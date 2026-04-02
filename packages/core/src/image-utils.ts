import type { BoardBBox } from './types.js';

/** Simple RGBA pixel buffer compatible with ImageData */
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Convert RGBA pixels to grayscale (single channel).
 */
export function toGrayscale(pixels: PixelBuffer): Uint8Array {
  const { data, width, height } = pixels;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return gray;
}

/**
 * Refine a rough YOLO board bbox using edge projection.
 *
 * 1. Crop to rough bbox, convert to grayscale
 * 2. Compute horizontal gradient, sum absolute values per column → vertical grid line signal
 * 3. Find 7 peaks (inner grid lines), fit evenly-spaced model
 * 4. Extrapolate to get board edges
 * 5. Same vertically
 */
export function refineBbox(pixels: PixelBuffer, rough: BoardBBox): BoardBBox {
  const { data, width } = pixels;

  function lum(px: number, py: number): number {
    const x = Math.min(Math.max(px, 0), width - 1);
    const y = Math.min(Math.max(py, 0), pixels.height - 1);
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const rw = rough.width;
  const rh = rough.height;

  // Column projection: sum of horizontal gradients per column
  const colSignal = new Float64Array(rw);
  for (let cx = 1; cx < rw; cx++) {
    let sum = 0;
    for (let ry = 0; ry < rh; ry++) {
      const px = rough.x + cx;
      const py = rough.y + ry;
      sum += Math.abs(lum(px, py) - lum(px - 1, py));
    }
    colSignal[cx] = sum;
  }

  // Row projection: sum of vertical gradients per row
  const rowSignal = new Float64Array(rh);
  for (let ry = 1; ry < rh; ry++) {
    let sum = 0;
    for (let cx = 0; cx < rw; cx++) {
      const px = rough.x + cx;
      const py = rough.y + ry;
      sum += Math.abs(lum(px, py) - lum(px, py - 1));
    }
    rowSignal[ry] = sum;
  }

  // Find the best evenly-spaced 7-peak fit for each signal
  const vLines = findGridLines(colSignal, rw);
  const hLines = findGridLines(rowSignal, rh);

  // Extrapolate outer edges: one stride before first line, one after last
  const vStride = vLines.length >= 2 ? (vLines[vLines.length - 1] - vLines[0]) / (vLines.length - 1) : rw / 8;
  const hStride = hLines.length >= 2 ? (hLines[hLines.length - 1] - hLines[0]) / (hLines.length - 1) : rh / 8;

  // Allow extending up to one stride beyond rough bbox (YOLO bbox can be slightly off)
  // but clamp to image bounds
  const left = Math.max(0, rough.x + (vLines.length > 0 ? vLines[0] - vStride : 0));
  const right = Math.min(pixels.width, rough.x + (vLines.length > 0 ? vLines[vLines.length - 1] + vStride : rw));
  const top = Math.max(0, rough.y + (hLines.length > 0 ? hLines[0] - hStride : 0));
  const bottom = Math.min(pixels.height, rough.y + (hLines.length > 0 ? hLines[hLines.length - 1] + hStride : rh));

  const rx = Math.round(left);
  const ry = Math.round(top);
  const w = Math.round(right - left);
  const h = Math.round(bottom - top);
  const size = Math.min(Math.max(w, h), rough.width, rough.height);

  return {
    x: Math.min(rx, rough.x + rough.width - size),
    y: Math.min(ry, rough.y + rough.height - size),
    width: size,
    height: size,
  };
}

/**
 * Find 7 evenly-spaced internal grid lines in a 1D gradient projection signal.
 *
 * Brute-force search over (stride, offset) space, scoring by the total signal
 * strength at all 7 expected positions. This is robust against outlier peaks
 * (e.g. board outer edges, overlay banners) because only a consistent periodic
 * pattern scores high — isolated strong peaks cannot dominate.
 */
function findGridLines(signal: Float64Array, len: number): number[] {
  const expectedStride = len / 8;
  const minStride = Math.floor(expectedStride * 0.7);
  const maxStride = Math.ceil(expectedStride * 1.3);

  let bestScore = -1;
  let bestStride = 0;
  let bestOffset = 0;

  for (let stride = minStride; stride <= maxStride; stride++) {
    // offset = position of the first internal grid line (between squares 0 and 1)
    const minOffset = Math.max(1, Math.floor(stride * 0.5));
    const maxOffset = Math.min(len - 1, Math.ceil(stride * 1.5));
    for (let offset = minOffset; offset <= maxOffset; offset++) {
      const lastPos = offset + 6 * stride;
      if (lastPos >= len) break;

      let score = 0;
      for (let k = 0; k < 7; k++) {
        const pos = offset + k * stride;
        // Sum signal in a ±2 window around the expected position
        for (let w = -2; w <= 2; w++) {
          const p = pos + w;
          if (p >= 0 && p < len) score += signal[p];
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestStride = stride;
        bestOffset = offset;
      }
    }
  }

  if (bestScore <= 0) return [];

  // Snap each line to the actual peak within a small window
  const lines: number[] = [];
  const snapRadius = Math.max(3, Math.floor(bestStride * 0.1));
  for (let k = 0; k < 7; k++) {
    const center = bestOffset + k * bestStride;
    let bestPos = center;
    let bestVal = -1;
    for (let d = -snapRadius; d <= snapRadius; d++) {
      const p = center + d;
      if (p >= 0 && p < len && signal[p] > bestVal) {
        bestVal = signal[p];
        bestPos = p;
      }
    }
    lines.push(bestPos);
  }

  return lines;
}

/**
 * Crop a region from a pixel buffer.
 */
export function cropPixels(pixels: PixelBuffer, bbox: BoardBBox): PixelBuffer {
  const { x, y, width: bw, height: bh } = bbox;
  const cropped = new Uint8ClampedArray(bw * bh * 4);

  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      const srcIdx = ((y + row) * pixels.width + (x + col)) * 4;
      const dstIdx = (row * bw + col) * 4;
      cropped[dstIdx] = pixels.data[srcIdx];
      cropped[dstIdx + 1] = pixels.data[srcIdx + 1];
      cropped[dstIdx + 2] = pixels.data[srcIdx + 2];
      cropped[dstIdx + 3] = pixels.data[srcIdx + 3];
    }
  }

  return { data: cropped, width: bw, height: bh };
}

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

export type OrientationSource = 'label' | 'pawn_move' | 'piece_count';

export interface OrientationResult {
  flipped: boolean;
  source: OrientationSource;
}

/**
 * Detect board orientation by reading coordinate labels on the board image.
 *
 * Looks for rank numbers in the bottom-left and top-left corners of the board.
 * Uses median square colors (not center sampling) to avoid confusion with pieces.
 * Compares the "ink" (text pixel count) in each corner:
 * "1" has much less ink than "8", so the corner with less ink is rank 1.
 *
 * Returns null if no labels are detected.
 */
export function detectOrientationFromLabels(pixels: PixelBuffer): boolean | null {
  const { data, width, height } = pixels;
  const sqW = width / 8;
  const sqH = height / 8;

  // Label region: bottom-left corner of the leftmost square in each rank.
  const labelW = Math.max(3, Math.floor(sqW * 0.30));
  const labelH = Math.max(3, Math.floor(sqH * 0.35));

  // Compute median background color per square parity (same approach as highlight detection).
  // This avoids pieces contaminating the background estimate.
  const pw = Math.max(2, Math.floor(sqW * 0.1));
  const ph = Math.max(2, Math.floor(sqH * 0.1));
  const insetX = Math.max(2, Math.floor(sqW * 0.08));
  const insetY = Math.max(2, Math.floor(sqH * 0.08));

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

  // Collect colors from inner squares only (avoid edge squares with labels)
  const lightColors: Array<[number, number, number]> = [];
  const darkColors: Array<[number, number, number]> = [];
  for (let rank = 1; rank < 7; rank++) {
    for (let file = 1; file < 7; file++) {
      const x0 = Math.floor(file * sqW) + insetX;
      const y0 = Math.floor(rank * sqH) + insetY;
      const c = samplePatch(x0, y0);
      if ((rank + file) % 2 === 0) lightColors.push(c);
      else darkColors.push(c);
    }
  }

  function median(arr: number[]): number {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  }

  const lightBg: [number, number, number] = [
    median(lightColors.map(c => c[0])),
    median(lightColors.map(c => c[1])),
    median(lightColors.map(c => c[2])),
  ];
  const darkBg: [number, number, number] = [
    median(darkColors.map(c => c[0])),
    median(darkColors.map(c => c[1])),
    median(darkColors.map(c => c[2])),
  ];

  // Count pixels in label region that differ from the expected background.
  function countInkPixels(sqRow: number): number {
    // Bottom-left square: row=sqRow, file=0. Parity = (sqRow + 0) % 2.
    const bg = (sqRow % 2 === 0) ? lightBg : darkBg;
    const x0 = 1;
    const y0 = Math.floor(sqRow * sqH + sqH - labelH);
    let ink = 0;
    const threshold = 35;
    for (let py = y0; py < y0 + labelH; py++) {
      for (let px = x0; px < x0 + labelW; px++) {
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const idx = (py * width + px) * 4;
        const dr = Math.abs(data[idx] - bg[0]);
        const dg = Math.abs(data[idx + 1] - bg[1]);
        const db = Math.abs(data[idx + 2] - bg[2]);
        if (dr + dg + db > threshold) ink++;
      }
    }
    return ink;
  }

  const bottomInk = countInkPixels(7);
  const topInk = countInkPixels(0);

  const totalPixels = labelW * labelH;
  const bottomRatio = bottomInk / totalPixels;
  const topRatio = topInk / totalPixels;

  // Both corners need some ink to confirm labels exist.
  const minRatio = 0.03;
  if (bottomRatio < minRatio && topRatio < minRatio) return null;

  // At least one corner must have substantial ink (the "8" digit).
  if (Math.max(bottomRatio, topRatio) < 0.08) return null;

  // The difference must be significant — "1" has ~2-3x less ink than "8".
  if (bottomInk > 0 && topInk > 0) {
    const ratio = Math.max(bottomInk, topInk) / Math.min(bottomInk, topInk);
    if (ratio < 1.3) return null;
  }

  // "1" has less ink than "8". If bottom has more ink → "8" at bottom → flipped.
  return bottomInk > topInk;
}

/**
 * Auto-detect if the board is flipped (black at bottom).
 *
 * Heuristic fallback when OCR label detection is unavailable or finds nothing.
 *
 * Strategies (in priority order):
 * 1. Pawn move direction from highlights (reliable when pawns are present).
 * 2. Piece count heuristic: more of a color's pieces at bottom = that color's side.
 */
export function detectBoardFlipped(
  fen: string,
  highlightedIndices?: number[],
): OrientationResult {
  // Strategy 1: pawn move direction from highlights
  if (highlightedIndices && highlightedIndices.length === 2) {
    const rows = fen.split('/');
    const board: (string | null)[] = new Array(64).fill(null);
    for (let rank = 0; rank < 8; rank++) {
      let file = 0;
      for (const ch of rows[rank]) {
        if (ch >= '1' && ch <= '8') { file += parseInt(ch); }
        else { board[rank * 8 + file] = ch; file++; }
      }
    }

    const [idx0, idx1] = highlightedIndices;
    const piece0 = board[idx0];
    const piece1 = board[idx1];

    let pawn: string | null = null;
    let fromRow = -1;
    let toRow = -1;
    if (piece0 && (piece0 === 'P' || piece0 === 'p') && !piece1) {
      pawn = piece0; toRow = Math.floor(idx0 / 8); fromRow = Math.floor(idx1 / 8);
    } else if (piece1 && (piece1 === 'P' || piece1 === 'p') && !piece0) {
      pawn = piece1; toRow = Math.floor(idx1 / 8); fromRow = Math.floor(idx0 / 8);
    }

    if (pawn && fromRow !== toRow) {
      const movedDown = toRow > fromRow;
      if (pawn === 'P') return { flipped: movedDown, source: 'pawn_move' };
      if (pawn === 'p') return { flipped: !movedDown, source: 'pawn_move' };
    }
  }

  // Strategy 2: piece count heuristic (fallback)
  // Counts white vs black pieces in the bottom half of the image.
  // Works well when there's any asymmetry. In very sparse equal positions
  // (e.g. K vs k+p) it can fail, but those cases should be caught by
  // label detection or pawn move detection first.
  const rows = fen.split('/');
  let whiteBottom = 0, blackBottom = 0;

  for (let rank = 0; rank < 8; rank++) {
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') continue;
      const isWhite = ch === ch.toUpperCase();
      if (rank >= 4) {
        if (isWhite) whiteBottom++; else blackBottom++;
      }
    }
  }

  return { flipped: blackBottom > whiteBottom, source: 'piece_count' };
}
