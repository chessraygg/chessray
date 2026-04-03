#!/usr/bin/env node
// Download all vendor assets: Stockfish, ONNX Runtime Web
// Run via: npm run setup
const https = require('https');
const fs = require('fs');
const path = require('path');

const VENDOR = path.resolve(__dirname, '..', 'vendor');

const ASSETS = [
  // Stockfish 18 Lite WASM
  {
    dir: 'stockfish',
    files: [
      { name: 'stockfish-18-lite-single.js', url: 'https://unpkg.com/stockfish@18.0.5/bin/stockfish-18-lite-single.js' },
      { name: 'stockfish-18-lite-single.wasm', url: 'https://unpkg.com/stockfish@18.0.5/bin/stockfish-18-lite-single.wasm' },
    ],
  },
  // ONNX Runtime Web 1.24.3
  {
    dir: 'onnxruntime-web',
    files: [
      { name: 'ort.min.js', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.min.js' },
      { name: 'ort.webgpu.min.js', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.webgpu.min.js' },
      { name: 'ort-wasm-simd-threaded.asyncify.mjs', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.asyncify.mjs' },
      { name: 'ort-wasm-simd-threaded.asyncify.wasm', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort-wasm-simd-threaded.asyncify.wasm' },
    ],
  },
  // YOLO chess piece detection model
  {
    dir: 'yolo-chess',
    files: [
      { name: 'chess-pieces.onnx', url: 'https://github.com/chessraygg/chessray/releases/download/v0.2.5/chess-pieces.onnx' },
    ],
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function main() {
  for (const asset of ASSETS) {
    const dir = path.join(VENDOR, asset.dir);
    fs.mkdirSync(dir, { recursive: true });

    for (const file of asset.files) {
      const dest = path.join(dir, file.name);
      if (fs.existsSync(dest)) {
        const size = fs.statSync(dest).size;
        if (size > 1000 || file.name.endsWith('.onnx')) {
          console.log(`Skipping ${asset.dir}/${file.name} (already exists, ${size} bytes)`);
          continue;
        }
      }
      console.log(`Downloading ${asset.dir}/${file.name}...`);
      await download(file.url, dest);
      const size = fs.statSync(dest).size;
      if (size < 100) {
        fs.unlinkSync(dest);
        throw new Error(`${file.name} is only ${size} bytes (download likely failed)`);
      }
      console.log(`  Saved (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  console.log('\nAll vendor assets downloaded successfully.');
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
