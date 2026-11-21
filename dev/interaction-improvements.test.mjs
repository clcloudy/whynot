import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { application } from '../functions/routes.mjs';
import { createPostgresDb } from '../functions/database.mjs';
import { summarizeMetrics } from './interaction-metrics.mjs';

class BackendError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
let pg, server, modelServer, base, database, handlers, clock = 0;
let modelCalls = 0, captured = [], modelGate, modelFailure = false, onModelRequest, purgeClaimOnUpdate = false;
const reset = (random = () => 0) => {
  handlers = [0, 1].map(() => application({ db: database, BackendError, random, now: () => Date.now() + clock,
    env: { get: name => ({ MODEL_API_KEY: 'fixture-key', MODEL_ENDPOINT: `http://127.0.0.1:${modelServer.address().port}` })[name] } }));
};
before(async () => {
  pg = new PGlite();
  await pg.exec('CREATE SCHEMA app');
  for (const file of ['schema.sql', ...(await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort().map(f => `migrations/${f}`)]) {
    await pg.exec(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }
  database = createPostgresDb(async (sql, params) => (await pg.query(sql, params)).rows,
    work => pg.transaction(tx => work(async (sql, params) => {
      if (purgeClaimOnUpdate && sql.startsWith('UPDATE app."interaction_requests"')) {
        purgeClaimOnUpdate = false;
        await tx.query('DELETE FROM app.interaction_requests WHERE owner=$1 AND request_id=$2', [params[0], params[2]]);
        return [];
      }
      return (await tx.query(sql, params)).rows;
    })));
  modelServer = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    captured = JSON.parse(raw).messages;
    modelCalls++;
    onModelRequest?.();
    if (modelGate) await modelGate;
    if (modelFailure) { response.writeHead(401).end(); return; }
    const opening = captured[0].content.includes('开场生成器');
    const content = opening
      ? { title: '聊一个细节', first_step: '今天注意到了什么？', detail: '说一个就好。', minutes: 1 }
      : { text: '听到了，我们可以聊一个新的小发现。' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, completion_tokens: 20 } }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  reset();
  server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(base + incoming.url, { method: incoming.method, headers: incoming.headers,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }) });
    let response;
    try { response = await handlers[Number(incoming.headers['x-fixture-worker'] ?? 0)]({ request }); }
    catch (error) { response = Response.json({ error: error.code ?? 'STORAGE_UNAVAILABLE' }, { status: error.status ?? 503 }); }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => modelServer.close(resolve));
  await pg.close();
});
function jar() {
  let token;
  return {
    get owner() { return createHash('sha256').update(token).digest('hex'); },
    async call(method, path, body, worker = 0) {
      const response = await fetch(base + '/functions/v1/app/api' + path, {
        method, headers: { 'content-type': 'application/json', 'x-fixture-worker': String(worker), ...(token ? { 'x-whynot-session': token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => null);
      if (data?.token) token = data.token;
      return { status: response.status, data };
    },
  };
}
const context = { scene: 'desk', energy: 'steady', budget: 5 };
async function chat(client) {
  await client.call('POST', '/session', {});
  const result = await client.call('POST', '/interactions', { ...context, request_id: randomUUID() });
  assert.equal(result.status, 201);
  assert.equal(result.data.mode, 'chat');
  return result.data;
}
async function save(client, interaction, text) {
  const turn = await client.call('POST', `/interactions/${interaction.id}/turns`, { request_id: randomUUID(), version: interaction.version, text: `帮我记住：${text}` });
  assert.equal(turn.status, 201);
  interaction.version = turn.data.version;
  const saved = await client.call('POST', `/interactions/${interaction.id}/memories`, { candidate_id: turn.data.candidate.id, version: 1 });
  assert.equal(saved.status, 201);
  return saved.data;
}
async function say(client, interaction, text) {
  const body = { request_id: randomUUID(), version: interaction.version, text };
  const path = `/interactions/${interaction.id}/turns`;
  const result = await client.call('POST', path, body);
  if (result.data.version) interaction.version = result.data.version;
  return { ...result, body, path };
}

test('匿名基线汇总保留未知用量，按模型版本计算覆盖率和P95', () => {
  const common = { event: 'model_attempt', config_version: 'a'.repeat(64), template_version: 'conversation-v2' };
  const summary = summarizeMetrics([
    { ...common, duration_ms: 50, input_tokens: 100, cached_input_tokens: 40 },
    { ...common, duration_ms: 90, input_tokens: 100, cached_input_tokens: null },
    { ...common, duration_ms: 150, input_tokens: null, cached_input_tokens: null, api_key: 'do-not-log', user_text: 'private' },
    { event: 'interaction_request', operation: 'turn', turn_version: 1, success: 1, replay: 0, duration_ms: 200 },
    { event: 'interaction_request', operation: 'turn', success: 1, replay: 1, duration_ms: 1 },
    { event: 'opening_cache', eligible: true, hit: true }, { event: 'opening_cache', eligible: true, hit: false },
  ]);
  assert.equal(summary.completed_turns, 1);
  assert.equal(summary.model_calls_per_100_turns, 300);
  assert.equal(summary.public_opening_reuse_rate, 0.5);
  assert.equal(summary.request_p95_ms, 200);
  assert.equal(summary.models[0].input_usage_coverage, 2 / 3);
  assert.equal(summary.models[0].cache_usage_coverage, 1 / 3);
  assert.equal(summary.models[0].input_cache_hit_rate, 0.4);
  assert.equal(summary.models[0].model_p95_ms, 150);
  assert.doesNotMatch(JSON.stringify(summary), /private|do-not-log|api_key|user_text/);
  const unknown = summarizeMetrics([{ ...common, input_tokens: null, cached_input_tokens: null }]);
  assert.equal(unknown.models[0].input_cache_hit_rate, null);
  assert.equal(unknown.models[0].input_tokens, null);
});

test('实际HTTP：指定论文不被更新的三条记忆挤掉，同义问法只引用相关事项', async () => {
  const client = jar(), interaction = await chat(client);
  for (const text of ['周三交论文', '周四去排练', '周五打球', '周六看展']) await save(client, interaction, text);
  for (const question of ['我上次说论文什么时候交？', '我之前提到毕业论文哪天交？', '还记得我的论文什么时候交吗？', '看看我保存的论文什么时候交？']) {
    const result = await say(client, interaction, question);
    assert.equal(result.status, 200);
    assert.equal(result.data.recall, true);
    assert.match(result.data.reply, /周三交论文/);
    assert.doesNotMatch(result.data.reply, /排练|打球|看展/);
  }
});

test('实际HTTP：普通陈述和换话题不触发回忆', async () => {
  const client = jar(), interaction = await chat(client);
  await save(client, interaction, '周三交论文');
  const result = await say(client, interaction, '我之前说得不清楚，今天想换个话题。');
  assert.equal(result.status, 201);
  assert.equal(result.data.recall, undefined);
  assert.doesNotMatch(result.data.reply, /周三交论文|确认保存过/);
});

test('实际HTTP：显式列表、无匹配、歧义澄清和旧正文检索', async () => {
  const client = jar(), interaction = await chat(client);
  const thesis = await save(client, interaction, '周三交论文');
  await save(client, interaction, '周四交课程报告');
  await save(client, interaction, '周五去彩排');
  const list = await say(client, interaction, '列出我保存的记录');
  assert.match(list.data.reply, /周三交论文/);
  assert.match(list.data.reply, /周四交课程报告/);
  const none = await say(client, interaction, '我上次说画展什么时候去？');
  assert.equal(none.data.reply, '没有找到你保存过的相关记录。');
  const ambiguous = await say(client, interaction, '我上次说要交什么？');
  assert.match(ambiguous.data.reply, /你指.*(?:论文|课程报告).*还是/);
  assert.doesNotMatch(ambiguous.data.reply, /周三|周四/);
  await pg.query('UPDATE app.memories SET topic_id = NULL WHERE id=$1', [thesis.id]);
  assert.match((await say(client, interaction, '我之前说毕业论文什么时候交？')).data.reply, /周三交论文/);
  assert.match((await say(client, interaction, '我之前说排练什么时候去？')).data.reply, /周五去彩排/);
});

test('实际HTTP：已确认、本人、未过期才可引用，编辑删除后重放隐去旧文', async () => {
  const client = jar(), interaction = await chat(client);
  const other = jar(), otherChat = await chat(other);
  await save(other, otherChat, '周一交论文');
  assert.match((await say(client, interaction, '我上次说论文什么时候交？')).data.reply, /没有找到/);
  const candidate = await say(client, interaction, '帮我记住：周二交论文');
  assert.ok(candidate.data.candidate);
  assert.match((await say(client, interaction, '我上次说论文什么时候交？')).data.reply, /没有找到/);
  const saved = await save(client, interaction, '周三交论文');
  const recalled = await say(client, interaction, '我上次说论文什么时候交？');
  const dependencies = (await pg.query('SELECT memory_id,version FROM app.turn_memories WHERE turn_id=$1', [recalled.data.id])).rows;
  assert.deepEqual(dependencies, [{ memory_id: saved.id, version: 1 }]);
  assert.equal((await client.call('POST', recalled.path, { ...recalled.body, text: '别的内容' })).status, 409);
  assert.equal((await other.call('POST', recalled.path, recalled.body)).status, 404);
  const edited = await client.call('PATCH', `/memories/${saved.id}`, { version: 1, text: '周日交毕业论文' });
  assert.equal(edited.data.version, 2);
  assert.match((await client.call('POST', recalled.path, recalled.body)).data.reply, /没有找到/);
  const fresh = await say(client, interaction, '我上次说论文什么时候交？');
  assert.match(fresh.data.reply, /周日交毕业论文/);
  await client.call('DELETE', `/memories/${saved.id}`);
  assert.match((await client.call('POST', fresh.path, fresh.body)).data.reply, /没有找到/);
  const expired = await save(client, interaction, '周二交论文');
  await pg.query("UPDATE app.memories SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  assert.match((await say(client, interaction, '我上次说论文什么时候交？')).data.reply, /没有找到/);
  assert.equal((await client.call('PATCH', `/memories/${expired.id}`, { version: 1, text: '周一交' })).status, 404);
});

test('实际HTTP：保存带问句的事实优先生成候选，删除会清除来源和传播上下文', async () => {
  const client = jar(), interaction = await chat(client);
  const saved = await save(client, interaction, '论文什么时候交还没定');
  const reply = await say(client, interaction, '这件事让我有点担心');
  assert.equal(reply.status, 201);
  assert.match(JSON.stringify(captured), /论文什么时候交还没定/);
  const dependencies = (await pg.query('SELECT memory_id FROM app.turn_memories WHERE turn_id=$1', [reply.data.id])).rows;
  assert.ok(dependencies.some(dependency => dependency.memory_id === saved.id));
  await client.call('DELETE', `/memories/${saved.id}`);
  const source = (await pg.query('SELECT user_text,reply_text FROM app.turns WHERE interaction_id=$1 AND version=1', [interaction.id])).rows[0];
  assert.deepEqual(source, { user_text: '', reply_text: '' });
  assert.notEqual((await client.call('POST', reply.path, reply.body)).data.reply, reply.data.reply);
  assert.equal((await say(client, interaction, '我们继续聊点别的事情')).status, 201);
  assert.doesNotMatch(JSON.stringify(captured), /论文什么时候交还没定/);
});

test('实际HTTP：更改主题重算稳定编号，同主题同相关性按确认时间选择', async () => {
  const client = jar(), interaction = await chat(client);
  const saved = await save(client, interaction, '周三交论文');
  assert.equal((await pg.query('SELECT topic_id FROM app.memories WHERE id=$1', [saved.id])).rows[0].topic_id, 'thesis');
  await client.call('PATCH', `/memories/${saved.id}`, { version: 1, text: '周六去排练' });
  assert.equal((await pg.query('SELECT topic_id FROM app.memories WHERE id=$1', [saved.id])).rows[0].topic_id, 'rehearsal');
  assert.match((await say(client, interaction, '我上次说论文什么时候交？')).data.reply, /没有找到/);
  const older = await save(client, interaction, '周三交论文');
  await pg.query("UPDATE app.memories SET confirmed_at=now()-interval '1 hour' WHERE id=$1", [older.id]);
  await save(client, interaction, '周五交论文');
  assert.equal((await say(client, interaction, '我上次说论文什么时候交？')).data.reply, '你说「周五交论文」。');
});

test('实际HTTP：回访只选匹配主题并同步标题，冷却、低精力和更正继续生效', async () => {
  const client = jar(), interaction = await chat(client);
  const saved = await save(client, interaction, '最近在校庆排练');
  const body = { ...context, request_id: randomUUID() };
  const revisit = await client.call('POST', '/interactions', body);
  assert.equal(revisit.data.title, '聊聊校庆排练');
  assert.match(revisit.data.first_step, /最近在校庆排练/);
  assert.equal(revisit.data.minutes, 2);
  assert.doesNotMatch((await client.call('POST', '/interactions', { ...context, request_id: randomUUID() })).data.first_step, /上次你说/);
  clock = 8 * 86400000;
  try {
    const low = await client.call('POST', '/interactions', { ...context, scene: 'waiting', energy: 'low', budget: 3, request_id: randomUUID() });
    assert.doesNotMatch(low.data.first_step, /上次你说/);
    assert.notEqual(low.data.topic, 'week-focus');
    assert.match((await client.call('POST', '/interactions', { ...context, request_id: randomUUID() })).data.first_step, /上次你说/);
  } finally { clock = 0; }
  await client.call('PATCH', `/memories/${saved.id}`, { version: 1, text: '周三交论文' });
  const replay = await client.call('POST', '/interactions', body);
  assert.doesNotMatch(JSON.stringify(replay.data), /校庆排练/);
  const unrelated = jar(), unrelatedChat = await chat(unrelated);
  await save(unrelated, unrelatedChat, '换了一个蓝色书包');
  assert.doesNotMatch((await client.call('POST', '/interactions', { ...context, request_id: randomUUID() })).data.first_step, /蓝色书包/);
  assert.doesNotMatch((await unrelated.call('POST', '/interactions', { ...context, request_id: randomUUID() })).data.first_step, /上次你说/);
});

test('实际HTTP：同号并发开场只生成一张卡与一次模型调用', async () => {
  const client = jar();
  await client.call('POST', '/session', {});
  const body = { ...context, scene: 'home', budget: 15, request_id: randomUUID() };
  const before = modelCalls, gate = holdModel();
  try {
    const first = client.call('POST', '/interactions', body, 0);
    await gate.started;
    const second = client.call('POST', '/interactions', body, 1);
    assert.equal((await client.call('POST', '/interactions', { ...body, budget: 10 }, 1)).status, 409);
    gate.release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
    assert.equal(results[0].data.id, results[1].data.id);
    assert.equal(modelCalls - before, 1);
  } finally { gate.release(); }
});

function holdModel() {
  let release, entered;
  modelGate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  onModelRequest = entered;
  return { started, release: () => { modelGate = null; onModelRequest = null; release(); } };
}

test('实际HTTP：跨处理实例的同轮并发重试只调用一次模型，同号异内容409', async () => {
  const client = jar(), interaction = await chat(client);
  const body = { request_id: randomUUID(), version: 1, text: '今天画了一幅画' };
  const path = `/interactions/${interaction.id}/turns`;
  const before = modelCalls, gate = holdModel();
  try {
    const first = client.call('POST', path, body, 0);
    await gate.started;
    const second = client.call('POST', path, body, 1);
    assert.equal((await client.call('POST', path, { ...body, text: '不一样的内容' }, 1)).status, 409);
    gate.release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    assert.equal(results[0].data.id, results[1].data.id);
    assert.equal(modelCalls - before, 1);
    assert.equal((await pg.query('SELECT count(*)::int AS count FROM app.turns WHERE interaction_id=$1', [interaction.id])).rows[0].count, 1);
  } finally { gate.release(); }
});

test('实际HTTP：失效处理者允许接手，模型失败后可用同号重试', async () => {
  const client = jar(), interaction = await chat(client);
  const body = { request_id: randomUUID(), version: 1, text: '今天试了新画法' };
  const hash = createHash('sha256').update([1, body.text, ''].join('\u001f')).digest('hex');
  await pg.query(`INSERT INTO app.interaction_requests (owner,scope,request_id,payload_hash,claim_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()-interval '1 second')`, [client.owner, `turn:${interaction.id}`, body.request_id, hash, randomUUID()]);
  const path = `/interactions/${interaction.id}/turns`;
  purgeClaimOnUpdate = true;
  modelFailure = true;
  const before = modelCalls;
  try {
    assert.equal((await client.call('POST', path, body)).status, 503);
    assert.equal(purgeClaimOnUpdate, false);
    assert.equal(modelCalls - before, 1);
  }
  finally { modelFailure = false; }
  assert.equal((await client.call('POST', path, body, 1)).status, 201);
});

test('实际HTTP：失去处理租约的旧调用不能提交轮次', async () => {
  const client = jar(), interaction = await chat(client);
  const body = { request_id: randomUUID(), version: 1, text: '我在练习画画' };
  const path = `/interactions/${interaction.id}/turns`;
  const gate = holdModel();
  try {
    const pending = client.call('POST', path, body);
    await gate.started;
    await pg.query('UPDATE app.interaction_requests SET claim_id=$1 WHERE owner=$2 AND request_id=$3', [randomUUID(), client.owner, body.request_id]);
    gate.release();
    assert.equal((await pending).status, 503);
    assert.equal((await pg.query('SELECT count(*)::int AS count FROM app.turns WHERE interaction_id=$1', [interaction.id])).rows[0].count, 0);
    await pg.query("UPDATE app.interaction_requests SET expires_at=now()-interval '1 second' WHERE owner=$1 AND request_id=$2", [client.owner, body.request_id]);
    assert.equal((await client.call('POST', path, body, 1)).status, 201);
  } finally { gate.release(); }
});

test('实际HTTP：收尾尊重用户意愿，超过三轮仍传入最近有效问答', async () => {
  const client = jar(), interaction = await chat(client);
  for (let i = 1; i <= 5; i++) assert.equal((await say(client, interaction, `我第${i}轮谈画画`)).status, 201);
  const history = captured.filter(message => message.role === 'user')
    .map(message => JSON.parse(message.content)).filter(message => message.source === 'history');
  assert.deepEqual(history.map(message => message.untrusted_user_data.text), ['我第2轮谈画画', '我第3轮谈画画', '我第4轮谈画画']);
  const before = modelCalls;
  const closing = await say(client, interaction, '今天太累了，不想细讲');
  assert.equal(closing.status, 201);
  assert.equal(closing.data.reply, '好，今天就聊到这儿。');
  assert.equal(modelCalls, before);
});
