import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_EXT, modelFolderFiles, runPage } from './serve.ts';
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
const PAGE = fileURLToPath(new URL('./page.html', import.meta.url));

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

  await runPage({
    page: PAGE,
    job: { model: basename(modelPath), width, height, views },
    files: new Map([[`/model/${basename(modelPath)}`, modelPath]]),
    library: opts.library,
    modelDir,
    browser: opts.browser,
    width,
    height,
    timeoutMs: opts.timeoutMs ?? 180_000,
    async onResult(name, body) {
      const m = /^([A-Za-z0-9_-]{1,40})\.png$/.exec(name);
      if (!m || !views.some((v) => v.name === m[1])) return;
      const out = join(outDir, `${stem}-${m[1]}.png`);
      await writeFile(out, body);
      files.push({ view: m[1]!, path: out });
    },
  });
  const order = new Map(views.map((v, i) => [v.name, i]));
  files.sort((a, b) => order.get(a.view)! - order.get(b.view)!);
  return { files, parts, totalParts: parts.reduce((n, p) => n + p.count, 0) };
}
