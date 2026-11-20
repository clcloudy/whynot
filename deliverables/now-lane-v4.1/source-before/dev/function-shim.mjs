// 云端 edge-runtime 不暴露 Node 全局；postgres 驱动在模块顶层就引用 Buffer。
// 本模块必须先于业务入口求值（见 build-function.mjs 的入口顺序）。
import { Buffer } from 'node:buffer';
import process from 'node:process';

globalThis.Buffer ??= Buffer;
globalThis.process ??= process;
if (!globalThis.setImmediate) {
  globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = id => clearTimeout(id);
}