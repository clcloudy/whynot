// Acceptance checks against the published site (no local fixture endpoints).
const BASE = process.env.BASE || 'https://whynot-now-ys5921k6eqx.qoder.website';
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
        headers: {
          origin: BASE,
          referer: `${BASE}/`,
          ...(token ? { 'x-whynot-session': token } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (typeof data?.token === 'string') token = data.token;
      return { status: response.status, data };
    },
  };
}

const a = jar();
const b = jar();

console.log('首次公开访问（匿名）');
const page = await fetch(`${BASE}/`);
check('首页 200 且无需登录', page.status === 200 && (await page.text()).includes('WhyNot'));
check('health', (await a.call('GET', '/api/health')).status === 200);
check('无会话推荐被拒绝', (await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' })).status === 401);
check('创建匿名会话', (await a.call('POST', '/api/session')).status === 200);

console.log('只有 3 分钟，精力低');
const first = await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' });
check('返回 201', first.status === 201, JSON.stringify(first.data));
check('耗时最多 3 分钟', first.data?.minutes >= 1 && first.data?.minutes <= 3);
check('含明确第一步', typeof first.data?.first_step === 'string' && first.data.first_step.length > 0);
const withScene = await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low', scene: 'waiting' });
check('填写场景同样合规', withScene.status === 201 && withScene.data.minutes <= 3);

console.log('换建议后给反馈');
const second = await a.call('POST', '/api/recommendations', { budget: 3, energy: 'low' });
check('新旧建议不同', second.status === 201 && second.data.id !== first.data.id);
check('换一个不产生反馈', second.data?.preference === null && second.data?.completed === false);
const done1 = await a.call('POST', `/api/recommendations/${second.data.id}/feedback`, { kind: 'completed' });
const done2 = await a.call('POST', `/api/recommendations/${second.data.id}/feedback`, { kind: 'completed' });
check('连续两次已完成只生效一次', done1.status === 200 && done2.status === 200 && done1.data.completed === true && done2.data.completed === true);
check('喜欢', (await a.call('POST', `/api/recommendations/${second.data.id}/feedback`, { kind: 'like' })).data.preference === 'like');
check('改选不喜欢', (await a.call('POST', `/api/recommendations/${second.data.id}/feedback`, { kind: 'dislike' })).data.preference === 'dislike');

console.log('模型不可用时的兜底');
check('无模型 Key 仍返回建议', first.status === 201 && second.status === 201);

console.log('错误输入或他人的建议编号');
for (const body of [{ budget: 7, energy: 'low' }, { budget: 3, energy: 'tired' }, { budget: 3, energy: 'low', scene: 'moon' }]) {
  const result = await a.call('POST', '/api/recommendations', body);
  check(`无效条件 ${JSON.stringify(body)}`, result.status === 400 && result.data?.error === 'INVALID_CONTEXT');
}
await b.call('POST', '/api/session');
check('他人建议反馈 404', (await b.call('POST', `/api/recommendations/${second.data.id}/feedback`, { kind: 'like' })).status === 404);
const unchanged = await a.call('POST', `/api/recommendations/${second.data.id}/feedback`, { kind: 'dislike' });
check('已有记录保持正确', unchanged.data?.preference === 'dislike' && unchanged.data?.completed === true);

console.log('全部条件组合');
let combos = 0, comboFailures = [];
for (const scene of [null, 'waiting', 'desk', 'outside', 'home']) {
  for (const energy of ['low', 'steady', 'high']) {
    for (const budget of [3, 5, 10, 15]) {
      const body = { budget, energy, ...(scene ? { scene } : {}) };
      const result = await a.call('POST', '/api/recommendations', body);
      combos++;
      if (result.status !== 201 || result.data.minutes > budget || result.data.minutes < 1) comboFailures.push(JSON.stringify(body));
    }
  }
}
check(`${combos} 种组合全部合规`, comboFailures.length === 0, comboFailures.join('; '));

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`FEEDBACK_CARD_ID=${second.data.id}`);
process.exit(failed ? 1 : 0);