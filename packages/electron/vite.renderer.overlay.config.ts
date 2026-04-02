import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/overlay'),
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/overlay_window'),
  },
  resolve: {
    alias: {
      '@chessray/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
});
