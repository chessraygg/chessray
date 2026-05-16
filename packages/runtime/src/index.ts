// Host-agnostic analysis pipeline. Both Electron's analysis.ts and the
// Chrome extension's offscreen.ts mount a single FrameProcessor instance
// from this package and feed it captured frames.

export * from './frame-processor.js';
export * from './eval-cache.js';
export * from './change-detect.js';
