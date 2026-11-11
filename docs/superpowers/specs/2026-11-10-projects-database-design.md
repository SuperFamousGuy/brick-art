# Projects database and published data: design

Date: 2026-11-10
Status: Draft for review

## Intent

brick-art designs buildable brick models from a text prompt. Today Claude
designs every model from scratch, using the parts database to pick real
parts. This project gives Claude a second reference: models that already
exist, both official LEGO sets and fan-made designs (MOCs).

Claude can use them in two ways. The user does not want to predict which
one Claude will pick for a given prompt, so the database supports both:

1. **Inventory lookup.** "What parts and colors did a real model of X
   use?" This needs only a parts list per model.
2. **Technique lookup.** "How does a real model build a roof, a lamp, or a
   curved wall?" This needs each part's position and the step that adds
   it, so Claude can lift a section (an "individual piece" of another
   project) into a new model.

This project also changes how the database reaches users. Until now,
every machine built its own database from public sources. From now on,
the project builds the database once, in CI, and publishes it as a
GitHub release. The plugin downloads the published database. The user
chose this because it is the better product: installs take seconds
instead of minutes, and slow sources (the LDraw model repository has no
bulk download) only cost time in CI.

The user's requirements:

- Projects live in the same database as the parts and reference the
  existing part and color records. They do not keep their own copies of
  part data.
- The default install finishes in under 5 minutes. Five minutes is the
  user's cut-off for "too long".
- Fan-made projects are an install-time option, off by default.
- Nothing is locked out. A user who wants every source can get it.
- Fan-made projects come from a curated list of sources in the repo,
  downloaded automatically, not from scraping sites that forbid it.
- The project publishes a prebuilt database, built in CI and hosted as a
  GitHub release.

## Goals

1. Official sets as projects: name, year, theme, and full parts list for
   every set in Rebrickable's CSV downloads.
2. Positions and build steps for official sets that the LDraw Official
   Model Repository (OMR) covers, including named sub-assemblies.
3. Fan-made projects, with positions and steps, from a curated source list
   in the repo.
4. A CI workflow that builds the full database on a schedule and publishes
   it as a GitHub release.
5. A plugin bootstrap that downloads the published database instead of
   building one, with local building kept for development and as a
   fallback.
6. An install option, chosen when the plugin is enabled and changeable
   later, for fan-made projects.
7. MCP tools that let Claude search projects, read a project's parts list,
   and read a sub-assembly's parts with positions and steps.

## Non-goals

- Rendering projects or generating instruction images.
- Studio `.io` files and other non-LDraw formats. Fan sources must offer
  LDraw files (`.ldr`, `.mpd`, or archives of them).
- Using projects to check whether a new model is buildable. That still
  waits on the model format.
- User-supplied model files. The user chose automatic downloads instead.
- Prices, purchase links, or "which sets do I own".
- Hosting anywhere other than GitHub releases.

## Changes to the parts-database design

This project reverses these parts of `2026-11-09-parts-database-design.md`:

| Parts design said | Now |
|---|---|
| Non-goal: "A hosted or shared database. Every machine builds its own." | The project publishes one database. Users download it. |
| "Seeding runs on each machine as part of plugin setup." | CI seeds. Users' machines download. Local seeding stays for development and as a fallback. |
| Non-goal: "Minifigures and sets as first-class objects." | Sets become first-class objects. Minifigures stay out, except as parts inside a set's parts list. |
| "Seeding uses the latest public data." | The published database is at most one schedule interval old. `/reseed --local` still builds from the latest data. |

These stay in force: no database or downloaded source files committed to
git; seeding (local or download) never blocks a session; a failed update
never replaces a working database.

## Anti-goals

These outcomes count as failure even if the code works:

- A database file or downloaded source data committed to git. Releases
  only.
- Publishing data whose license or terms do not allow redistribution.
- The default install takes 5 minutes or longer.
- The seed scrapes a site whose owner has said no to it. Rebrickable
  removed MOC access from its API in 2020, saying too many sites were
  taking its MOC data. BrickLink Studio has no public API.
- The seed hammers ldraw.org, a volunteer-run site, with unbounded
  parallel requests or re-downloads unchanged files on every run.
- A project appears without its author or designer, license, and source
  link, so Claude cannot credit it.
- A placement silently points at a part or color that is not in the
  database. Unmatched references are kept, counted, and flagged.
- Turning an option on or off requires reinstalling the plugin.
- A plugin update that changes the schema leaves users with no working
  database because no matching release exists yet.

## Constraints

### Plugin install options

Facts confirmed from the Claude Code docs on 2026-11-10
(code.claude.com/docs/en/plugins/manifest-reference.md#user-configuration):

- `plugin.json` can declare `userConfig`: an object of options, each with
  `type` (`string`, `number`, `boolean`, `directory`, `file`), `title`,
  `description`, and optional `default`. A `string` with `options` shows
  a picker, but only on Claude Code 2.1.271 and later.
- Claude Code asks for the values when the plugin is enabled. Users change
  them later in `/plugin` under the plugin's **Configure options**.
  Non-sensitive options also appear in `/config`.
- Hook processes receive every option as `CLAUDE_PLUGIN_OPTION_<KEY>`
  (key uppercased). MCP server config can use `${user_config.KEY}`.
- A community bug report says the options may not appear for plugins
  loaded with `--plugin-dir`, which is how developers test. Not verified.

### GitHub hosting

- Release files can be up to 2 GB each and do not count toward repository
  size.
- GitHub-hosted Actions runners have about 7 GB of memory and a 6-hour job
  limit. The current seed runs with a 3 GB heap.
- Release downloads need no authentication for a public repository.

### Sizes

Measured on 2026-11-10:

- Today's parts database: 46 MB, 9 MB gzipped.
- OMR, estimated from a sample of 50 sets spread across the list: about
  2,000 model files, 230 MB of text, about 35 MB gzipped. Stored as rows,
  the builder should measure the size; an estimate of 100 to 200 MB
  uncompressed for the full database is reasonable.
- Downloading a database of this size takes well under a minute on a
  typical home connection, so the 5-minute target is easy to meet.

### Licenses of published data

The published database redistributes data from every source, so each
source's license applies:

| Source | License | Effect |
|---|---|---|
| Rebrickable CSVs | Terms read by the user on 2026-11-10: use is allowed "for any purpose, including commercial", and a statement that the data comes from Rebrickable is "highly appreciated". The clause names the API; the API docs direct bulk users to the CSVs, so the same terms are taken to apply. | Credit Rebrickable as the source in `CREDITS.md`, the README, and the status tool. |
| LDraw parts library | CC BY 4.0 or CC BY 2.0 and 4.0 for all 5,876 parts with a license line in today's database | Credit "The LDraw Parts Library". |
| LDCad shadow library | CC BY-SA 4.0 | Share-alike: the published database is released under CC BY-SA 4.0. |
| OMR models | CC BY 4.0, older files CCAL 2.0 "Redistributable" | Credit each file's author. |
| Fan sources | Per file | Only redistributable files are included (see below). |

Each release includes a credits file listing every source, its license,
and the version used.

**One license rule for every model file**, OMR and fan sources alike
(Claude's call): a model is included only if every file in it has a
license line on the allow list kept in the seed code (CC BY, CC BY-SA,
CC0, CCAL 2.0 "Redistributable", public domain), or has no license line
and comes from a source that declares an allowed `default_license`.
Anything else is skipped and counted by reason, and does not fail the
release. The 95% placement threshold is measured over included models
only. The manifest and status tool report the number skipped per source.
LDraw parts with a line outside the allow list are kept as part records
but lose their geometry in the published database.

### Data sources

**Rebrickable CSV downloads** (already used by the seed). The seed adds:

| File | Used for |
|------|----------|
| `sets.csv.gz` | Already downloaded. Add set name, theme ID, and part count. |
| `themes.csv.gz` | Theme names and parent themes. |
| `inventory_parts.csv.gz` | Already downloaded. Add the `quantity` column. |
| `inventories.csv.gz` | Already downloaded. Add the `version` column. |
| `inventory_minifigs.csv.gz`, `minifigs.csv.gz` | Minifigures inside a set, so its parts list is complete. |

A set can have several inventory versions. Use the highest version.

**LDraw Official Model Repository (OMR).** Facts checked on 2026-11-10:

- About 1,470 sets, listed at `https://library.ldraw.org/omr/sets`.
- No bulk download. Each set's page (`/omr/sets/<id>`) links one or more
  `.mpd` files at `https://library.ldraw.org/media/omr_models/<n>/<file>.mpd`.
  A set with alternate models (B-models) has one file per model. The list
  pages link thumbnails, not files, so the seed reads each set page.
  About 1,470 pages plus 2,000 files.
- Set 10001-1 is 620 KB, 872 part placements, and 24 sub-files, and took
  0.7 seconds to fetch.
- Each `.mpd` holds sub-files (`0 FILE <name>.ldr`), a main model that
  references them, and `0 STEP` lines between build steps.
- Set number is in the file name, for example `10001-1.mpd`, matching
  Rebrickable's `set_num` format.
- Header lines carry `0 Author:` and `0 !LICENSE`.

**Fan-made sources.** No large, openly licensed, bulk-downloadable
collection exists. Checked on 2026-11-10:

- Rebrickable removed MOC access from its API in 2020 to stop scraping.
  Its bulk CSVs have no MOCs.
- BrickLink Studio's gallery has no public API. Each designer decides
  whether their file can be downloaded.
- Datsville (`github.com/mjhorvath/Datsville`), a community LDraw town,
  downloads from GitHub. Licenses are mixed and written in each file's
  header. Development has slowed.

So fan-made projects come from a hand-maintained list in the repo.
Datsville is the first entry.

### Existing system kept

- Background work from a `SessionStart` hook that never blocks a session.
- Versioned database files and a pointer file swapped on success.
- Geometry in LDraw units (LDU): 1 stud = 20 LDU, 1 plate = 8 LDU, y axis
  points down.
- Parts keyed by Rebrickable `part_num`, colors by Rebrickable color ID.
- TypeScript on Node.js with `node:sqlite`. Pure JavaScript dependencies
  only.
- macOS, Linux, and Windows.

## Design

### Overview

```
GitHub Actions (schedule, or a seed change on main)
  └─ seed (full: parts, sets, OMR, fan sources)
       └─ release: standard.db.gz, full.db.gz, release.json, CREDITS.md

User's machine
  SessionStart hook ─► bootstrap ─► download matching release (background)
                                        │  fallback: local seed
                                        ▼
                         ${CLAUDE_PLUGIN_DATA}/<versioned>.db ◄─ MCP server
```

### Published releases

A GitHub Actions workflow in this repo builds and publishes the database.

- **Triggers.** A weekly schedule, a push to `main` that changes the seed
  version or curated data, and a manual run. (Weekly is Claude's call:
  Rebrickable updates daily, LDraw monthly, and a week-old database is
  fine for design reference.)
- **Build.** The workflow runs the seed with every source on, writing two
  databases:
  - `standard`: parts, official sets, and OMR positions.
  - `full`: everything in `standard` plus fan-made projects.
- **Assets.** Each release holds `standard.db.gz`, `full.db.gz`, a
  `release.json`, and `CREDITS.md`. `release.json` lists, for each
  database: schema version (the seed's `SEED_VERSION`), build time,
  SHA-256 and size of the compressed and uncompressed file, the source
  manifest, and the counts.
- **Tags.** `data-<schema version>-<YYYYMMDD>`, for example
  `data-3-20261117`. Releases are marked so they do not show as the
  repo's "latest" software release. The builder chooses how (for example
  a prerelease flag or a naming filter).
- **Retention.** Keep the last few releases for each schema version, and
  at least one release for every schema version a published plugin
  version still uses. Delete older ones.
- **CI caching.** The workflow caches downloaded sources between runs, so
  OMR files are fetched once and then only when changed. This, plus the
  polite fetch rules below, keeps load on ldraw.org to one client.
- **Gates.** The workflow fails, and publishes nothing, if the database
  fails its acceptance checks: the part-geometry threshold from the parts
  design, the 95% placement threshold below, and a final scan confirming
  that no included file has a license outside the allow list.

### Bootstrap on the user's machine

The bootstrap decides what to do at session start, still returning in
well under a second.

1. Read the options (see "Install options").
2. If the current database matches the plugin's schema version and the
   chosen variant, and was checked for updates within the last day, do
   nothing.
3. Otherwise start a background process that:
   - Finds the newest release whose tag matches the plugin's schema
     version, using the GitHub releases API without a token, or a fixed
     URL pattern if the builder prefers to avoid the API's rate limit.
   - Downloads the chosen variant only if it is newer than the current
     database.
   - Checks its SHA-256 against `release.json`, decompresses it to a new
     versioned file, and swaps the pointer.
4. If no matching release exists, or the download fails, and the user
   has no usable database, the background process runs a **fallback
   seed**: parts and official sets only, no OMR positions and no fan
   projects. This keeps the fallback within the 5-minute target and
   keeps ldraw.org's traffic to CI alone, even when many users fall back
   at once after a schema change. The status tool and the project tools
   say that positions arrive with the next release. The bootstrap keeps
   checking for a release at each session start and replaces the
   fallback database when one appears. (Claude's call.)

**Curated data and downloaded databases.** A downloaded database carries
the curated data CI built it from, and that is authoritative. The
bootstrap does not compare a downloaded database's curated hash with the
plugin's own `curated/` folder, so a plugin slightly ahead of or behind
`main` never triggers a local reseed. The curated-hash check still
applies to locally seeded databases. (Claude's call.)

The MCP server already reopens the database when the pointer changes, so
updates appear without a restart.

The status tool reports the release tag, variant, build time, and
whether the database came from a release or a local seed.

### Local seeding

The seed script stays. It is what CI runs, and it remains available on
users' machines:

- **Development.** Developers seed locally as today.
- **Fallback.** When no matching release can be downloaded. Parts and
  official sets only, as described above.
- **`/reseed`.** Downloads the newest matching release. `/reseed --local`
  builds the user's chosen variant from the latest public data on their
  machine, including OMR, taking several minutes plus about 10 minutes
  for OMR. Only an explicit user request fetches OMR from a user's
  machine.

A local seed uses the same rules as CI, including the polite OMR fetch
rules below.

### Install options

One boolean option in `plugin.json`:

| Option | Default | Effect |
|--------|---------|--------|
| `fan_projects` | `false` | Download the `full` database, which adds fan-made projects. |

Positions are no longer an option. They were optional only because
fetching them took about 10 minutes. With publishing they add tens of MB
to a download that takes seconds, so every install gets them. (Claude's
call. This replaces the earlier `set_positions` option and its
"recommended" prompt; the user can ask to restore it.)

The option's title and description say what it adds and how much bigger
the download is, for example: "Download fan-made designs. Adds community
designs from a curated list. Adds about 8 MB to the download." The builder
fills in N.

**How the bootstrap reads the option.** The hook receives it as
`CLAUDE_PLUGIN_OPTION_FAN_PROJECTS` and writes it to an options file in
the data folder. The `/reseed` command, which runs from the Bash tool
without that variable, reads the file. For development with
`--plugin-dir`, the environment variable `BRICK_ART_FAN_PROJECTS`
overrides the file.

**Users who were never prompted.** Users loading the plugin with
`--plugin-dir`, or on a Claude Code version without plugin options, get
the default. On the first session, the bootstrap's hook output tells
Claude which variant it is installing, so Claude can tell the user and
point them to `/plugin` (**Configure options**) to change it.

**Changing the option.** The bootstrap sees that the chosen variant
differs from the current database and downloads the other one in the
background.

### OMR download

These rules apply in CI and in local seeds:

- Read the set list pages, then each set page, to collect `.mpd` URLs.
- Limit concurrency to a small number (4 is a reasonable start) and send
  the existing generic `brick-art-seed` user agent.
- Cache every file. On later runs, skip files whose URL version
  (`?v=<timestamp>`) has not changed, or send conditional requests.
- Retry transient failures a few times with backoff. A set that still
  fails is skipped and counted.
- Record in the manifest: sets listed, files fetched, files from cache,
  files failed, and total bytes.

### Curated fan-made sources

A new curated file, `curated/fan-sources.yaml`, lists each source:

```yaml
- id: datsville
  name: Datsville
  homepage: https://github.com/mjhorvath/Datsville
  fetch:
    kind: github          # github | url
    repo: mjhorvath/Datsville
    paths: ["models/**/*.ldr", "models/**/*.mpd"]   # which files are models
  designer: Datsville contributors   # fallback when a file has no Author line
  # default_license: optional; applies to files with no !LICENSE line
```

- `github` sources download the default branch as an archive and record
  the commit SHA, the same way the seed handles the LDCad shadow library.
- `url` sources download one file or archive.
- Datsville's real file layout is for the builder to confirm. The paths
  above are a guess.
- **What is one project.** Within a source, a top-level model is a model
  file that no other model file in the source references. Each top-level
  model becomes one project. Files it references, directly or through
  other files, become sub-assemblies inside that project. A file used by
  several top-level models appears as a sub-assembly in each, so
  sub-assembly references never cross project boundaries. (Claude's
  call.)
- **Licenses.** The seed reads each file's `0 Author:` and `0 !LICENSE`
  lines and stores them. A project's license is its top-level file's
  line. A project is included only if every file in it has a license on
  an allow list kept in the seed code: CC BY, CC BY-SA, CC0, CCAL 2.0
  "Redistributable", or public domain. A file with no license line uses
  the source's `default_license` if it has one, and is otherwise treated
  as not allowed. Skipped projects are counted. Datsville's entry has no
  default license, so its unlicensed files are left out. (Claude's call.)
- **Adding a source.** Edit this file. Rule: the source's owner allows
  automated download, and its files carry or come with a license that
  permits redistribution. The reviewer of the change checks this. A
  change to this file triggers a new release.

### Matching LDraw references to the database

LDraw files name parts by LDraw file (`3001.dat`) and colors by LDraw
color code. The database uses Rebrickable part numbers and color IDs.

**Parts.** Reverse the existing match. The parts table already stores
each part's `ldraw_file`. Build a map from LDraw file to Rebrickable
`part_num`. Where several Rebrickable parts share one file, prefer the one
whose `geometry_from` is itself (an exact match) over one that borrowed
geometry through a relationship. A reference with no match stays in the
database with its raw LDraw file name and a null `part_num`, and is
counted.

**Colors.** Rebrickable color IDs equal LDraw codes for most common
colors, but not all. The builder sets up the mapping from the LDraw
library's `LDConfig.ldr` (already downloaded as part of `complete.zip`),
matching by code, then confirming by name or RGB. Record the match rate.
Color code 16 ("current color") inherits the color of the placement that
references the sub-file, so resolve it when flattening.

**Acceptance threshold.** At least 95% of part references across all OMR
files resolve to a known part and color. Primitives and flexible segments are
excluded, and "Moved to" and "=" aliases are followed. The first draft set the
threshold at 98% of all placements. It was revised after the first live build
measured 81% raw and 95.2% over part references. CI does not publish a database below
the threshold. A local seed below the threshold still completes, and the
status tool reports the drop.

### Data model

The builder designs the exact tables. The database must hold the
following.

**Projects**

- ID, source (`rebrickable`, `omr`, or a fan source ID), and source key
  (set number or file path).
- Kind: `official` or `fan`.
- Name, year, theme (with parent theme), part count.
- Author or designer, license line, source URL.
- Whether positions and steps are available.
- For official sets: one project per set number. OMR data attaches to the
  Rebrickable set with the same number. An OMR B-model becomes its own
  project linked to the set.

**Parts list (inventory)**

- Project, part number, color ID, quantity, spare flag, and whether the
  part comes from a minifigure.
- Official sets use Rebrickable's inventory. Fan projects derive it by
  counting placements after flattening.

**Sub-assemblies**

- Each `0 FILE` section in a model is a sub-assembly: project, name, and
  the number of steps it has.
- The project's main model is a sub-assembly too.

**Placements**

- Sub-assembly, step number, order within the step.
- Either a part (part number, color, raw LDraw file name) or a reference
  to another sub-assembly.
- Position and rotation as the LDraw 3x4 transform, in LDU, relative to
  the sub-assembly's own origin.

**Indexes for search.** Theme, year, name text, and "projects that use
part X in color Y" must be fast.

### Lookup tools

Add these to the existing MCP server. Defaults follow the parts tools:
ranked results, a result limit with a parameter to raise it, and compact
results with full detail from the get tools.

1. **Search projects.** Filter by name text, theme, year range, kind
   (official or fan), part count range, uses a given part (optionally in a
   given color), and has positions. Rank projects with positions first,
   then by how closely they match. Each result shows its sub-assembly
   names so Claude can see what pieces are available.
2. **Get project.** Everything about one project: details, credit and
   license, parts list resolved to part names and colors, and its
   sub-assemblies with step and part counts.
3. **Get sub-assembly.** One sub-assembly's placements, grouped by step,
   with part, color, and transform. A `flatten` option expands nested
   sub-assemblies into parts with transforms relative to the requested
   sub-assembly, and resolves inherited colors. Large results are paged
   by step range.

The status tool adds project counts per source, the placement match rate,
the release tag and variant, and whether the database came from a release
or a local seed.

Every project result includes its author or designer, license, and
source URL.

### Testing

As in the parts design, tests use fixtures and no network:

- A small Rebrickable fixture with two sets, themes, inventory versions,
  and a minifigure.
- Two small `.mpd` fixtures: one with nested sub-files, steps, color 16,
  and an unmatched part; one B-model.
- A fake OMR set list and set page, served locally, to test link
  extraction, concurrency limits, caching, and retries.
- A fan-sources fixture with one GitHub-style archive and one URL source,
  including files with an allowed license, a forbidding license, and no
  license.
- Release download: a fake release served locally, covering a matching
  release, a newer release, no matching schema version (falls back to
  local seed), a checksum mismatch (rejected, old database kept), and an
  interrupted download.
- Options: changing the option switches the variant; the options file and
  the development variable are read correctly.
- Each new MCP tool against a fixture-seeded database.

The CI workflow is checked by a manual run before the first scheduled
one. A manual check also runs a local full seed against live sources and
times it.

## Decisions

The user decided:

- Projects live in the same database and reference existing parts.
- Support both inventory lookup and technique lookup.
- Fan-made projects are an install option, off by default.
- Fan-made projects are downloaded automatically, from a curated list in
  the repo, not by scraping.
- The default install should finish in under 5 minutes.
- A user can opt into every source.
- Users choose options in a prompt during plugin setup.
- Publish a prebuilt database instead of building on every machine.
- Rebrickable's terms allow it, with credit (checked by the user).

Claude decided (the user can override):

- GitHub releases as the host, built by GitHub Actions, weekly plus on
  seed changes.
- Two published variants, `standard` and `full`, rather than a separate
  fan-made add-on file.
- Positions are always included. The `set_positions` option is dropped.
- Local seeding stays for development, fallback, and `/reseed --local`.
- The published database is released under CC BY-SA 4.0 because of the
  LDCad data, with a credits file.
- CI refuses to publish below the acceptance thresholds or with any file
  outside the license allow list.
- One license allow list for all model files; disallowed files are
  skipped and counted, not fatal.
- The fallback seed builds parts and official sets only, never OMR.
- Downloaded databases skip the curated-hash check.
- Rebrickable CSVs for official parts lists, OMR for official positions.
- LDraw file and color references map to Rebrickable IDs. Acceptance
  threshold: 95% of part references.
- Fan project boundaries and the license allow list.
- Datsville as the first fan source.
- LDraw formats only. No Studio `.io`.
- Three new MCP tools: search projects, get project, get sub-assembly.

## Left to the builder

- Exact table layout and indexes.
- The color-mapping method, within the rule above.
- OMR concurrency and retry settings, within "small and polite".
- How the bootstrap finds the newest matching release (API or URL
  pattern), and how releases are kept out of the repo's "latest" slot.
- Release retention count.
- Compression format, if something beats gzip without native add-ons.
- Datsville's actual file paths.
- How placements are paged in the get sub-assembly tool.

## Open risks

- **LDraw goodwill.** CI fetches OMR files from a volunteer-run site,
  once a week, with caching. Before public release, a person should tell
  the LDraw team about the project and ask whether they would prefer a
  different arrangement.
- **Fan-made coverage.** The curated list starts with one source, and
  the license rules may leave out much of Datsville.
- **Schema changes and releases.** A plugin update that bumps the schema
  version reaches users at about the same time CI publishes the matching
  release. The local-seed fallback covers the gap, at the cost of a slow
  first session for users who update in that window.
- **Options with `--plugin-dir`.** May not appear. The development
  environment variable covers this.
