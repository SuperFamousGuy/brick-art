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
   far.
3. **SVG rendering.** An image of the fully built model. This is the current
   visual output; richer renderings may replace or extend it later.

## Guiding principles

- Use real, commonly available brick parts and colors so a person can build
  the model with physical bricks.
- Keep the model physically buildable: every brick connects to the model, and
  each step only adds parts that attach to what already exists.
- Keep the parts list, instructions, and SVG consistent with each other. They
  describe the same model.

## Status

The project is at its start. No code, part catalog, or output format exists
yet. Design decisions such as the model representation, part catalog source,
and rendering approach are still open.
