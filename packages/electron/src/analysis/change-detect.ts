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
