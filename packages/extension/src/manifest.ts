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
    'contextMenus',
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
  // No content_scripts: the side panel is the one and only UI surface.
  // Drawing arrows on the captured page would feed back into the
  // tabCapture stream and confuse YOLO recognition; the in-panel
  // virtual board renders the same arrows + eval bar without that
  // feedback loop, and avoids polluting every page's DOM/CSS.
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
