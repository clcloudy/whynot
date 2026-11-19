const API = '/functions/v1/app';
const SESSION_KEY = 'whynot-session';
const GUIDE_KEY = 'whynot-guide';

const CATEGORY_LABELS = { rest: '歇', observe: '看', listen: '听', tidy: '归', explore: '探' };
const SCENE_LABELS = { waiting: '等饭／排队', desk: '在桌前', outside: '在路上', home: '在家／宿舍' };
const ENERGY_LABELS = { low: '有点累', steady: '还可以', high: '精神好' };

let sessionToken = null;
try { sessionToken = localStorage.getItem(SESSION_KEY); } catch {}
function saveToken(token) {
  sessionToken = token;
  try { localStorage.setItem(SESSION_KEY, token); } catch {}
}

class RequestError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function requestJson(path, init) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(sessionToken ? { 'x-whynot-session': sessionToken } : {}) },
      credentials: 'same-origin',
      signal: AbortSignal.timeout(25000),
    });
  } catch { throw new RequestError('network_error', 0); }
  let body;
  try { body = await response.json(); } catch { throw new RequestError('invalid_response', response.status); }
  if (!response.ok) throw new RequestError(typeof body?.error === 'string' ? body.error : 'request_failed', response.status);
  return body;
}

function cardResult(value) {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || typeof value.title !== 'string'
    || typeof value.first_step !== 'string' || typeof value.detail !== 'string'
    || !Number.isInteger(value.minutes)
    || !['like', 'dislike', null].includes(value.preference)
    || typeof value.completed !== 'boolean') throw new RequestError('invalid_response', 0);
  const category = typeof value.category === 'string' && CATEGORY_LABELS[value.category] ? value.category : null;
  return { ...value, category };
}

const state = {
  sessionReady: false,
  busy: false,
  feedbackPending: false,
  card: null,
};

const result = document.getElementById('result');
const askButton = document.getElementById('ask');
const guide = document.getElementById('guide');
const sceneToggle = document.getElementById('scene-toggle');
const scenePanel = document.getElementById('scene-panel');
const sceneValueText = document.getElementById('scene-value-text');
const settingsToggle = document.getElementById('settings-toggle');
const about = document.getElementById('about');

const SVG_OPEN_64 = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M30 7.2 H7.2 V40.8 H40.8 V19.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M26 32 H38" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_BROKEN_48 = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M27 6 H6 V42 H42 V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M31 10 H42" stroke="var(--wn-alert)" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_CLOSED_16 = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 2.4 H2.4 V13.6 H13.6 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';

function conditions() {
  const scene = document.querySelector('input[name="scene"]:checked').value;
  return {
    budget: Number(document.querySelector('input[name="budget"]:checked').value),
    energy: document.querySelector('input[name="energy"]:checked').value,
    scene: scene || null,
  };
}

async function ensureSession(force = false) {
  if (state.sessionReady && !force) return true;
  try {
    const body = await requestJson('/api/session', { method: 'POST' });
    if (body?.ok !== true) throw new RequestError('invalid_response', 0);
    if (typeof body.token === 'string') saveToken(body.token);
    state.sessionReady = true;
    return true;
  } catch {
    state.sessionReady = false;
    return false;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEmpty() {
  const block = el('div', 'empty');
  const fig = el('span', 'empty-fig');
  fig.innerHTML = SVG_OPEN_64;
  block.append(fig, el('h2', null, '现在不刷，也可以。'), el('p', 'hint', '选好上面，点一下就有一条。'));
  result.replaceChildren(block);
}

function renderLoading() {
  const card = el('article', 'skeleton');
  card.append(el('p', 'sk-text', '正在找建议'));
  const meta = el('div', 'sk sk-meta');
  const title1 = el('div', 'sk sk-title w1');
  const title2 = el('div', 'sk sk-title w2');
  const btn = el('div', 'sk sk-btn');
  const line1 = el('div', 'sk sk-line w1');
  const line2 = el('div', 'sk sk-line w2');
  card.append(meta, title1, title2, btn, line1, line2);
  result.replaceChildren(card);
}

function renderNotice(text) {
  const notice = el('div', 'notice');
  notice.setAttribute('role', 'alert');
  const inner = el('div', 'notice-inner');
  const fig = el('span', 'notice-fig');
  fig.innerHTML = SVG_BROKEN_48;
  const body = el('div', 'notice-body');
  body.append(el('p', 'notice-title', text));
  const retry = el('button', 'retry', '再试一次');
  retry.type = 'button';
  retry.addEventListener('click', () => ask());
  body.append(retry);
  inner.append(fig, body);
  notice.append(inner);
  return notice;
}

function swapButton() {
  const swap = el('button', 'swap', '换一个');
  swap.type = 'button';
  const card = state.card;
  if (card) {
    const sceneText = card.scene ? SCENE_LABELS[card.scene] : '跳过';
    swap.setAttribute('aria-label', `换一个，保留 ${card.budget} 分钟、${ENERGY_LABELS[card.energy]}、${sceneText}`);
  }
  swap.disabled = state.busy;
  swap.addEventListener('click', () => ask());
  return swap;
}

function feedbackButton(label, kind) {
  const button = el('button', kind === 'completed' ? 'done-key' : null, label);
  button.type = 'button';
  const active = kind === 'completed' ? state.card.completed : state.card.preference === kind;
  button.setAttribute('aria-pressed', String(active));
  button.addEventListener('click', () => sendFeedback(kind));
  return button;
}

function completedRow() {
  const row = el('div', 'done-row');
  const done = el('span', 'done-state');
  done.innerHTML = SVG_CLOSED_16;
  done.append('已完成');
  row.append(done, el('span', 'done-spacer'));
  const swap = el('button', 'textbtn', '换一个');
  swap.type = 'button';
  const card = state.card;
  const sceneText = card.scene ? SCENE_LABELS[card.scene] : '跳过';
  swap.setAttribute('aria-label', `换一个，保留 ${card.budget} 分钟、${ENERGY_LABELS[card.energy]}、${sceneText}`);
  swap.addEventListener('click', () => ask());
  const share = el('button', 'textbtn', '分享这条');
  share.type = 'button';
  share.addEventListener('click', () => shareCard());
  row.append(swap, share);
  return row;
}

async function shareCard() {
  const card = state.card;
  if (!card) return;
  const text = `刚看到一条 ${card.budget} 分钟能做的小事：${card.first_step}你也可以选一次自己的空当。${location.href}`;
  let note = '已复制。';
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    note = '没复制成功，可以长按页面手动复制。';
  }
  const row = result.querySelector('.done-row');
  if (row) row.insertAdjacentElement('afterend', el('p', 'share-note', note));
}

function buildCard() {
  const card = state.card;
  const article = el('article', 'card');
  const meta = el('div', 'card-meta');
  if (card.category) meta.append(el('span', 'cat', CATEGORY_LABELS[card.category]));
  meta.append(el('span', 'badge', `约 ${card.minutes} 分钟`));
  const title = el('h2', null, card.title);
  const sep = el('hr', 'card-sep');
  const first = el('div', 'first');
  first.append(el('span', 'first-label', '第一步'), el('p', 'first-text', card.first_step));
  article.append(meta, title, sep, first, el('p', 'detail', card.detail));

  if (card.completed) {
    article.append(completedRow());
  } else {
    const actions = el('div', 'card-actions');
    const feedback = el('div', 'feedback');
    feedback.setAttribute('role', 'group');
    feedback.setAttribute('aria-label', '这条建议怎么样');
    feedback.append(feedbackButton('喜欢', 'like'), feedbackButton('不喜欢', 'dislike'), feedbackButton('已完成', 'completed'));
    actions.append(feedback, el('span', 'key-sep'), swapButton());
    article.append(actions);
  }
  return article;
}

function renderCard() {
  result.replaceChildren(buildCard());
}

function errorText(error) {
  if (error instanceof RequestError) {
    if (error.code === 'network_error') return '网络好像断了，已选条件还在。再试一次？';
    if (error.code === 'INVALID_CONTEXT') return '时间和精力的选择好像出了点问题，请重新选一下。';
    if (error.code === 'SESSION_REQUIRED') return '会话过期了，请再试一次。';
  }
  return '暂时没找到建议，请稍后再试。';
}

function dismissGuide() {
  try { localStorage.setItem(GUIDE_KEY, 'seen'); } catch {}
  guide.hidden = true;
}

async function ask() {
  if (state.busy) return;
  state.busy = true;
  askButton.disabled = true;
  askButton.textContent = '正在找建议';
  const previous = state.card;
  renderLoading();
  try {
    if (!await ensureSession()) throw new RequestError('network_error', 0);
    const payload = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(conditions()),
    };
    let body;
    try {
      body = await requestJson('/api/recommendations', payload);
    } catch (error) {
      if (error instanceof RequestError && error.code === 'SESSION_REQUIRED') {
        await ensureSession(true);
        body = await requestJson('/api/recommendations', payload);
      } else { throw error; }
    }
    state.card = cardResult(body);
    dismissGuide();
    renderCard();
  } catch (error) {
    state.card = previous;
    result.replaceChildren(renderNotice(errorText(error)));
    if (previous) result.append(buildCard());
  } finally {
    state.busy = false;
    askButton.disabled = false;
    askButton.textContent = '给我一个建议';
    const swap = result.querySelector('.swap, .done-row .textbtn');
    if (swap) swap.disabled = false;
  }
}

async function sendFeedback(kind) {
  if (state.busy || state.feedbackPending || !state.card) return;
  if (kind === 'completed' && state.card.completed) return;
  if (kind !== 'completed' && state.card.preference === kind) return;
  state.feedbackPending = true;
  const snapshot = { ...state.card };
  if (kind === 'completed') state.card.completed = true;
  else state.card.preference = kind;
  renderCard();
  try {
    const body = await requestJson(`/api/recommendations/${state.card.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    state.card = cardResult(body);
    renderCard();
  } catch {
    state.card = snapshot;
    renderCard();
    result.querySelector('.card')?.append(el('p', 'share-note', '反馈没有送达，请再点一次。'));
  } finally {
    state.feedbackPending = false;
  }
}

function syncSceneRow() {
  const scene = document.querySelector('input[name="scene"]:checked').value;
  sceneValueText.textContent = scene ? SCENE_LABELS[scene] : '可跳过';
}

sceneToggle.addEventListener('click', () => {
  const expanded = sceneToggle.getAttribute('aria-expanded') === 'true';
  sceneToggle.setAttribute('aria-expanded', String(!expanded));
  scenePanel.hidden = expanded;
});

document.querySelectorAll('input[name="scene"]').forEach(input => {
  input.addEventListener('change', syncSceneRow);
});

settingsToggle.addEventListener('click', () => {
  const expanded = settingsToggle.getAttribute('aria-expanded') === 'true';
  settingsToggle.setAttribute('aria-expanded', String(!expanded));
  settingsToggle.textContent = expanded ? '设置' : '收起设置';
  about.hidden = expanded;
});

askButton.addEventListener('click', () => ask());

(function init() {
  const now = new Date();
  document.getElementById('masthead-date').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
  let guideSeen = false;
  try { guideSeen = localStorage.getItem(GUIDE_KEY) === 'seen'; } catch {}
  guide.hidden = guideSeen;
  syncSceneRow();
  renderEmpty();
  ensureSession();
})();
