const API = '/functions/v1/app';
const SESSION_KEY = 'whynot-session';
const GUIDE_KEY = 'whynot-guide';
const CATEGORY_LABELS = { rest: '歇', observe: '看', listen: '听', tidy: '归', explore: '探' };
const CATEGORY_NAMES = { rest: '休息', observe: '观察', listen: '聆听', tidy: '整理', explore: '探索' };
const CATEGORY_SHAPES = {
  rest: '<path d="M4 17 11 10M14 10C20 6 13 2 13 2S8 6 11 8"/>',
  observe: '<path d="M11 3H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
  listen: '<path d="M8 3a6 6 0 0 0 0 12M12 5a6 6 0 0 1 0 12"/>',
  tidy: '<path d="M8 3a6 6 0 0 0 0 12ZM12 5a6 6 0 0 1 0 12Z"/>',
  explore: '<path d="M3 16 8 10l4 2M15 3h-3v6h6V6"/><circle cx="3" cy="16" r="1.5" fill="currentColor" stroke="none"/>',
};
const PREFERENCE_SHAPES = {
  like: '<path d="M6 10 2 6C-1 2 4 0 6 3c2-3 7-1 4 3Z" fill="currentColor"/>',
  dislike: '<path d="M2 1h5l3 3v7H2ZM7 1v3h3M4 7h4"/>',
};
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
  TURN_EXPIRED: '这次互动已经休息了，重新开始一次吧。',
  IMAGE_EXPIRED: '照片放太久失效了，重新传一张就好。',
  CANDIDATE_EXPIRED: '这条记忆确认超时了，已经收起。',
  VERSION_CONFLICT: '内容在别处更新过了，刷新后再试。',
  REQUEST_CONFLICT: '这次发送和之前不一致，已停止重发。',
  MODEL_UNAVAILABLE: 'AI 这会儿没回应，你的话还在，可以再发一次。',
  NOT_CONVERSATIONAL: '这次互动已经结束了。',
  IMAGE_TOO_LARGE: '照片超过 4 MiB 了，换张小一点的。',
  UNSUPPORTED_IMAGE: '只支持 JPEG、PNG 或 WebP 照片。',
  INVALID_IMAGE: '这张照片没能读取，换一张试试。',
  IMAGE_REQUIRED: '先传一张照片，再开始识别。',
  INVALID_TURN: '这句话没能发出去，检查一下再试。',
  INVALID_MEMORY: '这段文字没被接受，改一下再试。',
};
const NO_RETRY = ['INVALID_CONTEXT', 'JSON_REQUIRED', 'INVALID_BODY'];
const SUPPORTS = document.documentElement.dataset.image === '1' ? ['text', 'image'] : ['text'];
const MODE_LABELS = { chat: '聊聊', discuss: '讨论', photo: '看图' };
const SVG_CLOSED_16 = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 2.4 H2.4 V13.6 H13.6 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';
const uuid = () => crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
let sessionToken = null, sessionPromise = null;
try { sessionToken = localStorage.getItem(SESSION_KEY); } catch {}
function saveToken(token) {
  sessionToken = token;
  try { localStorage.setItem(SESSION_KEY, token); } catch {}
}
class RequestError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
async function requestJson(path, init, timeoutMs = 25000) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response, body;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(sessionToken ? { 'x-whynot-session': sessionToken } : {}) },
      credentials: 'same-origin', signal,
    });
    if (response.status === 204) return null;
    body = await response.json();
  } catch (error) {
    const timeout = signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name);
    throw new RequestError(timeout ? 'timeout' : response ? 'invalid_response' : 'network_error', response?.status || 0);
  }
  if (!response.ok) throw new RequestError(body?.error || 'request_failed', response.status);
  return body;
}
async function requestWithRecovery(path, init, recoverSession = true, timeoutMs = 25000) {
  let sessionRetried = false, storageRetried = false;
  for (;;) {
    try { return await requestJson(path, init, timeoutMs); }
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
  feedbackPending: false, feedbackAttempts: {}, card: null, ix: null, completionHeight: 0,
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
const localSettings = document.documentElement.dataset.localSettings === '1';
const SVG_OPEN_64 = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M30 7.2 H7.2 V40.8 H40.8 V19.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M26 32 H38" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_BROKEN_48 = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M27 6 H6 V42 H42 V14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M31 10 H42" stroke="var(--wn-alert)" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_STAMP = '<svg class="ticket-stamp" viewBox="0 0 80 80" aria-hidden="true" focusable="false"><circle cx="40" cy="40" r="36"/><circle cx="40" cy="40" r="26"/><defs><path id="stamp-arc" d="M9 40a31 31 0 0 1 62 0"/></defs><text class="stamp-ring"><textPath href="#stamp-arc" startOffset="50%">WHYNOT</textPath></text><text class="stamp-center" x="40" y="37">此<tspan x="40" y="56">刻</tspan></text></svg>';
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
  block.append(fig, el('h2', null, '现在不刷，也可以。'), el('p', 'hint', '选好上面，点一下就开始。'));
  result.replaceChildren(block);
}
function renderLoading(text = '正在找建议') {
  const card = el('article', 'skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.append(el('p', 'sk-text', text));
  ['meta', 'title w1', 'title w2', 'btn', 'line w1', 'line w2'].forEach((name, i) => {
    const block = el('div', `sk sk-${name}`);
    block.style.animationDelay = `${i * 60}ms`;
    card.append(block);
  });
  result.replaceChildren(card);
}
function errorText(error) {
  if (NO_RETRY.includes(error.code)) return '这次没成功，刷新页面再试。';
  return ERRORS[error.code] || '这次没出票，再试一次。';
}
function renderNotice(error, snapshot, opts = {}) {
  const notice = el('div', 'notice');
  const offline = navigator.onLine === false;
  const inner = el('div', 'notice-inner');
  const fig = el('span', 'notice-fig');
  fig.innerHTML = SVG_BROKEN_48;
  const body = el('div', 'notice-body');
  const text = offline ? '网络断了，已选条件还在。恢复后点「再试一次」。' : opts.message || errorText(error);
  const message = el('p', 'notice-title', text);
  message.setAttribute('role', offline ? 'status' : 'alert');
  if (offline) notice.dataset.offline = 'true';
  body.append(message);
  const missing = error.code === 'NOT_FOUND';
  if (opts.retry || !NO_RETRY.includes(error.code)) {
    const retry = el('button', 'retry', opts.label || (missing ? '换一个' : '再试一次'));
    retry.type = 'button';
    retry.dataset.focus = 'retry';
    retry.disabled = offline;
    retry.setAttribute('aria-disabled', String(offline));
    retry.addEventListener('click', opts.retry || (() => ask(missing ? conditions() : snapshot)));
    body.append(retry);
  }
  if (opts.extra) body.append(opts.extra());
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
  const label = state.card.completed ? '换一张' : '换一个';
  swap.textContent = changed ? '按新条件再来一条' : label;
  swap.closest('.card-actions')?.classList.toggle('changed', changed);
  const context = state.conditions;
  swap.setAttribute('aria-label', changed ? '按新条件再来一条建议' : `${label}，${state.card.completed ? '换一个建议，' : ''}保留 ${context.budget} 分钟、${ENERGY_LABELS[context.energy]}、${SCENE_LABELS[context.scene] || '跳过'}`);
  swap.disabled = state.busy || navigator.onLine === false;
  swap.setAttribute('aria-disabled', String(swap.disabled));
}
function swapButton(className = 'swap') {
  const swap = el('button', className, '换一个');
  swap.type = 'button';
  swap.dataset.focus = 'swap';
  swap.addEventListener('click', () => state.ix
    ? startInteraction(conditions(), { replaces: state.ix.id, source: 'swap' })
    : ask(conditions(), 'swap'));
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
function preferenceMark(className = '') {
  const mark = el('span', `preference-mark ${className}`);
  mark.setAttribute('aria-hidden', 'true');
  mark.dataset.preference = state.card.preference || '';
  if (state.card.preference) mark.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12" focusable="false" aria-hidden="true">${PREFERENCE_SHAPES[state.card.preference]}</svg>`;
  return mark;
}
function completedRow() {
  const row = el('div', 'done-row');
  if (state.completionHeight) row.style.minHeight = `${state.completionHeight}px`;
  const done = el('span', 'done-state');
  done.tabIndex = -1;
  done.dataset.focus = 'completed';
  done.setAttribute('aria-label', '已完成，不可撤销');
  done.textContent = '已完成';
  const share = el('button', 'textbtn', '分享此刻');
  share.type = 'button';
  share.dataset.focus = 'share';
  share.setAttribute('aria-label', '分享此刻，分享这条已完成的建议');
  share.setAttribute('aria-disabled', String(state.feedbackPending || shareBusy));
  share.addEventListener('click', shareCard);
  row.append(done, swapButton('textbtn'), share);
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
  const text = `刚完成一件约 ${card.minutes} 分钟的小事：${title}。你也可以出一张自己的此刻。\n${location.origin}${location.pathname}`;
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
  if (card.category) head.innerHTML = `<svg class="category-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">${CATEGORY_SHAPES[card.category]}</svg>`;
  head.append(el('span', 'ticket-code', `THIS PASS · ${code}`), el('span', 'ticket-valid', '有效'));
  const body = el('div', 'ticket-body');
  const meta = el('div', 'card-meta');
  if (card.category) {
    const cat = el('span', 'cat', CATEGORY_LABELS[card.category]);
    cat.setAttribute('aria-label', `类别：${CATEGORY_NAMES[card.category]}`);
    meta.append(cat);
  }
  meta.append(el('span', 'condition-note'), preferenceMark('compact-feedback'));
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
  stub.append(el('div', 'ticket-bar'), el('span', 'ticket-code', code), el('span', 'ticket-void', '此刻作废'), preferenceMark());
  const sep = el('div', 'ticket-sep');
  sep.setAttribute('aria-hidden', 'true');
  if (card.completed) {
    article.classList.add('ticket-done');
    article.insertAdjacentHTML('beforeend', SVG_STAMP);
  }
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
  const caret = key === 'turn-input' ? active.selectionStart : null;
  const ticket = !state.ix || state.ix.mode === 'micro';
  const old = result.querySelector('.card');
  if (!ticket || !state.card.completed) state.completionHeight = 0;
  else if (old) state.completionHeight = old.querySelector('.card-actions, .done-row').getBoundingClientRect().height;
  const article = ticket ? buildCard() : buildInteractionCard();
  if (old) {
    article.classList.add('card-refresh');
    const animateFeedback = ticket && state.feedbackPending && state.card.preference && old.querySelector('.preference-mark')?.dataset.preference !== state.card.preference;
    if (ticket && state.card.completed && !old.classList.contains('ticket-done')) article.querySelector('.ticket-stamp').classList.add('stamp-in');
    old.replaceWith(article);
    if (animateFeedback) {
      const mark = [...article.querySelectorAll('.preference-mark svg')].find(node => node.getBoundingClientRect().width > 0);
      mark.classList.add('feedback-in');
      if (getComputedStyle(mark).animationName === 'none') mark.classList.remove('feedback-in');
      else for (const event of ['animationend', 'animationcancel']) mark.addEventListener(event, () => mark.classList.remove('feedback-in'), { once: true });
    }
  } else result.append(article);
  syncConditions();
  const log = result.querySelector('.turn-log');
  if (log) log.scrollTop = log.scrollHeight;
  if (key) {
    const node = result.querySelector(`[data-focus="${key}"]`) || result.querySelector('.done-state');
    focus(node);
    if (key === 'turn-input' && node?.dataset.focus === key) node.setSelectionRange(caret ?? node.value.length, caret ?? node.value.length);
  }
  syncTurnForm(state.ix);
}
function dismissGuide() {
  try { localStorage.setItem(GUIDE_KEY, 'seen'); } catch {}
  guide.hidden = true;
}
function setBusy(busy, busyText = '正在找建议') {
  state.busy = busy;
  result.setAttribute('aria-busy', String(busy));
  askButton.disabled = busy;
  askButton.setAttribute('aria-busy', String(busy));
  askButton.setAttribute('aria-label', busy ? `出票中，${busyText}` : '出一张现在，开始一次互动');
  if (busy) {
    askButton.textContent = '出票中';
    askButton.insertAdjacentHTML('beforeend', '<span class="ask-dots" aria-hidden="true"><i></i><i></i><i></i></span>');
  } else askButton.textContent = '出一张现在';
}
function exitCard() {
  const old = result.querySelector('.card');
  if (!old || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  old.classList.add('card-out');
  return new Promise(res => setTimeout(res, 160));
}
async function ask(snapshot = conditions(), source = 'primary') {
  if (state.busy) return;
  snapshot = { ...snapshot };
  clearShare();
  feedbackStatus.textContent = '';
  status.textContent = '正在找建议';
  focus(result);
  setBusy(true);
  const timer = setTimeout(() => {
    const text = result.querySelector('.sk-text');
    if (text) text.textContent = '还在找，再等一下';
  }, 8000);
  await exitCard();
  renderLoading();
  try {
    if (navigator.onLine === false) throw new RequestError('network_error', 0);
    await ensureSession();
    const body = await requestWithRecovery('/api/recommendations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot),
    });
    const card = cardResult(body);
    if (card.minutes > snapshot.budget) throw new RequestError('invalid_response', 0);
    releaseIx(state.ix);
    state.ix = null;
    state.card = card;
    state.completionHeight = 0;
    state.seq++;
    state.conditions = snapshot;
    state.conditionsMatch = sameConditions(card, snapshot);
    if (!state.conditionsMatch) console.warn('Recommendation context mismatch');
    state.feedbackPending = false;
    state.feedbackAttempts = {};
    result.replaceChildren();
    dismissGuide();
    setBusy(false);
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
    // Interaction cards keep their own state; only feedback fields merge back.
    const merged = state.ix ? { ...state.card, preference: card.preference, completed: card.completed } : card;
    redraw = Object.keys(merged).some(key => merged[key] !== state.card[key]);
    state.card = merged;
    note = kind === 'completed' ? '已完成。这条记下了。' : kind === 'like' ? '记为喜欢，可以改。' : '记为不喜欢，可以改。';
  } catch (error) {
    if (!current()) return;
    redraw = true;
    state.card = snapshot;
    if (error.code === 'NOT_FOUND') {
      releaseIx(state.ix);
      state.ix = null;
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
function interactionResult(value) {
  const card = cardResult(value);
  if (!['chat', 'discuss', 'micro', 'photo'].includes(value.mode)
    || !['open', 'card', 'awaiting_image', 'closed', 'expired'].includes(value.state)
    || !Number.isInteger(value.version) || value.version < 1
    || !['text', 'image', 'none'].includes(value.expected_input)) throw new RequestError('invalid_response', 0);
  return {
    card, mode: value.mode, topic: typeof value.topic === 'string' ? value.topic : null,
    state: value.state, version: value.version, word: value.word ?? null,
  };
}
function releaseIx(ix) {
  if (ix) for (const url of ix.urls) URL.revokeObjectURL(url);
}
function interactionFrom(data) {
  return {
    id: data.card.id, mode: data.mode, topic: data.topic,
    status: data.state, version: data.version, word: data.word,
    messages: [], draft: '', sending: false, ending: false,
    candidate: null, pendingImage: null, uploadBusy: false, uploadError: '', turnError: '',
    urls: [],
  };
}
async function startInteraction(snapshot = conditions(), opts = {}) {
  if (state.busy) return;
  snapshot = { ...snapshot };
  const replaces = opts.replaces ?? null;
  const requestId = opts.requestId || uuid();
  const source = opts.source || 'primary';
  const payload = { ...snapshot, supports: SUPPORTS, request_id: requestId, ...(replaces ? { replaces } : {}) };
  clearShare();
  feedbackStatus.textContent = '';
  status.textContent = '正在开启互动';
  focus(result);
  setBusy(true, '正在开启互动');
  const timer = setTimeout(() => {
    const text = result.querySelector('.sk-text');
    if (text) text.textContent = '还在准备，再等一下';
  }, 8000);
  await exitCard();
  renderLoading('正在开启互动');
  try {
    if (navigator.onLine === false) throw new RequestError('network_error', 0);
    await ensureSession();
    const body = await requestWithRecovery('/api/interactions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = interactionResult(body);
    if (data.card.minutes > snapshot.budget) throw new RequestError('invalid_response', 0);
    releaseIx(state.ix);
    state.card = data.card;
    state.completionHeight = 0;
    state.ix = interactionFrom(data);
    state.seq++;
    state.conditions = snapshot;
    state.conditionsMatch = sameConditions(data.card, snapshot);
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
      status.textContent = `新的互动：${data.card.title}，约 ${data.card.minutes} 分钟`;
    }
    if (result.contains(document.activeElement)) reveal(result.querySelector('.card'));
  } catch (error) {
    setBusy(false);
    status.textContent = '';
    const noticeOpts = {};
    if (!NO_RETRY.includes(error.code)) {
      // Retrying an opening reuses the same request UUID and payload.
      const fresh = error.code === 'REQUEST_CONFLICT' || (error.code === 'NOT_FOUND' && replaces);
      noticeOpts.retry = fresh
        ? () => startInteraction(snapshot, { replaces: error.code === 'REQUEST_CONFLICT' ? replaces : null, source })
        : () => startInteraction(snapshot, { replaces, requestId, source });
      if (fresh) noticeOpts.label = '重新开始';
    }
    if (error.code === 'STORAGE_UNAVAILABLE') {
      noticeOpts.message = '互动暂时不可用：服务端还没准备好互动存储。可以先看一条普通建议。';
      noticeOpts.extra = () => {
        const fallback = el('button', 'retry', '看一条普通建议');
        fallback.type = 'button';
        fallback.addEventListener('click', () => ask(snapshot));
        return fallback;
      };
    }
    result.replaceChildren(renderNotice(error, snapshot, noticeOpts));
    if (state.card) renderCard();
    if (document.activeElement === result) reveal(result);
  } finally {
    clearTimeout(timer);
    setBusy(false);
    syncConditions();
  }
}
function wordCard(word) {
  const block = el('div', 'word-card');
  const head = el('div', 'word-head');
  head.append(el('span', 'word-en', word.word), el('span', 'word-ipa', word.ipa));
  block.append(head, el('p', 'word-meaning', word.meaning), el('p', 'word-practice', word.practice));
  return block;
}
function messageNode(ix, msg) {
  const node = el('div', `msg msg-${msg.role} msg-${msg.status}`);
  if (msg.imageUrl) {
    const img = el('img', 'msg-img');
    img.src = msg.imageUrl;
    img.alt = '你上传的照片';
    node.append(img);
  }
  if (msg.word) node.append(wordCard(msg.word));
  else if (msg.text) node.append(el('p', 'msg-text', msg.text));
  if (msg.status === 'pending') node.append(el('span', 'msg-wait', msg.role === 'user' ? '发送中' : '正在回应'));
  if (msg.status === 'failed') {
    const foot = el('div', 'msg-foot');
    foot.append(el('span', 'msg-error', msg.stale ? '这条跟不上当前对话了，移除后再说一次。' : errorText({ code: msg.error })));
    if (!msg.conflict && !msg.stale) {
      const retry = el('button', 'textbtn msg-retry', msg.reupload ? '重新上传' : '重试');
      retry.type = 'button';
      retry.dataset.focus = `retry-${msg.requestId}`;
      retry.addEventListener('click', () => retryTurn(msg));
      foot.append(retry);
    }
    const drop = el('button', 'textbtn', '移除');
    drop.type = 'button';
    drop.dataset.focus = `drop-${msg.requestId}`;
    drop.addEventListener('click', () => dropTurn(msg));
    foot.append(drop);
    node.append(foot);
  }
  return node;
}
function turnLog(ix) {
  const log = el('div', 'turn-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', '对话记录');
  for (const msg of ix.messages) log.append(messageNode(ix, msg));
  return log;
}
function syncTurnForm(ix) {
  if (!ix) return;
  const input = result.querySelector('[data-focus="turn-input"]');
  const send = result.querySelector('[data-focus="send"]');
  if (!input || !send) return;
  const text = ix.draft.trim();
  const valid = text.length >= 1 && text.length <= 500 && !/[\u0000-\u001f]/.test(text);
  input.disabled = ix.sending;
  send.disabled = ix.sending || !valid;
  send.setAttribute('aria-disabled', String(send.disabled));
  const count = result.querySelector('.turn-count');
  if (count) count.textContent = ix.draft.length ? `${ix.draft.length}/500` : '';
  const hint = result.querySelector('.turn-hint');
  if (hint) hint.textContent = ix.turnError || '';
}
function turnForm(ix) {
  const wrap = el('div', 'turn-area');
  const form = el('div', 'turn-form');
  const input = el('input', 'turn-input');
  input.type = 'text';
  input.maxLength = 500;
  input.autocomplete = 'off';
  input.enterKeyHint = 'send';
  input.placeholder = ix.word ? '围绕这个词继续问…' : ix.mode === 'photo' ? '补充说明，比如「左边那个」' : '说点什么，一句话就够';
  input.setAttribute('aria-label', '输入要发送的话，1 到 500 字');
  input.dataset.focus = 'turn-input';
  input.value = ix.draft;
  input.addEventListener('input', () => { ix.draft = input.value; syncTurnForm(ix); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendTurn(); }
  });
  const send = el('button', 'turn-send', '发送');
  send.type = 'button';
  send.dataset.focus = 'send';
  send.addEventListener('click', () => sendTurn());
  form.append(input, send);
  const foot = el('div', 'turn-foot');
  const hint = el('span', 'turn-hint');
  hint.setAttribute('role', 'status');
  foot.append(hint, el('span', 'turn-count'));
  wrap.append(form, foot);
  return wrap;
}
function openPicker() {
  result.querySelector('.photo-file')?.click();
}
function photoArea(ix) {
  const area = el('div', 'photo-area');
  const pick = el('button', 'photo-pick', ix.uploadBusy ? '正在上传…' : ix.messages.length ? '重拍或换一张' : '拍照或选图');
  pick.type = 'button';
  pick.dataset.focus = 'photo';
  pick.disabled = ix.uploadBusy || ix.sending;
  pick.setAttribute('aria-disabled', String(pick.disabled));
  pick.addEventListener('click', openPicker);
  const file = el('input', 'photo-file');
  file.type = 'file';
  file.accept = 'image/jpeg,image/png,image/webp';
  file.hidden = true;
  file.tabIndex = -1;
  file.setAttribute('aria-hidden', 'true');
  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (chosen) uploadPhoto(chosen);
  });
  area.append(pick, file, el('p', 'photo-hint', '支持 JPEG／PNG／WebP，不超过 4 MiB，每边不超过 4096 像素'));
  if (ix.uploadError) {
    const error = el('p', 'photo-error', ix.uploadError);
    error.setAttribute('role', 'alert');
    area.append(error);
  }
  return area;
}
function ixActions(ix) {
  const row = el('div', 'ix-actions');
  const end = el('button', 'textbtn ix-end', ix.ending ? '正在结束…' : '结束互动');
  end.type = 'button';
  end.dataset.focus = 'end';
  end.setAttribute('aria-disabled', String(ix.ending));
  end.addEventListener('click', endInteraction);
  row.append(end, swapButton());
  return row;
}
function closedRow(ix) {
  const row = el('div', 'ix-closed');
  const mark = el('span', 'done-state');
  mark.innerHTML = SVG_CLOSED_16;
  mark.append(ix.status === 'expired' ? '这次互动已过期' : '已结束，随时可以再来');
  const restart = el('button', 'swap ix-restart', '重新开始');
  restart.type = 'button';
  restart.dataset.focus = 'restart';
  restart.addEventListener('click', () => startInteraction(conditions(), { source: 'restart' }));
  row.append(mark, el('span', 'done-spacer'), restart, swapButton('textbtn'));
  return row;
}
function candButton(label, key, onClick, disabled) {
  const button = el('button', null, label);
  button.type = 'button';
  button.dataset.focus = key;
  button.setAttribute('aria-disabled', String(disabled));
  button.addEventListener('click', onClick);
  return button;
}
function candidateBlock(ix) {
  const candidate = ix.candidate;
  const block = el('div', 'candidate');
  block.append(el('span', 'candidate-label', candidate.status === 'saved' ? '已记下这句' : '要记住这句吗？'));
  if (candidate.status === 'editing') {
    const input = el('input', 'candidate-input');
    input.type = 'text';
    input.maxLength = 100;
    input.value = candidate.editText;
    input.dataset.focus = 'cand-input';
    input.setAttribute('aria-label', '修改要记住的话，1 到 100 字');
    input.addEventListener('input', () => { candidate.editText = input.value; });
    block.append(input);
  } else {
    block.append(el('p', 'candidate-text', `「${candidate.text}」`));
  }
  if (['pending', 'editing'].includes(candidate.status)) {
    const keys = el('div', 'candidate-keys');
    keys.setAttribute('role', 'group');
    keys.setAttribute('aria-label', '保存这条记忆');
    if (candidate.status === 'editing') {
      keys.append(
        candButton('保存修改', 'cand-save', () => confirmCandidate('confirm', candidate.editText), candidate.saving),
        candButton('取消', 'cand-cancel', () => { candidate.status = 'pending'; candidate.note = ''; renderCard(); }, candidate.saving),
      );
    } else {
      keys.append(
        candButton('保存', 'cand-save', () => confirmCandidate('confirm'), candidate.saving),
        candButton('改一下再保存', 'cand-edit', () => {
          candidate.status = 'editing';
          candidate.editText = candidate.text;
          renderCard();
          focus(result.querySelector('[data-focus="cand-input"]'));
        }, candidate.saving),
        candButton('跳过', 'cand-skip', () => confirmCandidate('skip'), candidate.saving),
      );
    }
    block.append(keys);
  }
  if (candidate.note) {
    const note = el('p', 'candidate-note', candidate.note);
    note.setAttribute('role', 'status');
    block.append(note);
  }
  return block;
}
function buildInteractionCard() {
  const ix = state.ix, card = state.card;
  const article = el('article', 'card ix-card');
  article.setAttribute('aria-labelledby', 'card-title');
  article.setAttribute('aria-describedby', 'card-first');
  const meta = el('div', 'card-meta');
  const mode = el('span', `mode mode-${ix.mode}`, MODE_LABELS[ix.mode]);
  mode.setAttribute('aria-label', `互动方式：${MODE_LABELS[ix.mode]}`);
  meta.append(mode, el('span', 'badge', `约 ${card.minutes} 分钟`), el('span', 'condition-note'));
  const title = el('h2', null, card.title);
  title.id = 'card-title';
  title.tabIndex = -1;
  const first = el('div', 'first');
  first.id = 'card-first';
  first.append(el('span', 'first-label', ix.mode === 'photo' ? '第一步' : '开场'), el('p', 'first-text', card.first_step));
  article.append(meta, title, el('hr', 'card-sep'), first, el('p', 'detail', card.detail));
  if (ix.messages.length) article.append(turnLog(ix));
  if (ix.candidate) article.append(candidateBlock(ix));
  if (ix.status === 'open' || ix.status === 'awaiting_image') {
    if (ix.mode === 'photo' && ix.status === 'awaiting_image') article.append(photoArea(ix));
    if (ix.mode !== 'photo' || ix.pendingImage || ix.word) article.append(turnForm(ix));
    article.append(ixActions(ix));
  } else {
    article.append(closedRow(ix));
  }
  return article;
}
async function doTurn(ix, msg) {
  const seq = state.seq;
  const current = () => state.ix === ix && seq === state.seq;
  try {
    if (navigator.onLine === false) throw new RequestError('network_error', 0);
    const payload = {
      request_id: msg.requestId, version: msg.version,
      ...(msg.imageRef ? { image_ref: msg.imageRef } : { text: msg.text }),
    };
    const body = await requestWithRecovery(`/api/interactions/${encodeURIComponent(ix.id)}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!current() || ix.status === 'closed' || ix.status === 'expired') return;
    if (!body || typeof body.reply !== 'string' || !Number.isInteger(body.version)) throw new RequestError('invalid_response', 0);
    msg.status = 'sent';
    ix.version = body.version;
    if (body.word) { ix.word = body.word; ix.pendingImage = null; ix.status = 'open'; }
    ix.messages.push({ role: 'ai', text: body.reply, word: body.word ?? null, status: 'sent' });
    for (const older of ix.messages) {
      if (older.role === 'user' && older.status === 'failed' && older.version < ix.version) older.stale = true;
    }
    if (body.candidate && typeof body.candidate.id === 'string') {
      ix.candidate = { ...body.candidate, status: 'pending', editText: body.candidate.text, note: '', saving: false };
    }
    ix.sending = false;
    renderCard();
    status.textContent = body.word ? '识别完成，可以围绕这个词继续问' : 'AI 已回复，可以继续说';
    focus(result.querySelector('[data-focus="turn-input"]'));
  } catch (error) {
    if (!current()) return;
    ix.sending = false;
    msg.status = 'failed';
    msg.error = error.code;
    if (error.code === 'TURN_EXPIRED' || error.code === 'NOT_FOUND') ix.status = 'expired';
    else if (error.code === 'NOT_CONVERSATIONAL') ix.status = 'closed';
    else if (error.code === 'REQUEST_CONFLICT') msg.conflict = true;
    else if (error.code === 'IMAGE_EXPIRED') { ix.pendingImage = null; msg.reupload = true; }
    renderCard();
    status.textContent = '这条没发出去，可以重试';
  }
}
async function sendTurn() {
  const ix = state.ix;
  if (!ix || ix.sending || ix.uploadBusy || !['open', 'awaiting_image'].includes(ix.status)) return;
  const text = ix.draft.trim();
  if (!text || text.length > 500 || /[\u0000-\u001f]/.test(text)) {
    ix.turnError = '写 1–500 个字，一行就好。';
    syncTurnForm(ix);
    return;
  }
  if (ix.mode === 'photo' && !ix.word && !ix.pendingImage) return;
  ix.turnError = '';
  const msg = { role: 'user', text, status: 'pending', requestId: uuid(), version: ix.version };
  ix.messages.push(msg);
  ix.draft = '';
  ix.sending = true;
  renderCard();
  await doTurn(ix, msg);
}
async function retryTurn(msg) {
  const ix = state.ix;
  if (!ix || ix.sending || ix.uploadBusy || msg.status !== 'failed' || msg.conflict || msg.stale) return;
  if (msg.reupload) { dropTurn(msg, false); openPicker(); return; }
  if (!['open', 'awaiting_image'].includes(ix.status)) return;
  msg.status = 'pending';
  msg.error = null;
  ix.sending = true;
  renderCard();
  await doTurn(ix, msg);
}
function dropTurn(msg, restore = true) {
  const ix = state.ix;
  if (!ix || ix.sending) return;
  ix.messages = ix.messages.filter(item => item !== msg);
  if (msg.imageUrl) {
    URL.revokeObjectURL(msg.imageUrl);
    ix.urls = ix.urls.filter(url => url !== msg.imageUrl);
  }
  if (restore && msg.text && !ix.draft) ix.draft = msg.text;
  renderCard();
  focus(result.querySelector('[data-focus="turn-input"]'));
}
async function uploadPhoto(file) {
  const ix = state.ix;
  if (!ix || ix.uploadBusy || ix.sending || ix.status !== 'awaiting_image') return;
  ix.uploadError = '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { ix.uploadError = ERRORS.UNSUPPORTED_IMAGE; renderCard(); return; }
  if (file.size > 4 * 1024 * 1024) { ix.uploadError = ERRORS.IMAGE_TOO_LARGE; renderCard(); return; }
  if (!file.size) { ix.uploadError = ERRORS.INVALID_IMAGE; renderCard(); return; }
  ix.uploadBusy = true;
  renderCard();
  const seq = state.seq;
  const current = () => state.ix === ix && seq === state.seq;
  const version = ix.version;
  try {
    if (navigator.onLine === false) throw new RequestError('network_error', 0);
    const body = await requestWithRecovery(`/api/interactions/${encodeURIComponent(ix.id)}/images?version=${version}`, {
      method: 'POST', headers: { 'content-type': file.type }, body: file,
    }, true, 60000);
    if (!current()) return;
    if (!body || typeof body.image_ref !== 'string') throw new RequestError('invalid_response', 0);
    const url = URL.createObjectURL(file);
    ix.urls.push(url);
    ix.pendingImage = body.image_ref;
    const msg = { role: 'user', imageRef: body.image_ref, imageUrl: url, status: 'pending', requestId: uuid(), version };
    ix.messages.push(msg);
    ix.uploadBusy = false;
    ix.sending = true;
    renderCard();
    await doTurn(ix, msg);
  } catch (error) {
    if (!current()) return;
    ix.uploadBusy = false;
    if (error.code === 'TURN_EXPIRED' || error.code === 'NOT_FOUND') ix.status = 'expired';
    else if (error.code === 'NOT_CONVERSATIONAL') ix.status = 'closed';
    else ix.uploadError = errorText(error);
    renderCard();
  }
}
async function endInteraction() {
  const ix = state.ix;
  if (!ix || ix.ending || !['open', 'awaiting_image'].includes(ix.status)) return;
  ix.ending = true;
  feedbackStatus.textContent = '';
  renderCard();
  const seq = state.seq;
  const current = () => state.ix === ix && seq === state.seq;
  try {
    await requestWithRecovery(`/api/interactions/${encodeURIComponent(ix.id)}`, { method: 'DELETE' });
    if (!current()) return;
    ix.status = 'closed';
    status.textContent = '互动已结束';
  } catch (error) {
    if (!current()) return;
    if (error.code === 'NOT_FOUND') { ix.status = 'closed'; status.textContent = '互动已结束'; }
    else feedbackStatus.textContent = errorText(error);
  } finally {
    if (current()) { ix.ending = false; renderCard(); }
  }
}
async function confirmCandidate(action, text) {
  const ix = state.ix, candidate = ix?.candidate;
  if (!candidate || candidate.saving || !['pending', 'editing'].includes(candidate.status)) return;
  if (action === 'confirm' && text !== undefined) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f]/.test(trimmed)) {
      candidate.note = '写 1–100 个字就好。';
      renderCard();
      return;
    }
    text = trimmed;
  }
  const payload = { candidate_id: candidate.id, version: candidate.version, action, ...(text !== undefined ? { text } : {}) };
  const key = JSON.stringify(payload);
  if (candidate.conflictKey === key) { candidate.note = ERRORS.REQUEST_CONFLICT; renderCard(); return; }
  candidate.saving = true;
  candidate.note = '';
  renderCard();
  const seq = state.seq;
  const current = () => state.ix === ix && seq === state.seq && ix.candidate === candidate;
  try {
    const body = await requestWithRecovery(`/api/interactions/${encodeURIComponent(ix.id)}/memories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!current()) return;
    if (body?.skipped === true) { candidate.status = 'skipped'; candidate.note = '已跳过，不会保存。'; }
    else if (body && typeof body.text === 'string') {
      candidate.status = 'saved';
      candidate.note = `已保存「${body.text}」。在「关于与数据」里可以查看和修改。`;
      status.textContent = '记忆已保存';
    } else throw new RequestError('invalid_response', 0);
  } catch (error) {
    if (!current()) return;
    if (error.code === 'CANDIDATE_EXPIRED') { candidate.status = 'expired'; candidate.note = ERRORS.CANDIDATE_EXPIRED; }
    else if (error.code === 'VERSION_CONFLICT') { candidate.status = 'expired'; candidate.note = '这条已经处理过了。'; }
    else if (error.code === 'NOT_FOUND') { candidate.status = 'expired'; candidate.note = '这条候选已经不在了。'; }
    else if (error.code === 'REQUEST_CONFLICT') { candidate.conflictKey = key; candidate.note = ERRORS.REQUEST_CONFLICT; }
    else candidate.note = errorText(error);
  } finally {
    if (current()) { candidate.saving = false; renderCard(); }
  }
}
const mem = {
  status: 'idle', items: [], total: 0, busy: false, loadingMore: false,
  error: '', note: '', editing: null, editDraft: '', confirmDelete: null,
};
const memoriesBox = document.getElementById('memories');
function memDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}月${date.getDate()}日`;
}
function memButton(label, key, onClick, danger = false) {
  const button = el('button', danger ? 'textbtn mem-danger' : 'textbtn', label);
  button.type = 'button';
  button.dataset.focus = key;
  button.setAttribute('aria-disabled', String(mem.busy));
  button.addEventListener('click', onClick);
  return button;
}
function renderMemories() {
  if (!memoriesBox) return;
  const active = document.activeElement;
  const key = memoriesBox.contains(active) ? active.dataset.focus : null;
  const box = el('div');
  const head = el('div', 'mem-head');
  head.append(el('span', 'mem-count', mem.status === 'ready' ? `共 ${mem.total} 条` : ''), memButton('刷新', 'mem-refresh', () => loadMemories()));
  box.append(head);
  if (mem.status === 'loading') box.append(el('p', 'mem-empty', '正在读取…'));
  else if (mem.status === 'error') {
    const error = el('p', 'mem-empty', `没能读到记忆：${mem.error}`);
    error.setAttribute('role', 'alert');
    box.append(error);
  } else if (mem.status === 'ready' && !mem.items.length) {
    box.append(el('p', 'mem-empty', '还没有保存过记忆。在聊天里说「帮我记住…」，确认后就会出现在这里。'));
  } else if (mem.status === 'ready') {
    const list = el('ul', 'mem-list');
    for (const item of mem.items) {
      const node = el('li', 'mem-item');
      if (mem.editing === item.id) {
        const input = el('input', 'mem-input');
        input.type = 'text';
        input.maxLength = 100;
        input.value = mem.editDraft;
        input.dataset.focus = `mem-input-${item.id}`;
        input.setAttribute('aria-label', '修改这条记忆，1 到 100 字');
        input.addEventListener('input', () => { mem.editDraft = input.value; });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveMemory(item); }
        });
        const keys = el('div', 'mem-keys');
        keys.append(
          memButton('保存', `mem-save-${item.id}`, () => saveMemory(item)),
          memButton('取消', `mem-cancel-${item.id}`, () => { mem.editing = null; mem.note = ''; renderMemories(); }),
        );
        node.append(input, keys);
      } else {
        node.append(el('p', 'mem-text', item.text), el('p', 'mem-meta', `${item.topic || '记忆'} · ${memDate(item.confirmed_at)}确认`));
        const keys = el('div', 'mem-keys');
        if (mem.confirmDelete === item.id) {
          keys.append(
            memButton('确认删除', `mem-confirm-${item.id}`, () => removeMemory(item), true),
            memButton('取消', `mem-cancel-${item.id}`, () => { mem.confirmDelete = null; renderMemories(); }),
          );
        } else {
          keys.append(
            memButton('编辑', `mem-edit-${item.id}`, () => {
              mem.editing = item.id;
              mem.editDraft = item.text;
              mem.confirmDelete = null;
              mem.note = '';
              renderMemories();
              focus(memoriesBox.querySelector(`[data-focus="mem-input-${item.id}"]`));
            }),
            memButton('删除', `mem-delete-${item.id}`, () => { mem.confirmDelete = item.id; mem.editing = null; renderMemories(); }, true),
          );
        }
        node.append(keys);
      }
      list.append(node);
    }
    box.append(list);
    if (mem.items.length < mem.total) {
      box.append(memButton(mem.loadingMore ? '正在加载…' : '加载更多', 'mem-more', () => moreMemories()));
    }
  }
  if (mem.note) {
    const note = el('p', 'mem-note', mem.note);
    note.setAttribute('role', 'status');
    box.append(note);
  }
  memoriesBox.replaceChildren(box);
  if (key) focus(memoriesBox.querySelector(`[data-focus="${key}"]`));
}
async function loadMemories() {
  if (mem.status === 'loading' || mem.busy) return;
  mem.status = 'loading';
  mem.error = '';
  renderMemories();
  try {
    await ensureSession();
    const body = await requestWithRecovery('/api/memories?limit=20&offset=0');
    if (!body || !Array.isArray(body.memories) || !Number.isInteger(body.total)) throw new RequestError('invalid_response', 0);
    mem.items = body.memories;
    mem.total = body.total;
    mem.status = 'ready';
    if (mem.editing && !mem.items.some(item => item.id === mem.editing)) {
      mem.editing = null;
      mem.note = '要修改的那条已经不在了。';
    }
    if (mem.confirmDelete && !mem.items.some(item => item.id === mem.confirmDelete)) mem.confirmDelete = null;
  } catch (error) {
    mem.status = 'error';
    mem.error = errorText(error);
  }
  renderMemories();
}
async function moreMemories() {
  if (mem.busy || mem.loadingMore || mem.status !== 'ready') return;
  mem.loadingMore = true;
  renderMemories();
  try {
    const body = await requestWithRecovery(`/api/memories?limit=20&offset=${mem.items.length}`);
    if (!body || !Array.isArray(body.memories)) throw new RequestError('invalid_response', 0);
    mem.items.push(...body.memories);
    mem.total = body.total;
  } catch (error) {
    mem.note = errorText(error);
  } finally {
    mem.loadingMore = false;
    renderMemories();
  }
}
async function saveMemory(item) {
  if (mem.busy) return;
  const text = mem.editDraft.trim();
  if (!text || text.length > 100 || /[\u0000-\u001f]/.test(text)) {
    mem.note = '写 1–100 个字就好。';
    renderMemories();
    return;
  }
  mem.busy = true;
  mem.note = '';
  renderMemories();
  try {
    const body = await requestWithRecovery(`/api/memories/${encodeURIComponent(item.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, version: item.version }),
    });
    if (!body || typeof body.text !== 'string' || !Number.isInteger(body.version)) throw new RequestError('invalid_response', 0);
    Object.assign(item, body);
    mem.editing = null;
    mem.note = '已更新。';
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') {
      mem.note = '这条在别处改过了，列表已刷新，你的修改还在。';
      mem.busy = false;
      await loadMemories();
      return;
    }
    if (error.code === 'NOT_FOUND') {
      mem.editing = null;
      mem.note = '这条已经不在了。';
      mem.busy = false;
      await loadMemories();
      return;
    }
    mem.note = errorText(error);
  } finally {
    mem.busy = false;
    renderMemories();
  }
}
async function removeMemory(item) {
  if (mem.busy) return;
  mem.busy = true;
  mem.note = '';
  renderMemories();
  try {
    await requestWithRecovery(`/api/memories/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    mem.items = mem.items.filter(entry => entry.id !== item.id);
    mem.total = Math.max(0, mem.total - 1);
    mem.confirmDelete = null;
    mem.note = '已删除。之后问 AI，这条不会再出现。';
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      mem.items = mem.items.filter(entry => entry.id !== item.id);
      mem.total = Math.max(0, mem.total - 1);
      mem.confirmDelete = null;
      mem.note = '这条已经不在了。';
    } else mem.note = errorText(error);
  } finally {
    mem.busy = false;
    renderMemories();
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
const modelSettingsPath = '/api/model-settings';
const modelForm = document.getElementById('model-form');
const modelFields = document.getElementById('model-fields');
const modelEndpoint = document.getElementById('model-endpoint');
const modelKey = document.getElementById('model-key');
const modelName = document.getElementById('model-name');
const modelImage = document.getElementById('model-image');
const modelChoices = document.getElementById('model-choices');
const modelSelect = document.getElementById('model-select');
const modelReset = document.getElementById('model-reset');
const modelNotice = document.getElementById('model-notice');
let modelSettingsLoaded = false;
let modelSettingsBusy = false;

function renderModelSettings(settings) {
  const custom = settings.source === 'custom';
  modelEndpoint.value = settings.endpoint || '';
  modelKey.value = '';
  modelKey.placeholder = custom ? '留空以保留当前地址的密钥' : '';
  modelName.value = settings.model || '';
  modelImage.checked = settings.image_enabled === true;
  modelReset.hidden = !custom;
  document.getElementById('model-source').textContent = {
    custom: '正在使用自定义模型。',
    environment: '正在使用本地启动配置。',
    builtin: '尚未配置 AI 密钥，目前可用内置建议。',
  }[settings.source];
  modelSettingsLoaded = true;
}

async function updateModelSettings(method, path = modelSettingsPath, body) {
  if (modelSettingsBusy) return;
  const discovering = path.endsWith('/models');
  modelSettingsBusy = true;
  modelFields.disabled = true;
  modelNotice.textContent = discovering ? '正在获取模型列表…' : '正在处理…';
  try {
    const settings = await requestWithRecovery(path, {
      method,
      ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (discovering) {
      modelSelect.replaceChildren(new Option('选择模型', ''), ...settings.models.map(name => new Option(name, name)));
      modelSelect.value = settings.models.includes(modelName.value) ? modelName.value : '';
      modelChoices.hidden = settings.models.length === 0;
      modelNotice.textContent = settings.models.length ? '请选择模型，也可以手动输入。' : '服务没有返回模型，请手动输入模型名称。';
    } else {
      if (method === 'DELETE') modelChoices.hidden = true;
      renderModelSettings(settings);
      modelNotice.textContent = { GET: '', PUT: '已保存，下次请求将使用所选模型。', DELETE: '已移除自定义设置。' }[method];
    }
  } catch (error) {
    modelNotice.textContent = {
      INVALID_MODEL_SETTINGS: '请检查 API 地址、密钥或模型名称。地址需使用 HTTPS，本机模型可用 HTTP。',
      MODEL_KEY_REQUIRED: '请填写这个 API 地址的密钥。',
      MODEL_LIST_UNAVAILABLE: '获取模型列表失败。请检查地址和密钥，或手动输入模型名称。',
    }[error.code] || (discovering ? '暂时无法获取模型列表，请稍后重试。' : '暂时无法处理 AI 设置，请稍后重试。');
  } finally {
    modelSettingsBusy = false;
    modelFields.disabled = !modelSettingsLoaded;
  }
}

function modelCredentials() {
  return { endpoint: modelEndpoint.value.trim(), api_key: modelKey.value.trim() };
}

document.getElementById('model-discover').addEventListener('click', () => {
  if (!modelEndpoint.reportValidity()) return;
  modelChoices.hidden = true;
  updateModelSettings('POST', `${modelSettingsPath}/models`, modelCredentials());
});
modelForm.addEventListener('submit', event => {
  event.preventDefault();
  updateModelSettings('PUT', modelSettingsPath, {
    ...modelCredentials(), model: modelName.value.trim(), image_enabled: modelImage.checked,
  });
});
modelEndpoint.addEventListener('input', () => { modelChoices.hidden = true; });
modelSelect.addEventListener('change', () => { if (modelSelect.value) modelName.value = modelSelect.value; });
modelName.addEventListener('input', () => {
  modelSelect.value = modelName.value;
  if (modelSelect.selectedIndex < 0) modelSelect.value = '';
});
modelReset.addEventListener('click', () => updateModelSettings('DELETE'));

settingsToggle.addEventListener('click', () => {
  const expanded = settingsToggle.getAttribute('aria-expanded') === 'true';
  settingsToggle.setAttribute('aria-expanded', String(!expanded));
  const section = localSettings ? '设置' : '关于与数据';
  const label = expanded ? section : `收起${section}`;
  settingsToggle.textContent = label;
  settingsToggle.setAttribute('aria-label', `${label}，${localSettings ? 'AI 模型、' : ''}主题设置与记忆管理`);
  about.hidden = expanded;
  if (expanded) focus(settingsToggle);
  else {
    if (localSettings && !modelSettingsLoaded) updateModelSettings('GET');
    loadMemories();
  }
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
askButton.addEventListener('click', () => startInteraction());
(function init() {
  const now = new Date();
  document.getElementById('masthead-date').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
  guide.hidden = document.documentElement.dataset.guided === '1';
  if (localSettings) {
    document.getElementById('model-settings').hidden = false;
    document.getElementById('about-title').textContent = '设置';
    settingsToggle.textContent = '设置';
    settingsToggle.setAttribute('aria-label', '设置，AI 模型、主题设置与记忆管理');
  }
  applyTheme(document.documentElement.dataset.theme || 'system');
  syncSceneRow();
  renderEmpty();
  ensureSession().catch(() => {});
})();
