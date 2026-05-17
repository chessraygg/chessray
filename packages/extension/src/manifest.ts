/**
 * MV3 manifest authored as TypeScript so @crxjs/vite-plugin can resolve
 * entry-point sources (service worker, content scripts, side panel, offscreen doc)
 * and rewrite them to hashed bundle filenames at build time.
 */

import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Chessray',
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: '116',
  icons: {
    16: 'src/icons/icon-16.png',
    32: 'src/icons/icon-32.png',
    48: 'src/icons/icon-48.png',
    128: 'src/icons/icon-128.png',
  },
  action: {
    default_title: 'Chessray',
    default_icon: {
      16: 'src/icons/icon-16.png',
      32: 'src/icons/icon-32.png',
      48: 'src/icons/icon-48.png',
      128: 'src/icons/icon-128.png',
    },
  },
  side_panel: {
    default_path: 'src/side-panel/side-panel.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: [
    'offscreen',     // Stockfish WASM + ONNX inference (off the SW thread)
    'scripting',     // executeScript reads tab viewport for overlay alignment
    'storage',       // capture state + user prefs (chrome.storage.session/local)
    'tabCapture',    // getMediaStreamId — core feature
    'sidePanel',     // setPanelBehavior + open the analysis UI
    'contextMenus',  // right-click "Capture this tab" fallback entry point
    // activeTab intentionally NOT requested — it's redundant when
    // host_permissions includes <all_urls>; tabCapture/scripting/tabs.*
    // all work via the host permission, and the install prompt is already
    // driven by <all_urls> so removing activeTab doesn't worsen UX.
  ],
  commands: {
    'toggle-capture': {
      suggested_key: {
        // Alt+Shift+C avoids the macOS Chrome reservation of Cmd+Shift+M
        // ("Switch Person" menu) — that earlier default never actually
        // bound on Mac because Chrome refuses to register an extension
        // shortcut over a built-in browser shortcut. Alt/Option+Shift+C is
        // free on Mac and Windows/Linux. Users can override at
        // chrome://extensions/shortcuts.
        default: 'Alt+Shift+C',
        mac: 'Alt+Shift+C',
      },
      description: 'Start/stop Chessray capture on the current tab',
    },
  },
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      matches: ['<all_urls>'],
      // Hard-block the overlay from injecting on chess.com / lichess.org.
      // The service worker also refuses tabCapture starts on these hosts
      // (see service-worker.ts isCaptureBlockedUrl) so the user can't
      // bypass via toolbar/shortcut/context-menu either. Chessray is a
      // streams / videos / screenshots / PDFs tool — running it on a live
      // chess-server tab would violate those sites' anti-cheat policies.
      exclude_matches: [
        '*://*.chess.com/*',
        '*://chess.com/*',
        '*://*.lichess.org/*',
        '*://lichess.org/*',
      ],
      js: ['src/content/overlay.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      resources: [
        'src/offscreen/offscreen.html',
        'vendor/stockfish/*',
        'vendor/onnxruntime-web/*',
        'vendor/yolo-chess/*',
        'vendor/paddle-ocr/*',
      ],
      matches: ['<all_urls>'],
    },
  ],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
