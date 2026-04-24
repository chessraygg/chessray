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
    default_popup: 'src/popup/popup.html',
    default_title: 'Chessray',
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
  ],
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
