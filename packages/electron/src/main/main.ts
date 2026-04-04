import { app, BrowserWindow, desktopCapturer, ipcMain, protocol, screen, session, systemPreferences } from 'electron';
import path from 'path';
import fs from 'fs';
import { platform } from './platform.js';

const LOG = platform.logPath;

fs.writeFileSync(LOG, `[main] Process started at ${new Date().toISOString()}\n`);
process.on('uncaughtException', (err) => {
  fs.appendFileSync(LOG, `[main] UNCAUGHT: ${err.stack}\n`);
});
process.on('unhandledRejection', (err) => {
  fs.appendFileSync(LOG, `[main] UNHANDLED REJECTION: ${err}\n`);
});

// Register custom protocol scheme before app ready (required for <script src="chess-vendor://...">)
protocol.registerSchemesAsPrivileged([{
  scheme: 'chess-vendor',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

let analysisWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

// Vendor files live at repo root: ../../vendor relative to this package
// In dev: __dirname is packages/electron/.vite/build, vendor is at repo root
const VENDOR_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'vendor')
  : path.resolve(__dirname, '../../../../vendor');

function getPreloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

function createAnalysisWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // needed for ONNX WASM
      webSecurity: false, // allow cross-origin workers (chess-vendor:// from localhost)
      backgroundThrottling: false, // prevent Chromium from throttling timers in this hidden window
    },
  });

  // In dev, Vite serves renderers; in production, load from disk
  if (ANALYSIS_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(ANALYSIS_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${ANALYSIS_WINDOW_VITE_NAME}/index.html`));
  }

  win.webContents.on('console-message', (_e, _level, message) => {
    fs.appendFileSync(LOG, `[analysis-renderer] ${message}\n`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    fs.appendFileSync(LOG, `[analysis-renderer] LOAD FAILED: ${code} ${desc}\n`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    fs.appendFileSync(LOG, `[analysis-renderer] CRASHED: ${JSON.stringify(details)}\n`);
  });

  return win;
}

function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  // Use full display size so overlay covers fullscreen apps too
  const { width, height } = display.size;

  const win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    ...platform.overlayWindowOptions,
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Click-through by default
  win.setIgnoreMouseEvents(true, { forward: true });

  // Exclude overlay from screen capture to prevent self-detection
  win.setContentProtection(true);

  // Platform-specific always-on-top and workspace behavior
  platform.configureOverlayWindow(win);

  if (OVERLAY_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(OVERLAY_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${OVERLAY_WINDOW_VITE_NAME}/index.html`));
  }

  // Send display metrics so the overlay can map frame→screen coordinates.
  // Also re-send when the overlay moves/resizes (e.g. entering/leaving fullscreen).
  const sendDisplayInfo = () => {
    const display = screen.getPrimaryDisplay();
    const bounds = win.getBounds();
    const info = {
      size: display.size,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      overlayBounds: bounds,
    };
    fs.appendFileSync(LOG,
      `[chessray] Display: size=${JSON.stringify(display.size)} workArea=${JSON.stringify(display.workArea)} scale=${display.scaleFactor} overlayBounds=${JSON.stringify(bounds)}\n`);
    win.webContents.send('display-info', info);
  };
  win.webContents.once('did-finish-load', sendDisplayInfo);
  win.on('move', sendDisplayInfo);
  win.on('resize', sendDisplayInfo);

  win.show();
  return win;
}

/** Get the primary screen source ID */
async function getPrimaryScreenSourceId(): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  const primary = sources[0];
  if (!primary) throw new Error('No screen source found');
  console.log(`[chessray] Auto-selected screen source: ${primary.id} (${primary.name})`);
  return primary.id;
}

// Serve vendor files via custom protocol so renderers can load them
// URLs look like: chess-vendor://onnxruntime-web/ort.webgpu.min.js
// where hostname = first path segment, pathname = rest
function registerVendorProtocol(): void {
  session.defaultSession.protocol.handle('chess-vendor', (request) => {
    const url = new URL(request.url);
    // hostname is the first path segment (e.g., "onnxruntime-web")
    // pathname is the rest (e.g., "/ort.webgpu.min.js")
    const relativePath = path.join(decodeURIComponent(url.hostname), decodeURIComponent(url.pathname));
    const filePath = path.join(VENDOR_PATH, relativePath);
    return new Response(fs.readFileSync(filePath), {
      headers: { 'Content-Type': guessMimeType(filePath) },
    });
  });
}

function guessMimeType(filePath: string): string {
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'application/javascript';
  if (filePath.endsWith('.wasm')) return 'application/wasm';
  if (filePath.endsWith('.onnx')) return 'application/octet-stream';
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

// ── Source visibility tracking ──
// For window captures, hide overlay when the tracked app is not frontmost.
// Screen captures are always visible.

let trackedPid: string | null = null;
let visibilityInterval: ReturnType<typeof setInterval> | null = null;
let sourceVisible = true;

function startVisibilityTracking(sourceId: string): void {
  stopVisibilityTracking();
  sourceVisible = true;

  // Screen captures: always visible, no tracking needed
  if (sourceId.startsWith('screen:')) return;

  // Extract PID from "window:PID:index"
  const parts = sourceId.split(':');
  trackedPid = parts[1] ?? null;
  if (!trackedPid) return;

  visibilityInterval = setInterval(async () => {
    const frontPid = await platform.getFrontmostPid();
    if (!frontPid) return;
    // Also treat our own app as "visible" (user interacting with debug panel)
    const isOurApp = frontPid === String(process.pid);
    const visible = frontPid === trackedPid || isOurApp;
    if (visible !== sourceVisible) {
      sourceVisible = visible;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('source-visibility', visible);
      }
    }
  }, 500);
}

function stopVisibilityTracking(): void {
  if (visibilityInterval) {
    clearInterval(visibilityInterval);
    visibilityInterval = null;
  }
  trackedPid = null;
  sourceVisible = true;
}

// ── IPC handlers ──

let pendingSourceId: string | null = null;
let rendererReady = false;
let retryInterval: ReturnType<typeof setInterval> | null = null;

function startCapture(sourceId: string): void {
  console.log(`[chessray] Starting capture: ${sourceId}`);
  fs.appendFileSync(LOG, `[chessray] Starting capture: ${sourceId}\n`);

  pendingSourceId = sourceId;
  rendererReady = false;

  // Create analysis + overlay windows if not yet created
  if (!analysisWindow || analysisWindow.isDestroyed()) {
    analysisWindow = createAnalysisWindow();
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = createOverlayWindow();
  }

  // Retry sending start-capture every 2s until renderer acknowledges
  if (retryInterval) clearInterval(retryInterval);
  retryInterval = setInterval(() => {
    if (rendererReady) {
      clearInterval(retryInterval!);
      retryInterval = null;
      return;
    }
    fs.appendFileSync(LOG, `[chessray] Retrying start-capture (renderer not ready yet)\n`);
    if (analysisWindow && !analysisWindow.isDestroyed()) {
      analysisWindow.webContents.send('start-capture', pendingSourceId);
    }
  }, 2000);
}

// Analysis renderer signals it's ready to receive commands
ipcMain.on('renderer-ready', () => {
  fs.appendFileSync(LOG, `[chessray] Analysis renderer ready\n`);
  rendererReady = true;
  if (pendingSourceId && analysisWindow && !analysisWindow.isDestroyed()) {
    analysisWindow.webContents.send('start-capture', pendingSourceId);
  }
});

// Analysis module requests the pending source ID (pull model — works regardless of timing)
ipcMain.handle('get-source-id', () => {
  return pendingSourceId;
});

// Forward frame results from analysis → overlay
ipcMain.on('frame-result', (_e, result) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('frame-result', result);
  }
});

ipcMain.on('debug-log', (_e, msg: string) => {
  console.log(`[chessray] ${msg}`);
  fs.appendFileSync(LOG, `[chessray] ${msg}\n`);
});

// Overlay mouse passthrough toggle
ipcMain.on('set-mouse-passthrough', (_e, passthrough: boolean) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(passthrough, { forward: true });
  }
});

// Window controls
ipcMain.on('minimize-app', () => {
  app.hide();
});

ipcMain.on('close-app', () => {
  app.quit();
});

ipcMain.on('set-max-depth', (_e, depth: number) => {
  if (analysisWindow && !analysisWindow.isDestroyed()) {
    analysisWindow.webContents.send('set-max-depth', depth);
  }
});

// ── App lifecycle ──

// Enforce single instance — quit if another copy is already running
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(() => {
  app.setName('ChessRay');
  platform.showInDock(app);
  registerVendorProtocol();

  // Grant screen capture permissions
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // Allow all display media requests (source is selected via our picker)
    callback({});
  });

  const screenStatus = platform.getScreenCaptureStatus(systemPreferences);
  fs.writeFileSync(LOG, `[chessray] App ready. Screen status=${screenStatus} platform=${process.platform} (trying capture)\n`);
  getPrimaryScreenSourceId()
    .then((sourceId) => startCapture(sourceId))
    .catch((err) => {
      fs.appendFileSync(LOG, `[chessray] Failed to get screen source: ${err}\n`);
      console.error(`[chessray] Failed to get screen source: ${err}`);
    });
});

app.on('window-all-closed', () => {
  if (platform.quitOnAllWindowsClosed) app.quit();
});


// Vite dev server URL declarations (injected by @electron-forge/plugin-vite)
declare const ANALYSIS_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const ANALYSIS_WINDOW_VITE_NAME: string;
declare const OVERLAY_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const OVERLAY_WINDOW_VITE_NAME: string;
