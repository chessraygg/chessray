import type { RecognitionResult } from './types.js';

/**
 * Common interface for all piece recognition implementations.
 */
export interface PieceRecognizerInterface {
  load(): Promise<void>;
  recognize(imageData: ImageData): Promise<RecognitionResult>;
}
