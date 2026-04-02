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
