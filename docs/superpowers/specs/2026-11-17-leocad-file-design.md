# LeoCAD file design

Date: 2026-11-17
Status: Ready for approval

## Intent

Each build should come with a file the user can open in LeoCAD
(https://www.leocad.org/) to edit, view, render, and share the model. It must be
fully usable in LeoCAD, not just readable.

LeoCAD opens our `.ldr` files today, but a model with submodels is spread over
several `.ldr` files in one folder. That folder breaks as soon as one file is
shared, and the `.ldr` carries none of LeoCAD's own data such as model
properties and saved cameras.

## Goals

- A new MCP tool writes `<name>.mpd` next to `<name>.ldr`: one self-contained
  file with the main model and every submodel it uses.
- The file opens in LeoCAD with the parts, colors, build steps, step text, and
  `ROTSTEP` views intact.
- It carries LeoCAD model properties (name, author, description) and two named
  cameras, `Front` and `Three-quarter`, that match the `render_model` views.
- A model edited and saved in LeoCAD can go back through `render_model`,
  `render_instructions`, and `pick_a_brick_list`, which already accept `.mpd`.

## Non-goals

- LeoCAD's legacy binary `.lcd` format.
- LeoCAD groups, lights, or animation key frames. Submodels already give the
  model its structure, and groups make single parts harder to select.
- Changing the `.ldr` file. It stays the source of truth for the build.

## Anti-goals

- Silently overwriting a `.mpd` the user has edited in LeoCAD.
- A file that looks right but has never been opened in LeoCAD.

## Approaches

1. **One bundled `.mpd` file (picked).** A new writer inlines the main model
   and every submodel as `0 FILE` blocks and adds `0 !LEOCAD` lines. One file to
   share, and the `.ldr` stays untouched.
2. **Add `0 !LEOCAD` lines to the `.ldr`.** Least work, but submodels stay in
   separate files, so sharing still breaks, and other LDraw tools see lines
   they don't use.
3. **LeoCAD's legacy `.lcd` format.** Ruled out. LeoCAD keeps it only for
   opening old files.

## Design

- **Tool:** `leocad_file` (in `src/leocad/`), registered in `src/mcp/server.ts`.
  Input: the absolute path of the `.ldr`. Output: the `.mpd` path, the list of
  submodels it inlined, and the camera names.
- **File layout:** `0 FILE <name>.ldr` first, then each submodel once, in the
  order it is first referenced, found recursively in the model's folder (as
  `render_model` does with `modelFolderFiles`). Each block ends with
  `0 NOFILE`. Model lines are copied as written, including `0 STEP`,
  `0 ROTSTEP`, and `0 //` step text. A referenced file that is neither a
  submodel in the folder nor a library part is an error.
- **LeoCAD lines,** in the main block after the header, using the syntax from
  https://www.leocad.org/docs/meta.html:
  - `0 !LEOCAD MODEL NAME`, `AUTHOR`, and `DESCRIPTION` from the `.ldr` header.
  - Two cameras with `POSITION`, `TARGET_POSITION`, `UP_VECTOR`, and `NAME`,
    built from the model's bounding box and the `DEFAULT_VIEWS` yaw and pitch
    in `src/render/render.ts`, so they frame the model as the renders do.
- **Overwrite rule:** the tool writes a `0 !BRICKART LEOCAD_FILE <hash>` line
  holding a hash of the content it wrote. If an existing `.mpd` no longer
  matches its hash, or has no hash line, the tool refuses unless called with
  `overwrite: true`, and says the file may hold LeoCAD edits.
- **Skill and docs:** `skills/build-model/SKILL.md` calls the tool after
  `render_model`, lists the `.mpd` in the delivered files, and explains that
  once the user edits the `.mpd` in LeoCAD, it becomes the input for any
  re-render. `README.md` and the required outputs in `CLAUDE.md` mention it.

## Verification

- Unit tests (`tests/leocad/`): single-file model, nested submodels, a submodel
  used twice (inlined once), a missing submodel, the LeoCAD lines, and the
  overwrite rule.
- Install LeoCAD with Homebrew (`brew install --cask leocad`). For a small test
  model and `titanic-transformer`, run LeoCAD's command line to render the
  `.mpd` from each named camera, and check that the images show the whole model.
- Round trip: open, save in LeoCAD, then run `render_model` and
  `render_instructions` on the saved file.

## Left to the builder

- Camera distance and field of view, as long as the whole model is in frame.
- Whether the bounding box comes from the render code or a small new helper.
- Exact error wording.
