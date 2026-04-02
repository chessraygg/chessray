#!/usr/bin/env node
// Kill any running ChessRay process before reinstall
const { execSync } = require('child_process');

try {
  if (process.platform === 'win32') {
    execSync('taskkill /F /IM "ChessRay.exe" 2>nul', { stdio: 'ignore' });
  } else {
    execSync("pkill -f 'ChessRay' 2>/dev/null", { stdio: 'ignore' });
  }
} catch {
  // Process not running — that's fine
}

// Give OS time to release file locks
const wait = process.platform === 'win32' ? 1000 : 500;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
