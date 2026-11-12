import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { headlessArgs } from './browser.ts';

/** Prints an HTML file to a PDF with a headless Chromium-based browser, honoring the page's `@page` size and margins. */
export async function printToPdf(opts: { htmlPath: string; pdfPath: string; browser: string; timeoutMs?: number }): Promise<void> {
  const pdfPath = resolve(opts.pdfPath);
  const profile = await mkdtemp(join(tmpdir(), 'brick-art-pdf-'));
  const args = headlessArgs(profile, 1056, 816, '').slice(0, -1);
  args.push(`--print-to-pdf=${pdfPath}`, '--no-pdf-header-footer', pathToFileURL(resolve(opts.htmlPath)).href);
  try {
    await new Promise<void>((done, fail) => {
      const child = spawn(opts.browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`PDF printing timed out\n${stderr}`)); }, opts.timeoutMs ?? 120_000);
      child.on('error', (e) => { clearTimeout(timer); fail(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(pdfPath)) done();
        else fail(new Error(`PDF printing failed (exit ${code})\n${stderr}`));
      });
    });
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
