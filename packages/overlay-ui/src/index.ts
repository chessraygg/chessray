// Host-agnostic overlay UI: canvas renderer + debug panel + slow-frame
// history + piece SVGs + preferences. Phase 3a — these six modules are
// pure DOM/localStorage code with no host coupling. The host bootstrap
// (overlay.ts in Electron, content/overlay.ts in the extension) is still
// host-specific for now; it will be lifted in Phase 3b.

export * from './canvas-renderer.js';
export * from './debug-panel.js';
export * from './debug-history.js';
export * from './piece-svg.js';
export * from './preferences.js';
export * from './split-layout.js';
