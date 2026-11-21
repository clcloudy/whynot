import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'whynot-local-'));
const dataDir = join(directory, 'data');
const children = new Set();
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`ok ${name}`); };

const model = createServer(async (request, response) => {
  const custom = request.url.startsWith('/v1/');
  if (request.url === '/redirect/models') {
    response.writeHead(302, { location: '/v1/models' }).end();
    return;
  }
  if (custom && request.headers.authorization !== 'Bearer custom-fixture-key') {
    response.writeHead(401).end();
    return;
  }
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'fixture-large' }, { id: 'fixture-small' }, { id: 'fixture-large' }, { id: 'bad model name' }] }));
    return;
  }
  if (!['/', '/v1/chat/completions'].includes(request.url)) {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (custom ? body.model !== 'fixture-large' || body.thinking : body.thinking?.type !== 'disabled') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'thinking_must_be_disabled' }));
    return;
  }
  const assistantMessagesValid = body.messages.filter(message => message.role === 'assistant').every(message => {
    try { return typeof JSON.parse(message.content).text === 'string'; } catch { return false; }
  });
  if (!assistantMessagesValid || body.response_format?.type !== 'json_object') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'invalid_json_conversation' }));
    return;
  }
  const opening = body.messages[0].content.includes('开场生成器');
  const card = body.messages[0].content.includes('建议生成器');
  const content = card
    ? { title: '自定义模型建议', first_step: '先深呼吸一次。', detail: '仅用于自动验收。', minutes: 2, category: 'rest' }
    : opening
    ? { title: '本地测试开场', first_step: '最近在忙什么？', detail: '仅用于自动验收。', minutes: 2 }
    : { text: `${custom ? '自定义模型' : '启动配置模型'}回复：你想先完成哪一部分？` };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const modelEndpoint = `http://127.0.0.1:${model.address().port}`;
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;

function launch(withModel = false, targetPort = port) {
  const child = spawn(process.execPath, ['dev/server.mjs', '--local', String(targetPort)], {
    cwd: root,
    env: { ...process.env, WHYNOT_DATA_DIR: dataDir, MODEL_API_KEY: withModel ? 'local-test-key' : '', MODEL_ENDPOINT: modelEndpoint, WHYNOT_TEST_DATABASE_URL: '', RNG_SEED: '7' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.stderr.resume();
  return child;
}
async function start(withModel = false) {
  const child = launch(withModel);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local startup timed out')), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local startup exited: ${code}`)); });
    child.stdout.on('data', data => {
      if (data.toString().includes(base)) { clearTimeout(timer); resolve(); }
    });
  });
  return child;
}
async function stop(child) {
  if (!children.has(child)) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
function jar() {
  let token = '';
  return async (method, path, body) => {
    const response = await fetch(`${base}/functions/v1/app${path}`, {
      method,
      headers: { origin: base, ...(token ? { 'x-whynot-session': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (data?.token) token = data.token;
    return { status: response.status, data };
  };
}

try {
  let child = await start();
  const page = await (await fetch(base)).text();
  check('本地页面提供 AI 模型设置', page.includes('本地版 · 数据保存在这台电脑') && page.includes('data-local-settings="1"') && page.includes('id="model-form"'));
  for (const path of ['/__local/db', '/__local/env', '/__local/fault', '/__local/acceptance-ui.mjs', '/.env']) {
    check(`不暴露 ${path}`, (await fetch(base + path)).status === 404);
  }
  check('拒绝跨站请求', (await fetch(base + '/functions/v1/app/api/session', { method: 'POST', headers: { origin: 'https://untrusted.example' } })).status === 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(base, { headers: { host: 'untrusted.example' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
  check('拒绝伪造 Host', forgedHostStatus === 403);
  check('拒绝跨站导航', (await fetch(base, { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);
  const a = jar(), b = jar();
  const modelPath = '/api/model-settings';
  check('无会话被拒绝', (await a('GET', '/api/memories')).status === 401);
  check('AI 设置要求会话', (await a('GET', modelPath)).status === 401 && (await a('POST', `${modelPath}/models`, {})).status === 401);
  check('创建会话', (await a('POST', '/api/session')).status === 200);
  check('无模型配置使用内置建议', (await a('GET', modelPath)).data.source === 'builtin');
  const context = { scene: 'desk', energy: 'steady', budget: 5 };
  const card = await a('POST', '/api/recommendations', context);
  check('无密钥内置建议可用', card.status === 201 && card.data.minutes <= 5);
  const feedbackPath = `/api/recommendations/${card.data.id}/feedback`;
  await a('POST', feedbackPath, { kind: 'completed' });
  check('完成反馈幂等', (await a('POST', feedbackPath, { kind: 'completed' })).data.completed === true);
  let opening;
  for (let i = 0; i < 12; i++) {
    opening = await a('POST', '/api/interactions', { ...context, supports: ['text'], request_id: randomUUID() });
    assert.equal(opening.status, 201);
    if (opening.data.mode === 'chat') break;
  }
  check('事务互动可用', opening.status === 201 && opening.data.mode === 'chat');
  const turnPath = `/api/interactions/${opening.data.id}/turns`;
  const turn = await a('POST', turnPath, { request_id: randomUUID(), version: 1, text: '帮我记住：本地持久化验收' });
  check('无模型手动记忆候选', turn.status === 201 && turn.data.candidate?.text === '本地持久化验收');
  const confirmation = { candidate_id: turn.data.candidate.id, version: turn.data.candidate.version };
  const memoryPath = `/api/interactions/${opening.data.id}/memories`;
  const saved = await a('POST', memoryPath, confirmation);
  check('确认保存记忆', saved.status === 201 && saved.data.text === '本地持久化验收');
  const replay = await a('POST', memoryPath, confirmation);
  check('重复保存不重复写入', replay.status === 200 && replay.data.id === saved.data.id);
  const unavailable = await a('POST', turnPath, { request_id: randomUUID(), version: 2, text: '你好' });
  check('无模型自由聊天明确报错', unavailable.status === 503 && unavailable.data.error === 'MODEL_UNAVAILABLE');
  await b('POST', '/api/session');
  check('其他会话看不到记忆', (await b('GET', '/api/memories')).data.total === 0);
  check('其他会话不能修改记忆', (await b('PATCH', `/api/memories/${saved.data.id}`, { text: '不能修改', version: 1 })).status === 404);
  check('非法参数被拒绝', (await a('POST', '/api/interactions', { budget: 7, energy: 'low', request_id: randomUUID() })).status === 400);
  const modelSettings = { endpoint: `${modelEndpoint}/v1/`, api_key: 'custom-fixture-key', model: 'fixture-small', image_enabled: false };
  const modelsPath = `${modelPath}/models`;
  const discovered = await a('POST', modelsPath, { endpoint: modelSettings.endpoint, api_key: modelSettings.api_key });
  check('获取并校验服务商模型列表', discovered.status === 200 && discovered.data.models.join(',') === 'fixture-large,fixture-small');
  check('获取列表不会保存设置', (await a('GET', modelPath)).data.source === 'builtin');
  check('地址要求 HTTPS 或本机 HTTP', (await a('PUT', modelPath, { ...modelSettings, endpoint: 'http://example.com/v1' })).data.error === 'INVALID_MODEL_SETTINGS');
  check('拒绝模型列表重定向', (await a('POST', modelsPath, { endpoint: `${modelEndpoint}/redirect`, api_key: modelSettings.api_key })).data.error === 'MODEL_LIST_UNAVAILABLE');
  check('首次保存要求密钥', (await a('PUT', modelPath, { ...modelSettings, api_key: '' })).data.error === 'MODEL_KEY_REQUIRED');
  const storedModel = await a('PUT', modelPath, modelSettings);
  check('保存设置且不返回密钥', storedModel.status === 200 && storedModel.data.endpoint === `${modelEndpoint}/v1/chat/completions` && !JSON.stringify(storedModel.data).includes(modelSettings.api_key));
  const getModel = await a('GET', modelPath);
  check('读取设置只返回非敏感字段', Object.keys(getModel.data).sort().join(',') === 'endpoint,image_enabled,model,source');
  check('其他会话没有该模型设置', (await b('GET', modelPath)).data.source === 'builtin');
  check('其他会话无法沿用已存密钥', (await b('POST', modelsPath, { endpoint: modelSettings.endpoint })).data.error === 'MODEL_KEY_REQUIRED');
  check('换地址不能沿用旧密钥', (await a('PUT', modelPath, { ...modelSettings, endpoint: 'https://example.com/v1', api_key: '' })).data.error === 'MODEL_KEY_REQUIRED');
  check('同地址可以沿用密钥获取列表', (await a('POST', modelsPath, { endpoint: storedModel.data.endpoint })).status === 200);
  check('同地址换模型可以保留密钥', (await a('PUT', modelPath, { ...modelSettings, api_key: '', model: 'fixture-large' })).data.model === 'fixture-large');
  const inventoryCard = await a('POST', '/api/recommendations', context);
  check('配置模型后推荐仍使用审核库存', inventoryCard.status === 201 && inventoryCard.data.title !== '自定义模型建议');
  const duplicate = launch(false, port + 1);
  const duplicateExit = await Promise.race([
    once(duplicate, 'exit').then(([code]) => code),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Duplicate startup did not stop')), 10000); timer.unref(); }),
  ]);
  check('防止两个进程同时使用同一数据库', duplicateExit !== 0);

  await stop(child);
  child = await start(true);
  check('重启后自定义模型保留并优先于启动配置', (await a('GET', modelPath)).data.model === 'fixture-large' && (await b('GET', modelPath)).data.source === 'environment');
  const restored = await a('GET', '/api/memories');
  check('重启后原会话与记忆保留', restored.status === 200 && restored.data.total === 1 && restored.data.memories[0].id === saved.data.id && restored.data.memories[0].text === saved.data.text);
  check('重启后反馈保留', (await a('POST', feedbackPath, { kind: 'like' })).data.completed === true);
  const turnBody = { request_id: randomUUID(), version: 2, text: '继续本地测试' };
  const modelTurn = await a('POST', turnPath, turnBody);
  check('重启后继续对话并调用自定义模型', modelTurn.status === 201 && modelTurn.data.version === 3 && modelTurn.data.reply.startsWith('自定义模型'));
  check('对话重试幂等', (await a('POST', turnPath, turnBody)).status === 200);
  check('旧版本对话被拒绝', (await a('POST', turnPath, { ...turnBody, request_id: randomUUID() })).status === 409);
  check('移除自定义模型后恢复启动配置', (await a('DELETE', modelPath)).data.source === 'environment');
  const secondTurn = await a('POST', turnPath, { request_id: randomUUID(), version: 3, text: '第二轮本地测试' });
  check('连续第二轮对话调用启动配置模型', secondTurn.status === 201 && secondTurn.data.reply.startsWith('启动配置模型'));
  const edited = await a('PATCH', `/api/memories/${saved.data.id}`, { text: '本地修改后保留', version: 1 });
  check('编辑记忆', edited.status === 200 && edited.data.version === 2);
  check('旧版本记忆被拒绝', (await a('PATCH', `/api/memories/${saved.data.id}`, { text: '过时修改', version: 1 })).status === 409);
  await stop(child);
  child = await start();
  check('移除自定义模型跨重启保留', (await a('GET', modelPath)).data.source === 'builtin');
  const afterEdit = await a('GET', '/api/memories');
  check('再次启动不重跑迁移且修改保留', afterEdit.data.memories[0].text === '本地修改后保留' && afterEdit.data.memories[0].version === 2);
  check('删除记忆', (await a('DELETE', `/api/memories/${saved.data.id}`)).status === 204);
  check('结束互动', (await a('DELETE', `/api/interactions/${opening.data.id}`)).status === 204);
  await stop(child);
  child = await start();
  check('删除结果跨重启保留', (await a('GET', '/api/memories')).data.total === 0);
  await stop(child);
  const contenders = [launch(), launch(false, port === 65535 ? port - 1 : port + 1)];
  const outcomes = await Promise.all(contenders.map(contender => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Concurrent restart timed out')), 30000);
    contender.once('error', error => { clearTimeout(timer); reject(error); });
    contender.once('exit', () => { clearTimeout(timer); resolve(false); });
    contender.stdout.on('data', data => {
      if (data.toString().includes('WhyNot 本地版')) { clearTimeout(timer); resolve(true); }
    });
  })));
  check('异常停止后并发重启只有一个进程取得数据库', outcomes.filter(Boolean).length === 1);
  await Promise.all(contenders.map(stop));
  child = await start();
  check('并发启动失败不损坏已有数据', (await a('GET', '/api/memories')).status === 200 && (await a('POST', feedbackPath, { kind: 'like' })).data.completed === true);
  await stop(child);
  console.log(`${passed} passed, 0 failed (模型为本地测试桩，不代表真实 AI 验证)`);
} finally {
  await Promise.all([...children].map(stop));
  await new Promise(resolve => model.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
