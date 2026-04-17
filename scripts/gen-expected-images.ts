/**
 * Generate expected-output images for pipeline test cases.
 *
 * Reads test/fixtures/pipeline-cases.ts and produces annotated PNGs in
 * test/fixtures/expected-images/ showing:
 *   - Left: original screenshot with magenta bbox and cyan grid
 *   - Right: virtual board rendered from expectedFen with SVG pieces and highlights
 *
 * Usage:
 *   npm run gen-expected            # regenerate all
 *   npm run gen-expected -- foo.png # regenerate only cases matching "foo.png"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { PIPELINE_CASES, type PipelineTestCase } from '../packages/core/test/fixtures/pipeline-cases.js';
import { buildFullFen, flipFen } from '@chessray/core';
import { drawText, drawVirtualBoard, setPixelOnPng } from './image-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'packages', 'core', 'test', 'screenshots');
const OUT_DIR = path.join(__dirname, '..', 'packages', 'core', 'test', 'fixtures', 'expected-images');


// ── Main generation loop ──

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

  // Right panel layout: virtual board (75% height) + summary labels below
  const gap = 20;
  const panelH = png.height;
  const boardDisplaySize = Math.floor(panelH * 0.75);
  const textScale = Math.max(2, Math.round(panelH / 250));
  const lineH = 9 * textScale;
  const panelW = Math.max(boardDisplaySize, 40 * 6 * textScale); // wide enough for ~40 char labels

  // Big colored swatches for the detected light/dark square colors
  const swatchSize = tc.expected_square_colors ? Math.floor(boardDisplaySize / 8) : 0;
  const swatchGap = swatchSize > 0 ? 8 : 0;

  // Count label lines to compute minimum height
  const labelLineCount = countLabelLines(tc);
  const minPanelH = boardDisplaySize + 8 + swatchSize + swatchGap + labelLineCount * lineH + 8;
  const outWidth = png.width + gap + panelW;
  const outHeight = Math.max(png.height, minPanelH);
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

  // Draw virtual board at top of right panel
  const boardX = png.width + gap;
  const boardY = 0;
  const hlSet = new Set(tc.highlighted);
  drawVirtualBoard(out, boardX, boardY, boardDisplaySize, tc.expectedFen, hlSet, tc.orientation === 'white bottom' ? 'up' : 'down', tc.expected_square_colors);

  // Draw big colored swatches showing the expected light/dark square colors
  let postBoardY = boardDisplaySize + 8;
  if (tc.expected_square_colors && swatchSize > 0) {
    const sc = tc.expected_square_colors;
    const swatchY = postBoardY;
    const labelTextScale = Math.max(1, Math.floor(textScale * 0.75));
    const labelHeight = 7 * labelTextScale;
    const innerSize = swatchSize - labelHeight - 4;
    const lightX = boardX;
    const darkX = boardX + swatchSize + swatchGap;

    const drawSwatch = (sx: number, color: readonly [number, number, number], label: string) => {
      // Fill swatch
      for (let y = swatchY; y < swatchY + innerSize; y++) {
        for (let x = sx; x < sx + swatchSize; x++) {
          if (x >= 0 && x < outWidth && y >= 0 && y < outHeight) {
            const i = (y * outWidth + x) * 4;
            out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; out.data[i + 3] = 255;
          }
        }
      }
      // Thin border
      for (let x = sx; x < sx + swatchSize; x++) {
        setPixelOnPng(out, x, swatchY, 60, 60, 60);
        setPixelOnPng(out, x, swatchY + innerSize - 1, 60, 60, 60);
      }
      for (let y = swatchY; y < swatchY + innerSize; y++) {
        setPixelOnPng(out, sx, y, 60, 60, 60);
        setPixelOnPng(out, sx + swatchSize - 1, y, 60, 60, 60);
      }
      // Label below the swatch (e.g. "LIGHT 240,217,181")
      drawText(out, `${label} ${color[0]},${color[1]},${color[2]}`, sx, swatchY + innerSize + 2, 200, 200, 200, labelTextScale);
    };

    drawSwatch(lightX, sc.light, 'LIGHT');
    drawSwatch(darkX, sc.dark, 'DARK');

    postBoardY += swatchSize + swatchGap;
  }

  // Draw all annotation labels below the virtual board
  const labelX = boardX + 4;
  let labelY = postBoardY;
  const gray = [200, 200, 200] as const;
  const dimGray = [160, 160, 160] as const;
  const cyan = [100, 220, 220] as const;

  const line = (text: string, color: readonly [number, number, number] = gray) => {
    drawText(out, text, labelX, labelY, color[0], color[1], color[2], textScale);
    labelY += lineH;
  };

  // File
  line(`FILE: ${tc.file}`, dimGray);

  // Orientation: white pawns up/down
  line(tc.orientation === 'white bottom' ? 'WHITE BOTTOM' : 'WHITE TOP');

  // Turn
  line(`TURN: ${tc.turn === 'w' ? 'WHITE' : tc.turn === 'b' ? 'BLACK' : 'UNKNOWN'}`);

  // Move (highlighted squares)
  line(tc.highlighted ? `MOVE: ${tc.highlighted[0]}.${tc.highlighted[1]}` : 'MOVE: NONE');

  // Castling rights (infer from corrected FEN)
  const correctedFen = tc.orientation === 'white top' ? flipFen(tc.expectedFen) : tc.expectedFen;
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
  line(`CASTLING: W ${wRights}. B ${bRights}`);

  // Orientation source
  line(`SOURCE: ${tc.orientation_source.toUpperCase()}`);

  // Bbox
  line(`BBOX: ${tc.bbox.x},${tc.bbox.y} ${tc.bbox.width}X${tc.bbox.height}`);

  // Square size
  line(`SQUARE: ${tc.squareSize}PX`);

  // Raw FEN (image orientation)
  line(`RAW FEN:`, dimGray);
  line(tc.expectedFen, dimGray);

  // Corrected FEN (standard orientation)
  line(`CORRECTED FEN:`, dimGray);
  line(correctedFen, dimGray);

  // Full FEN (6-field)
  line(`FULL FEN:`, dimGray);
  line(fullFen, dimGray);

  // Labels
  if (tc.expected_labels.skipped) {
    line(`LABELS: SKIPPED (${tc.expected_labels.reason})`, cyan);
  } else if (tc.expected_labels.result === null) {
    line(`LABELS: NONE`, cyan);
  } else {
    line(`LABELS:`, cyan);
    for (const lbl of tc.expected_labels.result) {
      line(`  ${lbl.side.toUpperCase()} ${lbl.type.toUpperCase()} ${lbl.chars.toUpperCase()} ${lbl.direction.toUpperCase()}`, cyan);
    }
  }

  const outName = tc.file.replace('.png', '-expected.png');
  fs.writeFileSync(path.join(OUT_DIR, outName), PNG.sync.write(out));
  console.log(`  ${outName}`);
  generated++;
}

console.log(`\nGenerated ${generated} expected image(s) in test/fixtures/expected-images/`);

/** Count the number of text lines that will be drawn for a test case */
function countLabelLines(tc: PipelineTestCase): number {
  let count = 0;
  count += 1; // file
  count += 1; // orientation
  count += 1; // turn
  count += 1; // move
  count += 1; // castling
  count += 1; // source
  count += 1; // bbox
  count += 1; // square size
  count += 2; // raw fen (label + value)
  count += 2; // corrected fen (label + value)
  count += 2; // full fen (label + value)
  // labels
  if (tc.expected_labels.skipped) {
    count += 1; // "LABELS: SKIPPED (reason)"
  } else if (tc.expected_labels.result === null) {
    count += 1; // "LABELS: NONE"
  } else {
    count += 1; // "LABELS:"
    count += tc.expected_labels.result.length; // one line per label
  }
  return count;
}
