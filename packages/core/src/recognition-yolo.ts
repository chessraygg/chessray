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
    // Lower threshold to capture more anchor votes for confidence-sum voting.
    // Each piece generates many overlapping detections from different anchors;
    // summing their confidences per class is more robust than picking the single
    // highest-confidence detection (which can be wrong when overlays shift color).
    const confThreshold = 0.3;

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

    // Group detections by grid square and vote by summed confidence per class.
    // Multiple YOLO anchors produce overlapping detections for the same piece;
    // voting is more robust than NMS (which just picks the single highest conf
    // and can be wrong when an overlay shifts the color balance).
    const board: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
    const tiles: TileClassification[] = [];

    // Accumulate confidence per (square, class)
    const squareVotes = new Map<string, Map<number, number>>();
    for (const det of detections) {
      const file = Math.min(7, Math.floor(det.x * 8));
      const rank = Math.min(7, Math.floor(det.y * 8));
      if (file < 0 || file >= 8 || rank < 0 || rank >= 8) continue;
      const key = `${rank},${file}`;
      if (!squareVotes.has(key)) squareVotes.set(key, new Map());
      const votes = squareVotes.get(key)!;
      votes.set(det.classId, (votes.get(det.classId) ?? 0) + det.confidence);
    }

    for (const [key, votes] of squareVotes) {
      const [rank, file] = key.split(',').map(Number);
      // Pick class with highest total confidence
      let bestClass = 0, bestTotal = 0;
      for (const [classId, total] of votes) {
        if (total > bestTotal) { bestTotal = total; bestClass = classId; }
      }
      const piece = CLASS_TO_FEN[bestClass];
      if (!piece) continue;
      // Use the max individual confidence for the tile's reported confidence
      const maxConf = detections
        .filter(d => d.classId === bestClass &&
          Math.min(7, Math.floor(d.x * 8)) === file &&
          Math.min(7, Math.floor(d.y * 8)) === rank)
        .reduce((max, d) => Math.max(max, d.confidence), 0);
      board[rank][file] = piece;
      tiles.push({ square: indexToSquare(rank, file), piece, confidence: maxConf });
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

