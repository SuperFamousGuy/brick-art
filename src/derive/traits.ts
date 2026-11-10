import type { ConnectionPoint } from '../types.ts';

export interface TraitInput {
  name: string;
  categoryName: string;
  connections: ConnectionPoint[];
  colorsTrans: boolean[];
}
export interface Traits {
  traits: string[];
  slopeAngle: number | null;
  basicKind: 'brick' | 'plate' | 'tile' | null;
}

/** Derive searchable traits from a part's name, category, connections, and available colors. */
export function deriveTraits(input: TraitInput): Traits {
  const { name, categoryName, connections, colorsTrans } = input;
  const traits = new Set<string>();

  if (categoryName === 'Bricks Sloped' || /\bSlope\b/.test(name)) traits.add('slope');
  if (/Inverted/.test(name)) traits.add('inverted');
  if (/Curved/.test(name)) traits.add('curved');
  if (/Round|Dish|Cone|Cylinder/.test(name)) traits.add('round');
  if (/Wedge/.test(name)) traits.add('wedge');
  if (categoryName.startsWith('Tiles') || name.startsWith('Tile')) traits.add('tile');
  if (name.includes('Hinge') || connections.some((c) => c.type === 'hinge_m' || c.type === 'hinge_f')) {
    traits.add('hinge');
  }
  if (colorsTrans.some(Boolean)) traits.add('transparent-capable');
  if (connections.some((c) => c.type === 'stud' && Math.abs(c.direction[1]) < 0.5)) {
    traits.add('side-stud');
  }

  const angle = /Slope\s+(\d+)/.exec(name);
  const kind = /^(Brick|Plate|Tile) \d+ x \d+$/.exec(name);
  return {
    traits: [...traits].sort(),
    slopeAngle: angle ? Number(angle[1]) : null,
    basicKind: kind ? (kind[1]!.toLowerCase() as 'brick' | 'plate' | 'tile') : null,
  };
}
