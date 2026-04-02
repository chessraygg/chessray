import type { BoardBBox } from './types.js';
import { refineBbox } from './bbox-refine.js';
import type { PixelBuffer } from './pixel-utils.js';

export interface BoardDetectionResult {
  found: boolean;
  bbox: BoardBBox | null;
  roughBbox: BoardBBox | null;
  confidence: number;
  elapsed_ms: number;
}

interface RawDetection {
  cx: number; cy: number; w: number; h: number;
  confidence: number; classId: number;
}

/**
 * Detect the chessboard using the YOLO model's class-0 (board) detection.
 * Runs inference on the full frame and returns the highest-confidence board bbox.
 *
 * @param session ONNX InferenceSession (same model used for piece recognition)
 * @param ort ONNX Runtime module (for creating tensors)
 * @param data RGBA pixel data
 * @param width image width
 * @param height image height
 */
export async function detectBoard(
  session: any,
  ort: any,
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<BoardDetectionResult> {
  const t0 = Date.now();
  if (!session) throw new Error('ONNX session not loaded');

  const inputSize = 640;

  // Resize full frame to 640x640, CHW float32
  const tensorData = new Float32Array(3 * inputSize * inputSize);
  for (let y = 0; y < inputSize; y++) {
    for (let x = 0; x < inputSize; x++) {
      const sx = Math.floor(x * width / inputSize);
      const sy = Math.floor(y * height / inputSize);
      const si = (sy * width + sx) * 4;
      const di = y * inputSize + x;
      tensorData[di] = data[si] / 255.0;
      tensorData[inputSize * inputSize + di] = data[si + 1] / 255.0;
      tensorData[2 * inputSize * inputSize + di] = data[si + 2] / 255.0;
    }
  }

  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]);
  const results = await session.run({ [session.inputNames[0]]: inputTensor });
  const output = results[session.outputNames[0]];
  const outputData = output.data as Float32Array;
  const numDetections = output.dims[2];
  const numChannels = output.dims[1];

  // Find all class-0 (board) detections
  const boardDetections: RawDetection[] = [];
  for (let i = 0; i < numDetections; i++) {
    // Class 0 = board (channel index 4)
    const boardProb = outputData[4 * numDetections + i];
    if (boardProb < 0.3) continue;

    // Check it's actually the best class for this detection
    let maxProb = 0;
    let maxClass = 0;
    for (let c = 4; c < numChannels; c++) {
      const prob = outputData[c * numDetections + i];
      if (prob > maxProb) { maxProb = prob; maxClass = c - 4; }
    }
    if (maxClass !== 0) continue;

    const cx = outputData[0 * numDetections + i];
    const cy = outputData[1 * numDetections + i];
    const w = outputData[2 * numDetections + i];
    const h = outputData[3 * numDetections + i];

    boardDetections.push({ cx, cy, w, h, confidence: boardProb, classId: 0 });
  }

  if (boardDetections.length === 0) {
    return { found: false, bbox: null, roughBbox: null, confidence: 0, elapsed_ms: Date.now() - t0 };
  }

  // Pick the largest board detection (main board, not thumbnails).
  // Among similar-sized boards, prefer higher confidence.
  boardDetections.sort((a, b) => {
    const areaA = a.w * a.h;
    const areaB = b.w * b.h;
    if (Math.abs(areaA - areaB) > 0.01) return areaB - areaA;
    return b.confidence - a.confidence;
  });
  const best = boardDetections[0];

  // Convert normalized coords to pixel coords (rough bbox)
  const bx = Math.round((best.cx - best.w / 2) * width);
  const by = Math.round((best.cy - best.h / 2) * height);
  const bw = Math.round(best.w * width);
  const bh = Math.round(best.h * height);
  const size = Math.max(bw, bh);
  const roughBbox: BoardBBox = { x: Math.max(0, bx), y: Math.max(0, by), width: size, height: size };

  // Refine bbox by finding exact board edges within the rough crop
  const refined = refineBbox({ data, width, height }, roughBbox);

  return {
    found: true,
    bbox: refined,
    roughBbox: roughBbox,
    confidence: best.confidence,
    elapsed_ms: Date.now() - t0,
  };
}
