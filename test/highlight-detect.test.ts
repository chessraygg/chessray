import { describe, it, expect, beforeAll } from 'vitest';
import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { detectBoard, cropPixels, detectHighlightedSquares, indexToSquare, flipFen, recognizeBoard, YoloPieceRecognizer } from '@chessray/core';
import type { BoardBBox } from '@chessray/core';
import { HIGHLIGHT_CASES } from './fixtures/highlight-cases.js';

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

describe('highlight detection', () => {
  beforeAll(async () => {
    session = await ort.InferenceSession.create(MODEL_PATH);
    recognizer = new YoloPieceRecognizer('');
    recognizer.session = session;
    recognizer.ort = ort;
  }, 30000);

  for (const tc of HIGHLIGHT_CASES) {
    it(`${tc.file}: ${tc.highlighted[0]}→${tc.highlighted[1]}, ${tc.turn} to move`, async () => {
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

      // Verify raw FEN
      expect(result.rawFen).toBe(tc.expectedFen);

      // Verify highlights
      expect(result.highlightedSquares.length).toBe(2);
      expect(squares).toContain(tc.highlighted[0]);
      expect(squares).toContain(tc.highlighted[1]);

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

      // Verify full FEN
      expect(result.fullFen).toBeTruthy();
      expect(result.fullFen!.split(' ').length).toBe(6);
      console.log(`  fullFen=${result.fullFen}`);

      // Save annotated debug image
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

      // Get highlight patches for debug visualization
      const { patches } = detectHighlightedSquares(cropped);
      for (const [px0, py0, pw, ph] of patches) {
        for (let py = py0; py < py0 + ph; py++)
          for (let px = px0; px < px0 + pw; px++)
            setPixel(bbox.x + px, bbox.y + py, 0, 255, 255);
      }

      const outDir = path.join(__dirname, 'output');
      fs.mkdirSync(outDir, { recursive: true });
      const outName = tc.file.replace('.png', '-highlight.png');
      fs.writeFileSync(path.join(outDir, outName), PNG.sync.write(out));

    }, 120000);
  }
});
