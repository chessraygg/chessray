/**
 * Popup: hosts the full @chessray/overlay-ui panel. Same canvas-renderer,
 * eval bar, top-moves list, settings and diagnostics the Electron app
 * uses; the only popup-specific addition is the Start/Stop strip at the
 * top, since the extension can't auto-start (tabCapture needs a popup
 * user-gesture grant).
 *
 * IMPORTANT: chrome.tabCapture.getMediaStreamId requires the user
 * activation to still be fresh at call time. ANY `await` between the
 * click event and getMediaStreamId can consume the activation and the
 * call fails with "Extension has not been invoked for the current
 * page (see activeTab permission). Chrome pages cannot be captured."
 *
 * The fix below: resolve tabId at popup load and call getMediaStreamId
 * synchronously from the click handler; only await after the streamId
 * is in hand.
 */

import { mountOverlay, type ChessRayAPI, type DisplayInfo, type HostDisplay } from '@chessray/overlay-ui';
import type { ExtensionMessage, ExtensionSetting } from '../shared/messages.js';
// Popup CSS imported AFTER mountOverlay (which pulls in panel.css from
// overlay-ui) so this file's selectors win on equal-specificity rules
// — body background, panel positioning, etc.
import './popup.css';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('cap-status')!;

// ── Pre-resolve target tabId at popup load ──────────────────────────
//   Done off the click path so awaiting tabs.query doesn't consume the
//   user gesture later. Falls back from currentWindow → lastFocusedWindow
//   so the popup also works when opened as a tab (test harness path).
let cachedTabId: number | null = null;
async function preloadTabId(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const override = params.get('tabId');
  if (override) { cachedTabId = Number(override); return; }
  // Ask the SW which tab Chrome activeTab-granted. That's the tab the
  // user clicked the toolbar action on — the only tab tabCapture is
  // allowed to capture. Falls back to chrome.tabs.query in test contexts
  // where the SW path isn't wired (popup-as-tab in puppeteer harness).
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-target-tab' } satisfies ExtensionMessage);
    if (resp?.tabId != null) { cachedTabId = resp.tabId; return; }
  } catch { /* SW unreachable; fall through */ }
  const isContent = (t: chrome.tabs.Tab | undefined): boolean =>
    !!t?.url && (t.url.startsWith('http://') || t.url.startsWith('https://'));
  const queries: Array<chrome.tabs.QueryInfo> = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { currentWindow: true },
    {},
  ];
  for (const q of queries) {
    const tabs = await chrome.tabs.query(q);
    const t = tabs.find(isContent);
    if (t) { cachedTabId = t.id ?? null; return; }
  }
  cachedTabId = null;
}

// Bootstrap status: ask the SW for actual capture state, then preload
// the tabId. This ordering matters — popups close on focus-loss (e.g.
// when Chrome shows the tab-share indicator), so the user may reopen
// the popup while a capture is already running. Without this query the
// popup would show "Idle" and let the user click Start, hitting the
// "active stream" error path.
startBtn.disabled = true;
setStatus('…');
async function bootstrap(): Promise<void> {
  const [state, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'get-capture-state' } satisfies ExtensionMessage)
      .catch(() => ({ running: false })),
    chrome.storage.session.get('__chessrayPopupStatus').catch(() => ({})),
  ]);
  await preloadTabId();
  startBtn.disabled = false;
  if (state?.running) {
    setStatus(`Running (tab ${state.tabId ?? '?'})`);
    startBtn.classList.add('running');
    return;
  }
  // Show last error if it happened recently (within ~30s), otherwise
  // fall back to Idle. Stale errors don't survive a tab reload.
  const last = stored?.__chessrayPopupStatus as { msg: string; isError: boolean; ts: number } | undefined;
  if (last?.isError && Date.now() - last.ts < 30_000) {
    setStatus(`(prev) ${last.msg}`, true);
    return;
  }
  if (cachedTabId === null) {
    setStatus('No http(s) tab to capture', true);
  } else {
    setStatus(`Idle (tab ${cachedTabId})`);
  }
}
void bootstrap();

// ── Frame-result + display-info plumbing ───────────────────────────────
const frameResultListeners: Array<(r: unknown) => void> = [];
const displayInfoListeners: Array<(info: DisplayInfo) => void> = [];

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'frame-result') {
    for (const cb of frameResultListeners) cb(msg.result);
  }
});

function applySetting(setting: ExtensionSetting): void {
  chrome.runtime.sendMessage({ type: 'apply-setting', setting } satisfies ExtensionMessage).catch(() => {});
}

const noop = (): void => { /* host doesn't support this method */ };

// ── Capture lifecycle ─────────────────────────────────────────────────
//
// Sync call into chrome.tabCapture.getMediaStreamId is critical: any
// preceding await consumes the user-gesture activation and the call
// fails with the activeTab error. Tab id is already cached.

function setStatus(msg: string, isError = false): void {
  status.textContent = msg;
  status.classList.toggle('error', isError);
  // Mirror to chrome.storage.session so reopening the popup (which
  // happens automatically when Chrome's tab-share indicator steals
  // focus) still shows the last status / error.
  void chrome.storage.session.set({
    __chessrayPopupStatus: { msg, isError, ts: Date.now() },
  }).catch(() => {});
}

startBtn.addEventListener('click', () => {
  if (cachedTabId === null) {
    setStatus('No http(s) tab found to capture', true);
    void preloadTabId();
    return;
  }
  const tabId = cachedTabId;
  setStatus('Starting…');
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      const msg = chrome.runtime.lastError?.message ?? 'no stream id';
      if (msg.includes('active stream')) {
        setStatus('Already capturing this tab — press Stop first, then Start again.', true);
      } else if (msg.includes('not been invoked')) {
        setStatus('Click the Chessray toolbar icon (not the popup) to grant tab-capture permission, then click Start.', true);
      } else {
        setStatus(`getMediaStreamId failed (tab ${tabId}): ${msg}`, true);
      }
      return;
    }
    void (async () => {
      try {
        const resp: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({
          type: 'start-capture', tabId, streamId,
        } satisfies ExtensionMessage);
        if (resp?.ok) {
          setStatus('Running');
          startBtn.classList.add('running');
        } else {
          setStatus(`SW error: ${resp?.error ?? 'unknown'}`, true);
        }
      } catch (err) {
        setStatus(`Send failed: ${(err as Error).message}`, true);
      }
    })();
  });
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop-capture' } satisfies ExtensionMessage).catch(() => {});
  setStatus('Stopped');
  startBtn.classList.remove('running');
});

// ── Bridge ─────────────────────────────────────────────────────────────

const bridge: ChessRayAPI = {
  onStartCapture: noop,
  onStopCapture: noop,
  sendRendererReady: noop,
  getSourceId: () => Promise.resolve(null),
  sendFrameResult: noop,
  sendDebugLog: (msg: string) => { console.log('[chessray]', msg); },

  onFrameResult: (cb) => { frameResultListeners.push(cb); },
  onStopTracking: noop,

  setMousePassthrough: noop,
  setAlwaysOnTop: noop,
  onDisplayInfo: (cb) => {
    displayInfoListeners.push(cb);
    cb({
      scaleFactor: window.devicePixelRatio || 1,
      overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    });
  },
  onSourceVisibility: (cb) => { cb(true); },

  getSources: () => Promise.resolve([]),
  selectSource: noop,
  reopenPicker: noop,

  setMultiPvMax: (n) => applySetting({ key: 'multi-pv-max', value: n }),
  onSetMultiPvMax: noop,
  setChangeDetect: (enabled) => applySetting({ key: 'change-detect', value: enabled }),
  onSetChangeDetect: noop,
  setManualFlip: (v) => applySetting({ key: 'manual-flip', value: v }),
  onSetManualFlip: noop,
  setTargetFps: (fps) => applySetting({ key: 'target-fps', value: fps }),
  onSetTargetFps: noop,

  onResetPanelPosition: noop,
  onTogglePanel: noop,
  onResetAllSettings: noop,
  requestResetPanelPosition: noop,
  requestResetAllSettings: () => {
    if (confirm('Reset all panel settings to defaults?')) {
      try { localStorage.removeItem('chessray-prefs'); } catch { /* ignore */ }
      location.reload();
    }
  },
  getDisplays: (): Promise<HostDisplay[]> => Promise.resolve([]),
  switchDisplay: noop,
  onDisplaysChanged: noop,

  startRecording: noop,
  stopRecording: noop,
  onRecordingStateChanged: noop,
  saveFrameArtifact: noop,

  minimizeApp: noop,
  closeApp: () => { window.close(); },
  openExternal: (url) => { chrome.tabs.create({ url }); },
  toggleLichess: (fen) => {
    const fenPath = encodeURIComponent(fen.split(' ')[0] ?? fen);
    chrome.tabs.create({ url: `https://lichess.org/analysis/${fenPath}` });
  },
  updateLichess: noop,
};

mountOverlay(bridge);
