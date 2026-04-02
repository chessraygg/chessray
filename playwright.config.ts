import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    headless: false, // Extensions need headed Chromium
  },
});
