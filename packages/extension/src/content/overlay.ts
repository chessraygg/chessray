/**
 * Content script: builds an extension-side ChessRayAPI implementation and
 * mounts the shared @chessray/overlay-ui panel into the active page.
 *
 * The same panel HTML, CSS, canvas-renderer and debug surface the Electron
 * app uses; only the IPC calls are different. Settings → offscreen via
 * chrome.runtime.sendMessage; frame results ← offscreen via tabs.sendMessage.
 *
 * Capabilities the extension can't honor (mouse-passthrough on a tab,
 * BrowserWindow recording, multi-monitor switching) are stubbed as no-ops
 * so the API surface stays total — mountOverlay can call any method
 * without `?.()` guards.
 */

import { mountOverlay, type ChessRayAPI, type DisplayInfo, type HostDisplay } from '@chessray/overlay-ui';
import type { ExtensionMessage, ExtensionSetting } from '../shared/messages.js';
// Minimal CSS for the on-screen canvas only. We deliberately don't
// import overlay-ui's panel.css here — it sets body{overflow:hidden}
// and *{margin:0} globally, which broke scrolling on every page the
// content script touched.
import './content-overlay.css';

type FrameResultListener = (result: unknown) => void;

const frameResultListeners: FrameResultListener[] = [];
const stopTrackingListeners: Array<() => void> = [];
const displayInfoListeners: Array<(info: DisplayInfo) => void> = [];

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'frame-result') {
    const r = msg.result as { board_detection?: { found?: boolean }; arrows?: unknown[]; recognition?: { fen?: string } };
    console.log(`[chessray content] frame-result: found=${r.board_detection?.found} arrows=${r.arrows?.length ?? 0} fen=${r.recognition?.fen ?? '-'}`);
    for (const cb of frameResultListeners) cb(msg.result);
  }
  if (msg.type === 'prefs-update') {
    // Side panel saved a new pref blob — mirror it into our localStorage
    // and re-fire the panel's own click handlers so initOverlay's state
    // updates and the on-page overlay re-renders. Each handler reads the
    // pref it owns from localStorage on click, so writing localStorage
    // first then synthesizing clicks reproduces the original flow.
    try {
      localStorage.setItem('chessray-prefs', JSON.stringify(msg.prefs));
      // Synthesize clicks on the panel's toggles so handlers re-apply.
      // Buttons that maintain a class-based toggle (.active) need their
      // class set BEFORE synthesizing the click, so the click ends up
      // matching the new state instead of toggling away from it.
      applyPrefsToHiddenPanel(msg.prefs);
    } catch (err) {
      console.error('[chessray content] prefs-update failed:', err);
    }
  }
});

/**
 * Mirror prefs that have a corresponding panel UI control. We prefer
 * setting input.value / checkbox.checked + dispatching 'input'/'change'
 * (matches what real user interaction does — the panel's own listeners
 * then update state and re-render). Clicks on toggle buttons use the
 * same pattern.
 */
function applyPrefsToHiddenPanel(prefs: Record<string, unknown>): void {
  const setRange = (id: string, value: number): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setCheckbox = (id: string, value: boolean): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    if (el.checked !== value) {
      el.checked = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const clickIfStateMismatch = (id: string, expected: boolean, isActiveSelector = '.active'): void => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) return;
    const currentlyActive = el.matches(isActiveSelector);
    if (currentlyActive !== expected) el.click();
  };

  if (typeof prefs.borderVisible === 'boolean') {
    clickIfStateMismatch('cv-border-btn', prefs.borderVisible);
  }
  if (typeof prefs.overlaySize === 'number') setRange('cv-overlay-size', prefs.overlaySize);
  if (typeof prefs.overlayOpacity === 'number') setRange('cv-overlay-opacity', Math.round(prefs.overlayOpacity * 100));
  if (typeof prefs.evalBarStaleOpacity === 'number') setRange('cv-eval-stale-opacity', Math.round(prefs.evalBarStaleOpacity * 100));
  if (typeof prefs.lossThreshold === 'number') setRange('cv-loss-threshold', prefs.lossThreshold);
  if (typeof prefs.pvDepth === 'number') setRange('cv-pv-depth', prefs.pvDepth);
  if (typeof prefs.pvGrowDelaySec === 'number') setRange('cv-pv-grow-delay', prefs.pvGrowDelaySec);
  if (typeof prefs.pvPreviewSec === 'number') setRange('cv-pv-preview-sec', prefs.pvPreviewSec);
  if (typeof prefs.showMovesDelaySec === 'number') setRange('cv-show-moves-delay', prefs.showMovesDelaySec);
  if (typeof prefs.autoDelaySec === 'number') setRange('cv-auto-delay', prefs.autoDelaySec);
  if (typeof prefs.pvAutoplay === 'boolean') setCheckbox('cv-pv-autoplay', prefs.pvAutoplay);
  if (typeof prefs.changeDetect === 'boolean') setCheckbox('cv-change-detect', prefs.changeDetect);
  if (typeof prefs.overlayVisible === 'boolean') {
    clickIfStateMismatch('cv-overlay-btn', prefs.overlayVisible);
  }
  if (typeof prefs.evalBarVisible === 'boolean') {
    clickIfStateMismatch('cv-eval-btn', prefs.evalBarVisible);
  }
}

function applySetting(setting: ExtensionSetting): void {
  const m: ExtensionMessage = { type: 'apply-setting', setting };
  // Service worker proxies → offscreen, but offscreen also accepts directly.
  chrome.runtime.sendMessage(m).catch(() => {});
}

function emitDisplayInfo(): void {
  const info: DisplayInfo = {
    scaleFactor: window.devicePixelRatio || 1,
    overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  };
  for (const cb of displayInfoListeners) cb(info);
}
window.addEventListener('resize', emitDisplayInfo);

const noop = (): void => { /* intentionally empty — capability not present in this host */ };

const bridge: ChessRayAPI = {
  // ── Capture lifecycle (analysis-side) ──
  // Content script doesn't run analysis; these are no-ops here. The
  // offscreen document handles capture; our service worker triggers it.
  onStartCapture: noop,
  onStopCapture: noop,
  sendRendererReady: noop,
  getSourceId: () => Promise.resolve(null),
  sendFrameResult: noop,
  sendDebugLog: (msg: string) => { console.log('[chessray]', msg); },

  // Frame results: subscribe to chrome.runtime messages.
  onFrameResult: (cb) => { frameResultListeners.push(cb); },
  onStopTracking: (cb) => { stopTrackingListeners.push(cb); },

  // ── Window/panel controls ──
  // Content overlay is pointer-events: none; passthrough is implicit.
  setMousePassthrough: noop,
  setAlwaysOnTop: noop,
  onDisplayInfo: (cb) => {
    displayInfoListeners.push(cb);
    // Push an initial value so the renderer has DPR/bounds before the
    // first resize event.
    cb({
      scaleFactor: window.devicePixelRatio || 1,
      overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    });
  },
  onSourceVisibility: (cb) => { cb(true); },

  // Source picker — no analog in tab-bound extension. Stub.
  getSources: () => Promise.resolve([]),
  selectSource: noop,
  reopenPicker: noop,

  // ── Engine settings → forward to offscreen ──
  setMultiPvMax: (n) => applySetting({ key: 'multi-pv-max', value: n }),
  onSetMultiPvMax: noop, // analysis-side; not used in content
  setChangeDetect: (enabled) => applySetting({ key: 'change-detect', value: enabled }),
  onSetChangeDetect: noop,
  setManualFlip: (v) => applySetting({ key: 'manual-flip', value: v }),
  onSetManualFlip: noop,
  setTargetFps: (fps) => applySetting({ key: 'target-fps', value: fps }),
  onSetTargetFps: noop,

  // ── Panel / system actions ──
  // The content panel handles these locally — no main-process roundtrip.
  onResetPanelPosition: noop,
  onTogglePanel: noop,
  onResetAllSettings: noop,
  requestResetPanelPosition: () => {
    const panel = document.getElementById('user-panel') as HTMLElement | null;
    if (panel) {
      panel.style.left = '20px';
      panel.style.top = '20px';
      panel.style.right = 'auto';
    }
  },
  requestResetAllSettings: () => {
    if (confirm('Reset all panel settings to defaults?')) {
      try { localStorage.removeItem('chessray-prefs'); } catch { /* ignore */ }
      location.reload();
    }
  },
  getDisplays: (): Promise<HostDisplay[]> => Promise.resolve([]),
  switchDisplay: noop,
  onDisplaysChanged: noop,

  // ── Frame recording — no fs in content script ──
  startRecording: noop,
  stopRecording: noop,
  onRecordingStateChanged: noop,
  saveFrameArtifact: noop,

  // ── Window/app controls ──
  minimizeApp: noop,
  closeApp: () => {
    const panel = document.getElementById('user-panel') as HTMLElement | null;
    if (panel) panel.style.display = 'none';
  },
  openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
  toggleLichess: (fen) => {
    const fenPath = encodeURIComponent(fen.split(' ')[0] ?? fen);
    window.open(`https://lichess.org/analysis/${fenPath}`, '_blank', 'noopener');
  },
  updateLichess: noop, // tab is detached; no live-sync
};

// Mount the overlay-ui but hide the floating panel — the popup is the
// canonical UI surface in the extension. The on-screen #video-overlay
// canvas stays visible (arrows + eval bar drawn on the captured page).
mountOverlay(bridge, { hidePanel: true });

// On window resize, the document area changes immediately but the
// capture stream's video resolution lags behind by a frame or two.
// Re-render the on-page overlay with the freshest vw/vh so it doesn't
// drift to "super downwards" / "super left" while the stream catches up.
let lastFrameResult: unknown = null;
frameResultListeners.unshift((r) => { lastFrameResult = r; });

let resizeRaf = 0;
const scheduleReplay = (): void => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (lastFrameResult === null) return;
    // Replay through every consumer that's NOT the cache-stamper above.
    for (let i = 1; i < frameResultListeners.length; i++) {
      frameResultListeners[i](lastFrameResult);
    }
  });
};
window.addEventListener('resize', scheduleReplay);
// visualViewport fires for pinch-zoom and OSK changes that don't fire
// 'resize'. The renderer reads visualViewport.width/height first, so
// re-render here keeps the overlay aligned through those gestures.
window.visualViewport?.addEventListener('resize', scheduleReplay);
window.visualViewport?.addEventListener('scroll', scheduleReplay);

// ── Viewport-change reporter ──
// When the side panel opens/closes (or the user resizes the window) the
// captured tab's content area changes, but the MediaStream sticks at
// the dimensions the constraints were pinned to at capture-start. Tell
// the SW so it can re-grab a streamId and restart capture with new
// constraints — the on-page overlay realigns once the new frames arrive.
//
// Why ResizeObserver and not just 'resize': Chrome's side panel slides
// in from the right and narrows the page's layout viewport, but in
// practice the 'resize' window event isn't fired reliably for that
// transition (the user reported the recapture never triggered on side
// panel open). ResizeObserver on documentElement catches every layout
// change regardless of cause. visualViewport.resize is kept as a
// belt-and-braces signal for pinch-zoom / OSK on mobile-emulating tabs.
let viewportReportTimer = 0;
let viewportSettleTimer = 0;
let lastReportedViewport = { w: 0, h: 0 };
// Use innerWidth/Height (matches what tabCapture's render-widget surface
// captures, including the scrollbar gutter) rather than visualViewport
// (which excludes scrollbars). Mismatched units between capture-pin and
// render-mapping was a likely source of the post-resize misalignment.
function measurePhysicalViewport(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const cssW = window.innerWidth || document.documentElement?.clientWidth || 0;
  const cssH = window.innerHeight || document.documentElement?.clientHeight || 0;
  return { w: Math.round(cssW * dpr), h: Math.round(cssH * dpr) };
}
const reportViewportSize = (cause: string): void => {
  if (viewportReportTimer) clearTimeout(viewportReportTimer);
  // 500ms debounce — long enough for Chrome's side-panel slide-in (~200ms
  // animation) plus the page's reflow + scrollbar settle to complete.
  // Shorter values caused us to recapture mid-animation and pin to a
  // viewport size that didn't match the post-settle page.
  viewportReportTimer = window.setTimeout(() => {
    viewportReportTimer = 0;
    const { w, h } = measurePhysicalViewport();
    if (w === lastReportedViewport.w && h === lastReportedViewport.h) return;
    console.log(`[chessray content] viewport changed (${cause}): ${lastReportedViewport.w}x${lastReportedViewport.h} → ${w}x${h}`);
    lastReportedViewport = { w, h };
    chrome.runtime.sendMessage({ type: 'viewport-resized', viewport: { width: w, height: h } })
      .catch((err) => console.warn('[chessray content] viewport-resized send failed', err));
    // Verification: 1.2s later the recapture should be done, the page
    // should be fully settled, and any scrollbar transitions complete.
    // If the viewport differs from what we reported, recapture once more.
    // Without this the recapture pins to a transient mid-flight size.
    if (viewportSettleTimer) clearTimeout(viewportSettleTimer);
    viewportSettleTimer = window.setTimeout(() => {
      viewportSettleTimer = 0;
      const settled = measurePhysicalViewport();
      if (settled.w === lastReportedViewport.w && settled.h === lastReportedViewport.h) return;
      console.log(`[chessray content] viewport drift after recapture: ${lastReportedViewport.w}x${lastReportedViewport.h} → ${settled.w}x${settled.h}`);
      lastReportedViewport = settled;
      chrome.runtime.sendMessage({ type: 'viewport-resized', viewport: { width: settled.w, height: settled.h } })
        .catch((err) => console.warn('[chessray content] viewport-resized verify send failed', err));
    }, 1200);
  }, 500);
};
window.addEventListener('resize', () => reportViewportSize('window-resize'));
window.visualViewport?.addEventListener('resize', () => reportViewportSize('vvport-resize'));
try {
  new ResizeObserver(() => reportViewportSize('ro')).observe(document.documentElement);
} catch (err) {
  console.warn('[chessray content] ResizeObserver init failed', err);
}

// ── DPR change detection (Chrome moved to a screen with different
// scale factor) ──
// innerWidth/Height in CSS px don't change when the window moves
// between displays of different DPR — only window.devicePixelRatio
// does. ResizeObserver/resize won't fire. Standard matchMedia trick:
// the resolution-MQ stops matching when DPR changes, so the 'change'
// event tells us to re-measure (the physical-px viewport we report
// IS dpr-dependent: innerWidth * DPR).
function watchDprChanges(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onChange = (): void => {
    mq.removeEventListener('change', onChange);
    reportViewportSize('dpr-change');
    watchDprChanges(); // re-bind to the NEW dpr's MQ
  };
  mq.addEventListener('change', onChange);
}
watchDprChanges();
// Seed lastReportedViewport with the current size on mount so the first
// post-mount layout change is detected as a real diff (without this, the
// initial recapture-from-mount can spuriously fire if the page hadn't
// finished settling at content-script-load time).
queueMicrotask(() => reportViewportSize('initial'));

// Notify the service worker that the content script is ready so it can
// trigger capture on user request.
chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {});
