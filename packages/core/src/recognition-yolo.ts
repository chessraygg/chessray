import type { RecognitionResult, TileClassification } from './types.js';
import type { PieceRecognizerInterface } from './recognition-interface.js';
import { indexToSquare } from './fen.js';

// NAKSTStudio/yolov8m class mapping (0=board, 1-12=pieces)
const CLASS_TO_FEN: Record<number, string> = {
  // 0: 'board' — skip
  1: 'K', 2: 'Q', 3: 'R', 4: 'B', 5: 'N', 6: 'P',
  7: 'k', 8: 'q', 9: 'r', 10: 'b', 11: 'n', 12: 'p',
};

interface Detection {
  x: number;     // center x (0-640)
  y: number;     // center y (0-640)
  w: number;     // width
  h: number;     // height
  confidence: number;
  classId: number;
}

/**
 * YOLO-ONNX piece recognizer.
 * Uses ONNX Runtime Web to run a YOLOv11n model that detects pieces with bounding boxes.
 * Maps detections to an 8x8 grid to produce a FEN string.
 */
export class YoloPieceRecognizer implements PieceRecognizerInterface {
  session: any = null;
  ort: any = null;

  constructor(private modelUrl: string) {}

  async recognize(imageData: ImageData): Promise<RecognitionResult> {
    return this.detect(imageData);
  }

  async load(): Promise<void> {
    // Import ONNX Runtime Web
    this.ort = (globalThis as any).ort;
    if (!this.ort) {
      throw new Error('ONNX Runtime Web not loaded. Include ort.min.js before using.');
    }

    // Fetch model and create session
    const response = await fetch(this.modelUrl);
    const modelBuffer = await response.arrayBuffer();
    // Prefer WebGPU (10-50x faster than WASM), fall back to WASM
    this.session = await this.ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['webgpu', 'wasm'],
    });

    // Log which execution provider was actually selected
    const eps = this.session?.handler?.executionProviders
      ?? this.session?.handler?.backendHint
      ?? 'unknown';
    console.log(`[YOLO] ONNX session created, EP: ${JSON.stringify(eps)}`);

    // Check if WebGPU is available in this context
    const gpu = (globalThis as any).navigator?.gpu;
    console.log(`[YOLO] WebGPU available in this context: ${!!gpu}`);
  }

  /**
   * Detect pieces in a full frame, mapping detections to the board grid.
   * @param fullImage The full (downscaled) frame
   * @param boardBbox The detected board bounding box (in downscaled coords)
   * @param scale Scale factor from original to downscaled (e.g., 0.44)
   */
  async detectWithBbox(
    fullImage: ImageData,
    boardBbox: { x: number; y: number; width: number; height: number },
    scale: number
  ): Promise<RecognitionResult> {
    if (!this.session) throw new Error('Model not loaded');
    const startTime = Date.now();

    const inputSize = 640;
    const { width: srcW, height: srcH, data: srcData } = fullImage;

    // Resize full frame to 640x640
    const tensorData = new Float32Array(3 * inputSize * inputSize);
    for (let y = 0; y < inputSize; y++) {
      for (let x = 0; x < inputSize; x++) {
        const sx = Math.floor(x * srcW / inputSize);
        const sy = Math.floor(y * srcH / inputSize);
        const si = (sy * srcW + sx) * 4;
        const di = y * inputSize + x;
        tensorData[di] = srcData[si] / 255.0;
        tensorData[inputSize * inputSize + di] = srcData[si + 1] / 255.0;
        tensorData[2 * inputSize * inputSize + di] = srcData[si + 2] / 255.0;
      }
    }

    const inputTensor = new this.ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]);
    const results = await this.session.run({ [this.session.inputNames[0]]: inputTensor });
    const output = results[this.session.outputNames[0]];
    const outputData = output.data as Float32Array;
    const numDetections = output.dims[2];
    const numChannels = output.dims[1];

    // Model outputs normalized coords (0-1), convert to image coords
    // Board bbox is in downscaled image coords
    const bx = boardBbox.x / srcW; // normalize bbox to 0-1
    const by = boardBbox.y / srcH;
    const bw = boardBbox.width / srcW;
    const bh = boardBbox.height / srcH;

    const detections: Detection[] = [];
    const confThreshold = 0.5;

    for (let i = 0; i < numDetections; i++) {
      let maxProb = 0;
      let maxClass = 0;
      for (let c = 4; c < numChannels; c++) {
        const prob = outputData[c * numDetections + i];
        if (prob > maxProb) { maxProb = prob; maxClass = c - 4; }
      }
      if (maxProb < confThreshold) continue;
      if (!(maxClass in CLASS_TO_FEN)) continue;

      // Coords are normalized (0-1)
      const cx = outputData[0 * numDetections + i];
      const cy = outputData[1 * numDetections + i];
      const w = outputData[2 * numDetections + i];
      const h = outputData[3 * numDetections + i];

      // Filter: only keep detections within the board bbox
      if (cx < bx || cx > bx + bw || cy < by || cy > by + bh) continue;

      detections.push({ x: cx, y: cy, w, h, confidence: maxProb, classId: maxClass });
    }

    const nmsDetections = nonMaxSuppression(detections, 0.5);

    // Map to 8x8 grid
    const board: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
    const tiles: TileClassification[] = [];

    for (const det of nmsDetections) {
      const file = Math.min(7, Math.floor((det.x - bx) / bw * 8));
      const rank = Math.min(7, Math.floor((det.y - by) / bh * 8));

      if (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
        const piece = CLASS_TO_FEN[det.classId];
        if (!piece) continue;
        const square = indexToSquare(rank, file);
        if (!board[rank][file] || det.confidence > (tiles.find(t => t.square === square)?.confidence ?? 0)) {
          board[rank][file] = piece;
          const existing = tiles.findIndex(t => t.square === square);
          const tile = { square, piece, confidence: det.confidence };
          if (existing >= 0) tiles[existing] = tile;
          else tiles.push(tile);
        }
      }
    }

    // Build FEN
    const fenRows: string[] = [];
    let totalConf = 0, pieceCount = 0;
    for (let rank = 0; rank < 8; rank++) {
      let row = '', empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (!piece) {
          empty++;
          if (!tiles.find(t => t.square === indexToSquare(rank, file))) {
            tiles.push({ square: indexToSquare(rank, file), piece: '.', confidence: 1 });
          }
        } else {
          if (empty > 0) { row += empty; empty = 0; }
          row += piece;
          pieceCount++;
          totalConf += tiles.find(t => t.square === indexToSquare(rank, file))?.confidence ?? 0;
        }
      }
      if (empty > 0) row += empty;
      fenRows.push(row);
    }

    return {
      fen: fenRows.join('/'),
      confidence: pieceCount > 0 ? totalConf / pieceCount : 0,
      tiles,
      elapsed_ms: Date.now() - startTime,
    };
  }

  /**
   * Detect pieces in a board image (cropped).
   * Input: ImageData of the cropped board (any size, will be resized to 640x640)
   */
  async detect(imageData: ImageData): Promise<RecognitionResult> {
    if (!this.session) throw new Error('Model not loaded');
    const startTime = Date.now();

    const inputSize = 640;
    const { width: srcW, height: srcH, data: srcData } = imageData;

    // Resize to 640x640 and convert to CHW float32 tensor [1, 3, 640, 640]
    const tensorData = new Float32Array(3 * inputSize * inputSize);

    for (let y = 0; y < inputSize; y++) {
      for (let x = 0; x < inputSize; x++) {
        const sx = Math.floor(x * srcW / inputSize);
        const sy = Math.floor(y * srcH / inputSize);
        const si = (sy * srcW + sx) * 4;
        const di = y * inputSize + x;

        // Normalize to 0-1, CHW format
        tensorData[di] = srcData[si] / 255.0;                           // R channel
        tensorData[inputSize * inputSize + di] = srcData[si + 1] / 255.0; // G channel
        tensorData[2 * inputSize * inputSize + di] = srcData[si + 2] / 255.0; // B channel
      }
    }
    const tPrep = Date.now() - startTime;

    const inputTensor = new this.ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]);
    const tInferStart = Date.now();
    const results = await this.session.run({ images: inputTensor });
    const tInfer = Date.now() - tInferStart;

    // Parse YOLO output: shape [1, 17, 8400] — 17 = 4 (bbox) + 13 (class probs)
    // Bbox coords are normalized (0-1), not pixel-based
    const output = results[Object.keys(results)[0]];
    const outputData = output.data as Float32Array;
    const numDetections = output.dims[2]; // 8400
    const numChannels = output.dims[1];   // 17

    const detections: Detection[] = [];
    const confThreshold = 0.5;

    for (let i = 0; i < numDetections; i++) {
      // Find best class
      let maxProb = 0;
      let maxClass = 0;
      for (let c = 4; c < numChannels; c++) {
        const prob = outputData[c * numDetections + i];
        if (prob > maxProb) {
          maxProb = prob;
          maxClass = c - 4;
        }
      }

      if (maxProb < confThreshold) continue;
      // Skip class 0 (board) and any unknown class
      if (!(maxClass in CLASS_TO_FEN)) continue;

      const cx = outputData[0 * numDetections + i];
      const cy = outputData[1 * numDetections + i];
      const w = outputData[2 * numDetections + i];
      const h = outputData[3 * numDetections + i];

      detections.push({
        x: cx, y: cy, w, h,
        confidence: maxProb,
        classId: maxClass,
      });
    }

    // NMS: remove overlapping detections
    const nmsDetections = nonMaxSuppression(detections, 0.5);

    // Map detections to 8x8 grid
    const board: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
    const tiles: TileClassification[] = [];

    for (const det of nmsDetections) {
      // Coords are normalized (0-1), map directly to 0-7 grid
      const file = Math.min(7, Math.floor(det.x * 8));
      const rank = Math.min(7, Math.floor(det.y * 8));

      if (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
        const piece = CLASS_TO_FEN[det.classId];
        if (!piece) continue;
        // Keep highest confidence detection per square
        if (!board[rank][file] || det.confidence > (tiles.find(t => t.square === indexToSquare(rank, file))?.confidence ?? 0)) {
          board[rank][file] = piece;
          const existing = tiles.findIndex(t => t.square === indexToSquare(rank, file));
          const tile = { square: indexToSquare(rank, file), piece, confidence: det.confidence };
          if (existing >= 0) tiles[existing] = tile;
          else tiles.push(tile);
        }
      }
    }

    // Build FEN from board
    const fenRows: string[] = [];
    let totalConf = 0;
    let pieceCount = 0;

    for (let rank = 0; rank < 8; rank++) {
      let row = '';
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (!piece) {
          empty++;
          // Add empty tile classification
          if (!tiles.find(t => t.square === indexToSquare(rank, file))) {
            tiles.push({ square: indexToSquare(rank, file), piece: '.', confidence: 1 });
          }
        } else {
          if (empty > 0) { row += empty; empty = 0; }
          row += piece;
          pieceCount++;
          totalConf += tiles.find(t => t.square === indexToSquare(rank, file))?.confidence ?? 0;
        }
      }
      if (empty > 0) row += empty;
      fenRows.push(row);
    }

    const tPost = Date.now() - startTime - tPrep - tInfer;
    return {
      fen: fenRows.join('/'),
      confidence: pieceCount > 0 ? totalConf / pieceCount : 0,
      tiles,
      elapsed_ms: Date.now() - startTime,
      timing: { prep_ms: tPrep, infer_ms: tInfer, post_ms: tPost },
    };
  }
}

function nonMaxSuppression(detections: Detection[], iouThreshold: number): Detection[] {
  detections.sort((a, b) => b.confidence - a.confidence);
  const result: Detection[] = [];

  for (const det of detections) {
    let dominated = false;
    for (const kept of result) {
      if (iou(det, kept) > iouThreshold) {
        dominated = true;
        break;
      }
    }
    if (!dominated) result.push(det);
  }

  return result;
}

function iou(a: Detection, b: Detection): number {
  const ax1 = a.x - a.w / 2, ay1 = a.y - a.h / 2;
  const ax2 = a.x + a.w / 2, ay2 = a.y + a.h / 2;
  const bx1 = b.x - b.w / 2, by1 = b.y - b.h / 2;
  const bx2 = b.x + b.w / 2, by2 = b.y + b.h / 2;

  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  const aArea = (ax2 - ax1) * (ay2 - ay1);
  const bArea = (bx2 - bx1) * (by2 - by1);

  return intersection / (aArea + bArea - intersection);
}
