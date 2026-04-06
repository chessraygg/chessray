/**
 * Coordinate label detection using PP-OCRv5 recognition model (ONNX).
 *
 * Self-contained: manages its own ONNX session as a lazy singleton.
 * Call detectLabels(pixels) — it handles everything internally.
 *
 * For each board edge, crops 8 individual square segments, runs the
 * PP-OCRv5 recognition model at multiple input widths (to handle
 * different aspect ratios), merges recognized chars, and analyzes
 * the sequence for monotonic ordering.
 *
 * No image preprocessing (contrast stretch, binarization, etc.) —
 * the SVTR-based recognition model handles low-contrast scene text natively.
 */

import type { PixelBuffer } from './pixel-utils.js';
import type { OrientationResult } from './orientation.js';

/** PP-OCRv5 recognition model constants */
const MODEL_INPUT_HEIGHT = 48;
const STRIP_PCT = 0.30;
/** Input widths to try per segment (different widths catch different characters) */
const INPUT_WIDTHS = [14, 24, 32];

let ocrSession: any = null;
let ocrSessionPromise: Promise<any> | null = null;
let ocrDict: string[] = [];

function getOrt(): any {
  const ort = (globalThis as any).ort;
  if (!ort) throw new Error('ONNX Runtime not loaded. Include ort before using label detection.');
  return ort;
}

/** Load the PP-OCRv5 recognition model and dictionary. */
async function getSession(): Promise<any> {
  if (ocrSession) return ocrSession;
  if (ocrSessionPromise) return ocrSessionPromise;

  ocrSessionPromise = (async () => {
    const ort = getOrt();

    let session: any;
    let dictText: string;

    if (typeof document !== 'undefined') {
      // Browser (Electron) path: fetch from vendor protocol
      const [modelResp, dictResp] = await Promise.all([
        fetch('chess-vendor://paddle-ocr/en_PP-OCRv5_mobile_rec_infer.onnx'),
        fetch('chess-vendor://paddle-ocr/ppocrv5_en_dict.txt'),
      ]);
      const modelBuf = await modelResp.arrayBuffer();
      session = await ort.InferenceSession.create(modelBuf, {
        executionProviders: ['wasm'],
      });
      dictText = await dictResp.text();
    } else {
      // Node.js path (tests)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');
      const vendorDir = path.resolve(__dirname, '..', '..', '..', 'vendor', 'paddle-ocr');
      session = await ort.InferenceSession.create(
        path.join(vendorDir, 'en_PP-OCRv5_mobile_rec_infer.onnx'),
      );
      dictText = fs.readFileSync(path.join(vendorDir, 'ppocrv5_en_dict.txt'), 'utf-8');
    }

    // PP-OCR dict format: index 0 = CTC blank, then dict chars, last = space
    ocrDict = ['', ...dictText.split('\n').filter((l: string) => l.length > 0), ' '];

    ocrSession = session;
    return session;
  })();

  return ocrSessionPromise;
}

/**
 * Run PP-OCRv5 recognition on a single segment.
 *
 * @param pixels Board pixel buffer
 * @param sx0 Source x origin
 * @param sy0 Source y origin
 * @param segW Segment width in source pixels
 * @param segH Segment height in source pixels
 * @param targetW Target width for model input
 * @returns Recognized text (single character typically)
 */
async function recognizeSegment(
  pixels: PixelBuffer,
  sx0: number, sy0: number,
  segW: number, segH: number,
  targetW: number,
): Promise<string> {
  const ort = getOrt();
  const session = await getSession();
  const { width: imgW, data } = pixels;
  const targetH = MODEL_INPUT_HEIGHT;

  // Create input tensor [1, 3, H, W] normalized to [-1, 1]
  const tensor = new Float32Array(3 * targetH * targetW);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const srcX = sx0 + Math.floor(x * segW / targetW);
      const srcY = sy0 + Math.floor(y * segH / targetH);
      const si = (srcY * imgW + srcX) * 4;
      const r = (data[si] / 255.0 - 0.5) / 0.5;
      const g = (data[si + 1] / 255.0 - 0.5) / 0.5;
      const b = (data[si + 2] / 255.0 - 0.5) / 0.5;
      const offset = y * targetW + x;
      tensor[offset] = r;
      tensor[targetH * targetW + offset] = g;
      tensor[2 * targetH * targetW + offset] = b;
    }
  }

  const input = new ort.Tensor('float32', tensor, [1, 3, targetH, targetW]);
  const results = await session.run({ [session.inputNames[0]]: input });
  const output = results[session.outputNames[0]];

  // CTC greedy decode
  const [, seqLen, numClasses] = output.dims;
  let text = '';
  let lastIdx = 0;
  for (let t = 0; t < seqLen; t++) {
    let maxVal = -Infinity, maxIdx = 0;
    for (let c = 0; c < numClasses; c++) {
      const v = output.data[t * numClasses + c];
      if (v > maxVal) { maxVal = v; maxIdx = c; }
    }
    if (maxIdx !== 0 && maxIdx !== lastIdx) {
      text += ocrDict[maxIdx] || '';
    }
    lastIdx = maxIdx;
  }

  return text.toLowerCase();
}

/**
 * Detect board orientation from coordinate labels using OCR.
 *
 * For each edge, runs PP-OCRv5 recognition on 8 individual square
 * segments at multiple input widths. Merges all recognized characters
 * and requires a monotonic sequence of 3+ unique chars to accept.
 *
 * Returns null if no labels are detected.
 */
export async function detectLabels(pixels: PixelBuffer): Promise<OrientationResult | null> {
  const { width: bw, height: bh } = pixels;
  const sqW = Math.floor(bw / 8);
  const sqH = Math.floor(bh / 8);

  const edges: Array<{ side: 'left' | 'right' | 'bottom' | 'top'; type: 'digit' | 'letter' }> = [
    { side: 'left', type: 'digit' },
    { side: 'right', type: 'digit' },
    { side: 'bottom', type: 'letter' },
    { side: 'top', type: 'letter' },
  ];

  let best: { flipped: boolean; unique: number } | null = null;

  for (const edge of edges) {
    const filterChar = (c: string) =>
      edge.type === 'digit' ? (c >= '1' && c <= '8') : (c >= 'a' && c <= 'h');

    const vertical = edge.side === 'left' || edge.side === 'right';
    const segW = vertical ? Math.max(3, Math.floor(sqW * STRIP_PCT)) : sqW;
    const segH = vertical ? sqH : Math.max(3, Math.floor(sqH * STRIP_PCT));

    // Collect recognized chars across all segments and input widths
    const allChars = new Set<string>();
    // Track chars in position order for sequence analysis
    const charsByPosition: string[] = [];

    for (let i = 0; i < 8; i++) {
      let sx0: number, sy0: number;
      if (edge.side === 'left') { sx0 = 0; sy0 = i * sqH; }
      else if (edge.side === 'right') { sx0 = bw - segW; sy0 = i * sqH; }
      else if (edge.side === 'top') { sx0 = i * sqW; sy0 = 0; }
      else { sx0 = i * sqW; sy0 = bh - segH; }

      let bestChar = '';
      for (const minW of INPUT_WIDTHS) {
        const naturalW = Math.round(MODEL_INPUT_HEIGHT * segW / segH);
        const targetW = Math.max(minW, naturalW);
        const text = await recognizeSegment(pixels, sx0, sy0, segW, segH, targetW);

        // Keep single valid chars
        for (const c of text) {
          if (filterChar(c)) {
            allChars.add(c);
            if (!bestChar) bestChar = c;
          }
        }
      }
      charsByPosition.push(bestChar);
    }

    // Build ordered sequence from position-ordered chars for direction analysis
    const orderedText = charsByPosition.join('');
    const direction = analyzeSequence(orderedText, edge.type);

    if (direction !== null) {
      const mergedUnique = allChars.size;
      if (!best || mergedUnique > best.unique) {
        best = { flipped: direction, unique: mergedUnique };
      }
    }

    if (best && best.unique >= 5) break;
  }

  if (!best) return null;
  return { flipped: best.flipped, source: 'label' };
}

/**
 * Analyze a sequence of characters read from an edge strip.
 *
 * PP-OCRv5 reliably detects 5-8 chars on labeled boards, so we can
 * set strict thresholds without risking missed detections:
 * - 4+ total chars in the sequence
 * - 4+ unique chars
 * - 3+ dominant-direction transitions
 * - With < 5 unique: strictly monotonic (zero violations)
 * - With 5+ unique: tolerate minor noise (dominant >= 3× minority)
 */
function analyzeSequence(text: string, type: 'digit' | 'letter'): boolean | null {
  const chars = text.split('').filter(c =>
    type === 'digit' ? (c >= '1' && c <= '8') : (c >= 'a' && c <= 'h'),
  );
  if (chars.length < 4) return null;

  const unique = new Set(chars);
  if (unique.size < 4) return null;

  let asc = 0;
  let desc = 0;
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] > chars[i - 1]) asc++;
    else if (chars[i] < chars[i - 1]) desc++;
  }

  const dominant = Math.max(asc, desc);
  const minority = Math.min(asc, desc);
  if (dominant < 3) return null;

  // With < 5 unique, require strictly monotonic (no violations)
  if (unique.size < 5 && minority > 0) return null;

  // With 5+ unique, tolerate minor noise (dominant must be 3× minority)
  if (minority > 0 && dominant < 3 * minority) return null;

  if (type === 'digit') return desc > asc ? false : true;
  return asc > desc ? false : true;
}
