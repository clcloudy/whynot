import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const output = resolve('.local/function');
const require = createRequire(import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['functions/index.ts'],
  outfile: resolve(output, 'index.ts'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['./_qoder/backend.mjs'],
  legalComments: 'linked',
});
const wasm = require.resolve('@imagemagick/magick-wasm/magick.wasm');
const magickPackage = resolve(dirname(wasm), '../..');
await Promise.all([
  copyFile(wasm, resolve(output, 'magick.wasm')),
  copyFile(resolve(magickPackage, 'LICENSE'), resolve(output, 'imagemagick-LICENSE.txt')),
  copyFile(resolve(magickPackage, 'NOTICE'), resolve(output, 'imagemagick-NOTICE.txt')),
]);
console.log(output);
