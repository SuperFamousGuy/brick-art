import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CurrentDb } from '../db/open.ts';
import { isLockHeld, readState } from '../seed/lock.ts';
import { dataPaths } from '../paths.ts';
import { searchParts } from '../lookup/search-parts.ts';
import { getPart } from '../lookup/get-part.ts';
import { listColors } from '../lookup/list-colors.ts';
import { databaseStatus } from '../lookup/status.ts';
import { findByUse } from '../lookup/find-by-use.ts';
import { findCompatible } from '../lookup/find-compatible.ts';
import { searchProjects } from '../lookup/search-projects.ts';
import { getProject } from '../lookup/get-project.ts';
import { findSubstitutes } from '../lookup/find-substitutes.ts';
import { TRAITS } from '../derive/traits.ts';
import type { ConnectionType } from '../types.ts';

const CONNECTION_TYPES = [
  'stud', 'stud_receptor', 'bar', 'bar_holder', 'clip', 'pin', 'pin_hole',
  'axle', 'axle_hole', 'ball', 'socket', 'hinge_m', 'hinge_f', 'other',
] as const satisfies readonly ConnectionType[];

/** Family names in curated/color-families.yaml; tests/mcp/server.test.ts checks they match. */
export const COLOR_FAMILIES = [
  'black', 'white', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink',
  'brown', 'tan', 'transparent', 'metallic', 'other',
] as const;

const int = z.number().int();
const range = z.union([int, z.tuple([int, int])]);
const limit = int.min(1).max(200).optional().describe('Maximum number of results, 1 to 200 (default 25).');

const SIZE_FRAME =
  "Measured on the part's bounding box in its own frame: studs on top are excluded, protrusions such as handles are included.";
const familyText = `Color family, case-insensitive: one of ${COLOR_FAMILIES.join(', ')}.`;
const partNumText = 'Rebrickable part number, such as "3001".';
const colorText = 'Rebrickable color id (look ids up with list_colors); keeps parts known in that color.';

/** Part filter fields shared by search_parts, find_by_use, and find_compatible_parts. */
const filterFields = {
  category: z.string().optional()
    .describe('Exact Rebrickable part category name, case-insensitive, such as "Bricks", "Plates", or "Bricks Sloped".'),
  width: range.optional()
    .describe(`Width in studs: one integer or an inclusive [min, max] range. ${SIZE_FRAME} Width and depth match in either orientation.`),
  depth: range.optional()
    .describe(`Depth in studs: one integer or an inclusive [min, max] range. ${SIZE_FRAME}`),
  height: range.optional()
    .describe('Height in plates (a brick is 3 plates, studs excluded): one integer or an inclusive [min, max] range.'),
  color: int.optional().describe(colorText),
  colorFamily: z.string().optional().describe(`${familyText} Keeps parts known in a color of that family.`),
  traits: z.array(z.enum(TRAITS)).optional()
    .describe('Traits the part must all have, from a closed vocabulary derived from part names, categories, and connections.'),
  slopeAngle: z.number().optional().describe('Slope angle in degrees, such as 45 or 33, read from the part name.'),
  minSetCount: int.optional().describe('Minimum number of distinct sets the part appears in.'),
  nameContains: z.string().optional().describe('Case-insensitive substring of the part name.'),
  includeIncomplete: z.boolean().optional()
    .describe('Include parts without complete geometry or connection data (default false).'),
  includePrints: z.boolean().optional().describe('Include printed and patterned variants (default false).'),
  includeNonSystem: z.boolean().optional()
    .describe('Include parts from non-System lines such as Duplo, Modulex, and Fabuland (default false).'),
};

const DEFAULTS =
  'Incomplete parts, printed variants, and non-System parts (such as Duplo) are excluded by default, and common parts come first.';

const version = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }
).version;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Builds the MCP server exposing the parts lookups over the database in dataDir. */
export function createServer(dataDir: string): McpServer {
  const current = new CurrentDb(dataDir);
  const { state: statePath, lock: lockPath } = dataPaths(dataDir);
  const server = new McpServer({ name: 'brick-art-parts', version });
  server.server.onclose = () => current.close();

  const notReady = (): ToolResult => {
    const state = readState(statePath);
    return fail(
      `Parts database is not ready (${state.status}). ${state.lastError ?? 'Seeding runs in the background; try again in a few minutes.'}`,
    );
  };

  /** Wraps a lookup: not-ready and thrown errors become isError results. */
  const withDb =
    <A>(run: (db: NonNullable<ReturnType<CurrentDb['get']>>, args: A) => unknown) =>
    (args: A): ToolResult => {
      try {
        const db = current.get();
        if (db === null) return notReady();
        return ok(run(db, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  server.registerTool(
    'search_parts',
    {
      description: `Returns parts matching size, category, color, trait, and name filters. ${DEFAULTS}`,
      inputSchema: { ...filterFields, limit },
    },
    withDb((db, args) => searchParts(db, args)),
  );

  server.registerTool(
    'get_part',
    {
      description: 'Returns full detail for one part: size, geometry, connections, traits, and colors.',
      inputSchema: { partNum: z.string().describe(partNumText) },
    },
    withDb((db, args: { partNum: string }) => getPart(db, args.partNum)),
  );

  server.registerTool(
    'find_by_use',
    {
      description: `Returns parts that can represent a thing, such as a tree or a window; unreviewed uses are labeled "suggestion". ${DEFAULTS}`,
      inputSchema: {
        represents: z.string()
          .describe('The thing to represent, matched as a case-insensitive substring, such as "tree" or "window".'),
        ...filterFields,
        limit,
      },
    },
    withDb((db, args) => findByUse(db, args)),
  );

  server.registerTool(
    'find_compatible_parts',
    {
      description: `Returns parts with a connection that mates with a connection type or with a given part's connections; give connectionType or partNum. ${DEFAULTS}`,
      inputSchema: {
        connectionType: z.enum(CONNECTION_TYPES).optional()
          .describe('Connection type to mate with, such as "stud" or "bar"; give this or partNum.'),
        partNum: z.string().optional()
          .describe(`${partNumText} Finds parts that mate with its connections; give this or connectionType.`),
        connectionIndex: int.min(0).optional()
          .describe("Zero-based index into the part's connections as get_part lists them; omit to use all of them."),
        ...filterFields,
        limit,
      },
    },
    withDb((db, args) => findCompatible(db, args)),
  );

  server.registerTool(
    'find_substitutes',
    {
      description: `Returns alternates or shorter-part combinations for a part in a color it does not come in; returns nothing when the part exists in that color. ${DEFAULTS}`,
      inputSchema: {
        partNum: z.string().describe(partNumText),
        color: int.describe('Rebrickable color id wanted (look ids up with list_colors).'),
        limit,
      },
    },
    withDb((db, args) => findSubstitutes(db, args)),
  );

  server.registerTool(
    'list_colors',
    {
      description: 'Returns real colors (placeholders excluded), optionally for one color family or the colors one part comes in.',
      inputSchema: {
        family: z.string().optional().describe(familyText),
        partNum: z.string().optional().describe(`${partNumText} Lists only the colors this part comes in.`),
      },
    },
    withDb((db, args) => listColors(db, args)),
  );

  const CREDIT = 'Every result carries its author, license, and URL; credit them when you use the model.';

  server.registerTool(
    'search_projects',
    {
      description: `Returns existing projects (official LEGO sets and fan models) matching name, theme, year, kind, size, and part filters; projects with build positions come first. ${CREDIT}`,
      inputSchema: {
        nameContains: z.string().optional()
          .describe('Case-insensitive substring of the project name; an exact name match ranks first.'),
        theme: z.string().optional().describe('Theme or parent theme name, case-insensitive, such as "Town".'),
        year: range.optional().describe('Release year: one integer or an inclusive [min, max] range.'),
        kind: z.enum(['official', 'fan']).optional().describe('"official" for LEGO sets, "fan" for fan models.'),
        partCount: range.optional().describe('Total part count: one integer or an inclusive [min, max] range.'),
        usesPart: z.string().optional().describe(`${partNumText} Keeps projects that contain this part.`),
        usesColor: int.optional()
          .describe('Rebrickable color id; keeps projects containing the part in that color, or any part in it when usesPart is omitted.'),
        hasPositions: z.boolean().optional()
          .describe('true keeps only projects with build positions; false keeps only those without.'),
        limit,
      },
    },
    withDb((db, args) => searchProjects(db, args)),
  );

  server.registerTool(
    'get_project',
    {
      description: `Returns full detail for one project: parts with colors and quantities, and its submodels. ${CREDIT}`,
      inputSchema: { id: int.describe('Project id from search_projects.') },
    },
    (args: { id: number }): ToolResult => {
      try {
        const db = current.get();
        if (db === null) return notReady();
        const project = getProject(db, args.id);
        return project === null ? fail(`No project with id ${args.id}.`) : ok(project);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'database_status',
    {
      description: 'Returns the parts database state, seed time, source versions, row counts, and any warnings; works before seeding finishes.',
      inputSchema: {},
    },
    (): ToolResult => {
      try {
        return ok(databaseStatus(current.get(), readState(statePath), isLockHeld(lockPath)));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
