// Memory acceptance against the local fixture server + fake model.
// Covers plan phase 4 and the memory design doc: candidates, confirmation,
// list/edit/delete, revisit cooldown, expiry, recall and ownership.
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { modeWeights } from '../functions/interactions.mjs';
import { validateCandidate } from '../functions/model.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const FAKE = 'http://127.0.0.1:8766';
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
const fault = (name, enabled) => fetch(`${BASE}/__local/fault`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, enabled }),
});
async function until(read, matches) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (matches(await read())) return true;
    await delay(25);
  }
  return false;
}
async function setEnv(name, value) {
  await fetch(`${BASE}/__local/env`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
}
const setSeed = value => setEnv('RNG_SEED', value);
const setClock = ms => setEnv('CLOCK_OFFSET_MS', ms);
const DAY = 24 * 60 * 60 * 1000;

function mulberry(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTEXT = { scene: 'desk', energy: 'steady', budget: 5 };
const openBody = (overrides = {}) => ({ ...CONTEXT, request_id: randomUUID(), ...overrides });

async function historyOf(j) {
  const owner = createHash('sha256').update(j.token()).digest('hex');
  const tables = await db();
  return tables.interactions
    .filter(row => row.owner === owner)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 3)
    .map(row => ({ mode: row.mode, topic: row.topic }));
}

function chatInterval(history) {
  const weights = modeWeights(MODES, history);
  const total = MODES.reduce((sum, mode) => sum + weights[mode], 0);
  return [0, weights.chat / total];
}

// Opening consumes: mode roll, topic roll, then (chat only) the revisit roll.
function seedForChat(history, revisit) {
  const [low, high] = chatInterval(history);
  for (let seed = 1; seed < 2000000; seed++) {
    const rng = mulberry(seed);
    const mode = rng();
    if (mode < low || mode >= high) continue;
    rng();
    const roll = rng();
    if (revisit ? roll < 0.25 : roll >= 0.25) return seed;
  }
  throw new Error('no seed found');
}

async function openChat(j, { revisit = false, overrides = {} } = {}) {
  const history = await historyOf(j);
  await setSeed(seedForChat(history, revisit));
  const result = await j.call('POST', '/api/interactions', openBody(overrides));
  await setSeed(null);
  return result;
}

await setEnv('MODEL_API_KEY', 'fake-local-key');
await setEnv('MODEL_ENDPOINT', `${FAKE}/memory-candidate`);

console.log('候选摘要');
check('非法摘要不通过校验（单元）', validateCandidate({ text: '长'.repeat(61), kind: 'status', topic: 'x' }) === null
  && validateCandidate({ text: 'ok', kind: 'guess', topic: 'x' }) === null
  && validateCandidate({ text: 'ok', kind: 'status', topic: '' }) === null
  && validateCandidate({ text: '最近在排练', kind: 'status', topic: '排练' }) !== null);
const mj = jar();
await mj.call('POST', '/api/session');
const chat1 = await openChat(mj);
check('取得聊天开场', chat1.status === 201 && chat1.data?.mode === 'chat');
const turn1Body = { request_id: randomUUID(), version: 1, text: '最近在排练节目' };
const turn1 = await mj.call('POST', `/api/interactions/${chat1.data.id}/turns`, turn1Body);
check('模型候选附在回复上', turn1.status === 201 && turn1.data?.candidate?.text === '最近在排练节目'
  && turn1.data.candidate.kind === 'status' && turn1.data.candidate.version === 1, JSON.stringify(turn1.data));
const retryTurn1 = await mj.call('POST', `/api/interactions/${chat1.data.id}/turns`, turn1Body);
check('候选随重发复用', retryTurn1.status === 200 && retryTurn1.data.candidate?.id === turn1.data.candidate.id);
const explicit = await mj.call('POST', `/api/interactions/${chat1.data.id}/turns`, { request_id: randomUUID(), version: 2, text: '帮我记住：下周三交论文' });
check('明确「帮我记住」生成候选', explicit.status === 201 && explicit.data?.candidate?.text === '下周三交论文', JSON.stringify(explicit.data));
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
const plain = await mj.call('POST', `/api/interactions/${chat1.data.id}/turns`, { request_id: randomUUID(), version: 3, text: '灯光部分' });
check('无值得记的内容不产生候选', plain.status === 201 && !plain.data.candidate);
await setEnv('MODEL_ENDPOINT', `${FAKE}/memory-candidate`);

console.log('跳过与确认');
const skipJar = jar();
await skipJar.call('POST', '/api/session');
const skipChat = await openChat(skipJar);
const skipTurn = await skipJar.call('POST', `/api/interactions/${skipChat.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '最近在排练' });
const skipResult = await skipJar.call('POST', `/api/interactions/${skipChat.data.id}/memories`, { candidate_id: skipTurn.data.candidate.id, version: 1, action: 'skip' });
check('跳过候选成功', skipResult.status === 200 && skipResult.data?.skipped === true);
check('跳过后列表为空', (await skipJar.call('GET', '/api/memories')).data?.memories?.length === 0);
const skipAgain = await skipJar.call('POST', `/api/interactions/${skipChat.data.id}/memories`, { candidate_id: skipTurn.data.candidate.id, version: 1, action: 'skip' });
check('重复跳过返回同一结果', skipAgain.status === 200 && skipAgain.data?.skipped === true);
const skipContinue = await skipJar.call('POST', `/api/interactions/${skipChat.data.id}/turns`, { request_id: randomUUID(), version: 2, text: '排的是校庆节目' });
check('跳过后当前互动仍可继续聊', skipContinue.status === 201);
const skipConfirm = await skipJar.call('POST', `/api/interactions/${skipChat.data.id}/memories`, { candidate_id: skipTurn.data.candidate.id, version: 1 });
check('已跳过的候选不能再确认', skipConfirm.status === 200 && skipConfirm.data?.skipped === true);

const confirmTurn = await mj.call('POST', `/api/interactions/${chat1.data.id}/turns`, { request_id: randomUUID(), version: 4, text: '我负责灯光' });
const candidateId = confirmTurn.data.candidate.id;
const confirmBody = { candidate_id: candidateId, version: 1 };
const concurrentConfirm = await Promise.all([
  mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, confirmBody),
  mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, confirmBody),
]);
check('并发确认只保存一次', concurrentConfirm.map(r => r.status).sort().join(',') === '200,201'
  && concurrentConfirm[0].data.id === concurrentConfirm[1].data.id, JSON.stringify(concurrentConfirm.map(r => r.data)));
const memoryId = concurrentConfirm.find(r => r.status === 201).data.id;
const confirmed = concurrentConfirm.find(r => r.status === 201).data;
check('确认保存用户看过的文字', confirmed.text === '最近在排练节目' && confirmed.kind === 'status' && confirmed.version === 1
  && Date.parse(confirmed.expires_at) - Date.parse(confirmed.confirmed_at) === 30 * DAY);
const confirmRetry = await mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, confirmBody);
check('重复确认返回同一结果', confirmRetry.status === 200 && confirmRetry.data.id === memoryId);
check('同键异文字 409', (await mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, { ...confirmBody, text: '另一句' })).status === 409);
check('候选版本不符 409', (await mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, { candidate_id: candidateId, version: 2 })).status === 409);
check('无会话确认 401', (await jar().call('POST', `/api/interactions/${chat1.data.id}/memories`, confirmBody)).status === 401);
const other = jar();
await other.call('POST', '/api/session');
check('跨会话确认 404', (await other.call('POST', `/api/interactions/${chat1.data.id}/memories`, confirmBody)).status === 404);
check('跨会话列表为空', (await other.call('GET', '/api/memories')).data?.memories?.length === 0);
const otherChat = await openChat(other);
check('候选挂在别的互动上 404', (await mj.call('POST', `/api/interactions/${otherChat.data.id}/memories`, confirmBody)).status === 404);
const editTurn = await mj.call('POST', `/api/interactions/${chat1.data.id}/turns`, { request_id: randomUUID(), version: 5, text: '帮我记住：在准备校庆演出' });
const edited = await mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, { candidate_id: editTurn.data.candidate.id, version: 1, text: '在准备校庆演出' });
check('编辑后确认保存最终文字', edited.status === 201 && edited.data.text === '在准备校庆演出');
check('非法确认输入 400', (await mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, { candidate_id: candidateId, version: 1, extra: 1 })).status === 400);

console.log('列表、更正与删除');
const list = await mj.call('GET', '/api/memories');
check('列表含两条有效条目', list.status === 200 && list.data.memories.length === 2 && list.data.total === 2);
check('列表展示期限与版本', list.data.memories.every(m => m.id && m.text && m.kind && m.version >= 1 && m.confirmed_at && m.expires_at));
const paged = await mj.call('GET', '/api/memories?limit=1&offset=1');
check('分页生效', paged.data.memories.length === 1 && paged.data.total === 2);
check('非法分页 400', (await mj.call('GET', '/api/memories?limit=0')).status === 400);
const patch = await mj.call('PATCH', `/api/memories/${memoryId}`, { text: '演出结束了', version: 1 });
check('更正递增版本', patch.status === 200 && patch.data.version === 2 && patch.data.text === '演出结束了');
check('旧版本更正 409', (await mj.call('PATCH', `/api/memories/${memoryId}`, { text: '再来一次', version: 1 })).status === 409);
const patchRetry = await mj.call('PATCH', `/api/memories/${memoryId}`, { text: '演出结束了', version: 1 });
check('更正重发幂等', patchRetry.status === 200 && patchRetry.data.version === 2);
const concurrentPatch = await Promise.all([
  mj.call('PATCH', `/api/memories/${memoryId}`, { text: '甲', version: 2 }),
  mj.call('PATCH', `/api/memories/${memoryId}`, { text: '乙', version: 2 }),
]);
check('并发更正只有一条成功', concurrentPatch.map(r => r.status).sort().join(',') === '200,409', JSON.stringify(concurrentPatch.map(r => r.data)));
check('跨会话更正 404', (await other.call('PATCH', `/api/memories/${memoryId}`, { text: 'x', version: 3 })).status === 404);
check('跨会话删除 404', (await other.call('DELETE', `/api/memories/${memoryId}`)).status === 404);
const winner = concurrentPatch.find(r => r.status === 200).data;
check('删除返回 204', (await mj.call('DELETE', `/api/memories/${memoryId}`)).status === 204);
check('重复删除同样 204', (await mj.call('DELETE', `/api/memories/${memoryId}`)).status === 204);
check('删除后列表只剩一条', (await mj.call('GET', '/api/memories')).data.memories.length === 1);
check('删除后重放旧确认不能重建', (await mj.call('POST', `/api/interactions/${chat1.data.id}/memories`, confirmBody)).status === 404);
check('删除后旧版本更正 404', (await mj.call('PATCH', `/api/memories/${memoryId}`, { text: winner.text, version: winner.version })).status === 404);

console.log('回访与冷却');
const rj = jar();
await rj.call('POST', '/api/session');
const rChat = await openChat(rj);
const rTurn = await rj.call('POST', `/api/interactions/${rChat.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '帮我记住：在准备校庆演出' });
await rj.call('POST', `/api/interactions/${rChat.data.id}/memories`, { candidate_id: rTurn.data.candidate.id, version: 1 });
const revisitBody = openBody();
await setSeed(seedForChat(await historyOf(rj), true));
const revisitOpen = await rj.call('POST', '/api/interactions', revisitBody);
await setSeed(null);
check('命中回访只提及确认的文字', revisitOpen.status === 201 && revisitOpen.data.mode === 'chat'
  && revisitOpen.data.first_step === '上次你说「在准备校庆演出」，最近怎么样了？', JSON.stringify(revisitOpen.data));
const tables1 = await db();
const revisitRow = tables1.interactions.find(row => row.id === revisitOpen.data.id);
const revisitCard = tables1.recommendations.find(row => row.id === revisitOpen.data.id);
check('卡片只保存通用开场', revisitRow.is_revisit === true && !revisitCard.first_step.includes('上次你说'));
check('回访计入开场历史', (await historyOf(rj)).length === 2 && (await historyOf(rj))[0].mode === 'chat');
const cooldownOpen = await openChat(rj, { revisit: true });
check('冷却期内再次开场用普通开场', cooldownOpen.status === 201 && !cooldownOpen.data.first_step.includes('上次你说'));
const revisitTurnBody = { request_id: randomUUID(), version: 1, text: '快演出了' };
const revisitTurn = await rj.call('POST', `/api/interactions/${revisitOpen.data.id}/turns`, revisitTurnBody);
check('回访互动可续聊', revisitTurn.status === 201);
check('续聊记录记忆依赖', (await db()).turn_memories.some(row => row.turn_id === revisitTurn.data.id && row.version === 1));
const rMemory = (await rj.call('GET', '/api/memories')).data.memories[0];
await rj.call('PATCH', `/api/memories/${rMemory.id}`, { text: '演出结束了', version: rMemory.version });
const reloadAfterEdit = await rj.call('POST', '/api/interactions', revisitBody);
check('更正后重新加载不再取用旧版本', reloadAfterEdit.status === 200 && !reloadAfterEdit.data.first_step.includes('上次你说'));
const revisitRetry = await rj.call('POST', `/api/interactions/${revisitOpen.data.id}/turns`, revisitTurnBody);
check('更正记忆后重放隐去旧回复正文', revisitRetry.status === 200 && revisitRetry.data.reply !== revisitTurn.data.reply
  && !(await db()).turns.find(row => row.id === revisitTurn.data.id).reply_text);
await rj.call('DELETE', `/api/memories/${rMemory.id}`);
const afterDeleteTurn = await rj.call('POST', `/api/interactions/${revisitOpen.data.id}/turns`, { request_id: randomUUID(), version: 2, text: '结束了' });
check('删除记忆后仍可普通接话', afterDeleteTurn.status === 201);

console.log('主动检索');
const recall = await rj.call('POST', `/api/interactions/${revisitOpen.data.id}/turns`, { request_id: randomUUID(), version: 3, text: '我上次说要准备什么？' });
check('无记录时说明没有并推进版本', recall.status === 200 && recall.data.recall === true && recall.data.reply.includes('没有找到') && recall.data.version === 4);
const rChat2 = await openChat(rj);
const rTurn2 = await rj.call('POST', `/api/interactions/${rChat2.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '帮我记住：下周体测' });
await rj.call('POST', `/api/interactions/${rChat2.data.id}/memories`, { candidate_id: rTurn2.data.candidate.id, version: 1 });
const recallPath = `/api/interactions/${rChat2.data.id}/turns`;
const recallBody = { request_id: randomUUID(), version: 2, text: '我上次说要准备什么？' };
const recall2 = await rj.call('POST', recallPath, recallBody);
check('主动检索返回已保存条目', recall2.status === 200 && recall2.data.recall === true && recall2.data.reply.includes('下周体测'));
check('检索走普通轮次的版本与幂等约束', recall2.data.version === 3
  && (await rj.call('POST', recallPath, recallBody)).data.version === 3
  && (await rj.call('POST', recallPath, { ...recallBody, version: 3 })).data?.error === 'REQUEST_CONFLICT'
  && (await db()).turns.filter(row => row.interaction_id === rChat2.data.id).length === 2);

console.log('审查回归：确认回滚、冷却回滚、删除与生成并发');
const raceJar = jar();
await raceJar.call('POST', '/api/session');
const raceChat = await openChat(raceJar);
const text = '正在准备管弦乐排练';
const raceTurn = await raceJar.call('POST', `/api/interactions/${raceChat.data.id}/turns`,
  { request_id: randomUUID(), version: 1, text: `帮我记住：${text}` });
const confirmationPath = `/api/interactions/${raceChat.data.id}/memories`;
const confirmationBody = { candidate_id: raceTurn.data.candidate.id, version: 1 };
await fault('consume', true);
const failedConfirmation = await raceJar.call('POST', confirmationPath, confirmationBody);
await fault('consume', false);
const failedTables = await db();
check('候选消费失败时记忆写入回滚', failedConfirmation.status === 503
  && !failedTables.memories.some(row => row.candidate_id === confirmationBody.candidate_id)
  && failedTables.memory_candidates.find(row => row.id === confirmationBody.candidate_id)?.status === 'pending');
const raceMemory = await raceJar.call('POST', confirmationPath, confirmationBody);
check('确认相同请求重试成功', raceMemory.status === 201);
const raceBody = openBody();
await fault('interaction', true);
await setSeed(seedForChat(await historyOf(raceJar), true));
const failedRevisit = await raceJar.call('POST', '/api/interactions', raceBody);
await fault('interaction', false);
const failedCooldown = (await db()).memories.find(row => row.id === raceMemory.data.id);
check('回访开场失败不占用冷却', failedRevisit.status === 503 && +new Date(failedCooldown.last_prompted_at) === 0);
await setSeed(seedForChat(await historyOf(raceJar), true));
const raceOpening = await raceJar.call('POST', '/api/interactions', raceBody);
await setSeed(null);
check('回访失败后同一请求可重试', raceOpening.status === 201 && raceOpening.data.first_step.includes(text));
await setEnv('MODEL_ENDPOINT', `${FAKE}/hold`);
const racePath = `/api/interactions/${raceOpening.data.id}/turns`;
const raceTurnBody = { request_id: randomUUID(), version: 1, text: '快开始了' };
const pending = raceJar.call('POST', racePath, raceTurnBody);
const modelReached = await until(async () => (await fetch(`${FAKE}/messages`)).json(),
  messages => messages.some(message => message.content.includes(text)));
const deletion = await raceJar.call('DELETE', `/api/memories/${raceMemory.data.id}`);
await fetch(`${FAKE}/release`, { method: 'POST' });
const raced = await pending;
check('模型生成中删除记忆后只提交通用回复', modelReached && deletion.status === 204
  && raced.status === 201 && !raced.data.reply.includes(text) && raced.data.version === 2);
check('并发删除后的重放没有旧记忆', (await raceJar.call('POST', racePath, raceTurnBody)).data.reply === raced.data.reply);
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);

console.log('到期与清理');
const ej = jar();
await ej.call('POST', '/api/session');
const eChat = await openChat(ej);
const eTurn = await ej.call('POST', `/api/interactions/${eChat.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '帮我记住：这周要交实验报告' });
await ej.call('POST', `/api/interactions/${eChat.data.id}/memories`, { candidate_id: eTurn.data.candidate.id, version: 1 });
const expiringBody = openBody();
await setSeed(seedForChat(await historyOf(ej), true));
const expiring = await ej.call('POST', '/api/interactions', expiringBody);
check('到期测试起始开场包含记忆', expiring.data.first_step.includes('这周要交实验报告'));
await setClock(8 * DAY);
const afterCooldown = await openChat(ej, { revisit: true });
check('冷却期过后可再回访', afterCooldown.data.first_step.includes('上次你说'));
await setClock(31 * DAY);
const expiredReplay = await ej.call('POST', '/api/interactions', expiringBody);
check('到期回访在查询列表前重放也隐去记忆', expiredReplay.status === 200 && !expiredReplay.data.first_step.includes('实验报告'));
const expiredTurn = await ej.call('POST', `/api/interactions/${eChat.data.id}/turns`,
  { request_id: randomUUID(), version: 2, text: '继续' });
check('空闲过期阻止续聊', expiredTurn.status === 409 && expiredTurn.data?.error === 'TURN_EXPIRED');
check('到期条目退出列表', (await ej.call('GET', '/api/memories')).data.memories.length === 0);
const expiredRevisit = await openChat(ej, { revisit: true });
check('到期条目不可回访', !expiredRevisit.data.first_step.includes('上次你说'));
const expiredOwner = createHash('sha256').update(ej.token()).digest('hex');
check('定时清理移除到期记忆和轮次正文', await until(db, tables => !tables.memories.some(row => row.owner === expiredOwner)
  && !tables.turns.some(row => row.owner === expiredOwner)));
await setClock(0);
const cj = jar();
await cj.call('POST', '/api/session');
const cChat = await openChat(cj);
const cTurn = await cj.call('POST', `/api/interactions/${cChat.data.id}/turns`, { request_id: randomUUID(), version: 1, text: '帮我记住：周五开会' });
await setClock(25 * 60 * 60 * 1000);
const expiredConfirm = await cj.call('POST', `/api/interactions/${cChat.data.id}/memories`, { candidate_id: cTurn.data.candidate.id, version: 1 });
check('候选到期不可确认', expiredConfirm.status === 409 && expiredConfirm.data?.error === 'CANDIDATE_EXPIRED');
await setClock(0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
