---
name: build-model
description: Design a buildable LEGO-style brick model from a text description and deliver its parts list, step-by-step instructions, and rendered images. Use when the user asks to build, design, or make a model, MOC, or brick version of something, such as "build a small red lighthouse".
---

# Build a brick model

Turn the user's description into a model built from real parts, and deliver three
outputs that describe the same model:

1. A parts list.
2. Step-by-step build instructions.
3. Rendered images of the finished model.

The LDraw model file is the source of truth. Write it first, then derive the parts
list and the instructions from it, and render it with `render_model`.

## Workflow

1. **Study a reference.** Before you design, call `search_projects` for an official
   set or fan model of the same subject (or a close one), and read one with
   `get_project` or `get_submodel`. Note the part count, footprint, and the parts and
   techniques it uses for shape and detail. Aim to match that level of detail.
2. **Plan.** Decide the scale, footprint, silhouette, and color scheme, then list the
   features that make the subject recognizable and the technique for each. Follow
   "Detail baseline". Choose a size that is large enough to show those features.
3. **Choose parts.** Use the brick-art lookup tools: `find_by_use` for parts that can
   represent something (a leaf, a window), `search_parts` by size and category,
   `get_part` for dimensions and connections, `find_compatible_parts` for what
   attaches to what, and `list_colors` with `partNum` to confirm a part comes in a
   color. `search_projects` and `get_submodel` show how official sets build similar
   things, with exact positions.
4. **Write the model.** Create a folder named after the model in the current working
   directory (for example `./lighthouse/`), and write `<name>.ldr` there. See
   "LDraw model format".
5. **Render.** Call `render_model` with the absolute path of the `.ldr` file. It
   writes `<name>-front.png` and `<name>-angle.png` next to the model and returns
   their paths, plus a tally of every part and color the file places.
6. **Check.** Look at both images. Fix and re-render when a part floats, overlaps
   another part, faces the wrong way, or does not connect. Compare the returned
   tally with your intended parts list; the tally is what the file actually contains.
7. **Refine.** Review the images against "Detail baseline" as a critic would. If the
   model looks blocky, flat, or pixelated, or if it misses a feature from your plan,
   add detail and render again. Do at least one refinement pass before you deliver.
8. **Deliver.** Write `<name>.md` with the parts list and the instructions, show the
   user the images, and give the paths of the `.ldr`, `.md`, and PNG files.

## Detail baseline

The first version must look like a finished set, not a stack of plain bricks. A
model built only from rectangular bricks and plates reads as pixel art. Meet these
minimums unless the user asks for something simpler, such as a microscale model:

- **Size.** Aim for 80 to 250 parts for a typical subject. Small subjects, such as
  a mailbox or a mushroom, can use 40 or more parts. Buildings, vehicles, and
  scenes often need 300 or more parts.
- **Part variety.** Use at least 20 distinct part types. No single plain brick or
  plate type makes up more than about a third of the parts.
- **Shaped silhouette.** Shape every edge and roofline that is not square in the
  real subject. Use slopes, curved slopes, inverted slopes, wedges, arches, round
  bricks, cones, and dishes instead of stair-stepped bricks.
- **Finished surfaces.** Cover visible top surfaces with tiles where the real subject
  is smooth. Leave studs only where they add texture, such as on grass or rock.
- **Sideways building.** Use bricks with studs on the side (SNOT bricks), brackets,
  and headlight bricks to mount details on vertical faces, such as windows, signs,
  trim, and panels.
- **Small details.** Add at least 5 kinds of detail that make the subject
  recognizable. Examples include windows with frames, doors, lamps, railings,
  fences, plants, rocks, signs, eyes, buttons, handles, and grilles. Use
  `find_by_use` to find parts that can represent each one.
- **Color.** Use 3 to 6 colors with intent: a main color, a secondary color, an
  accent color, and darker or lighter shades for depth. Break up large single-color
  walls with a texture, a trim line, or a variation in shade.
- **Base or context.** Give a standing subject a base, terrain, or ground plate with
  its own detail, unless the subject is a vehicle or a free-standing object.

Use submodels for repeated or complex assemblies, such as a window, a wheel set, or
a roof section. This keeps a larger model manageable.

## LDraw model format

A part placement is one line:

```
1 <color> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <part>.dat
```

- **Units:** a stud pitch is 20 LDU, a plate is 8 LDU tall, and a brick is 24 LDU
  tall. Studs are not included in those heights.
- **Axes:** y points down, so higher parts have more negative y. The model's front
  faces -z.
- **Origin:** most parts have their origin at the top center of the body, below the
  studs. A brick placed at y = 0 sits on top of a brick placed at y = 24.
- **Rotation:** `a b c / d e f / g h i` is a 3x3 rotation matrix by rows. The identity
  is `1 0 0 0 1 0 0 0 1`.
- **Part:** the LDraw file name of the part, which is usually the Rebrickable part
  number, such as `3001.dat`. `get_part` returns it as `ldrawFile`.
- **Color:** an LDraw color code. For common colors the code equals the Rebrickable
  color id. The `render_model` tally names each code from LDraw's own color table, so
  check that the names match the colors you chose.
- **Steps:** put `0 STEP` after each group of parts that makes one build step.
  Each step adds parts that attach to what is already built.
- **Header:** start the file with `0 <Model title>`, `0 Name: <name>.ldr`, and
  `0 Author: brick-art`.

Large models can split into submodels: write each one as its own `.ldr` file in the
same folder and place it with a type 1 line like a part. `render_model` reads them
from the model's folder.

## Parts list

One row per part and color: quantity, part number, part name, color name, and
size. The totals must match the `render_model` tally.

## Instructions

Number the steps to match the `0 STEP` groups in the `.ldr` file. For each step,
list the parts it adds and say where each one goes, relative to parts already
placed.

## If rendering fails

`render_model` needs Chrome, Edge, Chromium, or Brave. Without a GPU it falls back to
software rendering, which takes longer. The first render downloads the LDraw parts
library, about 145 MB, unless it is already cached.

When `render_model` reports that no browser is installed, tell the user, and offer an
SVG drawing of the model as a fallback. When it reports a missing part, fix the part
name in the `.ldr` file and render again.
