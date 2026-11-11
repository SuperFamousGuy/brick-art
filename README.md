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
- **Rendered images**: studio-lit pictures of the finished model, front and
  three-quarter, made from the official 3D shape of every part.
- **Model file**: an LDraw `.ldr` file that opens in LDraw tools such as
  LeoCAD, LDView, and BrickLink Studio.

## Example

> Build a small red lighthouse on a rocky gray base.

Claude responds with the parts list, the build steps, and rendered images of
the completed lighthouse.

## Install

brick-art is a [Claude Code](https://claude.com/claude-code) plugin. It
requires Node.js 22.18 or later. Rendering also needs a Chromium-based browser:
Google Chrome, Microsoft Edge, Chromium, or Brave. To use a browser in another
location, set `BRICK_ART_BROWSER` to its executable.

Add the marketplace:

```
/plugin marketplace add SuperFamousGuy/brick-art
```

Install the plugin:

```
/plugin install brick-art@brick-art
```

### First run

The first session after you install the plugin downloads a published parts
database from the brick-art releases. The standard database is about a 55 MB
download and takes about 205 MB on disk. The download takes seconds, and the
lookup tools are ready as soon as it finishes. If the download fails, the
plugin builds a smaller database locally from the source data. That build
downloads about 165 MB and takes a few minutes. You can keep working while it
runs. Until a database is ready, the lookup tools report "not ready".

The plugin asks one question at install: **Download fan-made designs**. The
default is off. When you turn it on, the database also includes community
designs from brick-art's curated list, with positions and build steps. It
adds about 8 MB to the download.

The first render downloads the LDraw parts library, about 145 MB, into the
plugin data folder. A local database build already includes it.

The database lives in the plugin data folder. Claude Code removes it when you
uninstall the plugin.

## Tools

Claude uses these tools to choose real parts, find existing designs, and
render the result:

| Tool | Purpose |
| --- | --- |
| `search_parts` | Search parts by size, category, color, trait, or name. |
| `get_part` | Get the size, geometry, connections, and colors of one part. |
| `find_by_use` | Find parts for a creative use, such as a tree or a window. Creative uses are labeled `suggestion`. |
| `find_compatible_parts` | Find parts that connect to a given part. |
| `find_substitutes` | Find alternates for a part in a color it does not come in. |
| `list_colors` | List the available colors. |
| `search_projects` | Search official sets and fan models by name, theme, year, kind, part count, or part. Projects with build positions come first. |
| `get_project` | Get one project's parts with colors and quantities, and its sub-assemblies. |
| `get_submodel` | Get the placed parts of one sub-assembly step by step, with colors, positions, and rotations. |
| `database_status` | Check whether the database is ready, when it was built, and its source versions. |
| `render_model` | Render an LDraw model file to PNG images, and tally the parts and colors it places. |

Default part lookups skip incomplete parts, printed variants, and placeholder
colors. Project results carry the author, license, and URL of each model, so
Claude can credit them.

## Refresh the data

To download the latest published database, run:

```
/brick-art:reseed
```

To rebuild the database on your machine from the source data instead, run:

```
/brick-art:reseed --local
```

Both commands run in the background. Claude reports the database status when
the refresh finishes.

## Development

Clone the repository and install the dependencies:

```
npm install
```

Run the tests and the type check:

```
npm test
```

```
npm run typecheck
```

Load the plugin from your working copy:

```
claude --plugin-dir .
```

With `--plugin-dir`, Claude Code does not prompt for the plugin options. To
turn on fan-made designs in development, set `BRICK_ART_FAN_PROJECTS` when you
start Claude Code. It applies to that session only and is not saved:

```
BRICK_ART_FAN_PROJECTS=true claude --plugin-dir .
```

In development, the database goes in `.data/` in the repository. Git ignores
that folder. To build it by hand, run:

```
node src/entry/seed.mjs
```

This builds the `fallback` variant: set parts lists without build positions.
To build another variant, pass `--variant standard` or `--variant full`. On
macOS and Linux, `bin/brick-art-seed` is a shortcut for the same command.

## Data sources and attribution

Data sourced from [Rebrickable](https://rebrickable.com) (rebrickable.com).

brick-art builds its database from these sources:

- Part, color, set, and set parts list data from Rebrickable.
- Part geometry from [The LDraw Parts Library](https://www.ldraw.org)
  (ldraw.org), licensed CC BY 4.0 / CC BY 2.0.
- Connection data from the
  [LDCad Shadow Library](https://github.com/RolandMelkert/LDCadShadowLibrary)
  by Roland Melkert, licensed CC BY-SA 4.0.
- Part positions and build steps for official sets from the
  [LDraw Official Model Repository (OMR)](https://library.ldraw.org/omr)
  and its authors. Only models with an open license are used. Each author is
  credited in `CREDITS.md`.
- Fan-made designs from [Datsville](https://github.com/mjhorvath/Datsville), when you
  turn on the fan-made option.

### Database license

The published database is licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Each release
includes a `CREDITS.md` file that lists every source and every OMR author.

## Status

Early development. The parts and project databases, the lookup tools, and
rendering work, and CI publishes the database. Models are LDraw files. Rendered
images for each instruction step are not built yet.

## Disclaimer

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or
endorse this project.
