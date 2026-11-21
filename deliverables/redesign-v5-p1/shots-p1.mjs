import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9343;
const OUT = 'E:/whynot/deliverables/redesign-v5-p1';
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
const reload = async wait => {
  await send('Page.navigate', { url: `${URL}?e=${Date.now()}` });
  for (let i = 0; i < 80; i++) {
    await pause(100);
    const ready = await evaluate(`document.readyState === 'complete' && typeof formState === 'object'`).catch(() => false);
    if (ready) break;
  }
  await pause(wait);
};
const waitFor = async (expr, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await pause(60);
  }
  throw new Error(`timeout: ${expr}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.removeItem('whynot-theme');localStorage.removeItem('whynot-guide')}catch{}` });
await media('dark');
await viewport(1440, 900);

await reload(360);
await screenshot('01-arrival-1440.png');
await waitFor(`document.querySelector('.stage').dataset.phase === 'stopped'`, 6000);
await pause(500);
await screenshot('02-stopped-1440.png');

await evaluate(`(async () => {
  const env = (name, value) => fetch('/__local/env', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, value }) });
  await env('MODEL_API_KEY', 'fake-local-key');
  await env('MODEL_ENDPOINT', 'http://127.0.0.1:8766/valid');
  for (const id of ['b10','esteady','snone']) document.getElementById(id).click();
})()`);
await pause(500);
await evaluate(`document.getElementById('issue').click()`);
await pause(180);
await screenshot('03-issue-press-1440.png');
await waitFor(`!!document.querySelector('#result .card')`, 8000);
await pause(160);
await screenshot('04-ticket-drop-1440.png');
await pause(700);
await evaluate(`restScene()`);
await pause(200);
await screenshot('05-resting-1440.png');
await evaluate(`(async () => {
  const env = (name, value) => fetch('/__local/env', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, value }) });
  await env('MODEL_API_KEY', null);
  await env('MODEL_ENDPOINT', null);
})()`);

await media('light');
await reload(2800);
await screenshot('06-light-stopped-1440.png');

await viewport(390, 844);
await reload(2600);
await screenshot('07-light-stopped-390.png');

ws.close();
edge.kill();
console.log('done');
