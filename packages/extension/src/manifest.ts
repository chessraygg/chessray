/**
 * MV3 manifest authored as TypeScript so @crxjs/vite-plugin can resolve
 * entry-point sources (service worker, content scripts, popup, offscreen doc)
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
  action: {
    default_title: 'Chessray',
  },
  // Restore default_path so the side panel reliably opens on action
  // click. We also call sidePanel.setPanelBehavior({openPanelOnActionClick})
  // in the SW. action.onClicked may or may not fire alongside this in
  // current Chrome — the SW handler is defensive: it handles both
  // (onClicked grants activeTab if it fires; the panel's Start button
  // also re-invokes via context menu if activeTab is missing).
  side_panel: {
    default_path: 'src/popup/popup.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: [
    'offscreen',
    'scripting',
    'storage',
    'tabCapture',
    'activeTab',
    'sidePanel',
  ],
  commands: {
    'toggle-capture': {
      suggested_key: {
        default: 'Ctrl+Shift+M',
        mac: 'Command+Shift+M',
      },
      description: 'Start/stop Chessray capture on the current tab',
    },
  },
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      matches: ['<all_urls>'],
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
