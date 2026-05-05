/**
 * Service worker: coordinates capture between the popup, the offscreen
 * document (pipeline + engine), and the content script (overlay).
 *
 * MV3 service workers are ephemeral — no persistent state here beyond what
 * lives in chrome.storage. The heavy lifting (Stockfish, ONNX, frame loop)
 * happens in the offscreen document, which stays alive as long as it has
 * active work.
 *
 * The popup grabs the tabCapture stream id itself (user-gesture context)
 * and hands the streamId here. We just open offscreen and forward.
 */

import type { ExtensionMessage } from '../shared/messages.js';

const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/offscreen.html');

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [
      chrome.offscreen.Reason.WORKERS,
      chrome.offscreen.Reason.USER_MEDIA,
    ],
    justification:
      'Runs Stockfish WASM worker + ONNX inference for live board recognition and evaluation.',
  });
}

/** Capture state persisted to chrome.storage.session so it survives
 *  SW restarts within the same browser session. The popup queries this
 *  on every open to show the real capture state — popups close on
 *  focus-loss (e.g. when Chrome's tab-share indicator appears) so the
 *  popup's local memory of "Starting…" or "Running" can be lost. */
type CaptureState = { running: boolean; tabId?: number };
async function getCaptureState(): Promise<CaptureState> {
  const { __chessrayCapture } = await chrome.storage.session.get('__chessrayCapture');
  return (__chessrayCapture as CaptureState | undefined) ?? { running: false };
}
async function setCaptureState(s: CaptureState): Promise<void> {
  await chrome.storage.session.set({ __chessrayCapture: s });
}

/** Read the target tab's content-area size in *physical* pixels.
 *  We hand this to getUserMedia as min=max so Chrome captures the
 *  page 1:1 (no letterboxing, no default-cap downscale). Without this,
 *  the captured frame doesn't map cleanly to viewport×DPR and the
 *  on-page overlay drifts a few CSS px off the actual board.
 *  activeTab grant from the user-gesture invocation covers executeScript. */
async function readTabViewport(tabId: number): Promise<{ width: number; height: number } | null> {
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Match the content-script's measurePhysicalViewport: innerWidth/
        // Height (includes scrollbar gutter) is what tabCapture's
        // render-widget surface sees. Using visualViewport.width here
        // (which excludes scrollbars) caused recaptured streams to be
        // pinned slightly smaller than the page Chrome was actually
        // capturing.
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth || document.documentElement?.clientWidth || 0;
        const h = window.innerHeight || document.documentElement?.clientHeight || 0;
        return { width: Math.round(w * dpr), height: Math.round(h * dpr) };
      },
    });
    return hit?.result ?? null;
  } catch (err) {
    note(`readTabViewport FAILED tab=${tabId}: ${String(err)}`);
    return null;
  }
}

/** In-memory mirror of the capture state. We need a SYNCHRONOUS read
 *  in chrome.action.onClicked to decide whether to start or stop, but
 *  getCaptureState() reads chrome.storage.session asynchronously and
 *  any await before getMediaStreamId would consume the user gesture.
 *  Initialized from storage on SW startup so it survives SW sleeps. */
let currentlyCapturing = false;

/** Toolbar badge: red dot while capturing, clear when idle. Lives in
 *  browser chrome (not in the captured tab pixels) so it doesn't leak
 *  into screen recordings while still being always-visible feedback. */
function setRecBadge(on: boolean): void {
  if (on) {
    // Classic record-light look: red dot on a transparent background,
    // not a red square. The previous styling (white ● on red fill) read
    // as a stop button — opposite of the intent. Setting the badge
    // background alpha to 0 removes the colored square; the text color
    // becomes the visible mark. Most browsers render the bullet glyph
    // U+25CF with enough body to look like a recording indicator at
    // toolbar-badge size.
    chrome.action.setBadgeText({ text: '\u25CF' }); // ●
    chrome.action.setBadgeTextColor?.({ color: '#ef4444' });
    chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] });
    chrome.action.setTitle({ title: 'Chessray — capturing (click to stop)' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Chessray' });
  }
}

async function startCapture(tabId: number, streamId: string): Promise<void> {
  await ensureOffscreen();
  const viewport = await readTabViewport(tabId);
  if (viewport) note(`viewport tab=${tabId} ${viewport.width}x${viewport.height}`);
  // Forward to offscreen. tabId rides along because offscreen documents
  // have no chrome.tabs access and need it to address the content script.
  const msg: ExtensionMessage = { type: 'capture-started', streamId, tabId, viewport: viewport ?? undefined };
  await chrome.runtime.sendMessage(msg);
  await setCaptureState({ running: true, tabId });
  currentlyCapturing = true;
  setRecBadge(true);
}

async function stopCapture(): Promise<void> {
  const msg: ExtensionMessage = { type: 'stop-capture' };
  await chrome.runtime.sendMessage(msg).catch(() => {});
  await setCaptureState({ running: false });
  currentlyCapturing = false;
  setRecBadge(false);
  // Tell every surface (content script + side panel) that capture
  // ended so the on-page overlay clears. Without this the last-drawn
  // bbox + arrows sit on the page until the user reloads it.
  const stopped: ExtensionMessage = { type: 'capture-stopped' };
  chrome.runtime.sendMessage(stopped).catch(() => {});
  // Content scripts need a tabs.sendMessage hop (they don't receive
  // runtime broadcasts). Get the last-invoked tab and notify it.
  if (lastInvokedTabId != null) {
    chrome.tabs.sendMessage(lastInvokedTabId, stopped).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, sender, sendResponse) => {
  if (msg.type === 'start-capture') {
    startCapture(msg.tabId, msg.streamId).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true; // async response
  }
  if (msg.type === 'stop-capture') {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'get-capture-state') {
    getCaptureState().then(sendResponse);
    return true;
  }
  if (msg.type === 'get-trace') {
    sendResponse({ trace });
    return false;
  }
  if (msg.type === 'get-target-tab') {
    (async () => {
      // Prefer the tab the user invoked the action on (activeTab grant
      // lives there). Fall back to chrome.storage.session in case the SW
      // was respawned between action click and panel query.
      if (lastInvokedTabId != null) {
        sendResponse({ tabId: lastInvokedTabId });
        return;
      }
      const stored = await chrome.storage.session.get('__chessrayInvokedTab').catch(() => ({} as Record<string, unknown>));
      const stashed = (stored as Record<string, unknown>).__chessrayInvokedTab as number | undefined;
      if (stashed != null) {
        lastInvokedTabId = stashed;
        sendResponse({ tabId: stashed });
        return;
      }
      sendResponse({ tabId: null });
    })();
    return true;
  }
  if (msg.type === 'ensure-offscreen') {
    // Test affordance: harness pings here so the offscreen doc exists
    // before it sends 'test-process-frame' directly to offscreen.
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }
  if (msg.type === 'viewport-resized') {
    // Just trace it. The actual handler is in offscreen (applyConstraints
    // on the existing track — we can't get a fresh streamId without a
    // user gesture, per Chrome DevRel).
    note(`viewport-resized tab=${sender.tab?.id} ${msg.viewport.width}x${msg.viewport.height}`);
    return false;
  }
  if (msg.type === 'log-from-offscreen') {
    note(`offscreen: ${msg.message}`);
    return false;
  }
  if (msg.type === 'forward-frame-result') {
    // Offscreen has no broadcast access; we do.
    //   chrome.tabs.sendMessage → content-script overlay on the page
    //   chrome.runtime.sendMessage → side panel
    const out: ExtensionMessage = { type: 'frame-result', result: msg.result };
    chrome.tabs.sendMessage(msg.tabId, out).catch(() => { /* no content script */ });
    chrome.runtime.sendMessage(out).catch(() => { /* no extension surface open */ });
    return false;
  }
  if (msg.type === 'pv-action') {
    // PV control sync. Only popup→content needs an explicit relay —
    // chrome.runtime.sendMessage from a content script already reaches
    // the side panel directly. The popup's message arrives here with
    // sender.tab undefined (extension context); forward it to the
    // active capture tab. Content-script-origin messages just trace.
    if (msg.from === 'popup') {
      void getCaptureState().then((s) => {
        if (s.tabId != null) chrome.tabs.sendMessage(s.tabId, msg).catch(() => {});
      });
    }
    return false;
  }
  return false;
});

// Toolbar click → open the side panel via an explicit chrome.action
// .onClicked handler. We deliberately DON'T use
// sidePanel.setPanelBehavior({openPanelOnActionClick: true}) because
// that flag suppresses the onClicked event, and we want onClicked to
// fire — that's the canonical "user invoked the extension on this tab"
// signal Chrome uses to grant activeTab. Without that grant, the side
// panel's Start button hits "Extension has not been invoked" when it
// tries chrome.tabCapture.getMediaStreamId.
/** The tab activeTab was last granted on. Side-panel UI queries this so
 *  Start always targets the tab the user invoked the extension on, even
 *  if they've since switched tabs in the same window. */
let lastInvokedTabId: number | undefined;

// Trace ring buffer — every meaningful event the SW sees gets logged
// here. The side panel reads it via 'get-trace' and shows it inline so
// we can see in production whether onClicked is firing, what tab id it
// passes, etc., without needing devtools.
const trace: string[] = [];
function note(s: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  trace.push(`${ts} ${s}`);
  if (trace.length > 30) trace.shift();
  void chrome.storage.session.set({ __chessrayTrace: trace }).catch(() => {});
}
note('SW startup');

// Explicitly tell Chrome NOT to auto-open the side panel on toolbar
// click. Per docs the default is already false, but in practice some
// Chrome versions interpret side_panel.default_path as implicit
// auto-open and silently suppress action.onClicked (chromium 40916430-
// class). Setting it explicitly to false makes our action.onClicked
// listener fire reliably so we can grab the streamId in the gesture.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .then(() => note('setPanelBehavior(openPanelOnActionClick=false) ok'))
  .catch((err) => note(`setPanelBehavior FAILED: ${String(err)}`));

// Hydrate currentlyCapturing + badge from persisted state — survives
// the SW sleeping mid-capture. Without this, after the SW respawns the
// in-memory flag would be false and a toolbar click would try to START
// (and fail with "active stream") instead of toggling off.
void getCaptureState().then((s) => {
  currentlyCapturing = !!s.running;
  setRecBadge(currentlyCapturing);
  note(`hydrated capture state: running=${currentlyCapturing}`);
});

// Documented pattern: side_panel.default_path in manifest + no
// setPanelBehavior call means action.onClicked fires on toolbar click
// (granting activeTab); the listener below opens the panel manually.

async function recordInvocation(tabId: number, source: string): Promise<void> {
  note(`invoked source=${source} tab=${tabId}`);
  lastInvokedTabId = tabId;
  await chrome.storage.session.set({ __chessrayInvokedTab: tabId }).catch(() => {});
}

/** Try to start capture immediately. Must be called from a user-gesture
 *  invocation (action.onClicked, context-menu.onClicked, commands) that
 *  granted activeTab on tabId; otherwise tabCapture.getMediaStreamId
 *  will reject. Returns false on failure so the caller can surface the
 *  error to the user via the trace ring. */
async function autoStart(tabId: number): Promise<boolean> {
  try {
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'no stream id'));
          return;
        }
        resolve(id);
      });
    });
    await startCapture(tabId, streamId);
    note(`autoStart ok tab=${tabId}`);
    return true;
  } catch (err) {
    note(`autoStart FAILED tab=${tabId}: ${String(err)}`);
    return false;
  }
}

chrome.action.onClicked.addListener((tab) => {
  note(`action.onClicked tab=${tab.id} (capturing=${currentlyCapturing})`);
  if (tab.id == null) return;
  const tabId = tab.id;
  // Toggle: if already capturing, the click stops it. Stopping doesn't
  // need a fresh user gesture (it just clears the existing stream), so
  // the await chain in stopCapture is fine.
  if (currentlyCapturing) {
    void stopCapture();
    return;
  }
  // Start path. getMediaStreamId MUST run synchronously before any
  // await — chrome.sidePanel.open consumes the user activation on some
  // Chrome versions (chromium 40916430-class). Grab the streamId
  // first, then do housekeeping in the callback.
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      note(`getMediaStreamId FAILED: ${chrome.runtime.lastError?.message ?? 'no id'}`);
      return;
    }
    await recordInvocation(tabId, 'action');
    try {
      await chrome.sidePanel.open({ tabId });
      note(`sidePanel.open ok`);
    } catch (err) {
      note(`sidePanel.open FAILED: ${String(err)}`);
    }
    try {
      await startCapture(tabId, streamId);
      note(`autoStart ok tab=${tabId}`);
    } catch (err) {
      note(`startCapture FAILED tab=${tabId}: ${String(err)}`);
    }
  });
});

// Context-menu fallback. If chrome.action.onClicked refuses to fire
// (some Chrome versions appear to suppress it when the side panel is
// configured), the user can right-click the page and pick "Chessray:
// Capture this tab" — context-menu invocation also grants activeTab.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'chessray-capture',
      title: 'Chessray: Capture this tab',
      contexts: ['page', 'frame', 'video', 'image'],
    });
    note('contextMenus.create ok');
  } catch (err) {
    note(`contextMenus.create FAILED: ${String(err)}`);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  note(`contextMenu.onClicked id=${info.menuItemId} tab=${tab?.id}`);
  if (info.menuItemId !== 'chessray-capture' || tab?.id == null) return;
  await recordInvocation(tab.id, 'context-menu');
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
    note(`sidePanel.open ok (from context menu)`);
  } catch (err) {
    note(`sidePanel.open FAILED (context): ${String(err)}`);
  }
  await autoStart(tab.id);
});

// Also stamp lastInvokedTabId whenever the user activates a tab while
// the side panel is open. tabs.onActivated doesn't grant activeTab, but
// the data point lets the panel show "you're viewing tab X but invoked
// tab Y — click toolbar to grant capture for X" without confusion.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await chrome.storage.session.set({ __chessrayActiveTab: tabId }).catch(() => {});
});

// Keyboard shortcut path. Firing a chrome.commands shortcut counts as
// user-invocation per Chrome's docs (same class of grant as a toolbar
// click), so we get activeTab → tabCapture access from inside the SW
// without bouncing through the popup. Also makes the extension usable
// without ever opening the popup, which is friendlier for power users.
let captureRunning = false;
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-capture') return;
  if (captureRunning) {
    captureRunning = false;
    await stopCapture();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  try {
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'no stream id'));
          return;
        }
        resolve(id);
      });
    });
    captureRunning = true;
    await startCapture(tab.id, streamId);
  } catch (err) {
    console.error('[chessray] toggle-capture failed:', err);
  }
});
