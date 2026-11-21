import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_TOPICS, DISCUSS_TOPICS, PHOTO_OPENING, MODE_WEIGHTS, RECENT_DECAY,
  eligibleTopics, topicGroup, eligibleModes, modeWeights, builtinOpening, pickOpening,
} from '../functions/interactions.mjs';
import { SCENES, ENERGIES, BUDGETS, options, pickBuiltin } from '../functions/suggestions.mjs';

const CONTEXT = { scene: 'desk', energy: 'steady', budget: 5 };
const POOLS = { chat: CHAT_TOPICS, discuss: DISCUSS_TOPICS };
const MEMORY_TOPICS = ['thesis', 'rehearsal', 'basketball', 'exhibition', 'course-report', 'exam'];

function sequence(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, '抽签不应额外消费随机数');
    return values[index++];
  };
}

// Force only the mode roll; exercise the actual filtered, weighted topic draw.
function drawAs(mode, context = CONTEXT, {
  history = [], exclude = null, imageReady = false, microCandidates = [],
  recent = [], scores = {}, rolls = [0.5, 0.5],
} = {}) {
  let modes = eligibleModes(context, { imageReady, microCandidates });
  if (exclude && modes.length > 1) modes = modes.filter(item => item !== exclude.mode);
  assert.ok(modes.includes(mode), `${mode} must be eligible`);
  const weights = modeWeights(modes, history);
  const total = modes.reduce((sum, item) => sum + weights[item], 0);
  const before = modes.slice(0, modes.indexOf(mode)).reduce((sum, item) => sum + weights[item], 0);
  const random = sequence([(before + weights[mode] / 2) / total, ...rolls]);
  const result = pickOpening({ context, history, exclude, imageReady, microCandidates, recent, scores, random });
  assert.equal(result.mode, mode);
  return result;
}

// Probe both sides inside every expected interval, not just its midpoint.
// Expected factors are supplied by each test, independent of implementation.
function assertTopicIntervals(mode, context, history, factors = {}, exclude = null) {
  let topics = eligibleTopics(mode, context);
  if (exclude?.mode === mode && topics.length > 1) topics = topics.filter(item => item.topic !== exclude.topic);
  const weights = topics.map(item => factors[item.group] ?? 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let before = 0;
  for (const [index, item] of topics.entries()) {
    const low = before / total;
    const high = (before + weights[index]) / total;
    for (const roll of [low + 1e-9, high - 1e-9]) {
      assert.equal(drawAs(mode, context, { history, exclude, rolls: [roll] }).topic, item.topic,
        `${mode}/${item.topic}, roll=${roll}, factors=${JSON.stringify(factors)}`);
    }
    before += weights[index];
  }
}

function frequencies(mode, history) {
  const counts = Object.fromEntries(eligibleTopics(mode, CONTEXT).map(item => [item.topic, 0]));
  for (let index = 0; index < 1700; index++) {
    counts[drawAs(mode, CONTEXT, { history, rolls: [(index + 0.5) / 1700] }).topic]++;
  }
  return counts;
}

test('保留八个旧话题编号，补齐元数据并增加有实质差异的主题组', () => {
  const original = {
    chat: ['week-focus', 'small-win', 'ongoing', 'rest-plan'],
    discuss: ['campus-hours', 'daily-choice', 'imagine', 'campus-space'],
  };
  for (const [mode, pool] of Object.entries(POOLS)) {
    assert.ok(pool.length > original[mode].length);
    assert.equal(new Set(pool.map(item => item.topic)).size, pool.length);
    assert.ok(new Set(pool.map(item => item.group)).size > 3);
    for (const id of original[mode]) assert.ok(pool.some(item => item.topic === id));
    for (const item of pool) {
      assert.equal(topicGroup(mode, item.topic), item.group);
      assert.ok(typeof item.group === 'string' && item.group.length > 0);
      assert.ok(item.scenes.length && item.scenes.every(scene => [null, ...SCENES].includes(scene)));
      assert.ok(item.energies.length && item.energies.every(energy => ENERGIES.includes(energy)));
      assert.ok(Number.isInteger(item.minutes) && item.minutes >= 1);
      for (const key of ['title', 'first', 'detail']) assert.ok(item[key].trim());
      assert.ok(Array.isArray(item.memoryTopics));
    }
  }
  assert.equal(topicGroup('chat', 'week-focus'), 'progress');
  assert.equal(topicGroup('chat', 'ongoing'), 'progress');
  assert.equal(topicGroup('discuss', 'campus-hours'), topicGroup('discuss', 'campus-space'));
  for (const [mode, topic] of [['chat', 'retired'], ['discuss', 'week-focus'], ['micro', 'week-focus'], ['photo', 'photo-word'], ['unknown', 'ongoing']]) {
    assert.equal(topicGroup(mode, topic), null);
  }
});

test('60种场景/精力/预算组合：筛选、实际抽签与兜底卡均合法', () => {
  let combinations = 0;
  const history = [
    { mode: 'chat', topic: 'ongoing' },
    { mode: 'discuss', topic: 'campus-space' },
    { mode: 'chat', topic: 'rest-plan' },
  ];
  for (const scene of [null, ...SCENES]) {
    for (const energy of ENERGIES) {
      for (const budget of BUDGETS) {
        combinations++;
        const context = { scene, energy, budget };
        const microCandidates = options(scene, energy, budget);
        for (const [mode, pool] of Object.entries(POOLS)) {
          const eligible = eligibleTopics(mode, context);
          assert.deepEqual(eligible, pool.filter(item => item.scenes.includes(scene)
            && item.energies.includes(energy) && item.minutes <= budget));
          assert.equal(eligible.length > 0, mode === 'chat' || energy !== 'low');
          for (const item of eligible) {
            const card = builtinOpening(mode, item.topic, context);
            assert.equal(card.minutes, item.minutes);
            assert.ok(card.minutes >= 1 && card.minutes <= budget);
            assert.equal(card.category, mode);
            assert.equal(card.first, item.first);
            if (energy === 'low') assert.notEqual(item.group, 'progress');
          }
        }
        for (const imageReady of [false, true]) {
          const expectedModes = ['chat', ...(energy === 'low' ? [] : ['discuss']), 'micro',
            ...(imageReady && scene !== 'outside' ? ['photo'] : [])];
          const modes = eligibleModes(context, { imageReady, microCandidates });
          assert.deepEqual(modes, expectedModes);
          for (const mode of modes) {
            for (const roll of [0, 0.1, 0.5, 0.9, 1 - Number.EPSILON]) {
              const draw = drawAs(mode, context, { history, imageReady, microCandidates, rolls: [roll, roll] });
              const card = builtinOpening(mode, draw.topic, context, microCandidates);
              assert.ok(card.minutes >= 1 && card.minutes <= budget, JSON.stringify({ context, draw }));
              if (mode in POOLS) assert.ok(eligibleTopics(mode, context).some(item => item.topic === draw.topic));
              if (mode === 'micro') assert.ok(microCandidates.includes(draw.card) && draw.card === card);
              if (mode === 'photo') assert.deepEqual(card, PHOTO_OPENING);
            }
          }
        }
      }
    }
  }
  assert.equal(combinations, 60);
});

test('场景、精力和时长在抽签前筛选；未选场景等价于null', () => {
  for (const mode of Object.keys(POOLS)) {
    assert.deepEqual(eligibleTopics(mode, { energy: 'steady', budget: 5 }),
      eligibleTopics(mode, { scene: null, energy: 'steady', budget: 5 }));
    for (const context of [{ ...CONTEXT, budget: 0 }, { ...CONTEXT, energy: 'invalid' }, { ...CONTEXT, scene: 'invalid' }]) {
      assert.deepEqual(eligibleTopics(mode, context), []);
      assert.ok(!eligibleModes(context, { microCandidates: [] }).includes(mode));
    }
  }
  assert.ok(!eligibleTopics('chat', CONTEXT).some(item => item.topic === 'waiting-sound'));
  assert.ok(!eligibleTopics('discuss', { ...CONTEXT, budget: 3 }).some(item => item.topic === 'repair-or-replace'));
  assert.ok(eligibleTopics('discuss', CONTEXT).some(item => item.topic === 'repair-or-replace'));
  assert.ok(!eligibleTopics('discuss', { ...CONTEXT, scene: 'waiting' }).some(item => item.topic === 'repair-or-replace'));
  assert.deepEqual(eligibleTopics('discuss', { ...CONTEXT, energy: 'low' }), []);
  assert.deepEqual(eligibleTopics('micro', CONTEXT), []);
  assert.deepEqual(eligibleTopics('photo', CONTEXT), []);
  assertTopicIntervals('chat', { scene: 'waiting', energy: 'low', budget: 1 }, [
    { mode: 'chat', topic: 'ongoing' },
  ]);
  assertTopicIntervals('discuss', { ...CONTEXT, budget: 3 }, [
    { mode: 'discuss', topic: 'repair-or-replace' },
  ]);
});

test('waiting低精力有具体声音细节的一分钟问题，无忙事回访', () => {
  const context = { scene: 'waiting', energy: 'low', budget: 3 };
  const topics = eligibleTopics('chat', context);
  const sound = topics.find(item => item.topic === 'waiting-sound');
  assert.ok(sound);
  assert.equal(sound.first, '刚才等待时，有什么声音引起你注意？');
  assert.equal(sound.minutes, 1);
  assert.equal(sound.group, 'sensory');
  assert.ok(topics.every(item => item.group !== 'progress' && item.memoryTopics.length === 0));
  assertTopicIntervals('chat', context, []);
  const draw = drawAs('chat', context, { rolls: [(topics.indexOf(sound) + 0.5) / topics.length] });
  assert.equal(builtinOpening('chat', draw.topic, context).first, sound.first);
  assert.ok(!eligibleModes(context).includes('discuss'));
});

test('相邻近似题按组一起降权，而不是仅降低已出现的topic', () => {
  for (const previous of ['week-focus', 'ongoing']) {
    assertTopicIntervals('chat', CONTEXT, [{ mode: 'chat', topic: previous }], { progress: 0.2 });
  }
  for (const previous of ['campus-hours', 'campus-space']) {
    assertTopicIntervals('discuss', CONTEXT, [{ mode: 'discuss', topic: previous }], { campus: 0.2 });
  }
  for (const [mode, first, sibling] of [
    ['chat', 'week-focus', 'ongoing'], ['discuss', 'campus-hours', 'campus-space'],
  ]) {
    const baseline = frequencies(mode, []);
    const decayed = frequencies(mode, [{ mode, topic: first }]);
    assert.equal(baseline[first], baseline[sibling]);
    assert.ok(Math.abs(decayed[first] - decayed[sibling]) <= 1);
    assert.ok(decayed[sibling] < baseline[sibling] / 2);
    assert.ok(decayed[first] > 0, '降权而非硬排除主题组');
  }
});

test('chat/discuss跨方式共用主题组历史', () => {
  assert.equal(topicGroup('chat', 'rest-plan'), topicGroup('discuss', 'quiet-or-lively'));
  assertTopicIntervals('discuss', CONTEXT, [{ mode: 'chat', topic: 'rest-plan' }], { rest: 0.2 });
  assertTopicIntervals('chat', CONTEXT, [{ mode: 'discuss', topic: 'quiet-or-lively' }], { rest: 0.2 });
  assertTopicIntervals('chat', CONTEXT, [
    { mode: 'discuss', topic: 'quiet-or-lively' },
    { mode: 'chat', topic: 'week-focus' },
  ], { rest: 0.2, progress: 0.5 });
});

test('沿用最近三次开场位置的衰减；重复组不叠乘，滑出三轮恢复', () => {
  assert.deepEqual(RECENT_DECAY, [0.2, 0.5, 0.5]);
  const progress = { mode: 'chat', topic: 'week-focus' };
  const micro = { mode: 'micro', topic: 'week-focus' };
  const photo = { mode: 'photo', topic: 'photo-word' };
  for (const history of [[micro, progress], [micro, photo, progress]]) {
    assertTopicIntervals('chat', CONTEXT, history, { progress: 0.5 });
  }
  assertTopicIntervals('chat', CONTEXT, [progress, { mode: 'chat', topic: 'ongoing' }, progress], { progress: 0.2 });
  assertTopicIntervals('chat', CONTEXT, [micro, photo, { mode: 'chat', topic: 'retired' }, progress]);
  assertTopicIntervals('chat', CONTEXT, [micro, { mode: 'photo', topic: 'rest-plan' }]);
  assert.deepEqual(MODE_WEIGHTS, { chat: 35, discuss: 20, micro: 20, photo: 25 });
  assert.deepEqual(modeWeights(['chat', 'discuss', 'micro', 'photo'], [
    { mode: 'chat', topic: 'week-focus' }, { mode: 'discuss', topic: 'campus-space' }, micro,
  ]), { chat: 7, discuss: 10, micro: 10, photo: 25 });
});

test('只有progress标注稳定回访主题；所有低精力候选禁止回访', () => {
  for (const pool of Object.values(POOLS)) {
    for (const item of pool) {
      assert.equal(new Set(item.memoryTopics).size, item.memoryTopics.length);
      if (item.group === 'progress') {
        assert.deepEqual(item.memoryTopics, MEMORY_TOPICS);
        assert.ok(!item.energies.includes('low'));
        assert.ok(item.energies.includes('steady'));
      } else {
        assert.deepEqual(item.memoryTopics, [], `${item.topic} 不得触发回访`);
      }
    }
  }
  for (const scene of [null, ...SCENES]) {
    for (const budget of BUDGETS) {
      for (const mode of Object.keys(POOLS)) {
        assert.ok(eligibleTopics(mode, { scene, energy: 'low', budget }).every(item =>
          item.group !== 'progress' && item.memoryTopics.length === 0));
      }
    }
  }
});

test('builtinOpening保留原卡片接口，photo资格与返回内容不变', () => {
  for (const [mode, pool] of Object.entries(POOLS)) {
    for (const item of pool) {
      assert.deepEqual(builtinOpening(mode, item.topic, CONTEXT), {
        title: item.title, first: item.first, detail: item.detail, minutes: item.minutes, category: mode,
      });
    }
  }
  assert.deepEqual(builtinOpening('photo', 'photo-word', CONTEXT), PHOTO_OPENING);
  assert.notEqual(builtinOpening('photo', 'photo-word', CONTEXT), PHOTO_OPENING);
  assert.deepEqual(drawAs('photo', CONTEXT, { imageReady: true }), { mode: 'photo', topic: 'photo-word' });
  for (const context of [{ ...CONTEXT, scene: 'outside' }, { ...CONTEXT, budget: 2 }]) {
    assert.ok(!eligibleModes(context, { imageReady: true }).includes('photo'));
  }
  assert.ok(!eligibleModes(CONTEXT, { imageReady: false }).includes('photo'));
  assert.ok(eligibleModes({ ...CONTEXT, energy: 'low' }, { imageReady: true }).includes('photo'));
});

test('micro原型避重与类别偏好继续交给pickBuiltin，沿用同一候选对象', () => {
  const context = { scene: 'waiting', energy: 'low', budget: 3 };
  const microCandidates = options(context.scene, context.energy, context.budget);
  const distinct = [...new Map(microCandidates.map(card => [card.prototype_id, card])).values()];
  const recent = distinct.slice(0, 3).map(card => ({ action: card.action, title: card.title }));
  const scores = { [microCandidates[0].category]: 2 };
  assert.ok(!eligibleModes(context, { microCandidates: [] }).includes('micro'));
  for (const rolls of [[0, 0], [0.6, 0.8], [0.99, 0.99]]) {
    const expected = pickBuiltin({ ...context, candidates: microCandidates, recent, scores, random: sequence(rolls) });
    const draw = drawAs('micro', context, { microCandidates, recent, scores, rolls });
    assert.deepEqual(draw, { mode: 'micro', topic: expected.action, card: expected });
    assert.equal(draw.card, expected);
    assert.equal(builtinOpening('micro', draw.topic, context, microCandidates), expected);
  }
  const first = microCandidates[0];
  const variant = { ...first, action: 'test-variant', title: '另一个版本' };
  const draw = drawAs('micro', context, {
    microCandidates: [first, variant], recent: [{ action: first.action, title: first.title }], rolls: [0, 0],
  });
  assert.equal(draw.card, variant);
  assert.equal(builtinOpening('micro', 'missing', context, microCandidates), null);
});

test('replacement只排除方式/当前题，不修改反馈或历史，也不扩大组级厌恶', () => {
  const exclude = Object.freeze({ mode: 'chat', topic: 'week-focus', preference: null, completed: false });
  const history = Object.freeze([Object.freeze({ mode: 'chat', topic: 'week-focus' })]);
  const scores = Object.freeze({ rest: 1 });
  assert.equal(drawAs('discuss', CONTEXT, { history, exclude, scores }).mode, 'discuss');
  // Only chat remains at two minutes with no micro candidates: switch the topic,
  // but keep its sibling eligible with the normal recent-group penalty.
  const context = { ...CONTEXT, budget: 2 };
  assertTopicIntervals('chat', context, history, { progress: 0.2 }, exclude);
  assertTopicIntervals('chat', context, [], {}, exclude);
  const draw = drawAs('chat', context, { history, exclude, scores, rolls: [0] });
  assert.notEqual(draw.topic, exclude.topic);
  assert.deepEqual(Object.keys(draw).sort(), ['mode', 'topic']);
  // A genuine singleton can repeat, preserving the original replacement contract.
  const singleton = drawAs('chat', { ...context, budget: 1 }, {
    exclude: { mode: 'chat', topic: 'familiar-taste' },
  });
  assert.equal(singleton.topic, 'familiar-taste');
  assert.deepEqual(exclude, { mode: 'chat', topic: 'week-focus', preference: null, completed: false });
  assert.deepEqual(history, [{ mode: 'chat', topic: 'week-focus' }]);
  assert.deepEqual(scores, { rest: 1 });
});
