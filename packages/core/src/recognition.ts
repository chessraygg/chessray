import type { RecognitionResult, TileClassification } from './types.js';
import { indexToSquare } from './fen.js';

// The 13 classes the model predicts
const PIECE_LABELS = ['.', 'b', 'k', 'n', 'p', 'q', 'r', 'B', 'K', 'N', 'P', 'Q', 'R'] as const;

export interface TensorLike {
  data(): Promise<Float32Array>;
  shape: number[];
  dispose(): void;
}

export interface TfModel {
  predict(input: TensorLike): TensorLike;
}

export interface TfOps {
  tensor4d(data: Float32Array | Uint8Array, shape: [number, number, number, number]): TensorLike;
  tensor?(data: Float32Array, shape: number[]): TensorLike;
  loadLayersModel?(path: string): Promise<TfModel>;
  loadGraphModel?(modelUrl: string): Promise<TfModel>;
}

/**
 * Piece recognizer using a TensorFlow.js model.
 * Batches all 64 tiles into a single prediction for speed.
 */
export class PieceRecognizer {
  private model: TfModel | null = null;

  constructor(private modelPath: string, private tf: TfOps) {}

  async load(): Promise<void> {
    if (this.tf.loadLayersModel) {
      this.model = await this.tf.loadLayersModel(this.modelPath);
    } else if (this.tf.loadGraphModel) {
      this.model = await this.tf.loadGraphModel(this.modelPath);
    } else {
      throw new Error('No model loader available');
    }
  }

  /**
   * Classify a 256x256 grayscale chessboard image.
   * Batches all 64 tiles (32x32 each) into one prediction call.
   */
  async classify(grayscale256: Uint8Array | Float32Array): Promise<RecognitionResult> {
    if (!this.model) throw new Error('Model not loaded. Call load() first.');

    const startTime = Date.now();

    // Extract all 64 tiles into a single batch tensor [64, 32, 32, 1]
    // Normalize each tile's contrast so the background (empty square) maps
    // to a consistent brightness regardless of board color scheme.
    const batchData = new Float32Array(64 * 32 * 32);
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const tileIdx = rank * 8 + file;
        const tileOffset = tileIdx * 32 * 32;

        // First pass: find min/max for this tile
        let minVal = 255, maxVal = 0;
        for (let ty = 0; ty < 32; ty++) {
          for (let tx = 0; tx < 32; tx++) {
            const srcIdx = (rank * 32 + ty) * 256 + (file * 32 + tx);
            const v = grayscale256[srcIdx] ?? 0;
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
        }

        // Normalize: stretch contrast to 0-255 range, then to 0-1
        const range = maxVal - minVal;
        const scale = range > 20 ? 255 / range : 1; // Don't normalize nearly-flat tiles (empty squares)

        for (let ty = 0; ty < 32; ty++) {
          for (let tx = 0; tx < 32; tx++) {
            const srcIdx = (rank * 32 + ty) * 256 + (file * 32 + tx);
            const v = grayscale256[srcIdx] ?? 0;
            if (range > 20) {
              // Tile has a piece — normalize contrast
              batchData[tileOffset + ty * 32 + tx] = Math.min(1, Math.max(0, (v - minVal) * scale / 255));
            } else {
              // Empty tile — pass through as-is
              batchData[tileOffset + ty * 32 + tx] = v / 255.0;
            }
          }
        }
      }
    }

    // Single batched prediction
    const input = this.tf.tensor4d(batchData, [64, 32, 32, 1]);
    const output = this.model.predict(input);
    const allProbs = await output.data();
    input.dispose();
    output.dispose();

    // Parse results — allProbs is [64 * 13] (64 tiles, 13 classes each)
    const tiles: TileClassification[] = [];
    let totalConfidence = 0;
    const fenRows: string[] = [];

    for (let rank = 0; rank < 8; rank++) {
      let fenRow = '';
      let emptyCount = 0;

      for (let file = 0; file < 8; file++) {
        const tileIdx = rank * 8 + file;
        const probOffset = tileIdx * 13;

        let maxProb = 0;
        let maxIdx = 0;
        for (let i = 0; i < 13; i++) {
          if (allProbs[probOffset + i] > maxProb) {
            maxProb = allProbs[probOffset + i];
            maxIdx = i;
          }
        }

        const piece = PIECE_LABELS[maxIdx] ?? '.';
        const square = indexToSquare(rank, file);
        tiles.push({ square, piece, confidence: maxProb });
        totalConfidence += maxProb;

        if (piece === '.') {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            fenRow += emptyCount;
            emptyCount = 0;
          }
          fenRow += piece;
        }
      }

      if (emptyCount > 0) fenRow += emptyCount;
      fenRows.push(fenRow);
    }

    return {
      fen: fenRows.join('/'),
      confidence: totalConfidence / 64,
      tiles,
      elapsed_ms: Date.now() - startTime,
    };
  }
}
