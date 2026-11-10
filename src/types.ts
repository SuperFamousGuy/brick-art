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
