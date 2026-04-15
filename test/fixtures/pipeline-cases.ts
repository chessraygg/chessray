import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { LabelStrip } from '@chessray/core';

export interface PipelineTestCase {
  /** Screenshot filename in test/screenshots/ */
  file: string;
  /** Board orientation: 'white bottom' (normal) or 'white top' (flipped) */
  orientation: 'white bottom' | 'white top';
  /** Highlighted squares in correct chess notation (e.g. ['c1', 'f4']). Null for starting positions with no highlights. */
  highlighted: [string, string] | null;
  /** Whose turn it is after this move. Null if turn can't be determined from highlights (starting positions). */
  turn: 'w' | 'b' | null;
  /** Expected refined board bounding box (pixel coordinates) */
  bbox: { x: number; y: number; width: number; height: number };
  /** Expected grid square size in pixels (bbox.width / 8) */
  squareSize: number;
  /** Expected FEN (position only, raw image orientation before flip) */
  expectedFen: string;
  /** How board orientation was detected */
  orientation_source: 'label' | 'pawn_move' | 'piece_count';
  /** Expected label detection result */
  expected_labels: { skipped: true; reason: 'piece_count' | 'cached' } | { skipped: false; result: LabelStrip[] | null };
  /** Expected highlight candidates above threshold, sorted by score descending */
  expected_candidates: Array<{ square: string; score: number }>;
}

const yamlPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'pipeline-cases.yaml');
export const PIPELINE_CASES: PipelineTestCase[] = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as PipelineTestCase[];
