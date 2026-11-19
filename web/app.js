const API = '/functions/v1/app';
const SESSION_KEY = 'whynot-session';

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
  return value;
}

const state = {
  sessionReady: false,
  busy: false,
  feedbackPending: false,
  card: null,
};

const result = document.getElementById('result');
const askButton = document.getElementById('ask');

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

function renderLoading() {
  const card = el('article', 'card');
  card.append(el('p', 'loading-text', '正在找建议…'));
  result.replaceChildren(card);
}

function renderNotice(text) {
  const notice = el('div', 'notice');
  notice.setAttribute('role', 'alert');
  notice.append(el('p', null, text));
  const retry = el('button', 'retry', '再试一次');
  retry.type = 'button';
  retry.addEventListener('click', () => ask());
  notice.append(retry);
  return notice;
}

function feedbackButton(label, kind) {
  const button = el('button', null, label);
  button.type = 'button';
  const active = kind === 'completed' ? state.card.completed : state.card.preference === kind;
  button.setAttribute('aria-pressed', String(active));
  if (kind === 'completed' && state.card.completed) {
    button.disabled = true;
    button.textContent = '已完成 ✓';
  }
  button.addEventListener('click', () => sendFeedback(kind));
  return button;
}

function buildCard() {
  const card = state.card;
  const article = el('article', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', null, card.title), el('span', 'badge', `约 ${card.minutes} 分钟`));
  const first = el('p', 'first');
  first.append(el('span', 'step-label', '第一步'), document.createTextNode(card.first_step));
  article.append(head, first, el('p', 'detail', card.detail));

  const actions = el('div', 'card-actions');
  const swap = el('button', 'swap', '换一个');
  swap.type = 'button';
  swap.disabled = state.busy;
  swap.addEventListener('click', () => ask());
  const feedback = el('div', 'feedback');
  feedback.append(feedbackButton('喜欢', 'like'), feedbackButton('不喜欢', 'dislike'), feedbackButton('已完成', 'completed'));
  actions.append(swap, feedback);
  article.append(actions);
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

async function ask() {
  if (state.busy) return;
  state.busy = true;
  askButton.disabled = true;
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
    renderCard();
  } catch (error) {
    state.card = previous;
    result.replaceChildren(renderNotice(errorText(error)));
    if (previous) result.append(buildCard());
  } finally {
    state.busy = false;
    askButton.disabled = false;
    const swap = result.querySelector('.swap');
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
    result.querySelector('.card')?.append(el('p', 'feedback-note', '反馈没有送达，请再点一次。'));
  } finally {
    state.feedbackPending = false;
  }
}

askButton.addEventListener('click', () => ask());
ensureSession();