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
// Popup owns its document, so it can safely load panel.css's global
// rules. (mount-overlay.ts no longer pulls panel.css automatically —
// that was leaking body{overflow:hidden} into every page the content
// script ran on.)
import '@chessray/overlay-ui/src/panel.css';
import './popup.css';

// Build stamp baked in by Vite (define in vite.config.ts). Surfaces in
// the side-panel status so we can tell at a glance which dist Chrome
// is actually running.
declare const __CHESSRAY_BUILD__: string;
const BUILD = typeof __CHESSRAY_BUILD__ !== 'undefined' ? __CHESSRAY_BUILD__ : '?';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('cap-status')!;

// ── Pre-resolve target tabId at popup load ──────────────────────────
//   Done off the click path so awaiting tabs.query doesn't consume the
//   user gesture later. Falls back from currentWindow → lastFocusedWindow
//   so the popup also works when opened as a tab (test harness path).
let cachedTabId: number | null = null;
let cachedTabUrl: string | null = null;
let cachedTabSource: 'sw-target' | 'currentWindow' | 'lastFocusedWindow' | 'any' | 'override' | 'none' = 'none';
async function preloadTabId(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const override = params.get('tabId');
  if (override) {
    cachedTabId = Number(override);
    cachedTabSource = 'override';
    await fetchTabUrl();
    return;
  }
  // Ask the SW which tab Chrome activeTab-granted.
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-target-tab' } satisfies ExtensionMessage);
    if (resp?.tabId != null) {
      cachedTabId = resp.tabId;
      cachedTabSource = 'sw-target';
      await fetchTabUrl();
      return;
    }
  } catch { /* SW unreachable; fall through */ }
  const isContent = (t: chrome.tabs.Tab | undefined): boolean =>
    !!t?.url && (t.url.startsWith('http://') || t.url.startsWith('https://'));
  const queries: Array<{ q: chrome.tabs.QueryInfo; src: typeof cachedTabSource }> = [
    { q: { active: true, currentWindow: true }, src: 'currentWindow' },
    { q: { active: true, lastFocusedWindow: true }, src: 'lastFocusedWindow' },
    { q: { currentWindow: true }, src: 'currentWindow' },
    { q: {}, src: 'any' },
  ];
  for (const { q, src } of queries) {
    const tabs = await chrome.tabs.query(q);
    const t = tabs.find(isContent);
    if (t) {
      cachedTabId = t.id ?? null;
      cachedTabSource = src;
      cachedTabUrl = t.url ?? null;
      return;
    }
  }
  cachedTabId = null;
  cachedTabSource = 'none';
}

async function fetchTabUrl(): Promise<void> {
  if (cachedTabId == null) return;
  try {
    const tab = await chrome.tabs.get(cachedTabId);
    cachedTabUrl = tab.url ?? null;
  } catch (err) {
    cachedTabUrl = `(get failed: ${(err as Error).message})`;
  }
}

function shortUrl(): string {
  if (!cachedTabUrl) return '(no url)';
  try {
    const u = new URL(cachedTabUrl);
    return u.host + u.pathname.slice(0, 20);
  } catch { return cachedTabUrl.slice(0, 40); }
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
  const [state, stored, traceResp] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'get-capture-state' } satisfies ExtensionMessage)
      .catch(() => ({ running: false })),
    chrome.storage.session.get('__chessrayPopupStatus').catch(() => ({})),
    chrome.runtime.sendMessage({ type: 'get-trace' } satisfies ExtensionMessage)
      .catch(() => ({ trace: [] })),
  ]);
  await preloadTabId();
  startBtn.disabled = false;
  // Show the last few SW events at the bottom so we can verify whether
  // chrome.action.onClicked fired when the user clicked the toolbar.
  const traceLines: string[] = traceResp?.trace?.slice(-6) ?? [];
  const traceTail = traceLines.length ? '\n— SW trace —\n' + traceLines.join('\n') : '\n(no SW events yet)';
  if (state?.running) {
    setStatus(`Running (tab ${state.tabId ?? '?'})`);
    startBtn.classList.add('running');
    return;
  }
  // Show last error if it happened recently (within ~30s), otherwise
  // fall back to Idle. Stale errors don't survive a tab reload.
  const last = (stored as Record<string, unknown> | undefined)?.__chessrayPopupStatus as { msg: string; isError: boolean; ts: number } | undefined;
  if (last?.isError && Date.now() - last.ts < 30_000) {
    setStatus(`(prev) ${last.msg}`, true);
    return;
  }
  if (cachedTabId === null) {
    setStatus(`No http(s) tab · build ${BUILD}${traceTail}`, true);
  } else {
    setStatus(`Idle · build ${BUILD} · ${cachedTabSource} · tab ${cachedTabId} · ${shortUrl()}${traceTail}`);
  }
}
void bootstrap();

// When the SW updates the invoked tab id (i.e., the user finally clicks
// the toolbar icon), refresh the side panel's status so the "click
// toolbar icon" warning goes away on its own without a panel reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if ('__chessrayInvokedTab' in changes) void bootstrap();
});

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

// Visible click counter — proves the click handler is reaching at all.
// If the user reports "no response" but the counter doesn't tick, the
// button isn't receiving events; if it ticks but status doesn't change
// after, the failure is downstream.
let clickCount = 0;
function bumpClicks(): void {
  clickCount++;
  startBtn.textContent = `Start [${clickCount}]`;
}

startBtn.addEventListener('click', () => {
  bumpClicks();
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
      // Always surface the RAW Chrome error verbatim plus all context.
      // The user keeps reporting "doesn't work" without telling me what
      // the error string is — wrapping it with friendly hints was hiding
      // the actual symptom. Show everything.
      setStatus(
        `Chrome rejected getMediaStreamId.\n` +
        `targetTabId=${tabId} (${cachedTabSource}, ${shortUrl()})\n` +
        `error: "${msg}"`,
        true,
      );
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

// Relay pref changes to the captured tab's content script so the on-page
// overlay (border/box, arrow opacity/size, eval-bar opacity, etc.) keeps
// up with what the user just toggled in the side panel. Side panel and
// content script each have their own localStorage; without this bridge,
// every setting only takes effect inside the (hidden) side-panel canvas.
const origSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = (key: string, value: string): void => {
  origSetItem(key, value);
  if (key !== 'chessray-prefs' || cachedTabId == null) return;
  try {
    const prefs = JSON.parse(value) as Record<string, unknown>;
    void chrome.tabs.sendMessage(cachedTabId, {
      type: 'prefs-update', prefs,
    } satisfies ExtensionMessage).catch(() => { /* content script may be missing */ });
  } catch { /* ignore parse errors */ }
};
