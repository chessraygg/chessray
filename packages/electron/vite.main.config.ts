import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@chessray/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
});
