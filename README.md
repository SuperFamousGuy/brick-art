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

## Install

brick-art is a [Claude Code](https://claude.com/claude-code) plugin. It
requires Node.js 22.18 or later.

Add the marketplace:

```
/plugin marketplace add SuperFamousGuy/brick-art
```

Install the plugin:

```
/plugin install brick-art@brick-art
```

### First run

The first session after you install the plugin builds the parts database in
the background. The build downloads about 165 MB and takes a few minutes. You
can keep working while it runs. Until it finishes, the lookup tools report
"not ready".

The database lives in the plugin data folder. Claude Code removes it when you
uninstall the plugin.

## Lookup tools

Claude uses these tools to choose real parts:

| Tool | Purpose |
| --- | --- |
| `search_parts` | Search parts by size, category, color, trait, or name. |
| `get_part` | Get the size, geometry, connections, and colors of one part. |
| `find_by_use` | Find parts for a creative use, such as a tree or a window. Creative uses are labeled `suggestion`. |
| `find_compatible_parts` | Find parts that connect to a given part. |
| `find_substitutes` | Find alternates for a part in a color it does not come in. |
| `list_colors` | List the available colors. |
| `database_status` | Check whether the database is ready, when it was built, and its source versions. |

Default lookups skip incomplete parts, printed variants, and placeholder
colors.

## Refresh the data

To rebuild the database from the latest source data, run:

```
/brick-art:reseed
```

The refresh runs in the background. Claude reports the database status when
it finishes.

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

In development, the database goes in `.data/` in the repository. Git ignores
that folder. To build it by hand, run:

```
bin/brick-art-seed
```

## Data sources and attribution

brick-art builds its database from these sources:

- Part data from [Rebrickable](https://rebrickable.com) (rebrickable.com).
- Part geometry from [The LDraw Parts Library](https://www.ldraw.org)
  (ldraw.org), licensed CC BY 4.0 / CC BY 2.0.
- Connection data from the
  [LDCad Shadow Library](https://github.com/RolandMelkert/LDCadShadowLibrary)
  by Roland Melkert, licensed CC BY-SA 4.0.

The plugin downloads this data to your machine when it builds the database.
It does not redistribute the data.

### Release note for maintainers

A person must check Rebrickable's terms of use before the first public
release.

## Status

Early development. The parts database and lookup tools work. The model
format and the rendering pipeline are not built yet.

## Disclaimer

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or
endorse this project.
