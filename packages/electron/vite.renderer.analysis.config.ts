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
    // Disable dep optimization — re-optimization on restart causes the
    // analysis module to hang, preventing capture from starting.
    noDiscovery: true,
    include: [],
  },
});
