// Model-path checks against the local fixture server + fake model endpoint.
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const FAKE = 'http://127.0.0.1:8766';
let passed = 0, failed = 0;

function check(name, condition, extra = '') {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${extra}`); }
}

async function setEnv(name, value) {
  await fetch(`${BASE}/__local/env`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
}

let token = '';
async function recommend(body) {
  const response = await fetch(`${BASE}/functions/v1/app/api/recommendations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-whynot-session': token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

const session = await fetch(`${BASE}/functions/v1/app/api/session`, { method: 'POST' });
const sessionBody = await session.json().catch(() => null);
if (typeof sessionBody?.token === 'string') token = sessionBody.token;
const db = async () => (await fetch(`${BASE}/__local/db`)).json();
const counts = async () => (await fetch(`${FAKE}/counts`)).json();
const rowFor = async id => (await db()).recommendations.find(row => row.id === id);

await setEnv('MODEL_API_KEY', 'fake-local-key');
const context = { budget: 5, energy: 'steady', scene: 'desk' };

console.log('模型成功路径');
await setEnv('MODEL_ENDPOINT', `${FAKE}/valid`);
let result = await recommend(context);
check('返回 201', result.status === 201);
let row = await rowFor(result.data.id);
check('来源为模型', row?.source === 'model');
check('输出经过修剪与校验', row?.title === 'fake 建议' && row?.minutes === 2);

console.log('无效输出兜底');
for (const [mode, label] of [['schema-bad', '超预算输出'], ['not-json', '非 JSON 输出']]) {
  await setEnv('MODEL_ENDPOINT', `${FAKE}/${mode}`);
  result = await recommend(context);
  row = await rowFor(result.data.id);
  check(`${label} → 内置兜底`, result.status === 201 && row?.source === 'builtin');
}

console.log('上游错误与重试上限');
await setEnv('MODEL_ENDPOINT', `${FAKE}/http500`);
const before500 = (await counts()).http500 ?? 0;
result = await recommend(context);
row = await rowFor(result.data.id);
check('5xx → 兜底', result.status === 201 && row?.source === 'builtin');
check('5xx 重试一次为止', (await counts()).http500 - before500 === 2);

await setEnv('MODEL_ENDPOINT', `${FAKE}/http401`);
const before401 = (await counts()).http401 ?? 0;
result = await recommend(context);
row = await rowFor(result.data.id);
check('401 → 兜底且不重试', result.status === 201 && row?.source === 'builtin' && (await counts()).http401 - before401 === 1);

console.log('超时兜底');
await setEnv('MODEL_ENDPOINT', `${FAKE}/slow`);
const started = Date.now();
result = await recommend(context);
const elapsed = Date.now() - started;
row = await rowFor(result.data.id);
check('超时 → 兜底', result.status === 201 && row?.source === 'builtin');
check('有限等待（两次 7 秒超时）', elapsed >= 13000 && elapsed < 20000, `${elapsed}ms`);

console.log('未配置 Key');
await setEnv('MODEL_API_KEY', null);
result = await recommend(context);
row = await rowFor(result.data.id);
check('无 Key → 内置建议', result.status === 201 && row?.source === 'builtin');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);