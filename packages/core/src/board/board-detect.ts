import type { BoardBBox } from '../types.js';
import { refineBbox } from './bbox-refine.js';

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
 * @param previousBbox Last accepted bbox (pixel coords). When supplied, hysteresis
 *   prefers a candidate matching it whenever competing candidates are similar in
 *   area and confidence — prevents flicker between two same-size boards on screen.
 */
export async function detectBoard(
  session: any,
  ort: any,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  previousBbox?: BoardBBox | null,
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
  const numDetections = output.dims[2];
  const numChannels = output.dims[1];
  // COPY outputData out of the tensor before disposing — on WASM
  // tensor.data is a view into ORT-managed memory that becomes invalid
  // after dispose(). Disposing input + every output releases GPU buffer
  // handles (WebGPU) / WASM-heap allocations (WASM) that otherwise
  // accumulate per inference.
  const outputData = new Float32Array(output.data as Float32Array);
  try { (inputTensor as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
  for (const k of Object.keys(results)) {
    try { (results[k] as { dispose?: () => void }).dispose?.(); } catch { /* ignore */ }
  }

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
  let best = boardDetections[0];

  // Hysteresis: when two boards of similar size compete (e.g., a YouTube video
  // showing a board next to a real board of matching dimensions), per-frame
  // YOLO confidence jitter flips the winner frame to frame. If the caller
  // supplied the previously accepted bbox, find the candidate that overlaps it
  // (high IoU) and stick with it unless another candidate beats it by a clear
  // confidence margin or has a clearly larger area.
  if (previousBbox && boardDetections.length > 1) {
    const prevCxN = (previousBbox.x + previousBbox.width / 2) / width;
    const prevCyN = (previousBbox.y + previousBbox.height / 2) / height;
    const prevWN = previousBbox.width / width;
    const prevHN = previousBbox.height / height;

    let sticky: RawDetection | null = null;
    let stickyIou = 0;
    for (const c of boardDetections) {
      const iou = boxIou(c.cx, c.cy, c.w, c.h, prevCxN, prevCyN, prevWN, prevHN);
      if (iou > stickyIou) { stickyIou = iou; sticky = c; }
    }

    if (sticky && sticky !== best && stickyIou > 0.5) {
      const bestArea = best.w * best.h;
      const stickyArea = sticky.w * sticky.h;
      const areaSimilar = Math.abs(bestArea - stickyArea) <= 0.01;
      const confDelta = best.confidence - sticky.confidence;
      if (areaSimilar && confDelta < 0.10) {
        best = sticky;
      }
    }
  }

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

function boxIou(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): number {
  const ax1 = ax - aw / 2, ay1 = ay - ah / 2, ax2 = ax + aw / 2, ay2 = ay + ah / 2;
  const bx1 = bx - bw / 2, by1 = by - bh / 2, bx2 = bx + bw / 2, by2 = by + bh / 2;
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = iw * ih;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}
