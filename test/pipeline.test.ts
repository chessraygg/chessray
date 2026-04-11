import { describe, it, expect, beforeAll } from 'vitest';
import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { detectBoard, cropPixels, detectHighlightedSquares, indexToSquare, flipFen, recognizeBoard, YoloPieceRecognizer, detectLabels } from '@chessray/core';
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
      const t0 = Date.now();
      const { data, width, height } = loadPng(tc.file);

      const board = await detectBoard(session, ort, data, width, height);
      expect(board.found).toBe(true);

      // Verify board bbox coordinates (within 5px tolerance for refinement variance)
      const bbox = board.bbox!;
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
      const actualSquareSize = Math.round(bbox.width / 8);
      expect(actualSquareSize).toBe(tc.squareSize);

      // Run the full recognition pipeline (same code path as production)
      const cropped = cropPixels({ data, width, height }, bbox);
      const result = await recognizeBoard(cropped, recognizer);

      const squares = result.highlightedSquares.map(indexToChess);
      console.log(`${tc.file}: highlights=${squares}, flipped=${result.flipped}, turn=${result.turn}, source=${result.orientationSource}`);

      // --- Save annotated debug image (before assertions so it's always generated) ---
      const out = new PNG({ width, height });
      out.data = Buffer.from(data);
      const rough = board.roughBbox!;
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

      // Draw highlight patches with their sampled colors
      const { patches: hlPatches } = detectHighlightedSquares(cropped);
      for (const patch of hlPatches) {
        const [pr, pg, pb] = patch.color.map(v => Math.round(v));
        // Fill patch with its sampled color
        for (let py = patch.y; py < patch.y + patch.h; py++)
          for (let px = patch.x; px < patch.x + patch.w; px++)
            setPixel(bbox.x + px, bbox.y + py, pr, pg, pb);
        // Border: white for median patches, black for non-median
        const [br, bg, bb] = patch.isMedian ? [255, 255, 255] : [0, 0, 0];
        for (let px = patch.x - 1; px <= patch.x + patch.w; px++) {
          setPixel(bbox.x + px, bbox.y + patch.y - 1, br, bg, bb);
          setPixel(bbox.x + px, bbox.y + patch.y + patch.h, br, bg, bb);
        }
        for (let py = patch.y - 1; py <= patch.y + patch.h; py++) {
          setPixel(bbox.x + patch.x - 1, bbox.y + py, br, bg, bb);
          setPixel(bbox.x + patch.x + patch.w, bbox.y + py, br, bg, bb);
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
      const expectedFlipped = tc.white_pawns === 'down';
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
        const labelResult = await detectLabels(cropped);
        if (tc.expected_labels === null) {
          // No labels expected — detectLabels should return null
          expect(labelResult).toBeNull();
          console.log('  labels: none (correct)');
        } else {
          // Labels expected — verify detection
          expect(labelResult).not.toBeNull();
          console.log(`  labels: flipped=${labelResult!.flipped}`);
          // Run per-strip verification for specific characters
          // (detectLabels returns overall result; chars are verified via the expected config)
        }
      }

    }, 120000);
  }
});
