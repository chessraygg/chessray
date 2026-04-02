import type { BoardBBox } from './types.js';
import type { PixelBuffer } from './pixel-utils.js';

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
