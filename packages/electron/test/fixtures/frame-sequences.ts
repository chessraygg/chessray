import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { Turn, OrientationSource } from '@chessray/core';

export interface FrameExpected {
  /** Recognized corrected FEN (position-only, no side-to-move) */
  fen: string;
  /** Highlighted squares in chess notation, or null for starting positions */
  highlighted: [string, string] | null;
  turn: Turn | null;
  flipped: boolean;
  orientation_source: OrientationSource | null;
  /** Detection status string, or null */
  detection_status: string | null;
  /** Played move inferred from prior frame's eval + current FEN. Null when unknown. */
  played_move: { from: string; to: string; uci: string } | null;
}

export interface FrameEntry {
  file: string;
  expected: FrameExpected;
}

export interface FrameSequenceCase {
  name: string;
  changeDetect?: boolean;
  frames: FrameEntry[];
}

const SQUARE_RE = /^[a-h][1-8]$/;
const VALID_TURNS = new Set(['w', 'b', null]);
const VALID_SOURCES = new Set(['label', 'pawn_move', 'piece_count', null]);

function validateFrame(entry: any, seqName: string, i: number): FrameEntry {
  const prefix = `frame-sequences.yaml[${seqName}].frames[${i}]`;
  if (typeof entry?.file !== 'string' || !entry.file.endsWith('.png'))
    throw new Error(`${prefix}: file must be a .png string`);
  const exp = entry.expected;
  if (typeof exp !== 'object') throw new Error(`${prefix}: expected must be an object`);
  if (typeof exp.fen !== 'string' || exp.fen.split('/').length !== 8)
    throw new Error(`${prefix}: expected.fen must be an 8-rank position FEN`);
  if (exp.highlighted !== null) {
    if (!Array.isArray(exp.highlighted) || exp.highlighted.length !== 2 ||
        !exp.highlighted.every((s: any) => typeof s === 'string' && SQUARE_RE.test(s)))
      throw new Error(`${prefix}: expected.highlighted must be null or [square, square]`);
  }
  if (!VALID_TURNS.has(exp.turn ?? null))
    throw new Error(`${prefix}: expected.turn must be 'w', 'b', or null`);
  if (typeof exp.flipped !== 'boolean')
    throw new Error(`${prefix}: expected.flipped must be a boolean`);
  if (!VALID_SOURCES.has(exp.orientation_source ?? null))
    throw new Error(`${prefix}: expected.orientation_source must be one of label/pawn_move/piece_count or null`);
  if (exp.detection_status !== null && typeof exp.detection_status !== 'string')
    throw new Error(`${prefix}: expected.detection_status must be null or a string`);
  if (exp.played_move !== null) {
    const pm = exp.played_move;
    if (typeof pm !== 'object' ||
        typeof pm.from !== 'string' || !SQUARE_RE.test(pm.from) ||
        typeof pm.to !== 'string' || !SQUARE_RE.test(pm.to) ||
        typeof pm.uci !== 'string')
      throw new Error(`${prefix}: expected.played_move must be null or {from, to, uci}`);
  }
  return entry as FrameEntry;
}

function validateSequence(seq: any, index: number): FrameSequenceCase {
  const name = seq?.name;
  if (typeof name !== 'string' || !name.length)
    throw new Error(`frame-sequences.yaml[${index}]: name must be a non-empty string`);
  if (!Array.isArray(seq.frames) || seq.frames.length === 0)
    throw new Error(`frame-sequences.yaml[${name}]: frames must be a non-empty array`);
  const frames = seq.frames.map((f: any, i: number) => validateFrame(f, name, i));
  const changeDetect = seq.changeDetect;
  if (changeDetect !== undefined && typeof changeDetect !== 'boolean')
    throw new Error(`frame-sequences.yaml[${name}]: changeDetect must be a boolean if present`);
  return { name, changeDetect, frames };
}

const yamlPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'frame-sequences.yaml');
const raw = (yaml.load(fs.readFileSync(yamlPath, 'utf8')) ?? []) as any[];

export const FRAME_SEQUENCE_CASES: FrameSequenceCase[] = raw.map((s, i) => validateSequence(s, i));
