import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { LabelStrip, Turn, OrientationSource, LabelsSkipReason } from '@chessray/core';

export interface PipelineTestCase {
  /** Screenshot filename in test/screenshots/ */
  file: string;
  /** Board orientation: 'white bottom' (normal) or 'white top' (flipped) */
  orientation: 'white bottom' | 'white top';
  /** Highlighted squares in correct chess notation (e.g. ['c1', 'f4']). Null for starting positions with no highlights. */
  highlighted: [string, string] | null;
  /** Whose turn it is after this move. Null if turn can't be determined from highlights (starting positions). */
  turn: Turn | null;
  /** Expected refined board bounding box (pixel coordinates) */
  bbox: { x: number; y: number; width: number; height: number };
  /** Expected grid square size in pixels (bbox.width / 8) */
  squareSize: number;
  /** Expected FEN (position only, raw image orientation before flip) */
  expectedFen: string;
  /** How board orientation was detected */
  orientation_source: OrientationSource;
  /** Expected label detection result */
  expected_labels: { skipped: true; reason: LabelsSkipReason } | { skipped: false; result: LabelStrip[] | null };
  /** Expected highlight candidates above threshold, sorted by score descending */
  expected_candidates: Array<{ square: string; score: number }>;
  /** Expected median RGB color of the board's light and dark squares (sampled from inner 6x6) */
  expected_square_colors?: { light: [number, number, number]; dark: [number, number, number] };
}

const REQUIRED_FIELDS: Array<keyof PipelineTestCase> = [
  'file', 'orientation', 'highlighted', 'turn', 'bbox', 'squareSize',
  'expectedFen', 'orientation_source', 'expected_labels', 'expected_candidates',
];

const VALID_ORIENTATIONS = ['white bottom', 'white top'];
const VALID_TURNS = ['w', 'b', null];
const VALID_ORIENTATION_SOURCES = ['label', 'pawn_move', 'piece_count'];
const VALID_LABEL_REASONS = ['piece_count', 'cached'];
const SQUARE_RE = /^[a-h][1-8]$/;

function validateCase(tc: any, index: number): PipelineTestCase {
  const prefix = `pipeline-cases.yaml[${index}] (${tc?.file ?? 'unknown'})`;

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in tc)) throw new Error(`${prefix}: missing required field '${field}'`);
  }

  // file
  if (typeof tc.file !== 'string' || !tc.file.endsWith('.png'))
    throw new Error(`${prefix}: file must be a .png string`);

  // orientation
  if (!VALID_ORIENTATIONS.includes(tc.orientation))
    throw new Error(`${prefix}: orientation must be one of ${VALID_ORIENTATIONS.join(', ')}, got '${tc.orientation}'`);

  // highlighted
  if (tc.highlighted !== null) {
    if (!Array.isArray(tc.highlighted) || tc.highlighted.length !== 2 ||
        !tc.highlighted.every((s: any) => typeof s === 'string' && SQUARE_RE.test(s)))
      throw new Error(`${prefix}: highlighted must be null or [square, square]`);
  }

  // turn
  if (!VALID_TURNS.includes(tc.turn))
    throw new Error(`${prefix}: turn must be 'w', 'b', or null`);

  // bbox
  if (typeof tc.bbox !== 'object' || ['x', 'y', 'width', 'height'].some(k => typeof tc.bbox[k] !== 'number'))
    throw new Error(`${prefix}: bbox must have numeric x, y, width, height`);

  // squareSize
  if (typeof tc.squareSize !== 'number')
    throw new Error(`${prefix}: squareSize must be a number`);

  // expectedFen
  if (typeof tc.expectedFen !== 'string' || tc.expectedFen.split('/').length !== 8)
    throw new Error(`${prefix}: expectedFen must be a valid position FEN with 8 ranks`);

  // orientation_source
  if (!VALID_ORIENTATION_SOURCES.includes(tc.orientation_source))
    throw new Error(`${prefix}: orientation_source must be one of ${VALID_ORIENTATION_SOURCES.join(', ')}`);

  // expected_labels
  if (typeof tc.expected_labels !== 'object')
    throw new Error(`${prefix}: expected_labels must be an object`);
  if (tc.expected_labels.skipped === true) {
    if (!VALID_LABEL_REASONS.includes(tc.expected_labels.reason))
      throw new Error(`${prefix}: expected_labels.reason must be one of ${VALID_LABEL_REASONS.join(', ')}`);
  } else if (tc.expected_labels.skipped === false) {
    if (!('result' in tc.expected_labels))
      throw new Error(`${prefix}: expected_labels with skipped=false must have result`);
  } else {
    throw new Error(`${prefix}: expected_labels.skipped must be true or false`);
  }

  // expected_candidates
  if (!Array.isArray(tc.expected_candidates))
    throw new Error(`${prefix}: expected_candidates must be an array`);
  for (const c of tc.expected_candidates) {
    if (typeof c.square !== 'string' || !SQUARE_RE.test(c.square))
      throw new Error(`${prefix}: candidate square must be a valid chess square, got '${c.square}'`);
    if (typeof c.score !== 'number')
      throw new Error(`${prefix}: candidate score must be a number`);
  }

  // expected_square_colors (optional)
  if (tc.expected_square_colors !== undefined) {
    const sc = tc.expected_square_colors;
    if (typeof sc !== 'object' || !sc.light || !sc.dark)
      throw new Error(`${prefix}: expected_square_colors must have 'light' and 'dark'`);
    for (const key of ['light', 'dark'] as const) {
      const v = sc[key];
      if (!Array.isArray(v) || v.length !== 3 || !v.every((n: any) => typeof n === 'number' && n >= 0 && n <= 255))
        throw new Error(`${prefix}: expected_square_colors.${key} must be a [r,g,b] tuple of 0-255 integers`);
    }
  }

  return tc as PipelineTestCase;
}

const yamlPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'pipeline-cases.yaml');
const rawCases = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as any[];
export const PIPELINE_CASES: PipelineTestCase[] = rawCases.map((tc, i) => validateCase(tc, i));
