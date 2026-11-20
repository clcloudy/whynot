const API = '/functions/v1/app';
const SESSION_KEY = 'whynot-session';
const GUIDE_KEY = 'whynot-guide';
const CATEGORY_LABELS = { rest: '歇', observe: '看', listen: '听', tidy: '归', explore: '探' };
const CATEGORY_NAMES = { rest: '休息', observe: '观察', listen: '聆听', tidy: '整理', explore: '探索' };
const SCENE_LABELS = { waiting: '等饭／排队', desk: '在桌前', outside: '在路上', home: '在家／宿舍' };
const ENERGY_LABELS = { low: '有点累', steady: '还可以', high: '精神好' };
const FEEDBACK_LABELS = { like: '喜欢这条建议', dislike: '不喜欢这条建议', completed: '标记为已完成' };
const ERRORS = {
  network_error: '网络好像断了，已选条件还在。再试一次？',
  timeout: '等太久了，网络可能不太稳。再试一次？',
  SESSION_REQUIRED: '会话过期了，再试一次就好。',
  NOT_FOUND: '这条建议找不到了，换一条就好。',
  INVALID_FEEDBACK: '这次反馈没被接受，可以再点一次。',
  STORAGE_UNAVAILABLE: '现在有点忙，没能记下。等一下再试。',
  invalid_response: '拿到的建议不完整，再试一次？',
};
const NO_RETRY = ['INVALID_CONTEXT', 'JSON_REQUIRED', 'INVALID_BODY'];
let sessionToken = null, sessionPromise = null;
try { sessionToken = localStorage.getItem(SESSION_KEY); } catch {}
function saveToken(token) {
  sessionToken = token;
  try { localStorage.setItem(SESSION_KEY, token); } catch {}
}
class RequestError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
async function requestJson(path, init) {
  const signal = AbortSignal.timeout(25000);
  let response, body;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(sessionToken ? { 'x-whynot-session': sessionToken } : {}) },
      credentials: 'same-origin', signal,
    });
    body = await response.json();
  } catch (error) {
    const timeout = signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name);
    throw new RequestError(timeout ? 'timeout' : response ? 'invalid_response' : 'network_error', response?.status || 0);
  }
  if (!response.ok) throw new RequestError(response.status === 409 ? 'STORAGE_UNAVAILABLE' : body?.error || 'request_failed', response.status);
  return body;
}
async function requestWithRecovery(path, init, recoverSession = true) {
  let sessionRetried = false, storageRetried = false;
  for (;;) {
    try { return await requestJson(path, init); }
    catch (error) {
      if (error.code === 'SESSION_REQUIRED' && recoverSession && !sessionRetried) {
        sessionRetried = true;
        await ensureSession(true);
      } else if (error.code === 'STORAGE_UNAVAILABLE' && !storageRetried) {
        storageRetried = true;
        await new Promise(resolve => setTimeout(resolve, 800));
      } else { throw error; }
    }
  }
}
function cardResult(value) {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || typeof value.title !== 'string' || !value.title.trim()
    || typeof value.first_step !== 'string' || !value.first_step.trim() || typeof value.detail !== 'string'
    || !Number.isInteger(value.minutes) || value.minutes < 1
    || !['like', 'dislike', null].includes(value.preference)
    || typeof value.completed !== 'boolean') throw new RequestError('invalid_response', 0);
  const category = Object.keys(CATEGORY_LABELS).includes(value.category) ? value.category : null;
  return { ...value, category };
}
const state = {
  sessionReady: false, busy: false, seq: 0, conditions: null, conditionsMatch: true,
  feedbackPending: false, feedbackAttempts: {}, card: null,
};
const result = document.getElementById('result');
const status = document.getElementById('status');
const feedbackStatus = document.getElementById('feedback-status');
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
  return {
    budget: Number(document.querySelector('input[name="budget"]:checked').value),
    energy: document.querySelector('input[name="energy"]:checked').value,
    scene: document.querySelector('input[name="scene"]:checked').value || null,
  };
}
function sameConditions(a, b) {
  return a && b && ['budget', 'energy', 'scene'].every(key => a[key] === b[key]);
}
async function ensureSession(force = false) {
  if (sessionPromise) return sessionPromise;
  if (state.sessionReady && !force) return;
  sessionPromise = (async () => {
    state.sessionReady = false;
    const body = await requestWithRecovery('/api/session', { method: 'POST' }, false);
    if (body?.ok !== true) throw new RequestError('invalid_response', 0);
    if (typeof body.token === 'string') saveToken(body.token);
    state.sessionReady = true;
  })();
  try { await sessionPromise; } finally { sessionPromise = null; }
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function focus(node) { node?.focus({ preventScroll: true }); }
function reveal(node) {
  const top = node.getBoundingClientRect().top;
  if (top < 0 || top >= innerHeight) node.scrollIntoView({ block: 'start', behavior: 'instant' });
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
  card.setAttribute('aria-hidden', 'true');
  card.append(el('p', 'sk-text', '正在找建议'));
  for (const name of ['meta', 'title w1', 'title w2', 'btn', 'line w1', 'line w2']) card.append(el('div', `sk sk-${name}`));
  result.replaceChildren(card);
}
function errorText(error) {
  if (NO_RETRY.includes(error.code)) return '这次没成功，刷新页面再试。';
  return ERRORS[error.code] || '这次没找到，再试一次。';
}
function renderNotice(error, snapshot) {
  const notice = el('div', 'notice');
  const offline = navigator.onLine === false;
  const inner = el('div', 'notice-inner');
  const fig = el('span', 'notice-fig');
  fig.innerHTML = SVG_BROKEN_48;
  const body = el('div', 'notice-body');
  const text = offline ? '网络断了，已选条件还在。恢复后点「再试一次」。' : errorText(error);
  const message = el('p', 'notice-title', text);
  message.setAttribute('role', offline ? 'status' : 'alert');
  if (offline) notice.dataset.offline = 'true';
  body.append(message);
  if (!NO_RETRY.includes(error.code)) {
    const missing = error.code === 'NOT_FOUND';
    const retry = el('button', 'retry', missing ? '换一个' : '再试一次');
    retry.type = 'button';
    retry.dataset.focus = 'retry';
    retry.disabled = offline;
    retry.setAttribute('aria-disabled', String(offline));
    retry.addEventListener('click', () => ask(missing ? conditions() : snapshot));
    body.append(retry);
  }
  inner.append(fig, body);
  notice.append(inner);
  return notice;
}
function syncConditions() {
  const changed = !!state.conditions && !sameConditions(state.conditions, conditions());
  const note = result.querySelector('.condition-note');
  if (note) {
    note.textContent = state.conditionsMatch && changed ? `按 ${state.conditions.budget} 分钟生成` : '';
    note.hidden = !note.textContent;
  }
  const swap = result.querySelector('[data-focus="swap"]');
  if (!swap) return;
  swap.textContent = changed ? '按新条件再来一条' : '换一个';
  swap.closest('.card-actions')?.classList.toggle('changed', changed);
  const context = state.conditions;
  swap.setAttribute('aria-label', changed ? '按新条件再来一条建议' : `换一个，保留 ${context.budget} 分钟、${ENERGY_LABELS[context.energy]}、${SCENE_LABELS[context.scene] || '跳过'}`);
  swap.disabled = state.busy || navigator.onLine === false;
  swap.setAttribute('aria-disabled', String(swap.disabled));
}
function swapButton(className = 'swap') {
  const swap = el('button', className, '换一个');
  swap.type = 'button';
  swap.dataset.focus = 'swap';
  swap.addEventListener('click', () => ask(conditions(), 'swap'));
  return swap;
}
function feedbackButton(label, kind) {
  const button = el('button', kind === 'completed' ? 'done-key' : null, label);
  button.type = 'button';
  button.dataset.focus = kind;
  button.setAttribute('aria-label', FEEDBACK_LABELS[kind]);
  button.setAttribute('aria-pressed', String(kind === 'completed' ? state.card.completed : state.card.preference === kind));
  button.setAttribute('aria-disabled', String(state.feedbackPending || (state.feedbackAttempts[kind] || 0) >= 2));
  button.addEventListener('click', () => sendFeedback(kind));
  return button;
}
function completedRow() {
  const row = el('div', 'done-row');
  const done = el('span', 'done-state');
  done.tabIndex = -1;
  done.dataset.focus = 'completed';
  done.setAttribute('aria-label', '已完成。这条记下了。');
  done.innerHTML = SVG_CLOSED_16;
  done.append('已完成');
  const share = el('button', 'textbtn', '分享这条');
  share.type = 'button';
  share.dataset.focus = 'share';
  share.setAttribute('aria-label', '分享这条建议');
  share.setAttribute('aria-disabled', String(state.feedbackPending || shareBusy));
  share.addEventListener('click', shareCard);
  row.append(done, el('span', 'done-spacer'), swapButton('textbtn'), share);
  return row;
}
const shareStatus = document.getElementById('share-status');
const shareText = document.getElementById('share-text');
let shareAttempt = 0, shareBusy = false, shareTimer;
function clearShare() {
  shareAttempt++;
  shareBusy = false;
  clearTimeout(shareTimer);
  shareStatus.textContent = '';
  shareText.hidden = true;
  shareText.value = '';
}
async function shareCard() {
  const card = state.card;
  if (!card?.completed || state.busy || state.feedbackPending || shareBusy) return;
  clearShare();
  if (navigator.onLine === false) { shareStatus.textContent = '现在分享不了，等有网再试。'; return; }
  shareBusy = true;
  const attempt = shareAttempt, seq = state.seq;
  const current = () => attempt === shareAttempt && seq === state.seq && state.card?.id === card.id && state.card.completed;
  const button = result.querySelector('[data-focus="share"]');
  button?.setAttribute('aria-disabled', 'true');
  const title = Array.from(card.title).slice(0, 40).join('').replace(/[。！？.!?]+$/, '');
  const text = `刚看到一条 ${state.conditions.budget} 分钟能做的小事：${title}。你也可以选一次自己的空当。\n${location.origin}${location.pathname}`;
  try {
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ text }); return; }
      catch (error) { if (error.name === 'AbortError' || !current()) return; }
    }
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch {}
    if (!current()) return;
    if (!copied) {
      shareText.value = text;
      shareText.hidden = false;
      focus(shareText);
      shareText.select();
      try { copied = document.execCommand('copy'); } catch {}
      if (copied) {
        shareText.hidden = true;
        shareText.value = '';
        focus(button);
      } else {
        shareStatus.textContent = '没能复制，可以长按选中这段文字。';
        reveal(shareText);
        return;
      }
    }
    shareStatus.textContent = '已复制。';
    shareTimer = setTimeout(() => { if (current()) shareStatus.textContent = ''; }, 2000);
  } finally {
    if (current()) {
      shareBusy = false;
      result.querySelector('[data-focus="share"]')?.setAttribute('aria-disabled', 'false');
    }
  }
}
function passCode(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1679616).toString(36).padStart(4, '0').toUpperCase();
}
function buildCard() {
  const card = state.card;
  const article = el('article', 'card');
  article.setAttribute('aria-labelledby', 'card-title');
  article.setAttribute('aria-describedby', 'card-first');
  const code = `NOW-${passCode(String(card.id || ''))}`;
  const head = el('div', 'ticket-head');
  head.setAttribute('aria-hidden', 'true');
  head.append(el('span', 'ticket-code', `THIS PASS · ${code}`), el('span', 'ticket-valid', '有效'));
  const body = el('div', 'ticket-body');
  const meta = el('div', 'card-meta');
  if (card.category) {
    const cat = el('span', 'cat', CATEGORY_LABELS[card.category]);
    cat.setAttribute('aria-label', `类别：${CATEGORY_NAMES[card.category]}`);
    meta.append(cat);
  }
  meta.append(el('span', 'condition-note'));
  const gap = card.minutes <= 3 ? 3 : card.minutes <= 5 ? 5 : card.minutes <= 10 ? 9 : 13;
  const gauge = el('div', 'gauge');
  gauge.setAttribute('aria-hidden', 'true');
  gauge.innerHTML = `<svg class="g-dot" viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><circle cx="6" cy="10" r="4"/></svg><span class="gauge-label">约 ${card.minutes} 分钟</span><svg class="g-line" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true"><line x1="1" y1="1" x2="99" y2="1" stroke-dasharray="3 ${gap}"/></svg><svg class="g-ring" viewBox="0 0 14 20" width="14" height="20" aria-hidden="true"><circle cx="7" cy="10" r="5"/></svg>`;
  const title = el('h2', null, card.title);
  title.id = 'card-title';
  title.tabIndex = -1;
  title.setAttribute('aria-label', `新的建议：${card.title}，约 ${card.minutes} 分钟`);
  const first = el('div', 'first');
  first.id = 'card-first';
  first.append(el('span', 'first-label', '从这一步开始'), el('p', 'first-text', card.first_step));
  body.append(meta, title, gauge, first, el('p', 'detail', card.detail));
  const stub = el('div', 'ticket-stub');
  stub.setAttribute('aria-hidden', 'true');
  stub.append(el('div', 'ticket-bar'), el('span', 'ticket-code', code), el('span', 'ticket-void', '此刻作废'));
  const sep = el('div', 'ticket-sep');
  sep.setAttribute('aria-hidden', 'true');
  if (card.completed) article.classList.add('ticket-done');
  article.append(head, body, sep, stub);
  if (card.completed) article.append(completedRow());
  else {
    const actions = el('div', 'card-actions');
    const feedback = el('div', 'feedback');
    feedback.setAttribute('role', 'group');
    feedback.setAttribute('aria-label', '这条建议怎么样');
    feedback.append(feedbackButton('喜欢', 'like'), feedbackButton('不喜欢', 'dislike'), feedbackButton('已完成', 'completed'));
    actions.append(feedback, swapButton());
    article.append(actions);
  }
  return article;
}
function renderCard() {
  const active = document.activeElement;
  const key = result.contains(active) ? active.dataset.focus : null;
  const old = result.querySelector('.card');
  if (old) old.replaceWith(buildCard());
  else result.append(buildCard());
  syncConditions();
  if (key) focus(result.querySelector(`[data-focus="${key}"]`) || result.querySelector('.done-state'));
}
function dismissGuide() {
  try { localStorage.setItem(GUIDE_KEY, 'seen'); } catch {}
  guide.hidden = true;
}
function setBusy(busy) {
  state.busy = busy;
  result.setAttribute('aria-busy', String(busy));
  askButton.disabled = busy;
  askButton.setAttribute('aria-busy', String(busy));
  if (busy) {
    askButton.textContent = '出票中';
    askButton.insertAdjacentHTML('beforeend', '<span class="ask-dots" aria-hidden="true"><i></i><i></i><i></i></span>');
  } else askButton.textContent = '出一张现在';
}
async function ask(snapshot = conditions(), source = 'primary') {
  if (state.busy) return;
  snapshot = { ...snapshot };
  clearShare();
  feedbackStatus.textContent = '';
  status.textContent = '正在找建议';
  focus(result);
  setBusy(true);
  renderLoading();
  const timer = setTimeout(() => {
    const text = result.querySelector('.sk-text');
    if (text) text.textContent = '还在找，再等一下';
  }, 8000);
  try {
    if (navigator.onLine === false) throw new RequestError('network_error', 0);
    await ensureSession();
    const body = await requestWithRecovery('/api/recommendations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot),
    });
    const card = cardResult(body);
    if (card.minutes > snapshot.budget) throw new RequestError('invalid_response', 0);
    state.card = card;
    state.seq++;
    state.conditions = snapshot;
    state.conditionsMatch = sameConditions(card, snapshot);
    if (!state.conditionsMatch) console.warn('Recommendation context mismatch');
    state.feedbackPending = false;
    state.feedbackAttempts = {};
    setBusy(false);
    result.replaceChildren();
    dismissGuide();
    renderCard();
    status.textContent = '';
    if (document.activeElement === result && source === 'primary') focus(result.querySelector('h2'));
    else {
      if (document.activeElement === result) focus(result.querySelector('[data-focus="swap"]'));
      status.textContent = `新的建议：${card.title}，约 ${card.minutes} 分钟`;
    }
    if (result.contains(document.activeElement)) reveal(result.querySelector('.card'));
  } catch (error) {
    setBusy(false);
    status.textContent = '';
    result.replaceChildren(renderNotice(error, snapshot));
    if (state.card) renderCard();
    if (document.activeElement === result) reveal(result);
  } finally {
    clearTimeout(timer);
    setBusy(false);
    syncConditions();
  }
}
async function sendFeedback(kind) {
  if (state.busy || state.feedbackPending || !state.card || (state.feedbackAttempts[kind] || 0) >= 2) return;
  if (kind === 'completed' ? state.card.completed : state.card.preference === kind) return;
  if (navigator.onLine === false) { feedbackStatus.textContent = ERRORS.network_error; return; }
  const seq = state.seq, cardId = state.card.id, snapshot = { ...state.card };
  const current = () => seq === state.seq && state.card?.id === cardId;
  state.feedbackPending = true;
  feedbackStatus.textContent = '';
  if (kind === 'completed') state.card.completed = true;
  else state.card.preference = kind;
  renderCard();
  let note = '', redraw = false;
  try {
    const body = await requestWithRecovery(`/api/recommendations/${encodeURIComponent(cardId)}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
    });
    if (!current()) return;
    const card = cardResult(body);
    if (card.id !== cardId) throw new RequestError('invalid_response', 0);
    redraw = Object.keys(card).some(key => card[key] !== state.card[key]);
    state.card = card;
    note = kind === 'completed' ? '已完成。这条记下了。' : kind === 'like' ? '记为喜欢，可以改。' : '记为不喜欢，可以改。';
  } catch (error) {
    if (!current()) return;
    redraw = true;
    state.card = snapshot;
    if (error.code === 'NOT_FOUND') {
      state.card = null;
      if (!state.busy) {
        if (result.contains(document.activeElement)) focus(result);
        result.replaceChildren(renderNotice(error, state.conditions));
      }
    } else if (error.code === 'INVALID_FEEDBACK') {
      state.feedbackAttempts[kind] = (state.feedbackAttempts[kind] || 0) + 1;
      if (state.feedbackAttempts[kind] < 2) note = errorText(error);
    } else { note = errorText(error); }
  } finally {
    // A stale completion must not unlock or roll back feedback on the next card.
    if (seq === state.seq && (state.card?.id === cardId || !state.card)) {
      state.feedbackPending = false;
      if (!state.busy && state.card) {
        if (redraw) renderCard();
        else result.querySelectorAll('.feedback button').forEach(button => button.setAttribute('aria-disabled', String((state.feedbackAttempts[button.dataset.focus] || 0) >= 2)));
        result.querySelector('[data-focus="share"]')?.setAttribute('aria-disabled', String(shareBusy));
        if (!(kind === 'completed' && state.card.completed && document.activeElement?.classList.contains('done-state'))) feedbackStatus.textContent = note;
      }
    }
  }
}
function syncSceneRow() {
  const scene = conditions().scene;
  const expanded = sceneToggle.getAttribute('aria-expanded') === 'true';
  sceneValueText.textContent = SCENE_LABELS[scene] || '可跳过';
  sceneToggle.setAttribute('aria-label', `场景，当前${SCENE_LABELS[scene] || '可跳过'}，${expanded ? '收起' : '展开'}${scene ? '修改' : '补充'}`);
}
sceneToggle.addEventListener('click', () => {
  const expanded = sceneToggle.getAttribute('aria-expanded') === 'true';
  sceneToggle.setAttribute('aria-expanded', String(!expanded));
  scenePanel.hidden = expanded;
  syncSceneRow();
  if (expanded) focus(sceneToggle);
});
document.querySelector('.panel').addEventListener('change', () => { syncSceneRow(); syncConditions(); });
const themeKey = 'whynot-theme';
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('input[name="theme"]').forEach(input => { input.checked = input.value === theme; });
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    const dark = theme === 'dark' || (theme === 'system' && meta.media.includes('dark'));
    meta.content = dark ? '#101827' : '#eaf0f8';
  });
}
about.addEventListener('change', event => {
  if (event.target.name !== 'theme') return;
  let theme = event.target.value;
  try {
    if (theme === 'system') localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, theme);
  } catch { theme = 'system'; }
  applyTheme(theme);
});
settingsToggle.setAttribute('aria-label', '设置，关于与主题');
settingsToggle.addEventListener('click', () => {
  const expanded = settingsToggle.getAttribute('aria-expanded') === 'true';
  settingsToggle.setAttribute('aria-expanded', String(!expanded));
  settingsToggle.textContent = expanded ? '设置' : '收起设置';
  settingsToggle.setAttribute('aria-label', expanded ? '设置，关于与主题' : '收起设置，关于与主题');
  about.hidden = expanded;
  if (expanded) focus(settingsToggle);
});
for (const event of ['offline', 'online']) window.addEventListener(event, () => {
  syncConditions();
  const notice = result.querySelector('[data-offline]');
  if (notice) {
    notice.querySelector('.notice-title').textContent = navigator.onLine ? '网络回来了。点「再试一次」。' : '网络断了，已选条件还在。恢复后点「再试一次」。';
    const retry = notice.querySelector('.retry');
    if (retry) { retry.disabled = !navigator.onLine; retry.setAttribute('aria-disabled', String(retry.disabled)); }
  }
});
askButton.addEventListener('click', () => ask());
(function init() {
  const now = new Date();
  document.getElementById('masthead-date').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
  guide.hidden = document.documentElement.dataset.guided === '1';
  applyTheme(document.documentElement.dataset.theme || 'system');
  syncSceneRow();
  renderEmpty();
  ensureSession().catch(() => {});
})();
