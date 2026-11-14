# brick-art

## Project goal

Generate LEGO-style brick constructions from a text prompt, the way image
models generate pictures from a prompt. The user describes what they want
("a small red lighthouse on a rocky base"), and Claude, using this project as
a plugin, designs a buildable model from real brick parts.

## Required outputs for every build

For each prompt, produce all three of these:

1. **Parts list.** Every brick the model uses, with part type, dimensions,
   color, and quantity.
2. **Step-by-step instruction manual.** An ordered build sequence a person can
   follow, where each step adds a small set of parts to the model built so
   far. Delivered as a LEGO-style PDF booklet (`<name>-instructions.pdf`) with
   one `<name>-step-NN.png` image per step, made by `render_instructions`.
3. **Rendered images.** Studio-lit PNGs of the fully built model, front and
   three-quarter, made by the `render_model` tool from the official 3D shape of
   every part. Fall back to an SVG drawing only when rendering is unavailable.

## Guiding principles

- Use real, commonly available brick parts and colors so a person can build
  the model with physical bricks.
- Keep the model physically buildable: every brick connects to the model, and
  each step only adds parts that attach to what already exists.
- Keep the parts list, instructions, and images consistent with each other.
  They describe the same model: the LDraw `.ldr` file is the source of truth,
  and the other outputs derive from it.

## Status

The parts database and lookup tools exist: a local database of real parts,
colors, and connection geometry, exposed to Claude through an MCP server. The
database also holds projects (official sets, OMR positions and build steps,
and optional fan designs), with search and sub-model tools. CI publishes the
database as a GitHub release, and the plugin downloads it.

Models are LDraw `.ldr` files, with `0 STEP` lines marking the build steps. The
`render_model` MCP tool renders them with three.js in a headless Chromium-based
browser, reading parts straight from the LDraw library zip (`src/render/`). The
`build-model` skill (`skills/build-model/SKILL.md`) is the build workflow.

The `render_instructions` MCP tool (`src/instructions/`) checks every step for
floating, overlapping, and off-grid parts, then builds the PDF booklet and step
images. A model with blocking findings is not rendered.

The `pick_a_brick_list` MCP tool (`src/order/`) writes `<name>-pick-a-brick.csv`,
the model's parts as LEGO element IDs for upload to LEGO Pick a Brick. Element
IDs come from the database's `elements` table (schema 4). The skill has Claude
check the tool's guesses on Pick a Brick in a browser and pass the results back
as overrides.

The plugin packaging is in `.claude-plugin/`. Opening this repo directly in
Claude Code is for development only; test the plugin with
`claude --plugin-dir .`.
