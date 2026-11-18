# LeoCAD File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `leocad_file` MCP tool that writes `<name>.mpd`, one self-contained LeoCAD-ready file with every submodel, model properties, and two named cameras.

**Architecture:** A pure writer in `src/leocad/` turns the main `.ldr` and its folder's submodel files into MPD text: `0 FILE` blocks plus `0 !LEOCAD` lines. Cameras come from the model's world bounding box, which `parseSteps` placements and the parts database's part bounds give us. A thin async wrapper does the file I/O and the overwrite check, and `src/mcp/server.ts` registers it.

**Tech Stack:** TypeScript on Node ≥ 22.18 (`node --test`, type stripping), zod, the existing LDraw helpers.

**Spec:** `docs/superpowers/specs/2026-11-17-leocad-file-design.md`

## Global Constraints

- Output file: `<name>.mpd` in the model's folder (or `outDir`), where `<name>` is the `.ldr` stem.
- The `.ldr` and its submodel files are never modified.
- LeoCAD syntax per https://www.leocad.org/docs/meta.html: `0 !LEOCAD MODEL NAME|AUTHOR|DESCRIPTION <text>`; camera fields `POSITION <x y z>`, `TARGET_POSITION <x y z>`, `UP_VECTOR <x y z>`, `FOV <deg>`, then `NAME <name>` last.
- Camera names: `Front` and `Three-quarter`, from `DEFAULT_VIEWS` in `src/render/render.ts` (`front` yaw 0 pitch 10, `angle` yaw 35 pitch 22).
- Hash line: `0 !BRICKART LEOCAD_FILE <sha256 hex>` where the hash covers every line except the hash line itself.
- No LeoCAD groups, lights, key frames, or `.lcd` output.

## Review Focus

- **Submodel with the same name in different case** (`Wheel.ldr` referenced as `wheel.ldr`). Expect one `0 FILE` block, named as the `.ldr` references it first. Tested in Task 1.
- **Header missing `0 Name:` or `0 Author:`.** Expect the MODEL lines to fall back to the file stem and to skip AUTHOR, not to print `undefined`. Tested in Task 1.
- **Part with no bounds in the database** (an unusual print or a new part). Expect the camera to still frame the model, using a 20 × 24 × 20 LDU box at that part's position. Tested in Task 2.
- **CRLF line endings in the `.ldr`.** Expect LF output with no stray `\r` on any line, and the hash to stay stable. Tested in Task 1.
- **`.mpd` deleted by the user, or `outDir` that doesn't exist yet.** Expect a normal write, with the folder created. Tested in Task 3.

---

### Task 1: MPD bundler

**Files:**
- Create: `src/leocad/bundle.ts`
- Test: `tests/leocad/bundle.test.ts`

**Interfaces:**
- Consumes: `splitMpd` and `isPartFile` from `src/render/tally.ts`; `modelFolderFiles` from `src/render/serve.ts`.
- Produces:
  ```ts
  export interface ModelInfo { name: string; title: string | null; author: string | null }
  export interface Bundle { info: ModelInfo; files: { name: string; lines: string[] }[] } // files[0] is the main model
  export function bundleModel(modelPath: string, isLibraryPart: (ref: string) => boolean): Bundle
  export function mpdText(bundle: Bundle, cameraLines: string[]): string // includes MODEL lines, cameras, and the hash line
  export function contentHash(text: string): string // sha256 of the text with any hash line removed
  export function storedHash(text: string): string | null
  ```

- [ ] **Step 1: Write the failing tests.** Build fixture folders in a temp dir. Tests:
  - `bundles a plain model as one FILE block`: output starts `0 FILE house.ldr`, ends with `0 NOFILE`, and keeps `0 STEP`, `0 ROTSTEP 0 45 0 ABS`, and `0 // Add the roof.` in their original order.
  - `inlines nested submodels once each, in first-reference order`: main → `wall.ldr` (twice) → `window.ldr`. Expect `FILE` names `['house.ldr','wall.ldr','window.ldr']`.
  - `matches submodel names case-insensitively`: file on disk `Wall.ldr`, referenced as `wall.ldr`. Expect one block named `wall.ldr`.
  - `throws for a missing reference`: main references `ghost.ldr`, which is neither a library part nor in the folder. Expect the error to match `/ghost\.ldr/`.
  - `writes MODEL lines from the header`: `0 Small House` / `0 Name: house.ldr` / `0 Author: brick-art` gives `0 !LEOCAD MODEL NAME house`, `0 !LEOCAD MODEL AUTHOR brick-art`, and `0 !LEOCAD MODEL DESCRIPTION Small House`, right after the main block's header lines. A header with no Name or Author gives `NAME house` and no AUTHOR line.
  - `strips CR`: a CRLF input gives no `\r` in the output.
  - `hash round-trips`: `storedHash(mpdText(b, [])) === contentHash(mpdText(b, []))`, and changing any one model line breaks the equality.
- [ ] **Step 2: Run** `node --test tests/leocad/bundle.test.ts`. Expected: FAIL, because the module isn't found.
- [ ] **Step 3: Implement `src/leocad/bundle.ts`.** Do a depth-first walk over type-1 lines. A reference is a submodel when it is not `isLibraryPart(ref)`, its file is in `modelFolderFiles`, and it is not `isPartFile`. Use the same rule as `tallyModel`. Keep a `MAX_DEPTH` of 32. Header lines are the leading type-0 lines before the first non-meta line, and MODEL lines go after them. Put the camera lines after the MODEL lines, then the hash line, then the model lines.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: `git add src/leocad/bundle.ts tests/leocad/bundle.test.ts && git commit -m "feat: bundle a model and its submodels into one MPD"`

### Task 2: LeoCAD cameras

**Files:**
- Create: `src/leocad/cameras.ts`
- Test: `tests/leocad/cameras.test.ts`

**Interfaces:**
- Consumes: `Placement` from `src/instructions/steps.ts`; `GeometrySource` from `src/instructions/geometry.ts`; `RenderView` and `DEFAULT_VIEWS` from `src/render/render.ts`; `Bounds` from `src/types.ts`.
- Produces:
  ```ts
  export const CAMERA_NAMES: Record<string, string> = { front: 'Front', angle: 'Three-quarter' };
  export const CAMERA_FOV = 30;
  export function worldBounds(parts: Placement[], geom: GeometrySource): Bounds
  export function cameraLines(bounds: Bounds, views?: RenderView[]): string[]
  ```

- [ ] **Step 1: Write the failing tests.**
  - `worldBounds transforms part bounds`: one part with bounds `[-10,-4,-10]..[10,24,10]` at pos `[100,0,0]` rotated 90° about y gives `[90,-4,-10]..[110,24,10]`.
  - `worldBounds falls back for unknown parts`: `geom.get` returns null, pos `[0,0,0]`. Expect `[-10,-12,-10]..[10,12,10]`.
  - `cameraLines writes two named cameras`: lines match `/^0 !LEOCAD CAMERA FOV 30 POSITION \S+ \S+ \S+ TARGET_POSITION \S+ \S+ \S+ UP_VECTOR 0 -1 0 NAME Front$/`. The same goes for `Three-quarter`. TARGET is the box center.
  - `front camera looks from -z`: for a box centered at the origin, the Front POSITION has x ≈ 0, y < 0 (above, since LDraw y points down), and z < 0. The distance from the center is ≥ radius / sin(15°).
- [ ] **Step 2: Run** `node --test tests/leocad/cameras.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The direction from the center in LDraw axes is `[sin(yaw)·cos(pitch), -sin(pitch), -cos(yaw)·cos(pitch)]`. The distance is `1.15 · radius / sin(CAMERA_FOV/2)`, where radius is half the box diagonal. Round numbers to 2 decimals. Emit all fields on one line, with `NAME` last.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat: LeoCAD cameras matching the render views"`

### Task 3: `leocad_file` tool

**Files:**
- Create: `src/leocad/write.ts`
- Modify: `src/mcp/server.ts` (register after `pick_a_brick_list`)
- Test: `tests/leocad/write.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `parseSteps`; `ZipIndex` (for `library.has('parts/<ref>')`); `MODEL_EXT`.
- Produces:
  ```ts
  export interface LeoCadOptions { modelPath: string; outDir?: string; overwrite?: boolean; library: ZipIndex; geometry: GeometrySource }
  export interface LeoCadResult { mpd: string; submodels: string[]; cameras: string[] }
  export async function writeLeoCadFile(opts: LeoCadOptions): Promise<LeoCadResult>
  ```

- [ ] **Step 1: Write the failing tests.** Use `writeLibrary` from `tests/helpers/ldraw-fixture.ts` and a fake `GeometrySource`.
  - `writes <name>.mpd next to the model`: returns `mpd` ending in `/house.mpd`, `submodels: ['wall.ldr']`, and `cameras: ['Front','Three-quarter']`. The `.ldr` bytes are unchanged.
  - `creates outDir`: a non-existent `outDir` is created.
  - `rewrites its own unedited file`: two calls in a row both succeed.
  - `refuses to overwrite an edited file`: append a line to the `.mpd`, then call again. Expect a rejection matching `/edited.*overwrite: true/`. With `overwrite: true` it succeeds.
  - `refuses a file with no hash line`: same expectation as above.
  - `rejects a non-model path`: `house.txt` gives `/\.ldr, \.mpd, or \.dat/`. Reject an `.mpd` input too, with `/already an .mpd/`, so the tool never overwrites its own input.
- [ ] **Step 2: Run** `node --test tests/leocad/write.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `writeLeoCadFile`**, then register `leocad_file` in `server.ts`. Copy the structure of the `pick_a_brick_list` registration: return `notReady()` without a database, use `openLDrawLibrary(dataDir)`, and `dbGeometry(db)`. Input schema: `modelPath`, `outDir?`, and `overwrite?`. Description: "Writes <model>.mpd, one LDraw file holding the model and all its submodels, with LeoCAD model properties and Front and Three-quarter cameras, for opening, editing, and sharing in LeoCAD. Refuses to replace an .mpd edited since it was written unless overwrite is true."
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "feat: leocad_file tool writes a LeoCAD-ready MPD"`

### Task 4: Skill, docs, and LeoCAD check

**Files:**
- Modify: `skills/build-model/SKILL.md` (workflow step after render, delivered files list, "Editing in LeoCAD" note), `README.md` (outputs list near line 19), `CLAUDE.md` (required outputs and status)

- [ ] **Step 1: Update the docs.** The skill calls `leocad_file` after `render_model` and again after any `.ldr` change. If the user edited the `.mpd` in LeoCAD, pass the `.mpd` to `render_model`, `render_instructions`, and `pick_a_brick_list`, and don't call `leocad_file` with `overwrite` unless the user asks.
- [ ] **Step 2: Install LeoCAD**: `brew install --cask leocad`. Expected: `/Applications/LeoCAD.app` exists.
- [ ] **Step 3: Generate test files.** Call `leocad_file` on a small single-file model and on `titanic-transformer/titanic.ldr` (or the main file in that folder).
- [ ] **Step 4: Render with LeoCAD's command line**, for each file and camera:
  `/Applications/LeoCAD.app/Contents/MacOS/LeoCAD -i <out>-front.png -c Front -w 800 -h 600 <file>.mpd` (check `--help` for the exact flag names).
  Expected: PNGs that show the whole model, framed like the `render_model` front and angle images. If the camera faces the wrong way, LeoCAD's camera axes differ from LDraw's. Fix the direction in `cameraLines`, add a test, and rerun.
- [ ] **Step 5: Round trip.** Open the small `.mpd` in LeoCAD, move one part, and save. Then run `render_model` and `render_instructions` on the saved file. Expected: both succeed. Note any lines LeoCAD rewrote, such as dropped `0 //` step text, in the skill's LeoCAD note.
- [ ] **Step 6: Commit**: `git commit -m "docs: LeoCAD file in the build workflow"`
