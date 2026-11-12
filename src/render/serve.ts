import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessArgs } from './browser.ts';
import type { ZipIndex } from './zip-index.ts';

export interface PageRun {
  /** Absolute path to the HTML page to serve at /render.html. */
  page: string;
  /** Served as /job.json. */
  job: unknown;
  /** Extra GET routes: '/model/<name>' -> absolute file path. */
  files: Map<string, string>;
  /** /ldraw/* lookup: the library zip first, then model-folder files. */
  library: ZipIndex;
  modelDir: string;
  browser: string;
  width: number;
  height: number;
  timeoutMs: number;
  /** POST /result/<name>; the name matches /^[A-Za-z0-9_.-]{1,80}$/. */
  onResult(name: string, body: Buffer): Promise<void>;
}

export const MODEL_EXT = new Set(['.ldr', '.mpd', '.dat']);
const THREE_ROOT = resolve(dirname(fileURLToPath(import.meta.resolve('three'))), '..');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
};
const RESULT_NAME = /^\/result\/([A-Za-z0-9_.-]{1,80})$/;

function send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Model-folder files the loader may ask for, keyed by lowercased name. */
export function modelFolderFiles(modelDir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const e of readdirSync(modelDir, { withFileTypes: true })) {
    if (e.isFile() && MODEL_EXT.has(extname(e.name).toLowerCase())) files.set(e.name.toLowerCase(), join(modelDir, e.name));
  }
  return files;
}

/**
 * Serves a page on 127.0.0.1 and drives a headless Chromium-based browser through it. Resolves when
 * the page POSTs /done; rejects when it POSTs /error, the browser exits, or the timeout passes.
 */
export async function runPage(run: PageRun): Promise<void> {
  const pageHtml = readFileSync(run.page);
  const job = JSON.stringify(run.job);
  const local = modelFolderFiles(run.modelDir);

  let settle!: { resolve: () => void; reject: (err: Error) => void };
  const finished = new Promise<void>((res, rej) => { settle = { resolve: res, reject: rej }; });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (req.method === 'GET') {
        if (path === '/' || path === '/render.html') return send(res, 200, pageHtml, MIME['.html']);
        if (path === '/job.json') return send(res, 200, job, MIME['.json']);
        const extra = run.files.get(path);
        if (extra) return send(res, 200, await readFile(extra));
        if (path.startsWith('/three/')) {
          const file = resolve(THREE_ROOT, '.' + path.slice('/three'.length));
          if (!file.startsWith(THREE_ROOT + sep) || extname(file) !== '.js') return send(res, 404, 'not found');
          const body = await readFile(file).catch(() => null);
          return body ? send(res, 200, body, MIME['.js']) : send(res, 404, 'not found');
        }
        if (path.startsWith('/ldraw/')) {
          const rel = path.slice('/ldraw/'.length);
          const fromZip = run.library.get(rel);
          if (fromZip) return send(res, 200, fromZip);
          // A submodel next to the model, requested under any of the loader's search prefixes.
          const name = rel.replace(/^(parts|p|models)\//i, '');
          const file = name.includes('/') ? undefined : local.get(name.toLowerCase());
          if (file) return send(res, 200, await readFile(file));
          return send(res, 404, 'not found');
        }
        return send(res, 404, 'not found');
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const m = RESULT_NAME.exec(path);
        if (m) {
          await run.onResult(m[1]!, body);
          send(res, 200, 'ok');
          return;
        }
        send(res, 200, 'ok');
        if (path === '/done') settle.resolve();
        else if (path === '/error') settle.reject(new Error(`render page failed: ${body.toString('utf8').slice(0, 2000)}`));
        return;
      }
      send(res, 405, 'method not allowed');
    })().catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, String(err));
    });
  });

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  const profile = await mkdtemp(join(tmpdir(), 'brick-art-render-'));
  const child = spawn(run.browser, headlessArgs(profile, run.width, run.height, `http://127.0.0.1:${port}/render.html`), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
  child.on('error', (err) => settle.reject(new Error(`could not start browser ${run.browser}: ${err.message}`)));
  child.on('exit', (code) => settle.reject(new Error(`browser exited (code ${code}) before rendering finished. ${stderr.trim()}`)));
  const timer = setTimeout(() => settle.reject(new Error(`render timed out after ${run.timeoutMs / 1000}s`)), run.timeoutMs);

  try {
    await finished;
  } finally {
    clearTimeout(timer);
    child.removeAllListeners('exit');
    if (child.exitCode === null) {
      const exited = new Promise((res) => child.once('exit', res));
      child.kill();
      await Promise.race([exited, new Promise((res) => setTimeout(res, 5000))]);
    }
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
