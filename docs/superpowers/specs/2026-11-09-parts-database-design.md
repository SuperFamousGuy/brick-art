# Parts database and lookup tool: design

Date: 2026-11-09
Status: Draft for review

## Intent

brick-art designs buildable brick models from a text prompt. To do that,
Claude needs detailed knowledge of the real parts it can use: what exists,
what shape each part has, how parts connect, which colors each part comes
in, how common it is, and what it can represent beyond its intended purpose
(a banana as a flower petal, for example).

This project builds that knowledge as a local database and gives Claude a
lookup tool to query it during a build.

The user's requirements:

- A script seeds the database. The seeded database is not stored in the
  repo.
- Seeding is reproducible on any machine and runs as part of setup when
  brick-art is installed as a Claude Code plugin.
- Seeding uses the latest public data. It records exactly which data it
  used. "Reproducible" means any machine can run the same process and get
  a database built the same way from the then-current data. It does not
  mean rebuilding a past database byte for byte. No download archive,
  version pinning, or rebuild-from-manifest option is needed.
- The project includes the lookup tool, not only the database.
- Creative-use data is drafted by Claude, marked unreviewed, and can be
  reviewed later. A human review of every entry is not required to ship.

## Goals

1. A seed script that downloads public part data, processes it, and writes
   a SQLite database to the plugin's persistent data folder.
2. Automatic seeding the first time a session starts with the plugin
   installed, and again when the seed logic or curated data changes.
3. A manifest inside the database that records every source used.
4. A curated creative-use dataset in the repo, merged in during seeding.
5. An MCP server, bundled with the plugin, that exposes lookup tools to
   Claude.
6. The minimal plugin packaging needed for the above to load: plugin
   manifest, hook config, and MCP config.

## Non-goals

- Checking whether a whole model is buildable. That needs a model format,
  which does not exist yet. This database supplies the data such a checker
  will need.
- Rendering SVGs. Same reason. The database supplies color RGB values and
  links to part geometry for a future renderer.
- Prices, marketplace availability, or purchase links.
- Minifigures and sets as first-class objects. Set data is used only to
  compute how common a part is.
- A hosted or shared database. Every machine builds its own.

## Anti-goals

These outcomes would count as failure even if the code works:

- The seeded database, or the downloaded source files, committed to the
  repo.
- The first session after install hangs for minutes while seeding blocks
  Claude.
- The lookup tool suggests parts that do not exist in the requested color,
  or rare parts ahead of common ones, so a person cannot build the result.
- Unreviewed creative uses presented to Claude as established fact.
- Silent data loss: parts dropped during seeding without being counted or
  flagged.

## Constraints

### Plugin environment

Facts confirmed from the Claude Code docs on 2026-11-09:

- Plugins have no install-time hook. Setup runs from a `SessionStart`
  hook, which checks state and seeds when needed.
- `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) persists across
  plugin updates and is deleted on uninstall. The database, downloads
  cache, and logs go here.
- `${CLAUDE_PLUGIN_ROOT}` is the installed version's directory. It changes
  on every update. Nothing is written there.
- Claude Code automatically installs Node.js dependencies for a plugin
  that has a `package.json` and a supported lockfile. Lifecycle scripts do
  not run, git dependencies are not supported, and install has a 60-second
  timeout. Python dependencies are not installed automatically.
- A plugin can bundle an MCP server through `.mcp.json` at the plugin
  root. Path variables are substituted in `command`, `args`, and `env`.

### Language and runtime

- TypeScript on Node.js. Reason: automatic dependency install (above).
- SQLite through Node's built-in `node:sqlite` module. No native add-ons,
  because lifecycle scripts do not run, so packages that compile or
  download binaries on install fail.
- All dependencies must be pure JavaScript. Ship compiled JavaScript in the
  repo or run TypeScript directly with Node's type stripping; the builder
  chooses, but the plugin must work without a build step on the user's
  machine.
- Minimum Node.js version: the lowest version where `node:sqlite` works
  without a flag (22.13). The seed and server check the version at start
  and report a clear error if it is too old.

### Data sources

Facts confirmed on 2026-11-09:

**Rebrickable CSV downloads.** Gzipped CSVs at
`https://cdn.rebrickable.com/media/downloads/<name>.csv.gz`. They update
daily and have no versioned URLs. Files and approximate sizes:

| File | Size | Used for |
|------|------|----------|
| `parts.csv.gz` | 1.0 MB | Part identity, name, category |
| `part_categories.csv.gz` | 1 KB | Category names |
| `part_relationships.csv.gz` | 197 KB | Alternates, molds, prints, sub-parts |
| `colors.csv.gz` | 5 KB | Color names, RGB, transparency |
| `elements.csv.gz` | 1.1 MB | Part and color combinations LEGO produced |
| `inventory_parts.csv.gz` | 14 MB | Which parts appear in which inventories, in which colors |
| `inventories.csv.gz` | 268 KB | Links inventories to sets |
| `sets.csv.gz` | 523 KB | Set year |

`themes`, `minifigs`, `inventory_sets`, and `inventory_minifigs` are
available but not needed.

Rebrickable's website blocks automated access, so its terms of use were
not checked. **Before public release, a person must read
rebrickable.com/terms in a browser** and confirm the data may be used this
way. The README must credit Rebrickable as required.

**LDraw parts library.** `https://library.ldraw.org/library/updates/complete.zip`,
about 147 MB, about 17,230 parts. Monthly releases named `YYYY-RR` (for
example 2026-10). Each part file carries a `!LICENSE` line, normally CC BY
4.0 or CC BY 2.0 and 4.0. Attribution to "The LDraw Parts Library" is
accepted. Some older files may carry deprecated license lines, including
"Not redistributable"; record each part's license line in the database.

The official LDraw library has no connection metadata. Its spec forbids
meta commands other than comments, BFC, and `!TEXMAP` in official parts.

**LDCad shadow library.** `github.com/RolandMelkert/LDCadShadowLibrary`,
CC BY-SA 4.0, actively maintained (last push 2026-09-10). It adds
connection ("snap") metadata for many LDraw parts. The database is built
locally and not redistributed, so share-alike does not affect the repo,
but the README must credit it.

## Design

### Overview

```
SessionStart hook ──► bootstrap (fast check) ──► seed (background, if needed)
                                                    │
                    downloads cache ◄── fetch ──────┤
                                                    ▼
                                   ${CLAUDE_PLUGIN_DATA}/parts.db
                                                    ▲
Claude ◄──── MCP tools ◄──── MCP server (read-only) ┘
```

### Seeding trigger

The `SessionStart` hook runs a fast bootstrap check. It must return in
well under a second when no work is needed.

The bootstrap seeds when any of these is true:

- The database does not exist.
- The database's recorded seed version differs from the seed script's
  version. The seed version is a constant the builder bumps when the
  schema or derivation logic changes.
- The hash of the curated data files in the repo differs from the hash
  recorded in the database.

When seeding is needed, the bootstrap starts the seed as a detached
background process and returns immediately. Seeding must never block the
session. Rules:

- A lock file in the data folder prevents two sessions from seeding at
  once. A stale lock (its process no longer running) is cleared.
- A failed or interrupted seed never leaves a half-built database in
  place, and the previous database (if any) stays usable. The seed writes
  each build to a new versioned file (for example `parts-<timestamp>.db`).
  On success it updates a small pointer file that names the current
  database. The MCP server reads the pointer and reopens the database
  when the pointer changes. Old database files are deleted once no
  process has them open. This works on Windows, where renaming over an
  open file fails, as well as on macOS and Linux.
- The seed writes progress and errors to a log file in the data folder.
- If seeding fails, the next session start retries. After repeated
  failures, the status tool reports the last error.

A curated-data-only change (new creative-use entries) may reuse cached
downloads instead of fetching again. The builder decides how long cached
downloads stay valid.

Users can also run the seed by hand to refresh to the latest public data.
The builder decides the exact entry point (a `bin/` command, a slash
command, or both).

### Manifest

The database has a manifest table. Each seed run records:

- Seed version and curated-data hash.
- Seed start and finish time.
- For each source file: URL, download time, size, SHA-256 checksum, and
  the server's `Last-Modified` header.
- LDraw release name (read from the archive) and LDCad shadow library
  commit SHA.
- Counts: parts loaded, parts with connection data, parts flagged
  incomplete, creative-use entries loaded and rejected.

### Matching Rebrickable parts to LDraw files

`parts.csv` has no LDraw IDs. Its columns are `part_num`, `name`,
`part_cat_id`, and `part_material`. Measured on 2026-11-09, an exact,
case-insensitive match of `part_num` to an LDraw file name in
`ldraw/parts/` matched:

| Rebrickable parts, ranked by number of sets | Matched |
|---------------------------------------------|---------|
| Top 200 | 98.5% |
| Top 1,000 | 95.8% |
| Top 3,000 | 80.8% |
| All parts excluding stickers and prints | 25.4% |

The misses near the top are mostly multi-part assemblies (such as
`970c03`, minifigure hips and legs) and minifigure accessories. The long
tail of misses is mostly rare, printed, or non-brick items.

Matching rules:

1. Exact case-insensitive match of part number to LDraw file name.
2. If no match, follow `part_relationships.csv` alternate and mold links
   to a part that does match, and use its geometry.
3. Otherwise, mark the part incomplete.

Do not use the Rebrickable API. Its per-part external IDs would improve
matching, but the API needs a personal key, which breaks automatic setup.

Acceptance threshold: at least 95% of the top 1,000 parts by set count
must have geometry after matching. The seed records the measured rate in
the manifest. If a future source change drops it below 95%, the seed
still completes, and the status tool reports the drop.

### Units and coordinates

Store geometry in LDraw units (LDU), the native unit of the source data:

- 1 stud pitch = 20 LDU (horizontal).
- 1 plate height = 8 LDU. 1 brick height = 24 LDU (3 plates).

Also store dimensions in studs and plates for easy querying. A part's
coordinate frame is its LDraw frame. Note that LDraw's y axis points down.

### Data model

The builder designs the exact tables. The database must hold the
following.

**Parts**

- Rebrickable part number (primary ID), LDraw file name, and any other
  IDs available from the sources.
- Name, category.
- Bounding box: width and depth in studs, height in plates, and exact
  LDU extents.
- Filled-space grid: which cells of the bounding box the part occupies.
  Cell size is one stud by one stud by one plate. A cell counts as filled
  if the part's geometry occupies a meaningful share of it; the builder
  sets the threshold. This grid must be queryable by size and shape (for
  example "fits in 2x2 by 2 plates with a curved top").
- Shape traits: tags such as `curved`, `round`, `slope`, `wedge`,
  `inverted`, `tile` (smooth top), `hinge`, `transparent-capable`. Derive
  them from category and name keywords, and from geometry where it is
  simple (for example a slope angle). The builder defines the tag list.
- Slope angle, where applicable.
- Set count: number of distinct sets the part appears in, any color.
- First and last year seen in a set.
- LDraw license line.
- Completeness flags: whether the part has geometry, connection data, and
  a filled-space grid. Parts missing any of these stay in the database
  and are excluded from build suggestions by default.

Printed and decorated variants (Rebrickable "print" relationships) link
to their base part. By default, lookups return base parts only.

**Connection points**

Each part has zero or more connection points. Each point has:

- Type. At minimum: stud, stud receptor (anti-stud, tube), bar, clip,
  pin, pin hole, axle, axle hole, ball, socket, hinge. The builder may
  split types further (for example hollow stud versus solid stud) where
  it changes what fits.
- Position in LDU, in the part's frame.
- Direction: the unit vector the connection faces. A side stud faces
  sideways.
- For hinge, ball, and clip connections: the allowed angle range, where
  the source data provides it.
- Source: `ldcad` (from the shadow library) or `inferred`.

Connection compatibility (which types join which) is a fixed table, not
per-part data. For example stud to stud receptor, clip to bar, pin to pin
hole, axle to axle hole, ball to socket.

Source priority: LDCad shadow library first. Where it has no data for a
part, infer connections from the LDraw geometry. LDraw part files build
studs, tubes, and other connectors from shared standard sub-files
(primitives such as `stud.dat`), so a parser can find each connector by
following sub-file references and their transforms. The builder decides
which primitives to recognize; standard studs, tubes, and anti-studs are
the minimum.

**Colors**

- Rebrickable color ID, name, RGB, and whether it is transparent.
- Color family: a curated grouping (for example green covers Bright
  Green, Dark Green, Sand Green, Olive Green, Lime, and others). Store the
  mapping in the repo as curated data.
- Exclude Rebrickable's placeholder colors (such as "Unknown" and "Any
  color") from build suggestions.

**Part and color availability**

- Each part and color combination that exists, with the number of sets
  that include it in that color and the last year it appeared.
- Sources: `elements.csv` (produced combinations) and `inventory_parts.csv`
  (combinations that appear in sets). A combination counts as available
  if either source lists it.

**Part relationships**

- Alternates, molds, prints, pairs, and sub-parts from
  `part_relationships.csv`. The substitution tool uses alternates and
  molds.

**Creative uses**

- Part, what it can represent, an optional short note on how it is used,
  a `reviewed` flag, and the source of the entry.

### Curated data in the repo

Curated data lives in a dedicated folder as hand-editable text files. The
builder chooses the format (YAML is a reasonable default because people
will edit it by hand). Two datasets:

1. **Creative uses.** Claude drafts entries for the few hundred most
   common parts, ranked by set count. Each entry starts with
   `reviewed: false`. Example:

   ```yaml
   - part: "33085"        # banana
     represents: flower petal
     note: arranged in a ring around a 1x1 round plate
     reviewed: false
   ```

   Draft entries only for uses that are known in the building community
   or clearly follow from the part's shape. Do not pad the count.

2. **Color families.** The mapping from each Rebrickable color to a
   family.

During seeding, each creative-use entry is validated against the parts
table. Entries with unknown part numbers are rejected and listed in the
seed log and manifest counts. A rejected entry never fails the whole
seed.

### Lookup tool (MCP server)

The MCP server opens the database read-only. Every tool response notes
when the database is missing or still seeding, rather than failing with a
generic error.

Default behavior across tools:

- Exclude incomplete parts, unless the caller asks to include them.
- Exclude printed variants, unless asked.
- Rank results by how common the part is (set count, then recency).
- Limit result count, with a parameter to raise it.
- Return compact results. Full detail comes from the get-part tool.

Tools:

1. **Search parts.** Filter by category, dimensions (exact or range, in
   studs and plates), available color or color family, shape traits,
   slope angle, minimum set count, and text in the name.
2. **Get part.** Everything about one part: IDs, dimensions, filled-space
   grid, connection points, available colors with per-color set counts,
   relationships, creative uses, and completeness flags.
3. **Find by use.** Search creative uses by what the part represents
   ("petal", "leaf", "eye"). Results mark unreviewed entries as
   suggestions. Optional color or color family filter.
4. **Find compatible parts.** Given a connection type, or a part and one
   of its connection points, return parts with a compatible connection.
   Optional filters as in search.
5. **Find substitutes.** Given a part and a color the part does not come
   in, return options in that color: alternates or molds that exist in
   the color, and combinations of simpler parts that fill the same
   footprint and height (for example two 1x3 bricks for a 1x6 brick).
   The builder decides how far combination search goes; at minimum, cover
   basic bricks and plates split along their length.
6. **List colors.** Colors with names, RGB, transparency, and family.
   Optional filter by family, or by a part to list only its colors.
7. **Database status.** Seed state (ready, seeding, failed), seed time,
   source versions from the manifest, and counts.

### Platforms

macOS, Linux, and Windows. Background seeding, lock handling, and stale
lock detection must work on all three.

### Plugin packaging

The repo root is the plugin root. The plugin replaces "open this repo in
Claude Code" as the way people use brick-art. Opening the repo directly
is for development only.

The repo gains the plugin manifest and the `SessionStart` hook config.
Declare the MCP server inline in the plugin manifest, not in a root
`.mcp.json`. A root `.mcp.json` would also load as project config when a
developer opens the repo, where `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PLUGIN_DATA}` are not set.

For development, the seed and MCP server use `${CLAUDE_PLUGIN_DATA}` when
it is set and fall back to a git-ignored data folder in the repo when it
is not. Developers test the plugin with `claude --plugin-dir`.

The download from `cdn.rebrickable.com` works with a plain HTTP client
(checked with curl on 2026-11-09), even though the Rebrickable website
blocks automated access. The builder should confirm this from Node early. The README explains installation, first-run
seeding, data sources with attribution, and how to refresh the data.

`.gitignore` excludes any local database or download cache a developer
creates while working in the repo.

### Testing

Tests must not depend on network access or the full downloads. Use a
small fixture set: a handful of Rebrickable CSV rows and a handful of
LDraw and LDCad part files covering a basic brick, a plate, a slope, a
part with side studs, a clip or bar part, and a hinge. Tests cover
parsing, connection inference, the filled-space grid, curated-data
validation, the atomic swap on failure, and each MCP tool against a
database seeded from fixtures.

A separate manual check runs a full seed against live sources and
reviews the manifest counts.

## Decisions

The user decided:

- The repo contains a seed script, not the database.
- Seeding runs on each machine as part of plugin setup.
- A first-run download of 100 to 200 MB that runs a few minutes is
  acceptable.
- Use the latest public data, and record what was used.
- Include the lookup tool in this project.
- Claude drafts creative-use entries flagged unreviewed. Full human review
  is not required.

Claude decided (the user can override):

- SQLite as the database.
- TypeScript on Node.js, using built-in `node:sqlite`.
- Rebrickable, LDraw, and the LDCad shadow library as sources.
- LDCad connection data first, geometry inference as fallback.
- Seeding runs in the background so it never blocks a session.
- An MCP server as the lookup interface, with the seven tools above.
- Model validation and SVG rendering are out of scope.
- Part matching by part number plus relationship links, with no
  Rebrickable API key. Acceptance threshold: 95% of the top 1,000 parts.
- macOS, Linux, and Windows support, with versioned database files and a
  pointer file instead of a rename.
- The plugin replaces direct repo use. The MCP server is declared in the
  plugin manifest, with a development data-folder fallback.

## Left to the builder

- Exact table layout, indexes, and full-text search setup.
- Curated data file format.
- The shape-trait tag list and the derivation rules.
- The filled-space threshold and the geometry method used to compute the
  grid.
- Which LDraw primitives connection inference recognizes beyond the
  minimum.
- Download cache lifetime.
- The manual refresh entry point.
- How far the substitution combination search goes, beyond the minimum.
- Whether to ship compiled JavaScript or run TypeScript directly.

## Open risks

- **Rebrickable terms of use.** Unverified. Must be checked by a person
  before public release.
- **Connection inference accuracy.** Inferred connections may be wrong for
  unusual parts. Recording the source of each point lets later tools
  weigh them.
- **Seed duration.** Parsing 17,000 LDraw parts with sub-file resolution
  may take longer than a few minutes. The builder should measure it early
  and cache resolved geometry if needed.
