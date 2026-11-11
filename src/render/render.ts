import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessArgs } from './browser.ts';
import { ldrawColorNames, tallyModel, type TallyRow } from './tally.ts';
import type { ZipIndex } from './zip-index.ts';

export interface RenderView { name: string; yaw: number; pitch: number }

/** Front and three-quarter studio views. Yaw turns the camera around the model; pitch raises it. */
export const DEFAULT_VIEWS: RenderView[] = [
  { name: 'front', yaw: 0, pitch: 10 },
  { name: 'angle', yaw: 35, pitch: 22 },
];

export interface RenderOptions {
  /** An .ldr or .mpd model file. Other model files it references are read from the same folder. */
  modelPath: string;
  /** Folder for the PNGs; default is the model's folder. */
  outDir?: string;
  views?: RenderView[];
  width?: number;
  height?: number;
  /** Chromium-based browser executable. */
  browser: string;
  library: ZipIndex;
  timeoutMs?: number;
}

export interface RenderResult {
  files: { view: string; path: string }[];
  /** Library parts the model places, by part and LDraw color, with submodels expanded. */
  parts: TallyRow[];
  totalParts: number;
}

const VIEW_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const MODEL_EXT = new Set(['.ldr', '.mpd', '.dat']);
const PAGE = fileURLToPath(new URL('./page.html', import.meta.url));
const THREE_ROOT = resolve(dirname(fileURLToPath(import.meta.resolve('three'))), '..');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
};

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
function modelFolderFiles(modelDir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const e of readdirSync(modelDir, { withFileTypes: true })) {
    if (e.isFile() && MODEL_EXT.has(extname(e.name).toLowerCase())) files.set(e.name.toLowerCase(), join(modelDir, e.name));
  }
  return files;
}

/**
 * Renders an LDraw model to one PNG per view: serves a three.js studio scene on 127.0.0.1 and
 * drives a headless Chromium-based browser through it. Parts come from the LDraw library zip;
 * files the library lacks are looked up by name in the model's folder.
 */
export async function renderModel(opts: RenderOptions): Promise<RenderResult> {
  const modelPath = resolve(opts.modelPath);
  const ext = extname(modelPath).toLowerCase();
  if (!MODEL_EXT.has(ext)) throw new Error(`model must be an .ldr, .mpd, or .dat file: ${modelPath}`);
  if (!(await stat(modelPath).then((s) => s.isFile(), () => false))) throw new Error(`model file not found: ${modelPath}`);
  const views = opts.views?.length ? opts.views : DEFAULT_VIEWS;
  for (const v of views) {
    if (!VIEW_NAME.test(v.name)) throw new Error(`view name must be 1-40 letters, digits, - or _: ${v.name}`);
  }
  if (new Set(views.map((v) => v.name)).size !== views.length) throw new Error('view names must be unique');
  const width = opts.width ?? 1200;
  const height = opts.height ?? 1600;
  const outDir = resolve(opts.outDir ?? dirname(modelPath));
  await mkdir(outDir, { recursive: true });
  const stem = basename(modelPath, extname(modelPath));
  const modelDir = dirname(modelPath);
  const local = modelFolderFiles(modelDir);
  const parts = tallyModel(await readFile(modelPath, 'utf8'), local, opts.library, ldrawColorNames(opts.library));
  const job = JSON.stringify({ model: basename(modelPath), width, height, views });
  const files: RenderResult['files'] = [];
  const pageHtml = readFileSync(PAGE);

  let settle!: { resolve: () => void; reject: (err: Error) => void };
  const finished = new Promise<void>((res, rej) => { settle = { resolve: res, reject: rej }; });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (req.method === 'GET') {
        if (path === '/' || path === '/render.html') return send(res, 200, pageHtml, MIME['.html']);
        if (path === '/job.json') return send(res, 200, job, MIME['.json']);
        if (path === `/model/${basename(modelPath)}`) return send(res, 200, await readFile(modelPath));
        if (path.startsWith('/three/')) {
          const file = resolve(THREE_ROOT, '.' + path.slice('/three'.length));
          if (!file.startsWith(THREE_ROOT + sep) || extname(file) !== '.js') return send(res, 404, 'not found');
          const body = await readFile(file).catch(() => null);
          return body ? send(res, 200, body, MIME['.js']) : send(res, 404, 'not found');
        }
        if (path.startsWith('/ldraw/')) {
          const rel = path.slice('/ldraw/'.length);
          const fromZip = opts.library.get(rel);
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
        const m = /^\/result\/([A-Za-z0-9_-]{1,40})\.png$/.exec(path);
        if (m && views.some((v) => v.name === m[1])) {
          const out = join(outDir, `${stem}-${m[1]}.png`);
          await writeFile(out, body);
          files.push({ view: m[1]!, path: out });
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
  const child = spawn(opts.browser, headlessArgs(profile, width, height, `http://127.0.0.1:${port}/render.html`), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
  child.on('error', (err) => settle.reject(new Error(`could not start browser ${opts.browser}: ${err.message}`)));
  child.on('exit', (code) => settle.reject(new Error(`browser exited (code ${code}) before rendering finished. ${stderr.trim()}`)));
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timer = setTimeout(() => settle.reject(new Error(`render timed out after ${timeoutMs / 1000}s`)), timeoutMs);

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
  const order = new Map(views.map((v, i) => [v.name, i]));
  files.sort((a, b) => order.get(a.view)! - order.get(b.view)!);
  return { files, parts, totalParts: parts.reduce((n, p) => n + p.count, 0) };
}
