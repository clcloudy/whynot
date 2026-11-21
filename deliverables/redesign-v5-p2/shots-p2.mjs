import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9344;
const OUT = 'E:/whynot/deliverables/redesign-v5-p2';
const URL = 'http://127.0.0.1:8895/';
const pause = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1440,900', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}/edge-evidence`, '--no-first-run', 'about:blank',
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
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const screenshot = async name => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Buffer.from(shot.data, 'base64'));
  console.log('saved', name);
};
const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const media = value => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
const reload = async () => {
  await send('Page.navigate', { url: `${URL}?e=${Date.now()}` });
  for (let i = 0; i < 80; i++) {
    await pause(150);
    const ready = await evaluate(`document.readyState === 'complete' && typeof formState === 'object'`).catch(() => false);
    if (ready) break;
  }
  await pause(3000);
};
const waitFor = async (expr, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await pause(80);
  }
  throw new Error(`timeout: ${expr}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.removeItem('whynot-theme');localStorage.removeItem('whynot-guide');localStorage.setItem('whynot-stage','dusk');localStorage.removeItem('whynot-marks')}catch{}`,
});
await media('light');
await viewport(1440, 900);
await reload();
await screenshot('01-dusk-stopped-1440.png');

await evaluate(`localStorage.setItem('whynot-stage','night'); applyStageLight('night')`);
await pause(500);
await screenshot('02-night-stopped-1440.png');

await evaluate(`(async () => { await ask(); })()`);
await waitFor(`!!document.querySelector('#result .card')`);
await evaluate(`document.querySelector('[data-focus="completed"]').click()`);
await waitFor(`state.card && state.card.completed === true`);
await pause(320);
await screenshot('03-night-ground-stamp-1440.png');
await evaluate(`localStorage.removeItem('whynot-marks')`);

await viewport(390, 844);
await reload();
await screenshot('04-dusk-stopped-390.png');

ws.close();
edge.kill();
console.log('done');
