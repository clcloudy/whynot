import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ActivityContentError, BUDGETS, DEFAULT_TIMEOUT_MS, EXAMPLE_BYTE_LIMIT, MAX_ATTEMPTS,
  buildPrompt, catalogDigest, generateDraft, parseExamples, publishDraft, selectExamples,
  summarizeUsage, validateEndpoint, validateTask,
} from '../functions/activity-generation.mjs';
import { coverageReport, validateCatalog } from '../functions/activity-catalog.mjs';
import { DEFAULT_CATALOG, DEFAULT_EXAMPLES, runCli } from './activity-content.mjs';

const EXAMPLE_A = 'ae23bdeb7b8d0c9c';
const EXAMPLE_B = 'c479e3d2c179d7a4';
const EXAMPLE_C = '0e408466680234c6';
const NOW = () => new Date('2026-11-20T12:00:00.000Z');
const ENV = { MODEL_API_KEY: 'fake-key-never-live', MODEL_ENDPOINT: 'https://model.invalid/chat/completions', MODEL: 'test-model' };
const ALL_SCENES = [null, 'waiting', 'desk', 'outside', 'home'];
const ALL_ENERGIES = ['low', 'steady', 'high'];
function catalogFixture() {
  const prototypes = [
    { id: 'rest_pause', category: 'rest', core_action: '停留，放松肩膀', variation: '动作幅度', completion: '放松一次就好',
      sources: [{ kind: 'example', id: EXAMPLE_A }, { kind: 'builtin', action: 'breathe' }] },
    { id: 'observe_color', category: 'observe', core_action: '看看颜色', variation: '颜色数量', completion: '看一种就好',
      sources: [{ kind: 'example', id: EXAMPLE_B }, { kind: 'builtin', action: 'colors' }] },
  ];
  const cards = prototypes.map((prototype, index) => ({ id: `old_card_${index}`, prototype_id: prototype.id,
    category: prototype.category, content_version: 'v1', status: 'published', scenes: ALL_SCENES, energies: ALL_ENERGIES,
    minutes: 1, requirements: { items: [], stationary: true, interruptible: true, keeps_awareness: true },
    title: index ? '看看颜色' : '稍作停留', first_step: '在安全的地方停留片刻。', detail: '随时可以结束。',
    sources: prototype.sources, review: { basis: 'editor', reviewer: 'fixture', reviewed_at: NOW().toISOString() } }));
  return { version: 'activity-v1', prototypes, cards,
    history: cards.map(card => ({ id: card.id, prototype_id: card.prototype_id, title: card.title })) };
}
function examplesFixture() {
  return [
    { id: EXAMPLE_A, text_id: 'aaaaaaaaaaaaaaaa', type: 'activity', time_band: '5m', text: '轻轻松开肩膀，到点就停',
      sources: [{ file: 'PRIVATE_SOURCE_FILE.xlsx', sheet: 'PRIVATE_SHEET', cell: 'A1' }] },
    { id: EXAMPLE_B, text_id: 'bbbbbbbbbbbbbbbb', type: 'activity', time_band: '15m', text: '看一种颜色就好', sources: [] },
  ];
}
function taskFixture(overrides = {}) {
  return { id: 'new_pause', prototype_id: 'rest_pause', scene: 'waiting', energy: 'low', budget: 3,
    category: 'rest', variation: '只放松一次肩膀', ...overrides };
}
function rawFixture(overrides = {}) {
  return { title: '给肩膀一点空隙', first_step: '留在队伍中，让肩膀自然放松。', detail: '听着叫号，随时可以停。',
    minutes: 2, category: 'rest', ...overrides };
}
function response(content = rawFixture(), usage = { prompt_tokens: 10, completion_tokens: 4 }, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage }), { status });
}
function generatorOptions(overrides = {}) {
  return { tasks: [taskFixture()], catalog: catalogFixture(), examples: examplesFixture(), env: ENV, now: NOW, ...overrides };
}
async function generated(overrides = {}) {
  return generateDraft(generatorOptions({ fetchImpl: async () => response(), ...overrides }));
}
const hasCode = code => error => error instanceof ActivityContentError && error.code === code;

// All network-facing calls below use node:test mocks or in-memory functions.
test('fixture matches catalog contract and covers all 60 inventory slots', () => {
  const catalog = catalogFixture();
  assert.deepEqual(validateCatalog(catalog, { requireCoverage: true }), []);
  assert.equal(coverageReport(catalog).length, 60);
  assert.ok(coverageReport(catalog).every(row => row.prototypes === 2));
});

test('tasks require all seven fields and validate enums, prototypes, categories and new identifiers', async t => {
  const catalog = catalogFixture();
  assert.deepEqual(validateTask(taskFixture(), catalog), []);
  for (const field of Object.keys(taskFixture())) {
    const task = taskFixture(); delete task[field];
    assert.ok(validateTask(task, catalog).length, field);
  }
  for (const mutation of [{ scene: 'bus' }, { energy: 'medium' }, { budget: 4 }, { budget: '5' },
    { category: 'explore' }, { prototype_id: 'missing' }, { variation: '' }, { id: 'old_card_0' }, { id: 'INVALID.id' }]) {
    assert.ok(validateTask(taskFixture(mutation), catalog).length);
  }
  assert.deepEqual(BUDGETS, [3, 5, 10, 15]);
  const fetchImpl = t.mock.fn();
  await assert.rejects(generateDraft(generatorOptions({ tasks: [taskFixture(), taskFixture()], fetchImpl })), hasCode('INVALID_TASKS'));
  assert.equal(fetchImpl.mock.callCount(), 0);
});

test('two references use only sample text, never source metadata or full history', () => {
  const catalog = catalogFixture();
  catalog.history.push({ id: 'history_only', prototype_id: 'rest_pause', title: 'NEVER_SEND_HISTORY_TEXT' });
  const prompt = buildPrompt(taskFixture(), catalog, examplesFixture());
  const full = JSON.stringify(prompt.messages);
  assert.match(full, /轻轻松开肩膀/);
  assert.match(full, /看一种颜色/);
  assert.doesNotMatch(full, /PRIVATE_SOURCE|PRIVATE_SHEET|NEVER_SEND_HISTORY_TEXT|ae23bdeb7b8d0c9c|text_id|sources/);
  assert.equal(prompt.examples.gameplay.id, EXAMPLE_A);
  assert.equal(prompt.examples.tone.id, EXAMPLE_B);
  assert.ok(prompt.examples.byte_upper_bound <= 200);
  assert.equal(prompt.examples.gameplay_truncated, false);
});

test('deduplicates by text_id across prototypes, filtering type and short time bands', () => {
  const catalog = catalogFixture();
  const examples = examplesFixture();
  examples[1].text_id = examples[0].text_id;
  const extra = { id: EXAMPLE_C, text_id: 'cccccccccccccccc', type: 'activity', time_band: '15m', text: '只看一下' };
  catalog.prototypes[1].sources.push({ kind: 'example', id: EXAMPLE_C });
  examples.push(extra);
  let selected = selectExamples(taskFixture(), catalog, examples);
  assert.equal(selected.metadata.tone.id, EXAMPLE_C);
  assert.notEqual(selected.metadata.tone.text_id, selected.metadata.gameplay.text_id);
  for (const mutation of [{ type: 'chat' }, { time_band: '30m' }, { time_band: 5 }]) {
    Object.assign(extra, { type: 'activity', time_band: '15m' }, mutation);
    selected = selectExamples(taskFixture(), catalog, examples);
    assert.equal(selected.metadata.tone, null);
  }
});

test('200-byte upper bound drops tone first, then truncates gameplay without cutting hard conditions', () => {
  const examples = examplesFixture();
  examples[0].text = '松'.repeat(45);
  examples[1].text = '看'.repeat(35);
  let selected = selectExamples(taskFixture(), catalogFixture(), examples);
  assert.equal(selected.metadata.tone_dropped, true);
  assert.equal(selected.metadata.gameplay_truncated, false);
  assert.equal(selected.metadata.tone, null);
  examples[0].text = '松'.repeat(1000);
  selected = selectExamples(taskFixture(), catalogFixture(), examples);
  assert.equal(selected.metadata.gameplay_truncated, true);
  assert.ok(Buffer.byteLength(selected.section, 'utf8') <= EXAMPLE_BYTE_LIMIT);
  assert.equal(selected.metadata.byte_upper_bound, Buffer.byteLength(selected.section, 'utf8'));
  assert.ok(selected.section.endsWith('…'));
  assert.doesNotMatch(selected.section, /\ufffd/);
  const prompt = buildPrompt(taskFixture({ scene: 'outside' }), catalogFixture(), examples);
  assert.match(prompt.messages[0].content, /不得离开队伍/);
  assert.match(prompt.messages[0].content, /听得到叫号/);
  assert.match(prompt.messages[0].content, /安全位置停留/);
  assert.match(prompt.messages[0].content, /不需要任何物品/);
  assert.match(prompt.messages[0].content, /随时可停/);
});

test('builtin prototypes use only a short core_action/completion reference', () => {
  const catalog = catalogFixture();
  catalog.prototypes[0].sources = [{ kind: 'builtin', action: 'breathe' }];
  const selected = selectExamples(taskFixture(), catalog, examplesFixture());
  assert.match(selected.section, /停留，放松肩膀；放松一次就好/);
  assert.equal(selected.metadata.gameplay.kind, 'builtin');
  assert.equal(selected.metadata.gameplay.action, 'breathe');
  assert.ok(!Object.hasOwn(selected.metadata.gameplay, 'text'));
});

test('real JSONL can supply catalog-linked short activity references', async () => {
  const examples = parseExamples(await readFile(DEFAULT_EXAMPLES, 'utf8'));
  const selected = selectExamples(taskFixture(), catalogFixture(), examples);
  assert.equal(selected.metadata.gameplay.id, EXAMPLE_A);
  assert.ok(selected.metadata.byte_upper_bound <= 200);
  assert.throws(() => parseExamples('{broken}'), hasCode('INVALID_EXAMPLES_JSONL'));
});

test('bundled catalog integrates with fake generation and in-memory publication', async () => {
  const previous = JSON.parse(await readFile(DEFAULT_CATALOG, 'utf8'));
  const examples = parseExamples(await readFile(DEFAULT_EXAMPLES, 'utf8'));
  const digest = catalogDigest(previous);
  const prototype = previous.prototypes.find(item => item.category === 'rest' && item.sources.some(source => source.kind === 'builtin'));
  assert.ok(prototype);
  const draft = await generated({ catalog: previous, examples,
    tasks: [taskFixture({ id: 'generation_integration_test', prototype_id: prototype.id })] });
  const { catalog, report } = publishDraft({ draft, previous, reviewer: 'in-memory-test', now: NOW });
  assert.equal(catalogDigest(previous), digest);
  assert.deepEqual(validateCatalog(catalog, { previous, requireCoverage: true }), []);
  assert.deepEqual(catalog.history.slice(0, previous.history.length), previous.history);
  assert.equal(report.approved_cards, 1);
});

test('six pilot tasks cover three queue prototypes and retain the example budget', async () => {
  const catalog = JSON.parse(await readFile(DEFAULT_CATALOG, 'utf8'));
  const examples = parseExamples(await readFile(DEFAULT_EXAMPLES, 'utf8'));
  const { tasks } = JSON.parse(await readFile(new URL('../deliverables/activity-examples/generation-tasks.v1.json', import.meta.url), 'utf8'));
  assert.equal(tasks.length, 6);
  assert.equal(new Set(tasks.map(task => task.prototype_id)).size, 3);
  for (const task of tasks) {
    assert.deepEqual(validateTask(task, catalog), []);
    const prompt = buildPrompt(task, catalog, examples);
    assert.ok(prompt.examples.byte_upper_bound <= 200);
    assert.equal(task.scene, 'waiting');
    assert.equal(task.energy, 'low');
    assert.equal(task.budget, 3);
  }
});

test('generator attaches trusted metadata and keeps actual minutes separate from time bands', async t => {
  const fetchImpl = t.mock.fn(async (url, init) => {
    assert.equal(url, ENV.MODEL_ENDPOINT);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer ${ENV.MODEL_API_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, ENV.MODEL);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return response();
  });
  const draft = await generated({ fetchImpl });
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.equal(draft.kind, 'activity-generation-draft');
  const card = draft.cards[0];
  assert.equal(card.minutes, 2);
  assert.equal(card.content_version, 'v2');
  assert.equal(card.status, 'draft');
  assert.equal(card.review, null);
  assert.deepEqual(card.scenes, ['waiting']);
  assert.deepEqual(card.requirements, { items: [], stationary: true, interruptible: true, keeps_awareness: true });
  assert.deepEqual(card.sources, catalogFixture().prototypes[0].sources);
  assert.doesNotMatch(JSON.stringify(draft.generation), /fake-key|PRIVATE_SOURCE|给肩膀一点空隙|留在队伍中/);
  assert.equal(draft.generation.usage.total_tokens, 14);
  assert.equal(draft.generation.usage.inventory_recommendation_tokens, 0);
});

test('missing key and invalid transport configuration fail before fetch', async t => {
  const fetchImpl = t.mock.fn();
  await assert.rejects(generated({ fetchImpl, env: {} }), hasCode('MODEL_API_KEY_REQUIRED'));
  for (const endpoint of ['http://model.invalid/chat', 'https://user:pass@model.invalid/chat',
    'https://model.invalid/chat?key=secret', 'https://model.invalid/chat#secret', 'https://model.invalid/chat?',
    'file:///secret', 'https://model.invalid/\nchat']) {
    await assert.rejects(generated({ fetchImpl, env: { ...ENV, MODEL_ENDPOINT: endpoint } }), hasCode('INVALID_MODEL_ENDPOINT'));
  }
  for (const endpoint of ['https://model.invalid/chat', 'http://127.0.0.1:8080/chat', 'http://localhost/chat', 'http://[::1]/chat']) {
    assert.equal(typeof validateEndpoint(endpoint), 'string');
  }
  assert.equal(fetchImpl.mock.callCount(), 0);
});

test('default seven-second bound and two-attempt maximum cannot be raised', async t => {
  assert.equal(DEFAULT_TIMEOUT_MS, 7000);
  assert.equal(MAX_ATTEMPTS, 2);
  const fetchImpl = t.mock.fn();
  for (const option of [{ timeoutMs: 7001 }, { timeoutMs: 0 }, { maxAttempts: 3 }, { maxAttempts: 0 }]) {
    await assert.rejects(generated({ fetchImpl, ...option }), hasCode('INVALID_RETRY_LIMITS'));
  }
  assert.equal(fetchImpl.mock.callCount(), 0);
});

test('timeouts bound even an injected fetch that ignores abort, with unknown usage for both attempts', async t => {
  const signals = [];
  const fetchImpl = t.mock.fn(async (url, init) => { signals.push(init.signal); return new Promise(() => {}); });
  const draft = await generated({ fetchImpl, timeoutMs: 5 });
  assert.equal(fetchImpl.mock.callCount(), 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(draft.cards.length, 0);
  assert.deepEqual(draft.generation.tasks[0].attempts.map(attempt => attempt.outcome), ['timeout', 'timeout']);
  assert.equal(draft.generation.usage.total_tokens, 'unknown');
  assert.equal(draft.generation.usage.unknown_prompt_attempts, 2);
});

test('timeout includes response body parsing, and a 401 never retries even if its body stalls', async t => {
  for (const status of [200, 401]) {
    const fetchImpl = t.mock.fn(async () => ({ status, ok: status === 200, json: () => new Promise(() => {}) }));
    const draft = await generated({ fetchImpl, timeoutMs: 5 });
    assert.equal(fetchImpl.mock.callCount(), status === 200 ? 2 : 1);
    assert.equal(draft.generation.tasks[0].error, status === 200 ? 'timeout' : 'http_error');
  }
});

test('500 retries, preserving usage from failed and successful attempts', async t => {
  let count = 0;
  const fetchImpl = t.mock.fn(async () => ++count === 1
    ? response('server unavailable', { prompt_tokens: 3, completion_tokens: 2 }, 503)
    : response(rawFixture(), { prompt_tokens: 7, completion_tokens: 4 }));
  const draft = await generated({ fetchImpl });
  assert.equal(draft.cards.length, 1);
  assert.equal(draft.generation.tasks[0].error, null);
  assert.deepEqual(draft.generation.tasks[0].attempts.map(attempt => attempt.outcome), ['http_error', 'accepted']);
  assert.equal(draft.generation.usage.total_tokens, 16);
  assert.equal(draft.generation.usage.attempts, 2);
});

test('401 is not retried and its usage is not discarded', async t => {
  const fetchImpl = t.mock.fn(async () => response('unauthorized', { prompt_tokens: 2, completion_tokens: 1 }, 401));
  const draft = await generated({ fetchImpl });
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.equal(draft.cards.length, 0);
  assert.equal(draft.generation.usage.total_tokens, 3);
});

test('network errors retry without leaking error messages; missing usage remains unknown', async t => {
  let count = 0;
  const fetchImpl = t.mock.fn(async () => {
    if (++count === 1) throw new Error(`secret ${ENV.MODEL_API_KEY} full prompt raw response`);
    return response();
  });
  const draft = await generated({ fetchImpl });
  assert.equal(fetchImpl.mock.callCount(), 2);
  assert.equal(draft.cards.length, 1);
  assert.equal(draft.generation.usage.prompt_tokens, 'unknown');
  assert.equal(draft.generation.usage.known_prompt_tokens, 10);
  assert.equal(draft.generation.usage.total_tokens, 'unknown');
  assert.doesNotMatch(JSON.stringify(draft), /fake-key|full prompt|raw response/);
});

test('invalid content JSON retries and includes both attempts in real usage', async t => {
  let count = 0;
  const fetchImpl = t.mock.fn(async () => response(++count === 1 ? '{not valid JSON' : rawFixture(), { prompt_tokens: 8, completion_tokens: 3 }));
  const draft = await generated({ fetchImpl });
  assert.equal(fetchImpl.mock.callCount(), 2);
  assert.equal(draft.cards.length, 1);
  assert.equal(draft.generation.usage.total_tokens, 22);
  assert.equal(draft.generation.tasks[0].attempts[0].outcome, 'invalid_json');
});

test('invalid outer JSON is retried at most twice with unknown rather than zero usage', async t => {
  const fetchImpl = t.mock.fn(async () => new Response('not json', { status: 200 }));
  const draft = await generated({ fetchImpl });
  assert.equal(fetchImpl.mock.callCount(), 2);
  assert.equal(draft.cards.length, 0);
  assert.equal(draft.generation.usage.total_tokens, 'unknown');
  assert.equal(draft.generation.usage.known_prompt_tokens, 0);
  assert.doesNotMatch(JSON.stringify(draft.generation), /not json/);
});

test('over-budget and invalid five-field schema stop without retry or cards, while retaining usage', async t => {
  const missing = rawFixture(); delete missing.detail;
  for (const raw of [rawFixture({ minutes: 4 }), rawFixture({ minutes: 1.5 }), rawFixture({ category: 'observe' }),
    rawFixture({ status: 'published' }), rawFixture({ sources: [] }), rawFixture({ title: '' }), missing, []]) {
    const fetchImpl = t.mock.fn(async () => response(raw));
    const draft = await generated({ fetchImpl });
    assert.equal(fetchImpl.mock.callCount(), 1);
    assert.equal(draft.cards.length, 0);
    assert.equal(draft.generation.usage.total_tokens, 14);
    assert.equal(draft.generation.tasks[0].error, raw.minutes === 4 ? 'over_budget' : 'invalid_schema');
  }
});

test('non-numeric or absent usage stays unknown, including per-approved-card totals', async () => {
  const draft = await generated({ fetchImpl: async () => response(rawFixture(), { prompt_tokens: '10' }) });
  assert.equal(draft.generation.usage.prompt_tokens, 'unknown');
  assert.equal(draft.generation.usage.completion_tokens, 'unknown');
  const { report } = publishDraft({ draft, previous: catalogFixture(), reviewer: 'editor', now: NOW });
  assert.equal(report.tokens_per_approved_card.total_tokens, 'unknown');
  assert.deepEqual(summarizeUsage([]), { attempts: 0, known_prompt_tokens: 0, known_completion_tokens: 0,
    unknown_prompt_attempts: 0, unknown_completion_attempts: 0, inventory_recommendation_tokens: 0,
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('unreviewed drafts never add inventory coverage', async () => {
  const previous = catalogFixture();
  const draft = await generated();
  assert.ok(validateCatalog(draft).length);
  const withDrafts = { ...previous, cards: [...previous.cards, ...draft.cards] };
  assert.deepEqual(validateCatalog(withDrafts), []);
  assert.deepEqual(coverageReport(withDrafts), coverageReport(previous));
  assert.throws(() => publishDraft({ draft, previous }), hasCode('REVIEWER_REQUIRED'));
  assert.throws(() => publishDraft({ draft, previous, reviewer: '  ' }), hasCode('REVIEWER_REQUIRED'));
});

test('explicit review appends a version and stable history without mutating the draft or previous catalog', async () => {
  const previous = catalogFixture();
  const before = structuredClone(previous);
  const draft = await generated({ catalog: previous });
  draft.cards[0].title = '人工编辑的放松';
  const { catalog, report } = publishDraft({ draft, previous, reviewer: '  reviewer  ', now: NOW });
  assert.deepEqual(previous, before);
  assert.equal(draft.cards[0].status, 'draft');
  assert.equal(draft.cards[0].review, null);
  assert.equal(catalog.version, 'activity-v2');
  assert.deepEqual(catalog.cards.slice(0, before.cards.length), before.cards);
  assert.deepEqual(catalog.history.slice(0, before.history.length), before.history);
  assert.equal(catalog.history.at(-1).id, taskFixture().id);
  assert.equal(catalog.history.at(-1).title, '人工编辑的放松');
  assert.deepEqual(catalog.cards.at(-1).review, { basis: 'editor', reviewer: 'reviewer', reviewed_at: NOW().toISOString() });
  assert.equal(catalog.cards.at(-1).generation.model, ENV.MODEL);
  assert.equal(catalog.cards.at(-1).generation.generated_at, NOW().toISOString());
  assert.deepEqual(catalog.cards.at(-1).generation.attempts, draft.generation.tasks[0].attempts);
  assert.deepEqual(validateCatalog(catalog, { previous }), []);
  assert.equal(report.approved_cards, 1);
  assert.equal(report.tokens_per_approved_card.total_tokens, 14);
  assert.equal(report.usage.inventory_recommendation_tokens, 0);
});

test('full base digest detects old-card/history/prototype changes, not just a version change', async () => {
  const draft = await generated();
  for (const change of [value => { value.cards[0].detail = '旧卡被覆盖'; }, value => { value.history[0].title = '历史被覆盖'; },
    value => { value.prototypes[0].completion = '旧原型被覆盖'; }, value => { value.version = 'activity-v2'; }]) {
    const previous = catalogFixture(); change(previous);
    assert.throws(() => publishDraft({ draft, previous, reviewer: 'editor', now: NOW }), hasCode('DRAFT_BASE_MISMATCH'));
  }
  const reorderedKeys = Object.fromEntries(Object.entries(catalogFixture()).reverse());
  reorderedKeys.cards = reorderedKeys.cards.map(card => Object.fromEntries(Object.entries(card).reverse()));
  assert.equal(catalogDigest(reorderedKeys), draft.base_digest);
});

test('failed/retried/discarded generations are all charged across approved cards', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return response(rawFixture({ minutes: 20 }), { prompt_tokens: 10, completion_tokens: 2 });
    if (calls === 2) return response('{bad json', { prompt_tokens: 8, completion_tokens: 1 });
    return response(rawFixture(), { prompt_tokens: 5, completion_tokens: 3 });
  };
  const draft = await generated({ tasks: [taskFixture({ id: 'failed' }), taskFixture({ id: 'approved' }), taskFixture({ id: 'discarded' })], fetchImpl });
  assert.equal(calls, 4);
  assert.equal(draft.cards.length, 2);
  assert.deepEqual(draft.cards.map(card => card.content_version), ['v2', 'v3']);
  draft.cards = draft.cards.filter(card => card.id === 'approved');
  const { catalog, report } = publishDraft({ draft, previous: catalogFixture(), reviewer: 'editor', now: NOW });
  assert.equal(catalog.cards.length, 3);
  assert.equal(report.failed_tasks, 1);
  assert.equal(report.discarded_cards, 1);
  assert.equal(report.usage.attempts, 4);
  assert.equal(report.tokens_per_approved_card.total_tokens, 37);
});

test('missing draft, card and generation fields cannot be published', async () => {
  const original = await generated();
  for (const field of ['kind', 'schema_version', 'base_version', 'base_digest', 'cards', 'generation']) {
    const draft = structuredClone(original); delete draft[field];
    assert.throws(() => publishDraft({ draft, previous: catalogFixture(), reviewer: 'editor', now: NOW }), ActivityContentError, field);
  }
  for (const field of Object.keys(original.cards[0])) {
    const draft = structuredClone(original); delete draft.cards[0][field];
    assert.throws(() => publishDraft({ draft, previous: catalogFixture(), reviewer: 'editor', now: NOW }), ActivityContentError, field);
  }
  for (const mutate of [draft => { delete draft.generation.generated_at; }, draft => { delete draft.generation.model; },
    draft => { delete draft.generation.tasks; }, draft => { delete draft.generation.usage; },
    draft => { delete draft.generation.tasks[0].attempts[0].prompt_tokens; },
    draft => { delete draft.generation.tasks[0].attempts[0].completion_tokens; },
    draft => { delete draft.generation.tasks[0].attempts[0].http_status; },
    draft => { draft.generation.usage.total_tokens = 0; }]) {
    const draft = structuredClone(original); mutate(draft);
    assert.throws(() => publishDraft({ draft, previous: catalogFixture(), reviewer: 'editor', now: NOW }), ActivityContentError);
  }
});

test('publication rejects reused IDs, reused content versions, pre-approved cards and altered hard metadata', async () => {
  const original = await generated();
  for (const mutate of [draft => { draft.cards[0].id = 'old_card_0'; }, draft => { draft.cards[0].content_version = 'v1'; },
    draft => { draft.cards[0].status = 'published'; }, draft => { draft.cards[0].review = { basis: 'editor' }; },
    draft => { draft.cards[0].requirements.items = ['phone']; }, draft => { draft.cards[0].minutes = 9; },
    draft => { draft.cards[0].scenes = ['home']; }, draft => { draft.cards.push(structuredClone(draft.cards[0])); }]) {
    const draft = structuredClone(original); mutate(draft);
    assert.throws(() => publishDraft({ draft, previous: catalogFixture(), reviewer: 'editor', now: NOW }), ActivityContentError);
  }
});

// Filesystem is deliberately in-memory: tests never publish or create output files on disk.
function memoryCli() {
  const root = path.dirname(DEFAULT_CATALOG);
  const taskPath = path.join(root, 'test-task.json');
  const outputPath = path.join(root, 'test-draft.json');
  const releasePath = path.join(root, 'test-release.json');
  const files = new Map([
    [DEFAULT_CATALOG, JSON.stringify(catalogFixture())], [DEFAULT_EXAMPLES, examplesFixture().map(item => JSON.stringify(item)).join('\n')],
    [taskPath, JSON.stringify(taskFixture())],
  ]);
  const writes = [];
  const stdout = [];
  const stderr = [];
  const io = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return files.get(file); },
    async stat(file) { if (file !== root) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return { isDirectory: () => true }; },
    async lstat(file) { if (!files.has(file)) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return { isDirectory: () => false }; },
    async writeFile(file, value, options) {
      assert.equal(options.flag, 'wx');
      if (files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(file, value); writes.push({ file, options });
    },
  };
  const options = { io, env: ENV, fetchImpl: async () => response(), now: NOW,
    stdout: value => stdout.push(value), stderr: value => stderr.push(value) };
  return { root, files, writes, stdout, stderr, options, taskPath, outputPath, releasePath };
}

test('CLI --help needs no catalog, model configuration or filesystem reads', async t => {
  const io = { readFile: t.mock.fn() };
  const output = [];
  assert.equal(await runCli(['--help'], { io, env: {}, stdout: value => output.push(value) }), 0);
  assert.equal(io.readFile.mock.callCount(), 0);
  assert.match(output[0], /publish DRAFT.json OUTPUT.json --reviewer NAME/);
});

test('CLI generate and explicit publish work with wx while leaving the old library untouched', async () => {
  const mem = memoryCli();
  const previous = mem.files.get(DEFAULT_CATALOG);
  assert.equal(await runCli(['generate', mem.taskPath, mem.outputPath], mem.options), 0);
  assert.equal(mem.writes.length, 1);
  assert.equal(JSON.parse(mem.files.get(mem.outputPath)).cards[0].status, 'draft');
  assert.equal(mem.files.get(DEFAULT_CATALOG), previous);
  assert.equal(await runCli(['publish', mem.outputPath, mem.releasePath], mem.options), 1);
  assert.ok(!mem.files.has(mem.releasePath));
  assert.equal(await runCli(['publish', mem.outputPath, mem.releasePath, '--reviewer', 'local editor'], mem.options), 0);
  assert.equal(mem.files.get(DEFAULT_CATALOG), previous);
  const next = JSON.parse(mem.files.get(mem.releasePath));
  assert.equal(next.version, 'activity-v2');
  assert.equal(next.cards.at(-1).status, 'published');
  assert.equal(await runCli(['coverage', mem.releasePath], mem.options), 0);
  assert.equal(JSON.parse(mem.stdout.at(-1)).coverage.length, 60);
  assert.equal(JSON.parse(mem.stdout.at(-1)).inventory_recommendation_tokens, 0);
  const secondTask = taskFixture({ id: 'another_pause' });
  mem.files.set(mem.taskPath, JSON.stringify(secondTask));
  const secondDraft = path.join(mem.root, 'second-draft.json');
  assert.equal(await runCli(['generate', mem.taskPath, secondDraft, '--catalog', mem.releasePath], mem.options), 0);
  assert.equal(JSON.parse(mem.files.get(secondDraft)).cards[0].content_version, 'v3');
});

test('CLI rejects existing output, formal-library output, missing parent and write races without overwrites', async t => {
  for (const kind of ['exists', 'formal', 'parent', 'race']) {
    const mem = memoryCli();
    const fetchImpl = t.mock.fn(async () => response());
    mem.options.fetchImpl = fetchImpl;
    let output = mem.outputPath;
    if (kind === 'exists') mem.files.set(output, 'KEEP ORIGINAL');
    if (kind === 'formal') output = DEFAULT_CATALOG;
    if (kind === 'parent') output = path.join(mem.root, 'missing-directory', 'draft.json');
    if (kind === 'race') mem.options.io.writeFile = async () => { throw Object.assign(new Error('racing writer'), { code: 'EEXIST' }); };
    const previous = new Map(mem.files);
    assert.equal(await runCli(['generate', mem.taskPath, output], mem.options), 1);
    assert.deepEqual(mem.files, previous);
    if (kind !== 'race') assert.equal(fetchImpl.mock.callCount(), 0);
  }
});

test('CLI saves failed-attempt cost metadata, not failed cards or raw responses', async () => {
  const mem = memoryCli();
  mem.options.fetchImpl = async () => response(rawFixture({ minutes: 30, detail: 'RAW_RESPONSE_CANARY' }));
  assert.equal(await runCli(['generate', mem.taskPath, mem.outputPath], mem.options), 1);
  const saved = mem.files.get(mem.outputPath);
  const draft = JSON.parse(saved);
  assert.equal(draft.cards.length, 0);
  assert.equal(draft.generation.usage.total_tokens, 14);
  assert.doesNotMatch(saved + mem.stdout.join('') + mem.stderr.join(''), /RAW_RESPONSE_CANARY|fake-key/);
  assert.equal(await runCli(['publish', mem.outputPath, mem.releasePath, '--reviewer', 'editor'], mem.options), 1);
  assert.ok(!mem.files.has(mem.releasePath));
});

test('CLI missing key is explicit and never calls fetch or writes outputs', async t => {
  const mem = memoryCli();
  mem.options.env = {};
  mem.options.fetchImpl = t.mock.fn();
  assert.equal(await runCli(['generate', mem.taskPath, mem.outputPath], mem.options), 1);
  assert.match(mem.stderr.at(-1), /MODEL_API_KEY_REQUIRED/);
  assert.equal(mem.options.fetchImpl.mock.callCount(), 0);
  assert.equal(mem.writes.length, 0);
});
