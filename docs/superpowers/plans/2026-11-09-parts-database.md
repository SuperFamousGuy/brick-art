# Parts Database and Lookup Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that seeds a local SQLite database of real brick parts from public sources and exposes it to Claude through MCP lookup tools.

**Architecture:** A `SessionStart` hook runs a fast bootstrap check and, when needed, starts a detached seed process. The seed downloads Rebrickable CSVs, the LDraw library, and the LDCad shadow library; resolves each part's geometry and connection points; merges curated data from the repo; and writes a versioned SQLite file plus a pointer file in the plugin data folder. A stdio MCP server opens the current database read-only and answers seven lookup tools.

**Tech Stack:** TypeScript run directly by Node.js type stripping, `node:sqlite`, `node:test`, `@modelcontextprotocol/sdk`, `zod`, `yaml`, `fflate`.

**Spec:** `docs/superpowers/specs/2026-11-09-parts-database-design.md`

## Global Constraints

- Minimum Node.js version: **22.18.0**. This is the first 22.x release that strips TypeScript types without a flag, and it is above the spec's `node:sqlite` floor of 22.13. The builder chose to run TypeScript directly, as the spec allowed.
- Entry points (`src/entry/*.mjs`) are plain JavaScript. They check `process.versions.node` before importing any `.ts` file, then print `brick-art requires Node.js 22.18.0 or later (found X)` and exit with code 1.
- Only erasable TypeScript syntax is allowed: no enums, no parameter properties, no namespaces. Relative imports use the `.ts` extension. Set `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`, `module: nodenext`, and `strict` in `tsconfig.json`.
- Every runtime dependency is pure JavaScript, with no install scripts and no native add-ons. Commit `package-lock.json`.
- Nothing is ever written to `${CLAUDE_PLUGIN_ROOT}`. Data goes to `${CLAUDE_PLUGIN_DATA}`, or to `BRICK_ART_DATA`, or to `<repo>/.data` in development.
- The seed never blocks a session. The bootstrap returns in under 1 second when no work is needed.
- Geometry is stored in LDraw units: stud pitch 20 LDU, plate 8 LDU, brick 24 LDU. LDraw's y axis points down.
- Default lookups exclude incomplete parts, printed variants, and the placeholder colors `-1` (`[Unknown]`) and `9999` (`[No Color/Any Color]`). Results rank by `set_count` descending, then `last_year` descending.
- Unreviewed creative uses are always labeled `"suggestion"` in tool output, never presented as fact.
- Platforms: macOS, Linux, and Windows. Use `node:path` for paths. Never rename a file over an open database.
- Source URLs:
  - Rebrickable: `https://cdn.rebrickable.com/media/downloads/<name>.csv.gz` for `parts`, `part_categories`, `part_relationships`, `colors`, `elements`, `inventory_parts`, `inventories`, and `sets`.
  - LDraw: `https://library.ldraw.org/library/updates/complete.zip`.
  - LDCad: the commit SHA comes from `https://api.github.com/repos/RolandMelkert/LDCadShadowLibrary/commits/main`. The archive comes from `https://codeload.github.com/RolandMelkert/LDCadShadowLibrary/zip/<sha>`.
- Tests never touch the network or the full downloads. Run them with `npm test`, which runs `node --test "tests/**/*.test.ts"`.

## Review Focus

1. **LDraw references with backslashes and mixed case**, such as `S\3001S01.DAT`. These must resolve the same as `s/3001s01.dat`. Tested in Task 3.
2. **Missing subfiles and reference cycles in LDraw data.** The part is marked incomplete and the seed continues. Tested in Task 5.
3. **CSV fields with quoted commas and doubled quotes**, such as `"Sticker Sheet for Sets 618-1, 628-2"`. These must parse into one field. Tested in Task 2.
4. **A session that starts while a seed runs, or after a seed crashed and left its lock.** The first case must not start a second seed. The second must clear the stale lock and retry. Tested in Task 12.
5. **A database swap while the MCP server has the old file open.** The server must answer from the new database on its next call. Tested in Task 15.

---

## File Structure

```
.claude-plugin/plugin.json        plugin manifest, inline MCP server
.claude-plugin/marketplace.json   single-plugin marketplace, source "./"
hooks/hooks.json                  SessionStart → bootstrap
commands/reseed.md                /brick-art:reseed slash command
bin/brick-art-seed                shell wrapper → src/entry/seed.mjs
curated/color-families.yaml       color ID → family
curated/creative-uses.yaml        creative-use entries
src/entry/{seed,bootstrap,server}.mjs   version-guarded entry points
src/types.ts                      shared types
src/paths.ts                      data folder, pointer, lock, state, log paths
src/sources/csv.ts                RFC 4180 CSV parser
src/sources/rebrickable.ts        typed Rebrickable loaders
src/sources/fetch.ts              downloads, cache, checksums
src/sources/extract.ts            zip → folder extraction
src/ldraw/library.ts              file lookup over LDraw + shadow folders
src/ldraw/parse.ts                LDraw line parser
src/ldraw/snaps.ts                LDCad snap parsing and classification
src/ldraw/resolve.ts              reference walk, transforms, snaps, inference
src/ldraw/shape.ts                bounds, dimensions, filled-space grid
src/derive/match.ts               Rebrickable part → LDraw file
src/derive/availability.ts        set counts, years, part-color availability
src/derive/traits.ts              shape traits, slope angle, basic kind
src/curated/load.ts               curated loader, validation, hash
src/db/schema.ts                  DDL and SEED_VERSION
src/db/write.ts                   bulk writer
src/db/open.ts                    read-only open through pointer, reopen on change
src/seed/seed.ts                  pipeline orchestration
src/seed/lock.ts                  lock and state files
src/seed/bootstrap.ts             needs-seed decision and detached spawn
src/lookup/*.ts                   one query module per tool
src/mcp/server.ts                 MCP wiring
tests/helpers/fixtures.ts         builds fixture sources in a temp dir
tests/**/*.test.ts
```

## Shared types (`src/types.ts`, created in Task 1, extended by later tasks)

```ts
export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major
export type Triangle = [Vec3, Vec3, Vec3];
export type ConnectionType =
  | 'stud' | 'stud_receptor' | 'bar' | 'bar_holder' | 'clip'
  | 'pin' | 'pin_hole' | 'axle' | 'axle_hole' | 'ball' | 'socket'
  | 'hinge_m' | 'hinge_f' | 'other';
export interface ConnectionPoint {
  type: ConnectionType; position: Vec3; direction: Vec3;
  angleMin: number | null; angleMax: number | null;
  source: 'ldcad' | 'inferred'; raw: string; snapId: string | null;
}
export interface Bounds { min: Vec3; max: Vec3 }
export type Grid = number[][][]; // [layer][z][x], layer 0 = top, 1 = filled
```

## Database schema (Task 9, consumed by Tasks 11 and 13 to 15)

| Table | Columns |
|-------|---------|
| `manifest` | `key TEXT PRIMARY KEY, value TEXT`. Keys: `seed_version`, `curated_hash`, `started_at`, `finished_at`, `ldraw_release`, `ldcad_commit`, `match_rate_top1000`, `count_parts`, `count_with_connections`, `count_incomplete`, `count_creative_loaded`, `count_creative_rejected`. |
| `sources` | `name TEXT PRIMARY KEY, url, downloaded_at, bytes INTEGER, sha256, last_modified` |
| `parts` | `part_num TEXT PRIMARY KEY, name, category_id INTEGER, category_name, ldraw_file, geometry_from, width_studs INTEGER, depth_studs INTEGER, height_plates INTEGER, min_x REAL, min_y REAL, min_z REAL, max_x REAL, max_y REAL, max_z REAL, grid TEXT` (JSON `Grid`)`, slope_angle REAL, basic_kind TEXT` (`brick`/`plate`/`tile`/NULL)`, set_count INTEGER, first_year INTEGER, last_year INTEGER, license, has_geometry INTEGER, has_connections INTEGER, has_grid INTEGER, is_complete INTEGER, is_print INTEGER, base_part_num TEXT` |
| `part_traits` | `part_num, trait`. PK is both columns. |
| `connections` | `id INTEGER PRIMARY KEY, part_num, type, x REAL, y REAL, z REAL, dx REAL, dy REAL, dz REAL, angle_min REAL, angle_max REAL, source, raw` |
| `connection_compat` | `a TEXT, b TEXT`. Stored symmetric, so both (a, b) and (b, a) rows exist. |
| `colors` | `id INTEGER PRIMARY KEY, name, rgb, is_trans INTEGER, family, is_placeholder INTEGER` |
| `part_colors` | `part_num, color_id, set_count INTEGER, last_year INTEGER, in_elements INTEGER`. PK is (`part_num`, `color_id`). |
| `part_relationships` | `rel_type, child_part_num, parent_part_num` |
| `creative_uses` | `part_num, represents, note, reviewed INTEGER, source` |

Indexes go on `parts(is_complete, set_count)`, `parts(width_studs, depth_studs, height_plates)`, `connections(part_num)`, `connections(type)`, `part_colors(color_id)`, and `creative_uses(represents)`.

Compatibility pairs: stud↔stud_receptor, bar↔clip, bar↔bar_holder, pin↔pin_hole, axle↔axle_hole, axle↔pin_hole, ball↔socket, and hinge_m↔hinge_f.

---

### Task 1: Project scaffold and data paths

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`, `src/paths.ts`, `src/entry/version-guard.mjs`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces:
  - `resolveDataDir(env: NodeJS.ProcessEnv, repoRoot: string): string`. Uses `CLAUDE_PLUGIN_DATA`, then `BRICK_ART_DATA`, then `<repoRoot>/.data`.
  - `dataPaths(dataDir: string): { pointer: string; lock: string; state: string; log: string; cacheDir: string; dbFile(stamp: string): string }`. The files are `current.json`, `seed.lock`, `seed-state.json`, `seed.log`, `cache/`, and `parts-<stamp>.db`.
  - `assertNodeVersion(): void` in `version-guard.mjs`, with the message from Global Constraints.

- [ ] **Step 1: Create the scaffold.** `package.json`: `"type": "module"`, `"engines": {"node": ">=22.18.0"}`, scripts `test` (per Global Constraints) and `typecheck` (`tsc --noEmit`), runtime dependencies `@modelcontextprotocol/sdk zod yaml fflate`, dev dependencies `typescript @types/node`. Run `npm install` to produce the lockfile. `.gitignore`: `node_modules/`, `.data/`.
- [ ] **Step 2: Write failing tests** in `tests/paths.test.ts`:
  - `resolveDataDir` returns `CLAUDE_PLUGIN_DATA` when it and `BRICK_ART_DATA` are both set.
  - It returns `BRICK_ART_DATA` when only that is set.
  - It returns `path.join(repoRoot, '.data')` when neither is set.
  - `dataPaths('/d').dbFile('20261109T120000')` equals `path.join('/d', 'parts-20261109T120000.db')`.
- [ ] **Step 3: Run** `npm test`. Expected: FAIL because the module is not found.
- [ ] **Step 4: Implement** `src/paths.ts`, `src/types.ts` (the shared types above), and `src/entry/version-guard.mjs`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `chore: scaffold TypeScript project and data paths`.

### Task 2: CSV parsing and Rebrickable loaders

**Files:**
- Create: `src/sources/csv.ts`, `src/sources/rebrickable.ts`, `tests/helpers/fixtures.ts`
- Test: `tests/sources/csv.test.ts`, `tests/sources/rebrickable.test.ts`

**Interfaces:**
- Produces:
  - `parseCsv(text: string): Record<string, string>[]`. The header row supplies the keys.
  - `loadRebrickable(dir: string): Promise<RebrickableData>`. It reads `<name>.csv.gz` files from `dir`.
  - `RebrickableData = { parts: RbPart[]; categories: Map<number, string>; colors: RbColor[]; elements: RbElement[]; relationships: RbRelationship[]; inventories: Map<number, string>; inventoryParts: RbInventoryPart[]; setYears: Map<string, number> }`. `inventories` maps inventory ID to set number.
  - `RbPart {partNum, name, categoryId}`
  - `RbColor {id, name, rgb, isTrans}`
  - `RbElement {partNum, colorId}`
  - `RbRelationship {relType, child, parent}`
  - `RbInventoryPart {inventoryId, partNum, colorId, isSpare}`
  - `writeFixtureSources(dir: string): Promise<FixtureSources>` in `tests/helpers/fixtures.ts`. Task 2 writes the CSVs, and Task 3 adds the LDraw files.

**Fixture data** (gzipped CSVs with real headers, matching the spec's source files):
- **colors:** `-1 [Unknown]`, `0 Black`, `2 Green`, `4 Red`, `47 Trans-Clear` (is_trans True), `288 Dark Green`, `9999 [No Color/Any Color]`.
- **categories:** `11 Bricks`, `14 Plates`, `3 Bricks Sloped`, `19 Tiles Special`, `5 Bricks Special`, `18 Hinges Arms and Turntables`, `27 Minifig Accessories`, `58 Stickers`.
- **parts:**
  - `3001 Brick 2 x 4`, `3008 Brick 1 x 8`, `3009 Brick 1 x 6`, `3010 Brick 1 x 4`, `3622 Brick 1 x 3`, `3004 Brick 1 x 2`, `3005 Brick 1 x 1`
  - `3023 Plate 1 x 2`, `3039 Slope 45° 2 x 2`, `87087 Brick Special 1 x 1 with Stud on 1 Side`
  - `60478 Plate Special 1 x 2 with Bar Handle on End`, `15712 Tile Special 1 x 1 with Clip`
  - `3937 Hinge Brick 1 x 2 Base`, `3938 Hinge Brick 1 x 2 Top Plate`, `33085 Banana`
  - `3001pr0001 Brick 2 x 4 with Print`, `3009b Brick 1 x 6 Alternate Mold`, `99999 Broken Part`
  - `003383 "Sticker Sheet for Sets 618-1, 628-2"` (category 58, quoted with a comma)
- **sets:** `S1-1` 2020, `S2-1` 2022, `S3-1` 2024, `S4-1` 1998.
- **inventories:** `1→S1-1`, `2→S2-1`, `3→S3-1`, `4→S4-1`, and `5→S3-1` (version 2).
- **inventory_parts:**
  - 3001 red in inventories 1, 2, 3, and 5. 3001 black in 3. 3001 red in 4 with `is_spare True`.
  - 3008 red in 1. 3009 red in 1. 3010 green in 2. 3004 green in 2 and 3. 3622 green in 3.
  - 3023 black in 1, 2, and 3. 33085 red in 4.
  - Every other part except 99999 and the sticker: black in 2.
- **elements:** `3001` color 2 (green).
- **part_relationships:** `P,3001pr0001,3001` and `M,3009b,3009`.

- [ ] **Step 1: Write failing tests.**
  - `parseCsv('a,b\n1,"x, ""y"""\n')` deep-equals `[{a:'1', b:'x, "y"'}]`.
  - `parseCsv` handles CRLF line ends and a trailing newline.
  - `loadRebrickable` on the fixtures: `parts.length === 19`. The sticker's name is `Sticker Sheet for Sets 618-1, 628-2`. `colors.find(c => c.id === 47).isTrans === true`. `setYears.get('S4-1') === 1998`. `inventoryParts.filter(r => r.isSpare).length === 1`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write a character-by-character state-machine parser. Decompress with `node:zlib` `gunzipSync`. The largest real file is 14 MB compressed, which is acceptable to read whole.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: parse Rebrickable CSV downloads`.

### Task 3: LDraw library lookup and line parser

**Files:**
- Create: `src/ldraw/library.ts`, `src/ldraw/parse.ts`
- Modify: `tests/helpers/fixtures.ts` (adds LDraw and shadow fixture folders and zips)
- Test: `tests/ldraw/library.test.ts`, `tests/ldraw/parse.test.ts`

**Interfaces:**
- Produces:
  - `class LDrawLibrary`:
    - `static fromDirs(ldrawRoot: string, shadowRoot: string | null): Promise<LDrawLibrary>`
    - `static fromMaps(ldraw: Map<string, string>, shadow: Map<string, string>): LDrawLibrary` (for tests)
    - `read(ref: string): string | null` and `readShadow(ref: string): string | null`. Both resolve `ref` against `parts/` and then `p/`.
    - `normalize(ref: string): string`. Lowercases, converts `\` to `/`, and trims.
    - `has(partFile: string): boolean`
    - `releaseName(): string | null`
  - `parseLDraw(text: string): ParsedFile`, where:
    - `ParsedFile = { description: string; license: string | null; updateTag: string | null; refs: Ref[]; tris: Triangle[]; snapLines: string[] }`
    - `Ref = { file: string; pos: Vec3; matrix: Mat3 }`
    - Type 4 quads split into two triangles. Type 2 and 5 lines are ignored. `snapLines` collects lines starting with `0 !LDCAD SNAP_` and ignores commented-out `0 //!LDCAD` lines. `updateTag` holds `YYYY-RR` from `!LDRAW_ORG ... UPDATE YYYY-RR`.

`fromDirs` indexes every file under `ldrawRoot/parts` and `ldrawRoot/p` (including `p/48`, `p/8`, and `parts/s`) by normalized relative path. It reads file contents lazily and caches parsed results. It must not load the whole library into memory, which is 552 MB uncompressed. `releaseName()` returns the largest `updateTag` among files read so far. The seed calls it after processing all parts.

**Fixture LDraw files.** Generate them from a `box(x0, y0, z0, x1, y1, z1)` helper that emits six type-4 quads. Hollow bodies are an outer box plus an inner box inset 4 LDU on the sides and from the top, which gives the parts walls.
- `p/stud.dat`: `box(-6,-4,-6,6,0,6)`.
- `p/stud2.dat`: the same geometry. It has no shadow file.
- `parts/s/3001s01.dat`: the hollow body `x ±40, y 0..24, z ±20`.
- `parts/3001.dat`: references `S\3001S01.DAT`, plus eight `stud.dat` references at `x ∈ {-30,-10,10,30}`, `z ∈ {-10,10}`, `y 0`.
- Bricks `3008`, `3009`, `3010`, `3622`, `3004`, and `3005`: 1×N hollow bodies with studs. `3005` uses `stud2.dat`. Width runs along x.
- `3023`: a 1×2 plate (`y 0..8`) with 2 studs. `33085`: `box(-10,0,-30,10,8,30)` with no studs.
- `3039`: the back half is a hollow body `x ±20, y 0..24, z 0..20`. The front half is a wedge whose top face slopes from `y 8` at `z 0` down to `y 24` at `z -20`. Name line `0 Slope Brick 45  2 x  2`. Two studs on the back row.
- `87087`: a 1×1 brick with a top stud, plus a side stud reference `1 16 0 12 -10 1 0 0 0 0 -1 0 1 0 stud.dat`.
- `60478`, `15712`, `3937`, and `3938`: simple boxes.
- `99999`: references `s\missing.dat`.
- Every part file carries `0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt` and `0 !LDRAW_ORG Part UPDATE 2026-10`. Only `3005` carries `UPDATE 2025-03`.

**Fixture shadow files** (real LDCad syntax):
- `p/stud.dat`: `0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [caps=one] [secs=R 6 4]`
- `parts/s/3001s01.dat`: `0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 20] [pos=0 24 0] [grid=C 4 C 2 20 20]`
- `parts/3937.dat`:
  - `0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=S 6 4] [pos=0 24 0] [grid=C 2 1 20 0]`
  - `0 !LDCAD SNAP_FGR [group=hgBrC] [genderOfs=F] [seq=18 4 18] [radius=4] [pos=0 10 0] [ori=0 -1 0 1 0 0 0 0 1]`
- `parts/3938.dat`: the same `SNAP_FGR` line with `[genderOfs=M]`.
- `parts/15712.dat`: `0 !LDCAD SNAP_CLP [radius=4] [length=8] [pos=0 -6 0]`
- `parts/60478.dat`: `0 !LDCAD SNAP_CYL [gender=M] [caps=none] [secs=R 4 16] [pos=0 4 -30] [ori=1 0 0 0 0 1 0 -1 0]`

`writeFixtureSources` also zips the LDraw tree under an `ldraw/` prefix as `complete.zip`. It zips the shadow tree under a `LDCadShadowLibrary-<sha>/` prefix as `ldcad.zip`, matching the GitHub archive layout. Use `fflate` `zipSync`.

- [ ] **Step 1: Write failing tests.**
  - `library.read('S\\3001S01.DAT')` returns the same text as `read('s/3001s01.dat')`.
  - `read('stud.dat')` finds `p/stud.dat`.
  - `read('nope.dat')` returns `null`.
  - `readShadow('stud.dat')` contains `SNAP_CYL`.
  - `parseLDraw` on fixture `3001.dat`: `refs.length === 9`. One ref has `file === 'S\\3001S01.DAT'`. `license` starts with `Licensed under CC BY 4.0`.
  - `parseLDraw` of one quad line yields 2 triangles.
  - `parseLDraw` ignores a `0 //!LDCAD SNAP_CYL` line (`snapLines.length === 0`).
  - `releaseName()` after reading `3001.dat` and `3005.dat` equals `'2026-10'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: LDraw library lookup and parser`.

### Task 4: LDCad snap parsing and classification

**Files:**
- Create: `src/ldraw/snaps.ts`
- Test: `tests/ldraw/snaps.test.ts`

**Interfaces:**
- Produces:
  - `parseSnapLine(line: string): SnapSpec`, where `SnapSpec = { kind: 'CYL' | 'CLP' | 'FGR' | 'SPH' | 'GEN' | 'INCL' | 'CLEAR'; params: Record<string, string> }`. Parameter names are lowercased.
  - `expandSnap(spec: SnapSpec, raw: string): ConnectionPoint[]`. Returns points in the snap's own file frame, with grid expansion applied. Returns `[]` for `INCL` and `CLEAR`, which the resolver handles.
  - `snapPosOri(spec: SnapSpec): { pos: Vec3; ori: Mat3 }`. Defaults to the origin and identity.
  - `gridOffsets(grid: string | undefined): Vec3[]`

**Rules:**
- **Defaults:** `gender=M`, `caps=one`, `pos=0 0 0`, `ori` identity.
- **Grid:** `[grid=C 4 C 2 20 20]` means countX 4, centered; countZ 2, centered; stepX 20; stepZ 20. A `C` marks the count that follows it as centered. Uncentered counts start at 0. Offsets are `(gx, 0, gz)` in the snap frame, so `pos + ori·offset`.
- **Direction:** M (and `genderOfs=M`) faces `ori·(0,-1,0)`. F faces `ori·(0,1,0)`. CLP faces `ori·(0,-1,0)`.
- **`secs` parsing:** groups of `shape radius length`. The dominant section is the longest one. Shapes are `R` (round), `S` (square), `A` (axle), and others treated as `R`.
- **CYL classification:**
  - Any `A` section: M → `axle`, F → `axle_hole`.
  - Dominant radius ≤ 4.5: M → `bar`, F → `bar_holder`.
  - Dominant radius ≤ 7: M with `caps=one` and total length ≤ 8 → `stud`, other M → `pin`. F with `caps=one` → `stud_receptor`, other F → `pin_hole`.
  - Otherwise `other`.
- **Other kinds:** CLP → `clip`. FGR → `hinge_m` or `hinge_f` by `genderOfs`. SPH: M → `ball`, F → `socket`. GEN → `other`.
- `angleMin` and `angleMax` are always `null`. LDCad gives no angle ranges.
- `source` is `'ldcad'`, and `snapId` comes from the `id` parameter.

- [ ] **Step 1: Write failing tests.**
  - The stud line expands to 1 `stud` at `[0,0,0]` facing `[0,-1,0]` with `snapId` `'studC'`.
  - The 3001s01 line expands to 8 `stud_receptor` points facing `[0,1,0]`. Their x values are `{-30,-10,10,30}`, their z values are `{-10,10}`, and every y is 24.
  - The 60478 line yields a `bar` facing `[0,0,1]`. Compute this as `ori·(0,-1,0)` with ori rows `(1,0,0),(0,0,1),(0,-1,0)`.
  - The 3937 CYL yields 2 `stud_receptor` points at x `±10`.
  - The FGR lines yield `hinge_f` and `hinge_m`.
  - `[secs=R 8 2 R 6 16 R 8 2] [caps=none] [gender=F]` yields `pin_hole`.
  - `[secs=A 6 20] [gender=F]` yields `axle_hole`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `snaps.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: parse and classify LDCad snap metadata`.

### Task 5: Reference resolver with connection inference

**Files:**
- Create: `src/ldraw/resolve.ts`
- Test: `tests/ldraw/resolve.test.ts`

**Interfaces:**
- Consumes: `LDrawLibrary`, `parseLDraw`, `parseSnapLine`, `expandSnap`, `snapPosOri`, and `gridOffsets`.
- Produces: `resolvePart(lib: LDrawLibrary, file: string): ResolvedPart`, where `ResolvedPart = { triangles: Triangle[]; bodyTriangles: Triangle[]; connections: ConnectionPoint[]; license: string | null; missingRefs: string[]; cyclic: boolean }`.

**Rules:**
- **Traversal:** depth-first. Child world transform = parent matrix × ref matrix, and child position = parent pos + parent matrix · ref pos. Directions transform by the matrix and are renormalized.
- **Snaps:** at each file, collect the expanded snaps of the shadow file with the same name. Then add the snaps of `SNAP_INCL [ref=…]` targets, resolved through `readShadow` and placed with `pos`, `ori`, and `grid`. Then add the children's snaps. A `SNAP_CLEAR` line in a file's shadow drops its children's snaps. With `[id=X]`, it drops only children's snaps whose `snapId` is X.
- **`bodyTriangles`:** excludes the subtrees of files whose normalized name matches `/^(p\/)?stud[0-9a-z]*\.dat$/` and `/^(p\/)?stu2[0-9a-z]*\.dat$/`.
- **Missing references:** a reference that can't be read is recorded in `missingRefs` (normalized) and skipped.
- **Cycles:** a file already on the current path sets `cyclic = true` and is skipped.
- **Inference:** applies only when the whole tree yielded zero LDCad snaps. Each reference to `stud.dat`, `stud2.dat`, or `stud2a.dat` adds a `stud` at the ref origin facing matrix·`(0,-1,0)`. Each reference to `stud3.dat`, `stud4.dat`, or `stud4a.dat` adds a `stud_receptor` at the ref origin facing matrix·`(0,1,0)`. These points have `source 'inferred'` and `raw` set to the referenced file name.

- [ ] **Step 1: Write failing tests** against the fixture library.
  - `3001`: 8 `stud` and 8 `stud_receptor` connections, all `source 'ldcad'`, and `missingRefs` empty.
  - `87087`: has a `stud` with position ≈ `[0,12,-10]` and direction ≈ `[0,0,-1]` (tolerance 1e-9).
  - `3005`: 1 `stud`, `source 'inferred'`.
  - `99999`: `missingRefs` deep-equals `['s/missing.dat']`.
  - Using `LDrawLibrary.fromMaps`, `a.dat` → `b.dat` → `a.dat` returns with `cyclic === true` and no throw.
  - `SNAP_INCL`: a shadow `parts/x.dat` with `0 !LDCAD SNAP_INCL [ref=stud.dat] [pos=0 0 0] [grid=2 1 20 0]` yields 2 studs.
  - `SNAP_CLEAR`: a shadow file with `0 !LDCAD SNAP_CLEAR [id=studC]` on a part that references `stud.dat` yields 0 studs from that child.
  - `3001` `bodyTriangles.length < triangles.length`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `resolve.ts`. Memoize each subfile's resolved local result by normalized name. Primitives repeat thousands of times across the library.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: resolve LDraw parts into geometry and connections`.

### Task 6: Bounds, dimensions, and filled-space grid

**Files:**
- Create: `src/ldraw/shape.ts`
- Test: `tests/ldraw/shape.test.ts`

**Interfaces:**
- Consumes: `ResolvedPart.bodyTriangles`
- Produces: `computeShape(bodyTriangles: Triangle[]): PartShape | null`, where `PartShape = { bounds: Bounds; widthStuds: number; depthStuds: number; heightPlates: number; grid: Grid }`. Returns `null` when there are no triangles.

**Rules:**
- `widthStuds = max(1, round((max.x - min.x) / 20))`, `depthStuds` uses z, and `heightPlates = max(1, round((max.y - min.y) / 8))`.
- Grid cells are 20 × 8 × 20 LDU, with the origin at the bounds minimum. Layer 0 is the top layer (smallest y).
- A cell is filled when any triangle intersects the cell box shrunk by 0.5 LDU on every side. Use a separating-axis triangle–box test. Triangles that lie only on cell faces don't fill the cell.

- [ ] **Step 1: Write failing tests.**
  - `3001` body: bounds `[-40,0,-20]` to `[40,24,20]`, dimensions `4 × 2 × 3`, and every grid cell `1`.
  - `3023`: `2 × 1 × 1`.
  - `3039`: dimensions `2 × 2 × 3`. The cell at layer 0, front z row (`grid[0][0]`), is empty for both x. The back row is filled in all layers.
  - An empty triangle list returns `null`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `shape.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: compute part bounds and filled-space grid`.

### Task 7: Matching, availability, and traits

**Files:**
- Create: `src/derive/match.ts`, `src/derive/availability.ts`, `src/derive/traits.ts`
- Test: `tests/derive/*.test.ts`

**Interfaces:**
- Consumes: `RebrickableData`, `LDrawLibrary.has`
- Produces:
  - `matchParts(rb: RebrickableData, has: (f: string) => boolean): Map<string, { ldrawFile: string; geometryFrom: string }>`
  - `matchRateTop(rb: RebrickableData, matches: Map<string, unknown>, setCounts: Map<string, number>, n: number): number`
  - `computeAvailability(rb: RebrickableData): { parts: Map<string, { setCount: number; firstYear: number | null; lastYear: number | null }>; partColors: Map<string, Map<number, { setCount: number; lastYear: number | null; inElements: boolean }>> }`
  - `deriveTraits(input: { name: string; categoryName: string; connections: ConnectionPoint[]; colorsTrans: boolean[] }): { traits: string[]; slopeAngle: number | null; basicKind: 'brick' | 'plate' | 'tile' | null }`

**Rules:**
- **Matching:** first try `<partNum lowercase>.dat` in `parts/`. If that fails, follow `M` and `A` relationships in either direction to a part that matches. `geometryFrom` is the part number whose file was used.
- **Counting:** count distinct set numbers through `inventories`, and skip spare rows. Years come from `setYears`. `part_colors` holds the union of inventory combinations and elements, and `inElements` marks the element ones.
- **Traits:**
  - Category `Bricks Sloped` or a name matching `/\bSlope\b/` → `slope`.
  - `/Inverted/` → `inverted`. `/Curved/` → `curved`. `/Round|Dish|Cone|Cylinder/` → `round`. `/Wedge/` → `wedge`.
  - A category starting with `Tiles`, or a name starting with `Tile` → `tile`.
  - A name containing `Hinge`, or any `hinge_m`/`hinge_f` connection → `hinge`.
  - Any transparent available color → `transparent-capable`.
  - Any `stud` whose direction has `|dy| < 0.5` → `side-stud`.
  - `slopeAngle` comes from `/Slope\s+(\d+)/`.
  - `basicKind` comes from the name matching `^(Brick|Plate|Tile) \d+ x \d+$`.

- [ ] **Step 1: Write failing tests** on the fixtures.
  - `matchParts`: `3001` → `3001.dat`. `3009b` → `geometryFrom '3009'`. `3001pr0001` and the sticker are absent.
  - `computeAvailability`: `3001` has `setCount 3`, `firstYear 2020`, `lastYear 2024`. `3001` red has `setCount 3`. `3001` green has `setCount 0` and `inElements true`. `33085` has `setCount 1` and `lastYear 1998`.
  - `deriveTraits`: `Slope 45° 2 x 2` in `Bricks Sloped` → traits include `slope`, `slopeAngle 45`, `basicKind null`. `Brick 1 x 6` → `basicKind 'brick'`. `87087` with its connections → includes `side-stud`.
  - `matchRateTop` with n = 3 over fixture counts returns `1`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: derive part matching, availability, and traits`.

### Task 8: Curated data loader and color families

**Files:**
- Create: `src/curated/load.ts`, `curated/color-families.yaml`, `curated/creative-uses.yaml`
- Test: `tests/curated/load.test.ts`

**Interfaces:**
- Produces:
  - `loadCurated(dir: string): Promise<{ families: Map<number, string>; uses: CreativeUse[]; hash: string }>`
  - `CreativeUse = { part: string; represents: string; note: string | null; reviewed: boolean }`
  - `validateUses(uses: CreativeUse[], partNums: Set<string>): { accepted: CreativeUse[]; rejected: { use: CreativeUse; reason: string }[] }`

**Formats:**
- `color-families.yaml`: `families: { <family>: [<colorId>, …] }`. Colors that aren't listed get family `other`.
- `creative-uses.yaml`: a list of `{part, represents, note?, reviewed}`, as in the spec example.
- `hash` is the SHA-256 of the two files' bytes, concatenated in sorted filename order.

**Content:**
- Draft `color-families.yaml` for every color in the live `colors.csv`. Fetch it once by hand with `curl`. Use the families `black`, `white`, `gray`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `brown`, `tan`, `transparent`, `metallic`, and `other`.
- Seed `creative-uses.yaml` with 5 entries for now, including `33085 → flower petal`. Task 18 fills it out.

- [ ] **Step 1: Write failing tests.**
  - On a temp dir with 2 uses and a 2-family file: `families.get(2) === 'green'` and `hash` is 64 hex characters.
  - Changing one byte changes the hash.
  - `validateUses` with part `nope` rejects it with a reason containing `unknown part`.
  - An entry missing `represents` is rejected and doesn't throw.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the loader and draft both YAML files.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: curated color families and creative uses`.

### Task 9: Database schema, writer, and pointer-based open

**Files:**
- Create: `src/db/schema.ts`, `src/db/write.ts`, `src/db/open.ts`
- Test: `tests/db/db.test.ts`

**Interfaces:**
- Produces:
  - `SEED_VERSION = 1`
  - `createSchema(db: DatabaseSync): void`. Creates the tables, indexes, and `connection_compat` rows from the schema section above.
  - `writePart(db, row: PartRow): void`, plus writers for connections, traits, colors, part colors, relationships, creative uses, manifest, and sources. The column names match the schema exactly. All writes run inside one transaction per table batch.
  - `readPointer(dataDir: string): string | null`
  - `writePointer(dataDir: string, dbFileName: string): void`. Writes `current.json` as `{"file": "<name>"}` through a temp file plus rename. The pointer is never open long-term, so the rename is safe on Windows.
  - `class CurrentDb { constructor(dataDir: string); get(): DatabaseSync | null }`. Opens read-only. On each `get()`, it compares the pointer's file name with the open one, and reopens and closes the old handle when they differ.

- [ ] **Step 1: Write failing tests.**
  - `createSchema` on `:memory:` creates all 10 tables. `connection_compat` contains (`stud`, `stud_receptor`) and (`stud_receptor`, `stud`).
  - With no pointer, `CurrentDb.get()` returns `null`.
  - Write db A with manifest `seed_version 1` and point to it, then `get()` reads it. Write db B and repoint, then the next `get()` returns B's manifest. The A handle is closed.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules. Open read-only with `new DatabaseSync(file, { readOnly: true })`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: SQLite schema, writer, and pointer-based open`.

### Task 10: Source download, cache, and extraction

**Files:**
- Create: `src/sources/fetch.ts`, `src/sources/extract.ts`
- Test: `tests/sources/fetch.test.ts`

**Interfaces:**
- Produces:
  - `fetchSources(cacheDir: string, opts: { refresh: boolean; maxAgeHours: number; baseUrls?: Partial<SourceUrls> }): Promise<FetchedSources>`
  - `FetchedSources = { rebrickableDir: string; ldrawRoot: string; shadowRoot: string; ldcadCommit: string; records: SourceRecord[] }`
  - `SourceRecord = { name: string; url: string; downloadedAt: string; bytes: number; sha256: string; lastModified: string | null }`
  - `extractZip(zipFile: string, destDir: string, keep: (path: string) => boolean, stripPrefix: RegExp): Promise<number>`. Returns the number of files written.

**Rules:**
- Stream downloads to `<cacheDir>/<name>.part`, then rename on completion. Send the header `User-Agent: brick-art-seed`.
- A cached file is reused when it's younger than `maxAgeHours` and `refresh` is false. Defaults: 24 hours, and `--refresh` forces a download. A `<name>.meta.json` beside each file stores its `SourceRecord`.
- LDraw extraction keeps `^ldraw/(parts|p)/` and strips `ldraw/`. LDCad extraction keeps `parts/` and `p/` and strips `^[^/]+/`.
- Extract into a fresh folder named after the archive's SHA-256, so a half-finished extraction is never reused.
- An HTTP error throws `Error('download failed: <name> <status>')`.

- [ ] **Step 1: Write failing tests.** Serve the Task 2 and 3 fixture files from a local `node:http` server, and set `baseUrls` to it. The server also answers the GitHub commits URL with `{"sha": "abc123"}`.
  - The first call downloads all 10 sources, and every record has a 64-character `sha256`.
  - A second call within `maxAgeHours` makes zero requests (count them in the server).
  - `refresh: true` downloads again.
  - A 500 on `parts.csv.gz` rejects with `download failed: parts 500`.
  - After extraction, `ldrawRoot/parts/3001.dat` and `shadowRoot/p/stud.dat` exist.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. Use `fflate`'s streaming `Unzip` so the 147 MB archive never sits whole in memory.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: download and cache source data`.

### Task 11: Seed pipeline, lock, and state

**Files:**
- Create: `src/seed/seed.ts`, `src/seed/lock.ts`, `src/entry/seed.mjs`, `bin/brick-art-seed`
- Test: `tests/seed/seed.test.ts`, `tests/seed/lock.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 10.
- Produces:
  - `runSeed(opts: { dataDir: string; repoRoot: string; refresh: boolean; sources?: FetchedSources; now?: () => Date }): Promise<SeedResult>`. Tests pass prebuilt `sources`.
  - `SeedResult = { dbFile: string; counts: Record<string, number> }`
  - `acquireLock(lockPath: string): boolean`. Creates the file exclusively and writes the pid. It replaces a lock whose pid isn't alive, which it checks with `process.kill(pid, 0)`.
  - `releaseLock(lockPath: string): void`
  - `readState(statePath): SeedState` and `writeState(statePath, s: SeedState)`, where `SeedState = { status: 'idle' | 'seeding' | 'ready' | 'failed'; startedAt: string | null; finishedAt: string | null; lastError: string | null; failures: number }`.
  - `src/entry/seed.mjs`: CLI that accepts `--refresh`, guards the Node version, and calls `runSeed`.
  - `bin/brick-art-seed`: `#!/bin/sh`, then runs `exec node "$(dirname "$0")/../src/entry/seed.mjs" "$@"`.

**Pipeline:**
1. Acquire the lock, or exit 0 with `seed already running`.
2. Set the state to `seeding`.
3. Fetch the sources.
4. Load Rebrickable and the library.
5. For every Rebrickable part: match, resolve, and compute shape and traits.
6. Compute availability and set counts.
7. Load and validate the curated data.
8. Write `parts-<stamp>.db`, where the stamp is `YYYYMMDDTHHMMSS` in UTC.
9. Write the manifest and sources.
10. Write the pointer.
11. Unlink every other `parts-*.db`, ignoring `EBUSY` and `EPERM`.
12. Set the state to `ready`, with `failures` 0.
13. Release the lock.

**Errors:** on any error, delete the new db file, keep the pointer unchanged, set the state to `failed` with `lastError` and `failures + 1`, release the lock, and rethrow. Write progress lines to `seed.log`.

**Completeness:**
- `has_geometry`: a shape exists.
- `has_grid`: same as `has_geometry`.
- `has_connections`: at least one connection.
- `is_complete`: all three are true, and `missingRefs` is empty.

`is_print` is set for `P` and `T` children, with `base_part_num` set to the parent.

- [ ] **Step 1: Write failing tests.**
  - Run `runSeed` on fixture sources into a temp `dataDir`. Then:
    - `count_parts = 19`.
    - Part `3001` has `is_complete 1`, `width_studs 4`, `set_count 3`, and 16 connections.
    - `3001pr0001` has `is_print 1` and `base_part_num '3001'`.
    - `99999` has `is_complete 0`.
    - The manifest's `ldraw_release = '2026-10'`.
    - `sources` has 10 rows.
    - `creative_uses` rows equal the accepted count.
  - A second `runSeed` leaves exactly one `parts-*.db` and repoints to it.
  - With `sources.ldrawRoot` pointed at an empty dir and a forced throw, the previous db and pointer are unchanged and the state is `failed` with `failures 1`.
  - `acquireLock` twice in one process: the second call returns `false`.
  - A lock file containing pid `999999` that isn't alive is replaced (returns `true`).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: seed pipeline with atomic pointer swap`.

### Task 12: SessionStart bootstrap

**Files:**
- Create: `src/seed/bootstrap.ts`, `src/entry/bootstrap.mjs`
- Test: `tests/seed/bootstrap.test.ts`

**Interfaces:**
- Consumes: `readPointer`, `SEED_VERSION`, `loadCurated` (hash only), `readState`, and the lock.
- Produces:
  - `needsSeed(dataDir: string, repoRoot: string): Promise<{ needed: boolean; reason: 'missing' | 'seed_version' | 'curated' | 'running' | 'ok' }>`
  - `bootstrap(dataDir: string, repoRoot: string, spawnSeed: () => void): Promise<string>`. Returns the line printed to stdout.

**Rules:**
- A live lock gives `running`, with nothing spawned. A missing pointer or db file gives `missing`.
- `manifest.seed_version != SEED_VERSION` gives `seed_version`. A different curated hash gives `curated`.
- When a seed is needed, call `spawnSeed`. The real spawn is `child_process.spawn(process.execPath, [seed.mjs], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true }).unref()`.
- The stdout line is one of:
  - `brick-art: parts database ready (<count_parts> parts, seeded <finished_at>).`
  - `brick-art: building the parts database in the background (first run takes a few minutes).`
  - When the state is failed: `brick-art: last parts database build failed: <lastError>. Retrying in the background.`
- The bootstrap never throws to the hook. It catches everything and prints `brick-art: setup check failed: <message>`.

- [ ] **Step 1: Write failing tests.**
  - An empty dataDir gives `missing`, and `spawnSeed` is called once.
  - After a fixture seed it gives `ok`, and `spawnSeed` isn't called.
  - Editing a curated file in a temp copy of `repoRoot` gives `curated`.
  - A live lock (current pid) gives `running`, and `spawnSeed` isn't called.
  - A stale lock (pid `999999`) with a missing db gives `missing`, and `spawnSeed` is called.
  - `bootstrap` on a ready db completes in under 1000 ms.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: SessionStart bootstrap starts background seed`.

### Task 13: Lookup queries: search parts, get part, list colors, status

**Files:**
- Create: `src/lookup/search-parts.ts`, `src/lookup/get-part.ts`, `src/lookup/list-colors.ts`, `src/lookup/status.ts`, `src/lookup/common.ts`
- Test: `tests/lookup/basic.test.ts` (seeds the fixtures once in `before`)

**Interfaces:**
- Consumes: `DatabaseSync`, schema.
- Produces:
  - `PartSummary = { partNum; name; category; widthStuds; depthStuds; heightPlates; setCount; lastYear; traits: string[] }`
  - `searchParts(db, a: { category?: string; width?: number | [number, number]; depth?: number | [number, number]; height?: number | [number, number]; color?: number; colorFamily?: string; traits?: string[]; slopeAngle?: number; minSetCount?: number; nameContains?: string; includeIncomplete?: boolean; includePrints?: boolean; limit?: number }): PartSummary[]`. The default limit is 25, with a maximum of 200. Width and depth match in either orientation.
  - `getPart(db, partNum: string): PartDetail | null`. `PartDetail` holds every `parts` column, plus `grid`, `connections`, `colors: {id, name, rgb, setCount, lastYear}[]`, `relationships`, and `creativeUses: {represents, note, status: 'reviewed' | 'suggestion'}[]`.
  - `listColors(db, a: { family?: string; partNum?: string }): { id; name; rgb; isTrans; family }[]`. Excludes placeholders.
  - `databaseStatus(db: DatabaseSync | null, state: SeedState): { state: string; seededAt: string | null; ldrawRelease; ldcadCommit; matchRateTop1000: number | null; counts: Record<string, number>; lastError: string | null; warnings: string[] }`. Adds the warning `match rate below 95%` when `match_rate_top1000 < 0.95`.

- [ ] **Step 1: Write failing tests.**
  - `searchParts({ width: 1, height: 3 })` returns brick part numbers ordered by `set_count`, where the first result has the largest count. It excludes `99999` and `3001pr0001`.
  - `searchParts({ width: 4, depth: 2 })` and `({ width: 2, depth: 4 })` both include `3001`.
  - `searchParts({ color: 2 })` includes `3001` (through elements) and `3010`.
  - `searchParts({ traits: ['slope'] })` returns exactly `['3039']`.
  - `getPart('3001').connections.length === 16`, and the `colors` IDs are `[0, 2, 4]` in any order.
  - `getPart('33085').creativeUses[0].status === 'suggestion'`.
  - `listColors({})` has no ID `-1` or `9999`.
  - `databaseStatus(null, failedState).state === 'failed'`, and `lastError` is passed through.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules. Use parameterized SQL only.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: search, part detail, color, and status lookups`.

### Task 14: Lookup queries: find by use, compatible parts, substitutes

**Files:**
- Create: `src/lookup/find-by-use.ts`, `src/lookup/find-compatible.ts`, `src/lookup/find-substitutes.ts`
- Test: `tests/lookup/advanced.test.ts`

**Interfaces:**
- Consumes: `PartSummary` and the filter shape from `searchParts` (reuse `common.ts`).
- Produces:
  - `findByUse(db, a: { represents: string; color?: number; colorFamily?: string; limit?: number }): { part: PartSummary; represents: string; note: string | null; status: 'reviewed' | 'suggestion' }[]`. The match is a case-insensitive substring. Reviewed entries rank first, then by commonness.
  - `findCompatible(db, a: { connectionType?: ConnectionType; partNum?: string; connectionIndex?: number; color?: number; limit?: number }): { part: PartSummary; matchingTypes: ConnectionType[] }[]`. Give either `connectionType`, or `partNum` with an optional index (all of the part's types when the index is omitted).
  - `findSubstitutes(db, a: { partNum: string; color: number; limit?: number }): { kind: 'related' | 'combination'; parts: string[]; note: string }[]`

**Substitution rules:**
1. **Related:** parts linked to the input by `M` or `A` relationships, in either direction, that are available in the color.
2. **Combination:** only for `basic_kind` parts. Find multisets of up to 3 parts with the same `basic_kind` and the same width, whose lengths sum to the input's length and which are all available in the color. Rank by fewest pieces, then by the summed `set_count`. Also check the reverse orientation.

- [ ] **Step 1: Write failing tests.**
  - `findByUse({ represents: 'petal' })[0].part.partNum === '33085'`, with `status 'suggestion'`.
  - `findCompatible({ connectionType: 'stud' })` includes `3001` (through its `stud_receptor`) and excludes `33085`.
  - `findCompatible({ connectionType: 'bar' })` includes `15712`.
  - `findCompatible({ connectionType: 'hinge_m' })` includes `3937`.
  - `findSubstitutes({ partNum: '3009', color: 2 })` includes `{kind: 'combination', parts: ['3622', '3622']}` and `['3010', '3004']` (sorted within each option). The two-piece options come before any three-piece option.
  - `findSubstitutes({ partNum: '3009', color: 4 })` returns `[]`, because the part already exists in red. It also returns `[]` for a part that isn't basic and has no relationships.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: creative use, compatibility, and substitution lookups`.

### Task 15: MCP server

**Files:**
- Create: `src/mcp/server.ts`, `src/entry/server.mjs`
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `CurrentDb`, `readState`, and every lookup function.
- Produces:
  - `createServer(dataDir: string): McpServer`
  - Tools, each with a `zod` input schema that mirrors its lookup function's arguments: `search_parts`, `get_part`, `find_by_use`, `find_compatible_parts`, `find_substitutes`, `list_colors`, and `database_status`.

**Rules:**
- Every tool except `database_status` returns `{ isError: true, content: [{type: 'text', text: 'Parts database is not ready (<state>). <lastError or "Seeding runs in the background; try again in a few minutes.">'}] }` when `CurrentDb.get()` is `null`.
- Successful results are `content: [{type: 'text', text: JSON.stringify(result)}]`.
- Each tool description says in one sentence what it returns and states the defaults: incomplete parts and prints excluded, common parts first.

- [ ] **Step 1: Write failing tests.** Use the SDK's `Client` with `InMemoryTransport.createLinkedPair()`.
  - `listTools` returns the 7 names above.
  - With no db, `search_parts` returns `isError true` and text starting with `Parts database is not ready`.
  - After a fixture seed, `get_part {partNum: '3001'}` parses to an object with `widthStuds 4`.
  - Run a second fixture seed while the server is connected, with the manifest `finished_at` changed through an injected `now`. Then the next `database_status` reports the new `seededAt`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the server. The entry point connects it to `StdioServerTransport` and resolves the data dir from `BRICK_ART_DATA`, then `CLAUDE_PLUGIN_DATA`, then the dev fallback.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: MCP server exposing parts lookups`.

### Task 16: Plugin packaging and docs

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `commands/reseed.md`
- Modify: `README.md`, `CLAUDE.md` (Status section)
- Test: `tests/plugin.test.ts`

**Content:**
- `plugin.json`: `name "brick-art"`, `version "0.1.0"`, and a description. Declare `mcpServers.brick-art-parts` inline with `command "node"`, `args ["${CLAUDE_PLUGIN_ROOT}/src/entry/server.mjs"]`, and `env {"BRICK_ART_DATA": "${CLAUDE_PLUGIN_DATA}"}`.
- `hooks/hooks.json`: `SessionStart` → command `node "${CLAUDE_PLUGIN_ROOT}/src/entry/bootstrap.mjs"`.
- `commands/reseed.md`: tells Claude to run `"${CLAUDE_PLUGIN_ROOT}/bin/brick-art-seed" --refresh` in the background and report `database_status` when it finishes.
- `README.md`: install through `/plugin marketplace add <repo>` and `/plugin install brick-art`. Also covers:
  - The first-run background seed (about 165 MB, a few minutes).
  - The Node 22.18+ requirement.
  - The lookup tools.
  - Refreshing with `/brick-art:reseed`.
  - Development with `claude --plugin-dir .` and `.data/`.
  - **Data sources and attribution:** Rebrickable; "The LDraw Parts Library" (CC BY 4.0 / 2.0); the LDCad Shadow Library by Roland Melkert (CC BY-SA 4.0).
  - A release note that Rebrickable's terms must be checked by a person before public release.
- `CLAUDE.md` Status: the parts database and lookup tool exist. Model format and rendering are still open.

- [ ] **Step 1: Write failing tests.**
  - `plugin.json` parses and has `mcpServers['brick-art-parts'].args[0]` ending in `server.mjs`.
  - `hooks.json` has a `SessionStart` hook whose command contains `bootstrap.mjs`.
  - No `.mcp.json` exists at the repo root.
  - `bin/brick-art-seed` is executable.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Create the files.** Run `claude plugin validate .` and expect no errors.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: package brick-art as a Claude Code plugin`.

### Task 17: Live seed check

**Files:**
- Modify: whatever the run exposes as broken. Any fix gets a fixture test in its owning task's test file.

- [ ] **Step 1: Run** `BRICK_ART_DATA=.data time node src/entry/seed.mjs --refresh`. Expected: exit 0. Record the wall time and peak memory (`/usr/bin/time -l` on macOS).
- [ ] **Step 2: Check the manifest** with `node -e` or `sqlite3 .data/parts-*.db "select * from manifest"`:
  - `match_rate_top1000 >= 0.95`
  - `count_parts` about 65,000
  - `count_with_connections` reported
  - `ldraw_release` and `ldcad_commit` set
- [ ] **Step 3: Spot-check** with `getPart` that `3001`, `3039`, `3937`, `87087`, `60478`, and `33085` have plausible dimensions and connection types, and record any mismatch. If the seed takes over 10 minutes or uses over 2 GB of memory, profile `resolve.ts` memoization before continuing.
- [ ] **Step 4: Run the bootstrap twice** with `CLAUDE_PLUGIN_DATA=.data node src/entry/bootstrap.mjs`. Expected: the `ready` line, in under 1 second.
- [ ] **Step 5: Commit** any fixes with the message `fix: issues found in live seed`.

### Task 18: Draft creative uses

**Files:**
- Modify: `curated/creative-uses.yaml`

- [ ] **Step 1: List the 400 most common complete parts** from the live database (`set_count` descending, `is_print 0`).
- [ ] **Step 2: Draft entries** with `reviewed: false` only for uses known in the building community or clearly implied by the part's shape. Don't pad the count. Each entry has a short `note` on how the part is used.
- [ ] **Step 3: Run** `BRICK_ART_DATA=.data node src/entry/seed.mjs`. Expected: `count_creative_rejected = 0`. Fix any rejected part numbers.
- [ ] **Step 4: Commit** with the message `data: draft creative-use entries for common parts`.
