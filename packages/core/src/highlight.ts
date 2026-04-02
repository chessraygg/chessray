import type { PixelBuffer } from './pixel-utils.js';

export interface HighlightResult {
  highlighted: number[];
  patches: Array<[number, number, number, number]>;
}

export function detectHighlightedSquares(pixels: PixelBuffer): HighlightResult {
  const { data, width, height } = pixels;
  const sqW = width / 8;
  const sqH = height / 8;
  const pw = Math.max(2, Math.floor(sqW * 0.1));
  const ph = Math.max(2, Math.floor(sqH * 0.1));

  function samplePatch(px0: number, py0: number): [number, number, number] {
    let r = 0, g = 0, b = 0, n = 0;
    for (let py = py0; py < py0 + ph; py++) {
      for (let px = px0; px < px0 + pw; px++) {
        const cx = Math.min(Math.max(px, 0), width - 1);
        const cy = Math.min(Math.max(py, 0), height - 1);
        const i = (cy * width + cx) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  }

  // Inset from square edges to avoid grid lines, anti-aliasing, and coordinate labels.
  // Use larger inset for big squares (annotations are further from corners) and
  // smaller inset for small squares (to avoid hitting piece graphics).
  const insetPct = sqW > 100 ? 0.15 : 0.08;
  const insetX = Math.max(2, Math.floor(sqW * insetPct));
  const insetY = Math.max(2, Math.floor(sqH * insetPct));

  const colors: Array<[number, number, number]> = [];
  const patches: Array<[number, number, number, number]> = [];

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const x0 = Math.floor(file * sqW);
      const y0 = Math.floor(rank * sqH);

      // Use top-left inset patch as the representative color for median computation
      patches.push([x0 + insetX, y0 + insetY, pw, ph]);
      colors.push(samplePatch(x0 + insetX, y0 + insetY));
    }
  }

  // Median per parity (exclude edge ranks/files for robustness)
  const lightIndices: number[] = [];
  const darkIndices: number[] = [];
  for (let i = 0; i < 64; i++) {
    const rank = Math.floor(i / 8);
    const file = i % 8;
    if (rank === 0 || rank === 7 || file === 0 || file === 7) continue;
    if ((rank + file) % 2 === 0) lightIndices.push(i);
    else darkIndices.push(i);
  }

  function medianColor(indices: number[]): [number, number, number] {
    const rs = indices.map(i => colors[i][0]).sort((a, b) => a - b);
    const gs = indices.map(i => colors[i][1]).sort((a, b) => a - b);
    const bs = indices.map(i => colors[i][2]).sort((a, b) => a - b);
    const mid = Math.floor(indices.length / 2);
    return [rs[mid], gs[mid], bs[mid]];
  }

  const lightMedian = medianColor(lightIndices);
  const darkMedian = medianColor(darkIndices);

  // Scoring: Euclidean distance weighted by chromatic deviation.
  // Highlights shift the hue (non-uniform per-channel diff, high std),
  // while edge/boundary artifacts just shift brightness (uniform diff, low std).
  // Weighting by channel std separates them cleanly.
  function highlightScore(color: [number, number, number], expected: [number, number, number]): number {
    const dr = color[0] - expected[0];
    const dg = color[1] - expected[1];
    const db = color[2] - expected[2];
    const euclidean = Math.sqrt(dr * dr + dg * dg + db * db);
    const mean = (dr + dg + db) / 3;
    const channelStd = Math.sqrt(((dr - mean) ** 2 + (dg - mean) ** 2 + (db - mean) ** 2) / 3);
    return euclidean * (1 + channelStd / 10);
  }

  // For each square, compute highlight scores at 4 inset corners and take the
  // MINIMUM. Move highlights cover the entire square (all 4 corners show the
  // highlight color → min is high), while annotations only affect 1-2 corners
  // (other corners show normal background → min is low).
  const scores: Array<{ idx: number; dist: number }> = [];
  for (let i = 0; i < 64; i++) {
    const rank = Math.floor(i / 8);
    const file = i % 8;
    const expected = (rank + file) % 2 === 0 ? lightMedian : darkMedian;

    const sqX0 = Math.floor(file * sqW);
    const sqY0 = Math.floor(rank * sqH);
    const sqX1 = Math.floor((file + 1) * sqW);
    const sqY1 = Math.floor((rank + 1) * sqH);

    const cornerPatches: Array<[number, number]> = [
      [sqX0 + insetX, sqY0 + insetY],
      [sqX1 - insetX - pw, sqY0 + insetY],
      [sqX0 + insetX, sqY1 - insetY - ph],
      [sqX1 - insetX - pw, sqY1 - insetY - ph],
    ];

    const cornerScores: number[] = [];
    for (const [cx, cy] of cornerPatches) {
      const c = samplePatch(cx, cy);
      cornerScores.push(highlightScore(c, expected));
    }
    // Use the minimum score across corners. Highlights cover the entire square
    // (all corners show highlight color → min is high), while annotations only
    // affect 1-2 corners (other corners normal → min is low).
    scores.push({ idx: i, dist: Math.min(...cornerScores) });
  }
  scores.sort((a, b) => b.dist - a.dist);

  // Dynamic thresholding using gap analysis.
  // Real highlights produce a few high-scoring squares with a clear drop-off.
  // Non-standard board themes (blue/ice) produce uniformly high scores with no clear gap.

  const minAbsolute = 18;
  if (scores[0].dist < minAbsolute) return { highlighted: [], patches };

  // Find the biggest gap in the top 8 scores, starting from index 2
  // (highlights always come in pairs — source and destination).
  let maxGap = 0;
  let cutIdx = 2;
  const limit = Math.min(8, scores.length);
  for (let i = 2; i < limit; i++) {
    const gap = scores[i - 1].dist - scores[i].dist;
    if (gap > maxGap) {
      maxGap = gap;
      cutIdx = i;
    }
  }

  // The gap must be significant relative to the top score.
  // Real highlights: gap is 50%+ of top score (e.g., 300→15 = gap 285).
  // No highlights: gap is tiny relative to top score (e.g., 50→48 = gap 2).
  if (maxGap < scores[0].dist * 0.3) return { highlighted: [], patches };

  const aboveThreshold = scores.slice(0, cutIdx).map(s => s.idx);
  return { highlighted: aboveThreshold, patches };
}

/**
 * Check if a piece could legally move from (fromRank, fromFile) to (toRank, toFile).
 * Basic geometric check — does not verify path obstruction or board state.
 */
function isLegalPieceMove(piece: string, fromRank: number, fromFile: number, toRank: number, toFile: number): boolean {
  const dr = Math.abs(toRank - fromRank);
  const df = Math.abs(toFile - fromFile);
  switch (piece.toLowerCase()) {
    case 'r': return dr === 0 || df === 0;
    case 'b': return dr === df && dr > 0;
    case 'q': return dr === 0 || df === 0 || (dr === df && dr > 0);
    case 'n': return (dr === 1 && df === 2) || (dr === 2 && df === 1);
    case 'k': return dr <= 1 && df <= 1 && (dr + df > 0);
    case 'p': return df <= 1 && dr >= 1 && dr <= 2;
    default: return false;
  }
}

/**
 * Disambiguate highlighted squares when more than 2 are detected.
 *
 * Strategy:
 * 1. If exactly 1 candidate has a piece on it, that's the move destination.
 *    Then find the source among remaining candidates by checking legal piece movement.
 * 2. Otherwise, fall back to the top 2 by detection score (first 2 in the array).
 *
 * @param candidates Raw indices sorted by detection score (descending)
 * @param fen Position-only FEN (raw image orientation)
 * @returns Exactly 2 indices [source, destination] or fewer if not enough candidates
 */
export function disambiguateHighlights(candidates: number[], fen: string): number[] {
  if (candidates.length <= 2) return candidates;

  const rows = fen.split('/');
  const board: (string | null)[] = new Array(64).fill(null);
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') file += parseInt(ch);
      else { board[rank * 8 + file] = ch; file++; }
    }
  }

  // Find candidates that have a piece vs empty
  const withPiece = candidates.filter(idx => board[idx] !== null);
  const empty = candidates.filter(idx => board[idx] === null);

  // Try to find a valid (empty_source, piece_destination) pair.
  // The source must be empty (the piece left it) and the destination has the piece.
  const validPairs: Array<{ src: number; dest: number; scoreRank: number }> = [];
  const piecesToCheck = withPiece.length === 1 ? withPiece : withPiece;

  for (const dest of piecesToCheck) {
    const piece = board[dest]!;
    const destRank = Math.floor(dest / 8);
    const destFile = dest % 8;

    for (const src of empty) {
      const srcRank = Math.floor(src / 8);
      const srcFile = src % 8;
      if (isLegalPieceMove(piece, srcRank, srcFile, destRank, destFile)) {
        // scoreRank: sum of position indices in the candidates array (lower = higher score)
        const srcPos = candidates.indexOf(src);
        const destPos = candidates.indexOf(dest);
        validPairs.push({ src, dest, scoreRank: srcPos + destPos });
      }
    }
  }

  if (validPairs.length > 0) {
    // Pick the pair with the best combined detection score (lowest scoreRank)
    validPairs.sort((a, b) => a.scoreRank - b.scoreRank);
    return [validPairs[0].src, validPairs[0].dest];
  }

  // Fallback: pick top 2 by score
  return candidates.slice(0, 2);
}

/**
 * Determine whose turn it is from highlighted squares and piece positions.
 */
export function turnFromHighlight(
  highlightedIndices: number[],
  fen: string
): 'w' | 'b' | null {
  if (highlightedIndices.length < 1) return null;

  const rows = fen.split('/');
  const board: (string | null)[] = new Array(64).fill(null);
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') { file += parseInt(ch); }
      else { board[rank * 8 + file] = ch; file++; }
    }
  }

  for (const idx of highlightedIndices) {
    const piece = board[idx];
    if (piece) {
      return piece === piece.toUpperCase() ? 'b' : 'w';
    }
  }

  return null;
}
