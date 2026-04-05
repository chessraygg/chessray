import { contextBridge, ipcRenderer } from 'electron';

/** Typed API exposed to renderer processes via window.chessRay */
const api = {
  // Analysis renderer: receive capture commands
  onStartCapture: (cb: (sourceId: string) => void) =>
    ipcRenderer.on('start-capture', (_e, sourceId: string) => cb(sourceId)),
  onStopCapture: (cb: () => void) =>
    ipcRenderer.on('stop-capture', () => cb()),

  // Analysis renderer: signal ready and get pending source ID
  sendRendererReady: () =>
    ipcRenderer.send('renderer-ready'),
  getSourceId: (): Promise<string | null> =>
    ipcRenderer.invoke('get-source-id'),

  // Analysis renderer: send results back
  sendFrameResult: (result: unknown) =>
    ipcRenderer.send('frame-result', result),
  sendDebugLog: (msg: string) =>
    ipcRenderer.send('debug-log', msg),

  // Overlay renderer: receive results
  onFrameResult: (cb: (result: unknown) => void) =>
    ipcRenderer.on('frame-result', (_e, result: unknown) => cb(result)),
  onStopTracking: (cb: () => void) =>
    ipcRenderer.on('stop-tracking', () => cb()),

  // Overlay renderer: mouse passthrough control
  setMousePassthrough: (passthrough: boolean) =>
    ipcRenderer.send('set-mouse-passthrough', passthrough),

  // Display info for coordinate mapping
  onDisplayInfo: (cb: (info: any) => void) =>
    ipcRenderer.on('display-info', (_e, info: any) => cb(info)),

  // Source visibility (overlay show/hide when tracked app is not frontmost)
  onSourceVisibility: (cb: (visible: boolean) => void) =>
    ipcRenderer.on('source-visibility', (_e, visible: boolean) => cb(visible)),

  // Source picker
  getSources: (): Promise<Electron.DesktopCapturerSource[]> =>
    ipcRenderer.invoke('get-sources'),
  selectSource: (id: string) =>
    ipcRenderer.send('select-source', id),
  reopenPicker: () =>
    ipcRenderer.send('reopen-picker'),

  // Engine settings
  setMaxDepth: (depth: number) =>
    ipcRenderer.send('set-max-depth', depth),
  onSetMaxDepth: (cb: (depth: number) => void) =>
    ipcRenderer.on('set-max-depth', (_e, depth: number) => cb(depth)),

  // Panel reset
  onResetPanelPosition: (cb: () => void) =>
    ipcRenderer.on('reset-panel-position', () => cb()),

  // Window controls
  minimizeApp: () =>
    ipcRenderer.send('minimize-app'),
  closeApp: () =>
    ipcRenderer.send('close-app'),
};

contextBridge.exposeInMainWorld('chessRay', api);

export type ChessRayAPI = typeof api;
