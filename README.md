# brick-art

Generate LEGO-style brick models from a text description.

Image models turn a prompt into a picture. brick-art turns a prompt into a
buildable brick model. You describe what you want, and Claude selects the
bricks, plans how they fit together, and gives you everything you need to
build it.

## What you get

For each prompt, brick-art produces:

- **Parts list**: every brick in the model, with type, size, color, and
  quantity.
- **Instruction manual**: numbered, step-by-step build instructions.
- **Preview image**: an SVG of the finished model.

## Example

> Build a small red lighthouse on a rocky gray base.

Claude responds with the parts list, the build steps, and an SVG of the
completed lighthouse.

## How it works

brick-art runs as a [Claude Code](https://claude.com/claude-code) project.
Open this repository in Claude Code and describe the model you want. The
project context in [CLAUDE.md](CLAUDE.md) tells Claude what to produce.

## Status

Early development. The model format, part catalog, and rendering pipeline are
not built yet.

## Disclaimer

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or
endorse this project.
