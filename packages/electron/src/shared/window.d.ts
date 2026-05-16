// Ambient global declaration so Electron's renderer code (analysis +
// overlay) can use `window.chessRay.X` without per-call casts. The
// canonical interface lives in @chessray/overlay-ui; this file just
// merges it onto the global Window type.

import type { ChessRayAPI } from '@chessray/overlay-ui';

declare global {
  interface Window {
    chessRay: ChessRayAPI;
  }
}

export {};
