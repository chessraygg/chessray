/**
 * Vite config for the MV3 extension build.
 *
 * - @crxjs/vite-plugin reads src/manifest.ts, follows the entry points it
 *   declares, and emits a valid MV3 bundle with rewritten paths.
 * - vite-plugin-static-copy brings the repo-root `vendor/` directory into the
 *   build so the offscreen doc can load Stockfish/ONNX/YOLO/OCR assets via
 *   `chrome.runtime.getURL('vendor/…')` at runtime.
 */

import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import manifest from './src/manifest.ts';
import { buildInfoPlugin } from '../overlay-ui/vite-plugin-build-info.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

export default defineConfig({
  // Force IPv4 binding so CRXJS's dev-mode loader (which fetches
  // http://localhost:5173 from the page) connects on macOS where Chrome
  // resolves localhost→::1 first and Vite's default would only bind IPv6.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
    },
  },
  plugins: [
    buildInfoPlugin(),
    crx({ manifest }),
    viteStaticCopy({
      // Single target with the parent dir as src puts each subdir (stockfish,
      // onnxruntime-web, yolo-chess, paddle-ocr) under dist/vendor/<name>/…
      // Per-subdir targets with globbed src double-nest the path — the plugin
      // preserves the relative path from src's parent, not the glob root.
      targets: [
        { src: resolve(repoRoot, 'vendor'), dest: '.' },
      ],
    }),
  ],
});
