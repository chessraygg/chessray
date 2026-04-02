/** IPC channel constants shared between main, preload, and renderers */
export const IPC = {
  // Main → Analysis
  START_CAPTURE: 'start-capture',
  STOP_CAPTURE: 'stop-capture',

  // Analysis → Main → Overlay
  FRAME_RESULT: 'frame-result',

  // Analysis → Main (debug)
  DEBUG_LOG: 'debug-log',

  // Overlay → Main
  SET_MOUSE_PASSTHROUGH: 'set-mouse-passthrough',

  // Renderer → Main (source picker)
  GET_SOURCES: 'get-sources',
  SELECT_SOURCE: 'select-source',

  // Main → Overlay
  STOP_TRACKING: 'stop-tracking',
} as const;
