// Run with Node: node dev/generate-icons.mjs. No dependencies or build step.
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const BACKGROUND = [0x10, 0x18, 0x27];
const FOREGROUND = [0xf6, 0xf2, 0xe8];
const LEVELS = 16;
const SAMPLES = 8;
// The OS supplies the corner mask; install PNGs retain an opaque background.
const MARK_SCALE = 0.8;
const STROKES = [
  [[4, 12], [4, 6], [8, 6], [10, 8], [12, 6], [16, 6], [18, 8], [20, 6], [28, 6], [28, 12]],
  [[4, 20], [4, 26], [28, 26], [28, 20]],
  [[11, 16], [21, 16]],
];
const SEGMENTS = STROKES.flatMap(points => points.slice(1).map(([x, y], i) => {
  const [startX, startY] = points[i], dx = x - startX, dy = y - startY;
  return [startX, startY, dx, dy, dx * dx + dy * dy];
}));

function ink(x, y) {
  for (const [startX, startY, dx, dy, length] of SEGMENTS) {
    const t = Math.max(0, Math.min(1, ((x - startX) * dx + (y - startY) * dy) / length));
    if ((x - startX - t * dx) ** 2 + (y - startY - t * dy) ** 2 <= 1) return true;
  }
  return false;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 4; // Two 4-bit palette indices per byte.
  header[9] = 3; // Indexed RGB, no transparency chunk.
  const palette = Buffer.from(Array.from({ length: LEVELS }, (_, level) =>
    BACKGROUND.map((channel, i) => Math.round(channel + (FOREGROUND[i] - channel) * level / (LEVELS - 1)))
  ).flat());
  const stride = Math.ceil(size / 2) + 1;
  const pixels = Buffer.alloc(stride * size); // Filter 0 on every row.
  const coordinate = sample => ((sample / SAMPLES) * 32 / size - 16) / MARK_SCALE + 16;
  const positions = Array.from({ length: size * SAMPLES }, (_, i) => coordinate(i + 0.5));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (ink(positions[x * SAMPLES + sx], positions[y * SAMPLES + sy])) coverage++;
        }
      }
      const index = Math.round(coverage * (LEVELS - 1) / (SAMPLES * SAMPLES));
      pixels[y * stride + 1 + (x >> 1)] |= index << ((x & 1) ? 0 : 4);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  const bytes = png(size);
  await writeFile(new URL(`../web/${name}`, import.meta.url), bytes);
  console.log(`${name}: ${size}x${size}, ${bytes.length} bytes`);
}
