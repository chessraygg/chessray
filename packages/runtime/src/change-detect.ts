/** Sample ~500 pixels from the board for quick visual change detection */
export function sampleBoardPixels(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const sample = new Uint8Array(500 * 3);
  const step = Math.max(1, Math.floor(Math.sqrt(width * height / 500)));
  let idx = 0;
  for (let y = step; y < height && idx < 500 * 3; y += step) {
    for (let x = step; x < width && idx < 500 * 3; x += step) {
      const i = (y * width + x) * 4;
      sample[idx++] = data[i];
      sample[idx++] = data[i + 1];
      sample[idx++] = data[i + 2];
    }
  }
  return sample;
}

/** Sample ~500 pixels from the full frame EXCLUDING pixels inside the given
 *  bbox. Used as a cheap fingerprint for bbox-cache invalidation — when the UI
 *  chrome around the board stays stable, the bbox can't have moved, so we can
 *  skip the 250 ms YOLO board-detection call. Board-content changes (piece
 *  moves) are invisible to this fingerprint because the bbox region is masked. */
export function sampleFrameOutsideBbox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bbox: { x: number; y: number; width: number; height: number } | null,
): Uint8Array {
  const sample = new Uint8Array(500 * 3);
  // Oversample by ~2x since up to half the pixels may fall inside the bbox.
  const step = Math.max(1, Math.floor(Math.sqrt(width * height / 1000)));
  let idx = 0;
  const bx0 = bbox ? bbox.x : -1;
  const bx1 = bbox ? bbox.x + bbox.width : -1;
  const by0 = bbox ? bbox.y : -1;
  const by1 = bbox ? bbox.y + bbox.height : -1;
  for (let y = step; y < height && idx < 500 * 3; y += step) {
    for (let x = step; x < width && idx < 500 * 3; x += step) {
      if (bbox && x >= bx0 && x < bx1 && y >= by0 && y < by1) continue;
      const i = (y * width + x) * 4;
      sample[idx++] = data[i];
      sample[idx++] = data[i + 1];
      sample[idx++] = data[i + 2];
    }
  }
  return sample;
}

/** Compare two pixel samples; returns true if visually similar */
export function boardUnchanged(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.min(a.length, b.length);
  const numPixels = Math.floor(len / 3);
  let changedPixels = 0;
  for (let i = 0; i < numPixels; i++) {
    const j = i * 3;
    if (Math.abs(a[j] - b[j]) > 30 || Math.abs(a[j+1] - b[j+1]) > 30 || Math.abs(a[j+2] - b[j+2]) > 30) {
      changedPixels++;
    }
  }
  return changedPixels / numPixels < 0.015;
}
