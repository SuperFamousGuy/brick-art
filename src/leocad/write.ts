import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { MODEL_EXT } from '../render/serve.ts';
import { DEFAULT_VIEWS } from '../render/render.ts';
import type { ZipIndex } from '../render/zip-index.ts';
import type { GeometrySource } from '../instructions/geometry.ts';
import { parseSteps } from '../instructions/steps.ts';
import { bundleModel, contentHash, mpdText, storedHash } from './bundle.ts';
import { CAMERA_NAMES, cameraLines, worldBounds } from './cameras.ts';

export interface LeoCadOptions {
  modelPath: string;
  /** Folder for the .mpd (default: the model's folder). */
  outDir?: string;
  /** Replace an existing .mpd even when it was edited after this tool wrote it. */
  overwrite?: boolean;
  library: ZipIndex;
  geometry: GeometrySource;
}
export interface LeoCadResult { mpd: string; submodels: string[]; cameras: string[] }

/** Writes `<model>.mpd`: the model and its submodels in one LDraw file, with LeoCAD properties and cameras. */
export async function writeLeoCadFile(opts: LeoCadOptions): Promise<LeoCadResult> {
  const modelPath = resolve(opts.modelPath);
  const ext = extname(modelPath).toLowerCase();
  if (!MODEL_EXT.has(ext)) throw new Error(`model must be an .ldr, .mpd, or .dat file: ${modelPath}`);
  if (ext === '.mpd') throw new Error(`the model is already an .mpd, so there is nothing to bundle: ${modelPath}`);
  if (!(await stat(modelPath).then((s) => s.isFile(), () => false))) throw new Error(`model file not found: ${modelPath}`);

  const isLibraryPart = (ref: string) => opts.library.has(`parts/${ref}`) || opts.library.has(`p/${ref}`);
  const bundle = bundleModel(modelPath, isLibraryPart);
  // The main section is pushed last in `sections`; it holds the world-frame parts of the whole model.
  const model = parseSteps(modelPath, { isLibraryPart });
  const mainName = basename(modelPath).toLowerCase();
  const main = model.sections.find((s) => s.file === mainName) ?? model.sections.at(-1);
  const placements = (main?.steps ?? []).flatMap((s) => s.added);
  if (placements.length === 0) throw new Error('the model places no parts');

  const text = mpdText(bundle, cameraLines(worldBounds(placements, opts.geometry)));

  const outDir = resolve(opts.outDir ?? dirname(modelPath));
  const target = join(outDir, `${basename(modelPath, extname(modelPath))}.mpd`);
  if (!opts.overwrite) {
    const existing = await readFile(target, 'utf8').catch(() => null);
    if (existing !== null) {
      const stored = storedHash(existing);
      if (stored === null || stored !== contentHash(existing)) {
        throw new Error(`${target} was edited after it was written (or was not written by this tool); pass overwrite: true to replace it`);
      }
    }
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(target, text);
  return {
    mpd: target,
    submodels: bundle.files.slice(1).map((f) => f.name),
    cameras: DEFAULT_VIEWS.map((v) => CAMERA_NAMES[v.name]!),
  };
}
