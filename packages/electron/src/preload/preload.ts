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
  setAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.send('set-always-on-top', enabled),

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
  setMultiPvMax: (n: number) =>
    ipcRenderer.send('set-multi-pv-max', n),
  onSetMultiPvMax: (cb: (n: number) => void) =>
    ipcRenderer.on('set-multi-pv-max', (_e, n: number) => cb(n)),

  // Change detection
  setChangeDetect: (enabled: boolean) =>
    ipcRenderer.send('set-change-detect', enabled),
  onSetChangeDetect: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on('set-change-detect', (_e, enabled: boolean) => cb(enabled)),

  // Manual orientation override (null = auto-detect, true/false = user choice)
  setManualFlip: (v: boolean | null) =>
    ipcRenderer.send('set-manual-flip', v),
  onSetManualFlip: (cb: (v: boolean | null) => void) =>
    ipcRenderer.on('set-manual-flip', (_e, v: boolean | null) => cb(v)),

  // Frame rate
  setTargetFps: (fps: number) =>
    ipcRenderer.send('set-target-fps', fps),
  onSetTargetFps: (cb: (fps: number) => void) =>
    ipcRenderer.on('set-target-fps', (_e, fps: number) => cb(fps)),

  // Panel reset
  onResetPanelPosition: (cb: () => void) =>
    ipcRenderer.on('reset-panel-position', () => cb()),

  // Panel show/hide toggle (driven by global shortcut + dock menu)
  onTogglePanel: (cb: () => void) =>
    ipcRenderer.on('toggle-panel', () => cb()),

  // Wipe saved prefs and reload the overlay (dock-menu "Reset All Settings")
  onResetAllSettings: (cb: () => void) =>
    ipcRenderer.on('reset-all-settings', () => cb()),

  // Trigger the same flows the dock menu does (so the in-panel System group
  // mirrors the dock menu without re-implementing dialogs / display logic).
  requestResetPanelPosition: () =>
    ipcRenderer.send('request-reset-panel-position'),
  requestResetAllSettings: () =>
    ipcRenderer.send('request-reset-all-settings'),
  getDisplays: (): Promise<{ id: number; width: number; height: number; primary: boolean; activeId: number | null }[]> =>
    ipcRenderer.invoke('get-displays'),
  switchDisplay: (id: number) =>
    ipcRenderer.send('switch-display', id),
  onDisplaysChanged: (cb: () => void) =>
    ipcRenderer.on('displays-changed', () => cb()),

  // Frame recording (test fixture capture)
  startRecording: () => ipcRenderer.send('start-recording'),
  stopRecording: () => ipcRenderer.send('stop-recording'),
  onRecordingStateChanged: (cb: (active: boolean, sessionDir: string | null) => void) =>
    ipcRenderer.on('recording-state-changed', (_e, active: boolean, dir: string | null) => cb(active, dir)),
  saveFrameArtifact: (filename: string, buf: Uint8Array) =>
    ipcRenderer.send('save-frame-artifact', filename, buf),

  // Window controls
  minimizeApp: () =>
    ipcRenderer.send('minimize-app'),
  closeApp: () =>
    ipcRenderer.send('close-app'),
  openExternal: (url: string) =>
    ipcRenderer.send('open-external', url),
  toggleLichess: (fen: string, color: string) =>
    ipcRenderer.send('toggle-lichess', fen, color),
  updateLichess: (fen: string, color: string) =>
    ipcRenderer.send('update-lichess', fen, color),
};

contextBridge.exposeInMainWorld('chessRay', api);

export type ChessRayAPI = typeof api;
