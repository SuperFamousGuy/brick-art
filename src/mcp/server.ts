import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CurrentDb } from '../db/open.ts';
import { readState } from '../seed/lock.ts';
import { dataPaths } from '../paths.ts';
import { searchParts } from '../lookup/search-parts.ts';
import { getPart } from '../lookup/get-part.ts';
import { listColors } from '../lookup/list-colors.ts';
import { databaseStatus } from '../lookup/status.ts';
import { findByUse } from '../lookup/find-by-use.ts';
import { findCompatible } from '../lookup/find-compatible.ts';
import { findSubstitutes } from '../lookup/find-substitutes.ts';
import type { ConnectionType } from '../types.ts';

const CONNECTION_TYPES = [
  'stud', 'stud_receptor', 'bar', 'bar_holder', 'clip', 'pin', 'pin_hole',
  'axle', 'axle_hole', 'ball', 'socket', 'hinge_m', 'hinge_f', 'other',
] as const satisfies readonly ConnectionType[];

const int = z.number().int();
const range = z.union([int, z.tuple([int, int])]);
const limit = int.min(1).max(200).optional();

const DEFAULTS = 'Incomplete parts and printed variants are excluded by default, and common parts come first.';

const version = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }
).version;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Builds the MCP server exposing the parts lookups over the database in dataDir. */
export function createServer(dataDir: string): McpServer {
  const current = new CurrentDb(dataDir);
  const statePath = dataPaths(dataDir).state;
  const server = new McpServer({ name: 'brick-art-parts', version });
  server.server.onclose = () => current.close();

  /** Wraps a lookup: not-ready and thrown errors become isError results. */
  const withDb =
    <A>(run: (db: NonNullable<ReturnType<CurrentDb['get']>>, args: A) => unknown) =>
    (args: A): ToolResult => {
      try {
        const db = current.get();
        if (db === null) {
          const state = readState(statePath);
          return fail(
            `Parts database is not ready (${state.status}). ${state.lastError ?? 'Seeding runs in the background; try again in a few minutes.'}`,
          );
        }
        return ok(run(db, args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  server.registerTool(
    'search_parts',
    {
      description: `Returns parts matching size, category, color, trait, and name filters. ${DEFAULTS}`,
      inputSchema: {
        category: z.string().optional(),
        width: range.optional(),
        depth: range.optional(),
        height: range.optional(),
        color: int.optional(),
        colorFamily: z.string().optional(),
        traits: z.array(z.string()).optional(),
        slopeAngle: z.number().optional(),
        minSetCount: int.optional(),
        nameContains: z.string().optional(),
        includeIncomplete: z.boolean().optional(),
        includePrints: z.boolean().optional(),
        limit,
      },
    },
    withDb((db, args) => searchParts(db, args)),
  );

  server.registerTool(
    'get_part',
    {
      description: 'Returns full detail for one part: size, geometry, connections, traits, and colors.',
      inputSchema: { partNum: z.string() },
    },
    withDb((db, args: { partNum: string }) => getPart(db, args.partNum)),
  );

  server.registerTool(
    'find_by_use',
    {
      description: `Returns parts that can represent a thing, such as a tree or a window; unreviewed uses are labeled "suggestion". ${DEFAULTS}`,
      inputSchema: { represents: z.string(), color: int.optional(), colorFamily: z.string().optional(), limit },
    },
    withDb((db, args) => findByUse(db, args)),
  );

  server.registerTool(
    'find_compatible_parts',
    {
      description: `Returns parts with a connection that mates with a connection type or with a given part's connections; give connectionType or partNum. ${DEFAULTS}`,
      inputSchema: {
        connectionType: z.enum(CONNECTION_TYPES).optional(),
        partNum: z.string().optional(),
        connectionIndex: int.min(0).optional(),
        color: int.optional(),
        limit,
      },
    },
    withDb((db, args) => findCompatible(db, args)),
  );

  server.registerTool(
    'find_substitutes',
    {
      description: `Returns alternates or shorter-part combinations for a part in a color it does not come in; returns nothing when the part exists in that color. ${DEFAULTS}`,
      inputSchema: { partNum: z.string(), color: int, limit },
    },
    withDb((db, args) => findSubstitutes(db, args)),
  );

  server.registerTool(
    'list_colors',
    {
      description: 'Returns real colors (placeholders excluded), optionally for one color family or the colors one part comes in.',
      inputSchema: { family: z.string().optional(), partNum: z.string().optional() },
    },
    withDb((db, args) => listColors(db, args)),
  );

  server.registerTool(
    'database_status',
    {
      description: 'Returns the parts database state, seed time, source versions, row counts, and any warnings; works before seeding finishes.',
      inputSchema: {},
    },
    (): ToolResult => {
      try {
        return ok(databaseStatus(current.get(), readState(statePath)));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
