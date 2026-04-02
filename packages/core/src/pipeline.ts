import type { PipelineResult, EvalResult, ArrowDescriptor, BoardBBox } from './types.js';
import type { PixelBuffer } from './pixel-utils.js';
import type { BoardDetectionResult } from './board-detect.js';
import type { RecognitionResult } from './types.js';
import { computeArrows } from './arrows.js';
import { compareFen, guessTurn, buildFullFen } from './fen.js';

export interface PipelineComponents {
  detectBoard: (data: Uint8ClampedArray, width: number, height: number) => BoardDetectionResult;
  cropAndPrepare: (pixels: PixelBuffer, bbox: BoardBBox) => Uint8Array; // returns 256x256 grayscale
  recognizePieces: (grayscale256: Uint8Array) => Promise<RecognitionResult>;
  evaluate: (fen: string) => Promise<EvalResult>;
}

/**
 * Full analysis pipeline: image → board detection → recognition → evaluation → arrows.
 * Includes deduplication — skips re-evaluation if position hasn't changed.
 */
export class ChessPipeline {
  private lastFen: string | null = null;
  private lastEval: EvalResult | null = null;
  private lastArrows: ArrowDescriptor[] = [];
  private prevPositionFen: string | null = null;

  constructor(private components: PipelineComponents) {}

  async analyze(pixels: PixelBuffer): Promise<PipelineResult> {
    const startTime = Date.now();

    // Stage 1: Board detection
    const detection = this.components.detectBoard(pixels.data, pixels.width, pixels.height);
    if (!detection.found || !detection.bbox) {
      return {
        board_detection: {
          found: false,
          bbox: null,
          confidence: detection.confidence,
        },
        recognition: null,
        evaluation: null,
        arrows: [],
        total_elapsed_ms: Date.now() - startTime,
      };
    }

    // Stage 2: Crop and prepare for recognition
    const grayscale = this.components.cropAndPrepare(pixels, detection.bbox);

    // Stage 3: Piece recognition
    const recognition = await this.components.recognizePieces(grayscale);

    // Stage 4: Check if position changed (dedup)
    const positionFen = recognition.fen;
    if (this.lastFen && compareFen(this.lastFen, positionFen) && this.lastEval) {
      // Position unchanged — return cached evaluation
      return {
        board_detection: {
          found: true,
          bbox: detection.bbox,
          confidence: detection.confidence,
        },
        recognition,
        evaluation: this.lastEval,
        arrows: this.lastArrows,
        total_elapsed_ms: Date.now() - startTime,
      };
    }

    // Stage 5: Determine turn and build full FEN
    const turn = guessTurn(this.prevPositionFen, positionFen);
    const fullFen = buildFullFen(positionFen, turn);
    this.prevPositionFen = positionFen;

    // Stage 6: Stockfish evaluation
    const evaluation = await this.components.evaluate(fullFen);

    // Stage 7: Compute arrows
    const arrows = computeArrows(evaluation.top_moves);

    // Cache results
    this.lastFen = fullFen;
    this.lastEval = evaluation;
    this.lastArrows = arrows;

    return {
      board_detection: {
        found: true,
        bbox: detection.bbox,
        confidence: detection.confidence,
      },
      recognition,
      evaluation,
      arrows,
      total_elapsed_ms: Date.now() - startTime,
    };
  }

  /** Reset cached state (e.g., when starting a new game) */
  reset(): void {
    this.lastFen = null;
    this.lastEval = null;
    this.lastArrows = [];
    this.prevPositionFen = null;
  }
}
