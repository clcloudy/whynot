// Photo-mode acceptance against the local fixture server + fake model.
// Covers plan phase 3: eligibility gating, upload validation, vision turns,
// ambiguity, expiry, cleanup, retries and concurrency.
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { eligibleModes, modeWeights } from '../functions/interactions.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const FAKE = 'http://127.0.0.1:8766';
let passed = 0, failed = 0;

function check(name, condition, extra = '') {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${extra}`); }
}

function jar() {
  let token = '';
  return {
    async call(method, path, body, headers = {}) {
      const response = await fetch(`${BASE}/functions/v1/app${path}`, {
        method,
        headers: { ...(token ? { 'x-whynot-session': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (typeof data?.token === 'string') token = data.token;
      return { status: response.status, data };
    },
    async upload(path, bytes, mime = 'image/png') {
      const response = await fetch(`${BASE}/functions/v1/app${path}`, {
        method: 'POST',
        headers: { ...(token ? { 'x-whynot-session': token } : {}), 'content-type': mime },
        body: bytes,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      return { status: response.status, data };
    },
    token: () => token,
  };
}

const db = async () => (await fetch(`${BASE}/__local/db`)).json();
async function setEnv(name, value) {
  await fetch(`${BASE}/__local/env`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
}
const setSeed = value => setEnv('RNG_SEED', value);
const setClock = ms => setEnv('CLOCK_OFFSET_MS', ms);

function firstOutput(seed) {
  let state = seed >>> 0;
  state = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function seedFor(low, high) {
  for (let seed = 1; seed < 1000000; seed++) {
    const value = firstOutput(seed);
    if (value >= low && value < high) return seed;
  }
  throw new Error(`no seed for [${low}, ${high})`);
}

// Minimal but structurally valid PNGs; dimensions live in the IHDR header.
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PHOTO = png(64, 48);

const CONTEXT = { scene: 'desk', energy: 'steady', budget: 5 };
const openBody = (overrides = {}) => ({ ...CONTEXT, request_id: randomUUID(), supports: ['text', 'image'], ...overrides });

// Force the mode roll into the photo interval of the current eligible set.
async function openPhoto(j, overrides = {}) {
  const modes = eligibleModes(CONTEXT, { imageReady: true });
  const tables = await db();
  const { createHash } = await import('node:crypto');
  const owner = createHash('sha256').update(j.token()).digest('hex');
  const history = tables.interactions
    .filter(row => row.owner === owner)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 3)
    .map(row => ({ mode: row.mode, topic: row.topic }));
  const weights = modeWeights(modes, history);
  const total = modes.reduce((sum, mode) => sum + weights[mode], 0);
  let before = 0;
  for (const mode of modes) {
    if (mode === 'photo') break;
    before += weights[mode];
  }
  await setSeed(seedFor(before / total, (before + weights.photo) / total));
  const result = await j.call('POST', '/api/interactions', openBody(overrides));
  await setSeed(null);
  return result;
}

console.log('抽取资格门控');
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
await setEnv('MODEL_API_KEY', null);
const noKey = jar();
await noKey.call('POST', '/api/session');
let sawPhoto = false;
for (let i = 0; i < 30; i++) {
  const result = await noKey.call('POST', '/api/interactions', openBody());
  if (result.data?.mode === 'photo') sawPhoto = true;
}
check('无模型 Key 时不抽中看图', !sawPhoto);
await setEnv('MODEL_API_KEY', 'fake-local-key');
const textOnly = jar();
await textOnly.call('POST', '/api/session');
sawPhoto = false;
for (let i = 0; i < 30; i++) {
  const result = await textOnly.call('POST', '/api/interactions', openBody({ supports: ['text'] }));
  if (result.data?.mode === 'photo') sawPhoto = true;
}
check('客户端不支持传图时不抽中看图', !sawPhoto);
const walking = jar();
await walking.call('POST', '/api/session');
sawPhoto = false;
for (let i = 0; i < 30; i++) {
  const result = await walking.call('POST', '/api/interactions', openBody({ scene: 'outside' }));
  if (result.data?.mode === 'photo') sawPhoto = true;
}
check('在路上不抽中看图', !sawPhoto);
check('资格函数排除在路上', !eligibleModes({ scene: 'outside', energy: 'steady', budget: 5 }, { imageReady: true }).includes('photo'));

const pj = jar();
await pj.call('POST', '/api/session');
const photoCard = await openPhoto(pj);
check('强制命中看图开场', photoCard.status === 201 && photoCard.data?.mode === 'photo', JSON.stringify(photoCard.data));
check('看图卡等待图片', photoCard.data.state === 'awaiting_image' && photoCard.data.expected_input === 'image'
  && photoCard.data.first_step.includes('拍') && photoCard.data.minutes <= 5);

console.log('上传入口校验');
check('无会话上传 401', (await jar().upload(`/api/interactions/${photoCard.data.id}/images?version=1`, PHOTO)).status === 401);
const chatCard = await (async () => {
  for (let i = 0; i < 20; i++) {
    const result = await pj.call('POST', '/api/interactions', openBody({ supports: ['text'] }));
    if (result.data?.mode === 'chat' || result.data?.mode === 'discuss') return result.data;
  }
  return null;
})();
check('文字互动不接受图片 409', (await pj.upload(`/api/interactions/${chatCard.id}/images?version=1`, PHOTO)).status === 409);
const other = jar();
await other.call('POST', '/api/session');
check('跨会话上传 404', (await other.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, PHOTO)).status === 404);
check('缺版本参数 400', (await pj.upload(`/api/interactions/${photoCard.data.id}/images`, PHOTO)).status === 400);
check('过期版本上传 409', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=9`, PHOTO)).status === 409);
check('非图片字节 415', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, Buffer.from('just text bytes'))).status === 415);
check('截断 PNG 400', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, PHOTO.subarray(0, 12))).status === 400);
const corrupt = Buffer.from(PHOTO);
corrupt[45] ^= 0xff;
check('尺寸正确但 IDAT 已坏的 PNG 400',
  (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, corrupt)).status === 400);
check('超大尺寸 400', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, png(8192, 8192))).status === 400);
{
  const oversize = Buffer.concat([PHOTO, Buffer.alloc(4 * 1024 * 1024)]);
  check('超 4MiB 413', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, oversize)).status === 413);
}
check('未传图先接话 409', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, PHOTO.subarray(0, 12))).status === 400
  && (await pj.call('POST', `/api/interactions/${photoCard.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '拍好了' })).status === 409);
const uploaded = await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=1`, PHOTO);
check('合法上传 201 返回短期引用', uploaded.status === 201 && typeof uploaded.data?.image_ref === 'string'
  && uploaded.data.mime === 'image/png' && uploaded.data.bytes === PHOTO.length && typeof uploaded.data.expires_at === 'string');

console.log('识图轮次');
const turnBody = { request_id: randomUUID(), version: 1, image_ref: uploaded.data.image_ref };
const recognized = await pj.call('POST', `/api/interactions/${photoCard.data.id}/turns`, turnBody);
check('识图成功 201 含词与音标', recognized.status === 201 && recognized.data?.word?.word === 'stapler'
  && recognized.data.word.ipa.includes('ˈ') && recognized.data.reply.includes('stapler') && recognized.data.version === 2, JSON.stringify(recognized.data));
const afterRow = (await db()).interactions.find(row => row.id === photoCard.data.id);
check('识图后进入练习状态', afterRow.state === 'open' && afterRow.word?.word === 'stapler');
check('识别完成后释放原图', !(await db()).images.some(row => row.id === uploaded.data.image_ref));
const retry = await pj.call('POST', `/api/interactions/${photoCard.data.id}/turns`, turnBody);
check('断线重发复用同一识图结果', retry.status === 200 && retry.data.reply === recognized.data.reply && retry.data.word?.word === 'stapler');
check('同键异引用 409', (await pj.call('POST', `/api/interactions/${photoCard.data.id}/turns`, { ...turnBody, image_ref: randomUUID() })).status === 409);
const practice = await pj.call('POST', `/api/interactions/${photoCard.data.id}/turns`, { request_id: randomUUID(), version: 2, text: '再念一次' });
check('练习轮沿用已保存的词', practice.status === 201 && practice.data.version === 3);
check('识别后不再接受上传', (await pj.upload(`/api/interactions/${photoCard.data.id}/images?version=3`, PHOTO)).status === 409);
check('看图卡可反馈', (await pj.call('POST', `/api/recommendations/${photoCard.data.id}/feedback`, { kind: 'like' })).data?.preference === 'like');
check('跨会话引用图片 404', (await other.call('POST', `/api/interactions/${photoCard.data.id}/turns`, turnBody)).status === 404);

console.log('歧义与澄清');
await setEnv('MODEL_ENDPOINT', `${FAKE}/ambiguous`);
const ambCard = await openPhoto(pj);
const ambUpload = await pj.upload(`/api/interactions/${ambCard.data.id}/images?version=1`, PHOTO);
const ambTurn = await pj.call('POST', `/api/interactions/${ambCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: ambUpload.data.image_ref });
check('歧义时先问用户', ambTurn.status === 201 && ambTurn.data.reply.includes('哪') && !ambTurn.data.word && ambTurn.data.version === 2);
const ambRow = (await db()).interactions.find(row => row.id === ambCard.data.id);
check('歧义后仍等待图片且保留原图', ambRow.state === 'awaiting_image'
  && (await db()).images.some(row => row.id === ambUpload.data.image_ref));
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
const clarified = await pj.call('POST', `/api/interactions/${ambCard.data.id}/turns`, { request_id: randomUUID(), version: 2, text: '左边那个' });
check('文字澄清后识图成功', clarified.status === 201 && clarified.data.word?.word === 'stapler' && clarified.data.version === 3);
check('澄清成功后释放原图', !(await db()).images.some(row => row.id === ambUpload.data.image_ref));

console.log('失败、过期与清理');
await setEnv('MODEL_ENDPOINT', `${FAKE}/schema-bad`);
const badCard = await openPhoto(pj);
const badUpload = await pj.upload(`/api/interactions/${badCard.data.id}/images?version=1`, PHOTO);
const badTurn = await pj.call('POST', `/api/interactions/${badCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: badUpload.data.image_ref });
check('无效识图输出 503 保留轮次', badTurn.status === 503
  && (await db()).interactions.find(row => row.id === badCard.data.id).version === 1
  && (await db()).images.some(row => row.id === badUpload.data.image_ref));
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
const badRetry = await pj.call('POST', `/api/interactions/${badCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: badUpload.data.image_ref });
check('失败后重拍入口仍可用（同引用重试）', badRetry.status === 201 && badRetry.data.word?.word === 'stapler');
{
  const expCard = await openPhoto(pj);
  const expUpload = await pj.upload(`/api/interactions/${expCard.data.id}/images?version=1`, PHOTO);
  await setClock(2 * 60 * 60 * 1000);
  const expired = await pj.call('POST', `/api/interactions/${expCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: expUpload.data.image_ref });
  check('引用过期 409', expired.status === 409 && expired.data?.error === 'IMAGE_EXPIRED');
  let retained = true;
  for (let attempt = 0; retained && attempt < 100; attempt++) {
    retained = (await db()).images.some(row => row.id === expUpload.data.image_ref && row.data);
    if (retained) await delay(25);
  }
  check('没有新的图片请求时也会清理到期图像内容', !retained);
  const reUpload = await pj.upload(`/api/interactions/${expCard.data.id}/images?version=1`, PHOTO);
  check('过期后可重新上传', reUpload.status === 201);
  const tables = await db();
  check('放弃上传的残留图片到期清理', !tables.images.some(row => row.id === expUpload.data.image_ref));
  await setClock(0);
}
{
  const conCard = await openPhoto(pj);
  const conUpload = await pj.upload(`/api/interactions/${conCard.data.id}/images?version=1`, PHOTO);
  const concurrent = await Promise.all([
    pj.call('POST', `/api/interactions/${conCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: conUpload.data.image_ref }),
    pj.call('POST', `/api/interactions/${conCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: conUpload.data.image_ref }),
  ]);
  const statuses = concurrent.map(result => result.status).sort();
  const winners = concurrent.filter(result => result.status === 201);
  check('并发识图只有一条推进', winners.length === 1 && statuses.every(status => status === 201 || status === 400 || status === 409), JSON.stringify(concurrent.map(result => result.data)));
  check('并发后版本只加一', (await db()).interactions.find(row => row.id === conCard.data.id).version === 2);
}
{
  const replaceTarget = await openPhoto(pj);
  const replaced = await pj.call('POST', '/api/interactions', openBody({ replaces: replaceTarget.data.id }));
  check('换一个排除看图方式', replaced.status === 201 && replaced.data.mode !== 'photo');
}
await setEnv('MODEL_ENDPOINT', `${FAKE}/slow`);
{
  const slowCard = await openPhoto(pj);
  const slowUpload = await pj.upload(`/api/interactions/${slowCard.data.id}/images?version=1`, PHOTO);
  const started = Date.now();
  const slowTurn = await pj.call('POST', `/api/interactions/${slowCard.data.id}/turns`, { request_id: randomUUID(), version: 1, image_ref: slowUpload.data.image_ref });
  const elapsed = Date.now() - started;
  check('识图超时 503 保留轮次', slowTurn.status === 503
    && (await db()).interactions.find(row => row.id === slowCard.data.id).version === 1);
  check('识图有限等待（两次 7 秒超时）', elapsed >= 13000 && elapsed < 20000, `${elapsed}ms`);
}
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);

console.log('固定条件抽样（含图片能力）');
await setSeed(null);
const sampleCounts = { chat: 0, discuss: 0, micro: 0, photo: 0 };
const SAMPLES = 600;
let sampleFailures = 0;
for (let i = 0; i < SAMPLES; i++) {
  const fresh = jar();
  await fresh.call('POST', '/api/session');
  const result = await fresh.call('POST', '/api/interactions', openBody());
  if (result.status !== 201 || !(result.data.mode in sampleCounts)) { sampleFailures++; continue; }
  sampleCounts[result.data.mode]++;
}
check('抽样全部成功', sampleFailures === 0);
const frequencies = Object.fromEntries(Object.entries(sampleCounts).map(([mode, count]) => [mode, count / SAMPLES]));
console.log('  频率', JSON.stringify(frequencies));
check('四类频率接近配置权重', Math.abs(frequencies.chat - 0.35) < 0.05 && Math.abs(frequencies.discuss - 0.2) < 0.05
  && Math.abs(frequencies.micro - 0.2) < 0.05 && Math.abs(frequencies.photo - 0.25) < 0.05, JSON.stringify(frequencies));
{
  const streak = jar();
  await streak.call('POST', '/api/session');
  const sequence = [];
  for (let i = 0; i < 40; i++) {
    const result = await streak.call('POST', '/api/interactions', openBody());
    sequence.push(result.data.mode);
  }
  let adjacentSame = 0;
  for (let i = 0; i + 1 < sequence.length; i++) if (sequence[i] === sequence[i + 1]) adjacentSame++;
  let coverage = 0;
  for (let i = 0; i + 10 <= sequence.length; i += 10) coverage += new Set(sequence.slice(i, i + 10)).size;
  const avgCoverage = coverage / 4;
  console.log(`  连续开场：相邻同方式 ${adjacentSame}/39，每十次覆盖 ${avgCoverage} 种`);
  check('降权使相邻重复保持低位', adjacentSame / 39 < 0.25, `${adjacentSame}/39`);
  check('每十次开场覆盖多种方式', avgCoverage >= 2.5, `${avgCoverage}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
