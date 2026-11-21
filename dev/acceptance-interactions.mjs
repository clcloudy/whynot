// Interaction acceptance against the local fixture server + fake model.
// Covers plan phases 1-2: weighted draw, decay, replacement, idempotent
// retries, turn versions, concurrency and model fallbacks.
import { randomUUID, createHash } from 'node:crypto';
import { modeWeights, eligibleModes, weightedPick, builtinOpening, pickOpening } from '../functions/interactions.mjs';
import { options } from '../functions/suggestions.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const FAKE = process.env.FAKE || 'http://127.0.0.1:8766';
const MODES = ['chat', 'discuss', 'micro'];
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
    token: () => token,
  };
}

const db = async () => (await fetch(`${BASE}/__local/db`)).json();
const counts = async () => (await fetch(`${FAKE}/counts`)).json();
const fault = (name, enabled) => fetch(`${BASE}/__local/fault`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, enabled }),
});
async function setEnv(name, value) {
  await fetch(`${BASE}/__local/env`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
}
const setSeed = value => setEnv('RNG_SEED', value);

// Same mulberry32 as dev/server.mjs: find a seed whose first output is in [low, high).
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

const CONTEXT = { scene: 'desk', energy: 'steady', budget: 5 };
const openBody = (overrides = {}) => ({ ...CONTEXT, request_id: randomUUID(), ...overrides });

// Owner is the SHA-256 of the session token, same as the server derives it.
async function historyOf(j) {
  const owner = createHash('sha256').update(j.token()).digest('hex');
  const tables = await db();
  return tables.interactions
    .filter(row => row.owner === owner)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 3)
    .map(row => ({ mode: row.mode, topic: row.topic }));
}

// Open with the mode roll placed inside the target mode's current interval.
async function openAs(j, mode, overrides = {}) {
  const weights = modeWeights(MODES, await historyOf(j));
  const total = MODES.reduce((sum, entry) => sum + weights[entry], 0);
  let before = 0;
  for (const entry of MODES) {
    if (entry === mode) break;
    before += weights[entry];
  }
  await setSeed(seedFor(before / total, (before + weights[mode]) / total));
  const result = await j.call('POST', '/api/interactions', openBody(overrides));
  await setSeed(null);
  return result;
}

const a = jar();
const b = jar();

console.log('入口校验');
check('无会话开场 401', (await a.call('POST', '/api/interactions', openBody())).status === 401);
await a.call('POST', '/api/session');
await b.call('POST', '/api/session');
for (const body of [
  { ...CONTEXT, request_id: randomUUID(), budget: 7 },
  { ...CONTEXT, request_id: randomUUID(), energy: 'tired' },
  { ...CONTEXT },
  { ...CONTEXT, request_id: 'not-a-uuid' },
  { ...CONTEXT, request_id: randomUUID(), replaces: 'nope' },
  { ...CONTEXT, request_id: randomUUID(), supports: ['voice'] },
  { ...CONTEXT, request_id: randomUUID(), extra: 1 },
]) {
  const result = await a.call('POST', '/api/interactions', body);
  check(`无效输入 ${JSON.stringify(body).slice(0, 80)}`, result.status === 400 && result.data?.error === 'INVALID_CONTEXT');
}
check('超 2KiB 请求体 413', (await a.call('POST', '/api/interactions', { ...openBody(), padding: 'x'.repeat(3000) })).status === 413);
check('非 JSON 415', (await a.call('POST', '/api/interactions', openBody(), { 'content-type': 'text/plain' })).status === 415);
check('无会话续聊 401', (await jar().call('POST', `/api/interactions/${randomUUID()}/turns`, { request_id: randomUUID(), version: 1, text: '你好' })).status === 401);

console.log('固定「桌前、还可以、5 分钟」：权重边界逐一命中');
await setEnv('MODEL_API_KEY', null);
const boundary = jar();
await boundary.call('POST', '/api/session');
for (const mode of MODES) {
  for (const label of ['下界', '上界内']) {
    const weights = modeWeights(MODES, await historyOf(boundary));
    const total = MODES.reduce((sum, entry) => sum + weights[entry], 0);
    let before = 0;
    for (const entry of MODES) {
      if (entry === mode) break;
      before += weights[entry];
    }
    const low = before / total;
    const high = (before + weights[mode]) / total;
    const mid = (low + high) / 2;
    // 种子取靠近边界的一侧，验证区间端点附近的命中。
    const seed = label === '下界' ? seedFor(low, mid) : seedFor(mid, high);
    await setSeed(seed);
    const result = await boundary.call('POST', '/api/interactions', openBody());
    await setSeed(null);
    check(`${mode} ${label} 命中`, result.status === 201 && result.data?.mode === mode, JSON.stringify(result.data));
  }
}
const shape = await boundary.call('POST', '/api/interactions', openBody());
check('响应含方式/话题/版本/期望输入', shape.status === 201
  && MODES.includes(shape.data.mode) && typeof shape.data.topic === 'string'
  && shape.data.version === 1 && ['text', 'none'].includes(shape.data.expected_input)
  && typeof shape.data.first_step === 'string' && shape.data.minutes >= 1 && shape.data.minutes <= 5);
check('互动编号复用卡片编号', (await db()).interactions.some(row => row.id === shape.data.id));

console.log('近期降权与恢复');
const decay = jar();
await decay.call('POST', '/api/session');
for (let i = 0; i < 3; i++) {
  const result = await openAs(decay, 'chat');
  check(`第 ${i + 1} 次强制聊天`, result.data?.mode === 'chat');
}
const decayedWeights = modeWeights(MODES, await historyOf(decay));
check('三连聊天后权重 7/20/20', decayedWeights.chat === 7 && decayedWeights.discuss === 20 && decayedWeights.micro === 20);
{
  // 8/47 高于降权后的聊天区间（7/47）；若未降权（35/75≈0.467）仍会命中聊天。
  await setSeed(seedFor(8 / 47, 9 / 47));
  const result = await decay.call('POST', '/api/interactions', openBody());
  await setSeed(null);
  check('降权后抽到讨论而非聊天', result.data?.mode === 'discuss');
}
for (const mode of ['discuss', 'micro', 'discuss']) {
  const result = await openAs(decay, mode);
  check(`恢复序列强制 ${mode}`, result.data?.mode === mode);
}
const restored = modeWeights(MODES, await historyOf(decay));
check('聊天滑出三轮后权重恢复 35', restored.chat === 35);
{
  const result = await openAs(decay, 'chat');
  check('恢复后可再抽中聊天', result.data?.mode === 'chat');
}

console.log('换一个的方式排除与单候选路径');
const solo = jar();
await solo.call('POST', '/api/session');
// 微行动兜底使自然条件下至少两种方式合格；单候选路径经「换一个」排除验证。
check('低精力 3 分钟不含讨论', !eligibleModes({ scene: 'desk', energy: 'low', budget: 3 }).includes('discuss'));
const soloMicro = await openAs(solo, 'micro');
check('取得微行动开场', soloMicro.data?.mode === 'micro');
const soloOther = await solo.call('POST', '/api/interactions', openBody({ replaces: soloMicro.data.id }));
check('换一个排除当前方式', soloOther.status === 201 && soloOther.data.mode !== 'micro');
const soloMicro2 = await solo.call('POST', '/api/interactions', openBody({ replaces: soloOther.data.id }));
check('再换不含上一方式', soloMicro2.status === 201 && soloMicro2.data.mode !== soloOther.data.mode);
// 经由换一个取得聊天卡，再沿替换链验证：相邻两张聊天卡话题必不同（排除当前话题），
// 而链上话题整体允许重复（只排除当前一项）。
let chatA = soloOther.data.mode === 'chat' ? soloOther.data : null;
let current = soloOther.data;
for (let i = 0; i < 8 && !chatA; i++) {
  const result = await solo.call('POST', '/api/interactions', openBody({ replaces: current.id }));
  current = result.data;
  if (current.mode === 'chat') chatA = current;
}
check('取得聊天卡', chatA !== null);
const chain = [chatA];
current = chatA;
for (let i = 0; i < 14; i++) {
  const result = await solo.call('POST', '/api/interactions', openBody({ replaces: current.id }));
  current = result.data;
  chain.push(current);
}
let switches = 0;
for (let i = 0; i + 1 < chain.length; i++) {
  if (chain[i].mode !== chain[i + 1].mode) switches++;
}
check('多方式时逐次换一个必换方式', switches === chain.length - 1);
check('话题降权后仍允许重复', pickOpening({ context: CONTEXT,
  history: [{ mode: 'chat', topic: 'week-focus' }], random: () => 0 }).topic === 'week-focus');
check('单候选时抽取返回唯一项（单元）', weightedPick(['only'], { only: 1 }, 0.999) === 'only');
const multi = jar();
await multi.call('POST', '/api/session');
const multiFirst = await multi.call('POST', '/api/interactions', openBody());
const multiReplace = await multi.call('POST', '/api/interactions', openBody({ replaces: multiFirst.data.id }));
check('多方式时换一个跳过当前方式', multiReplace.status === 201 && multiReplace.data.mode !== multiFirst.data.mode);
check('换一个不产生反馈', multiReplace.data.preference === null && multiReplace.data.completed === false);
check('换一个计入历史', (await historyOf(multi)).length === 2 && (await historyOf(multi))[0].mode === multiReplace.data.mode);
check('换卡后旧互动已结束', (await db()).interactions.find(row => row.id === multiFirst.data.id)?.state === 'closed');
check('换卡后旧卡仍可反馈', (await multi.call('POST', `/api/recommendations/${multiFirst.data.id}/feedback`, { kind: 'like' })).status === 200);
check('换非法编号 404', (await multi.call('POST', '/api/interactions', openBody({ replaces: randomUUID() }))).status === 404);
check('换他人卡片 404', (await multi.call('POST', '/api/interactions', openBody({ replaces: soloMicro.data.id }))).status === 404);

console.log('开场幂等与冲突');
const retryJar = jar();
await retryJar.call('POST', '/api/session');
const retryBody = openBody();
const retryFirst = await retryJar.call('POST', '/api/interactions', retryBody);
const retryAgain = await retryJar.call('POST', '/api/interactions', retryBody);
check('重试返回同一张卡', retryFirst.status === 201 && retryAgain.status === 200 && retryAgain.data.id === retryFirst.data.id);
check('重试不新增记录', (await db()).interactions.filter(row => row.request_id === retryBody.request_id).length === 1);
check('同键异载荷 409', (await retryJar.call('POST', '/api/interactions', { ...retryBody, budget: 10 })).status === 409);
{
  const body = openBody({ replaces: retryFirst.data.id });
  const first = await retryJar.call('POST', '/api/interactions', body);
  const again = await retryJar.call('POST', '/api/interactions', body);
  check('换一个重试同样幂等', first.status === 201 && again.status === 200 && again.data.id === first.data.id);
}

console.log('续聊：版本、幂等、并发与归属');
await setEnv('MODEL_API_KEY', null);
let noModel = null;
for (let i = 0; i < 20 && !noModel; i++) {
  const result = await a.call('POST', '/api/interactions', openBody());
  if (result.data?.state === 'open') noModel = result;
}
{
  const result = await a.call('POST', `/api/interactions/${noModel.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '最近在准备小组作业' });
  const row = (await db()).interactions.find(item => item.id === noModel.data.id);
  check('无模型时续聊 503 且保留轮次', result.status === 503 && result.data?.error === 'MODEL_UNAVAILABLE' && row.version === 1);
}
await setEnv('MODEL_API_KEY', 'fake-local-key');
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
const chatJar = jar();
await chatJar.call('POST', '/api/session');
let chatCard = null;
for (let i = 0; i < 20 && !chatCard; i++) {
  const result = await chatJar.call('POST', '/api/interactions', openBody());
  if (result.data?.mode === 'chat' || result.data?.mode === 'discuss') chatCard = result.data;
}
check('取得可续聊的开场', chatCard !== null && chatCard.state === 'open' && chatCard.expected_input === 'text');
const turn1Body = { request_id: randomUUID(), version: 1, text: '这周大部分时间在排练校庆节目' };
const turn1 = await chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, turn1Body);
check('首轮回复 201 且版本推进', turn1.status === 201 && typeof turn1.data?.reply === 'string' && turn1.data.version === 2);
const turn1Retry = await chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, turn1Body);
check('断线重发复用同一回复', turn1Retry.status === 200 && turn1Retry.data.reply === turn1.data.reply && turn1Retry.data.id === turn1.data.id);
check('重发不再推进版本', turn1Retry.data.version === 2 && (await db()).turns.filter(row => row.interaction_id === chatCard.id).length === 1);
check('同键异文本 409', (await chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, { ...turn1Body, text: '换一句' })).status === 409);
check('过期版本 409', (await chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, { request_id: randomUUID(), version: 1, text: '迟到的回复' })).status === 409);
const turn2Body = { request_id: randomUUID(), version: 2, text: '我负责灯光部分' };
const concurrent = await Promise.all([
  chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, turn2Body),
  chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, { ...turn2Body, request_id: randomUUID() }),
]);
check('并发回复只有一条推进', concurrent.map(result => result.status).sort().join(',') === '201,409', JSON.stringify(concurrent.map(result => result.data)));
check('并发后版本只加一', (await db()).interactions.find(row => row.id === chatCard.id).version === 3);
check('续聊不重新抽签', (await db()).interactions.find(row => row.id === chatCard.id).mode === chatCard.mode);
check('跨会话续聊 404', (await b.call('POST', `/api/interactions/${chatCard.id}/turns`, { request_id: randomUUID(), version: 3, text: '你好' })).status === 404);
check('跨会话换卡 404', (await b.call('POST', '/api/interactions', openBody({ replaces: chatCard.id }))).status === 404);
check('非法互动编号 404', (await chatJar.call('POST', '/api/interactions/not-a-uuid/turns', { request_id: randomUUID(), version: 1, text: '你好' })).status === 404);
for (const body of [
  { request_id: randomUUID(), version: 3 },
  { request_id: randomUUID(), text: '缺版本' },
  { request_id: 'bad', version: 3, text: '你好' },
  { request_id: randomUUID(), version: 0, text: '你好' },
  { request_id: randomUUID(), version: 3, text: '   ' },
  { request_id: randomUUID(), version: 3, text: '长'.repeat(501) },
  { request_id: randomUUID(), version: 3, text: '带\u0000控制符' },
  { request_id: randomUUID(), version: 3, text: '你好', extra: 1 },
]) {
  const result = await chatJar.call('POST', `/api/interactions/${chatCard.id}/turns`, body);
  check(`无效轮次输入 ${JSON.stringify(body).slice(0, 60)}`, result.status === 400 && result.data?.error === 'INVALID_TURN');
}
const microJar = jar();
await microJar.call('POST', '/api/session');
let microCard = null;
for (let i = 0; i < 30 && !microCard; i++) {
  const result = await microJar.call('POST', '/api/interactions', openBody());
  if (result.data?.mode === 'micro') microCard = result.data;
}
check('取得微行动卡', microCard !== null && microCard.state === 'card' && microCard.expected_input === 'none');
check('微行动不接受续聊', (await microJar.call('POST', `/api/interactions/${microCard.id}/turns`, { request_id: randomUUID(), version: 1, text: '做完了' })).status === 409);
check('微行动沿用卡片反馈', (await microJar.call('POST', `/api/recommendations/${microCard.id}/feedback`, { kind: 'completed' })).data?.completed === true);

console.log('模型路径：开场与回复');
const modelJar = jar();
await modelJar.call('POST', '/api/session');
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
let modelCard = null;
for (let i = 0; i < 20 && !modelCard; i++) {
  const result = await modelJar.call('POST', '/api/interactions', openBody());
  if (result.data?.mode !== 'micro') modelCard = result.data;
}
const modelRow = (await db()).recommendations.find(row => row.id === modelCard.id);
check('模型开场生效', modelRow?.source === 'model' && modelRow.title === 'fake 开场');
const modelTurn = await modelJar.call('POST', `/api/interactions/${modelCard.id}/turns`, { request_id: randomUUID(), version: 1, text: '在排练节目' });
check('模型回复生效', modelTurn.status === 201 && modelTurn.data.reply === 'fake 追问：那件事里最让你在意的是什么？');
for (const mode of ['chat', 'discuss']) {
  const fresh = jar();
  await fresh.call('POST', '/api/session');
  const modelOpening = await openAs(fresh, mode);
  const stored = (await db()).recommendations.find(row => row.id === modelOpening.data.id);
  check(`模型 ${mode} 开场按数据库契约入库`, modelOpening.status === 201 && stored?.source === 'model' && stored.category === mode);
}
const microWithModel = await openAs(modelJar, 'micro');
const drawn = builtinOpening('micro', microWithModel.data.topic, CONTEXT);
check('开启模型后微行动仍落实抽中的条目', microWithModel.data.first_step === drawn.first
  && (await db()).recommendations.find(row => row.id === microWithModel.data.id)?.action === microWithModel.data.topic);
for (const [mode, label] of [['schema-bad', '超预算开场'], ['not-json', '非 JSON 开场']]) {
  await setEnv('MODEL_ENDPOINT', `${FAKE}/${mode}`);
  const result = await modelJar.call('POST', '/api/interactions', openBody());
  const row = (await db()).recommendations.find(item => item.id === result.data.id);
  check(`${label} → 同方式内置兜底`, result.status === 201 && row?.source === 'builtin');
}
await setEnv('MODEL_ENDPOINT', `${FAKE}/http500`);
const before500 = (await counts()).http500 ?? 0;
const result500 = await openAs(modelJar, 'chat');
check('开场 5xx → 兜底', result500.status === 201 && (await db()).recommendations.find(row => row.id === result500.data.id)?.source === 'builtin');
check('开场 5xx 重试一次为止', (await counts()).http500 - before500 === 2);
await setEnv('MODEL_ENDPOINT', `${FAKE}/http401`);
const before401 = (await counts()).http401 ?? 0;
const result401 = await openAs(modelJar, 'discuss');
check('开场 401 → 兜底且不重试', result401.status === 201 && (await counts()).http401 - before401 === 1);
await setEnv('MODEL_ENDPOINT', `${FAKE}/schema-bad`);
let badReplyCard = null;
for (let i = 0; i < 20 && !badReplyCard; i++) {
  const result = await modelJar.call('POST', '/api/interactions', openBody());
  if (result.data?.mode !== 'micro') badReplyCard = result.data;
}
const badReply = await modelJar.call('POST', `/api/interactions/${badReplyCard.id}/turns`, { request_id: randomUUID(), version: 1, text: '在忙演出' });
check('无效回复保留原轮次', badReply.status === 503 && (await db()).interactions.find(row => row.id === badReplyCard.id).version === 1);
await setEnv('MODEL_ENDPOINT', `${FAKE}/slow`);
const slowStarted = Date.now();
const slowReply = await modelJar.call('POST', `/api/interactions/${badReplyCard.id}/turns`, { request_id: randomUUID(), version: 1, text: '在忙演出' });
const slowElapsed = Date.now() - slowStarted;
check('回复超时 → 503 保留轮次', slowReply.status === 503 && (await db()).interactions.find(row => row.id === badReplyCard.id).version === 1);
check('回复有限等待（两次 7 秒超时）', slowElapsed >= 13000 && slowElapsed < 20000, `${slowElapsed}ms`);
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
const recovered = await modelJar.call('POST', `/api/interactions/${badReplyCard.id}/turns`, { request_id: randomUUID(), version: 1, text: '在忙演出' });
check('失败后重试成功', recovered.status === 201 && recovered.data.version === 2);
const concurrentModel = await Promise.all([
  modelJar.call('POST', `/api/interactions/${badReplyCard.id}/turns`, { request_id: randomUUID(), version: 2, text: '负责道具' }),
  modelJar.call('POST', `/api/interactions/${badReplyCard.id}/turns`, { request_id: randomUUID(), version: 2, text: '负责道具' }),
]);
check('模型并发回复只有一条推进', concurrentModel.map(result => result.status).sort().join(',') === '201,409');

console.log('旧入口与旧卡反馈回归');
const legacy = await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' });
check('旧推荐入口仍 201', legacy.status === 201 && legacy.data.minutes <= 3);
check('旧入口不写互动表', !(await db()).interactions.some(row => row.id === legacy.data.id));
check('互动卡可喜欢', (await a.call('POST', `/api/recommendations/${noModel.data.id}/feedback`, { kind: 'like' })).data?.preference === 'like');
check('互动卡可完成', (await a.call('POST', `/api/recommendations/${noModel.data.id}/feedback`, { kind: 'completed' })).data?.completed === true);
check('他人互动卡反馈 404', (await b.call('POST', `/api/recommendations/${noModel.data.id}/feedback`, { kind: 'like' })).status === 404);

console.log('全部条件组合');
let combos = 0;
const comboFailures = [];
for (const scene of [null, 'waiting', 'desk', 'outside', 'home']) {
  for (const energy of ['low', 'steady', 'high']) {
    for (const budget of [3, 5, 10, 15]) {
      const body = { budget, energy, request_id: randomUUID(), ...(scene ? { scene } : {}) };
      const result = await a.call('POST', '/api/interactions', body);
      combos++;
      if (result.status !== 201 || result.data.minutes > budget || result.data.minutes < 1) {
        comboFailures.push(JSON.stringify(body));
        continue;
      }
      const eligible = eligibleModes({ scene, energy, budget });
      if (!eligible.includes(result.data.mode)) comboFailures.push(`mode ${result.data.mode} ${JSON.stringify(body)}`);
      if (result.data.mode === 'micro') {
        const validActions = options(scene, energy, budget).map(item => item.action);
        if (!validActions.includes(result.data.topic)) comboFailures.push(`action ${result.data.topic}`);
      }
      if (energy === 'low' && result.data.mode === 'discuss') comboFailures.push(`discuss-low ${JSON.stringify(body)}`);
    }
  }
}
check(`${combos} 种组合全部合规`, comboFailures.length === 0, comboFailures.join('; '));

console.log('空历史抽样（随机，非种子）');
await setSeed(null);
const sampleCounts = { chat: 0, discuss: 0, micro: 0 };
const SAMPLES = 1200;
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
check('聊天频率接近 35/75', Math.abs(frequencies.chat - 35 / 75) < 0.04, JSON.stringify(frequencies));
check('讨论频率接近 20/75', Math.abs(frequencies.discuss - 20 / 75) < 0.04, JSON.stringify(frequencies));
check('微行动频率接近 20/75', Math.abs(frequencies.micro - 20 / 75) < 0.04, JSON.stringify(frequencies));

console.log('审查回归：事务、模型上下文和结束互动');
const txJar = jar();
await txJar.call('POST', '/api/session');
const owner = createHash('sha256').update(txJar.token()).digest('hex');
const requestBody = openBody();
await setSeed(seedFor(0, 0.4));
await fault('interaction', true);
const failedOpening = await txJar.call('POST', '/api/interactions', requestBody);
await fault('interaction', false);
const afterOpeningFault = await db();
check('开场第二次写入失败时推荐和互动一起回滚', failedOpening.status === 503
  && !afterOpeningFault.recommendations.some(row => row.owner === owner)
  && !afterOpeningFault.interactions.some(row => row.owner === owner));
await setSeed(seedFor(0, 0.4));
const txOpen = await txJar.call('POST', '/api/interactions', requestBody);
await setSeed(null);
check('开场相同请求重试成功', txOpen.status === 201 && txOpen.data.mode === 'chat');
const turnsPath = `/api/interactions/${txOpen.data.id}/turns`;
await setEnv('MODEL_ENDPOINT', `${FAKE}/capture`);
const firstTurn = { request_id: randomUUID(), version: 1, text: '第 A 句' };
await fault('advance', true);
const failedTurn = await txJar.call('POST', turnsPath, firstTurn);
await fault('advance', false);
const afterTurnFault = await db();
check('推进版本失败时已插入轮次回滚', failedTurn.status === 503
  && !afterTurnFault.turns.some(row => row.interaction_id === txOpen.data.id)
  && afterTurnFault.interactions.find(row => row.id === txOpen.data.id)?.version === 1);
const retriedTurn = await txJar.call('POST', turnsPath, firstTurn);
check('相同请求重试可继续对话', retriedTurn.status === 201 && retriedTurn.data.version === 2);
for (const [idx, letter] of [...'BCDE'].entries()) {
  const result = await txJar.call('POST', turnsPath, { request_id: randomUUID(), version: idx + 2, text: `第 ${letter} 句` });
  check(`第 ${letter} 句可继续接话`, result.status === 201);
}
const messages = await (await fetch(`${FAKE}/messages`)).json();
const sent = messages.slice(1).map(message => JSON.parse(message.content));
check('发给模型的是最新三轮、当前发言和实际开场', sent.find(message => message.source === 'opening')?.text.includes(txOpen.data.first_step)
  && sent.filter(message => ['history', 'latest_input'].includes(message.source) && typeof message.untrusted_user_data === 'object')
    .map(message => message.untrusted_user_data.text).join('|') === '第 B 句|第 C 句|第 D 句|第 E 句');
const sentContext = sent.find(message => message.source === 'context')?.untrusted_user_data;
check('送模包含已保存的场景、精力和时间且不污染固定前缀', sentContext?.budget === 5
  && sentContext.energy === '还可以' && sentContext.scene === '在桌前' && !messages[0].content.includes('在桌前'));
const oldReplay = await txJar.call('POST', turnsPath, firstTurn);
check('旧轮次重试返回初次响应版本', oldReplay.status === 200 && oldReplay.data.version === 2);
const wrongVersion = await txJar.call('POST', turnsPath, { ...firstTurn, version: 6 });
check('同键只改版本也冲突', wrongVersion.status === 409 && wrongVersion.data?.error === 'REQUEST_CONFLICT');
const replace = await txJar.call('POST', '/api/interactions', openBody({ replaces: txOpen.data.id }));
check('换卡成功即清除旧轮次正文', replace.status === 201 && !(await db()).turns.some(row => row.interaction_id === txOpen.data.id));
check('结束的互动不可重放或续聊', (await txJar.call('POST', turnsPath, firstTurn)).status === 409
  && (await txJar.call('POST', turnsPath, { ...firstTurn, request_id: randomUUID(), version: 6 })).status === 409);
check('主动结束互动返回 204', (await txJar.call('DELETE', `/api/interactions/${replace.data.id}`)).status === 204);
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
