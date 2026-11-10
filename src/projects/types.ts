import type { Mat3, Vec3 } from '../types.ts';

export interface ModelLine { step: number; seq: number; color: number; pos: Vec3; matrix: Mat3; ref: string }
export interface ModelFile { name: string; author: string | null; license: string | null; lines: ModelLine[]; stepCount: number }
export interface ParsedModel { main: string; files: Map<string, ModelFile> } // keys normalized: lowercase, '/' separators, trimmed
export type Variant = 'fallback' | 'standard' | 'full';
