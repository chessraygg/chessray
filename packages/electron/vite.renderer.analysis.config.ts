import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/analysis'),
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/analysis_window'),
  },
  resolve: {
    alias: {
      '@chessray/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  optimizeDeps: {
    // Pre-bundle CJS deps that don't work with Vite's ESM dev server.
    // noDiscovery is off so Vite can discover and pre-bundle them.
    include: ['tesseract.js'],
  },
});
