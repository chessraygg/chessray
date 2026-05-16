import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // frame-sequence.test.ts runs the full YOLO + change-detect +
    // FrameProcessor pipeline over a multi-frame fixture and routinely
    // exceeds vitest's 5s default — ~6s locally, more on slower CI
    // runners. Mirror packages/core/vitest.config.ts's 30s + headroom.
    testTimeout: 60000,
  },
});
