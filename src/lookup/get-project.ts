import type { DatabaseSync } from 'node:sqlite';
import { FALLBACK_NOTE, NO_OMR_NOTE, isFallback, toSummary } from './search-projects.ts';
import type { ProjectSummary, Row } from './search-projects.ts';

export interface ProjectDetail extends Omit<ProjectSummary, 'submodels'> {
  baseProjectId: number | null;
  parts: {
    partNum: string; name: string | null; colorId: number; colorName: string | null;
    quantity: number; isSpare: boolean; fromMinifig: boolean;
  }[];
  submodels: { id: number; name: string; isMain: boolean; stepCount: number | null; partCount: number | null }[];
  note: string | null;
}

/** Full detail for one project, or null when unknown. */
export function getProject(db: DatabaseSync, id: number): ProjectDetail | null {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
  if (!p) return null;
  const { submodels: _unused, ...summary } = toSummary(p, []);
  const parts = db
    .prepare(
      `SELECT pp.part_num, pt.name AS part_name, pp.color_id, c.name AS color_name,
              pp.quantity, pp.is_spare, pp.from_minifig
       FROM project_parts pp
       LEFT JOIN parts pt ON pt.part_num = pp.part_num
       LEFT JOIN colors c ON c.id = pp.color_id
       WHERE pp.project_id = ?
       ORDER BY pp.is_spare, pp.from_minifig, pp.part_num, pp.color_id`,
    )
    .all(id) as Row[];
  const submodels = db
    .prepare('SELECT * FROM submodels WHERE project_id = ? ORDER BY is_main DESC, id')
    .all(id) as Row[];
  return {
    ...summary,
    baseProjectId: p.base_project_id,
    parts: parts.map((r) => ({
      partNum: r.part_num, name: r.part_name, colorId: r.color_id, colorName: r.color_name,
      quantity: r.quantity, isSpare: r.is_spare === 1, fromMinifig: r.from_minifig === 1,
    })),
    submodels: submodels.map((r) => ({
      id: r.id, name: r.name, isMain: r.is_main === 1, stepCount: r.step_count, partCount: r.part_count,
    })),
    note: p.has_positions === 1 ? null : isFallback(db) ? FALLBACK_NOTE : NO_OMR_NOTE,
  };
}
