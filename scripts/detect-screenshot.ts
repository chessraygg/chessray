/**
 * Detect board bbox, FEN, highlights, and orientation from a test screenshot.
 *
 * Usage:
 *   npx tsx scripts/detect-screenshot.ts <screenshot-filename>
 *
 * Example:
 *   npx tsx scripts/detect-screenshot.ts test-carlsen-titled2.png
 *
 * Outputs all values needed to add a new HighlightTestCase entry.
 */

import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { detectBoard, cropPixels, detectHighlightedSquares, detectBoardFlipped, indexToSquare, flipFen, buildFullFen, YoloPieceRecognizer } from '@chessray/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, '../vendor/yolo-chess/chess-pieces.onnx');
const SCREENSHOTS_DIR = path.join(__dirname, '../test/screenshots');

function rawIndexToChess(idx: number, whitePawns: 'up' | 'down'): string {
  const rank = Math.floor(idx / 8);
  const file = idx % 8;
  if (whitePawns === 'up') {
    return indexToSquare(rank, file);
  } else {
    return String.fromCharCode(97 + (7 - file)) + (rank + 1);
  }
}

/** Get raw FEN using the production YoloPieceRecognizer */
async function getRawFen(recognizer: YoloPieceRecognizer, cropped: { data: Uint8ClampedArray; width: number; height: number }): Promise<string> {
  const imageData = { data: cropped.data, width: cropped.width, height: cropped.height } as ImageData;
  const result = await recognizer.detect(imageData);
  return result.fen;
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

  // Highlight detection
  const cropped = cropPixels({ data, width: png.width, height: png.height }, bbox);
  const { highlighted } = detectHighlightedSquares(cropped);

  // FEN detection
  const rawFen = await getRawFen(recognizer, cropped);

  // Orientation detection (using pawn move direction from highlights, then fallback)
  const flipped = detectBoardFlipped(rawFen, highlighted);
  const whitePawns = flipped ? 'down' : 'up';

  // Map highlights to chess notation
  const squares = highlighted.map(idx => rawIndexToChess(idx, whitePawns));

  // Turn detection (piece on highlighted square = just moved)
  const fenRows = rawFen.split('/');
  const fenBoard: (string | null)[] = new Array(64).fill(null);
  for (let rank = 0; rank < 8; rank++) {
    let f = 0;
    for (const ch of fenRows[rank]) {
      if (ch >= '1' && ch <= '8') f += parseInt(ch);
      else { fenBoard[rank * 8 + f] = ch; f++; }
    }
  }
  let turn: 'w' | 'b' = 'w';
  for (const idx of highlighted) {
    const piece = fenBoard[idx];
    if (piece) {
      turn = piece === piece.toUpperCase() ? 'b' : 'w';
      break;
    }
  }

  // Corrected FEN (standard orientation)
  const correctedFen = flipped ? flipFen(rawFen) : rawFen;
  const fullFen = buildFullFen(correctedFen, turn);
  const castling = fullFen.split(' ')[2];

  console.log(`bbox: { x: ${bbox.x}, y: ${bbox.y}, width: ${bbox.width}, height: ${bbox.height} }`);
  console.log(`squareSize: ${squareSize}`);
  console.log(`highlighted indices: [${highlighted.join(', ')}]`);
  console.log(`highlighted squares: [${squares.map(s => `'${s}'`).join(', ')}]`);
  console.log(`white_pawns: '${whitePawns}'`);
  console.log(`turn: '${turn}'`);
  console.log(`rawFen (image orientation): '${rawFen}'`);
  console.log(`correctedFen (standard): '${correctedFen}'`);
  console.log(`castling: '${castling}'`);
  console.log(`fullFen: '${fullFen}'`);

  console.log(`\n--- Copy-paste for highlight-cases.ts ---\n`);
  console.log(`  {
    file: '${file}',
    white_pawns: '${whitePawns}',
    highlighted: ['${squares[0]}', '${squares[1]}'],
    turn: '${turn}',
    bbox: { x: ${bbox.x}, y: ${bbox.y}, width: ${bbox.width}, height: ${bbox.height} },
    squareSize: ${squareSize},
    expectedFen: '${rawFen}',
  },`);
}

main().catch(console.error);
