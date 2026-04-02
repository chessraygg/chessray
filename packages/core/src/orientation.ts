import type { PixelBuffer } from './pixel-utils.js';

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
