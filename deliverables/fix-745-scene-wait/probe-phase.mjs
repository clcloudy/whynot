import { spawn } from 'node:child_process';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9347;
const URL = 'http://127.0.0.1:8895/?probe=' + Date.now();
const pause = ms => new Promise(r => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1440,900', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=E:/whynot/deliverables/fix-745-scene-wait/edge-probe', '--no-first-run', 'about:blank',
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
await evaluate(`localStorage.removeItem('whynot-theme'); localStorage.removeItem('whynot-marks')`, false);

await evaluate(`(() => {
  window.__phases = [];
  const t0 = performance.now();
  const stage = document.querySelector('.stage');
  window.__phases.push({ t: 0, phase: stage.dataset.phase });
  new MutationObserver(() => {
    window.__phases.push({ t: Math.round(performance.now() - t0), phase: stage.dataset.phase, cls: stage.className });
  }).observe(stage, { attributes: true, attributeFilter: ['data-phase', 'class'] });
})()`, false);

const result = await evaluate(`(async () => {
  const mod = await import('/__local/acceptance-ui.mjs?t=' + Date.now());
  const r = await mod.default('lane');
  return { passed: r.passed, total: r.results.length, failed: r.results.filter(x => !x.passed).map(x => x.name) };
})()`);

const phases = await evaluate('JSON.stringify(window.__phases)', false);
console.log('lane result:', JSON.stringify(result));
console.log('phase timeline (ms, phase, class):');
for (const p of JSON.parse(phases)) console.log(' ', p.t, p.phase, p.cls || '');
ws.close();
edge.kill();
