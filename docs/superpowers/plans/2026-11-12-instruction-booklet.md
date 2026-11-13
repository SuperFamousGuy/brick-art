# Instruction Booklet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a LEGO-style PDF instruction booklet, plus one PNG per step, from a model's `.ldr` file, after a check that every part a step adds connects, doesn't overlap, and sits on the grid.

**Architecture:** One parse of the `.ldr` (`parseSteps`) produces a step model: sections, steps, the parts each step adds in world coordinates, callouts, and step text. A pure checker tests that model against part geometry from the parts database. A manual-look three.js page renders every step image from one flattened `.ldr` per section, toggling part visibility. A pure layout packs steps into pages, which are written as HTML and printed to PDF by the same headless Chromium. The `render_instructions` MCP tool runs the whole pipeline.

**Tech Stack:** Node 22 TypeScript (no build step, `node --test`), three.js 0.160 `LDrawLoader`, headless Chromium (`--print-to-pdf`), `node:sqlite` parts database, MCP SDK, zod.

**Spec:** `docs/superpowers/specs/2026-11-12-instruction-booklet-design.md`

## Global Constraints

- Node 22, TypeScript, no build step. No new npm dependencies.
- Uses only a Chromium-based browser already required by `render_model`, plus the LDraw library zip and the parts database.
- Real LDraw part geometry for every image. No hand-drawn parts.
- Manual look: flat colors, dark part outlines, light-blue page. No new-part highlight color.
- The `.ldr` is the single source: parts boxes, step images, parts list page, and step text all come from one `parseSteps` result.
- Outputs in the model folder (or `outDir`): `<stem>-instructions.pdf` and `<stem>-step-NN.png` (NN zero-padded to 2 digits, 3 when the booklet has 100 or more steps). `<stem>` is the stem of the top-level file passed in.
- Callout threshold: a submodel of `CALLOUT_MAX_PARTS = 8` parts or fewer becomes a callout. A larger one becomes its own section.
- Step-size warning above 8 added parts.
- Override meta line: `0 !BRICKART CONNECTED`, which applies to the next type-1 line only.
- Step text: a `0 // <text>` comment inside the step's group. The PDF shows no step text.
- Without the parts database, the booklet still builds, and the cover and tool result say "connections not checked".
- Units: 1 LDU = 0.4 mm. A stud pitch is 20 LDU, and a plate is 8 LDU tall. LDraw is y-down.

## Review Focus

1. **No `0 STEP` in the file** → one step holding every part, not zero steps (Task 1 test `no STEP lines gives one step`).
2. **A trailing `0 STEP` or several `0 STEP` lines in a row** → no empty steps, and the numbers stay consecutive (Task 1 test `empty steps are dropped`).
3. **Color 16 in a submodel** inherits the color of the line that placed it, in callouts, sections, parts boxes, and the parts list (Task 1 test `color 16 inherits through callouts and sections`).
4. **Rotated parts** (a 90° turn about y, or a part upside down) → connection points and grid cells are transformed by the full matrix before comparing (Task 3 tests `rotated part connects` and `rotated overlap is caught`).
5. **The same small submodel used in two different steps** → each step gets its own callout with that step's quantity, and the parts list counts every instance (Task 1 test `callout quantity is per step`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/instructions/steps.ts` (new) | Parse `.ldr`/`.mpd` plus folder submodels into a `StepModel` |
| `src/instructions/geometry.ts` (new) | Read part bounds, grid, and connections from the parts database |
| `src/instructions/check.ts` (new) | Connection, overlap, off-grid, and step-size checks; pure |
| `src/render/serve.ts` (new, extracted) | Shared local server plus headless-browser driver for render pages |
| `src/render/render.ts` (modify) | Use `serve.ts`; behavior unchanged |
| `src/render/instructions.html` (new) | Manual-look three.js page: step shots, part icons, attach marks, hidden-part counts |
| `src/instructions/render-steps.ts` (new) | Flatten sections to `.ldr`, build the shot list, run the page |
| `src/instructions/layout.ts` (new) | Pack steps into landscape pages; pure |
| `src/instructions/booklet-html.ts` (new) | Turn pages into HTML (cover, steps, parts list) |
| `src/render/pdf.ts` (new) | Print an HTML file to PDF with headless Chromium |
| `src/instructions/build.ts` (new) | Orchestrator: parse, check, render, lay out, print |
| `src/mcp/server.ts` (modify) | Register `render_instructions` |
| `skills/build-model/SKILL.md`, `CLAUDE.md`, `.gitignore` (modify) | Workflow, status, ignore `.superpowers/` |

---

### Task 1: Step model parser

**Files:**
- Create: `src/instructions/steps.ts`
- Test: `tests/instructions/steps.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3` from `src/types.ts`. Reuse the MPD-splitting approach in `src/render/tally.ts` (`splitMpd` is private there; export it from `tally.ts` and import it, rather than copying).
- Produces:
```ts
export const CALLOUT_MAX_PARTS = 8;
export const DEFAULT_VIEW = { yaw: -35, pitch: 30 }; // front-left, from above
export interface Placement {
  part: string;        // library file, lowercased, e.g. '3001.dat'
  color: number;       // resolved LDraw color (16 replaced by the inherited color)
  pos: Vec3;           // world position, LDU
  rot: Mat3;           // world rotation, row-major
  source: { file: string; line: number }; // file name and 1-based line of the type-1 line
  accepted: boolean;   // preceded by 0 !BRICKART CONNECTED
}
export interface Callout {
  file: string;              // submodel file name
  quantity: number;          // instances of this submodel placed in this step
  miniSteps: Placement[][];  // the submodel's own steps, in the submodel's local frame
  instances: Placement[][];  // world-frame parts of each instance, in placement order
  attach: Vec3[];            // world origin of each instance
}
export interface Insert { sectionId: string; quantity: number; parts: Placement[]; attach: Vec3 }
export interface Step {
  number: number;            // 1-based, continuous across the whole booklet
  text: string | null;       // joined `0 //` comments in this step
  loose: Placement[];        // library parts placed directly in this step (the parts box)
  callouts: Callout[];
  inserts: Insert[];         // whole large submodels added in this step
  added: Placement[];        // every part that becomes visible in this step = loose + callout instances + insert parts
  view: { yaw: number; pitch: number };
  rotated: boolean;          // this step starts a new ROTSTEP view
}
export interface Section { id: string; title: string; file: string; quantity: number; steps: Step[] }
export interface PartCount { part: string; color: number; count: number }
export interface StepModel { title: string; stem: string; sections: Section[]; parts: PartCount[]; totalParts: number }
export function parseSteps(modelPath: string, opts: { isLibraryPart: (file: string) => boolean }): StepModel;
```

Rules the tests pin:
- `0 STEP` and `0 ROTSTEP …` end a step. Empty steps are dropped, and numbering is continuous across sections.
- `0 ROTSTEP <x> <y> <z> ABS` sets the view to `{ yaw: DEFAULT_VIEW.yaw + y, pitch: DEFAULT_VIEW.pitch + x }`. `REL` and `ADD` add to the current view. `0 ROTSTEP END` restores `DEFAULT_VIEW`. The new view applies from the next step on, which gets `rotated: true`. Ignore z.
- A type-1 line whose file is not a library part (`!isLibraryPart`) and resolves to a model-folder or MPD file is a submodel. If the submodel holds `<= CALLOUT_MAX_PARTS` library parts after expansion, it becomes a callout. Otherwise it becomes a section. Sections come before the section that uses them, depth first, and each file has one section with `quantity` = total instances. The main model is the last section, with `id` = stem.
- Callouts in the same step are grouped by file, and `quantity` counts instances in that step only.
- World transform of a child = parent `rot · childRot`, and `parentPos + parentRot · childPos`.
- Submodel names are case-insensitive. Nesting deeper than 32 levels throws, like `tally.ts`.
- `parts` equals what `tallyModel` reports for the same file (same keys, same counts).

- [ ] **Step 1: Write the failing tests** in `tests/instructions/steps.test.ts`. Write model files into a temp dir; `isLibraryPart = (f) => f.endsWith('.dat')`.
  - `three steps from STEP lines`: three `1 4 …` lines split by two `0 STEP` lines → `sections.length === 1`, steps numbered `[1,2,3]`, each `loose.length === 1`.
  - `no STEP lines gives one step`: two parts and no STEP → one step with `added.length === 2`.
  - `empty steps are dropped`: `0 STEP` ×2 in a row, plus a trailing `0 STEP` → step numbers `[1,2]`.
  - `step text and accepted flag`: `0 // put the red brick on top` → `text === 'put the red brick on top'`, and `0 !BRICKART CONNECTED` before the part → `added[0].accepted === true`, while the next part is `false`.
  - `small submodel becomes a callout with world transform`: `wheel.ldr` with 2 parts, placed twice in one step at `x = 40` and `x = -40` → one callout, `quantity === 2`, `attach` deep-equals `[[40,0,0],[-40,0,0]]`, and `instances[0][0].pos` is offset by 40.
  - `callout quantity is per step`: `wheel.ldr` placed once in step 1 and twice in step 2 → callout quantities `1` and `2`, and the `parts` count for the wheel's part is 6.
  - `large submodel becomes its own section first`: a 9-part `hull.ldr` → `sections.map(s=>s.id)` deep-equals `['hull', '<stem>']`, the main step has `inserts[0].sectionId === 'hull'`, and the hull steps are numbered before the main steps.
  - `color 16 inherits through callouts and sections`: a `1 16` part inside a submodel placed with color 4 → that placement's `color === 4`, and `parts` has no color 16.
  - `ROTSTEP sets the view`: `0 ROTSTEP 0 180 0 ABS` → the next step's `view` deep-equals `{ yaw: 145, pitch: 30 }` and `rotated === true`, and `0 ROTSTEP END` restores `DEFAULT_VIEW`.
  - `rotated parent rotates child`: a submodel placed with a 90° y rotation (`0 0 1 0 1 0 -1 0 0`) and a child at `20 0 0` → child world pos `[0, 0, -20]`.
  - `parts matches tallyModel`: compare with `tallyModel` output on the same file.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/instructions/steps.test.ts`
Expected: FAIL, cannot find module `src/instructions/steps.ts`.

- [ ] **Step 3: Implement `parseSteps` in `src/instructions/steps.ts`**, and export `splitMpd` from `src/render/tally.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/instructions/steps.test.ts tests/render/render.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/instructions/steps.ts src/render/tally.ts tests/instructions/steps.test.ts
git commit -m "feat: parse .ldr build steps into sections, callouts, and world placements"
```

---

### Task 2: Part geometry from the parts database

**Files:**
- Create: `src/instructions/geometry.ts`
- Test: `tests/instructions/geometry.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` (`node:sqlite`), the `parts`, `connections`, and `connection_compat` tables (`src/db/schema.ts`), plus `Bounds`, `Grid`, `ConnectionType`, `Vec3`.
- Produces:
```ts
export interface PartGeom {
  bounds: Bounds;                    // part-local LDU
  grid: Grid | null;                 // [layer][z][x]; layer 0 = top (min y); cell = 20 x 8 x 20 LDU, anchored at bounds.min
  connections: { type: ConnectionType; position: Vec3; direction: Vec3 }[] | null; // null when has_connections = 0
}
export interface GeometrySource {
  get(ldrawFile: string): PartGeom | null;            // null when the part is unknown or has no geometry
  compatible(a: ConnectionType, b: ConnectionType): boolean;
}
export function dbGeometry(db: DatabaseSync): GeometrySource;
```
Look parts up by `parts.ldraw_file`, case-insensitively (falling back to `part_num` = the file name without `.dat`). Cache each result.

- [ ] **Step 1: Write the failing tests.** Create an in-memory DB with `createSchema`, then insert one part `3001` (`ldraw_file '3001.dat'`, bounds, grid JSON, `has_connections 1`) with one `stud` and one `stud_receptor` row.
  - `dbGeometry reads bounds, grid, and connections`: `get('3001.DAT')` returns the bounds, the parsed grid, and 2 connections with `position`/`direction` from the row's `x,y,z`/`dx,dy,dz`.
  - `compatible follows connection_compat`: `compatible('stud','stud_receptor') === true` and `compatible('stud','stud') === false`.
  - `missing connections is null, unknown part is null`: a part with `has_connections 0` → `connections === null`, and `get('nope.dat') === null`.

- [ ] **Step 2: Run** `node --test tests/instructions/geometry.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `dbGeometry`.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/instructions/geometry.ts tests/instructions/geometry.test.ts && git commit -m "feat: read part geometry and connection compatibility for step checks"`

---

### Task 3: Step checker

**Files:**
- Create: `src/instructions/check.ts`
- Test: `tests/instructions/check.test.ts`

**Interfaces:**
- Consumes: `StepModel`, `Placement` (Task 1); `GeometrySource`, `PartGeom` (Task 2).
- Produces:
```ts
export type FindingKind = 'floating' | 'overlap' | 'off-grid' | 'unverified' | 'large-step';
export interface Finding {
  kind: FindingKind;
  blocking: boolean;          // true for floating, overlap, off-grid
  section: string; step: number;
  part: string; color: number; pos: Vec3;
  source: { file: string; line: number };
  message: string;            // one sentence naming the step, part, color, and position
}
export interface CheckResult { findings: Finding[]; accepted: Placement[]; blocked: boolean }
export const POS_TOLERANCE = 0.5;   // LDU
export function checkModel(model: StepModel, geom: GeometrySource): CheckResult;
```

Algorithm, per section, in step order. The placed set starts empty. The first part of a section is the anchor.
1. **Connected:** a new part connects when one of its world connection points lies within `POS_TOLERANCE` of a `compatible` world connection point on a placed part, and the two directions are parallel (`|dot| > 0.99`). Within a step, iterate to a fixpoint, so parts connected only to other new parts of that step count once that chain reaches the model. Callout and insert parts are checked as a group: their internal connections were checked in their own mini-steps or section, so the group passes when any member connects. Check callout mini-steps and section steps the same way, in their local frame.
2. **Off-grid vs floating:** a part that fails 1 but has a compatible point within 20 LDU laterally and `POS_TOLERANCE` vertically of a placed part's point → `off-grid`. Otherwise → `floating`.
3. **Overlap:** world AABBs shrunk by `POS_TOLERANCE` intersect → when both parts have a grid and both rotations are axis-aligned (every matrix entry in {-1, 0, 1}), transform each filled cell to its world box (cell = 20 × 8 × 20 LDU from `bounds.min`, shrunk by `POS_TOLERANCE`), and report overlap only if two cell boxes intersect. This also works when the grids are offset by half a stud. When there's no grid or the rotation isn't axis-aligned, report `unverified` instead of `overlap`.
4. **No data:** a part with `geom.get() === null` or `connections === null` → `unverified` (not blocking), and skip 1 and 2 for it.
5. **Accepted** parts (`accepted: true`) skip all checks and go to `accepted`.
6. **Large step:** a step with `added.length > 8` → one `large-step` (not blocking).
- `blocked` = any blocking finding.

- [ ] **Step 1: Write the failing tests.** Use a fake `GeometrySource`: `box.dat` with bounds `[-10,0,-10]..[10,24,10]`, grid `[[[1]],[[1]],[[1]]]`, a `stud` at `[0,0,0]` dir `[0,-1,0]`, and a `stud_receptor` at `[0,24,0]` dir `[0,-1,0]`. Build `StepModel`s by calling `parseSteps` on temp `.ldr` files.
  - `stacked brick connects`: box at y=0, then box at y=-24 in step 2 → no findings, `blocked === false`.
  - `floating brick is blocking`: second box at y=-100 → one `floating`, `blocking`, `step === 2`, and the message contains `box.dat` and `-100`.
  - `half-stud shift is off-grid`: second box at `x=10, y=-24` → `off-grid`.
  - `brick inside brick is overlap`: second box at the same position → the findings include a blocking `overlap` for step 2.
  - `same-step chain connects`: step 2 adds two boxes at y=-24 and y=-48 → no findings.
  - `rotated part connects`: second box at y=-24 with a 90° y rotation → no findings.
  - `rotated overlap is caught`: second box rotated 90° about y at the same position → `overlap`.
  - `unknown part is unverified, not blocking`: `mystery.dat` → `unverified`, and `blocked === false`.
  - `accepted part is skipped`: floating box with `0 !BRICKART CONNECTED` → no findings, and `accepted.length === 1`.
  - `large step warns`: 9 stacked boxes in one step → one `large-step`, and `blocked === false`.
  - `callout group connects through any member`: a 2-box callout placed on top of the base → no findings.

- [ ] **Step 2: Run** `node --test tests/instructions/check.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `checkModel`.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/instructions/check.ts tests/instructions/check.test.ts && git commit -m "feat: check each build step for floating, overlapping, and off-grid parts"`

---

### Task 4: Extract the shared render server

**Files:**
- Create: `src/render/serve.ts`
- Modify: `src/render/render.ts` (`renderModel` keeps its signature and results)
- Test: `tests/render/render.test.ts` (unchanged; it must still pass)

**Interfaces:**
- Produces:
```ts
export interface PageRun {
  page: string;                          // absolute path to the HTML page to serve at /render.html
  job: unknown;                          // served as /job.json
  files: Map<string, string>;            // extra GET routes: '/model/<name>' -> absolute file path
  library: ZipIndex; modelDir: string;   // /ldraw/* lookup, exactly as render.ts does today
  browser: string; width: number; height: number; timeoutMs: number;
  onResult(name: string, body: Buffer): Promise<void>; // POST /result/<name> (name matches /^[A-Za-z0-9_.-]{1,80}$/)
}
export function runPage(run: PageRun): Promise<void>; // resolves on POST /done, rejects on /error, exit, or timeout
```
Move into `runPage`: the `/three/` route, the `/ldraw/` route with its model-folder fallback, `readBody`, browser spawn, timeout, and cleanup.

- [ ] **Step 1: Run the existing tests to record the baseline.** Run: `node --test tests/render/render.test.ts`. Expected: PASS (browser tests skip when no browser is installed; note which ran).
- [ ] **Step 2: Move the server and browser code into `runPage`**, and make `renderModel` call it.
- [ ] **Step 3: Run** `node --test tests/render/render.test.ts && npm run typecheck`. Expected: PASS, with the same tests run as the baseline.
- [ ] **Step 4: Commit** `git add src/render/serve.ts src/render/render.ts && git commit -m "refactor: share the render page server between render tools"`

---

### Task 5: Manual-look step renderer

**Files:**
- Create: `src/render/instructions.html`, `src/instructions/render-steps.ts`
- Test: `tests/instructions/render-steps.test.ts`

**Interfaces:**
- Consumes: `runPage` (Task 4); `StepModel`, `Placement`, `Section` (Task 1).
- Produces:
```ts
export interface Shot {
  name: string;               // output file stem, e.g. 'step-03', 'callout-03-1-2', 'part-3001-4'
  model: string;              // flattened .ldr name served under /model/
  visible: [number, number];  // half-open index range of top-level parts to show
  frame: [number, number];    // index range the camera fits to (the whole section, so framing never jumps)
  view: { yaw: number; pitch: number };
  marks: Vec3[];              // world points to project (callout attach points)
  watch: [number, number];    // index range of new parts whose visible pixels to count
  width: number; height: number;
}
export interface ShotResult { name: string; png: string; marks: [number, number][]; hiddenParts: number[] /* indices in watch with 0 visible pixels */ }
export function flattenLdr(parts: Placement[]): string; // one `1 <color> <pos> <rot> <part>` line per placement, in order
export function planShots(model: StepModel, sizes: { step: [number, number]; mini: [number, number]; icon: [number, number] }): { models: Map<string, string>; shots: Shot[] };
export function renderShots(opts: { model: StepModel; outDir: string; stem: string; browser: string; library: ZipIndex; modelDir: string; timeoutMs?: number }): Promise<Map<string, ShotResult>>;
```
- Main step PNGs are written as `<stem>-step-NN.png` in `outDir`. Callout and part-icon images go to `<outDir>/.<stem>-instructions/`, a hidden working folder that the PDF build reads.
- Page rules (`instructions.html`): load each flattened model once with `LDrawLoader`. Map the i-th child of the loaded group to placement i, and assert in the page that `children.length === parts.length` (fail through `/error` otherwise). Use `MeshLambertMaterial` with the part's color, a hemisphere light plus one directional light, and no shadows, AO, or environment map. Show LDraw edge and conditional lines, colored `#1b1b1b`. Background `#cfe6f5`. Use `renderer.setPixelRatio(2)` for print sharpness. Fit the camera once per `frame` range and view, with the same fit loop as `page.html`. For `watch`, render an ID pass (each watched part in a unique flat color, the others black) and count the pixels per part. Post each PNG as `/result/<name>.png`, and the marks and hidden parts as `/result/<name>.json`.

- [ ] **Step 1: Write the failing tests.**
  - `flattenLdr writes world lines in order` (no browser): two placements → two type-1 lines with exact numbers and the parts in order.
  - `planShots frames the whole section`: for a 3-step model, every `step-*` shot's `frame` equals `[0, 3]`, and `visible` grows `[0,1]`, `[0,2]`, `[0,3]`.
  - `planShots makes one icon per part and color`: a model with `box.dat` in colors 4 and 1 → shots `part-box-4` and `part-box-1`.
  - `renderShots writes step PNGs and attach marks` (`skip: noBrowser`, using the `box.dat` zip fixture from `tests/render/render.test.ts`, moved to `tests/helpers/ldraw-fixture.ts`): a 2-step model with a callout → `<stem>-step-01.png` and `-02.png` exist with the PNG signature, and the step-2 result has one mark inside the image bounds.
  - `renderShots reports a hidden new part` (`skip: noBrowser`): add a `big.dat` 60 × 60 × 60 LDU box to the fixture zip. Step 1 places `big.dat`, and step 2 places `box.dat` at its center → `hiddenParts.length === 1` for `step-02`.

- [ ] **Step 2: Run** `node --test tests/instructions/render-steps.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `flattenLdr`, `planShots`, `renderShots`, and `instructions.html`.
- [ ] **Step 4: Run** the same command, then `npm run typecheck`. Expected: PASS. Open one step PNG and confirm by eye: flat colors, dark outlines, light-blue background.
- [ ] **Step 5: Commit** `git add src/render/instructions.html src/instructions/render-steps.ts tests/instructions/render-steps.test.ts tests/helpers/ldraw-fixture.ts tests/render/render.test.ts && git commit -m "feat: render manual-style step images with attach marks and hidden-part counts"`

---

### Task 6: Page layout, booklet HTML, and PDF

**Files:**
- Create: `src/instructions/layout.ts`, `src/instructions/booklet-html.ts`, `src/render/pdf.ts`
- Test: `tests/instructions/layout.test.ts`, `tests/instructions/booklet.test.ts`

**Interfaces:**
- Consumes: `StepModel` (Task 1), `ShotResult` (Task 5), `headlessArgs` (`src/render/browser.ts`).
- Produces:
```ts
// layout.ts
export interface Cell { step: number; span: 1 | 2 }  // span 2 = double-width cell for big steps or steps with callouts
export interface Page { kind: 'cover' | 'section' | 'steps' | 'parts'; sectionId?: string; cells?: Cell[] }
export function layoutBooklet(model: StepModel): Page[];
// booklet-html.ts
export function bookletHtml(opts: { model: StepModel; pages: Page[]; shots: Map<string, ShotResult>; checked: boolean; colorNames: Map<number, string> }): string;
// pdf.ts
export function printToPdf(opts: { htmlPath: string; pdfPath: string; browser: string; timeoutMs?: number }): Promise<void>;
```
Layout rules: landscape pages with a 3 × 2 grid (6 slots). A step with a callout, an insert, or more than 4 `loose` parts takes span 2. Pages are: one cover, then for each section a `section` divider page (only when there's more than one section), then that section's `steps` pages, then `parts` pages. A step never splits across pages.

HTML rules: page size `11in 8.5in` landscape with 0.4in margins, which fits A4 and Letter. Background `#cfe6f5`. Each cell has a large step number, a cream parts box (`#fff7e0`, border `#c8b27a`) with one icon per part and color, labeled `Nx`, and the step image. Callouts are cream boxes with mini-step images numbered 1, 2, … and `Nx` when the quantity is above 1. Draw the arrow as an inline SVG from the callout box to the projected attach mark. A rotated step shows a rotate icon. Insert steps show the section's final image with its quantity. The cover shows the image of the main section's last step, the title, and the part count, plus "connections not checked" when `checked` is false. The parts pages are a grid of icons with quantity and color name. No step text and no LEGO branding.

`printToPdf`: spawn the browser with `headlessArgs(...)` minus the URL, plus `--print-to-pdf=<pdfPath>`, `--no-pdf-header-footer`, and the `file://` URL. Resolve when the process exits 0 and the PDF exists; otherwise reject with stderr.

- [ ] **Step 1: Write the failing tests.**
  - `layout puts the cover first and parts last`: a 7-step single-section model → kinds `['cover','steps','steps','parts']`.
  - `big steps span two slots and never split`: steps with spans `[2,2,2,1]` → page 1 holds steps 1–3 (6 slots), and page 2 holds step 4.
  - `section dividers only with more than one section`: a model with a 9-part submodel → it contains a `section` page for `hull` before its steps.
  - `bookletHtml has every step number and no step text`: the output contains `>1<` … `>N<` step numbers, contains no `0 //` text, and includes `connections not checked` only when `checked` is false.
  - `parts page totals match the model`: the sum of the `Nx` labels on parts pages equals `model.totalParts`.
  - `printToPdf writes a PDF` (`skip: noBrowser`): a simple HTML → the file starts with `%PDF`.

- [ ] **Step 2: Run** `node --test tests/instructions/layout.test.ts tests/instructions/booklet.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `layoutBooklet`, `bookletHtml`, and `printToPdf`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/instructions/layout.ts src/instructions/booklet-html.ts src/render/pdf.ts tests/instructions/layout.test.ts tests/instructions/booklet.test.ts && git commit -m "feat: lay out instruction pages and print them to PDF"`

---

### Task 7: Orchestrator and `render_instructions` tool

**Files:**
- Create: `src/instructions/build.ts`
- Modify: `src/mcp/server.ts` (register the tool after `render_model`)
- Test: `tests/instructions/build.test.ts`, `tests/mcp/server.test.ts` (tool count 11 → 12, add `'render_instructions'` to the sorted list)

**Interfaces:**
- Consumes: Tasks 1–6, `openLDrawLibrary`, `findBrowser`, `ldrawColorNames`, and `CurrentDb` in `server.ts`.
- Produces:
```ts
export interface InstructionsResult {
  status: 'built' | 'blocked';
  checked: boolean;                        // false when no parts database was available
  pdf: string | null;                      // null when blocked
  steps: { number: number; section: string; text: string | null; png: string | null;
           parts: { part: string; color: number; colorName: string | null; count: number }[] }[];
  findings: Finding[];
  accepted: { part: string; color: number; source: { file: string; line: number } }[];
  totalParts: number;
}
export function buildInstructions(opts: {
  modelPath: string; outDir?: string; browser: string; library: ZipIndex;
  geometry: GeometrySource | null; timeoutMs?: number;
}): Promise<InstructionsResult>;
```
Flow: `parseSteps` → if `geometry` is set, `checkModel`; if blocked, return `status: 'blocked'` with findings and steps (`png: null`) without rendering. Otherwise run `renderShots`, add each step's hidden parts as non-blocking `unverified` findings with the message "new part is hidden from the camera", run `layoutBooklet` and `bookletHtml`, write `<outDir>/.<stem>-instructions/booklet.html`, run `printToPdf` to `<stem>-instructions.pdf`, and return. `steps[].parts` counts each step's `added` by part and color.
- Tool: `render_instructions`, with inputs `modelPath` (absolute `.ldr`/`.mpd`) and `outDir` (optional), both described. Its description says it renders a LEGO-style PDF booklet and one PNG per step, after checking that each step's parts connect, and that a `blocked` status lists the parts to fix. With `current.get() === null`, pass `geometry: null`. The no-browser message matches `render_model`'s.

- [ ] **Step 1: Write the failing tests.**
  - `blocked model renders nothing`: a floating box with a fake geometry → `status === 'blocked'`, `pdf === null`, and no PNG files are written (runs without a browser, because rendering never starts).
  - `no database means checked false` (`skip: noBrowser`): `geometry: null` → `status === 'built'`, `checked === false`, the PDF exists, and each step has a PNG.
  - `step parts match the model` (`skip: noBrowser`): the sum of all `steps[].parts[].count` equals `totalParts`.
  - Server test: `listTools returns the twelve tools`, including `render_instructions`, and the existing description test covers its inputs.

- [ ] **Step 2: Run** `node --test tests/instructions/build.test.ts tests/mcp/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildInstructions` and register the tool.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `git add src/instructions/build.ts src/mcp/server.ts tests/instructions/build.test.ts tests/mcp/server.test.ts && git commit -m "feat: add render_instructions tool for PDF booklets"`

---

### Task 8: Skill, docs, and end-to-end check

**Files:**
- Modify: `skills/build-model/SKILL.md`, `CLAUDE.md`, `.gitignore`
- Test: `tests/plugin.test.ts` (keep it passing; extend it if it checks skill content)

- [ ] **Step 1: Update `SKILL.md`.**
  - Add a workflow step after "Check": call `render_instructions`. If `status` is `blocked`, fix each blocking finding in the `.ldr` and run it again. Use `0 !BRICKART CONNECTED` only for a part the render shows is really attached, and tell the user which parts were accepted. Report `unverified` findings, and say when `checked` is false.
  - In "LDraw model format", add: a `0 // <sentence>` in each step; `0 ROTSTEP <x> <y> <z> ABS` / `0 ROTSTEP END` to turn the view; keep steps to 8 parts or fewer; submodels of up to 8 parts become callouts and larger ones become sections.
  - Rewrite "Instructions": the `.md` instruction section is generated from the tool's `steps` (each step: number, text, embedded `<stem>-step-NN.png`, and parts), and the deliverables include `<stem>-instructions.pdf`.
  - Update "Required outputs" in `CLAUDE.md` item 2 to name the PDF booklet and step images, and its Status section to mention `render_instructions`.
  - Add `.superpowers/` to `.gitignore`.
- [ ] **Step 2: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 3: End-to-end.** Run `buildInstructions` on `titanic-transformer/titanic-transformer.ldr` with the real database and library (a small script in the scratchpad that imports `src/instructions/build.ts`). Expected: either `built` with a PDF, or `blocked` with findings that name real parts. Open the PDF and check the cover, a step page with a callout and arrow, a section divider, and the parts page. Record the result and any findings in the PR description. Don't fix the Titanic model in this branch.
- [ ] **Step 4: Commit** `git add skills/build-model/SKILL.md CLAUDE.md .gitignore && git commit -m "docs: build-model produces a checked PDF instruction booklet"`
