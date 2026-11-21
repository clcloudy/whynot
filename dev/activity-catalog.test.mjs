import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY_CATALOG as catalog, options, pickBuiltin, prototypeFor } from '../functions/suggestions.mjs';
import { coverageReport, validateCatalog } from '../functions/activity-catalog.mjs';
import { eligibleModes, pickOpening } from '../functions/interactions.mjs';

const context = { scene: 'waiting', energy: 'low', budget: 3 };
const candidates = options(context.scene, context.energy, context.budget);
const distinct = [...new Map(candidates.map(card => [card.prototype_id, card])).values()];
const draw = (overrides = {}) => pickBuiltin({ ...context, candidates, random: () => 0, ...overrides });

test('发布库校验并覆盖60种组合，至少两种原型', () => {
  assert.deepEqual(validateCatalog(catalog, { requireCoverage: true }), []);
  const report = coverageReport(catalog);
  assert.equal(report.length, 60);
  assert.ok(report.every(row => row.prototypes >= 2));
  for (const row of report) {
    for (const card of options(row.scene, row.energy, row.budget)) {
      assert.ok(card.minutes <= row.budget && card.scenes.includes(row.scene) && card.energies.includes(row.energy));
      assert.deepEqual(card.requirements.items, []);
      assert.equal(card.requirements.interruptible, true);
      assert.equal(card.requirements.keeps_awareness, true);
      if (row.energy === 'low') assert.notEqual(card.category, 'explore');
    }
  }
});

test('重复编号、无原型、未审核、错误耗时与缺字段均禁止发布', () => {
  for (const mutate of [
    data => data.cards.push(data.cards[0]),
    data => { data.cards[0].prototype_id = 'missing'; },
    data => { data.cards[0].minutes = 100; },
    data => { data.cards[0].first_step = ''; },
    data => { data.cards[0].review = null; },
    data => { data.cards[0].requirements.items = ['headphones']; },
    data => { data.cards[0].requirements.keeps_awareness = false; },
  ]) {
    const changed = structuredClone(catalog);
    mutate(changed);
    assert.ok(validateCatalog(changed).length > 0);
  }
});

test('候选严格过滤时长、精力、场景、物品、状态', () => {
  for (const change of [
    { minutes: 4 }, { energies: ['high'] }, { scenes: ['home'] }, { status: 'draft' }, { status: 'retired' },
    { requirements: { ...candidates[0].requirements, items: ['headphones'] } },
  ]) {
    const inventory = { ...catalog, cards: [{ ...candidates[0], ...change }] };
    assert.deepEqual(options('waiting', 'low', 3, { inventory, fallback: () => [] }), []);
  }
  assert.ok(options('waiting', 'low', 3, { inventory: { ...catalog, cards: [] } }).length > 0);
  for (const status of ['retired', 'draft']) {
    const inventory = { ...catalog, cards: catalog.cards.map(card => ({ ...card, status })) };
    assert.deepEqual(options('waiting', 'low', 3, { inventory }), []);
  }
});

test('最近三原型排除；不足时从最早放回，不重复上一原型', () => {
  assert.ok(distinct.length >= 4);
  const recent = distinct.slice(0, 3).map(card => ({ action: card.action, title: card.title }));
  assert.ok(!recent.map(entry => prototypeFor(entry)).includes(draw({ recent }).prototype_id));
  assert.equal(draw({ candidates: distinct.slice(0, 3), recent }).prototype_id, distinct[2].prototype_id);
  assert.equal(draw({ candidates: distinct.slice(0, 2), recent }).prototype_id, distinct[1].prototype_id);
  assert.equal(draw({ candidates: distinct.slice(0, 2), recent: [recent[0], recent[0], recent[1]] }).prototype_id, distinct[1].prototype_id);
});

test('单原型优先换版本，记录覆盖缺口；完全为空返回null', () => {
  const first = candidates[0];
  const second = { ...first, action: 'test_variant', id: 'test_variant', title: '不同版本' };
  const gaps = [];
  const result = draw({ candidates: [first, second], recent: [{ action: first.action, title: first.title }], onGap: gap => gaps.push(gap) });
  assert.equal(result.action, second.action);
  assert.equal(gaps[0].prototypes, 1);
  assert.equal(draw({ candidates: [], onGap: gap => gaps.push(gap) }), null);
  assert.equal(gaps[1].prototypes, 0);
});

test('八个文案版本不增加原型概率，类别偏好作用于原型', () => {
  const [first, second] = distinct;
  const pool = [...Array.from({ length: 8 }, (_, i) => ({ ...first, action: `variant_${i}` })), second];
  let selectedFirst = 0;
  for (let i = 0; i < 1000; i++) {
    if (draw({ candidates: pool, random: () => (i + 0.5) / 1000 }).prototype_id === first.prototype_id) selectedFirst++;
  }
  assert.equal(selectedFirst, 500);
  const otherCategory = distinct.find(card => card.category !== first.category);
  assert.ok(otherCategory);
  assert.equal(draw({ candidates: [first, otherCategory], random: () => 0.6, scores: { [first.category]: 2 } }).prototype_id, first.prototype_id);
});

test('历史旧编号及模型标题归并，未知历史不伪造原型', () => {
  for (const entry of catalog.history) assert.equal(prototypeFor({ action: entry.id }), entry.prototype_id);
  const entry = catalog.history[0];
  assert.equal(prototypeFor({ action: 'model', title: ` ${entry.title}。` }), entry.prototype_id);
  assert.equal(prototypeFor({ action: 'model', title: '完全未知的活动' }), null);
  const previous = structuredClone(catalog);
  const next = { ...structuredClone(catalog), version: 'activity-v2' };
  assert.deepEqual(validateCatalog(next, { previous }), []);
  next.cards[0].title = '不能偷偷修改已发布版本';
  assert.ok(validateCatalog(next, { previous }).includes('CARD_VERSION_CHANGED'));
});

test('互动资格、抽原型、话题与取卡共用候选集合', () => {
  assert.ok(!eligibleModes(context, { microCandidates: [] }).includes('micro'));
  const only = [candidates[0]];
  const opening = pickOpening({ context, history: [], microCandidates: only, random: () => 0.99 });
  assert.equal(opening.mode, 'micro');
  assert.equal(opening.topic, only[0].action);
  assert.equal(opening.card, only[0]);
});
