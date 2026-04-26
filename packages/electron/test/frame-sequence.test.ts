import { describe, it, expect, beforeAll } from 'vitest';
import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { YoloPieceRecognizer, indexToSquare, type PipelineResult } from '@chessray/core';
import { FrameProcessor, type ImageDataLike } from '../src/analysis/frame-processor.js';
import { StubEngine } from './helpers/stub-engine.js';
import { FRAME_SEQUENCE_CASES } from './fixtures/frame-sequences.js';

const MODEL_PATH = path.join(__dirname, '../../../vendor/yolo-chess/chess-pieces.onnx');
const SEQUENCES_DIR = path.join(__dirname, 'fixtures/sequences');

let session: ort.InferenceSession;
let recognizer: YoloPieceRecognizer;

function loadImage(file: string): ImageDataLike {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

function toSquare(idx: number): string {
  return indexToSquare(Math.floor(idx / 8), idx % 8);
}

describe('frame-sequence pipeline', () => {
  beforeAll(async () => {
    (globalThis as any).ort = ort;
    session = await ort.InferenceSession.create(MODEL_PATH);
    recognizer = new YoloPieceRecognizer('');
    (recognizer as any).session = session;
    (recognizer as any).ort = ort;
  }, 30000);

  if (FRAME_SEQUENCE_CASES.length === 0) {
    it.skip('(no sequences configured — add entries to frame-sequences.yaml)', () => {});
  }

  for (const seq of FRAME_SEQUENCE_CASES) {
    it(`sequence: ${seq.name}`, async () => {
      const engine = new StubEngine();
      const results: PipelineResult[] = [];
      const processor = new FrameProcessor({
        onnxSession: session,
        ortModule: ort,
        recognizer,
        getEngine: () => engine,
        reinitEngine: async () => { /* no-op */ },
        sendResult: (r) => results.push(r),
        log: () => { /* silent */ },
        encodePreviewUrl: () => '',
        changeDetectEnabled: seq.changeDetect ?? true,
      });

      for (let i = 0; i < seq.frames.length; i++) {
        const frame = seq.frames[i];
        const imgPath = path.join(SEQUENCES_DIR, frame.file);
        const img = loadImage(imgPath);
        results.length = 0;
        await processor.processFrame(img);

        // Last result is the current frame's sendResult; earlier entries in
        // `results` are optimistic pre-eval sends — we assert on the final one.
        const result = results[results.length - 1];
        expect(result, `${seq.name}#${i}: expected at least one sendResult`).toBeDefined();

        const exp = frame.expected;
        expect(result.recognition?.fen, `${seq.name}#${i} fen`).toBe(exp.fen);

        const highlights = (result.highlighted_squares ?? []).map(toSquare);
        if (exp.highlighted === null) {
          expect(highlights, `${seq.name}#${i} highlighted`).toEqual([]);
        } else {
          expect(highlights.length, `${seq.name}#${i} highlight count`).toBe(2);
          expect(highlights, `${seq.name}#${i} highlighted`).toContain(exp.highlighted[0]);
          expect(highlights, `${seq.name}#${i} highlighted`).toContain(exp.highlighted[1]);
        }

        expect(result.turn ?? null, `${seq.name}#${i} turn`).toBe(exp.turn);
        expect(!!result.flipped, `${seq.name}#${i} flipped`).toBe(exp.flipped);
        expect(result.orientation_source ?? null, `${seq.name}#${i} orientation_source`).toBe(exp.orientation_source);
        expect(result.detection_status ?? null, `${seq.name}#${i} detection_status`).toBe(exp.detection_status);

        if (exp.played_move === null) {
          expect(result.played_move ?? null, `${seq.name}#${i} played_move`).toBeNull();
        } else {
          expect(result.played_move, `${seq.name}#${i} played_move present`).toBeDefined();
          expect(result.played_move?.from, `${seq.name}#${i} played_move.from`).toBe(exp.played_move.from);
          expect(result.played_move?.to, `${seq.name}#${i} played_move.to`).toBe(exp.played_move.to);
          expect(result.played_move?.uci, `${seq.name}#${i} played_move.uci`).toBe(exp.played_move.uci);
        }
      }
    });
  }
});
