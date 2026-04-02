const fs = require('fs');
const { PNG } = require('pngjs');

function drawExpected(inFile, outFile, bx, by, bw) {
  const png = PNG.sync.read(fs.readFileSync(inFile));
  const { width, height } = png;
  const sq = bw / 8;
  function draw(x, y, r, g, b) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    png.data[i] = r; png.data[i+1] = g; png.data[i+2] = b; png.data[i+3] = 255;
  }
  for (let t = 0; t < 3; t++) {
    for (let x = bx-t; x <= bx+bw+t; x++) { draw(x, by-t, 255, 0, 0); draw(x, by+bw+t, 255, 0, 0); }
    for (let y = by-t; y <= by+bw+t; y++) { draw(bx-t, y, 255, 0, 0); draw(bx+bw+t, y, 255, 0, 0); }
  }
  for (let k = 1; k < 8; k++) {
    const gx = Math.round(bx + k * sq), gy = Math.round(by + k * sq);
    for (let y = by; y <= by+bw; y++) draw(gx, y, 0, 255, 0);
    for (let x = bx; x <= bx+bw; x++) draw(x, gy, 0, 255, 0);
  }
  fs.writeFileSync(outFile, PNG.sync.write(png));
  console.log('saved', outFile);
}

drawExpected('test/screenshots/test-aronian.png', 'test/expected/aronian.png', 728, 143, 536);
