import type { RecognitionResult, TileClassification } from './types.js';
import type { PieceRecognizerInterface } from './recognition-interface.js';
import { indexToSquare } from './fen.js';

/**
 * Tile-based piece classifier using TensorFlow.js.
 * Splits a 256x256 board image into 64 tiles of 32x32 and classifies each.
 * Trained on lichess green/white boards (Elucidation/ChessboardFenTensorflowJs).
 */

const PIECE_LABELS = ['.', 'b', 'k', 'n', 'p', 'q', 'r', 'B', 'K', 'N', 'P', 'Q', 'R'] as const;

export class TilePieceRecognizer implements PieceRecognizerInterface {
  private model: any = null;
  private tf: any = null;

  constructor(private modelUrl: string) {}

  async load(): Promise<void> {
    this.tf = (globalThis as any).tf;
    if (!this.tf) throw new Error('TensorFlow.js not loaded');
    this.model = await this.tf.loadLayersModel(this.modelUrl);
  }

  async recognize(imageData: ImageData): Promise<RecognitionResult> {
    if (!this.model) throw new Error('Model not loaded');
    const startTime = Date.now();

    const { width, height, data } = imageData;

    // Convert to grayscale and resize to 256x256
    const gray256 = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const sx = Math.floor(x * width / 256);
        const sy = Math.floor(y * height / 256);
        const si = (sy * width + sx) * 4;
        gray256[y * 256 + x] = Math.round(0.299 * data[si] + 0.587 * data[si + 1] + 0.114 * data[si + 2]);
      }
    }

    // Batch all 64 tiles into [64, 32, 32, 1]
    const batchData = new Float32Array(64 * 32 * 32);
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const tileIdx = rank * 8 + file;
        const tileOffset = tileIdx * 32 * 32;

        // No normalization — pass raw grayscale values to model
        for (let ty = 0; ty < 32; ty++) {
          for (let tx = 0; tx < 32; tx++) {
            const v = gray256[(rank * 32 + ty) * 256 + (file * 32 + tx)];
            batchData[tileOffset + ty * 32 + tx] = v / 255.0;
          }
        }
      }
    }

    const input = this.tf.tensor4d(batchData, [64, 32, 32, 1]);
    const output = this.model.predict(input);
    const allProbs = await output.data();
    input.dispose();
    output.dispose();

    const tiles: TileClassification[] = [];
    let totalConfidence = 0;
    const fenRows: string[] = [];

    for (let rank = 0; rank < 8; rank++) {
      let fenRow = '', emptyCount = 0;
      for (let file = 0; file < 8; file++) {
        const off = (rank * 8 + file) * 13;
        let maxP = 0, maxI = 0;
        for (let i = 0; i < 13; i++) {
          if (allProbs[off + i] > maxP) { maxP = allProbs[off + i]; maxI = i; }
        }
        const piece = PIECE_LABELS[maxI] ?? '.';
        tiles.push({ square: indexToSquare(rank, file), piece, confidence: maxP });
        totalConfidence += maxP;

        if (piece === '.') { emptyCount++; }
        else { if (emptyCount > 0) { fenRow += emptyCount; emptyCount = 0; } fenRow += piece; }
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
