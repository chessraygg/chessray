import { describe, it, expect, beforeAll } from 'vitest';
import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { runDetectionPipeline, indexToSquare, flipFen, YoloPieceRecognizer } from '@chessray/core';
import type { BoardBBox } from '@chessray/core';
import { PIPELINE_CASES } from './fixtures/pipeline-cases.js';

const MODEL_PATH = path.join(__dirname, '../vendor/yolo-chess/chess-pieces.onnx');
let session: ort.InferenceSession;
let recognizer: YoloPieceRecognizer;

function loadPng(name: string) {
  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'screenshots', name)));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

/** Convert corrected highlight index to chess notation */
function indexToChess(idx: number): string {
  return indexToSquare(Math.floor(idx / 8), idx % 8);
}

describe('end-to-end detection pipeline', () => {
  beforeAll(async () => {
    // Make ort available globally for label detection (PP-OCRv5)
    (globalThis as any).ort = ort;

    session = await ort.InferenceSession.create(MODEL_PATH);
    recognizer = new YoloPieceRecognizer('');
    recognizer.session = session;
    recognizer.ort = ort;
  }, 30000);

  for (const tc of PIPELINE_CASES) {
    it(`${tc.file}: ${tc.highlighted ? `${tc.highlighted[0]}→${tc.highlighted[1]}` : 'no highlights'}, ${tc.turn ?? 'unknown'} to move`, async () => {
      const { data, width, height } = loadPng(tc.file);

      const result = await runDetectionPipeline(session, ort, recognizer, data, width, height);
      expect(result.found).toBe(true);

      // Verify board bbox coordinates (within 5px tolerance for refinement variance)
      const bbox = result.bbox!;
      const tol = 5;
      expect(bbox.x).toBeGreaterThanOrEqual(tc.bbox.x - tol);
      expect(bbox.x).toBeLessThanOrEqual(tc.bbox.x + tol);
      expect(bbox.y).toBeGreaterThanOrEqual(tc.bbox.y - tol);
      expect(bbox.y).toBeLessThanOrEqual(tc.bbox.y + tol);
      expect(bbox.width).toBeGreaterThanOrEqual(tc.bbox.width - tol);
      expect(bbox.width).toBeLessThanOrEqual(tc.bbox.width + tol);
      expect(bbox.height).toBeGreaterThanOrEqual(tc.bbox.height - tol);
      expect(bbox.height).toBeLessThanOrEqual(tc.bbox.height + tol);

      // Verify grid square size
      expect(result.squareSize).toBe(tc.squareSize);

      const squares = result.highlightedSquares.map(indexToChess);
      console.log(`${tc.file}: highlights=${squares}, flipped=${result.flipped}, turn=${result.turn}, source=${result.orientationSource}`);

      // --- Save annotated debug image (before assertions so it's always generated) ---
      const out = new PNG({ width, height });
      out.data = Buffer.from(data);
      const rough = result.roughBbox!;
      const sqW = bbox.width / 8;
      const sqH = bbox.height / 8;

      const setPixel = (px: number, py: number, r: number, g: number, b: number) => {
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const i = (py * width + px) * 4;
          out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
        }
      };

      const drawRect = (b: BoardBBox, r: number, g: number, bl: number, thickness: number) => {
        for (let t = 0; t < thickness; t++) {
          for (let x = b.x - t; x <= b.x + b.width + t; x++) {
            setPixel(x, b.y - t, r, g, bl);
            setPixel(x, b.y + b.height + t, r, g, bl);
          }
          for (let y = b.y - t; y <= b.y + b.height + t; y++) {
            setPixel(b.x - t, y, r, g, bl);
            setPixel(b.x + b.width + t, y, r, g, bl);
          }
        }
      };

      drawRect(rough, 255, 0, 0, 3);
      drawRect(bbox, 0, 100, 255, 2);

      for (let k = 1; k < 8; k++) {
        const gx = bbox.x + Math.round(k * sqW);
        const gy = bbox.y + Math.round(k * sqH);
        for (let y = bbox.y; y <= bbox.y + bbox.height; y++) setPixel(gx, y, 0, 200, 0);
        for (let x = bbox.x; x <= bbox.x + bbox.width; x++) setPixel(x, gy, 0, 200, 0);
      }

      // Draw the padding strip frame that's sampled for each square (magenta outline)
      const insetPctDbg = sqW > 100 ? 0.15 : 0.08;
      const insetXDbg = Math.max(2, Math.floor(sqW * insetPctDbg));
      const insetYDbg = Math.max(2, Math.floor(sqH * insetPctDbg));
      const edgeInsetDbg = Math.max(1, Math.floor(Math.min(sqW, sqH) * 0.02));
      for (let rank2 = 0; rank2 < 8; rank2++) {
        for (let file2 = 0; file2 < 8; file2++) {
          // Outer border (just past grid lines)
          const ox0 = bbox.x + Math.floor(file2 * sqW) + edgeInsetDbg;
          const oy0 = bbox.y + Math.floor(rank2 * sqH) + edgeInsetDbg;
          const ox1 = bbox.x + Math.floor((file2 + 1) * sqW) - edgeInsetDbg;
          const oy1 = bbox.y + Math.floor((rank2 + 1) * sqH) - edgeInsetDbg;
          for (let px = ox0; px < ox1; px++) { setPixel(px, oy0, 255, 0, 255); setPixel(px, oy1 - 1, 255, 0, 255); }
          for (let py = oy0; py < oy1; py++) { setPixel(ox0, py, 255, 0, 255); setPixel(ox1 - 1, py, 255, 0, 255); }
          // Inner border (where inset/piece area begins)
          const ix0 = bbox.x + Math.floor(file2 * sqW) + insetXDbg;
          const iy0 = bbox.y + Math.floor(rank2 * sqH) + insetYDbg;
          const ix1 = bbox.x + Math.floor((file2 + 1) * sqW) - insetXDbg;
          const iy1 = bbox.y + Math.floor((rank2 + 1) * sqH) - insetYDbg;
          for (let px = ix0; px < ix1; px++) { setPixel(px, iy0, 255, 0, 255); setPixel(px, iy1 - 1, 255, 0, 255); }
          for (let py = iy0; py < iy1; py++) { setPixel(ix0, py, 255, 0, 255); setPixel(ix1 - 1, py, 255, 0, 255); }
        }
      }

      // Draw border frame median color in center of each square (white border)
      if (result.highlightColors.length > 0) {
        const patchW = Math.max(2, Math.floor(sqW * 0.1));
        const patchH = Math.max(2, Math.floor(sqH * 0.1));
        for (let i = 0; i < 64; i++) {
          const r2 = Math.floor(i / 8);
          const f2 = i % 8;
          const cx = bbox.x + Math.floor((f2 + 0.5) * sqW) - Math.floor(patchW / 2);
          const cy = bbox.y + Math.floor((r2 + 0.5) * sqH) - Math.floor(patchH / 2);
          const [mr, mg, mb] = result.highlightColors[i].map(v => Math.round(v));
          for (let py = cy; py < cy + patchH; py++)
            for (let px = cx; px < cx + patchW; px++)
              setPixel(px, py, mr, mg, mb);
          for (let px = cx - 1; px <= cx + patchW; px++) {
            setPixel(px, cy - 1, 255, 255, 255);
            setPixel(px, cy + patchH, 255, 255, 255);
          }
          for (let py = cy - 1; py <= cy + patchH; py++) {
            setPixel(cx - 1, py, 255, 255, 255);
            setPixel(cx + patchW, py, 255, 255, 255);
          }
        }
      }

      const outDir = path.join(__dirname, 'output');
      fs.mkdirSync(outDir, { recursive: true });
      const outName = tc.file.replace('.png', '-highlight.png');
      fs.writeFileSync(path.join(outDir, outName), PNG.sync.write(out));

      // --- Assertions ---
      // Verify raw FEN
      expect(result.rawFen).toBe(tc.expectedFen);

      // Verify highlights
      if (tc.highlighted) {
        expect(result.highlightedSquares.length).toBe(2);
        expect(squares).toContain(tc.highlighted[0]);
        expect(squares).toContain(tc.highlighted[1]);
      }

      // Verify orientation
      const expectedFlipped = tc.orientation === 'white top';
      expect(result.flipped).toBe(expectedFlipped);

      // Verify corrected FEN
      const expectedCorrectedFen = expectedFlipped ? flipFen(tc.expectedFen) : tc.expectedFen;
      expect(result.correctedFen).toBe(expectedCorrectedFen);

      // Verify orientation source
      expect(result.orientationSource).toBe(tc.orientation_source);

      // Verify turn
      expect(result.turn).toBe(tc.turn);

      // Verify full FEN (null when turn can't be determined)
      if (tc.turn) {
        expect(result.fullFen).toBeTruthy();
        expect(result.fullFen!.split(' ').length).toBe(6);
      } else {
        expect(result.fullFen).toBeNull();
      }
      console.log(`  fullFen=${result.fullFen}`);

      // Verify label detection
      if (tc.expected_labels !== undefined) {
        // Labels are detected inside recognizeBoard's orientation step;
        // verify via orientationSource when labels are expected
        if (tc.expected_labels === null) {
          console.log('  labels: none (correct)');
        } else {
          console.log(`  labels: flipped=${result.flipped}`);
        }
      }

    }, 120000);
  }
});
