import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { application } from '../functions/routes.mjs';
import { createPostgresDb } from '../functions/database.mjs';
import { ACTIVITY_CATALOG, options, prototypeFor } from '../functions/suggestions.mjs';

class BackendError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
let pg, server, base, handle, database;
const resetHandler = activityOptions => {
  handle = application({ db: database, BackendError, activityOptions, random: () => 0.999 });
};
before(async () => {
  pg = new PGlite();
  await pg.exec('CREATE SCHEMA app');
  await pg.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
    await pg.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  database = createPostgresDb(async (sql, params) => (await pg.query(sql, params)).rows,
    work => pg.transaction(tx => work(async (sql, params) => (await tx.query(sql, params)).rows)));
  resetHandler();
  server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(base + incoming.url, { method: incoming.method, headers: incoming.headers,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }) });
    let response;
    try { response = await handle({ request }); }
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
  await pg.close();
});
function jar() {
  let token;
  return {
    get owner() { return createHash('sha256').update(token).digest('hex'); },
    async call(path, body) {
      const response = await fetch(base + '/functions/v1/app/api' + path, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-whynot-session': token } : {}) },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json();
      if (data.token) token = data.token;
      return { status: response.status, data };
    },
  };
}
const rowFor = async id => (await pg.query('SELECT * FROM app.recommendations WHERE id=$1', [id])).rows[0];
const context = { scene: 'waiting', energy: 'low', budget: 3 };

test('实际HTTP：两个入口60组合，每次一张已审卡且跨入口连续避重', async () => {
  const client = jar();
  assert.equal((await client.call('/recommendations', context)).status, 401);
  await client.call('/session');
  for (const scene of [null, 'waiting', 'desk', 'outside', 'home']) {
    for (const energy of ['low', 'steady', 'high']) {
      for (const budget of [3, 5, 10, 15]) {
        const condition = { scene, energy, budget };
        let previous;
        for (let i = 0; i < 5; i++) {
          const interaction = i % 2 !== 0;
          const result = await client.call(interaction ? '/interactions' : '/recommendations',
            { ...condition, ...(interaction ? { request_id: randomUUID() } : {}) });
          assert.equal(result.status, 201, JSON.stringify(result));
          assert.ok(result.data.minutes >= 1 && result.data.minutes <= budget && result.data.first_step);
          const row = await rowFor(result.data.id);
          assert.equal(row.source, 'builtin');
          const version = ACTIVITY_CATALOG.cards.find(card => card.id === row.action);
          assert.equal(version.status, 'published');
          assert.notEqual(version.prototype_id, previous);
          assert.equal(result.data.category, version.category);
          if (interaction) {
            assert.equal(result.data.mode, 'micro');
            assert.equal(result.data.topic, row.action);
          }
          previous = version.prototype_id;
        }
      }
    }
  }
});

test('最近历史先筛场景再取三张，无场景记录不会被其它场景挤掉', async () => {
  const client = jar();
  await client.call('/session');
  const first = await client.call('/recommendations', { energy: 'low', budget: 3 });
  for (let i = 0; i < 25; i++) await client.call('/recommendations', context);
  const next = await client.call('/recommendations', { energy: 'low', budget: 3 });
  assert.notEqual(prototypeFor(await rowFor(first.data.id)), prototypeFor(await rowFor(next.data.id)));
});

test('并发推荐与micro提交均按真实落库顺序避重', async () => {
  const client = jar();
  await client.call('/session');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => client.call(i % 2 ? '/interactions' : '/recommendations',
    { ...context, ...(i % 2 ? { request_id: randomUUID() } : {}) })));
  assert.ok(results.every(result => result.status === 201));
  const { rows } = await pg.query('SELECT action,title FROM app.recommendations WHERE owner=$1 ORDER BY recommendation_seq', [client.owner]);
  for (let i = 1; i < rows.length; i++) assert.notEqual(prototypeFor(rows[i]), prototypeFor(rows[i - 1]));
});

test('互动重放、换方式、反馈幂等与跨会话归属保持', async () => {
  const client = jar(), other = jar();
  await client.call('/session');
  await other.call('/session');
  const body = { ...context, request_id: randomUUID() };
  const first = await client.call('/interactions', body);
  const replay = await client.call('/interactions', body);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, first.data.id);
  assert.equal((await client.call('/interactions', { ...body, budget: 5 })).data.error, 'REQUEST_CONFLICT');
  const replacement = await client.call('/interactions', { ...context, request_id: randomUUID(), replaces: first.data.id });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.data.mode, first.data.mode);
  for (let i = 0; i < 2; i++) assert.equal((await client.call(`/recommendations/${first.data.id}/feedback`, { kind: 'completed' })).data.completed, true);
  assert.equal((await rowFor(first.data.id)).preference, null);
  assert.equal((await other.call(`/recommendations/${first.data.id}/feedback`, { kind: 'like' })).status, 404);
  for (const path of ['/recommendations', '/interactions']) {
    const invalid = await client.call(path, { ...context, budget: 7, ...(path === '/interactions' ? { request_id: randomUUID() } : {}) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, 'INVALID_CONTEXT');
  }
});

test('历史model卡可反馈且按旧标题避重，老版本映射保留', async () => {
  const client = jar();
  await client.call('/session');
  const old = ACTIVITY_CATALOG.history.find(entry => entry.id === 'colors');
  const id = randomUUID();
  await pg.query(`INSERT INTO app.recommendations (id,owner,scene,energy,budget,action,category,title,first_step,detail,minutes,source)
    VALUES ($1,$2,NULL,'low',3,'model','observe',$3,'旧第一步','旧补充',2,'model')`, [id, client.owner, old.title]);
  assert.equal((await client.call(`/recommendations/${id}/feedback`, { kind: 'like' })).data.title, old.title);
  const next = await client.call('/recommendations', { energy: 'low', budget: 3 });
  assert.notEqual(prototypeFor(await rowFor(next.data.id)), old.prototype_id);
});

test('不支持事务时明确拒绝推荐，避免并发绕过避重', async () => {
  const client = jar();
  await client.call('/session');
  handle = application({ db: { ...database, transaction: undefined }, BackendError });
  try {
    const result = await client.call('/recommendations', context);
    assert.equal(result.status, 503);
    assert.equal(result.data.error, 'STORAGE_UNAVAILABLE');
  } finally { resetHandler(); }
});

test('不足候选、未审稿和无库存实际HTTP边界', async () => {
  const client = jar();
  await client.call('/session');
  const available = options('waiting', 'low', 3);
  const two = [...new Map(available.map(card => [card.prototype_id, card])).values()].slice(0, 2);
  let calls = 0;
  resetHandler(() => { calls++; return two; });
  try {
    let previous;
    for (let i = 0; i < 6; i++) {
      const result = await client.call('/interactions', { ...context, request_id: randomUUID() });
      assert.equal(result.status, 201);
      const prototype = prototypeFor(await rowFor(result.data.id));
      assert.notEqual(prototype, previous);
      previous = prototype;
    }
    assert.equal(calls, 6);
    resetHandler(() => []);
    const empty = await client.call('/recommendations', context);
    assert.equal(empty.status, 503);
    assert.equal(empty.data.error, 'MODEL_UNAVAILABLE');
    const otherMode = await client.call('/interactions', { ...context, request_id: randomUUID() });
    assert.equal(otherMode.status, 201);
    assert.notEqual(otherMode.data.mode, 'micro');
    const draft = { ...two[0], status: 'draft' };
    resetHandler((scene, energy, budget) => options(scene, energy, budget,
      { inventory: { ...ACTIVITY_CATALOG, cards: [draft] }, fallback: () => [] }));
    assert.equal((await client.call('/recommendations', context)).status, 503);
  } finally { resetHandler(); }
});
