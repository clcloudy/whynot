import assert from 'node:assert/strict';
import { ACTIVITY_CATALOG } from '../functions/suggestions.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const FAKE = process.env.FAKE || 'http://127.0.0.1:8766';
const setEnv = (name, value) => fetch(`${BASE}/__local/env`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, value }),
});
const session = await fetch(`${BASE}/functions/v1/app/api/session`, { method: 'POST' }).then(response => response.json());
const counts = () => fetch(`${FAKE}/counts`).then(response => response.json());
const before = await counts();
const actions = new Set(ACTIVITY_CATALOG.cards.filter(card => card.status === 'published').map(card => card.id));
try {
  for (const endpoint of ['valid', 'schema-bad', 'not-json', 'http500', 'http401', 'slow', null]) {
    await setEnv('MODEL_API_KEY', endpoint ? 'fake-local-key' : null);
    await setEnv('MODEL_ENDPOINT', `${FAKE}/${endpoint ?? 'valid'}`);
    const response = await fetch(`${BASE}/functions/v1/app/api/recommendations`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-whynot-session': session.token },
      body: JSON.stringify({ scene: 'desk', energy: 'steady', budget: 5 }),
    });
    assert.equal(response.status, 201);
    const card = await response.json();
    const tables = await fetch(`${BASE}/__local/db`).then(response => response.json());
    const row = tables.recommendations.find(row => row.id === card.id);
    assert.equal(row.source, 'builtin');
    assert.ok(actions.has(row.action));
    assert.ok(card.minutes <= 5 && card.first_step);
    console.log(`ok 库存推荐不依赖模型 ${endpoint ?? '无密钥'}`);
  }
  assert.deepEqual(await counts(), before);
  console.log('ok 推荐模型调用次数为 0；超时、无效响应、认证失败不影响取卡');
} finally {
  await setEnv('MODEL_API_KEY', null);
  await setEnv('MODEL_ENDPOINT', null);
}
