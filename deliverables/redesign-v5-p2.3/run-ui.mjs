import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9346;
const OUT = 'E:/whynot/deliverables/redesign-v5-p2.3';
const URL = 'http://127.0.0.1:8895/?runner=' + Date.now();
const pause = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1440,900', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}/edge-runner`, '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

async function waitJson(path) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${path}`); if (r.ok) return r.json(); } catch {}
    await pause(250);
  }
  throw new Error(`CDP not ready: ${path}`);
}
const pages = await waitJson('/json/list');
const page = pages.find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await pause(1200);
await evaluate(`localStorage.removeItem('whynot-theme'); localStorage.removeItem('whynot-guide'); localStorage.removeItem('whynot-stage'); localStorage.removeItem('whynot-marks')`, false);
console.log('runner page ready');

const started = Date.now();
await evaluate(`(async () => {
  const mod = await import('/__local/acceptance-ui.mjs?t=' + Date.now());
  const out = {};
  for (const g of ['lane','state','timing','layout','polish','legends','completion','b4','ix']) {
    window.__groupCurrent = g;
    out[g] = await mod.default(g);
  }
  window.__allResults = out;
  window.__groupCurrent = 'done';
  return true;
})()`);
console.log('suite finished in', Math.round((Date.now() - started) / 1000), 's');

const json = await evaluate('JSON.stringify(window.__allResults)', false);
const data = JSON.parse(json);
const groups = {}; let total = 0, passed = 0;
for (const [k, v] of Object.entries(data)) {
  groups[k] = { passed: v.passed, total: v.results.length, results: v.results };
  total += v.results.length; passed += v.passed;
}
const out = { date: '2026-11-21', scope: 'v5 P2.1：主题驱动场景 + 折叠说明 + 重播进站 + 场景最终态加固', groups, total, passed, failed: total - passed };
writeFileSync(`${OUT}/ui-final.json`, JSON.stringify(out, null, 2));
console.log('groups', Object.keys(groups).map(k => `${k} ${groups[k].passed}/${groups[k].total}`).join(', '));
console.log('total', total, 'passed', passed, 'failed', total - passed);
for (const [k, v] of Object.entries(groups)) {
  const failed = v.results.filter(r => !r.passed);
  if (failed.length) console.log('FAIL', k, failed.map(r => r.name).join(' | '));
}
ws.close();
edge.kill();
