# Projects Database and Published Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add official sets and fan-made models (parts lists, positions, steps, sub-assemblies) to the brick-art database, build that database in GitHub Actions, publish it as a GitHub release, and have the plugin download it instead of seeding locally.

**Architecture:** The existing seed gains project stages: Rebrickable sets, LDraw OMR models, and curated fan sources. Each model is parsed from LDraw MPD/LDR text and its part and color references are mapped to Rebrickable IDs. CI runs the seed for the `full` variant, derives a `standard` variant, gates both on acceptance checks, and publishes them gzipped with `release.json` and `CREDITS.md`. On users' machines, the `SessionStart` bootstrap now starts a detached updater. The updater downloads the matching release, verifies its checksum, and swaps the pointer. If no release is available and there is no usable database, it falls back to a local parts-and-sets seed. Three new MCP tools read projects.

**Tech Stack:** TypeScript run by Node.js type stripping, `node:sqlite`, `node:test`, `node:http` (test servers), `node:zlib`, `@modelcontextprotocol/sdk`, `zod`, `yaml`, `fflate`, GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-10-projects-database-design.md`. It extends `docs/superpowers/specs/2026-11-09-parts-database-design.md`; the earlier plan is `docs/superpowers/plans/2026-11-09-parts-database.md`.

## Global Constraints

Everything in the earlier plan's Global Constraints still applies: Node.js 22.18.0 or later, erasable TypeScript only with `.ts` imports, pure-JavaScript dependencies, nothing written to `${CLAUDE_PLUGIN_ROOT}`, a session is never blocked, LDraw units (stud 20 LDU, plate 8 LDU, y axis down), macOS, Linux, and Windows, and tests never touch the network. In addition:

- `SEED_VERSION` goes from `2` to `3` (Task 3).
- Release tags: `data-<SEED_VERSION>-<YYYYMMDD>` (UTC build date), for example `data-3-20261117`. Every release is created with `--prerelease --latest=false`.
- Release assets: `standard.db.gz`, `full.db.gz`, `release.json`, `CREDITS.md`.
- Release repository: `SuperFamousGuy/brick-art`. Tests override the API base with `BRICK_ART_RELEASE_API`.
- Variants: `fallback` (parts plus official set parts lists; local only, never published), `standard` (plus OMR positions), `full` (plus fan projects).
- Plugin option: `fan_projects` (boolean, default `false`). The hook reads it as `CLAUDE_PLUGIN_OPTION_FAN_PROJECTS`, and `BRICK_ART_FAN_PROJECTS` overrides it. Truthy values: `true` and `1`, case-insensitive.
- OMR fetch: concurrency 4, user agent `brick-art-seed`, 3 retries with backoff of 1 s, 2 s, and 4 s. Base URL `https://library.ldraw.org`.
- License allow list, as case-insensitive regexes on a `!LICENSE` line: `CC BY` (covers `CC BY 2.0`, `CC BY 4.0`, `CC BY-SA`), `CC0`, `CCAL version 2\.0` only when preceded by `Redistributable`, `public domain`. A line containing `Not redistributable` is never allowed.
- Placement acceptance threshold: 95% of OMR part references resolve to a known part and color (primitives and flexible segments excluded; "Moved to" and "=" aliases followed). CI refuses to publish below it. Part-geometry threshold: 95% of the top 1,000 parts, unchanged.
- The published database is licensed CC BY-SA 4.0. `CREDITS.md` credits Rebrickable ("Data sourced from Rebrickable"), the LDraw Parts Library, the LDCad shadow library, each OMR author, and each fan source.
- The update check runs at most once per 24 hours unless the variant or schema changed.
- Unmatched part or color references are stored with their raw LDraw values, never dropped.

## Review Focus

1. **No network or GitHub API rate limiting (HTTP 403 or 429) at session start while a usable database exists.** The updater keeps the current database, records the failure, and does not start a fallback seed. Tested in Task 10.
2. **A truncated or corrupted release download** (checksum mismatch, gzip error mid-stream). The old database and pointer stay. No partial file is left behind. Tested in Task 10.
3. **Real-world MPD naming.** Sub-file names with spaces and mixed case (`10001 - Main.ldr`), backslash paths, a reference to a sub-file declared later in the file, and a sub-file referenced but never declared. All resolve or are flagged, never dropped. Tested in Task 4.
4. **The user toggles `fan_projects` while an update is running.** No second updater starts, and the next session picks up the new variant. Tested in Task 11.
5. **A `get_submodel` call on a huge sub-assembly** (thousands of placements with `flatten`). The response is paged and returns `nextStep`, never the full set. Tested in Task 13.

---

## File Structure

```
.claude-plugin/plugin.json          + userConfig.fan_projects
.github/workflows/data-release.yml  weekly + on schema/curated change + manual; builds and publishes
commands/reseed.md                  download newest release; --local builds locally
curated/fan-sources.yaml            curated fan-made source list (new)
src/sources/rebrickable.ts          + sets detail, themes, versions, quantity, minifigs
src/sources/fetch.ts                + themes/inventory_minifigs/minifigs tables, keep LDConfig.ldr
src/sources/omr.ts                  OMR crawl, cache, polite fetch (new)
src/sources/fan.ts                  fan source download and file selection (new)
src/curated/load.ts                 + fan-sources.yaml in hash and loader
src/projects/sets.ts                Rebrickable sets → projects + parts lists (new)
src/projects/mpd.ts                 LDraw MPD/LDR model parser (new)
src/projects/license.ts             license allow list (new)
src/projects/colors.ts              LDraw color code → Rebrickable color id (new)
src/projects/assemble.ts            model files → project, submodels, placements (new)
src/db/schema.ts                    + project tables, SEED_VERSION 3
src/db/write.ts                     + project writers
src/seed/seed.ts                    + variant, project stages, failure isolation
src/seed/options.ts                 options file and env reading (new)
src/seed/bootstrap.ts               decides update vs ok, spawns updater
src/release/build.ts                CI: seed full, gates, derive standard, assets (new)
src/release/download.ts             find, download, verify, swap (new)
src/release/prune.ts                choose old releases to delete (new)
src/entry/update.mjs                detached updater entry (new)
src/entry/release.mjs               CI build entry (new)
src/lookup/search-projects.ts       (new)
src/lookup/get-project.ts           (new)
src/lookup/get-submodel.ts          (new, includes flatten)
src/lookup/status.ts                + projects, variant, origin, release tag
src/mcp/server.ts                   + three tools
tests/helpers/fixtures.ts           + sets/themes/minifigs, LDConfig.ldr
tests/helpers/models.ts             MPD fixtures, fake OMR site, fake release server (new)
```

## Shared types (`src/projects/types.ts`, created in Task 4)

```ts
import type { Mat3, Vec3 } from '../types.ts';
export interface ModelLine { step: number; seq: number; color: number; pos: Vec3; matrix: Mat3; ref: string }
export interface ModelFile { name: string; author: string | null; license: string | null; lines: ModelLine[]; stepCount: number }
export interface ParsedModel { main: string; files: Map<string, ModelFile> } // keys normalized: lowercase, '/' separators, trimmed
export type Variant = 'fallback' | 'standard' | 'full';
```

## Database additions (Task 3)

| Table | Columns |
|-------|---------|
| `projects` | `id INTEGER PRIMARY KEY, source TEXT, source_key TEXT, kind TEXT` (`official`/`fan`)`, name, year INTEGER, theme, parent_theme, part_count INTEGER, author, license, url, has_positions INTEGER, base_project_id INTEGER` (B-model → its set)`, UNIQUE(source, source_key)` |
| `project_parts` | `project_id INTEGER, part_num TEXT, color_id INTEGER, quantity INTEGER, is_spare INTEGER, from_minifig INTEGER` |
| `submodels` | `id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, is_main INTEGER, step_count INTEGER, part_count INTEGER` |
| `placements` | `submodel_id INTEGER, step INTEGER, seq INTEGER, part_num TEXT` (null when unmatched or a child)`, ldraw_file TEXT, ldraw_color INTEGER, color_id INTEGER` (null when 16 or unmatched)`, child_submodel_id INTEGER, x REAL, y REAL, z REAL, matrix TEXT` (JSON `Mat3`) |

Indexes: `projects(theme)`, `projects(year)`, `projects(kind, has_positions)`, `project_parts(part_num, color_id)`, `project_parts(project_id)`, `submodels(project_id)`, `placements(submodel_id, step, seq)`.

New manifest keys: `variant`, `built_by` (`ci`/`local`), `placement_match_rate`, `color_match_rate`, `count_projects_official`, `count_projects_with_positions`, `count_projects_fan`, `count_models_skipped_license`, `count_omr_files_failed`, `failed_sources` (comma-separated, empty when none), `release_tag` (written by the downloader into its state file, not the database; see Task 10).

---

### Task 1: Rebrickable set data loaders

**Files:**
- Modify: `src/sources/rebrickable.ts`, `src/sources/fetch.ts:48-51` (`REBRICKABLE_TABLES`), `tests/helpers/fixtures.ts`
- Test: `tests/sources/rebrickable.test.ts`

**Interfaces:**
- Produces, as additions to `RebrickableData`:
  - `sets: Map<string, { name: string; year: number; themeId: number; numParts: number }>` (keep `setYears` for existing consumers).
  - `themes: Map<number, { name: string; parentId: number | null }>`
  - `inventoryVersions: Map<number, number>` (inventory id → version).
  - `RbInventoryPart` gains `quantity: number`.
  - `inventoryMinifigs: { inventoryId: number; figNum: string; quantity: number }[]`
- `REBRICKABLE_TABLES` gains `themes`, `inventory_minifigs`, and `minifigs` (`minifigs` is fetched for its name only and loaded into `minifigNames: Map<string, string>`).
- Fixture additions: `themes` rows `[1, 'Harbor', 2]` and `[2, 'Town', '']`. `inventory_minifigs` row `[1, 'fig-000001', 2]`. `minifigs` row `['fig-000001', 'Fixture Fig', 1, '']`. `SOURCE_NAMES` in `fixtureFetched` gains the three names.

- [ ] **Step 1: Write failing tests** in `tests/sources/rebrickable.test.ts`:
  - `loadRebrickable(fixture).sets.get('S1-1')` deep-equals `{ name: 'Set One', year: 2020, themeId: 1, numParts: 10 }`.
  - `themes.get(1)` deep-equals `{ name: 'Harbor', parentId: 2 }`, and `themes.get(2).parentId === null`.
  - `inventoryVersions.get(5) === 2`.
  - Every `inventoryParts` row has `quantity === 1` (the fixture writes 1).
  - `inventoryMinifigs` deep-equals `[{ inventoryId: 1, figNum: 'fig-000001', quantity: 2 }]`.
  - A `themes.csv.gz` without `parent_id` throws `themes.csv missing column parent_id`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the loaders with the existing `loadTable` and `assertColumns`. An empty `parent_id` maps to `null`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including every existing seed and availability test.
- [ ] **Step 5: Commit** `feat: load Rebrickable set, theme, version, and minifig data`.

### Task 2: Official set projects

**Files:**
- Create: `src/projects/sets.ts`
- Test: `tests/projects/sets.test.ts`

**Interfaces:**
- Consumes: `RebrickableData` from Task 1.
- Produces:
  - `interface ProjectRow { id: number; source: string; sourceKey: string; kind: 'official' | 'fan'; name: string; year: number | null; theme: string | null; parentTheme: string | null; partCount: number; author: string | null; license: string | null; url: string | null; hasPositions: boolean; baseProjectId: number | null }`
  - `interface ProjectPartRow { projectId: number; partNum: string; colorId: number; quantity: number; isSpare: boolean; fromMinifig: boolean }`
  - `buildSetProjects(rb: RebrickableData, firstId: number): { projects: ProjectRow[]; parts: ProjectPartRow[] }`

**Rules:**
- One project per entry in `rb.sets` whose `set_num` does not start with `fig-`. Fields: `source 'rebrickable'`, `sourceKey` = set number, `kind 'official'`, `url` = `https://rebrickable.com/sets/<set_num>/`, `license null`, `author null`, `hasPositions false`.
- Parts come from the set's highest-version inventory only. Minifigures listed in that inventory's `inventory_minifigs` add their own inventory's parts (the minifig's highest version), multiplied by the minifig quantity, with `fromMinifig true`.
- Rows with the same `(partNum, colorId, isSpare, fromMinifig)` are summed.
- `partCount` = sum of non-spare quantities.

- [ ] **Step 1: Write failing tests**:
  - Four projects, with ids starting at `firstId`. `S1-1` has `theme 'Harbor'` and `parentTheme 'Town'`.
  - `S3-1` uses inventory 5 only: exactly one part row, `{ partNum: '3001', colorId: 4, quantity: 1, isSpare: false, fromMinifig: false }`.
  - `S1-1` includes `{ partNum: '33085', colorId: 4, quantity: 2, fromMinifig: true }`.
  - `S4-1`'s spare `3001` row has `isSpare: true` and is excluded from `partCount`.
  - No project has `sourceKey` starting with `fig-`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildSetProjects`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: build official set projects from Rebrickable inventories`.

### Task 3: Project schema and writers

**Files:**
- Modify: `src/db/schema.ts` (DDL, `SEED_VERSION = 3`), `src/db/write.ts`
- Test: `tests/db/db.test.ts`

**Interfaces:**
- Consumes: `ProjectRow` and `ProjectPartRow` (Task 2).
- Produces:
  - `interface SubmodelRow { id: number; projectId: number; name: string; isMain: boolean; stepCount: number; partCount: number }`
  - `interface PlacementRow { submodelId: number; step: number; seq: number; partNum: string | null; ldrawFile: string | null; ldrawColor: number; colorId: number | null; childSubmodelId: number | null; pos: Vec3; matrix: Mat3 }`
  - `writeProjects`, `writeProjectParts`, `writeSubmodels`, and `writePlacements`, each `(db: DatabaseSync, rows: readonly T[]) => void`, using the existing `batch`.
  - Tables and indexes exactly as in "Database additions" above.

- [ ] **Step 1: Write failing tests**: write one row of each type into a fresh schema and read it back. Check that `matrix` round-trips as the same 9 numbers, that `UNIQUE(source, source_key)` rejects a duplicate, and that `SEED_VERSION === 3`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the DDL and writers.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: project tables and writers; seed version 3`.

### Task 4: LDraw model parser and license rule

**Files:**
- Create: `src/projects/types.ts` (shared types above), `src/projects/mpd.ts`, `src/projects/license.ts`, `tests/helpers/models.ts`
- Test: `tests/projects/mpd.test.ts`, `tests/projects/license.test.ts`

**Interfaces:**
- Produces:
  - `normalizeRef(ref: string): string`. Trims, lowercases, and turns `\` into `/`.
  - `parseModel(text: string, fileName: string): ParsedModel`. `main` is the first `0 FILE` name, or `normalizeRef(fileName)` for a plain `.ldr` without `0 FILE`. `0 NOFILE` ends a sub-file. `0 STEP` and `0 ROTSTEP` end a step; `step` is 1-based and `stepCount` counts non-empty steps. `0 Author:` and `0 !LICENSE` are read per sub-file. Type-1 lines become `ModelLine`, keeping their color code. Other line types are ignored.
  - `licenseAllowed(line: string | null, sourceDefault?: string | null): boolean`. Applies the Global Constraints allow list. A `null` line uses `sourceDefault`, and `null` with no default is `false`.
  - `tests/helpers/models.ts` exports `MPD_10001_MINI`, `MPD_CLEAN`, and `MPD_BMODEL` as strings:
    - `MPD_10001_MINI`: main file `10001 - Main.ldr` with two steps. Step 1 places part `3001.dat` in color 4 at the origin with the identity matrix. Step 2 references `10001 - Cab.ldr` (declared later, written as `10001 - CAB.LDR`) in color 4, with translation `(0, -24, 0)` and the 90° y rotation matrix `0 0 1 0 1 0 -1 0 0`. `10001 - Cab.ldr` holds `3023.dat` in color 16 at `(10, 0, 0)` with the identity matrix, `9999x.dat` (unmatched) in color 0, and a reference to `missing.ldr`, which is never declared and is not a part. Licensed CC BY 4.0.
    - `MPD_CLEAN`: `MPD_10001_MINI` without the `9999x.dat` and `missing.ldr` lines, so every placement resolves.
    - `MPD_BMODEL`: a one-file model `10001-1_B-Model.mpd` with `3001.dat` in color 72 and no `!LICENSE` line.

- [ ] **Step 1: Write failing tests**:
  - `parseModel(MPD_10001_MINI, '10001-1.mpd')` gives `main === '10001 - main.ldr'`, `files.size === 2`, and main `stepCount === 2`.
  - The cab line referencing 3023 has `color === 16`. Its `ref` is kept as written, and `normalizeRef(ref) === '3023.dat'`.
  - `normalizeRef('S\\3001S01.DAT') === 's/3001s01.dat'`.
  - A plain `.ldr` with no `0 FILE` gives one file named after the file name.
  - `licenseAllowed('Licensed under CC BY 4.0 : see CAreadme.txt') === true`, and `licenseAllowed('Redistributable under CCAL version 2.0 : see CAreadme.txt') === true`.
  - `licenseAllowed('Not redistributable : see NonCAreadme.txt') === false`. `licenseAllowed('All rights reserved') === false`. `licenseAllowed(null) === false`. `licenseAllowed(null, 'CC0') === true`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `mpd.ts` and `license.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: parse LDraw models and check licenses`.

### Task 5: Reference mapping and project assembly

**Files:**
- Create: `src/projects/colors.ts`, `src/projects/assemble.ts`
- Modify: `src/sources/fetch.ts` (the ldraw `keep` predicate also keeps `LDConfig.ldr`), `tests/helpers/fixtures.ts` (adds `LDConfig.ldr` to the LDraw tree)
- Test: `tests/projects/colors.test.ts`, `tests/projects/assemble.test.ts`

**Interfaces:**
- Consumes: Task 3 row types, Task 4 parser and license rule.
- Produces:
  - `buildColorMap(ldconfig: string, rbColors: RbColor[]): { map: Map<number, number>; rate: number }`. Parses `0 !COLOUR <Name> CODE <n> VALUE #<rgb>`. A code maps to the Rebrickable id equal to the code when the normalized names match or the RGBs match. Otherwise it maps to the unique Rebrickable color with the same normalized name, then the unique one with the same RGB. Name normalization: lowercase, `_` to space, `grey` to `gray`, collapse spaces. `rate` = mapped codes / codes in LDConfig.
  - `buildPartMap(parts: { partNum: string; ldrawFile: string | null; geometryFrom: string | null }[]): Map<string, string>`. Maps a normalized LDraw file to a part number, preferring `geometryFrom === partNum`, then the smallest part number.
  - `interface AssembledProject { submodels: Omit<SubmodelRow, 'projectId'>[]; placements: PlacementRow[]; parts: Omit<ProjectPartRow, 'projectId'>[]; stats: { placements: number; resolved: number }; licenses: (string | null)[]; authors: string[] }`
  - `assembleProject(root: string, files: Map<string, ModelFile>, maps: { parts: Map<string, string>; colors: Map<number, number> }, nextSubmodelId: () => number): AssembledProject`.
    - Starting from `root`, every referenced name found in `files` becomes a submodel, reached once even when referenced many times. Cycles are cut and the cycling reference is stored as an unmatched placement.
    - Other references map through `maps.parts`. Unmatched references keep `ldrawFile` and get a null `partNum`.
    - Color 16 gives `colorId null`, counted as resolved. A placement is resolved when its part (or child submodel) and its color both resolve.
    - `parts` comes from flattening from `root`: color 16 inherits the parent's color, and quantities are summed per `(partNum, colorId)`. Unmatched parts are omitted from `parts` but counted in `stats`.

- [ ] **Step 1: Write failing tests**:
  - The fixture `LDConfig.ldr` has codes 0 `Black #1B2A34`, 4 `Red #C91A09`, 2 `Green #237841`, 72 `Dark_Bluish_Grey #6C6E68`, and 47 `Trans_Clear #FCFCFC`. With the fixture Rebrickable colors, `map.get(0) === 0` (by name, since the RGB differs), `map.get(47) === 47`, `map.has(72) === false`, and `rate === 0.8`.
  - `buildPartMap` maps `'3009.dat'` to `'3009'`, not `'3009b'`.
  - `assembleProject` on `MPD_10001_MINI` gives two submodels. The main submodel has `isMain: true` and `stepCount 2`.
  - The placement for `9999x.dat` has `partNum null` and `ldrawFile '9999x.dat'`. `missing.ldr` is also an unmatched placement.
  - `parts` includes `{ partNum: '3023', colorId: 4, quantity: 1 }`, inheriting red from the main file's reference to the cab, which is in color 4.
  - `stats` is `{ placements: 5, resolved: 3 }`.
  - A two-file cycle (`a.ldr` references `b.ldr`, which references `a.ldr`) terminates with 2 submodels.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `colors.ts` and `assemble.ts`. Also extend the ldraw keep predicate to `(p) => /^(parts|p)\//.test(p) || p === 'LDConfig.ldr'`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: map LDraw references and assemble projects`.

### Task 6: OMR download

**Files:**
- Create: `src/sources/omr.ts`
- Modify: `tests/helpers/models.ts` (adds `startFakeOmr`)
- Test: `tests/sources/omr.test.ts`

**Interfaces:**
- Produces:
  - `interface OmrFile { setNum: string; fileName: string; path: string; url: string; isBModel: boolean }`
  - `fetchOmr(cacheDir: string, opts: { baseUrl?: string; concurrency?: number; retries?: number; backoffMs?: number }): Promise<{ files: OmrFile[]; fetched: number; fromCache: number; failed: number; bytes: number }>`
  - `startFakeOmr(pages: Map<string, string | number>): Promise<{ url: string; hits: Map<string, number>; close(): Promise<void> }>`. A `node:http` server that serves the given path-to-body map. A number is an HTTP status. It records hits per path and the maximum number of requests in flight at once.

**Rules:**
- Crawl `/omr/sets?page=1,2,…` until a page adds no new `/omr/sets/<id>` links. On each set page, collect links matching `/media/omr_models/<n>/<file>.(mpd|ldr)?v=<v>`.
- The set number is the file name's leading `^([0-9A-Za-z]+-\d+)`. `isBModel` is true when anything other than the extension follows it.
- The cache lives at `<cacheDir>/omr/`. `index.json` maps URL path to `{ v, file }`. A file whose `v` is unchanged is not requested again.
- Retries apply to network errors and 5xx/429 only. A file that still fails is counted in `failed` and skipped.
- Never more than `concurrency` requests in flight.

- [ ] **Step 1: Write failing tests** with `startFakeOmr`, using two list pages, three set pages, and four files, one of them a B-model:
  - The first run gives `files.length === 4`, `fetched === 4`, and `fromCache === 0`.
  - A second run with the same `v` values gives `fetched === 0`, `fromCache === 4`, and no new hits on the file paths.
  - Changing one file's `v` makes it alone refetch.
  - A file returning 503 twice and then 200 is fetched (`retries 3`, `backoffMs 1`). A file returning 404 is in `failed` with exactly one hit.
  - The maximum in flight with `concurrency 2` is `<= 2`.
  - `10001-1_B-Model-from-Instruction.mpd` gives `{ setNum: '10001-1', isBModel: true }`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `omr.ts` with `fetch` and the user agent `brick-art-seed`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: polite cached OMR download`.

### Task 7: Curated fan sources

**Files:**
- Create: `curated/fan-sources.yaml`, `src/sources/fan.ts`
- Modify: `src/curated/load.ts` (load `fan-sources.yaml` and include it in `hash`)
- Test: `tests/curated/load.test.ts`, `tests/sources/fan.test.ts`

**Interfaces:**
- Produces:
  - `interface FanSource { id: string; name: string; homepage: string; fetch: { kind: 'github'; repo: string; paths: string[] } | { kind: 'url'; url: string; paths: string[] }; designer: string; defaultLicense: string | null }`
  - `Curated` gains `fanSources: FanSource[]`. An invalid entry throws `fan-sources.yaml: <id>: <problem>`.
  - `fetchFanSource(cacheDir: string, src: FanSource, opts: { githubApi?: string; codeload?: string; idleTimeoutMs?: number }): Promise<{ root: string; commit: string | null; files: string[] }>`. A `github` source fetches the commit SHA, then the zip archive, extracts it with the top folder stripped, and returns the file paths matching `paths` (globs with `*` and `**`), relative to `root`, sorted. A `url` source downloads the file and extracts it if it is a `.zip`. Cache reuse follows the LDCad pattern in `fetch.ts`.
  - `buildFanProjects(src: FanSource, root: string, files: string[], maps, nextSubmodelId): { projects: (AssembledProject & { root: string })[]; skipped: number }`.
    - All files are parsed into one name-to-`ModelFile` map. Duplicate names: the first path in sorted order wins.
    - Top-level models are model files that no other file references.
    - A project is skipped when any of its files fails `licenseAllowed(file.license, src.defaultLicense)`.

**`curated/fan-sources.yaml`:** one Datsville entry, as in the spec, with `defaultLicense` absent. Before writing `paths`, inspect the repository (`gh api repos/mjhorvath/Datsville/contents` and the folders below it) and set `paths` to the folders holding model files. Record what you found in a YAML comment.

- [ ] **Step 1: Write failing tests**:
  - The curated hash changes when `fan-sources.yaml` changes.
  - An entry missing `fetch.kind` throws an error naming the entry.
  - Fetching a fixture GitHub source from a fake codeload server (reuse `startFakeOmr` as a generic server) gives files filtered by `models/**/*.ldr`.
  - Fixture source with three files: `town.ldr` (CC BY 4.0, references `house.ldr`), `house.ldr` (CC BY 4.0), and `shed.ldr` (no license line). This gives 1 project (`town.ldr`, with `house.ldr` as a submodel) and `skipped === 1`.
  - The same fixture with `defaultLicense: CC0` gives 2 projects.
  - A `Not redistributable` file inside an otherwise CC BY project causes the whole project to be skipped.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the loader, `fan.ts`, and the YAML file.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: curated fan sources with license filtering`.

### Task 8: Seed variants and project stages

**Files:**
- Modify: `src/seed/seed.ts`, `src/entry/seed.mjs`
- Test: `tests/seed/seed.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 7.
- Produces:
  - `SeedOptions` gains `variant: Variant` (default `'fallback'`), `builtBy?: 'ci' | 'local'` (default `'local'`), `omr?: { baseUrl?: string; files?: OmrFile[] }` and `fanFetch?: { githubApi?: string; codeload?: string }` (test hooks).
  - `src/entry/seed.mjs` accepts `--variant <fallback|standard|full>` and `--built-by <ci|local>`.

**Pipeline additions**, after the parts are written and before the manifest:
1. Write the set projects (Task 2). This runs for every variant.
2. If the variant is `standard` or `full`: build the color and part maps, fetch OMR, and parse each file.
   - A set's main file attaches to the Rebrickable project with the same `setNum`: write its submodels and placements, and set `has_positions 1`, `author`, `license`, and `url` (the OMR file URL).
   - A B-model becomes its own project: `source 'omr'`, `sourceKey` = file name, `kind 'official'`, `baseProjectId` = its set's project, and parts from assembly.
   - An OMR file whose set number has no Rebrickable set becomes an `omr` project with no `baseProjectId`.
   - An OMR file failing `licenseAllowed` is skipped and counted in `count_models_skipped_license`.
3. If the variant is `full`: for each fan source, `fetchFanSource` then `buildFanProjects`, with `kind 'fan'`, `source` = the source id, `sourceKey` = the root path, `author` = file author or `designer`, and `url` = `homepage`.
4. Failure isolation: an error in step 2 or in one fan source is logged, its name is appended to `failed_sources`, and the seed continues. Errors in the parts stages or step 1 still fail the seed, as today.
5. Parts whose `license` fails `licenseAllowed` are written with geometry and connections removed and `is_complete 0`. This rule applies in every variant, so local and published databases agree.
6. Manifest: the new keys from "Database additions". `placement_match_rate` = resolved / placements over included OMR models, or `''` for `fallback`.

- [ ] **Step 1: Write failing tests** (fixture OMR served by `startFakeOmr` with `MPD_10001_MINI` as set `S1-1` and `MPD_BMODEL` as `S1-1_B-Model.mpd`, plus a fixture fan source):
  - `variant 'fallback'`: 4 official projects and 0 submodels. The manifest has `variant 'fallback'` and `placement_match_rate ''`.
  - `variant 'standard'`: `S1-1` has `has_positions 1` and 2 submodels.
    - The B-model is skipped for having no license, so `count_models_skipped_license 1`.
    - `count_projects_fan 0`.
  - `variant 'full'`: `count_projects_fan 1`.
  - An OMR server that returns 500 for every page: the seed completes, `failed_sources` contains `omr`, and the parts are intact.
  - A part fixture whose `!LICENSE` is `Not redistributable` gets `has_geometry 0` and `is_complete 0`.
  - `built_by` defaults to `local`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the stages in `seed.ts`. Keep the parts pipeline unchanged above them.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: seed variants with project stages`.

### Task 9: Release build, gates, and CI workflow

**Files:**
- Create: `src/release/build.ts`, `src/release/prune.ts`, `src/entry/release.mjs`, `.github/workflows/data-release.yml`
- Test: `tests/release/build.test.ts`, `tests/release/prune.test.ts`

**Interfaces:**
- Consumes: `runSeed` (Task 8).
- Produces:
  - `checkGates(db: DatabaseSync): string[]`. Returns one message per failed gate; empty means pass. The gates:
    - `match_rate_top1000 < 0.95`
    - `placement_match_rate < 0.95`
    - any `projects` row whose `license` fails `licenseAllowed`, among rows with non-null license
    - any `parts` row with `has_geometry 1` whose `license` fails `licenseAllowed`
    - `failed_sources` contains `omr`
  - `deriveStandard(fullFile: string, outFile: string): void`. Copies the database, deletes `kind = 'fan'` projects and their rows, sets manifest `variant` to `standard`, and runs `VACUUM`.
  - `buildRelease(opts: { dataDir: string; repoRoot: string; outDir: string; now?: () => Date; seed?: Partial<SeedOptions> }): Promise<{ tag: string; assets: string[]; gateFailures: string[] }>`
    - Runs `runSeed({ variant: 'full', builtBy: 'ci', refresh: false })` and checks the gates. When a gate fails, it returns the failures and writes nothing to `outDir`.
    - Otherwise it derives `standard` and gzips both databases.
    - It writes `release.json`: `{ tag, schemaVersion, builtAt, variants: { standard: {...}, full: {...} } }`, where each variant has `{ file, gzSha256, gzBytes, dbSha256, dbBytes, counts }`.
    - It writes `CREDITS.md`, which states CC BY-SA 4.0 and credits every source and every distinct OMR author and fan source.
  - `src/entry/release.mjs`: runs `buildRelease` with `--out <dir>`, prints the tag on the last line, and exits 1 when a gate fails.
  - `selectReleasesToDelete(tags: string[], keep: number): string[]`. Only considers tags matching `^data-(\d+)-(\d{8})$`. Per schema version, keeps the newest `keep` releases. The newest release of every schema version is never selected.
  - `src/release/prune.ts` also exports a CLI `main()` that runs `gh release list --limit 200 --json tagName` and `gh release delete <tag> --yes --cleanup-tag` for each selected tag, with `keep` = 3.

**Workflow (`data-release.yml`):**
- `on`: `schedule: cron '0 6 * * 1'`, `push` to `main` with `paths: ['src/db/schema.ts', 'curated/**']`, and `workflow_dispatch`.
- `permissions: contents: write`. One job on `ubuntu-latest` with `timeout-minutes: 120`.
- Steps:
  1. Checkout.
  2. `actions/setup-node` with Node `22`.
  3. `npm ci`.
  4. `actions/cache` on `.data/cache`, with key `sources-${{ github.run_id }}` and restore-keys `sources-`.
  5. `node --max-old-space-size=3072 src/entry/release.mjs --out .data/out`, capturing the tag.
  6. If a release with that tag exists, delete it with `gh release delete "$TAG" --yes --cleanup-tag`.
  7. `gh release create "$TAG" out/* --prerelease --latest=false --title "Data $TAG" --notes-file out/CREDITS.md`.
  8. `node src/release/prune.ts`.

- [ ] **Step 1: Write failing tests**:
  - `buildRelease` on fixtures writes four files. Use a fake OMR serving only `MPD_CLEAN` as `S1-1.mpd`, so the placement rate is 1.0.
    - `release.json.variants.standard.gzSha256` equals the SHA-256 of `standard.db.gz`.
    - The `standard` database has `count(*) FROM projects WHERE kind='fan'` = 0, and `full` has 1.
  - With `MPD_10001_MINI` served instead (rate 0.6), `gateFailures` contains `placement_match_rate` and `outDir` is empty.
  - The tag for `now = 2026-11-17T08:00Z` is `data-3-20261117`.
  - `selectReleasesToDelete(['data-3-20261103','data-3-20261110','data-3-20261117','data-3-20261124','data-2-20261001','v0.1.0'], 3)` deep-equals `['data-3-20261103']`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and the workflow.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Then run `npx --yes @action-validator/cli .github/workflows/data-release.yml` if it is available, otherwise check the YAML parses with `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/data-release.yml','utf8'))"`.
- [ ] **Step 5: Commit** `feat: release build with gates and weekly CI publish`.

### Task 10: Release download and updater

**Files:**
- Create: `src/release/download.ts`, `src/entry/update.mjs`
- Modify: `tests/helpers/models.ts` (adds `startFakeReleases`)
- Test: `tests/release/download.test.ts`

**Interfaces:**
- Consumes: the `release.json` format (Task 9), `writePointer`, `acquireLock`/`releaseLock`/`writeState`, `runSeed`.
- Produces:
  - `interface ReleaseInfo { tag: string; assets: Map<string, string> }` (asset name → download URL).
  - `findRelease(schemaVersion: number, apiBase?: string): Promise<ReleaseInfo | null>`. Calls `GET <apiBase>/repos/SuperFamousGuy/brick-art/releases?per_page=50` with the user agent `brick-art-seed`, keeps tags `data-<schemaVersion>-YYYYMMDD`, and returns the newest. A 403 or 429 throws `RateLimited`. `apiBase` defaults to `process.env.BRICK_ART_RELEASE_API ?? 'https://api.github.com'`.
  - `interface UpdateState { lastCheckedAt: string | null; releaseTag: string | null; variant: Variant | null; origin: 'release' | 'local' | null; lastError: string | null }`, stored at `<dataDir>/update.json` through `readUpdateState`/`writeUpdateState`.
  - `runUpdate(opts: { dataDir: string; repoRoot: string; variant: 'standard' | 'full'; force?: boolean; apiBase?: string; seed?: Partial<SeedOptions> }): Promise<{ outcome: 'updated' | 'current' | 'fallback_seeded' | 'kept' | 'busy'; tag: string | null }>`

**Rules for `runUpdate`:**
1. Acquire the seed lock, or return `busy`.
2. `findRelease`. When it returns a release whose tag differs from `releaseTag`, or whose variant differs, or when `force` is set:
   - Download `release.json` and `<variant>.db.gz` into `<dataDir>/download.part`.
   - Verify `gzSha256`, then gunzip by streaming into `parts-<stamp>.db.part`.
   - Verify `dbSha256`, rename to `parts-<stamp>.db`, and open it to check that `manifest.seed_version === SEED_VERSION`.
   - Write the pointer and remove the other `parts-*.db` files, ignoring failures.
   - Record `{ releaseTag, variant, origin: 'release' }` and return `updated`.
3. Same tag and variant: return `current`.
4. No release, or any error in step 2:
   - Delete the `.part` files.
   - If the current database is usable (manifest `seed_version` matches), record `lastError` and return `kept`.
   - Otherwise run `runSeed({ variant: 'fallback' })`, record `origin: 'local'`, and return `fallback_seeded`.
5. Always set `lastCheckedAt` and release the lock.

`src/entry/update.mjs` reads the options (Task 11) and `--force`, calls `runUpdate`, and logs to `seed.log`.

- [ ] **Step 1: Write failing tests** with `startFakeReleases`, which serves the releases JSON and assets built by `buildRelease` on fixtures:
  - First run: `updated`. The pointer names a new database whose manifest `variant` is `standard`, and `update.json` has `origin 'release'`.
  - Second run: `current`, with no asset hits.
  - Switching to `variant 'full'`: `updated`, and the new manifest `variant` is `full`.
  - A corrupted `standard.db.gz` (one byte flipped) on a dataDir that already holds a fixture database: `kept`. The pointer is unchanged and no `.part` files remain.
  - The API returning 403 with a usable database: `kept`, and `runSeed` is not called (inject a `seed` hook that throws if called).
  - Empty releases on an empty dataDir: `fallback_seeded`, and the manifest `variant` is `fallback`.
  - A release tag for schema `2` is ignored.
  - A held lock: `busy`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `download.ts` and `update.mjs`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: download published database with local fallback`.

### Task 11: Options, bootstrap, plugin manifest, and /reseed

**Files:**
- Create: `src/seed/options.ts`
- Modify: `src/seed/bootstrap.ts`, `src/entry/bootstrap.mjs`, `.claude-plugin/plugin.json`, `commands/reseed.md`
- Test: `tests/seed/options.test.ts`, `tests/seed/bootstrap.test.ts`, `tests/plugin.test.ts`

**Interfaces:**
- Consumes: `readUpdateState` and `runUpdate` (Task 10).
- Produces:
  - `readOptions(env: NodeJS.ProcessEnv, dataDir: string): { fanProjects: boolean; source: 'env' | 'plugin' | 'file' | 'default' }`. Precedence: `BRICK_ART_FAN_PROJECTS`, then `CLAUDE_PLUGIN_OPTION_FAN_PROJECTS`, then `<dataDir>/options.json`, then `false`.
  - `writeOptions(dataDir: string, o: { fanProjects: boolean }): void`. The bootstrap writes this whenever the source is `env` or `plugin`.
  - `variantFor(o): 'standard' | 'full'`.
  - `needsUpdate(dataDir, repoRoot, variant, now = new Date()): Promise<{ needed: boolean; reason: 'running' | 'missing' | 'schema' | 'variant' | 'fallback' | 'curated' | 'check_due' | 'ok' }>`. Replaces `needsSeed`.
    - A live lock gives `running`. No database gives `missing`. A schema mismatch gives `schema`.
    - The manifest variant differs from the chosen variant: `variant`.
    - The manifest variant is `fallback`: `fallback`, but only when the check is due.
    - A local-origin database with a curated hash mismatch: `curated`.
    - `lastCheckedAt` older than 24 h: `check_due`.
    - Otherwise `ok`.
    - Downloaded databases (origin `release`) never return `curated`.
  - `bootstrap(dataDir, repoRoot, env, spawnUpdate: () => void): Promise<string>`. Hook output lines:
    - First install (`missing`) when the options source is `default`: `brick-art: installing the standard database in the background. Fan-made designs are off; turn them on in /plugin → brick-art → Configure options.`
    - Other `missing`: `brick-art: installing the <variant> database in the background.`
    - `variant`: `brick-art: switching to the <variant> database in the background.`
    - `ok` and other quiet reasons: `brick-art: database ready (<variant>, <count_parts> parts, <count_projects_official> sets, <release tag or "local build">).`
    - `fallback`: append ` Build positions arrive with the next published release.`
  - `spawnDetachedUpdate(dataDir, repoRoot)`. Same as `spawnDetachedSeed`, but runs `src/entry/update.mjs` with `--max-old-space-size=3072`.
- `plugin.json` gains:
  ```json
  "userConfig": {
    "fan_projects": {
      "type": "boolean",
      "title": "Download fan-made designs",
      "description": "Adds community designs from brick-art's curated list, with positions and build steps. Adds about 8 MB to the download.",
      "default": false
    }
  }
  ```
  Task 14 measured the fan-made download at 8 MB, and `N` is now `8`.
- `commands/reseed.md`: with no arguments, it runs `update.mjs --force` in the background and then reports `database_status`. With `--local`, it runs `seed.mjs --refresh --variant <standard|full from options.json>`. Keep the `BRICK_ART_DATA="${CLAUDE_PLUGIN_DATA}"` prefix and `run_in_background`.

- [ ] **Step 1: Write failing tests**:
  - `readOptions` precedence across all four sources. `'TRUE'` and `'1'` are true. `'no'` is false.
  - `needsUpdate` returns each reason from fixtures:
    - A released-origin database with a different curated hash gives `ok`, not `curated`.
    - A held lock with a different variant gives `running`, and `spawnUpdate` is not called.
    - `lastCheckedAt` 25 h ago gives `check_due`.
  - `bootstrap` with no options on an empty dataDir prints the first-install line exactly.
  - `bootstrap` on a ready database completes in under 1000 ms.
  - `tests/plugin.test.ts`: `plugin.json.userConfig.fan_projects.default === false`, and `type === 'boolean'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the options, bootstrap, manifest, and command changes. `src/entry/bootstrap.mjs` passes `process.env` and `spawnDetachedUpdate`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Then run `claude plugin validate .`. Expected: no errors.
- [ ] **Step 5: Commit** `feat: fan-projects option and release-first bootstrap`.

### Task 12: Search projects and get project tools

**Files:**
- Create: `src/lookup/search-projects.ts`, `src/lookup/get-project.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/lookup/projects.test.ts`, `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: the project tables, `clampLimit`, `escapeLike`.
- Produces:
  - `searchProjects(db, f: { nameContains?: string; theme?: string; year?: Range; kind?: 'official' | 'fan'; partCount?: Range; usesPart?: string; usesColor?: number; hasPositions?: boolean; limit?: number }): { results: ProjectSummary[]; note: string | null }`
    - `ProjectSummary = { id, name, kind, sourceKey, year, theme, partCount, hasPositions, author, license, url, submodels: string[] }`
    - `theme` matches the theme or the parent theme, case-insensitively.
    - Order: `has_positions DESC`, then exact name match first, then `year DESC`, then `id`.
    - `note` is set when the manifest variant is `fallback`: `Build positions are not downloaded yet; they arrive with the next published release.`
  - `getProject(db, id: number): ProjectDetail | null`
    - `ProjectDetail = ProjectSummary & { baseProjectId, parts: { partNum, name, colorId, colorName, quantity, isSpare, fromMinifig }[], submodels: { id, name, isMain, stepCount, partCount }[], note: string | null }`
    - `note` is set when `has_positions` is 0: the fallback note, or `This project has no positions in the LDraw model repository.`
  - MCP tools `search_projects` and `get_project`, with zod schemas mirroring the filters and descriptions stating that every result carries its author, license, and URL to credit.

- [ ] **Step 1: Write failing tests** on a `standard` fixture database:
  - `searchProjects({ usesPart: '3001', usesColor: 4 })` returns `S1-1` first, because it has positions.
  - `theme: 'town'` matches all four sets through the parent theme.
  - `getProject` for `S1-1` lists the minifig banana with `fromMinifig: true` and lists 2 submodels.
  - On a `fallback` fixture database, `note` is set.
  - The MCP server lists `search_projects`, `get_project`, and `get_submodel` in its tool list (the last one is registered in Task 13; add that assertion there).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both lookups and register both tools.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: search_projects and get_project tools`.

### Task 13: Get sub-assembly tool and status additions

**Files:**
- Create: `src/lookup/get-submodel.ts`
- Modify: `src/lookup/status.ts`, `src/mcp/server.ts`
- Test: `tests/lookup/submodel.test.ts`, `tests/lookup/basic.test.ts`

**Interfaces:**
- Produces:
  - `getSubmodel(db, a: { submodelId: number; flatten?: boolean; fromStep?: number; maxPlacements?: number }): { submodel: { id, projectId, name, stepCount }; steps: { step: number; placements: PlacementOut[] }[]; nextStep: number | null }`
    - `PlacementOut = { partNum: string | null; ldrawFile: string | null; colorId: number | null; colorName: string | null; submodel: string | null; pos: Vec3; matrix: Mat3 }`
    - `maxPlacements` defaults to 300 and is capped at 1000.
    - Steps are returned whole, starting at `fromStep` (default 1), until adding the next step would exceed `maxPlacements`. A first step that alone exceeds the cap is returned anyway.
    - `nextStep` is the first step not returned, or `null`.
    - With `flatten`, child submodel placements are expanded recursively in place, at their parent's step:
      - Positions: `pos = parent.pos + parent.matrix · child.pos`. Matrices: `matrix = parent.matrix · child.matrix`.
      - Colors: color 16 takes the parent's color.
      - Depth is limited to 32.
  - `databaseStatus` gains `variant`, `origin` (from `update.json`), `releaseTag`, `placementMatchRate`, `failedSources: string[]`, and project counts. A warning `positions not downloaded (fallback database)` appears when the variant is `fallback`.
    - The signature becomes `databaseStatus(db, state, lockHeld, update: UpdateState)`.
  - MCP tool `get_submodel`, with its description stating that transforms are in LDraw units and relative to the requested sub-assembly's origin.

- [ ] **Step 1: Write failing tests**:
  - On the `standard` fixture, the main submodel unflattened gives 2 steps and one placement with `submodel '10001 - cab.ldr'`.
  - Flattened, the `3023` placement has `colorId 4`, `pos` `[0, -24, -10]` (the cab's `(10, 0, 0)` rotated by `0 0 1 0 1 0 -1 0 0`, then translated by `(0, -24, 0)`), and `matrix` `[0, 0, 1, 0, 1, 0, -1, 0, 0]`.
  - A generated submodel with 50 steps of 20 placements and `maxPlacements 300` returns 15 steps and `nextStep 16`.
  - Status on a `fallback` database includes the warning, and `origin` comes from `update.json`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the lookup, the status changes, and the tool registration.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Also run `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `feat: get_submodel tool and release-aware status`.

### Task 14: Docs, live build, first release, and measurements

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json` (replaces `N`), `CLAUDE.md` (Status section)

- [ ] **Step 1: Update `README.md`.**
  - Install now downloads a published database in seconds, and the fan-made option is chosen at install.
  - `/reseed` and `/reseed --local`.
  - Data sources with credits: "Data sourced from Rebrickable", the LDraw Parts Library, the LDCad shadow library, the LDraw OMR and its authors, and Datsville.
  - The database license, CC BY-SA 4.0.
  - Remove the "check Rebrickable's terms" note.
- [ ] **Step 2: Run a full local release build:** `BRICK_ART_DATA=.data node --max-old-space-size=3072 src/entry/release.mjs --out .data/out`. Expected: exit 0 and a tag on the last line. Record the wall time, the OMR file count, `placement_match_rate`, `color_match_rate`, `count_models_skipped_license`, and the four asset sizes. If a gate fails, stop and report the gate messages instead of changing thresholds.
- [ ] **Step 3: Replace `N` in `plugin.json`** with `full.db.gz` size minus `standard.db.gz` size, rounded to whole MB.
- [ ] **Step 4: Update the `CLAUDE.md` Status section.** The project database exists and the database is published by CI.
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `docs: published database, project sources, and credits`.
- [ ] **Step 7: After merge to `main`**, run the workflow by hand (`gh workflow run data-release.yml`) and confirm a `data-3-…` prerelease with four assets appears. Then, in a clean data folder, run `BRICK_ART_DATA=$(mktemp -d) node src/entry/update.mjs`. Expected: `updated`, and `database_status` reports `origin release`. This step needs the user's go-ahead because it publishes.
- [ ] **Step 8: Hand back to the user** the measurements from Step 2, plus a reminder of the spec's open item: tell the LDraw team that CI fetches OMR files weekly.

---

## Self-review notes

- Spec coverage. Each item maps to a task:
  - Sets: Tasks 1 and 2. Positions and sub-assemblies: Tasks 4, 5, 6, and 8. Fan sources: Task 7.
  - Release build, gates, retention, and credits: Task 9. Download, checksum, and fallback: Task 10.
  - Option, prompt, unprompted message, `/reseed`, and the curated-hash rule: Task 11.
  - Tools: Tasks 12 and 13. License allow list: Tasks 4, 7, 8, and 9. Polite OMR: Task 6. README: Task 14.
- Deliberate deviation: Task 8 strips geometry from non-allowed parts in every variant, not only the published one, so local and published databases agree. Today no part is affected: all 5,876 licensed parts are CC BY.
