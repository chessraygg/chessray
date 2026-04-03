/**
 * Generate expected-output images for pipeline test cases.
 *
 * Reads test/fixtures/pipeline-cases.ts and produces annotated PNGs in
 * test/fixtures/expected-images/ showing:
 *   - Left: original screenshot with magenta bbox and cyan grid
 *   - Right: virtual board rendered from expectedFen with piece symbols and highlights
 *
 * Usage:
 *   npm run gen-expected            # regenerate all
 *   npm run gen-expected -- foo.png # regenerate only cases matching "foo.png"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { PIPELINE_CASES, type PipelineTestCase } from '../test/fixtures/pipeline-cases.js';
import { buildFullFen, flipFen } from '@chessray/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'test', 'screenshots');
const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'expected-images');

// Colors for the virtual board
const LIGHT_SQ = [240, 217, 181] as const;  // #f0d9b5
const DARK_SQ = [181, 136, 99] as const;    // #b58863
const HIGHLIGHT_LIGHT = [247, 247, 105] as const;  // #f7f769
const HIGHLIGHT_DARK = [218, 202, 58] as const;    // #daca3a
const WHITE_PIECE = [255, 255, 255] as const;
const BLACK_PIECE = [0, 0, 0] as const;
const PIECE_OUTLINE = [80, 80, 80] as const;

// Simple 5x7 pixel font for chess piece letters
const FONT: Record<string, string[]> = {
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  Q: ['01110','10001','10001','10101','10010','01101','00000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
};

// 5x7 bitmap font for labels (uppercase, digits, common symbols)
const TEXT_FONT: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01110','10001','10000','10000','10000','10001','01110'],
  D: ['11100','10010','10001','10001','10001','10010','11100'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01110','10001','10000','10111','10001','10001','01110'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  J: ['00111','00010','00010','00010','00010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01110','10001','10000','01110','00001','10001','01110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','01010','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00110','01000','10000','11111'],
  '3': ['01110','10001','00001','00110','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['01110','10001','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','10001','01110'],
  '/': ['00001','00010','00010','00100','01000','01000','10000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '.': ['00000','00000','00000','00000','00000','01100','01100'],
};

/** Draw a text string onto a PNG at (x, y) with given color and scale */
function drawText(
  png: PNG, text: string,
  x: number, y: number,
  r: number, g: number, b: number,
  scale: number = 1,
) {
  let cx = x;
  for (const ch of text) {
    const glyph = TEXT_FONT[ch.toUpperCase()];
    if (!glyph) { cx += 4 * scale; continue; }
    for (let gr = 0; gr < 7; gr++) {
      for (let gc = 0; gc < 5; gc++) {
        if (glyph[gr][gc] === '1') {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPixelOnPng(png, cx + gc * scale + sx, y + gr * scale + sy, r, g, b);
            }
          }
        }
      }
    }
    cx += 6 * scale; // 5px char + 1px gap
  }
}

function chessToGrid(sq: string, whitePawns: 'up' | 'down') {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1]);
  if (whitePawns === 'up') return { row: 8 - rank, col: file };
  return { row: rank - 1, col: 7 - file };
}

/** Parse FEN position string into 8x8 array */
function parseFen(fen: string): string[][] {
  const board: string[][] = [];
  for (const row of fen.split('/')) {
    const rank: string[] = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch); i++) rank.push('.');
      } else {
        rank.push(ch);
      }
    }
    board.push(rank);
  }
  return board;
}

/** Draw a virtual board onto a PNG at the given position */
function drawVirtualBoard(
  out: PNG,
  ox: number, oy: number,
  boardSize: number,
  fen: string,
  highlightedSquares: Set<string>,
  whitePawns: 'up' | 'down',
) {
  const board = parseFen(fen);
  const sq = boardSize / 8;

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const x0 = Math.floor(ox + file * sq);
      const y0 = Math.floor(oy + rank * sq);
      const x1 = Math.floor(ox + (file + 1) * sq);
      const y1 = Math.floor(oy + (rank + 1) * sq);
      const isLight = (rank + file) % 2 === 0;

      // Check if this square is highlighted
      let chessFile: number, chessRank: number;
      if (whitePawns === 'up') {
        chessFile = file;
        chessRank = 8 - rank;
      } else {
        chessFile = 7 - file;
        chessRank = rank + 1;
      }
      const sqName = String.fromCharCode(97 + chessFile) + chessRank;
      const isHighlighted = highlightedSquares.has(sqName);

      // Square background
      let bgColor: readonly [number, number, number];
      if (isHighlighted) {
        bgColor = isLight ? HIGHLIGHT_LIGHT : HIGHLIGHT_DARK;
      } else {
        bgColor = isLight ? LIGHT_SQ : DARK_SQ;
      }

      // Fill square
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x >= 0 && x < out.width && y >= 0 && y < out.height) {
            const i = (y * out.width + x) * 4;
            out.data[i] = bgColor[0];
            out.data[i + 1] = bgColor[1];
            out.data[i + 2] = bgColor[2];
            out.data[i + 3] = 255;
          }
        }
      }

      // Draw piece
      const piece = board[rank]?.[file];
      if (piece && piece !== '.') {
        const isWhitePiece = piece === piece.toUpperCase();
        const pieceColor = isWhitePiece ? WHITE_PIECE : BLACK_PIECE;
        const outlineColor = isWhitePiece ? PIECE_OUTLINE : [180, 180, 180] as const;
        const letter = piece.toUpperCase();
        const glyph = FONT[letter];

        // Draw filled circle for the piece
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const radius = sq * 0.35;

        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < radius && x >= 0 && x < out.width && y >= 0 && y < out.height) {
              const i = (y * out.width + x) * 4;
              if (dist > radius - 1.5) {
                // Outline
                out.data[i] = outlineColor[0];
                out.data[i + 1] = outlineColor[1];
                out.data[i + 2] = outlineColor[2];
              } else {
                out.data[i] = pieceColor[0];
                out.data[i + 1] = pieceColor[1];
                out.data[i + 2] = pieceColor[2];
              }
              out.data[i + 3] = 255;
            }
          }
        }

        // Draw letter on the piece
        if (glyph) {
          const letterColor = isWhitePiece ? [40, 40, 40] : [220, 220, 220];
          const scale = Math.max(1, Math.floor(sq / 14));
          const lw = 5 * scale;
          const lh = 7 * scale;
          const lx = Math.floor(cx - lw / 2);
          const ly = Math.floor(cy - lh / 2);

          for (let gr = 0; gr < 7; gr++) {
            for (let gc = 0; gc < 5; gc++) {
              if (glyph[gr][gc] === '1') {
                for (let sy = 0; sy < scale; sy++) {
                  for (let sx = 0; sx < scale; sx++) {
                    const px = lx + gc * scale + sx;
                    const py = ly + gr * scale + sy;
                    if (px >= 0 && px < out.width && py >= 0 && py < out.height) {
                      const i = (py * out.width + px) * 4;
                      out.data[i] = letterColor[0];
                      out.data[i + 1] = letterColor[1];
                      out.data[i + 2] = letterColor[2];
                      out.data[i + 3] = 255;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Draw border around the board
  for (let t = 0; t < 2; t++) {
    for (let x = ox - t; x <= ox + boardSize + t; x++) {
      setPixelOnPng(out, x, oy - t, 60, 60, 60);
      setPixelOnPng(out, x, oy + boardSize + t, 60, 60, 60);
    }
    for (let y = oy - t; y <= oy + boardSize + t; y++) {
      setPixelOnPng(out, ox - t, y, 60, 60, 60);
      setPixelOnPng(out, ox + boardSize + t, y, 60, 60, 60);
    }
  }
}

function setPixelOnPng(png: PNG, x: number, y: number, r: number, g: number, b: number) {
  if (x >= 0 && x < png.width && y >= 0 && y < png.height) {
    const i = (y * png.width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const filter = process.argv[2];
let generated = 0;

for (const tc of PIPELINE_CASES) {
  if (filter && !tc.file.includes(filter)) continue;

  const srcPath = path.join(SCREENSHOTS_DIR, tc.file);
  if (!fs.existsSync(srcPath)) {
    console.error(`SKIP ${tc.file} — screenshot not found`);
    continue;
  }

  const png = PNG.sync.read(fs.readFileSync(srcPath));
  const b = tc.bbox;

  // Right panel layout: virtual board (75% height) + summary labels (25% height)
  const gap = 20;
  const panelH = png.height;
  const boardDisplaySize = Math.floor(panelH * 0.75);
  const textScale = Math.max(2, Math.round(panelH / 250));
  const lineH = 9 * textScale;
  const panelW = Math.max(boardDisplaySize, 40 * 6 * textScale); // wide enough for ~40 char labels

  const outWidth = png.width + gap + panelW;
  const outHeight = png.height;
  const out = new PNG({ width: outWidth, height: outHeight });

  // Fill entire image with dark background
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const i = (y * outWidth + x) * 4;
      out.data[i] = 30;
      out.data[i + 1] = 30;
      out.data[i + 2] = 30;
      out.data[i + 3] = 255;
    }
  }

  // Copy original image to left side
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const si = (y * png.width + x) * 4;
      const di = (y * outWidth + x) * 4;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }

  // Draw overlays on the original (left side)
  const setPixel = (px: number, py: number, r: number, g: number, bl: number) => {
    setPixelOnPng(out, px, py, r, g, bl);
  };

  // Magenta bbox (3px thick)
  for (let t = 0; t < 3; t++) {
    for (let x = b.x - t; x <= b.x + b.width + t; x++) {
      setPixel(x, b.y - t, 255, 0, 255);
      setPixel(x, b.y + b.height + t, 255, 0, 255);
    }
    for (let y = b.y - t; y <= b.y + b.height + t; y++) {
      setPixel(b.x - t, y, 255, 0, 255);
      setPixel(b.x + b.width + t, y, 255, 0, 255);
    }
  }

  // Cyan grid lines (2px thick)
  const sqW = b.width / 8;
  const sqH = b.height / 8;
  for (let k = 1; k < 8; k++) {
    const gx = b.x + Math.round(k * sqW);
    const gy = b.y + Math.round(k * sqH);
    for (let y = b.y; y <= b.y + b.height; y++) {
      setPixel(gx, y, 0, 255, 255);
      setPixel(gx + 1, y, 0, 255, 255);
    }
    for (let x = b.x; x <= b.x + b.width; x++) {
      setPixel(x, gy, 0, 255, 255);
      setPixel(x, gy + 1, 0, 255, 255);
    }
  }

  // Draw virtual board at top of right panel (highlights shown only here)
  const boardX = png.width + gap;
  const boardY = 0;
  const hlSet = new Set(tc.highlighted);
  drawVirtualBoard(out, boardX, boardY, boardDisplaySize, tc.expectedFen, hlSet, tc.white_pawns);

  // Draw annotation labels below the virtual board
  const labelX = boardX + 4;
  let labelY = boardDisplaySize + 8;

  // Orientation: white pawns up/down
  const orientLabel = tc.white_pawns === 'up' ? 'WHITE BOTTOM' : 'WHITE TOP';
  drawText(out, orientLabel, labelX, labelY, 200, 200, 200, textScale);
  labelY += lineH;

  // Turn
  const turnLabel = `TURN: ${tc.turn === 'w' ? 'WHITE' : 'BLACK'}`;
  drawText(out, turnLabel, labelX, labelY, 200, 200, 200, textScale);
  labelY += lineH;

  // Move (highlighted squares)
  const moveLabel = `MOVE: ${tc.highlighted[0]}.${tc.highlighted[1]}`;
  drawText(out, moveLabel, labelX, labelY, 200, 200, 200, textScale);
  labelY += lineH;

  // Castling rights (infer from corrected FEN)
  const correctedFen = tc.white_pawns === 'down' ? flipFen(tc.expectedFen) : tc.expectedFen;
  const fullFen = buildFullFen(correctedFen, tc.turn);
  const castling = fullFen.split(' ')[2] || '-';
  const describeSide = (short: boolean, long: boolean) => {
    if (short && long) return 'SHORT LONG';
    if (short) return 'SHORT';
    if (long) return 'LONG';
    return 'NONE';
  };
  const wRights = describeSide(castling.includes('K'), castling.includes('Q'));
  const bRights = describeSide(castling.includes('k'), castling.includes('q'));
  drawText(out, `CASTLING RIGHTS: W ${wRights}. B ${bRights}`, labelX, labelY, 200, 200, 200, textScale);
  labelY += lineH;

  // Full FEN
  drawText(out, `FEN:`, labelX, labelY, 160, 160, 160, textScale);
  labelY += lineH;
  drawText(out, correctedFen, labelX, labelY, 160, 160, 160, textScale);

  const outName = tc.file.replace('.png', '-expected.png');
  fs.writeFileSync(path.join(OUT_DIR, outName), PNG.sync.write(out));
  console.log(`  ${outName}`);
  generated++;
}

console.log(`\nGenerated ${generated} expected image(s) in test/fixtures/expected-images/`);
