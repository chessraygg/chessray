import type { PixelBuffer } from './pixel-utils.js';

export interface HighlightResult {
  highlighted: number[];
  scores?: Array<{ idx: number; dist: number }>;
  /** Per-square representative color (border frame median), indexed 0-63 */
  colors?: Array<[number, number, number]>;
  /** Median colors for light and dark squares */
  medians?: { light: [number, number, number]; dark: [number, number, number] };
}

export function detectHighlightedSquares(pixels: PixelBuffer): HighlightResult {
  const { data, width, height } = pixels;
  const sqW = width / 8;
  const sqH = height / 8;

  // Inset from square edges to avoid grid lines, anti-aliasing, and coordinate labels.
  const insetPct = sqW > 100 ? 0.15 : 0.08;
  const insetX = Math.max(2, Math.floor(sqW * insetPct));
  const insetY = Math.max(2, Math.floor(sqH * insetPct));

  const colors: Array<[number, number, number]> = [];

  // Per-channel median of pixels in the padding strip around each square.
  // The strip runs from a minimal edge inset (to skip grid lines) up to the
  // main inset boundary. This thin frame captures bare board background
  // without being contaminated by piece graphics in the center.
  const edgeInset = Math.max(2, Math.floor(Math.min(sqW, sqH) * 0.03));
  function squareFrameMedianColor(sqX0: number, sqY0: number, sqX1: number, sqY1: number): [number, number, number] {
    // Outer boundary: just past grid lines
    const x0 = sqX0 + edgeInset;
    const y0 = sqY0 + edgeInset;
    const x1 = sqX1 - edgeInset;
    const y1 = sqY1 - edgeInset;
    // Inner boundary: the existing inset (where piece area begins)
    const ix0 = sqX0 + insetX;
    const iy0 = sqY0 + insetY;
    const ix1 = sqX1 - insetX;
    const iy1 = sqY1 - insetY;
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        // Only include pixels in the padding strip (outside inner boundary)
        if (px >= ix0 && px < ix1 && py >= iy0 && py < iy1) continue;
        const cx = Math.min(Math.max(px, 0), width - 1);
        const cy = Math.min(Math.max(py, 0), height - 1);
        const i = (cy * width + cx) * 4;
        rs.push(data[i]);
        gs.push(data[i + 1]);
        bs.push(data[i + 2]);
      }
    }
    rs.sort((a, b) => a - b);
    gs.sort((a, b) => a - b);
    bs.sort((a, b) => a - b);
    const mid = Math.floor(rs.length / 2);
    return [rs[mid], gs[mid], bs[mid]];
  }

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sqX0 = Math.floor(file * sqW);
      const sqY0 = Math.floor(rank * sqH);
      const sqX1 = Math.floor((file + 1) * sqW);
      const sqY1 = Math.floor((rank + 1) * sqH);

      colors.push(squareFrameMedianColor(sqX0, sqY0, sqX1, sqY1));
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

  // Score each square by comparing its border frame median color to the
  // expected parity median. Highlights shift the background color uniformly;
  // the border frame median is robust to pieces and annotations.
  const scores: Array<{ idx: number; dist: number }> = [];
  for (let i = 0; i < 64; i++) {
    const rank = Math.floor(i / 8);
    const file = i % 8;
    const expected = (rank + file) % 2 === 0 ? lightMedian : darkMedian;
    scores.push({ idx: i, dist: highlightScore(colors[i], expected) });
  }
  scores.sort((a, b) => b.dist - a.dist);

  // Dynamic thresholding using gap analysis.
  // Real highlights produce a few high-scoring squares with a clear drop-off.
  // Non-standard board themes (blue/ice) produce uniformly high scores with no clear gap.

  const minAbsolute = 18;
  if (scores[0].dist < minAbsolute) return { highlighted: [], scores, colors, medians: { light: lightMedian, dark: darkMedian } };

  // Find the biggest gap in the top 8 scores.
  // Start from index 2 (highlights usually come in pairs) but also consider
  // index 1: one highlight may score much higher than the other (e.g. the
  // source square is empty while the destination has a piece absorbing the
  // highlight color). In that case, emit just the strong highlight and let
  // disambiguateHighlights search the score list for its partner.
  let maxGap = 0;
  let cutIdx = 2;
  const limit = Math.min(8, scores.length);
  // Consider the gap at index 1 (single strong highlight) only when the
  // top score is in plausible highlight range. Extreme outliers (500+)
  // are usually annotations/overlays, not real move highlights — for those
  // we want to look deeper into the score list, so start from index 2.
  const startIdx = scores[0].dist < 300 ? 1 : 2;
  for (let i = startIdx; i < limit; i++) {
    const gap = scores[i - 1].dist - scores[i].dist;
    if (gap > maxGap) {
      maxGap = gap;
      cutIdx = i;
    }
  }

  // The gap must be significant: either relative to the top score OR as a
  // large fraction of the score just above the gap. The relative-to-top check
  // fails when an outlier inflates the top score (e.g., a piece corner scores
  // 600+ while real highlights score ~200, giving a 30% threshold of 180+).
  const scoreAboveGap = scores[cutIdx - 1].dist;
  const gapIsSignificant = maxGap >= scores[0].dist * 0.3 ||
    maxGap >= scoreAboveGap * 0.35;
  if (!gapIsSignificant) return { highlighted: [], scores, colors, medians: { light: lightMedian, dark: darkMedian } };

  const primary = scores.slice(0, cutIdx).map(s => s.idx);

  // Include runner-up candidates that score well above the noise floor.
  // These enable disambiguateHighlights to find valid move pairs when the
  // top 2 don't form a legal move (e.g., false positive on a nearby square).
  const noiseFloor = scores[Math.min(7, scores.length - 1)].dist;
  const runnerUpThreshold = Math.max(minAbsolute * 3, noiseFloor * 10);
  let extendedCount = cutIdx;
  while (extendedCount < Math.min(6, scores.length) && scores[extendedCount].dist >= runnerUpThreshold) {
    extendedCount++;
  }
  const highlighted = scores.slice(0, extendedCount).map(s => s.idx);

  return { highlighted, scores, colors, medians: { light: lightMedian, dark: darkMedian } };
}

/**
 * Check if a piece could legally move from (fromRank, fromFile) to (toRank, toFile).
 * Basic geometric check — does not verify path obstruction or board state.
 */
/**
 * Check if a piece could legally move from (fromRank, fromFile) to (toRank, toFile).
 * Basic geometric check — does not verify path obstruction or board state.
 * @param flipped If provided, enforces pawn direction (false = white pawns move to lower rows)
 */
function isLegalPieceMove(piece: string, fromRank: number, fromFile: number, toRank: number, toFile: number, flipped?: boolean): boolean {
  const dr = Math.abs(toRank - fromRank);
  const df = Math.abs(toFile - fromFile);
  switch (piece.toLowerCase()) {
    case 'r': return dr === 0 || df === 0;
    case 'b': return dr === df && dr > 0;
    case 'q': return dr === 0 || df === 0 || (dr === df && dr > 0);
    case 'n': return (dr === 1 && df === 2) || (dr === 2 && df === 1);
    case 'k': return (dr <= 1 && df <= 1 && (dr + df > 0)) || (dr === 0 && df === 2); // includes castling
    case 'p': {
      if (df > 1 || dr < 1 || dr > 2) return false;
      if (flipped == null) return true; // no orientation info, accept either direction
      // White pawns (P) move toward lower rows in standard, higher in flipped
      // Black pawns (p) move toward higher rows in standard, lower in flipped
      const isWhite = piece === 'P';
      const movesUp = toRank < fromRank;
      if (!flipped) return isWhite ? movesUp : !movesUp;
      return isWhite ? !movesUp : movesUp;
    }
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
export function disambiguateHighlights(
  candidates: number[],
  fen: string,
  scores?: Array<{ idx: number; dist: number }>,
  colors?: Array<[number, number, number]>,
  medians?: { light: [number, number, number]; dark: [number, number, number] },
  flipped?: boolean,
): number[] {
  if (candidates.length === 0) return candidates;

  const rows = fen.split('/');
  const board: (string | null)[] = new Array(64).fill(null);
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') file += parseInt(ch);
      else { board[rank * 8 + file] = ch; file++; }
    }
  }

  // Build score lookup for ranking pairs
  const scoreMap = new Map<number, number>();
  if (scores) {
    for (const s of scores) scoreMap.set(s.idx, s.dist);
  }

  // Find candidates that have a piece vs empty
  const withPiece = candidates.filter(idx => board[idx] !== null);
  const empty = candidates.filter(idx => board[idx] === null);

  // Compute highlight "naturalness" for a square: how board-like is its color?
  // Real highlights tint the board color uniformly (low channel-ratio variance).
  // Annotations replace the board color entirely (high channel-ratio variance).
  // Returns 0 (natural highlight) to 1+ (annotation-like). Board-agnostic.
  function annotationPenalty(idx: number): number {
    if (!colors || !medians) return 0;
    const color = colors[idx];
    const rank = Math.floor(idx / 8);
    const file = idx % 8;
    const expected = (rank + file) % 2 === 0 ? medians.light : medians.dark;
    // Per-channel ratio of actual color to expected median
    const ratios = [
      expected[0] > 10 ? color[0] / expected[0] : 1,
      expected[1] > 10 ? color[1] / expected[1] : 1,
      expected[2] > 10 ? color[2] / expected[2] : 1,
    ];
    const mean = (ratios[0] + ratios[1] + ratios[2]) / 3;
    const variance = ((ratios[0] - mean) ** 2 + (ratios[1] - mean) ** 2 + (ratios[2] - mean) ** 2) / 3;
    return variance;
  }

  // Try to find a valid (empty_source, piece_destination) pair.
  // The source must be empty (the piece left it) and the destination has the piece.
  const validPairs: Array<{ src: number; dest: number; combinedScore: number }> = [];

  for (const dest of withPiece) {
    const piece = board[dest]!;
    const destRank = Math.floor(dest / 8);
    const destFile = dest % 8;

    for (const src of empty) {
      const srcRank = Math.floor(src / 8);
      const srcFile = src % 8;
      // Use piece_count orientation for pawn direction validation
      if (isLegalPieceMove(piece, srcRank, srcFile, destRank, destFile, flipped)) {
        const srcScore = scoreMap.get(src) ?? 0;
        const destScore = scoreMap.get(dest) ?? 0;
        validPairs.push({ src, dest, combinedScore: srcScore + destScore });
      }
    }
  }

  if (validPairs.length > 0) {
    validPairs.sort((a, b) => b.combinedScore - a.combinedScore);
    return [validPairs[0].src, validPairs[0].dest];
  }

  // No valid pair among initial candidates. Expand: for each candidate piece,
  // search the full score list for an empty square that forms a legal move.
  // This handles annotations/overlays that create false-positive highlights
  // while the real partner square scored below the initial threshold.
  if (scores) {
    const minScore = 18;
    const expandedEmpty = scores
      .filter(s => !candidates.includes(s.idx) && s.dist >= minScore && board[s.idx] === null);

    for (const dest of withPiece) {
      const piece = board[dest]!;
      const destRank = Math.floor(dest / 8);
      const destFile = dest % 8;

      for (const s of expandedEmpty) {
        const srcRank = Math.floor(s.idx / 8);
        const srcFile = s.idx % 8;
        if (isLegalPieceMove(piece, srcRank, srcFile, destRank, destFile, flipped)) {
          const destScore = scoreMap.get(dest) ?? 0;
          validPairs.push({ src: s.idx, dest, combinedScore: s.dist + destScore });
        }
      }
    }

    // Also try: candidate empty square + expanded piece destination
    const expandedPiece = scores
      .filter(s => !candidates.includes(s.idx) && s.dist >= minScore && board[s.idx] !== null);

    for (const src of empty) {
      const srcRank = Math.floor(src / 8);
      const srcFile = src % 8;

      for (const s of expandedPiece) {
        const piece = board[s.idx]!;
        const destRank = Math.floor(s.idx / 8);
        const destFile = s.idx % 8;
        if (isLegalPieceMove(piece, srcRank, srcFile, destRank, destFile, flipped)) {
          const srcScore = scoreMap.get(src) ?? 0;
          validPairs.push({ src, dest: s.idx, combinedScore: srcScore + s.dist });
        }
      }
    }

    // Also try: expanded empty × expanded piece (both outside initial candidates).
    // Only when all candidates look like annotations (high channel-ratio variance),
    // meaning the real highlight pair is likely entirely outside the candidate list.
    const allCandidatesAnnotation = candidates.length >= 2 &&
      candidates.every(idx => annotationPenalty(idx) > 0.08);
    if (allCandidatesAnnotation) for (const srcEntry of expandedEmpty) {
      const srcRank = Math.floor(srcEntry.idx / 8);
      const srcFile = srcEntry.idx % 8;

      for (const destEntry of expandedPiece) {
        const piece = board[destEntry.idx]!;
        const destRank = Math.floor(destEntry.idx / 8);
        const destFile = destEntry.idx % 8;
        if (isLegalPieceMove(piece, srcRank, srcFile, destRank, destFile, flipped)) {
          validPairs.push({ src: srcEntry.idx, dest: destEntry.idx, combinedScore: srcEntry.dist + destEntry.dist });
        }
      }
    }

    if (validPairs.length > 0) {
      // Rank by naturalness: prefer pairs without annotation-colored squares.
      // A square is "annotation-like" when its channel-ratio variance is high
      // (>0.08). Small variance differences between real highlights and normal
      // squares are ignored — only penalize clearly foreign colors.
      const annotationThreshold = 0.08;
      validPairs.sort((a, b) => {
        const penA = (annotationPenalty(a.src) > annotationThreshold ? 1 : 0) +
                     (annotationPenalty(a.dest) > annotationThreshold ? 1 : 0);
        const penB = (annotationPenalty(b.src) > annotationThreshold ? 1 : 0) +
                     (annotationPenalty(b.dest) > annotationThreshold ? 1 : 0);
        if (penA !== penB) return penA - penB;
        const distA = Math.max(Math.abs(Math.floor(a.src / 8) - Math.floor(a.dest / 8)),
                               Math.abs((a.src % 8) - (a.dest % 8)));
        const distB = Math.max(Math.abs(Math.floor(b.src / 8) - Math.floor(b.dest / 8)),
                               Math.abs((b.src % 8) - (b.dest % 8)));
        if (distA !== distB) return distA - distB;
        return b.combinedScore - a.combinedScore;
      });
      return [validPairs[0].src, validPairs[0].dest];
    }
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

  // A valid last-move highlight has one empty square (source) and one occupied (destination).
  // If both squares have pieces, it's likely a false positive — return null.
  const pieces = highlightedIndices.filter(idx => board[idx] !== null);
  const empties = highlightedIndices.filter(idx => board[idx] === null);
  if (pieces.length === 0 || empties.length === 0) return null;

  // The piece on the destination is the one that just moved.
  // Uppercase (White) piece → White just moved → Black's turn.
  const piece = board[pieces[0]]!;
  return piece === piece.toUpperCase() ? 'b' : 'w';
}
