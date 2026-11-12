# Instruction booklet design

Date: 2026-11-12
Status: Ready for approval

## Intent

Today the build instructions are text in `<name>.md`, written by hand from the
`0 STEP` groups in the `.ldr`. `render_model` renders only the finished model.
The user wants instructions that look like an official LEGO assembly booklet:
numbered steps, each one a picture of the model so far, with the parts that
step adds and how they connect. The reference is the booklet for set 40279
(the frog polybag): a grid of numbered steps on a light-blue page, one fixed
camera angle, tan callout boxes for sub-assemblies with an arrow to where they
attach, and "2x" when a sub-assembly is built twice.

The booklet must be generated from the `.ldr`. The LDraw file stays the source
of truth (see `CLAUDE.md`), so the step pictures, parts boxes, parts list, and
text instructions all describe the same model.

People use the booklet two ways, and both count: printed on paper, and followed
on a screen.

## Goals

- A PDF booklet for every model the `build-model` skill makes, generated from
  the `.ldr` with no hand drawing.
- One rendered image per build step, showing the whole model built so far.
- A parts box on every step, with an image of each part the step adds and its
  quantity ("2x").
- Sub-assembly callouts with mini-steps, a quantity, and an arrow to where the
  sub-assembly attaches.
- The "manual look": flat colors, dark part outlines, light-blue page.
- A check that refuses or flags steps whose parts float or don't connect.

## Anti-goals

The user named these. Getting either one wrong makes the feature a failure,
even if the PDF looks right.

- **Parts floating or misaligned between steps.** A part must not move between
  the step that adds it and later steps, and every part a step adds must
  connect to the model built so far.
- **Incorrect instructions.** The parts box, step picture, parts list, and
  `.md` text must never disagree with the `.ldr` or with each other.

## Non-goals

- Editing models by hand in a GUI.
- Highlighting new parts with a colored outline. The frog booklet doesn't, and
  small steps plus the parts box make the change clear. (Builder's call to
  revisit only if the user asks.)
- Multilingual text, safety warnings, set numbers, or LEGO branding. The cover
  shows the model's own name, not the LEGO logo.
- Exporting to other instruction formats (LPub3D, Studio).

## Decisions

### Made by the user

- The booklet resembles official LEGO assembly booklets, as in set 40279.
- Output works for both print and screen.
- Every step has a parts box.
- Visual style: the manual look (flat colors, dark outlines, light-blue page),
  chosen over the current studio shading.
- No floating or misaligned parts, and no incorrect instructions (anti-goals).

### Made by Claude (open to change)

- **Output files.** In the model folder:
  - `<name>-instructions.pdf`: landscape pages, cover first, step pages, and
    a parts-list page at the end with a picture of each part.
  - `<name>-step-NN.png`: one image per main step, so the `.md` can embed them
    and a single step can be viewed without the PDF.
  The existing `<name>-front.png` and `<name>-angle.png` studio renders stay.
- **Page layout.** Steps fill a grid of about two to six per page. A step with
  more parts or a callout gets a bigger cell. Steps are numbered straight
  through the booklet.
- **Camera.** One fixed three-quarter angle for each section, so pictures can
  be compared step to step. To show another side, the `.ldr` uses
  `0 ROTSTEP`, and the booklet shows a "turn the model" rotate icon on that
  step.
- **Submodels.**
  - A submodel of about 8 parts or fewer becomes a callout box: its own
    mini-steps numbered 1, 2, …, then an arrow from the box to where it
    attaches in the main step that places it. When the main step places the
    same submodel N times, the box shows "Nx".
  - A larger submodel gets its own numbered section of full-size steps, like
    the numbered bags in big sets. The main model then adds it in one step.
  - The ~8-part threshold is a starting point to tune.
- **Rendering approach.** Reuse the three.js and LDrawLoader pipeline in
  `src/render/` with a second scene style: unlit or toon flat colors, LDraw's
  own edge lines (line types 2 and 5, which LDrawLoader already builds) drawn
  dark, no ambient occlusion or environment map, and a light-blue background.
  Load the model once and toggle part visibility per step. Don't reload the
  model for each step.
- **PDF.** Lay out the booklet as HTML and print it to PDF with the same
  headless Chromium that `render_model` already drives. No new dependency.
- **Tool surface.** Add a `render_instructions` MCP tool. It takes the `.ldr`
  path and returns the PDF path, the step PNG paths, the per-step parts, and
  any connection-check findings. `build-model` calls it after `render_model`
  and before delivering.
- **Text instructions.** The PDF has no step text, like LEGO booklets. Each
  step's sentence comes from a `0 // <text>` comment inside that step's group
  in the `.ldr`, and `SKILL.md` requires one per step. `render_instructions`
  returns per-step data (number, text, added parts, PNG path). The skill
  writes `<name>.md` from that data, embedding each step's PNG, so the text,
  parts, and picture share one source.
- **More than one top-level model.** A folder can hold several top-level
  files. `titanic-transformer/` has a ship mode and a robot mode that share
  submodels. `render_instructions` makes one booklet for the file it is given,
  and names outputs by that file's stem, so booklets never clash. The skill
  makes a booklet for the primary model only. Instructions for turning one
  mode into another are out of scope.

### Correctness (from the anti-goals)

- **Single source.** The per-step part lists, parts boxes, parts list page,
  and step images all come from one parse of the `.ldr` (with submodels
  expanded). Nothing is typed in twice.
- **No movement between steps.** Each step's image shows the same placed parts
  at the same transforms as the final model, with later parts hidden. A part
  can't be in one place in step 3 and another in step 7.
- **Connection check.** Before rendering, check every part a step adds. It
  must touch a compatible connection point (stud to anti-stud, clip to bar,
  pin to hole, and so on) on a part that is already placed, or on another part
  in the same step that connects to the model in turn. The `connections` and
  `connection_compat` tables in the parts database hold the geometry. Sub-
  assembly parts are checked within the sub-assembly first, and then the
  sub-assembly as a whole must connect where it attaches.
  - Where a part has no connection data (`has_connections = 0`), fall back to
    a bounding-box contact test and report the result as unverified, not as
    passed.
  - **Overlap and grid alignment.** The check also flags a part whose solid
    volume overlaps another part's (bounding boxes, refined with the grid
    shape data where available), and a part whose studs sit off the stud grid
    of the part it connects to. Touching a connection point is not enough on
    its own.
  - Findings name the step, the part, the color, and its position.
  - **Outcomes (decided by the user):**
    - A clear failure (no connection, overlap, or off-grid) blocks the
      booklet. The skill fixes the `.ldr` and runs again, as it does for a
      floating part in a render.
    - An "unverified" part does not block. It is listed in the tool result,
      and the skill tells the user.
    - A part the check rejects but that is legal (sideways building with
      brackets, tiles on jumper plates, friction fits) can be accepted with a
      `0 !BRICKART CONNECTED` meta line just before it in the `.ldr`. That
      stops the skill from looping on a false alarm. The skill uses it only
      after checking the render, and tells the user which parts it accepted.
    - Without the parts database, the booklet still builds, and its cover
      and the tool result say "connections not checked".
- **Step size.** Warn when a step adds more than about 8 parts, or when a step
  adds parts that hide each other from the camera, because those steps are
  hard to follow. A warning doesn't block the booklet.

## Builder's discretion

- Exact page size and margins (A4 vs Letter landscape, or one size that prints
  on both), font, and the light-blue shade.
- The grid packing algorithm.
- The arrow's start and end points, as long as the end point is the
  sub-assembly's attachment point in the main step.
- The part icon renders: angle, size, and whether they're cached per part and
  color.
- How `render_instructions` and `render_model` share code (one module with two
  styles, or two).
- The connection tolerance. LDraw units are 1 LDU = 0.4 mm. A stud is 20 LDU
  wide and a plate is 8 LDU tall.
- Performance targets. A 250-part model should render its booklet in a few
  minutes on a laptop without a GPU.

## Constraints

- Node 22, TypeScript, no build step (matches the repo).
- Uses only a Chromium-based browser already required by `render_model`, plus
  the LDraw library zip and the parts database.
- Real LDraw part geometry for every image. No hand-drawn parts.
- The `build-model` skill (`skills/build-model/SKILL.md`) must be updated to
  produce and deliver the booklet, and to describe the connection check.
