/**
 * Coordinate label detection using Tesseract OCR.
 *
 * Self-contained: manages its own Tesseract worker as a lazy singleton.
 * Call detectLabels(pixels) — it handles everything internally.
 */

import type { PixelBuffer, OrientationResult } from './image-utils.js';
import Tesseract from 'tesseract.js';

let worker: Tesseract.Worker | null = null;
let workerPromise: Promise<Tesseract.Worker> | null = null;

async function getWorker(): Promise<Tesseract.Worker> {
  if (worker) return worker;
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng').then(w => {
      worker = w;
      return w;
    });
  }
  return workerPromise;
}

/** Encode a PixelBuffer to PNG using canvas (browser) or pngjs (Node.js) */
function encodePng(pixels: PixelBuffer): Uint8Array | Buffer {
  // Browser path: use canvas
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext('2d')!;
    const imgData = new ImageData(
      new Uint8ClampedArray(pixels.data),
      pixels.width,
      pixels.height,
    );
    ctx.putImageData(imgData, 0, 0);
    // Convert to blob synchronously via data URL
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Node.js path: use pngjs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PNG } = require('pngjs');
  const png = new PNG({ width: pixels.width, height: pixels.height });
  png.data = Buffer.from(pixels.data);
  return PNG.sync.write(png);
}

/**
 * Detect board orientation from coordinate labels using OCR.
 *
 * Scans all 4 edge strips (left, right, bottom, top) at multiple widths.
 * Requires a strictly monotonic sequence of 3+ unique characters to accept.
 *
 * Returns null if no labels are detected.
 */
export async function detectLabels(pixels: PixelBuffer): Promise<OrientationResult | null> {
  const w = await getWorker();
  const { width: bw, height: bh } = pixels;
  const sqW = bw / 8;
  const sqH = bh / 8;

  function extractStrip(side: string, pct: number): PixelBuffer {
    let sW: number, sH: number, sx0: number, sy0: number;
    if (side === 'left') { sW = Math.floor(sqW * pct); sH = bh; sx0 = 0; sy0 = 0; }
    else if (side === 'right') { sW = Math.floor(sqW * pct); sH = bh; sx0 = bw - Math.floor(sqW * pct); sy0 = 0; }
    else if (side === 'top') { sW = bw; sH = Math.floor(sqH * pct); sx0 = 0; sy0 = 0; }
    else { sW = bw; sH = Math.floor(sqH * pct); sx0 = 0; sy0 = bh - Math.floor(sqH * pct); }

    // Upscale small strips so Tesseract can read tiny labels
    const minDim = 50;
    const scale = Math.max(1, Math.ceil(minDim / Math.min(sW, sH)));
    const outW = sW * scale;
    const outH = sH * scale;

    const data = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const srcX = sx0 + Math.floor(x / scale);
        const srcY = sy0 + Math.floor(y / scale);
        const si = (srcY * bw + srcX) * 4;
        const di = (y * outW + x) * 4;
        data[di] = pixels.data[si];
        data[di + 1] = pixels.data[si + 1];
        data[di + 2] = pixels.data[si + 2];
        data[di + 3] = 255;
      }
    }
    return { data, width: outW, height: outH };
  }

  let best: { flipped: boolean; unique: number } | null = null;

  for (const pct of [0.25, 0.30, 0.35]) {
    const configs: Array<{ side: string; whitelist: string; type: 'digit' | 'letter' }> = [
      { side: 'left', whitelist: '12345678', type: 'digit' },
      { side: 'right', whitelist: '12345678', type: 'digit' },
      { side: 'bottom', whitelist: 'abcdefgh', type: 'letter' },
      { side: 'top', whitelist: 'abcdefgh', type: 'letter' },
    ];

    for (const cfg of configs) {
      const strip = extractStrip(cfg.side, pct);
      if (strip.width < 3 || strip.height < 3) continue;

      await w.setParameters({
        tessedit_char_whitelist: cfg.whitelist,
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      });

      const buf = encodePng(strip);
      const result = await w.recognize(buf);
      const text = result.data.text.replace(/\s+/g, '').trim();
      if (!text) continue;

      const detected = analyzeSequence(text, cfg.type);
      if (detected === null) continue;

      const chars = text.split('').filter(c =>
        cfg.type === 'digit' ? (c >= '1' && c <= '8') : (c >= 'a' && c <= 'h'),
      );
      const unique = new Set(chars).size;

      if (!best || unique > best.unique) {
        best = { flipped: detected, unique };
      }
    }

    // Stop early if we got a strong result
    if (best && best.unique >= 4) break;
  }

  if (!best) return null;
  return { flipped: best.flipped, source: 'label' };
}

/**
 * Analyze a sequence of characters read from an edge strip.
 * Requires a predominantly monotonic ordering with 3+ unique characters.
 * Tolerates minor OCR noise (allows minority direction violations).
 *
 * To avoid false positives from board texture noise, requires either:
 * - 4+ unique characters, OR
 * - 3 unique with strictly monotonic ordering (no violations at all)
 */
function analyzeSequence(text: string, type: 'digit' | 'letter'): boolean | null {
  const chars = text.split('').filter(c =>
    type === 'digit' ? (c >= '1' && c <= '8') : (c >= 'a' && c <= 'h'),
  );
  if (chars.length < 3) return null;

  const unique = new Set(chars);
  if (unique.size < 3) return null;

  let asc = 0;
  let desc = 0;
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] > chars[i - 1]) asc++;
    else if (chars[i] < chars[i - 1]) desc++;
  }

  const dominant = Math.max(asc, desc);
  const minority = Math.min(asc, desc);
  if (dominant < 2) return null;

  // With only 3 unique chars, require strictly monotonic AND high
  // unique-to-total ratio to avoid false positives from board texture noise.
  // Real labels like "468" have 100% unique ratio; noise like "eedaa" has 60%.
  if (unique.size < 4) {
    if (minority > 0) return null;
    if (unique.size / chars.length < 0.8) return null;
  }

  // With 4+ unique, tolerate minor noise (dominant must be 3x minority)
  if (minority > 0 && dominant < 3 * minority) return null;

  if (type === 'digit') return desc > asc ? false : true;
  return asc > desc ? false : true;
}
