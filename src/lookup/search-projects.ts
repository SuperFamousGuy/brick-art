import type { DatabaseSync } from 'node:sqlite';
import { clampLimit, escapeLike } from './common.ts';
import type { Range } from './common.ts';

export interface ProjectSummary {
  id: number;
  name: string;
  kind: 'official' | 'fan';
  sourceKey: string;
  year: number | null;
  theme: string | null;
  partCount: number | null;
  hasPositions: boolean;
  author: string | null;
  license: string | null;
  url: string | null;
  submodels: string[];
}

export interface ProjectFilter {
  nameContains?: string;
  /** Matches the theme or the parent theme, case-insensitively. */
  theme?: string;
  year?: Range;
  kind?: 'official' | 'fan';
  partCount?: Range;
  usesPart?: string;
  usesColor?: number;
  hasPositions?: boolean;
  limit?: number;
}

export const FALLBACK_NOTE = 'Build positions are not downloaded yet; they arrive with the next published release.';
export const NO_OMR_NOTE = 'This project has no positions in the LDraw model repository.';

export type Row = Record<string, any>;

const bounds = (r: Range): [number, number] => (typeof r === 'number' ? [r, r] : r);

export function isFallback(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT value FROM manifest WHERE key = 'variant'").get() as { value: string } | undefined;
  return row?.value === 'fallback';
}

export function toSummary(r: Row, submodels: string[]): ProjectSummary {
  return {
    id: r.id, name: r.name, kind: r.kind, sourceKey: r.source_key, year: r.year, theme: r.theme,
    partCount: r.part_count, hasPositions: r.has_positions === 1, author: r.author, license: r.license,
    url: r.url, submodels,
  };
}

/** Submodel names for a project, main first, then by id. */
export function submodelNames(db: DatabaseSync, projectId: number): string[] {
  return (db
    .prepare('SELECT name FROM submodels WHERE project_id = ? ORDER BY is_main DESC, id')
    .all(projectId) as Row[]).map((r) => r.name);
}

/** Finds projects (official sets and fan models), positioned ones first. */
export function searchProjects(
  db: DatabaseSync, f: ProjectFilter = {},
): { results: ProjectSummary[]; note: string | null } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (f.nameContains !== undefined && f.nameContains !== '') {
    where.push("LOWER(p.name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'");
    params.push(escapeLike(f.nameContains));
  }
  if (f.theme !== undefined) {
    where.push('(LOWER(p.theme) = LOWER(?) OR LOWER(p.parent_theme) = LOWER(?))');
    params.push(f.theme, f.theme);
  }
  if (f.year !== undefined) {
    where.push('p.year BETWEEN ? AND ?');
    params.push(...bounds(f.year));
  }
  if (f.kind !== undefined) {
    where.push('p.kind = ?');
    params.push(f.kind);
  }
  if (f.partCount !== undefined) {
    where.push('p.part_count BETWEEN ? AND ?');
    params.push(...bounds(f.partCount));
  }
  if (f.usesPart !== undefined || f.usesColor !== undefined) {
    const inner: string[] = ['pp.project_id = p.id'];
    if (f.usesPart !== undefined) {
      inner.push('pp.part_num = ?');
      params.push(f.usesPart);
    }
    if (f.usesColor !== undefined) {
      inner.push('pp.color_id = ?');
      params.push(f.usesColor);
    }
    where.push(`EXISTS (SELECT 1 FROM project_parts pp WHERE ${inner.join(' AND ')})`);
  }
  if (f.hasPositions !== undefined) {
    where.push('p.has_positions = ?');
    params.push(f.hasPositions ? 1 : 0);
  }

  const exact = f.nameContains !== undefined && f.nameContains !== '';
  const order = ['p.has_positions DESC'];
  if (exact) {
    order.push('(LOWER(p.name) = LOWER(?)) DESC');
    params.push(f.nameContains!);
  }
  order.push('p.year DESC', 'p.id ASC');

  const rows = db
    .prepare(
      `SELECT p.* FROM projects p ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${order.join(', ')} LIMIT ?`,
    )
    .all(...params, clampLimit(f.limit)) as Row[];

  return {
    results: rows.map((r) => toSummary(r, submodelNames(db, r.id))),
    note: isFallback(db) ? FALLBACK_NOTE : null,
  };
}
