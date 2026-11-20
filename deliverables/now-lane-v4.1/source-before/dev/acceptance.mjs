// Acceptance checks against the local fixture server (dev/server.mjs).
import { validateCard } from '../functions/model.mjs';
import { ANYWHERE, EXTRAS } from '../functions/suggestions.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
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

const a = jar();
const b = jar();

console.log('会话与健康检查');
check('health', (await a.call('GET', '/api/health')).status === 200);
check('无会话推荐被拒绝', (await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' })).status === 401);
const session = await a.call('POST', '/api/session');
check('创建会话', session.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(a.token()));
check('重复会话复用', (await a.call('POST', '/api/session')).status === 200);

console.log('3 分钟 + 低精力（跳过场景）');
const first = await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' });
check('返回 201', first.status === 201, JSON.stringify(first.data));
check('耗时不超过 3 分钟', first.data?.minutes >= 1 && first.data?.minutes <= 3);
check('含第一步', typeof first.data?.first_step === 'string' && first.data.first_step.length > 0);
check('场景为空', first.data?.scene === null);
check('初始无反馈', first.data?.preference === null && first.data?.completed === false);
const CATEGORIES = ['rest', 'observe', 'listen', 'tidy', 'explore'];
check('推荐响应含 category', typeof first.data?.category === 'string' && first.data.category.length > 0);
check('category 属于 5 类集合', CATEGORIES.includes(first.data?.category));

console.log('换一个');
const second = await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' });
check('新建议编号不同', second.status === 201 && second.data.id !== first.data.id);
check('换一个不产生反馈', second.data?.preference === null && second.data?.completed === false);
let rows = (await db()).recommendations;
const lowRows = rows.filter(row => row.budget === 3 && row.energy === 'low');
check('低精力不含 explore', lowRows.every(row => row.category !== 'explore'));
check('无模型 Key 时走内置兜底', lowRows.every(row => row.source === 'builtin'));

console.log('反馈幂等与改选');
const done1 = await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'completed' });
const done2 = await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'completed' });
check('已完成两次都成功', done1.status === 200 && done2.status === 200);
check('已完成只生效一次', done1.data.completed === true && done2.data.completed === true);
check('喜欢', (await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'like' })).data.preference === 'like');
check('改选不喜欢', (await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'dislike' })).data.preference === 'dislike');
check('再改选喜欢', (await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'like' })).data.preference === 'like');
check('无效反馈类型', (await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'love' })).status === 400);
check('反馈多余字段', (await a.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'like', extra: 1 })).status === 400);

console.log('错误输入与他人建议');
for (const body of [{ budget: 7, energy: 'low' }, { budget: '3', energy: 'low' }, { budget: 3, energy: 'tired' }, { budget: 3, energy: 'low', scene: 'moon' }, { energy: 'low' }, { budget: 3, energy: 'low', scene: null, extra: 1 }]) {
  const result = await a.call('POST', '/api/recommendations', body);
  check(`无效条件 ${JSON.stringify(body)}`, result.status === 400 && result.data?.error === 'INVALID_CONTEXT');
}
await b.call('POST', '/api/session');
check('他人建议反馈 404', (await b.call('POST', `/api/recommendations/${first.data.id}/feedback`, { kind: 'like' })).status === 404);
check('非法编号 404', (await a.call('POST', '/api/recommendations/not-a-uuid/feedback', { kind: 'like' })).status === 404);
rows = (await db()).recommendations;
const firstRow = rows.find(row => row.id === first.data.id);
check('原记录保持正确', firstRow.preference === 'like' && firstRow.completed === true);
check('非 JSON 请求 415', (await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' }, { 'content-type': 'text/plain' })).status === 415);
check('未知路由 404', (await a.call('GET', '/api/nope')).status === 404);

console.log('全部条件组合');
const anywhereActions = new Set([...ANYWHERE, ...Object.values(EXTRAS).flat()].filter(item => item.anywhere).map(item => item.action));
let combos = 0, comboFailures = [];
for (const scene of [null, 'waiting', 'desk', 'outside', 'home']) {
  for (const energy of ['low', 'steady', 'high']) {
    for (const budget of [3, 5, 10, 15]) {
      const body = { budget, energy, ...(scene ? { scene } : {}) };
      const result = await a.call('POST', '/api/recommendations', body);
      combos++;
      if (result.status !== 201 || result.data.minutes > budget || result.data.minutes < 1
        || !CATEGORIES.includes(result.data.category)) {
        comboFailures.push(JSON.stringify(body));
        continue;
      }
      const row = (await db()).recommendations.find(item => item.id === result.data.id);
      if (energy === 'low' && row.category === 'explore') comboFailures.push(`explore ${JSON.stringify(body)}`);
      if (!scene && !anywhereActions.has(row.action)) comboFailures.push(`not-anywhere ${JSON.stringify(body)}`);
    }
  }
}
check(`${combos} 种组合全部合规`, comboFailures.length === 0, comboFailures.join('; '));

console.log('模型输出校验（单元）');
const valid = { title: '看看远处', first_step: '抬头，找一种远处的颜色。', detail: '让目光停一会儿。', minutes: 2, category: 'observe' };
check('合法输出通过', validateCard(valid, 3, 'low') !== null);
check('超预算拒绝', validateCard({ ...valid, minutes: 4 }, 3, 'low') === null);
check('低精力 explore 拒绝', validateCard({ ...valid, category: 'explore' }, 5, 'low') === null);
check('缺第一步拒绝', validateCard({ ...valid, first_step: '' }, 5, 'steady') === null);
check('超长标题拒绝', validateCard({ ...valid, title: '长'.repeat(41) }, 5, 'steady') === null);
check('非整数耗时拒绝', validateCard({ ...valid, minutes: 2.5 }, 5, 'steady') === null);
check('未知类型拒绝', validateCard({ ...valid, category: 'dance' }, 5, 'steady') === null);
check('控制字符拒绝', validateCard({ ...valid, detail: 'x\u0000y' }, 5, 'steady') === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);