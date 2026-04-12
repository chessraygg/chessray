/**
 * Detect board bbox, FEN, highlights, and orientation from a test screenshot.
 * Outputs a draft PipelineTestCase entry for test/fixtures/pipeline-cases.ts.
 *
 * Usage:
 *   npx tsx scripts/detect-screenshot.ts <screenshot-filename>
 *
 * Example:
 *   npx tsx scripts/detect-screenshot.ts test-carlsen-titled2.png
 *
 * The output is a DRAFT — review and correct expectedFen, highlighted squares,
 * turn, and orientation_source before committing.
 */

import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { detectBoard, cropPixels, recognizeBoard, indexToSquare, flipFen, buildFullFen, YoloPieceRecognizer } from '@chessray/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, '../vendor/yolo-chess/chess-pieces.onnx');
const SCREENSHOTS_DIR = path.join(__dirname, '../test/screenshots');

function indexToChess(idx: number): string {
  return indexToSquare(Math.floor(idx / 8), idx % 8);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npx tsx scripts/detect-screenshot.ts <screenshot-filename>');
    process.exit(1);
  }

  const srcPath = path.join(SCREENSHOTS_DIR, file);
  if (!fs.existsSync(srcPath)) {
    console.error(`Screenshot not found: ${srcPath}`);
    process.exit(1);
  }

  console.log(`\n=== Detecting: ${file} ===\n`);

  // Make ort available globally for label detection
  (globalThis as any).ort = ort;

  const session = await ort.InferenceSession.create(MODEL_PATH);
  const recognizer = new YoloPieceRecognizer('');
  recognizer.session = session;
  recognizer.ort = ort;
  const png = PNG.sync.read(fs.readFileSync(srcPath));
  const data = new Uint8ClampedArray(png.data);

  // Board detection
  const board = await detectBoard(session, ort, data, png.width, png.height);
  if (!board.found) {
    console.error('Board not found!');
    process.exit(1);
  }
  const bbox = board.bbox!;
  const squareSize = Math.round(bbox.width / 8);

  // Full recognition pipeline (same code path as production and tests)
  const cropped = cropPixels({ data, width: png.width, height: png.height }, bbox);
  const result = await recognizeBoard(cropped, recognizer);

  const squares = result.highlightedSquares.map(indexToChess);
  const orientation = result.flipped ? 'white top' : 'white bottom';

  // Corrected FEN (standard orientation)
  const correctedFen = result.flipped ? flipFen(result.rawFen) : result.rawFen;
  const fullFen = buildFullFen(correctedFen, result.turn ?? 'w');

  console.log(`bbox: { x: ${bbox.x}, y: ${bbox.y}, width: ${bbox.width}, height: ${bbox.height} }`);
  console.log(`squareSize: ${squareSize}`);
  console.log(`highlighted indices: [${result.highlightedSquares.join(', ')}]`);
  console.log(`highlighted squares: [${squares.map(s => `'${s}'`).join(', ')}]`);
  console.log(`orientation: '${orientation}'`);
  console.log(`turn: '${result.turn}'`);
  console.log(`orientation_source: '${result.orientationSource}'`);
  console.log(`rawFen (image orientation): '${result.rawFen}'`);
  console.log(`correctedFen (standard): '${correctedFen}'`);
  console.log(`fullFen: '${fullFen}'`);

  const highlightStr = squares.length >= 2
    ? `['${squares[0]}', '${squares[1]}']`
    : 'null';
  const turnStr = result.turn ? `'${result.turn}'` : 'null';

  console.log(`\n--- Draft for pipeline-cases.ts (review before committing) ---\n`);
  console.log(`  {
    file: '${file}',
    orientation: '${orientation}',
    highlighted: ${highlightStr},
    turn: ${turnStr},
    bbox: { x: ${bbox.x}, y: ${bbox.y}, width: ${bbox.width}, height: ${bbox.height} },
    squareSize: ${squareSize},
    expectedFen: '${result.rawFen}',
    orientation_source: '${result.orientationSource}',
    expected_labels: null,
  },`);
}

main().catch(console.error);
