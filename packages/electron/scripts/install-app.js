#!/usr/bin/env node
// Copy packaged app to the system applications folder (platform-specific)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const outDir = path.resolve(__dirname, '..');

if (process.platform === 'darwin') {
  // Find the .app bundle in out/
  const archDir = `ChessRay-darwin-${process.arch}`;
  const src = path.join(outDir, 'out', archDir, 'ChessRay.app');
  const dest = path.join(os.homedir(), 'Applications', 'ChessRay.app');

  if (!fs.existsSync(src)) {
    console.error(`Packaged app not found at: ${src}`);
    process.exit(1);
  }

  // Remove from both ~/Applications and /Applications to avoid duplicates
  const systemDest = '/Applications/ChessRay.app';
  execSync(`rm -rf "${dest}"`);
  if (fs.existsSync(systemDest)) {
    execSync(`rm -rf "${systemDest}"`);
    console.log(`Removed stale ${systemDest}`);
  }
  execSync(`cp -R "${src}" "${dest}"`);
  console.log(`Installed to ${dest}`);

} else if (process.platform === 'win32') {
  // Find the packaged folder in out/
  const archDir = `ChessRay-win32-${process.arch}`;
  const src = path.join(outDir, 'out', archDir);
  const dest = path.join(os.homedir(), 'AppData', 'Local', 'ChessRay');

  if (!fs.existsSync(src)) {
    console.error(`Packaged app not found at: ${src}`);
    process.exit(1);
  }

  execSync(`rmdir /s /q "${dest}" 2>nul`, { stdio: 'ignore' });
  fs.mkdirSync(dest, { recursive: true });
  execSync(`xcopy /s /e /y /q "${src}\\*" "${dest}\\"`, { stdio: 'inherit' });
  console.log(`Installed to ${dest}`);

} else {
  // Linux
  const archDir = `ChessRay-linux-${process.arch}`;
  const src = path.join(outDir, 'out', archDir);
  const dest = path.join(os.homedir(), '.local', 'share', 'chessray');

  if (!fs.existsSync(src)) {
    console.error(`Packaged app not found at: ${src}`);
    process.exit(1);
  }

  execSync(`rm -rf "${dest}"`);
  execSync(`cp -R "${src}" "${dest}"`);
  console.log(`Installed to ${dest}`);
}
