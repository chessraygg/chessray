/**
 * Shared image-building helpers for expected-image generators.
 *
 * Keeps `gen-expected-images.ts` (single-frame pipeline cases) and
 * `gen-expected-sequences.ts` (multi-frame sequences) from duplicating the
 * bitmap font, SVG piece set, and PNG compositing utilities.
 */

import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';

export const DEFAULT_LIGHT_SQ = [240, 217, 181] as const;  // #f0d9b5
export const DEFAULT_DARK_SQ = [181, 136, 99] as const;    // #b58863
export const HIGHLIGHT_YELLOW = [247, 247, 105] as const;  // #f7f769
export const HIGHLIGHT_BLEND = 0.55;

/** Mix `rgb` with HIGHLIGHT_YELLOW by the standard blend factor */
export function blendHighlight(rgb: readonly [number, number, number]): readonly [number, number, number] {
  return [
    Math.round(rgb[0] * (1 - HIGHLIGHT_BLEND) + HIGHLIGHT_YELLOW[0] * HIGHLIGHT_BLEND),
    Math.round(rgb[1] * (1 - HIGHLIGHT_BLEND) + HIGHLIGHT_YELLOW[1] * HIGHLIGHT_BLEND),
    Math.round(rgb[2] * (1 - HIGHLIGHT_BLEND) + HIGHLIGHT_YELLOW[2] * HIGHLIGHT_BLEND),
  ];
}

// Inline SVG chess pieces — cburnett set from lichess (CC BY-SA 3.0).
// Source: https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
export const PIECE_SVGS: Record<string, string> = {
  K: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path stroke-linejoin="miter" d="M22.5 11.63V6M20 8h5"/><path fill="#fff" stroke-linecap="butt" stroke-linejoin="miter" d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"/><path fill="#fff" d="M11.5 37a22.3 22.3 0 0 0 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10z"/><path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0"/></g></svg>`,
  Q: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="#fff" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M8 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0m16.5-4.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0M41 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0M16 8.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0M33 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0"/><path stroke-linecap="butt" d="M9 26c8.5-1.5 21-1.5 27 0l2-12-7 11V11l-5.5 13.5-3-15-3 15-5.5-14V25L7 14z"/><path stroke-linecap="butt" d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/><path fill="none" d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0"/></g></svg>`,
  R: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="#fff" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path stroke-linecap="butt" d="M9 39h27v-3H9zm3-3v-4h21v4zm-1-22V9h4v2h5V9h5v2h5V9h4v5"/><path d="m34 14-3 3H14l-3-3"/><path stroke-linecap="butt" stroke-linejoin="miter" d="M31 17v12.5H14V17"/><path d="m31 29.5 1.5 2.5h-20l1.5-2.5"/><path fill="none" stroke-linejoin="miter" d="M11 14h23"/></g></svg>`,
  B: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><g fill="#fff" stroke-linecap="butt"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.94 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path stroke-linejoin="miter" d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5"/></g></svg>`,
  N: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path fill="#fff" d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21"/><path fill="#fff" d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3"/><path fill="#000" d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0m5.433-9.75a.5 1.5 30 1 1-.866-.5.5 1.5 30 1 1 .866.5"/></g></svg>`,
  P: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><path fill="#fff" stroke="#000" stroke-linecap="round" stroke-width="1.5" d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"/></svg>`,
  k: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path stroke-linejoin="miter" d="M22.5 11.6V6"/><path fill="#000" stroke-linecap="butt" stroke-linejoin="miter" d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"/><path fill="#000" d="M11.5 37a22.3 22.3 0 0 0 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10z"/><path stroke-linejoin="miter" d="M20 8h5"/><path stroke="#ececec" d="M32 29.5s8.5-4 6-9.7C34.1 14 25 18 22.5 24.6v2.1-2.1C20 18 9.9 14 7 19.9c-2.5 5.6 4.8 9 4.8 9"/><path stroke="#ececec" d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0"/></g></svg>`,
  q: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><g stroke="none"><circle cx="6" cy="12" r="2.75"/><circle cx="14" cy="9" r="2.75"/><circle cx="22.5" cy="8" r="2.75"/><circle cx="31" cy="9" r="2.75"/><circle cx="39" cy="12" r="2.75"/></g><path stroke-linecap="butt" d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5z"/><path stroke-linecap="butt" d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z"/><path fill="none" stroke-linecap="butt" d="M11 38.5a35 35 1 0 0 23 0"/><path fill="none" stroke="#ececec" d="M11 29a35 35 1 0 1 23 0m-21.5 2.5h20m-21 3a35 35 1 0 0 22 0m-23 3a35 35 1 0 0 24 0"/></g></svg>`,
  r: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path stroke-linecap="butt" d="M9 39h27v-3H9zm3.5-7 1.5-2.5h17l1.5 2.5zm-.5 4v-4h21v4z"/><path stroke-linecap="butt" stroke-linejoin="miter" d="M14 29.5v-13h17v13z"/><path stroke-linecap="butt" d="M14 16.5 11 14h23l-3 2.5zM11 14V9h4v2h5V9h5v2h5V9h4v5z"/><path fill="none" stroke="#ececec" stroke-linejoin="miter" stroke-width="1" d="M12 35.5h21m-20-4h19m-18-2h17m-17-13h17M11 14h23"/></g></svg>`,
  b: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><g fill="#000" stroke-linecap="butt"><path d="M9 36c3.4-1 10.1.4 13.5-2 3.4 2.4 10.1 1 13.5 2 0 0 1.6.5 3 2-.7 1-1.6 1-3 .5-3.4-1-10.1.5-13.5-1-3.4 1.5-10.1 0-13.5 1-1.4.5-2.3.5-3-.5 1.4-2 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path stroke="#ececec" stroke-linejoin="miter" d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5"/></g></svg>`,
  n: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path fill="#000" d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21"/><path fill="#000" d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.04-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-1-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-2 2.5-3c1 0 1 3 1 3"/><path fill="#ececec" stroke="#ececec" d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0m5.43-9.75a.5 1.5 30 1 1-.86-.5.5 1.5 30 1 1 .86.5"/><path fill="#ececec" stroke="none" d="m24.55 10.4-.45 1.45.5.15c3.15 1 5.65 2.49 7.9 6.75S35.75 29.06 35.25 39l-.05.5h2.25l.05-.5c.5-10.06-.88-16.85-3.25-21.34s-5.79-6.64-9.19-7.16z"/></g></svg>`,
  p: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><path stroke="#000" stroke-linecap="round" stroke-width="1.5" d="M22.5 9a4 4 0 0 0-3.22 6.38 6.48 6.48 0 0 0-.87 10.65c-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47a6.46 6.46 0 0 0-.87-10.65A4.01 4.01 0 0 0 22.5 9z"/></svg>`,
};

const pieceCache = new Map<string, PNG>();

/** Rasterize an SVG piece to RGBA pixel buffer at the given size */
export function rasterizePiece(piece: string, size: number): PNG {
  const key = `${piece}_${size}`;
  const cached = pieceCache.get(key);
  if (cached) return cached;
  const svg = PIECE_SVGS[piece];
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  const resvg = new Resvg(sized, { fitTo: { mode: 'width', value: size } });
  const rendered = resvg.render();
  const buf = rendered.asPng();
  const png = PNG.sync.read(buf);
  pieceCache.set(key, png);
  return png;
}

// 5x7 bitmap font for labels (uppercase, digits, common symbols)
export const TEXT_FONT: Record<string, string[]> = {
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
  '_': ['00000','00000','00000','00000','00000','00000','11111'],
  '(': ['00010','00100','01000','01000','01000','00100','00010'],
  ')': ['01000','00100','00010','00010','00010','00100','01000'],
  '|': ['00100','00100','00100','00100','00100','00100','00100'],
  ',': ['00000','00000','00000','00000','00110','00100','01000'],
  '>': ['10000','01000','00100','00010','00100','01000','10000'],
  '→': ['10000','01000','00100','00010','00100','01000','10000'],
  '[': ['01110','01000','01000','01000','01000','01000','01110'],
  ']': ['01110','00010','00010','00010','00010','00010','01110'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '×': ['00000','10001','01010','00100','01010','10001','00000'],
  '=': ['00000','00000','11111','00000','11111','00000','00000'],
};

export function setPixelOnPng(png: PNG, x: number, y: number, r: number, g: number, b: number) {
  if (x >= 0 && x < png.width && y >= 0 && y < png.height) {
    const i = (y * png.width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
}

/** Draw a text string onto a PNG at (x, y) with given color and scale */
export function drawText(
  png: PNG, text: string,
  x: number, y: number,
  r: number, g: number, b: number,
  scale: number = 1,
) {
  let cx = x;
  for (const ch of text) {
    const glyph = TEXT_FONT[ch.toUpperCase()] ?? TEXT_FONT[ch];
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

/** Parse FEN position string into 8x8 array */
export function parseFen(fen: string): string[][] {
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

/** Composite a piece PNG (with alpha) onto the output at (dx, dy) */
export function compositePiece(out: PNG, piece: PNG, dx: number, dy: number) {
  for (let y = 0; y < piece.height; y++) {
    for (let x = 0; x < piece.width; x++) {
      const si = (y * piece.width + x) * 4;
      const alpha = piece.data[si + 3];
      if (alpha === 0) continue;
      const ox = dx + x;
      const oy = dy + y;
      if (ox < 0 || ox >= out.width || oy < 0 || oy >= out.height) continue;
      const di = (oy * out.width + ox) * 4;
      if (alpha === 255) {
        out.data[di] = piece.data[si];
        out.data[di + 1] = piece.data[si + 1];
        out.data[di + 2] = piece.data[si + 2];
        out.data[di + 3] = 255;
      } else {
        const a = alpha / 255;
        const ia = 1 - a;
        out.data[di] = Math.round(piece.data[si] * a + out.data[di] * ia);
        out.data[di + 1] = Math.round(piece.data[si + 1] * a + out.data[di + 1] * ia);
        out.data[di + 2] = Math.round(piece.data[si + 2] * a + out.data[di + 2] * ia);
        out.data[di + 3] = 255;
      }
    }
  }
}

/** Draw a virtual board onto a PNG at the given position */
export function drawVirtualBoard(
  out: PNG,
  ox: number, oy: number,
  boardSize: number,
  fen: string,
  highlightedSquares: Set<string>,
  whitePawns: 'up' | 'down',
  detectedColors?: { light: readonly [number, number, number]; dark: readonly [number, number, number] },
) {
  const board = parseFen(fen);
  const sq = boardSize / 8;
  const pieceSize = Math.round(sq * 0.9);

  const lightSq = detectedColors?.light ?? DEFAULT_LIGHT_SQ;
  const darkSq = detectedColors?.dark ?? DEFAULT_DARK_SQ;
  const lightHl = blendHighlight(lightSq);
  const darkHl = blendHighlight(darkSq);

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const x0 = Math.floor(ox + file * sq);
      const y0 = Math.floor(oy + rank * sq);
      const x1 = Math.floor(ox + (file + 1) * sq);
      const y1 = Math.floor(oy + (rank + 1) * sq);
      const isLight = (rank + file) % 2 === 0;

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

      const bgColor: readonly [number, number, number] = isHighlighted
        ? (isLight ? lightHl : darkHl)
        : (isLight ? lightSq : darkSq);

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

      const piece = board[rank]?.[file];
      if (piece && piece !== '.' && PIECE_SVGS[piece]) {
        const piecePng = rasterizePiece(piece, pieceSize);
        const px = Math.floor((x0 + x1) / 2 - pieceSize / 2);
        const py = Math.floor((y0 + y1) / 2 - pieceSize / 2);
        compositePiece(out, piecePng, px, py);
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

/** Draw a filled rectangle (useful for backgrounds and color swatches). */
export function fillRect(
  out: PNG,
  x: number, y: number,
  w: number, h: number,
  r: number, g: number, b: number,
) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      setPixelOnPng(out, px, py, r, g, b);
    }
  }
}

/** Draw a hollow rectangle outline with the given thickness. */
export function strokeRect(
  out: PNG,
  x: number, y: number,
  w: number, h: number,
  r: number, g: number, b: number,
  thickness: number = 1,
) {
  for (let t = 0; t < thickness; t++) {
    for (let px = x - t; px <= x + w + t; px++) {
      setPixelOnPng(out, px, y - t, r, g, b);
      setPixelOnPng(out, px, y + h + t, r, g, b);
    }
    for (let py = y - t; py <= y + h + t; py++) {
      setPixelOnPng(out, x - t, py, r, g, b);
      setPixelOnPng(out, x + w + t, py, r, g, b);
    }
  }
}
