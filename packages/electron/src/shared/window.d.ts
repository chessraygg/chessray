import type { ChessRayAPI } from '../preload/preload.js';

declare global {
  interface Window {
    chessRay: ChessRayAPI;
  }
}

export {};
