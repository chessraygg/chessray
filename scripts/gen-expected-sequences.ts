/**
 * Generate expected-output images for frame-sequence test cases.
 *
 * Reads packages/electron/test/fixtures/frame-sequences.yaml and produces
 * one annotated PNG per sequence, stacking per-frame panels vertically.
 *
 * Each per-frame panel mirrors the single-frame pipeline layout:
 *   - Left: the captured frame with bbox / grid overlays
 *   - Right: virtual board rendered from the expected FEN + highlights,
 *            plus text labels with the frame's processing details.
 *
 * Usage:
 *   npx tsx scripts/gen-expected-sequences.ts                     # all
 *   npx tsx scripts/gen-expected-sequences.ts topalov-yagiz       # filter by seq name
 */

import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { YoloPieceRecognizer } from '@chessray/core';
import { FRAME_SEQUENCE_CASES, type FrameSequenceCase, type FrameExpected } from '../packages/electron/test/fixtures/frame-sequences.js';
import { FrameProcessor } from '../packages/electron/src/analysis/frame-processor.js';
import { StubEngine } from '../packages/electron/test/helpers/stub-engine.js';
import type { PipelineResult } from '../packages/electron/src/shared/types.js';
import { drawText, drawVirtualBoard, setPixelOnPng, fillRect, strokeRect } from './image-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, '../vendor/yolo-chess/chess-pieces.onnx');
const SEQUENCES_DIR = path.join(__dirname, '../packages/electron/test/fixtures/sequences');
const OUT_DIR = path.join(__dirname, '../packages/electron/test/fixtures/expected-sequences');

const PANEL_BG = [30, 30, 30] as const;
const TEXT_GRAY = [200, 200, 200] as const;
const TEXT_DIM = [160, 160, 160] as const;
const TEXT_CYAN = [100, 220, 220] as const;
const TEXT_WARN = [245, 158, 11] as const;

function loadFrame(file: string): { data: Uint8ClampedArray; width: number; height: number } {
  const png = PNG.sync.read(fs.readFileSync(path.join(SEQUENCES_DIR, file)));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

/** Run the entire sequence through a FrameProcessor (fresh state) and collect the per-frame
 *  final PipelineResult — the same thing the test asserts against. Used here for the bbox,
 *  detected medians, and board_detection info drawn on each panel. */
async function runSequence(
  session: ort.InferenceSession,
  recognizer: YoloPieceRecognizer,
  seq: FrameSequenceCase,
): Promise<PipelineResult[]> {
  const out: PipelineResult[] = [];
  const buffer: PipelineResult[] = [];
  const processor = new FrameProcessor({
    onnxSession: session,
    ortModule: ort,
    recognizer,
    getEngine: () => new StubEngine(),
    reinitEngine: async () => { /* no-op */ },
    sendResult: (r) => buffer.push(r),
    log: () => { /* silent */ },
    encodePreviewUrl: () => '',
    changeDetectEnabled: seq.changeDetect ?? true,
  });
  for (const frame of seq.frames) {
    const img = loadFrame(frame.file);
    buffer.length = 0;
    await processor.processFrame(img);
    out.push(buffer[buffer.length - 1]);
  }
  return out;
}

function drawOriginalFrame(
  out: PNG,
  ox: number, oy: number,
  src: { data: Uint8ClampedArray; width: number; height: number },
): void {
  for (let y = 0; y < src.height; y++) {
    const srcRow = y * src.width * 4;
    const dstRow = ((oy + y) * out.width + ox) * 4;
    for (let x = 0; x < src.width; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
}

function drawBboxOverlay(
  out: PNG,
  frameOx: number, frameOy: number,
  bbox: { x: number; y: number; width: number; height: number },
): void {
  const thick = 4;
  const magenta = [255, 0, 255] as const;
  const cyan = [0, 255, 255] as const;

  // Magenta bbox
  for (let t = 0; t < thick; t++) {
    for (let x = bbox.x - t; x <= bbox.x + bbox.width + t; x++) {
      setPixelOnPng(out, frameOx + x, frameOy + bbox.y - t, magenta[0], magenta[1], magenta[2]);
      setPixelOnPng(out, frameOx + x, frameOy + bbox.y + bbox.height + t, magenta[0], magenta[1], magenta[2]);
    }
    for (let y = bbox.y - t; y <= bbox.y + bbox.height + t; y++) {
      setPixelOnPng(out, frameOx + bbox.x - t, frameOy + y, magenta[0], magenta[1], magenta[2]);
      setPixelOnPng(out, frameOx + bbox.x + bbox.width + t, frameOy + y, magenta[0], magenta[1], magenta[2]);
    }
  }

  // Cyan 8×8 grid inside bbox
  const sqW = bbox.width / 8;
  const sqH = bbox.height / 8;
  for (let k = 1; k < 8; k++) {
    const gx = bbox.x + Math.round(k * sqW);
    const gy = bbox.y + Math.round(k * sqH);
    for (let y = bbox.y; y <= bbox.y + bbox.height; y++) {
      setPixelOnPng(out, frameOx + gx, frameOy + y, cyan[0], cyan[1], cyan[2]);
      setPixelOnPng(out, frameOx + gx + 1, frameOy + y, cyan[0], cyan[1], cyan[2]);
    }
    for (let x = bbox.x; x <= bbox.x + bbox.width; x++) {
      setPixelOnPng(out, frameOx + x, frameOy + gy, cyan[0], cyan[1], cyan[2]);
      setPixelOnPng(out, frameOx + x, frameOy + gy + 1, cyan[0], cyan[1], cyan[2]);
    }
  }
}

function formatExpected(exp: FrameExpected): string[] {
  const lines: { text: string; color: readonly [number, number, number] }[] = [];
  const L = (text: string, color: readonly [number, number, number] = TEXT_GRAY) => lines.push({ text, color });

  L(`HIGHLIGHTED: ${exp.highlighted ? `${exp.highlighted[0]} → ${exp.highlighted[1]}` : 'NONE'}`);
  L(`TURN: ${exp.turn === 'w' ? 'WHITE' : exp.turn === 'b' ? 'BLACK' : 'UNKNOWN'}`);
  L(`FLIPPED: ${exp.flipped ? 'YES' : 'NO'}`);
  L(`SOURCE: ${exp.orientation_source ? exp.orientation_source.toUpperCase() : 'NONE'}`);

  if (exp.detection_status) {
    L(`STATUS: ${exp.detection_status.toUpperCase()}`, TEXT_WARN);
  } else {
    L(`STATUS: OK`, TEXT_CYAN);
  }

  if (exp.played_move) {
    L(`PLAYED: ${exp.played_move.from} → ${exp.played_move.to} (${exp.played_move.uci})`);
  } else {
    L(`PLAYED: NONE`, TEXT_DIM);
  }

  L(`FEN:`, TEXT_DIM);
  L(exp.fen, TEXT_DIM);

  return lines.map(l => `\u0001${l.color[0]},${l.color[1]},${l.color[2]}\u0001${l.text}`);
}

function drawLabels(
  out: PNG,
  ox: number, oy: number,
  lines: string[],
  textScale: number,
): number {
  const lineH = 9 * textScale;
  let y = oy;
  for (const encoded of lines) {
    // Decode inline color prefix: \u0001R,G,B\u0001text
    const match = encoded.match(/^\u0001(\d+),(\d+),(\d+)\u0001(.*)$/);
    const text = match ? match[4] : encoded;
    const r = match ? parseInt(match[1], 10) : TEXT_GRAY[0];
    const g = match ? parseInt(match[2], 10) : TEXT_GRAY[1];
    const b = match ? parseInt(match[3], 10) : TEXT_GRAY[2];
    drawText(out, text, ox, y, r, g, b, textScale);
    y += lineH;
  }
  return y;
}

function drawColorSwatch(
  out: PNG,
  ox: number, oy: number,
  size: number,
  color: readonly [number, number, number],
  label: string,
  textScale: number,
): void {
  fillRect(out, ox, oy, size, size, color[0], color[1], color[2]);
  strokeRect(out, ox, oy, size, size, 60, 60, 60, 1);
  drawText(out, `${label} ${color[0]},${color[1]},${color[2]}`, ox, oy + size + 4, TEXT_GRAY[0], TEXT_GRAY[1], TEXT_GRAY[2], Math.max(1, Math.floor(textScale * 0.75)));
}

async function generate(seq: FrameSequenceCase, session: ort.InferenceSession, recognizer: YoloPieceRecognizer): Promise<void> {
  console.log(`\n=== sequence: ${seq.name} ===`);

  // Run pipeline to get bbox and medians per frame
  const results = await runSequence(session, recognizer, seq);

  // Load raw frame PNGs for full-size rendering
  const frameImages = seq.frames.map(f => loadFrame(f.file));
  const frameW = frameImages[0].width;
  const frameH = frameImages[0].height;

  // Per-row layout: [raw frame | gap | (virtual board + text details)]
  const gap = 30;
  const rowPad = 20;
  const panelW = Math.max(1000, Math.floor(frameW * 0.45));
  const rowH = Math.max(frameH, 900) + rowPad;
  const outW = frameW + gap + panelW + rowPad * 2;
  const outH = rowH * seq.frames.length;

  const out = new PNG({ width: outW, height: outH });
  fillRect(out, 0, 0, outW, outH, PANEL_BG[0], PANEL_BG[1], PANEL_BG[2]);

  const boardSize = Math.floor(frameH * 0.55);
  const textScale = Math.max(3, Math.round(frameH / 400));

  for (let i = 0; i < seq.frames.length; i++) {
    const frame = seq.frames[i];
    const exp = frame.expected;
    const img = frameImages[i];
    const result = results[i];
    const rowY = i * rowH;

    // Left: raw frame at full size
    drawOriginalFrame(out, 0, rowY, img);

    if (result?.board_detection?.bbox) {
      drawBboxOverlay(out, 0, rowY, result.board_detection.bbox);
    }

    // Frame separator line at top of each row (except first)
    if (i > 0) {
      fillRect(out, 0, rowY, outW, 2, 80, 80, 80);
    }

    // Panel header with frame index + filename
    const panelOx = frameW + gap;
    const panelOy = rowY + rowPad;
    drawText(out, `FRAME ${i} — ${frame.file}`, panelOx, panelOy, 100, 220, 220, textScale);

    // Virtual board below the header
    const boardOy = panelOy + 10 * textScale;
    const medians = result?.square_colors;
    const hlSet = new Set(exp.highlighted ?? []);
    const whitePawns: 'up' | 'down' = exp.flipped ? 'down' : 'up';
    drawVirtualBoard(out, panelOx, boardOy, boardSize, exp.fen, hlSet, whitePawns, medians);

    // Color swatches to the right of the virtual board (detected medians)
    if (medians) {
      const swatchSize = Math.floor(boardSize / 6);
      const swatchOx = panelOx + boardSize + 20;
      drawColorSwatch(out, swatchOx, boardOy, swatchSize, medians.light, 'LIGHT', textScale);
      drawColorSwatch(out, swatchOx, boardOy + swatchSize + 30, swatchSize, medians.dark, 'DARK', textScale);
    }

    // Text labels below the virtual board
    const labelOy = boardOy + boardSize + 16;
    const lines = formatExpected(exp);
    let cursor = drawLabels(out, panelOx, labelOy, lines, textScale);

    // Bbox from actual pipeline result (not expected YAML)
    if (result?.board_detection?.bbox) {
      const b = result.board_detection.bbox;
      const scale = Math.max(1, Math.floor(textScale * 0.75));
      drawText(out, `BBOX: ${b.x},${b.y}  ${b.width}X${b.height}`, panelOx, cursor, TEXT_DIM[0], TEXT_DIM[1], TEXT_DIM[2], scale);
      cursor += 9 * scale;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${seq.name}.png`);
  fs.writeFileSync(outPath, PNG.sync.write(out));
  console.log(`  → ${outPath}`);
}

async function main(): Promise<void> {
  (globalThis as any).ort = ort;
  const session = await ort.InferenceSession.create(MODEL_PATH);
  const recognizer = new YoloPieceRecognizer('');
  (recognizer as any).session = session;
  (recognizer as any).ort = ort;

  const filter = process.argv[2];
  const cases = filter
    ? FRAME_SEQUENCE_CASES.filter(s => s.name.includes(filter))
    : FRAME_SEQUENCE_CASES;

  if (cases.length === 0) {
    console.error('No matching sequences.');
    process.exit(1);
  }

  for (const seq of cases) {
    await generate(seq, session, recognizer);
  }

  console.log(`\nGenerated ${cases.length} expected sequence image(s) in test/fixtures/expected-sequences/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
