import type { BoardBBox } from './types.js';
import type { PixelBuffer } from './pixel-utils.js';
import { cropPixels } from './pixel-utils.js';
import { detectBoard, type BoardDetectionResult } from './board-detect.js';
import { recognizeBoard, type BoardRecognitionResult } from './recognize-board.js';
import type { OrientationResult } from './image-utils.js';

export interface DetectionPipelineResult extends BoardRecognitionResult {
  /** Board was found in the frame */
  found: boolean;
  /** Refined board bounding box (null when not found) */
  bbox: BoardBBox | null;
  /** Rough YOLO bounding box before refinement (null when not found) */
  roughBbox: BoardBBox | null;
  /** YOLO detection confidence */
  confidence: number;
  /** Board square size in pixels */
  squareSize: number;
}

/**
 * Full detection pipeline: screenshot → board detection + recognition.
 *
 * Single entry point that combines YOLO board detection, bbox refinement,
 * cropping, piece recognition, highlight detection, orientation, and turn.
 * Both production (analysis.ts) and tests use this function.
 */
export async function runDetectionPipeline(
  session: any,
  ort: any,
  recognizer: { recognize(imageData: ImageData): Promise<any> },
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cachedOrientation?: { prevFen: string; orientation: OrientationResult } | null,
): Promise<DetectionPipelineResult> {
  const detection = await detectBoard(session, ort, data, width, height);

  if (!detection.found || !detection.bbox) {
    return {
      found: false,
      bbox: null,
      roughBbox: null,
      confidence: 0,
      squareSize: 0,
      rawFen: '',
      correctedFen: '',
      fullFen: null,
      recognition: null as any,
      highlightedSquares: [],
      flipped: false,
      turn: null,
      orientationSource: 'piece_count',
      midAnimation: false,
      highlightColors: [],
      highlightScores: [],
      highlightMedians: { light: [0, 0, 0], dark: [0, 0, 0] },
      timing: { pieces_ms: 0, orientation_ms: 0, highlights_ms: 0, disambiguate_ms: 0, pawnRefine_ms: 0, turn_ms: 0, total_ms: detection.elapsed_ms },
    };
  }

  const bbox = detection.bbox;
  const cropped = cropPixels({ data, width, height }, bbox);
  const boardResult = await recognizeBoard(cropped, recognizer, cachedOrientation);

  return {
    found: true,
    bbox,
    roughBbox: detection.roughBbox,
    confidence: detection.confidence,
    squareSize: Math.round(bbox.width / 8),
    ...boardResult,
  };
}
