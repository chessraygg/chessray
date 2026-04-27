import type { RecognitionResult, TileClassification } from '../types.js';
import type { PieceRecognizerInterface } from './recognition-interface.js';
import { indexToSquare } from '../fen/fen.js';

// NAKSTStudio/yolov8m class mapping (0=board, 1-12=pieces)
const CLASS_TO_FEN: Record<number, string> = {
  // 0: 'board' — skip
  1: 'K', 2: 'Q', 3: 'R', 4: 'B', 5: 'N', 6: 'P',
  7: 'k', 8: 'q', 9: 'r', 10: 'b', 11: 'n', 12: 'p',
};

/**
 * YOLO-ONNX piece recognizer.
 * Uses ONNX Runtime Web to run a YOLOv11n model that detects pieces with bounding boxes.
 * Maps detections to an 8x8 grid to produce a FEN string.
 */
export class YoloPieceRecognizer implements PieceRecognizerInterface {
  session: any = null;
  ort: any = null;
  /** Which ORT execution provider was actually selected at load time
   *  ('webgpu' or 'wasm'). Hosts log this so we can tell from the
   *  side-panel trace whether GPU acceleration is engaged — the
   *  difference is ~10-20× per inference. */
  executionProvider: string = 'unknown';

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

    // Explicit EP selection: try WebGPU first, only fall back to WASM on failure.
    // ort-web's `[webgpu, wasm]` list silently picks whichever succeeds and
    // exposes no reliable way to query which one ran — so we split the calls
    // and log the actual path taken.
    let selectedEp = 'webgpu';
    try {
      this.session = await this.ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['webgpu'],
      });
    } catch (err) {
      console.log(`[YOLO] WebGPU session creation failed: ${err}. Falling back to WASM.`);
      selectedEp = 'wasm';
      this.session = await this.ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
      });
    }

    const gpu = (globalThis as any).navigator?.gpu;
    this.executionProvider = selectedEp;
    console.log(`[YOLO] ONNX session created, EP: ${selectedEp} | navigator.gpu: ${!!gpu}`);

    // Single warm-up inference: kernel compilation (the only fixed cost we
    // need to pay before the first real frame). One zero-tensor run is enough
    // to trigger compilation; further benchmark runs and a WASM-reference
    // session were dropped — together they added ~6 s to cold start without
    // affecting steady-state performance.
    try {
      const inputSize = 640;
      const zero = new Float32Array(1 * 3 * inputSize * inputSize);
      const tensor = new this.ort.Tensor('float32', zero, [1, 3, inputSize, inputSize]);
      const feeds: Record<string, unknown> = { [this.session.inputNames[0]]: tensor };
      const t0 = Date.now();
      await this.session.run(feeds);
      console.log(`[YOLO warmup] ${selectedEp}: ${Date.now() - t0}ms`);
    } catch (err) {
      console.log(`[YOLO warmup] skipped (${err})`);
    }
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

    const confThreshold = 0.5;

    // Map detections directly to 8x8 grid, keeping highest confidence per square
    const board: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
    const tiles: TileClassification[] = [];

    for (let i = 0; i < numDetections; i++) {
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
      if (!(maxClass in CLASS_TO_FEN)) continue;

      const cx = outputData[0 * numDetections + i];
      const cy = outputData[1 * numDetections + i];
      const file = Math.min(7, Math.floor(cx * 8));
      const rank = Math.min(7, Math.floor(cy * 8));
      if (file < 0 || file >= 8 || rank < 0 || rank >= 8) continue;

      const piece = CLASS_TO_FEN[maxClass];
      if (!piece) continue;
      const square = indexToSquare(rank, file);
      const existing = tiles.find(t => t.square === square);
      if (!board[rank][file] || maxProb > (existing?.confidence ?? 0)) {
        board[rank][file] = piece;
        const idx = tiles.findIndex(t => t.square === square);
        const tile = { square, piece, confidence: maxProb };
        if (idx >= 0) tiles[idx] = tile;
        else tiles.push(tile);
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

