import type { RebrickableData } from '../sources/rebrickable.ts';

export interface ProjectRow {
  id: number;
  source: string;
  sourceKey: string;
  kind: 'official' | 'fan';
  name: string;
  year: number | null;
  theme: string | null;
  parentTheme: string | null;
  partCount: number;
  author: string | null;
  license: string | null;
  url: string | null;
  hasPositions: boolean;
  baseProjectId: number | null;
}

export interface ProjectPartRow {
  projectId: number;
  partNum: string;
  colorId: number;
  quantity: number;
  isSpare: boolean;
  fromMinifig: boolean;
}

/** Builds one official project per Rebrickable set, using each set's highest-version inventory. */
export function buildSetProjects(
  rb: RebrickableData,
  firstId: number,
): { projects: ProjectRow[]; parts: ProjectPartRow[] } {
  // Highest-version inventory ID per set or minifig number.
  const latest = new Map<string, number>();
  for (const [invId, setNum] of rb.inventories) {
    const cur = latest.get(setNum);
    const version = rb.inventoryVersions.get(invId) ?? 1;
    if (cur === undefined || version > (rb.inventoryVersions.get(cur) ?? 1)) latest.set(setNum, invId);
  }

  const partsByInv = new Map<number, typeof rb.inventoryParts>();
  for (const row of rb.inventoryParts) {
    let list = partsByInv.get(row.inventoryId);
    if (!list) partsByInv.set(row.inventoryId, (list = []));
    list.push(row);
  }
  const minifigsByInv = new Map<number, typeof rb.inventoryMinifigs>();
  for (const row of rb.inventoryMinifigs) {
    let list = minifigsByInv.get(row.inventoryId);
    if (!list) minifigsByInv.set(row.inventoryId, (list = []));
    list.push(row);
  }

  const projects: ProjectRow[] = [];
  const parts: ProjectPartRow[] = [];
  let id = firstId;
  for (const [setNum, set] of rb.sets) {
    if (setNum.startsWith('fig-')) continue;
    const projectId = id++;
    const sums = new Map<string, ProjectPartRow>();
    const add = (partNum: string, colorId: number, isSpare: boolean, fromMinifig: boolean, qty: number) => {
      const key = `${partNum}\t${colorId}\t${isSpare}\t${fromMinifig}`;
      const existing = sums.get(key);
      if (existing) existing.quantity += qty;
      else sums.set(key, { projectId, partNum, colorId, quantity: qty, isSpare, fromMinifig });
    };

    const invId = latest.get(setNum);
    if (invId !== undefined) {
      for (const p of partsByInv.get(invId) ?? []) add(p.partNum, p.colorId, p.isSpare, false, p.quantity);
      for (const m of minifigsByInv.get(invId) ?? []) {
        const figInv = latest.get(m.figNum);
        if (figInv === undefined) continue;
        for (const p of partsByInv.get(figInv) ?? []) {
          add(p.partNum, p.colorId, p.isSpare, true, p.quantity * m.quantity);
        }
      }
    }

    const rows = [...sums.values()];
    parts.push(...rows);
    const theme = rb.themes.get(set.themeId);
    const parent = theme?.parentId == null ? undefined : rb.themes.get(theme.parentId);
    projects.push({
      id: projectId,
      source: 'rebrickable',
      sourceKey: setNum,
      kind: 'official',
      name: set.name,
      year: set.year,
      theme: theme?.name ?? null,
      parentTheme: parent?.name ?? null,
      partCount: rows.reduce((n, r) => (r.isSpare ? n : n + r.quantity), 0),
      author: null,
      license: null,
      url: `https://rebrickable.com/sets/${setNum}/`,
      hasPositions: false,
      baseProjectId: null,
    });
  }
  return { projects, parts };
}
