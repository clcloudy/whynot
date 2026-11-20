import { copyFile, mkdir, rm } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

// --no-wasm：云端精简包。平台 Function 部署有请求大小上限，
// 且看图学词依赖未配置的 WHYNOT_DATABASE_URL，故云端包不携带解码 WASM。
const slim = process.argv.includes('--no-wasm');
const output = resolve('.local/function');
const require = createRequire(import.meta.url);
await mkdir(output, { recursive: true });
// 平台 edge-runtime 打包器只识别带 node: 前缀的内置模块。
const nodeBuiltins = new Set(builtinModules);
const nodePrefix = {
  name: 'node-prefix',
  setup(b) {
    b.onResolve({ filter: /^[a-z_]/ }, args => nodeBuiltins.has(args.path)
      ? { path: `node:${args.path}`, external: true } : undefined);
  },
};
await build({
  stdin: {
    // 垫片先于业务入口求值，补齐 edge-runtime 缺失的 Node 全局。
    contents: "import './dev/function-shim.mjs';\nimport './functions/index.ts';\n",
    resolveDir: resolve('.'),
    sourcefile: 'cloud-entry.ts',
    loader: 'ts',
  },
  outfile: resolve(output, 'index.ts'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['./_qoder/backend.mjs'],
  legalComments: 'linked',
  plugins: [nodePrefix],
});
if (slim) {
  await Promise.all(['magick.wasm', 'imagemagick-LICENSE.txt', 'imagemagick-NOTICE.txt']
    .map(name => rm(resolve(output, name), { force: true })));
} else {
  const wasm = require.resolve('@imagemagick/magick-wasm/magick.wasm');
  const magickPackage = resolve(dirname(wasm), '../..');
  await Promise.all([
    copyFile(wasm, resolve(output, 'magick.wasm')),
    copyFile(resolve(magickPackage, 'LICENSE'), resolve(output, 'imagemagick-LICENSE.txt')),
    copyFile(resolve(magickPackage, 'NOTICE'), resolve(output, 'imagemagick-NOTICE.txt')),
  ]);
}
console.log(output);
