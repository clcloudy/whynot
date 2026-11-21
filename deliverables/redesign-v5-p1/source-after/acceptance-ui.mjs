const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

export default async function run(group = 'state') {
  const results = [];
  window.uiProgress = { group, results };
  const check = (name, condition, detail = '') => results.push({ name, passed: !!condition, detail });
  document.getElementById('b3-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'b3-frame';
  frame.title = 'B3 本地验收';
  frame.style.cssText = 'position:fixed;top:0;left:0;z-index:1000;width:390px;height:844px;border:0;display:block';
  const loaded = new Promise(resolve => frame.onload = resolve);
  frame.src = `${location.origin}/?b3=${Date.now()}`;
  document.body.append(frame);
  await loaded;
  frame.scrollIntoView({ block: 'start' });
  const w = frame.contentWindow, d = w.document;
  const state = () => w.eval('state');
  const native = w.fetch.bind(w);
  const errors = [];
  w.addEventListener('error', event => errors.push(event.message));
  w.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  const click = selector => { const node = d.querySelector(selector); node.focus(); node.click(); };
  // API contract fixtures must not accidentally enter the click-driven lane.
  const select = (name, value) => {
    d.querySelector(`input[name="${name}"][value="${value}"]`).checked = true;
    w.syncConditions();
  };
  const selectTheme = value => click(`input[name="theme"][value="${value}"]`);
  const lane = () => w.eval('formState');
  const visible = (node, win = w) => !!node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && win.getComputedStyle(node).visibility !== 'hidden';
  const waitFor = async (predicate, label, timeout = 35000) => {
    const end = performance.now() + timeout;
    while (!predicate()) {
      if (performance.now() >= end) throw new Error(`验收等待超时：${label}`);
      await pause(10);
    }
  };
  const stationInput = (index, doc = d) => {
    const field = doc.querySelectorAll('.field')[index];
    return field.querySelector('input:checked') || field.querySelector('input');
  };
  const enterLaneThroughUI = async ({ waitForTicket = true, budget = 'b10', energy = 'esteady', scene = 'snone' } = {}) => {
    if (lane().phase !== 'AT_FIELD_1' || d.getElementById('lane-form').hidden) w.resetForm(false);
    const picks = [budget, energy, scene];
    for (let index = 0; index < picks.length; index++) {
      const input = d.getElementById(picks[index]);
      input.focus();
      input.click();
      await waitFor(() => lane().step > index || lane().phase === 'READY' || state().busy, `填第${index + 1}格`, 2500);
    }
    if (waitForTicket) {
      await waitFor(() => lane().phase === 'READY', '三格齐了', 2500);
      d.getElementById('issue').click();
    } else {
      await waitFor(() => lane().phase === 'READY', '三格齐了', 2500);
      d.getElementById('issue').click();
    }
    await waitFor(() => state().busy || lane().phase === 'TICKET' || !!d.querySelector('.lane-banner'), '票面启动出票', 2500);
    if (waitForTicket) await waitFor(() => !state().busy && lane().phase !== 'ISSUING', '通道出票结束');
  };
  const checkCardSemantics = () => {
    check('整卡不是 live region', !d.getElementById('result').hasAttribute('aria-live'));
    check('卡片关联标题与第一步', d.querySelector('.card').getAttribute('aria-labelledby') === 'card-title' && d.querySelector('.card').getAttribute('aria-describedby') === 'card-first');
  };
  const feedback = kind => { d.querySelector(`[data-focus="${kind}"]`).focus(); return w.sendFeedback(kind); };
  const response = (code, status = 400) => w.Response.json({ error: code }, { status });
  const style = d.createElement('style');
  style.textContent = ':root { scrollbar-width: none; }';
  d.head.append(style);
  await w.ensureSession();
  check('首屏不抢焦点', d.activeElement === d.body);
  if (!['lane', 'ix'].includes(group)) {
    await w.ask();
    check('普通推荐生成后焦点到标题', d.activeElement.id === 'card-title');
    checkCardSemantics();
  }

  if (group === 'state') {
    let gate = deferred();
    w.fetch = async (url, init) => { const r = await native(url, init); if (String(url).endsWith('/feedback')) await gate.promise; return r; };
    const old = state().card.id;
    const first = feedback('like');
    check('反馈焦点保留', d.activeElement.dataset.focus === 'like');
    check('反馈在途仍可换卡', !d.querySelector('[data-focus="swap"]').disabled);
    await w.ask(w.conditions(), 'swap');
    const next = state().card.id;
    check('换卡后焦点在换一个', d.activeElement.dataset.focus === 'swap');
    check('换卡使新卡反馈立即可用', next !== old && !state().feedbackPending);
    const second = feedback('dislike');
    gate.resolve();
    await first;
    await second;
    check('旧反馈不能覆盖新卡', state().card.id === next && state().card.preference === 'dislike');

    const oldGate = deferred(), newGate = deferred();
    let count = 0;
    w.fetch = async (url, init) => { const r = await native(url, init); if (String(url).endsWith('/feedback')) await (++count === 1 ? oldGate : newGate).promise; return r; };
    const pendingOld = feedback('like');
    await w.ask(w.conditions(), 'swap');
    const pendingNew = feedback('like');
    oldGate.resolve(); await pendingOld;
    check('旧反馈 finally 不能解锁新反馈', state().feedbackPending && d.querySelector('[data-focus="like"]').getAttribute('aria-disabled') === 'true');
    newGate.resolve(); await pendingNew;
    w.fetch = async (url, init) => { if (String(url).endsWith('/feedback')) { await pause(5000); throw new TypeError('local offline'); } return native(url, init); };
    const failed = feedback('dislike');
    await w.ask(w.conditions(), 'swap');
    const latest = state().card.id;
    await failed;
    check('5秒旧反馈失败不回滚新卡', state().card.id === latest && !d.getElementById('feedback-status').textContent);

    gate = deferred();
    const seen = [];
    let laneRequests = 0;
    w.fetch = async (url, init) => {
      if (String(url).endsWith('/api/interactions')) laneRequests++;
      if (String(url).endsWith('/api/recommendations')) { seen.push(JSON.parse(init.body)); await gate.promise; }
      return native(url, init);
    };
    select('budget', '10');
    state().sessionReady = false;
    const pending = w.ask();
    select('budget', '3');
    const lockedEpoch = lane().epoch;
    d.getElementById('b15').click();
    d.getElementById('sdesk').click();
    check('在途DOM点击不改条件或重入通道', state().busy && lane().phase === 'ISSUING' && lane().epoch === lockedEpoch && w.conditions().budget === 3 && laneRequests === 0);
    gate.resolve(); await pending;
    check('会话等待前快照条件', seen.length === 1 && seen[0].budget === 10 && state().conditions.budget === 10);
    check('程序注入条件不自动提交', seen.length === 1 && laneRequests === 0);
    check('旧条件标注与新条件按钮', d.querySelector('.condition-note').textContent === '按 10 分钟生成' && d.querySelector('[data-focus="swap"]').textContent === '按新条件再来一条');
    await w.ask(w.conditions(), 'swap');
    check('新条件生成不超3分钟', state().conditions.budget === 3 && state().card.minutes <= 3 && d.querySelector('.condition-note').hidden);

    let requests = 0;
    w.fetch = async (url, init) => { if (String(url).endsWith('/api/recommendations')) { requests++; throw new TypeError('local offline'); } return native(url, init); };
    const retained = state().card.id;
    select('budget', '10');
    await w.ask();
    select('budget', '3');
    const recovered = [];
    w.fetch = async (url, init) => { if (String(url).endsWith('/api/recommendations')) recovered.push(JSON.parse(init.body)); return native(url, init); };
    check('失败保留旧卡与当前条件', state().card.id === retained && w.conditions().budget === 3 && d.querySelector('.notice') && d.querySelectorAll('.card').length === 1);
    check('网络错误不自动重试', requests === 1);
    click('.notice .retry');
    while (state().busy) await pause(10);
    check('重试仍使用失败请求快照', recovered.length === 1 && recovered[0].budget === 10 && state().card.minutes <= 10 && w.conditions().budget === 3);

    w.fetch = native;
    await w.ask();
    let feedbackCalls = 0;
    w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) { feedbackCalls++; return native(String(url).replace(state().card.id, 'invalid-id'), init); } return native(url, init); };
    await feedback('like');
    check('无效编号实际API返回404，仅留换一个', feedbackCalls === 1 && !d.querySelector('.card') && d.querySelector('.notice .retry').textContent === '换一个' && d.querySelector('.notice-title').textContent.includes('这条建议找不到了'));

    w.fetch = native; await w.ask();
    let replay = 0, sessions = 0;
    w.fetch = (url, init) => {
      if (String(url).endsWith('/api/session')) sessions++;
      if (String(url).endsWith('/feedback') && ++replay === 1) return Promise.resolve(response('SESSION_REQUIRED', 401));
      return native(url, init);
    };
    await feedback('like');
    check('反馈401重建会话并重放一次', replay === 2 && sessions === 1 && state().card.preference === 'like');
    replay = 0; sessions = 0;
    w.fetch = (url, init) => {
      if (String(url).endsWith('/api/session')) sessions++;
      if (String(url).endsWith('/feedback')) { replay++; return Promise.resolve(response('SESSION_REQUIRED', 401)); }
      return native(url, init);
    };
    await feedback('dislike');
    check('重复401恢复有上限且回滚', replay === 2 && sessions === 1 && state().card.preference === 'like' && d.getElementById('feedback-status').textContent.includes('会话过期'));

    {
      const times = [];
      w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) { times.push(performance.now()); return Promise.resolve(response('STORAGE_UNAVAILABLE', 503)); } return native(url, init); };
      await feedback('dislike');
      check('503只重试一次且退避800ms', times.length === 2 && times[1] - times[0] >= 790 && d.getElementById('feedback-status').textContent.includes('现在有点忙'));
    }
    {
      let calls = 0;
      w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) { calls++; return Promise.resolve(response('VERSION_CONFLICT', 409)); } return native(url, init); };
      await feedback('dislike');
      check('409保留服务端错误码不自动重试', calls === 1 && d.getElementById('feedback-status').textContent.includes('别处更新'));
    }
    let invalid = 0;
    w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) { invalid++; return Promise.resolve(response('INVALID_FEEDBACK')); } return native(url, init); };
    await feedback('dislike'); await feedback('dislike'); await feedback('dislike');
    check('非法反馈只允许一次手动再试', invalid === 2 && !d.getElementById('feedback-status').textContent);

    w.fetch = native; await w.ask();
    w.fetch = async (url, init) => {
      const r = await native(url, init);
      if (!String(url).endsWith('/feedback')) return r;
      const body = await r.json(); body.completed = true;
      return w.Response.json(body);
    };
    await feedback('like');
    check('服务端权威完成态覆盖乐观状态', state().card.completed && !!d.querySelector('.done-row') && !d.querySelector('.feedback'));

    for (const code of ['INVALID_CONTEXT', 'JSON_REQUIRED', 'INVALID_BODY']) {
      let calls = 0;
      w.fetch = async (url, init) => { if (String(url).endsWith('/api/recommendations')) { calls++; return response(code); } return native(url, init); };
      await w.ask();
      check(`${code}不重试`, calls === 1 && !d.querySelector('.notice .retry') && d.querySelector('.notice-title').textContent.includes('刷新页面'));
    }
    w.fetch = async (url, init) => String(url).endsWith('/api/recommendations') ? new w.Response('{bad') : native(url, init);
    await w.ask();
    check('无效响应可手动重试', d.querySelector('.notice-title').textContent.includes('不完整') && !!d.querySelector('.notice .retry'));
    w.fetch = async (url, init) => { const r = await native(url, init); if (!String(url).endsWith('/api/recommendations')) return r; const body = await r.json(); body.category = 'toString'; return w.Response.json(body); };
    await w.ask();
    check('未知category安全降级', state().card.category === null && !d.querySelector('.cat'));
    w.fetch = native;
  }

  if (group === 'timing') {
    const nativeTimeout = w.AbortSignal.timeout;
    let timeoutMs = 0;
    w.AbortSignal.timeout = ms => { timeoutMs = ms; return nativeTimeout.call(w.AbortSignal, ms); };
    w.fetch = (url, init) => String(url).endsWith('/api/recommendations')
      ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) : native(url, init);
    const retained = state().card.id;
    const pending = w.ask();
    const lockedConditions = JSON.stringify(w.conditions());
    d.getElementById('b3').click();
    check('生成中aria-busy及ISSUING锁定通道', d.getElementById('result').getAttribute('aria-busy') === 'true' && d.documentElement.dataset.laneState === 'ISSUING' && lane().phase === 'ISSUING' && JSON.stringify(w.conditions()) === lockedConditions);
    await pause(8100);
    check('8秒只更新视觉文案', d.querySelector('.sk-text').textContent === '还在找，再等一下' && d.getElementById('status').textContent === '正在找建议');
    await pending;
    check('真实25秒超时文案且保留旧卡', timeoutMs === 25000 && d.querySelector('.notice-title').textContent.includes('等太久了') && state().card.id === retained);
    check('结束清理加载状态并回第三格重试', d.getElementById('result').getAttribute('aria-busy') === 'false' && !state().busy && lane().phase === 'AT_FIELD_3' && d.documentElement.dataset.laneState === 'AT_FIELD_3' && !d.querySelector('.skeleton') && visible(d.querySelector('.notice.lane-banner')));
    w.AbortSignal.timeout = nativeTimeout;
    w.fetch = native;
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => false });
    await w.ask();
    check('离线保留卡片并禁用换一个', !!d.querySelector('.card') && d.querySelector('[data-focus="swap"]').disabled && d.querySelector('.notice-title').getAttribute('role') === 'status');
    let sent = 0;
    w.fetch = (url, init) => { sent++; return native(url, init); };
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => true });
    w.dispatchEvent(new w.Event('online'));
    check('网络恢复就地提示，不自动提交', sent === 0 && d.querySelector('.notice-title').textContent.includes('网络回来了') && !d.querySelector('.notice .retry').disabled);
    click('.notice .retry'); while (state().busy) await pause(10);
    check('恢复后手动重试成功且只有一张卡', !d.querySelector('.notice') && d.querySelectorAll('.card').length === 1);
    delete w.navigator.onLine;
  }

  if (group === 'layout') {
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
      frame.style.width = `${width}px`; frame.style.height = `${height}px`;
      await pause(50);
      const sizes = [...d.querySelectorAll('.card-actions button')].map(e => e.getBoundingClientRect());
      const card = d.querySelector('.card').getBoundingClientRect();
      check(`${width}px无横向滚动`, d.documentElement.scrollWidth === d.documentElement.clientWidth);
      check(`${width}px四键一行且均≥44`, sizes.every(r => r.width >= 43.99 && r.height >= 43.99 && r.top === sizes[0].top), JSON.stringify(sizes.map(r => [r.width, r.height])));
      check(`${width}px四键等宽`, Math.max(...sizes.map(r => r.width)) - Math.min(...sizes.map(r => r.width)) < 1);
      if (width === 390) check('390px卡宽350', card.width === 350);
      if (width === 768) check('768px单列且票宽460', w.getComputedStyle(d.querySelector('.board')).gridTemplateColumns.split(' ').length === 1 && Math.round(d.querySelector('.ticket-col').getBoundingClientRect().width) === 460 && d.querySelector('.page').getBoundingClientRect().width === 768);
    }
    frame.style.width = '320px'; frame.style.height = '568px';
    d.documentElement.style.fontSize = '32px';
    await pause(50);
    const keys = [...d.querySelectorAll('.card-actions button')].map(e => e.getBoundingClientRect());
    check('200%无横向滚动', d.documentElement.scrollWidth === d.documentElement.clientWidth);
    check('200%四键2×2且≥44', keys[0].top === keys[1].top && keys[2].top === keys[3].top && keys[2].top > keys[0].top && keys.every(r => r.height >= 44 && r.width >= 44));
    check('200%第一步与耗时不裁切', d.querySelector('.first-text').scrollHeight <= d.querySelector('.first-text').clientHeight && d.querySelector('.gauge-label').scrollHeight <= d.querySelector('.gauge-label').clientHeight);
    w.resetForm(false);
    await pause(50);
    const options = [...d.querySelectorAll('.field[data-step="0"] input')].map(input => input.labels[0]);
    const segments = options.map(node => node.getBoundingClientRect());
    check('200%首格四选项可见且热区≥44不重叠', options.length === 4 && options.every(node => visible(node)) && segments.every((r, i) => r.width >= 44 && r.height >= 44 && segments.slice(i + 1).every(s => r.right <= s.left || s.right <= r.left || r.bottom <= s.top || s.bottom <= r.top)));
    check('200%首格选项完整且无横向滚动', d.documentElement.scrollWidth === d.documentElement.clientWidth && options.every(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight));
  }
  if (group === 'polish') {
    const root = d.documentElement, css = node => node.ownerDocument.defaultView.getComputedStyle(node);
    const html = await (await native('/')).text();
    const beforeApp = html.replace('<script src="/app.js"></script>', '');
    const guideValue = w.localStorage.getItem('whynot-guide'), themeValue = w.localStorage.getItem('whynot-theme');
    const probe = d.createElement('iframe');
    probe.hidden = true; d.body.append(probe);
    const load = async source => {
      const loaded = new Promise(resolve => { probe.onload = resolve; });
      probe.srcdoc = source; await loaded; return probe.contentWindow;
    };
    w.localStorage.removeItem('whynot-guide'); w.localStorage.setItem('whynot-theme', 'dark');
    let p = await load(beforeApp);
    check('首访三行引导在外部脚本前可见且措辞准确', [...p.document.querySelectorAll('.guide p')].map(n => n.textContent).join('/') === '一次只问一件事/答完一格，收成一行/三格齐了，出一张现在' && p.getComputedStyle(p.document.getElementById('guide')).display !== 'none');
    check('首帧显式深色与页外文字同步', p.document.documentElement.dataset.theme === 'dark' && p.getComputedStyle(p.document.querySelector('.guide p')).color === 'rgba(246, 242, 232, 0.66)' && !p.document.querySelector('script[src="/app.js"]') && typeof p.ask !== 'function');
    p = await load(html); await p.ensureSession();
    const pFetch = p.fetch.bind(p);
    p.fetch = (url, init) => String(url).endsWith('/api/recommendations') ? Promise.reject(new TypeError('test offline')) : pFetch(url, init);
    await p.ask();
    check('首次出票失败不收起引导也不写seen', !p.document.getElementById('guide').hidden && p.localStorage.getItem('whynot-guide') === null);
    p.fetch = pFetch;
    const pending = p.ask();
    const pConditions = JSON.stringify(p.conditions());
    p.document.getElementById('b3').click();
    check('生成中结果播报忙碌且通道条件锁定', p.document.getElementById('result').getAttribute('aria-busy') === 'true' && p.document.documentElement.dataset.laneState === 'ISSUING' && !!p.document.getElementById('status').textContent && JSON.stringify(p.conditions()) === pConditions);
    await pending;
    check('首次成功收起引导并写seen且通道让位票卡', p.document.getElementById('guide').hidden && p.localStorage.getItem('whynot-guide') === 'seen' && p.document.getElementById('lane-form').hidden && p.document.querySelectorAll('.ticket-context > button.context-key').length === 3);
    p = await load(beforeApp);
    check('回访外部脚本前引导已隐藏且主题不闪回', p.getComputedStyle(p.document.getElementById('guide')).display === 'none' && p.getComputedStyle(p.document.body).backgroundColor === 'rgb(16, 24, 39)');
    w.localStorage.removeItem('whynot-guide');
    p = await load(html); await p.ensureSession();
    p.Storage.prototype.setItem = () => { throw new p.DOMException('test', 'QuotaExceededError'); };
    await p.ask();
    check('存储写拒绝仍出票并在本页收起引导', !!p.document.querySelector('.card') && p.document.getElementById('guide').hidden && p.localStorage.getItem('whynot-guide') === null);
    p = await load(beforeApp);
    check('写拒绝后刷新无法持久记住但仍可见引导', p.getComputedStyle(p.document.getElementById('guide')).display !== 'none');
    p = await load(html.replace('<head>', '<head><script>Object.defineProperty(window,"localStorage",{get(){throw new DOMException("test","SecurityError")}})</script>'));
    await p.ensureSession(); await p.ask();
    check('存储读拒绝保持系统主题并能出票收起引导', !p.document.documentElement.hasAttribute('data-theme') && !!p.document.querySelector('.card') && p.document.getElementById('guide').hidden);
    for (const [key, value] of [['whynot-guide', guideValue], ['whynot-theme', themeValue]]) {
      if (value === null) w.localStorage.removeItem(key); else w.localStorage.setItem(key, value);
    }
    const settings = d.getElementById('settings-toggle');
    check('关于入口可见文案包含于名称', settings.textContent === '关于与数据' && settings.getAttribute('aria-label').includes(settings.textContent));
    click('#settings-toggle');
    check('展开关于与数据保留主题与服务端数据说明', settings.textContent === '收起关于与数据' && settings.getAttribute('aria-label').includes(settings.textContent) && !d.getElementById('about').hidden && d.getElementById('about-title').textContent === '关于与数据' && d.querySelectorAll('input[name="theme"]').length === 3 && d.getElementById('about').textContent.includes('清除浏览器数据不会删除服务端记录'));
    click('#settings-toggle');
    check('关闭关于焦点回入口且名称恢复', d.getElementById('about').hidden && d.activeElement === settings && settings.textContent === '关于与数据');
    const date = new w.Date();
    check('页眉显示本地日期且票面回站名称含可见文案', d.getElementById('masthead-date').textContent === `${date.getMonth() + 1}月${date.getDate()}日` && [...d.querySelectorAll('.ticket-context > button.context-key')].length === 3 && [...d.querySelectorAll('.ticket-context > button.context-key')].every(node => (node.getAttribute('aria-label') || node.textContent).includes(node.textContent.trim())));
    click('#settings-toggle');
    for (let i = 0; i < 800 && w.eval('mem.status') === 'loading'; i++) await pause(10);
    check('关于记忆加载完成后再测主题请求隔离', w.eval('mem.status') !== 'loading');
    d.getElementById('feedback-status').textContent = '记为喜欢，可以改。';
    const rgb = color => color.match(/[\d.]+/g).map(Number);
    const luminance = color => rgb(color).slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
    const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const background = node => {
      while (node) { const color = css(node).backgroundColor, values = rgb(color); if (values.length === 3 || values[3] === 1) return color; node = node.parentElement; }
      return 'rgb(255,255,255)';
    };
    // Keep a pristine lane beside the ticket fixture; do not force hidden cards visible.
    p = await load(html); await p.ensureSession();
    probe.hidden = false;
    probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:390px;height:844px;border:0';
    p.resetForm(false);
    const laneDoc = p.document, laneFetch = p.fetch.bind(p);
    const rules = [...d.styleSheets, ...laneDoc.styleSheets].flatMap(sheet => [...sheet.cssRules]);
    const media = rules.filter(rule => rule.media?.mediaText.includes('prefers-color-scheme'));
    const savedMedia = media.map(rule => rule.media.mediaText);
    const option = stationInput(0, laneDoc).labels[0], cardId = state().card.id;
    let themeRequests = 0;
    w.fetch = (url, init) => { themeRequests++; return native(url, init); };
    p.fetch = (url, init) => { themeRequests++; return laneFetch(url, init); };
    const textSelectors = ['.masthead .brand-name', '.masthead-date', '.guide p', '.foot', '.settings', '.about h2', '.about p', '.about legend', '.share-note', '.card h2', '.first-label', '.first-text', '.detail', '.cat', '.gauge-label', '.feedback button', '.swap', '.ticket-context .context-key'];
    const laneSelectors = ['.f-q', '.field.is-active .opts label', '.progress span', '.progress b'];
    for (const dark of [false, true]) {
      media.forEach(rule => { rule.media.mediaText = dark ? 'all' : 'not all'; });
      for (const theme of ['system', 'light', 'dark']) {
        w.applyTheme(theme); p.applyTheme(theme); await pause(200);
        const key = `系统${dark ? '深' : '浅'}/${theme}`;
        const contrasts = textSelectors.flatMap(selector => [...d.querySelectorAll(selector)].map(node => ({ selector, ratio: contrast(css(node).color, background(node)) })));
        contrasts.push(...laneSelectors.flatMap(selector => [...laneDoc.querySelectorAll(selector)].filter(node => visible(node, p)).map(node => ({ selector, ratio: contrast(css(node).color, background(node)) }))));
        check(`${key}页外与票面普通文字对比度≥4.5`, contrasts.every(x => x.ratio >= 4.5), JSON.stringify(contrasts));
        const shadows = [d.querySelector('.card')].filter(node => visible(node) && css(node).boxShadow !== 'none');
        check(`${key}结果票保留纸张投影`, shadows.length === 1 && shadows[0].classList.contains('card') && css(shadows[0]).boxShadow.includes('26px'));
        const laneShadows = [...laneDoc.querySelectorAll('#lane-form, #lane-form *, .progress, .progress *')].filter(node => visible(node, p) && css(node).boxShadow !== 'none').map(node => css(node).boxShadow);
        check(`${key}通道纸面不叠加硬投影`, laneShadows.every(shadow => shadow.includes('inset') || /0px -?1px/.test(shadow)) && css(laneDoc.querySelector('.sheet')).filter.includes('drop-shadow'));
        check(`${key}首格选项文字对纸面≥4.5`, css(option).color === 'rgb(27, 35, 52)' && contrast(css(option).color, background(option)) >= 4.5);
        check(`${key}主题与换票保持中性色`, [...d.querySelectorAll('input[name="theme"]:checked + label')].every(n => css(n).backgroundColor !== css(option).backgroundColor) && css(d.querySelector('.swap')).color === 'rgb(27, 35, 52)');
        stationInput(0, laneDoc).focus({ preventScroll: true });
        check(`${key}首站单选焦点对表面≥3`, css(option).outlineStyle === 'solid' && contrast(css(option).outlineColor, background(option)) >= 3);
        for (const node of [settings, d.querySelector('.card h2')]) {
          node.focus({ preventScroll: true });
          check(`${key}/${node === settings ? '页脚' : '票面'}焦点对表面≥3`, css(node).outlineStyle === 'solid' && contrast(css(node).outlineColor, background(node)) >= 3);
        }
        d.getElementById('theme-system').focus({ preventScroll: true });
        const themeLabel = d.querySelector('label[for="theme-system"]');
        check(`${key}主题单选外圈对面板≥3`, css(themeLabel).outlineStyle === 'solid' && contrast(css(themeLabel).outlineColor, css(d.getElementById('about')).backgroundColor) >= 3);
      }
    }
    media.forEach((rule, i) => { rule.media.mediaText = savedMedia[i]; });
    check('切换主题不改票据或提交请求', state().card.id === cardId && !state().busy && themeRequests === 0);
    w.fetch = native;
    const boxes = () => [...d.querySelectorAll('.masthead,.card,.card *,.foot,.about,.about *'), ...laneDoc.querySelectorAll('#lane-form,.field.is-active,.field.is-active *,.progress,.progress *')].map(node => { const r = node.getBoundingClientRect(), win = node.ownerDocument.defaultView; return [r.left + win.scrollX, r.top + win.scrollY, r.width, r.height]; });
    for (const [width, font] of [[320, 16], [390, 16], [768, 16], [320, 32]]) {
      frame.style.width = probe.style.width = `${width}px`; root.style.fontSize = laneDoc.documentElement.style.fontSize = `${font}px`;
      w.applyTheme('light'); p.applyTheme('light'); await pause(200); const light = boxes();
      w.applyTheme('dark'); p.applyTheme('dark'); await pause(200); const dark = boxes();
      check(`${width}px/${font / 16 * 100}%双主题结构矩形完全一致`, light.length === dark.length && light.every((r, i) => r.every((v, j) => Math.abs(v - dark[i][j]) < .01)));
      check(`${width}px/${font / 16 * 100}%关于入口与主题热区≥44无横滚`, root.scrollWidth === root.clientWidth && [settings, ...d.querySelectorAll('label[for^="theme-"]')].every(n => { const r = n.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }));
    }
    const minutes = state().card.minutes;
    for (const value of [3, 5, 10, 15]) {
      state().card.minutes = value; w.renderCard();
      const dot = d.querySelector('.g-dot').getBoundingClientRect(), ring = d.querySelector('.g-ring').getBoundingClientRect(), line = d.querySelector('.g-line').getBoundingClientRect(), label = d.querySelector('.gauge-label');
      check(`320px/200%/${value}分钟保留两端点和完整时长`, dot.width === 12 && ring.width === 14 && line.width >= 24 && label.scrollWidth <= label.clientWidth && root.scrollWidth === root.clientWidth && dot.top > label.getBoundingClientRect().top);
    }
    state().card.minutes = minutes; w.renderCard();
    probe.remove();
    frame.style.width = '390px'; root.style.fontSize = '16px';
    d.getElementById('feedback-status').textContent = '';
    click('#settings-toggle');
    w.applyTheme(themeValue === 'light' || themeValue === 'dark' ? themeValue : 'system');
  }
  if (group === 'legends') {
    const css = node => w.getComputedStyle(node);
    const visibleMarks = () => [...d.querySelectorAll('.preference-mark svg')].filter(node => node.getBoundingClientRect().width > 0);
    const geometry = () => ['.card', '.ticket-body', '.ticket-stub', '.card-actions'].map(selector => {
      const r = d.querySelector(selector).getBoundingClientRect();
      return [r.top + w.scrollY, r.left + w.scrollX, r.width, r.height];
    });
    const sameGeometry = (a, b) => a.every((r, i) => r.every((v, j) => Math.abs(v - b[i][j]) < 1));
    const originals = new Map();
    frame.style.width = '320px';
    for (const [category, label, name] of [['rest', '歇', '休息'], ['observe', '看', '观察'], ['listen', '听', '聆听'], ['tidy', '归', '整理'], ['explore', '探', '探索']]) {
      w.fetch = async (url, init) => {
        const r = await native(url, init);
        if (!String(url).endsWith('/api/recommendations')) return r;
        return w.Response.json({ ...await r.json(), category });
      };
      await w.ask();
      const icon = d.querySelector('.category-icon'), rect = icon.getBoundingClientRect();
      originals.set(category, icon.innerHTML);
      check(`${category}图例16px且位于票头编号旁`, rect.width === 16 && rect.height === 16 && icon.parentElement.className === 'ticket-head' && icon.nextElementSibling.className === 'ticket-code' && icon.getAttribute('viewBox') === '0 0 20 20');
      check(`${category}装饰隐藏且类别文字保留`, icon.getAttribute('aria-hidden') === 'true' && icon.getAttribute('focusable') === 'false' && d.querySelector('.cat').textContent === label && d.querySelector('.cat').getAttribute('aria-label') === `类别：${name}`);
      for (const theme of ['light', 'dark']) {
        w.applyTheme(theme);
        check(`${category}/${theme}静态中性色且320px无横向滚动`, css(icon).animationName === 'none' && css(icon).color === css(d.querySelector('.cat')).color && d.documentElement.scrollWidth === d.documentElement.clientWidth);
      }
    }
    check('五类几何不同且均不依赖外部图像', new Set(originals.values()).size === 5 && [...d.querySelectorAll('.category-icon use, .category-icon image')].length === 0);
    for (const category of [undefined, null, 'toString', '<svg onload=alert(1)>', ['rest'], {}]) {
      let id;
      w.fetch = async (url, init) => {
        const r = await native(url, init);
        if (!String(url).endsWith('/api/recommendations')) return r;
        const body = await r.json(); id = body.id;
        if (category === undefined) delete body.category; else body.category = category;
        return w.Response.json(body);
      };
      await w.ask();
      check(`异常类别${JSON.stringify(category) ?? '缺失'}仅隐藏图例`, state().card.id === id && state().card.category === null && !d.querySelector('.category-icon, .cat') && !!d.querySelector('#card-first') && d.querySelectorAll('.card-actions button').length === 4);
    }
    w.fetch = native;
    await w.ask();
    check('未反馈时预留标记位但没有图形', d.querySelectorAll('.preference-mark').length === 2 && !d.querySelector('.preference-mark svg'));
    await pause(280);
    const gate = deferred();
    let requests = 0;
    w.fetch = async (url, init) => {
      if (!String(url).endsWith('/feedback')) return native(url, init);
      requests++;
      const r = await native(url, init); await gate.promise; return r;
    };
    d.querySelector('[data-focus="like"]').focus({ preventScroll: true });
    const feedbackCardId = state().card.id;
    const before = geometry(), pending = w.sendFeedback('like');
    const heart = visibleMarks()[0];
    check('乐观喜欢显示单枚12px心形且120ms一次淡入', visibleMarks().length === 1 && heart.getBoundingClientRect().width === 12 && css(heart).animationName === 'feedbackIn' && css(heart).animationDuration === '0.12s' && css(heart).animationIterationCount === '1');
    check('反馈不重播整卡且布局不位移', css(d.querySelector('.card')).animationName === 'none' && sameGeometry(before, geometry()));
    await w.sendFeedback('like'); await w.sendFeedback('dislike');
    check('反馈在途防连点且焦点保留', requests === 1 && state().card.preference === 'like' && d.activeElement.dataset.focus === 'like' && d.querySelector('[data-focus="like"]').getAttribute('aria-disabled') === 'true');
    gate.resolve(); await pending;
    await w.sendFeedback('like');
    check('确认不重建标记且同选项不重发', heart === visibleMarks()[0] && requests === 1 && d.querySelector('[data-focus="like"]').getAttribute('aria-disabled') === 'false');
    await pause(160);
    d.documentElement.style.fontSize = '32px';
    check('完成淡入后切换窄版不重播隐藏副本', visibleMarks().length === 1 && css(visibleMarks()[0]).animationName === 'none');
    d.documentElement.style.fontSize = '16px';
    check('切回副券仍不重播且动画类已清理', visibleMarks().length === 1 && !d.querySelector('.preference-mark .feedback-in'));
    w.fetch = native;
    await feedback('dislike');
    const fold = visibleMarks()[0].innerHTML;
    check('可改选折角且两按钮pressed互斥', fold !== heart.innerHTML && d.querySelector('[data-focus="like"]').getAttribute('aria-pressed') === 'false' && d.querySelector('[data-focus="dislike"]').getAttribute('aria-pressed') === 'true' && d.getElementById('feedback-status').textContent.includes('可以改'));
    await feedback('like');
    check('可再次改回心形且反馈归属不变', visibleMarks()[0].innerHTML === heart.innerHTML && state().card.preference === 'like' && state().card.id === feedbackCardId);
    w.fetch = (url, init) => String(url).endsWith('/feedback') ? Promise.resolve(response('test_failure', 500)) : native(url, init);
    await feedback('dislike');
    check('失败还原心形pressed及焦点且不重播动画', state().card.preference === 'like' && visibleMarks()[0].innerHTML === heart.innerHTML && css(visibleMarks()[0]).animationName === 'none' && d.querySelector('[data-focus="like"]').getAttribute('aria-pressed') === 'true' && d.activeElement.dataset.focus === 'dislike' && !!d.getElementById('feedback-status').textContent);
    w.fetch = native;
    for (const [width, font] of [[320, 16], [390, 16], [768, 16], [320, 32]]) {
      frame.style.width = `${width}px`; d.documentElement.style.fontSize = `${font}px`;
      await pause(50);
      const key = `${width}px/${font / 16 * 100}%`, marks = visibleMarks();
      const keys = [...d.querySelectorAll('.card-actions button')].map(node => node.getBoundingClientRect());
      check(`${key}只显示一个标记且热区≥44无横滚`, marks.length === 1 && keys.every(r => r.width >= 44 && r.height >= 44) && d.documentElement.scrollWidth === d.documentElement.clientWidth);
      const a = marks[0].getBoundingClientRect(), b = d.querySelector('.card').getBoundingClientRect();
      check(`${key}标记在票内且不覆盖正文`, a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom && ![...d.querySelectorAll('#card-title, .first, .detail')].some(node => { const r = node.getBoundingClientRect(); return a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top; }));
      const kind = state().card.preference === 'like' ? 'dislike' : 'like';
      d.querySelector(`[data-focus="${kind}"]`).focus({ preventScroll: true });
      const beforeChange = geometry(), beforeScroll = [w.scrollX, w.scrollY];
      await w.sendFeedback(kind);
      const afterChange = geometry();
      check(`${key}改选图形不引发布局位移`, sameGeometry(beforeChange, afterChange), JSON.stringify({ beforeChange, afterChange, beforeScroll, afterScroll: [w.scrollX, w.scrollY] }));
    }
    frame.style.width = '390px'; d.documentElement.style.fontSize = '16px';
    for (const theme of ['light', 'dark']) {
      w.applyTheme(theme); d.querySelector('.card').style.filter = 'grayscale(1)';
      await pause(200);
      const selected = d.querySelector('.feedback [aria-pressed="true"]'), other = d.querySelector('.feedback [aria-pressed="false"]');
      check(`${theme}灰度仍有填充边框字重与形状区分`, css(selected).backgroundColor !== css(other).backgroundColor && css(selected).borderColor !== css(other).borderColor && css(selected).fontWeight === '600' && css(visibleMarks()[0].parentElement).color === 'rgb(27, 35, 52)');
      d.querySelector('.card').style.removeProperty('filter');
    }
    const media = [...d.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.media?.mediaText.includes('prefers-reduced-motion'));
    const saved = media.map(rule => rule.media.mediaText);
    media.forEach(rule => { rule.media.mediaText = 'all'; });
    await feedback(state().card.preference === 'like' ? 'dislike' : 'like');
    check('模拟减少动态显示静态标记', css(visibleMarks()[0]).animationName === 'none' && css(visibleMarks()[0]).opacity === '1');
    media.forEach((rule, i) => { rule.media.mediaText = saved[i]; });
    const oldGate = deferred();
    w.fetch = async (url, init) => { if (String(url).endsWith('/feedback')) { await oldGate.promise; return response('test_failure', 500); } return native(url, init); };
    const stale = feedback(state().card.preference === 'like' ? 'dislike' : 'like');
    await w.ask(w.conditions(), 'swap');
    const nextId = state().card.id;
    oldGate.resolve(); await stale;
    check('旧反馈失败不会把标记带到新票', state().card.id === nextId && state().card.preference === null && !d.querySelector('.preference-mark svg') && !d.getElementById('feedback-status').textContent);
    w.fetch = native;
    await feedback('like'); await feedback('completed');
    check('完成仪式保留已确认偏好且无反馈按钮', state().card.preference === 'like' && visibleMarks().length === 1 && !!d.querySelector('.ticket-stamp') && !d.querySelector('.feedback'));
    const markRect = visibleMarks()[0].getBoundingClientRect(), stampRect = d.querySelector('.ticket-stamp').getBoundingClientRect();
    check('完成后偏好标记与印章不重叠', markRect.right <= stampRect.left || markRect.left >= stampRect.right || markRect.bottom <= stampRect.top || markRect.top >= stampRect.bottom);
  }
  if (group === 'completion') {
    const css = node => w.getComputedStyle(node);
    const geometry = () => ['.card', '.ticket-body', '.foot'].map(selector => {
      const r = d.querySelector(selector).getBoundingClientRect();
      return [r.top, r.left, r.width, r.height];
    });
    const sameGeometry = (a, b) => a.every((r, i) => r.every((value, j) => Math.abs(value - b[i][j]) < 1));
    let feedbackCalls = 0, shares = 0;
    const failedGate = deferred();
    Object.defineProperty(w.navigator, 'share', { configurable: true, value: async () => { shares++; } });
    w.fetch = async (url, init) => {
      if (!String(url).endsWith('/feedback')) return native(url, init);
      feedbackCalls++; await failedGate.promise;
      return response('request_failed', 500);
    };
    const failed = feedback('completed');
    await w.sendFeedback('completed'); await w.shareCard();
    check('完成在途双击只发一次且禁止分享', feedbackCalls === 1 && shares === 0 && state().feedbackPending && d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'true');
    check('乐观完成同步印章打孔编号与刻度', !!d.querySelector('.ticket-stamp') && css(d.querySelector('.card')).maskImage.includes('5px') && css(d.querySelector('.ticket-head .ticket-code')).color === css(d.querySelector('.ticket-stamp')).color && css(d.querySelector('.g-line line')).strokeDasharray === 'none');
    check('完成状态不可点且保留焦点', d.activeElement.classList.contains('done-state') && d.activeElement.tagName === 'SPAN' && d.activeElement.getAttribute('aria-label') === '已完成，不可撤销');
    check('印章出现时通道隐藏且票卡仍可见', d.getElementById('lane-form').hidden && visible(d.querySelector('.card')) && lane().phase === 'TICKET');
    failedGate.resolve(); await failed;
    check('完成失败完整回滚且完成操作恢复', !state().card.completed && !d.querySelector('.ticket-stamp, .done-row') && css(d.querySelector('.card')).maskImage === 'none' && css(d.querySelector('.g-line line')).strokeDasharray !== 'none' && visible(d.querySelector('[data-focus="completed"]')) && d.getElementById('lane-form').hidden && d.activeElement.dataset.focus === 'completed' && !!d.getElementById('feedback-status').textContent);

    w.fetch = native;
    for (const [width, fontSize] of [[320, 16], [390, 16], [768, 16], [320, 32]]) {
      frame.style.width = `${width}px`;
      d.documentElement.style.fontSize = `${fontSize}px`;
      await w.ask(); await pause(300);
      const label = `${width}px/${fontSize === 32 ? '200%' : '100%'}`;
      d.querySelector('[data-focus="completed"]').focus({ preventScroll: true });
      const before = geometry();
      const gate = deferred();
      w.fetch = async (url, init) => {
        const r = await native(url, init);
        if (String(url).endsWith('/feedback')) await gate.promise;
        return r;
      };
      const completion = w.sendFeedback('completed');
      const stamp = d.querySelector('.ticket-stamp');
      const animation = stamp.getAnimations()[0];
      check(`${label}只播放300ms印章不重播整卡入场`, css(stamp).animationDuration === '0.3s' && css(d.querySelector('.card')).animationName === 'none');
      let stable = true;
      for (const time of [0, 100, 200, 300]) {
        if (animation) { animation.pause(); animation.currentTime = time; }
        stable &&= sameGeometry(before, geometry());
      }
      check(`${label}盖章前后及300ms内布局不位移`, stable, JSON.stringify({ before, after: geometry() }));
      const matrix = new w.DOMMatrix(css(stamp).transform);
      check(`${label}固定负8度且无回弹`, Math.abs(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI + 8) < 0.01 && Math.abs(Math.hypot(matrix.a, matrix.b) - 1) < 0.01);
      const r = stamp.getBoundingClientRect(), card = d.querySelector('.card').getBoundingClientRect();
      const body = d.querySelector('.ticket-body').getBoundingClientRect();
      const textRight = body.right - parseFloat(css(d.querySelector('.ticket-body')).paddingRight);
      check(`${label}印章在票面内且不盖正文`, r.left >= card.left && r.right <= card.right && (r.bottom <= body.top || r.left >= textRight));
      check(`${label}完成操作无横向滚动且热区≥44`, d.documentElement.scrollWidth === d.documentElement.clientWidth && [...d.querySelectorAll('.done-row button')].every(button => { const r = button.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }));
      gate.resolve(); await completion;
      check(`${label}确认后不重复盖章且开放分享`, d.querySelector('.ticket-stamp') === stamp && d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'false');
      w.fetch = native;
    }
    let sent = 0;
    w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) sent++; return native(url, init); };
    await w.sendFeedback('completed'); await w.sendFeedback('completed');
    check('确认后再次完成不发请求且不可撤销', sent === 0 && state().card.completed && !d.querySelector('.feedback'));
    check('完成操作显示换一张与分享此刻且名称含可见文案', ['swap', 'share'].every(key => { const n = d.querySelector(`[data-focus="${key}"]`); return n.getAttribute('aria-label').includes(n.textContent); }) && d.querySelector('[data-focus="swap"]').textContent === '换一张' && d.querySelector('[data-focus="share"]').textContent === '分享此刻');
    let payload = '';
    Object.defineProperty(w.navigator, 'share', { configurable: true, value: async value => { payload = value.text; } });
    w.history.replaceState(null, '', '/?private=completion#token');
    await w.shareCard();
    check('分享只含实际分钟与干净链接不含票号', payload.includes(`约 ${state().card.minutes} 分钟`) && payload.endsWith(location.origin + '/') && !payload.includes('private') && !payload.includes('token') && !payload.includes(state().card.id) && !payload.includes('NOW-'));

    d.documentElement.style.fontSize = '16px';
    frame.style.width = '390px';
    w.fetch = native;
    await w.ask();
    select('budget', '5');
    const expandedHeight = d.querySelector('.card-actions').getBoundingClientRect().height;
    await feedback('completed');
    check('改条件两行操作区完成后不收缩', Math.abs(d.querySelector('.done-row').getBoundingClientRect().height - expandedHeight) < 1);
    const swapGate = deferred();
    let recommendations = 0;
    select('budget', '10');
    w.fetch = async (url, init) => {
      if (String(url).endsWith('/api/recommendations')) { recommendations++; await swapGate.promise; return response('request_failed', 500); }
      return native(url, init);
    };
    const retainedHeight = d.querySelector('.done-row').getBoundingClientRect().height;
    const swap = w.ask(w.conditions(), 'swap');
    check('完成票退场期间通道保持出票锁定', lane().phase === 'ISSUING' && d.documentElement.dataset.laneState === 'ISSUING' && d.getElementById('result').getAttribute('aria-busy') === 'true');
    check('完成票实际播放160ms退场动画', css(d.querySelector('.card')).animationName === 'out' && css(d.querySelector('.card')).animationDuration === '0.16s');
    await pause(200);
    check('骨架接管后结果仍忙碌且通道不能重入', !!d.querySelector('.skeleton') && state().busy && lane().phase === 'ISSUING' && d.getElementById('result').getAttribute('aria-busy') === 'true');
    swapGate.resolve(); await swap;
    check('换票失败保留隐藏完成票及第三格重试入口', !!d.querySelector('.ticket-done') && !visible(d.querySelector('.ticket-done')) && visible(d.querySelector('.notice.lane-banner .retry')) && lane().phase === 'AT_FIELD_3' && recommendations === 1 && sent === 0);
    check('换票失败保留完成区高度快照而不量隐藏卡', Math.abs(state().completionHeight - retainedHeight) < 1 && parseFloat(d.querySelector('.done-row').style.minHeight) >= retainedHeight - 1);
    const seen = [];
    select('budget', '3');
    w.fetch = (url, init) => { if (String(url).endsWith('/api/recommendations')) seen.push(JSON.parse(init.body)); return native(url, init); };
    click('.notice .retry'); while (state().busy) await pause(10);
    check('完成后失败重试仍重放条件快照', seen.length === 1 && seen[0].budget === 10 && w.conditions().budget === 3 && !state().card.completed && lane().phase === 'TICKET' && d.getElementById('lane-form').hidden && visible(d.querySelector('.card')));

    const media = [...d.styleSheets[0].cssRules].filter(rule => rule.media?.mediaText.includes('prefers-reduced-motion'));
    const originalMedia = media.map(rule => rule.media.mediaText), match = w.matchMedia;
    media.forEach(rule => { rule.media.mediaText = 'all'; });
    w.matchMedia = query => query.includes('prefers-reduced-motion') ? { matches: true } : match.call(w, query);
    await feedback('completed');
    const reduced = d.querySelector('.ticket-stamp');
    check('模拟减少动态立即呈现静态完成态', css(reduced).animationName === 'none' && css(reduced).opacity === '1' && reduced.getAnimations().length === 0 && !!d.querySelector('.ticket-done'));
    await w.exitCard();
    check('模拟减少动态跳过旧票退场', !d.querySelector('.card-out'));
    media.forEach((rule, i) => { rule.media.mediaText = originalMedia[i]; });
    w.matchMedia = match;
    delete w.navigator.share;
    d.documentElement.style.fontSize = '';
    frame.style.width = '390px';
    w.fetch = native;
  }
  if (group === 'b4') {
    const root = d.documentElement, key = 'whynot-theme';
    const stored = w.localStorage.getItem(key), guided = w.localStorage.getItem('whynot-guide');
    const media = [...d.styleSheets[0].cssRules].filter(rule => rule.media?.mediaText.includes('prefers-color-scheme'));
    const originalMedia = media.map(rule => rule.media.mediaText);
    const readTheme = () => d.querySelector('input[name="theme"]:checked').value;
    click('#settings-toggle');
    check('关于可展开且主题为原生单选组', !d.getElementById('about').hidden && d.querySelectorAll('input[name="theme"]').length === 3);
    for (const dark of [false, true]) {
      media.forEach(rule => { rule.media.mediaText = dark ? 'all' : 'not all'; });
      for (const theme of ['system', 'light', 'dark']) {
        selectTheme(theme);
        const expected = theme === 'dark' || (theme === 'system' && dark);
        check(`CSS系统${dark ? '深' : '浅'}色/选择${theme}`, w.getComputedStyle(d.body).backgroundColor === (expected ? 'rgb(16, 24, 39)' : 'rgb(234, 240, 248)') && w.getComputedStyle(root).colorScheme === (expected ? 'dark' : 'light'));
        check(`主题${theme}/系统${dark}同步meta及纸张投影`, [...d.querySelectorAll('meta[name="theme-color"]')].every(meta => meta.content === ((theme === 'dark' || (theme === 'system' && meta.media.includes('dark'))) ? '#0d1526' : '#cfe0f2')) && w.getComputedStyle(d.querySelector('.card')).boxShadow !== 'none');
      }
    }
    media.forEach((rule, i) => { rule.media.mediaText = originalMedia[i]; });
    selectTheme('dark');
    check('显式主题写入存储', w.localStorage.getItem(key) === 'dark');
    selectTheme('system');
    check('跟随系统清除覆盖值', w.localStorage.getItem(key) === null && !root.hasAttribute('data-theme'));
    const setItem = w.Storage.prototype.setItem;
    w.Storage.prototype.setItem = () => { throw new w.DOMException('test', 'QuotaExceededError'); };
    selectTheme('dark');
    check('写入被拒静默回到系统', readTheme() === 'system' && !root.hasAttribute('data-theme'));
    w.Storage.prototype.setItem = setItem;
    click('#settings-toggle');
    check('关闭关于后焦点回入口', d.getElementById('about').hidden && d.activeElement.id === 'settings-toggle');

    const html = await (await native('/')).text();
    const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    check('首屏脚本≤400B且早于样式', new TextEncoder().encode(inline).length <= 400 && html.indexOf(inline) < html.indexOf('href="/style.css"'));
    const probe = d.createElement('iframe');
    probe.hidden = true;
    d.body.append(probe);
    async function probePage(source) {
      const loaded = new Promise(resolve => { probe.onload = resolve; });
      probe.srcdoc = source;
      await loaded;
      return probe.contentWindow;
    }
    const beforeApp = html.replace('<script src="/app.js"></script>', '');
    w.localStorage.setItem(key, 'dark');
    w.localStorage.setItem('whynot-guide', 'seen');
    let p = await probePage(beforeApp);
    check('外部app运行前已是深色且回访引导隐藏', p.document.documentElement.dataset.theme === 'dark' && p.getComputedStyle(p.document.body).backgroundColor === 'rgb(16, 24, 39)' && p.getComputedStyle(p.document.getElementById('guide')).display === 'none');
    check('外部app运行前主题meta已同步', [...p.document.querySelectorAll('meta[name="theme-color"]')].every(m => m.content === '#0d1526'));
    w.localStorage.removeItem('whynot-guide');
    w.localStorage.setItem(key, 'unknown');
    p = await probePage(beforeApp);
    check('无效主题忽略且首访引导无需app即可见', !p.document.documentElement.hasAttribute('data-theme') && p.getComputedStyle(p.document.getElementById('guide')).display !== 'none');
    p = await probePage(html.replace('<head>', '<head><script>window.testErrors=[];addEventListener("error",e=>testErrors.push(e.message));Object.defineProperty(window,"localStorage",{get(){throw new DOMException("test","SecurityError")}})</script>'));
    await p.ensureSession();
    await p.ask();
    await p.sendFeedback('like');
    check('存储读取被拒仍能生成及反馈，主题跟随系统', !p.document.documentElement.hasAttribute('data-theme') && p.document.querySelector('input[name="theme"]:checked').value === 'system' && p.eval('state.card.preference') === 'like' && !p.testErrors.length);
    probe.remove();
    if (stored === null) w.localStorage.removeItem(key); else w.localStorage.setItem(key, stored);
    if (guided === null) w.localStorage.removeItem('whynot-guide'); else w.localStorage.setItem('whynot-guide', guided);
    w.applyTheme(stored === 'light' || stored === 'dark' ? stored : 'system');

    check('未完成卡无分享入口', !d.querySelector('[data-focus="share"]'));
    const completionGate = deferred();
    let earlyShares = 0;
    Object.defineProperty(w.navigator, 'share', { configurable: true, value: async () => { earlyShares++; } });
    w.fetch = async (url, init) => { const response = await native(url, init); if (String(url).endsWith('/feedback')) await completionGate.promise; return response; };
    const completion = feedback('completed');
    await w.shareCard();
    check('完成反馈在途不允许提前分享', state().feedbackPending && earlyShares === 0 && d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'true');
    completionGate.resolve(); await completion;
    w.fetch = native;
    delete w.navigator.share;
    check('完成后分享可用', d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'false');
    const setNav = (name, value) => Object.defineProperty(w.navigator, name, { configurable: true, value });
    const command = d.execCommand;
    let shares = 0, copies = 0, legacy = 0, payload = '', network = 0;
    w.fetch = (url, init) => { if (!String(url).includes('/api/memories')) network++; return native(url, init); };
    setNav('share', async value => { shares++; payload = value.text; });
    setNav('clipboard', { writeText: async text => { copies++; payload = text; } });
    const originalTitle = state().card.title;
    state().card.title = '长'.repeat(50);
    w.history.replaceState(null, '', '/?private=test#token');
    click('[data-focus="share"]');
    await pause(0);
    check('原生分享优先且不落剪贴板（stub）', shares === 1 && copies === 0);
    check('分享标题≤40字且链接不带查询、片段、编号', payload.includes('长'.repeat(40) + '。') && !payload.includes('长'.repeat(41)) && payload.endsWith(location.origin + '/') && !payload.includes('private') && !payload.includes(state().card.id));
    state().card.title = originalTitle;
    setNav('share', async () => { throw new w.DOMException('cancel', 'AbortError'); });
    await w.shareCard();
    check('分享取消安静结束且不复制', copies === 0 && !d.getElementById('share-status').textContent);
    setNav('share', async () => { throw new w.DOMException('blocked', 'NotAllowedError'); });
    await w.shareCard();
    check('原生拒绝后剪贴板降级（stub）', copies === 1 && d.getElementById('share-status').textContent === '已复制。');
    await pause(2100);
    check('复制提示2秒清除', !d.getElementById('share-status').textContent);
    setNav('share', undefined);
    setNav('clipboard', { writeText: async () => { throw new w.DOMException('blocked', 'NotAllowedError'); } });
    d.execCommand = action => { legacy++; return action === 'copy'; };
    await w.shareCard();
    check('剪贴板拒绝后传统复制（stub）', legacy === 1 && d.getElementById('share-text').hidden && d.activeElement.dataset.focus === 'share');
    d.execCommand = () => false;
    await w.shareCard();
    const area = d.getElementById('share-text');
    check('全部复制受限提供只读可选文本', !area.hidden && area.readOnly && area.selectionEnd === area.value.length && area.selectionStart === 0 && d.activeElement === area && d.getElementById('share-status').textContent.includes('长按'));
    click('#settings-toggle');
    frame.style.width = '320px';
    root.style.fontSize = '32px';
    await pause(50);
    check('320px/200%关于及分享无横向滚动', root.scrollWidth === root.clientWidth && area.getBoundingClientRect().right <= root.clientWidth);
    check('主题触摸目标均≥44', [...d.querySelectorAll('label[for^="theme-"]')].every(n => { const r = n.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }));
    root.style.fontSize = '';
    frame.style.width = '390px';
    check('所有分享分支不调用API', network === 0);
    let gate = deferred();
    setNav('share', async () => { shares++; await gate.promise; });
    const pending = w.shareCard();
    const count = shares;
    await w.shareCard();
    check('原生分享在途防重复', shares === count);
    gate.resolve(); await pending;
    setNav('share', undefined);
    gate = deferred();
    setNav('clipboard', { writeText: () => gate.promise });
    const stale = w.shareCard();
    await w.ask();
    gate.resolve(); await stale;
    check('旧分享完成不污染新卡或显示旧文本', !d.getElementById('share-status').textContent && area.hidden && !area.value);
    await feedback('completed');
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => false });
    const before = network;
    await w.shareCard();
    check('离线分享有提示且不发请求', network === before && d.getElementById('share-status').textContent.includes('等有网'));
    delete w.navigator.onLine;
    delete w.navigator.share;
    delete w.navigator.clipboard;
    d.execCommand = command;
    w.clearShare();

    const manifestResponse = await native('/manifest.webmanifest');
    const manifest = await manifestResponse.json();
    check('manifest类型、入口与显示模式', manifestResponse.headers.get('content-type').includes('application/manifest+json') && manifest.start_url === '/' && manifest.scope === '/' && manifest.display === 'standalone');
    check('manifest身份与语言保持稳定', manifest.id === '/' && manifest.name === 'WhyNot' && manifest.short_name === 'WhyNot' && manifest.lang === 'zh-CN');
    check('安装启动主题采用夜色而非旧纸色', manifest.background_color === '#101827' && manifest.theme_color === '#101827');
    check('manifest声明两种普通安装图标而非maskable', manifest.icons.length === 2 && [192, 512].every(size => manifest.icons.some(icon => icon.src === `/icon-${size}.png` && icon.sizes === `${size}x${size}` && icon.type === 'image/png' && icon.purpose === 'any')));
    const faviconResponse = await native('/icon.svg'), svgText = await faviconResponse.text();
    const svg = new w.DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
    check('favicon为夜色米白32px静态SVG', faviconResponse.ok && faviconResponse.headers.get('content-type').includes('image/svg+xml') && svg.getAttribute('viewBox') === '0 0 32 32' && svg.querySelector('rect')?.getAttribute('fill') === '#101827' && svg.querySelector('path')?.getAttribute('stroke') === '#f6f2e8' && !svg.querySelector('script,image,use,animate,parsererror'));
    check('favicon包含三笔圆头圆接锁齿图形', svg.querySelectorAll('path').length === 1 && svg.querySelector('path').getAttribute('d').match(/M/g)?.length === 3 && svg.querySelector('path').getAttribute('stroke-width') === '2' && svg.querySelector('path').getAttribute('stroke-linecap') === 'round' && svg.querySelector('path').getAttribute('stroke-linejoin') === 'round');
    svg.querySelector('rect').setAttribute('rx', '0');
    svg.querySelector('path').setAttribute('transform', 'translate(16 16) scale(.8) translate(-16 -16)');
    for (const [path, size] of [['/apple-touch-icon.png', 180], ['/icon-192.png', 192], ['/icon-512.png', 512]]) {
      const r = await native(path), image = await w.createImageBitmap(await r.blob());
      check(`安装图标${size}px有效`, r.ok && r.headers.get('content-type').includes('image/png') && image.width === size && image.height === size);
      const canvas = d.createElement('canvas'); canvas.width = canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0); image.close();
      const pixels = context.getImageData(0, 0, size, size).data;
      const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
      check(`${size}px安装图标背景与中心笔画配色`, [16, 24, 39, 255].every((v, i) => pixels[i] === v) && [246, 242, 232, 255].every((v, i) => pixels[center + i] === v));
      let opaque = true, margin = true;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        opaque &&= pixels[i + 3] === 255;
        if (x < size * .16 || x >= size * .84 || y < size * .16 || y >= size * .84) margin &&= pixels[i] === 16 && pixels[i + 1] === 24 && pixels[i + 2] === 39;
      }
      check(`${size}px安装图标全不透明且外缘留白≥16%`, opaque && margin);
      svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
      const reference = new w.Image(), url = w.URL.createObjectURL(new w.Blob([new w.XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      try {
        await new Promise((resolve, reject) => { reference.onload = resolve; reference.onerror = reject; reference.src = url; });
        context.clearRect(0, 0, size, size); context.drawImage(reference, 0, 0);
        const expected = context.getImageData(0, 0, size, size).data;
        const meanError = pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - expected[i])), 0) / (size * size * 3);
        check(`${size}px PNG与favicon主体几何一致`, meanError < 3, String(meanError));
        const corners = [[4, 12], [28, 12], [4, 20], [28, 20], [11, 16], [21, 16], [4, 6], [8, 6], [10, 8], [12, 6], [16, 6], [18, 8], [20, 6], [28, 6], [4, 26], [28, 26]];
        const localErrors = corners.map(([x, y]) => {
          const cx = ((x - 16) * .8 + 16) * size / 32, cy = ((y - 16) * .8 + 16) * size / 32, radius = size * .8 / 32 + 1;
          let total = 0, count = 0;
          for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py++) for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px++) {
            const index = (py * size + px) * 4;
            for (let channel = 0; channel < 3; channel++) total += Math.abs(pixels[index + channel] - expected[index + channel]);
            count += 3;
          }
          return total / count;
        });
        check(`${size}px PNG端点和锁齿圆角与SVG一致`, localErrors.every(error => error < 12), JSON.stringify(localErrors));
      } finally { w.URL.revokeObjectURL(url); }
    }
    check('文档关联manifest及Apple图标', d.querySelector('link[rel="manifest"]').getAttribute('href') === '/manifest.webmanifest' && d.querySelector('link[rel="apple-touch-icon"]').getAttribute('sizes') === '180x180');
    check('文档关联SVG favicon', d.querySelector('link[rel="icon"]').getAttribute('href') === '/icon.svg' && d.querySelector('link[rel="icon"]').getAttribute('type') === 'image/svg+xml');
  }
  if (group === 'lane') {
    const root = d.documentElement, form = d.getElementById('lane-form');
    const fields = [...d.querySelectorAll('form#lane-form .field')];
    const activeField = () => fields.findIndex(node => node.classList.contains('is-active'));
    const at = index => lane().step === index && lane().phase === `AT_FIELD_${index + 1}`;
    const doneValues = () => fields.map(node => node.classList.contains('is-done'));
    const css = node => w.getComputedStyle(node);
    const pick = id => {
      const input = d.getElementById(id);
      input.focus();
      input.click();
      return input;
    };
    const settleTicket = () => waitFor(() => !state().busy && lane().phase === 'TICKET', '实际API出票');
    const setEnv = (name, value) => native('/__local/env', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, value }) });
    const motionRules = [...d.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.media?.mediaText.includes('prefers-reduced-motion'));
    const savedMotion = motionRules.map(rule => rule.media.mediaText), match = w.matchMedia;
    const motion = reduced => {
      motionRules.forEach(rule => { rule.media.mediaText = reduced ? 'all' : 'not all'; });
      w.matchMedia = query => query.includes('prefers-reduced-motion') ? { matches: reduced, media: query, addEventListener() {}, removeEventListener() {} } : match.call(w, query);
    };
    const stored = w.localStorage.getItem('whynot-lane'), guided = w.localStorage.getItem('whynot-guide');
    const openingCalls = [], recommendationCalls = [], feedbackCalls = [];
    const gate = deferred();
    let failOpening = false, probe;
    try {
      await setEnv('MODEL_API_KEY', 'fake-local-key');
      await setEnv('MODEL_ENDPOINT', 'http://127.0.0.1:8766/valid');
      motion(false);
      w.fetch = async (url, init) => {
        const path = String(url);
        if (path.endsWith('/api/interactions')) {
          openingCalls.push(JSON.parse(init.body));
          if (failOpening) throw new TypeError('lane test offline');
          await gate.promise;
        }
        if (path.endsWith('/api/recommendations')) recommendationCalls.push(JSON.parse(init.body));
        if (path.endsWith('/feedback')) feedbackCalls.push(JSON.parse(init.body));
        return native(url, init);
      };

      w.resetForm(false);
      check('lane/初始是一张三格空票且不自动出票', !form.hidden && d.getElementById('result').hidden && lane().step === 0 && lane().phase === 'AT_FIELD_1' && lane().values.every(value => value === null) && doneValues().every(value => !value) && d.getElementById('issue').disabled && !state().card && openingCalls.length === 0);
      check('lane/状态公开且html同步', Number.isInteger(lane().epoch) && lane().epoch >= 0 && root.dataset.laneState === lane().phase && d.body.dataset.phase === lane().phase);
      check('lane/票面骨架完整且齿孔票头基线存在', !!form.querySelector('.perf') && !!form.querySelector('.thead') && !!form.querySelector('.band') && getComputedStyle(form).maskImage.includes('radial-gradient'));
      check('lane/退役控件全部移除而非隐藏兼容', !d.querySelector('#ask,.panel,.seg,#scene-toggle,#scene-panel,#lane-collection,.lane,.station-ticket'));
      const contract = [
        ['budget', 'b3', '3', 0], ['budget', 'b5', '5', 0], ['budget', 'b10', '10', 0], ['budget', 'b15', '15', 0],
        ['energy', 'elow', 'low', 1], ['energy', 'esteady', 'steady', 1], ['energy', 'ehigh', 'high', 1],
        ['scene', 'snone', '', 2], ['scene', 'swaiting', 'waiting', 2], ['scene', 'sdesk', 'desk', 2], ['scene', 'soutside', 'outside', 2], ['scene', 'shome', 'home', 2],
      ];
      check('lane/12个radio的name id value和所属格保持原契约', form.querySelectorAll('input[type="radio"]').length === contract.length && contract.every(([name, id, value, index]) => { const input = d.getElementById(id); return input?.type === 'radio' && input.name === name && input.value === value && input.closest('.field') === fields[index] && input.labels.length === 1 && !!input.labels[0].textContent.trim(); }));
      check('lane/初始没有预选且一次只展开一格', form.querySelectorAll('input:checked').length === 0 && fields.filter(node => node.classList.contains('is-active')).length === 1 && fields.map(node => node.querySelector('.f-body').inert).join() === 'false,true,true');
      check('lane/三行都显示空横线且问题仅第一格可见', [...form.querySelectorAll('.f-val')].every(node => node.textContent === '—') && fields[0].querySelector('.f-body').getBoundingClientRect().height > 0 && fields[1].querySelector('.f-body').getBoundingClientRect().height === 0 && fields[2].querySelector('.f-body').getBoundingClientRect().height === 0);

      const beforeEpoch = lane().epoch;
      const budgetInput = pick('b10');
      await pause(80);
      check('lane/选时间后本格收成一行且下一格展开', lane().phase === 'AT_FIELD_2' && lane().step === 1 && lane().epoch > beforeEpoch && fields[0].classList.contains('is-done') && fields[0].querySelector('.f-val').textContent === '10 分钟' && fields[1].classList.contains('is-active') && !fields[1].querySelector('.f-body').inert && fields[0].querySelector('.f-body').inert);
      check('lane/区间带立刻写入+10′并带到达时间', d.getElementById('band-num').textContent === '+10′' && /^\d{2}:\d{2}$/.test(d.getElementById('band-time').textContent));
      check('lane/焦点移到下一格第一个选项', d.activeElement === d.getElementById('elow') && d.activeElement.type === 'radio');
      check('lane/只填一格不发任何API', openingCalls.length === 0 && recommendationCalls.length === 0 && feedbackCalls.length === 0 && d.getElementById('issue').disabled);

      const stampEpoch = lane().epoch;
      budgetInput.click();
      budgetInput.dispatchEvent(new w.Event('change', { bubbles: true }));
      check('lane/重复点击同一选项不重复推进', lane().epoch === stampEpoch && lane().step === 1 && openingCalls.length === 0);
      pick('esteady'); await pause(60);
      pick('snone'); await pause(80);
      check('lane/三格填完进入READY且主按钮可点', lane().phase === 'READY' && lane().step === 3 && doneValues().every(Boolean) && [...form.querySelectorAll('.f-val')].map(node => node.textContent).join('·') === '10 分钟·还可以·跳过' && !d.getElementById('issue').disabled && d.activeElement === d.getElementById('issue'));
      check('lane/进度条与播报同步', [...d.querySelectorAll('.progress li')].every(node => node.classList.contains('is-done')) && d.getElementById('band-num').textContent === '+10′' && d.getElementById('lane-status').getAttribute('role') === 'status' && d.getElementById('lane-status').textContent.includes('三格齐了'));

      click('.field[data-step="0"] .f-edit'); await pause(60);
      check('lane/点改回到已填格并保留选择', at(0) && d.activeElement === d.getElementById('b10') && fields[0].classList.contains('is-active'));
      pick('b15'); await pause(60);
      check('lane/改完自动回到READY并更新区间带', lane().phase === 'READY' && lane().values[0] === '15' && d.getElementById('band-num').textContent === '+15′' && !d.getElementById('issue').disabled);

      const firstSnapshot = { ...w.conditions() };
      const oldCard = state().card;
      d.getElementById('issue').click();
      await waitFor(() => state().busy && openingCalls.length === 1, '票面单次实际请求', 3000);
      check('lane/出票只开启一个互动并传完整条件及UUID', recommendationCalls.length === 0 && feedbackCalls.length === 0 && Object.entries(firstSnapshot).every(([key, value]) => openingCalls[0][key] === value) && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(openingCalls[0].request_id) && openingCalls[0].supports.includes('image'));
      check('lane/ISSUING同步结果busy且三格齐了', lane().phase === 'ISSUING' && root.dataset.laneState === 'ISSUING' && d.getElementById('result').getAttribute('aria-busy') === 'true' && d.getElementById('result').getAttribute('aria-label').includes('出票中') && form.hidden && doneValues().every(Boolean));
      const issuingEpoch = lane().epoch, locked = JSON.stringify(w.conditions());
      d.getElementById(firstSnapshot.budget === 3 ? 'b15' : 'b3').click();
      d.getElementById(firstSnapshot.scene === 'desk' ? 'shome' : 'sdesk').click();
      click('.field[data-step="1"] .f-line');
      w.resetForm(false);
      await pause(30);
      check('lane/在途DOM点击不回改条件或重入', JSON.stringify(w.conditions()) === locked && lane().phase === 'ISSUING' && openingCalls.length === 1 && recommendationCalls.length === 0 && d.getElementById('issue').disabled);
      gate.resolve(); await settleTicket();
      check('lane/真实API成功只留一张结果票且票面隐藏', !!state().ix && d.querySelectorAll('.card').length === 1 && visible(d.querySelector('.card')) && form.hidden && root.dataset.laneState === 'TICKET' && d.getElementById('result').getAttribute('aria-busy') === 'false' && state().card.minutes <= firstSnapshot.budget);
      check('lane/首次成功焦点到标题而引导才收起', d.activeElement.id === 'card-title' && d.getElementById('guide').hidden && w.localStorage.getItem('whynot-guide') === 'seen');
      checkCardSemantics();
      check('lane/结果票有区间带与票头票根', !!d.querySelector('.card .route-band') && !!d.querySelector('.card .ticket-head') && !!d.querySelector('.card .ticket-stub') && d.querySelector('.card .route-band').textContent.includes('+15′'));
      const contextKeys = [...d.querySelectorAll('.ticket-context > button.context-key')];
      check('lane/结果三枚条件键可见可访问且可返回', contextKeys.length === 3 && contextKeys.every((node, i) => node.dataset.station === String(i) && node.type === 'button' && visible(node) && !!node.textContent.trim() && node.getAttribute('aria-label')?.includes(node.textContent.trim())));

      const oldId = state().ix.id, preReturn = JSON.stringify(w.conditions());
      click('.ticket-context > button[data-station="1"]'); await pause(60);
      check('lane/条件键返回对应格并保留全部选择', at(1) && !form.hidden && d.getElementById('result').hidden && d.activeElement === d.getElementById('e' + (w.conditions().energy)) && lane().values.every(value => value !== null) && state().ix.id === oldId && !visible(d.querySelector('.card')));
      pick('ehigh'); await pause(60);
      check('lane/回改后仍需重新出票', lane().phase === 'READY' && lane().values[1] === 'high' && !d.getElementById('issue').disabled && openingCalls.length === 1);
      d.getElementById('issue').click(); await settleTicket();
      check('lane/再次出票带旧互动replaces且条件为新值', openingCalls.length === 2 && openingCalls[1].replaces === oldId && openingCalls[1].energy === 'high' && openingCalls[1].budget === 15 && state().ix.id !== oldId && feedbackCalls.length === 0 && preReturn.length > 0);

      const retained = state().ix.id;
      click('.ticket-context > button[data-station="2"]'); await pause(60);
      check('lane/结果回第三格保留已填值', at(2) && lane().values[2] === '' && d.activeElement === d.getElementById('snone'));
      failOpening = true;
      pick('sdesk');
      d.getElementById('issue').click();
      await waitFor(() => !state().busy && !!d.querySelector('.notice.lane-banner'), '出票失败回到票面');
      const failedPayload = openingCalls.at(-1), failedCount = openingCalls.length;
      check('lane/网络失败不自动重试且显示错误重试', failedCount === 3 && lane().phase === 'AT_FIELD_3' && !form.hidden && visible(d.querySelector('.notice.lane-banner')) && !!d.querySelector('.lane-banner .notice-title').textContent && visible(d.querySelector('.lane-banner .retry')) && d.activeElement === d.querySelector('.lane-banner .retry'));
      check('lane/失败保留旧票DOM与全部条件', state().ix.id === retained && state().card.id === retained && d.querySelectorAll('.card').length === 1 && !visible(d.querySelector('.card')) && lane().values.join('·') === '15·high·desk' && !d.getElementById('issue').disabled);
      failOpening = false;
      click('.notice.lane-banner .retry'); await settleTicket();
      check('lane/手动重试复用原request_id及完整snapshot', openingCalls.length === failedCount + 1 && JSON.stringify(openingCalls.at(-1)) === JSON.stringify(failedPayload) && state().conditions.budget === failedPayload.budget && state().conditions.energy === failedPayload.energy && state().conditions.scene === failedPayload.scene && state().card.minutes <= failedPayload.budget);
      check('lane/重试成功清除错误且恢复单张可见票', !d.querySelector('.notice.lane-banner') && form.hidden && d.querySelectorAll('.card').length === 1 && visible(d.querySelector('.card')));

      w.resetForm(false);
      w.localStorage.setItem('whynot-lane', JSON.stringify({ budget: 5, energy: 'high', scene: 'desk' }));
      w.useLastConditions(); await pause(60);
      check('lane/用上次的条件一键填满并聚焦出票', lane().phase === 'READY' && lane().values.join('·') === '5·high·desk' && !d.getElementById('issue').disabled && d.activeElement === d.getElementById('issue') && d.getElementById('band-num').textContent === '+5′');
      click('#reset-form'); await pause(60);
      check('lane/重填清空三格并回到第一格', at(0) && lane().values.every(value => value === null) && form.querySelectorAll('input:checked').length === 0 && d.getElementById('issue').disabled && d.getElementById('result').hidden);

      motion(true);
      pick('b3'); pick('elow'); pick('soutside');
      check('lane/reduced-motion三格立即填完', lane().phase === 'READY' && lane().values.join('·') === '3·low·outside');
      const beforeReduced = openingCalls.length;
      d.getElementById('issue').click();
      check('lane/reduced-motion出票立即ISSUING且无过场', state().busy && lane().phase === 'ISSUING' && root.dataset.laneState === 'ISSUING');
      await settleTicket();
      check('lane/reduced-motion仍只生成一次且标题聚焦', openingCalls.length === beforeReduced + 1 && d.activeElement.id === 'card-title');
      motion(false);

      w.resetForm(false);
      const enter = d.getElementById('b10');
      enter.focus();
      enter.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await pause(60);
      check('lane/已选项用回车也可确认并前进', at(1) && d.activeElement === d.getElementById('elow'));

      for (const [width, font] of [[320, 16], [390, 16], [768, 16], [320, 35.2]]) {
        frame.style.width = `${width}px`; root.style.fontSize = `${font}px`;
        const labelPrefix = `lane/${width}px/${Math.round(font / 16 * 100)}%`;
        w.resetForm(false);
        for (let index = 0; index < 3; index++) {
          await pause(30);
          const field = fields[index], question = field.querySelector('.f-q');
          const options = [...field.querySelectorAll('input')].map(input => input.labels[0]);
          const boxes = options.map(node => node.getBoundingClientRect());
          const label = `${labelPrefix}/第${index + 1}格`;
          check(`${label}单格无横滚且问题选项不裁切`, at(index) && activeField() === index && root.scrollWidth === root.clientWidth && [question, ...options].every(node => visible(node) && node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight));
          check(`${label}选项热区≥44且不重叠`, boxes.every((r, i) => r.width >= 44 && r.height >= 44 && boxes.slice(i + 1).every(s => r.right <= s.left || s.right <= r.left || r.bottom <= s.top || s.bottom <= r.top)));
          pick(field.querySelector('input').id);
          await pause(30);
        }
        check(`${labelPrefix}三格填完不横滚且主按钮可点`, lane().phase === 'READY' && root.scrollWidth === root.clientWidth && !d.getElementById('issue').disabled);
      }
      frame.style.width = '390px'; root.style.fontSize = '';

      const html = await (await native('/')).text();
      probe = d.createElement('iframe');
      probe.title = '通道存储边界验收';
      probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:390px;height:844px;border:0';
      d.body.append(probe);
      const instrumentation = '<script>window.laneProbeErrors=[];window.laneProbeCalls=[];addEventListener("error",e=>laneProbeErrors.push(e.message));addEventListener("unhandledrejection",e=>laneProbeErrors.push(String(e.reason)));const originalFetch=window.fetch.bind(window);window.fetch=(url,init)=>{if(/\\/api\\/(interactions|recommendations)$/.test(String(url)))laneProbeCalls.push(String(url));return originalFetch(url,init)};<\/script>';
      const loadProbe = async (raw, prelude = '') => {
        if (raw === null) w.localStorage.removeItem('whynot-lane'); else w.localStorage.setItem('whynot-lane', raw);
        const loaded = new Promise(resolve => { probe.onload = resolve; });
        probe.srcdoc = html.replace('<head>', `<head>${instrumentation}${prelude}`);
        await loaded;
        const p = probe.contentWindow;
        await p.ensureSession();
        return p;
      };
      const idleProbe = p => p.eval('formState.step') === 0 && p.eval('formState.values.every(value => value === null)') && !p.document.getElementById('lane-form').hidden && p.document.querySelectorAll('.field.is-active:not([hidden])').length === 1 && p.laneProbeCalls.length === 0 && !p.laneProbeErrors.length && p.document.activeElement === p.document.body;
      for (const saved of [{ budget: 3, energy: 'low', scene: null }, { budget: 5, energy: 'steady', scene: 'waiting' }, { budget: 10, energy: 'high', scene: 'desk' }, { budget: 15, energy: 'low', scene: 'outside' }, { budget: 15, energy: 'steady', scene: 'home' }]) {
        const p = await loadProbe(JSON.stringify(saved));
        check(`lane/合法上次条件${JSON.stringify(saved)}不自动填入或出票`, idleProbe(p) && p.document.querySelectorAll('#lane-form input:checked').length === 0 && p.conditions().budget === 10 && p.conditions().energy === 'steady' && p.conditions().scene === null);
      }
      for (const raw of ['{bad', 'null', '[]', '"bad"', '{}', '{"budget":0,"energy":"low","scene":null}', '{"budget":16,"energy":"low","scene":null}', '{"budget":3.5,"energy":"low","scene":null}', '{"budget":"10","energy":"steady","scene":null}', '{"budget":10,"energy":"toString","scene":null}', '{"budget":10,"energy":"steady","scene":"__proto__"}', '{"budget":10,"energy":"steady","scene":[]}', '{"budget":10,"energy":["steady"],"scene":null}', '{"budget":10,"energy":"steady","scene":["desk"]}', '{"budget":10,"energy":"steady","scene":"<svg onload=alert(1)>"}']) {
        const p = await loadProbe(raw);
        check(`lane/坏存储${raw}安全回默认值且不启动`, idleProbe(p) && p.conditions().budget === 10 && p.conditions().energy === 'steady' && p.conditions().scene === null && !p.document.querySelector('#lane-form svg[onload]'));
      }
      const walkProbe = async p => {
        const originalMatch = p.matchMedia.bind(p);
        p.matchMedia = query => query.includes('prefers-reduced-motion') ? { matches: true } : originalMatch(query);
        for (const id of ['b10', 'esteady', 'snone']) {
          const input = p.document.getElementById(id);
          input.focus(); input.click();
          await waitFor(() => p.eval('formState.step') > ['b10', 'esteady', 'snone'].indexOf(id) || p.eval('formState.phase') === 'READY', '存储拒绝后仍能填格', 1000);
        }
        p.document.getElementById('issue').click();
        await waitFor(() => !p.eval('state.busy') && p.eval('formState.phase') === 'TICKET', '存储拒绝后真实出票');
      };
      w.localStorage.removeItem('whynot-guide');
      let p = await loadProbe(null, '<script>Object.defineProperty(window,"localStorage",{get(){throw new DOMException("test","SecurityError")}})<\/script>');
      check('lane/存储读取拒绝仍初始化空票', idleProbe(p));
      await walkProbe(p);
      check('lane/存储读取拒绝真实三格出票不阻塞', p.laneProbeCalls.length === 1 && !!p.eval('state.ix') && p.document.getElementById('guide').hidden && !p.laneProbeErrors.length);
      p = await loadProbe(null, '<script>Storage.prototype.setItem=function(){throw new DOMException("test","QuotaExceededError")}<\/script>');
      await walkProbe(p);
      check('lane/存储写入拒绝真实三格出票不阻塞', p.laneProbeCalls.length === 1 && !!p.eval('state.ix') && p.document.getElementById('guide').hidden && p.localStorage.getItem('whynot-lane') === null && !p.laneProbeErrors.length);

      const stage = d.querySelector('.stage');
      check('lane/进站编排已停站或静息', ['stopped', 'resting'].includes(stage.dataset.phase));
      w.restScene();
      await pause(800);
      check('lane/静息后场景运行中动画为0', stage.dataset.phase === 'resting' && d.getAnimations().filter(animation => animation.playState === 'running').length === 0);
      const reducedProbe = await loadProbe(null, '<script>const _m=window.matchMedia;window.matchMedia=q=>q.includes("prefers-reduced-motion")?{matches:true,media:q,addEventListener(){},removeEventListener(){}}:_m.call(window,q);addEventListener("load",()=>{for(const s of document.styleSheets){try{for(const r of s.cssRules){if(r.media&&r.media.mediaText.includes("prefers-reduced-motion"))r.media.mediaText="all";}}catch{}}});<\/script>');
      await pause(220);
      check('lane/reduced-motion首帧停站且无场景动画', reducedProbe.document.querySelector('.stage').dataset.phase === 'stopped' && reducedProbe.document.getAnimations().filter(animation => animation.playState === 'running').length === 0);
    } finally {
      gate.resolve();
      probe?.remove();
      w.fetch = native;
      w.matchMedia = match;
      motionRules.forEach((rule, i) => { rule.media.mediaText = savedMotion[i]; });
      frame.style.width = '390px'; root.style.fontSize = '';
      for (const [key, value] of [['whynot-lane', stored], ['whynot-guide', guided]]) {
        if (value === null) w.localStorage.removeItem(key); else w.localStorage.setItem(key, value);
      }
      await setEnv('MODEL_API_KEY', null);
      await setEnv('MODEL_ENDPOINT', null);
    }
  }

  if (group === 'ix') {
    const until = async fn => { for (let i = 0; i < 800 && !fn(); i++) await pause(10); };
    const ixOf = () => w.eval('state.ix');
    const contrastCheck = async (label, selectors) => {
      const rgb = color => color.match(/[\d.]+/g).map(Number);
      const luminance = color => rgb(color).slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
      const background = node => {
        while (node) { const color = w.getComputedStyle(node).backgroundColor, values = rgb(color); if (values.length === 3 || values[3] === 1) return color; node = node.parentElement; }
        return 'rgb(255,255,255)';
      };
      for (const theme of ['light', 'dark']) {
        w.applyTheme(theme); await pause(200);
        const ratios = selectors.flatMap(selector => [...d.querySelectorAll(selector)].filter(n => n.getBoundingClientRect().width > 0).map(node => {
          const x = luminance(w.getComputedStyle(node).color), y = luminance(background(node));
          return { selector, ratio: (Math.max(x, y) + .05) / (Math.min(x, y) + .05) };
        }));
        check(`${label}/${theme}文字对比度≥4.5`, ratios.length > 0 && ratios.every(x => x.ratio >= 4.5), JSON.stringify(ratios));
      }
      w.applyTheme('system');
    };
    const setDraft = text => {
      const input = d.querySelector('[data-focus="turn-input"]');
      input.value = text;
      input.dispatchEvent(new w.Event('input'));
    };
    const setEnv = (name, value) => native('/__local/env', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, value }),
    });
    await setEnv('MODEL_API_KEY', 'fake-local-key');
    await setEnv('MODEL_ENDPOINT', 'http://127.0.0.1:8766/valid');
    const openingCalls = [], recommendationCalls = [], feedbackCalls = [];
    const openingGate = deferred();
    let openingFailure = null;
    w.fetch = async (url, init) => {
      const path = String(url);
      if (path.endsWith('/api/interactions')) {
        openingCalls.push(JSON.parse(init.body));
        if (openingFailure) return response(openingFailure, 503);
        const result = await native(url, init);
        if (openingCalls.length === 1) await openingGate.promise;
        return result;
      }
      if (path.endsWith('/api/recommendations')) recommendationCalls.push(JSON.parse(init.body));
      if (path.endsWith('/feedback')) feedbackCalls.push(JSON.parse(init.body));
      return native(url, init);
    };
    check('P0由三格票面与出票按钮替代三站', !d.getElementById('ask') && d.querySelectorAll('form#lane-form .field').length === 3 && d.querySelectorAll('form#lane-form .field.is-active').length === 1 && !!d.getElementById('issue'));
    try {
      await enterLaneThroughUI({ waitForTicket: false });
      check('互动开场在结果与通道体现出票忙碌', d.getElementById('result').getAttribute('aria-busy') === 'true' && d.documentElement.dataset.laneState === 'ISSUING' && d.getElementById('status').textContent.includes('正在开启互动') && state().busy);
    } finally {
      openingGate.resolve();
    }
    await until(() => !state().busy);
    check('实际逐站点击只请求互动并保留图片声明', openingCalls.length === 1 && recommendationCalls.length === 0 && openingCalls[0].supports.includes('image') && !!ixOf() && d.activeElement.id === 'card-title');
    checkCardSemantics();
    const replaced = ixOf().id, previousMode = ixOf().mode;
    select('budget', '5'); select('energy', 'low');
    check('改条件不自动生成互动', openingCalls.length === 1);
    click('[data-focus="swap"]');
    await until(() => !state().busy);
    check('互动换票带replaces及当前条件且不提交反馈', openingCalls.length === 2 && openingCalls[1].replaces === replaced && openingCalls[1].budget === 5 && openingCalls[1].energy === 'low' && ixOf().id !== replaced && ixOf().mode !== previousMode && feedbackCalls.length === 0);
    openingFailure = 'MODEL_UNAVAILABLE';
    await enterLaneThroughUI();
    const failedOpening = openingCalls.at(-1);
    select('budget', '15'); select('energy', 'high');
    openingFailure = null;
    click('.notice .retry'); await until(() => !state().busy);
    check('互动开场重试保留UUID和失败条件快照', JSON.stringify(openingCalls.at(-1)) === JSON.stringify(failedOpening) && state().card.budget === failedOpening.budget && state().card.energy === failedOpening.energy);
    openingFailure = 'STORAGE_UNAVAILABLE';
    await enterLaneThroughUI();
    check('互动503明确原因并提供普通推荐降级', d.querySelector('.notice').textContent.includes('互动存储') && [...d.querySelectorAll('.notice button')].some(n => n.textContent === '看一条普通建议'));
    [...d.querySelectorAll('.notice button')].find(n => n.textContent === '看一条普通建议').click();
    await until(() => !state().busy);
    check('503降级使用完整V3票卡与时长而非对话卡', !ixOf() && !!d.querySelector('.ticket-head') && !!d.querySelector('.gauge') && !d.querySelector('.ix-card') && recommendationCalls.length === 1);
    await w.sendFeedback('completed');
    check('503降级完成盖章且确认后允许分享', !!d.querySelector('.ticket-stamp') && !!d.querySelector('.done-row') && d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'false');
    const feedbackBeforeSwap = feedbackCalls.length;
    select('budget', '3');
    click('[data-focus="swap"]'); await until(() => !state().busy);
    check('普通建议换票只请求当前条件推荐且不提交反馈', !ixOf() && recommendationCalls.length === 2 && recommendationCalls.at(-1).budget === 3 && feedbackCalls.length === feedbackBeforeSwap);
    w.fetch = native;
    select('budget', '10'); select('energy', 'steady');
    const openMode = async modes => {
      for (let i = 0; i < 40; i++) {
        await w.startInteraction();
        const ix = ixOf();
        if (ix && modes.includes(ix.mode)) return ix;
      }
      return null;
    };
    let ix = await openMode(['chat', 'discuss']);
    check('开场生成可聊互动卡', !!ix && !!d.querySelector('[data-focus="turn-input"]') && !!d.querySelector('[data-focus="send"]') && !!d.querySelector('[data-focus="end"]'));

    let gate = deferred(), turnCalls = 0;
    w.fetch = async (url, init) => {
      if (String(url).endsWith('/turns')) { turnCalls++; const r = await native(url, init); await gate.promise; return r; }
      return native(url, init);
    };
    setDraft('第一轮的话');
    const firstSend = w.sendTurn();
    await w.sendTurn();
    check('发送中防双击', turnCalls === 1 && ix.messages.length === 1 && ix.sending && d.querySelector('[data-focus="send"]').disabled, JSON.stringify({ turnCalls, msgs: ix.messages.length, sending: ix.sending }));
    gate.resolve(); await firstSend;
    check('第一轮回复上卡且版本推进', ix.messages.length === 2 && ix.messages[1].role === 'ai' && ix.version === 2 && d.querySelectorAll('.msg').length === 2, JSON.stringify({ msgs: ix.messages.map(m => ({ role: m.role, status: m.status, text: m.text })), version: ix.version, dom: d.querySelectorAll('.msg').length, ixStatus: ix.status, busy: state().busy }));

    const bodies = [];
    w.fetch = (url, init) => { if (String(url).endsWith('/turns')) bodies.push(JSON.parse(init.body)); return native(url, init); };
    setDraft('第二轮的话');
    await w.sendTurn();
    check('第二轮使用第一次回复的版本', bodies[0].version === 2 && ix.version === 3 && ix.messages.length === 4, JSON.stringify({ bodies, msgs: ix.messages.map(m => ({ role: m.role, status: m.status, text: m.text })), version: ix.version, dom: d.querySelectorAll('.msg').length, sending: ix.sending }));

    let failOnce = true;
    const retryBodies = [];
    w.fetch = (url, init) => {
      if (String(url).endsWith('/turns')) {
        retryBodies.push(JSON.parse(init.body));
        if (failOnce) { failOnce = false; return Promise.resolve(response('MODEL_UNAVAILABLE', 503)); }
      }
      return native(url, init);
    };
    setDraft('会失败的一句');
    await w.sendTurn();
    check('模型不可用保留消息与重试入口', ix.messages.at(-1).status === 'failed' && ix.messages.at(-1).text === '会失败的一句' && !!d.querySelector('.msg-retry'));
    const failedId = retryBodies[0].request_id, failedVersion = retryBodies[0].version;
    click(`[data-focus="retry-${failedId}"]`);
    await until(() => !ix.sending);
    check('重试复用同一UUID版本与内容', retryBodies[1].request_id === failedId && retryBodies[1].version === failedVersion && retryBodies[1].text === '会失败的一句' && ix.messages.at(-1).status === 'sent', JSON.stringify({ retryBodies, msgs: ix.messages.map(m => ({ role: m.role, status: m.status, text: m.text })), version: ix.version, dom: d.querySelectorAll('.msg').length }));

    gate = deferred();
    w.fetch = async (url, init) => { const r = await native(url, init); if (String(url).endsWith('/turns')) await gate.promise; return r; };
    setDraft('迟到的一句');
    const late = w.sendTurn();
    const oldId = ix.id;
    await w.startInteraction(w.conditions(), { replaces: oldId });
    const fresh = ixOf();
    gate.resolve(); await late;
    check('换卡后迟到响应不污染新卡', fresh.id !== oldId && fresh.messages.length === 0 && ixOf() === fresh);

    w.fetch = native;
    ix = await openMode(['chat', 'discuss']);
    click('[data-focus="end"]');
    await until(() => !ix.ending);
    check('结束204收起输入并提供重新开始', ix.status === 'closed' && !d.querySelector('[data-focus="turn-input"]') && !!d.querySelector('[data-focus="restart"]'));
    click('[data-focus="restart"]');
    await until(() => !w.eval('state.busy'));
    const restarted = ixOf();
    check('重新开始使用新互动ID且无旧消息', restarted.id !== ix.id && restarted.messages.length === 0);

    const micro = await openMode(['micro']);
    check('抽到小行动卡', !!micro && !!d.querySelector('[data-focus="like"]'));
    await w.sendFeedback('like');
    check('小行动反馈绑定本卡且保留互动状态', w.eval('state.card.preference') === 'like' && ixOf() === micro && micro.version === 1);
    gate = deferred();
    w.fetch = async (url, init) => {
      if (String(url).endsWith('/feedback')) { await gate.promise; return response('request_failed', 500); }
      return native(url, init);
    };
    const failedCompletion = w.sendFeedback('completed');
    check('小行动乐观盖章保留互动并在确认前禁分享', ixOf() === micro && !!d.querySelector('.ticket-stamp.stamp-in') && d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'true');
    gate.resolve(); await failedCompletion;
    check('小行动完成失败回滚印章与布局且保留互动', ixOf() === micro && !state().card.completed && !d.querySelector('.ticket-stamp') && !!d.querySelector('.card-actions'));
    w.fetch = native;
    await w.sendFeedback('completed');
    check('小行动完成态沿用分享行', w.eval('state.card.completed') && !!d.querySelector('.done-row'));
    check('小行动完成保留V3票头刻度并允许分享', ixOf() === micro && !!d.querySelector('.ticket-head') && !!d.querySelector('.gauge') && d.querySelector('[data-focus="share"]').getAttribute('aria-disabled') === 'false');
    click('[data-focus="swap"]'); await until(() => !state().busy);
    check('完成小行动换一张退出票卡且重置完成高度', ixOf().id !== micro.id && ixOf().mode !== 'micro' && !d.querySelector('.ticket-stamp') && state().completionHeight === 0 && !!d.querySelector('.ix-card'));

    ix = await openMode(['chat', 'discuss']);
    const candidate = { id: '11111111-1111-4111-8111-111111111111', text: '最近在练吉他', kind: 'status', topic: '近况', version: 1 };
    const confirmBodies = [];
    let candidateExpiredOnce = false;
    w.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith('/turns')) return Promise.resolve(w.Response.json({ id: 't1', reply: '看到了，确认一下要不要保存这句话。', version: ix.version + 1, candidate }));
      if (u.endsWith('/memories')) {
        const payload = JSON.parse(init.body);
        confirmBodies.push(payload);
        if (candidateExpiredOnce) { candidateExpiredOnce = false; return Promise.resolve(response('CANDIDATE_EXPIRED', 409)); }
        if (payload.action === 'skip') return Promise.resolve(w.Response.json({ skipped: true }));
        return Promise.resolve(w.Response.json({ id: 'm1', kind: 'status', topic: '近况', text: payload.text ?? candidate.text, version: 1, confirmed_at: new Date().toISOString(), expires_at: new Date().toISOString() }, { status: 201 }));
      }
      return native(url, init);
    };
    setDraft('帮我记住我最近在练吉他');
    await w.sendTurn();
    check('候选原文与三键出现', d.querySelector('.candidate-text')?.textContent.includes('最近在练吉他') && !!d.querySelector('[data-focus="cand-save"]') && !!d.querySelector('[data-focus="cand-edit"]') && !!d.querySelector('[data-focus="cand-skip"]'));
    await contrastCheck('对话与候选', ['.mode', '.badge', '.msg-text', '.turn-input', '.candidate-label', '.candidate-text', '.candidate-keys button', '.ix-actions button']);
    click('[data-focus="cand-save"]');
    await until(() => !ix.candidate.saving);
    check('确认使用候选自身版本并显示回执', confirmBodies[0].candidate_id === candidate.id && confirmBodies[0].version === 1 && confirmBodies[0].action === 'confirm' && d.querySelector('.candidate-note').textContent.includes('已保存'));

    setDraft('帮我记住下周三交论文');
    await w.sendTurn();
    click('[data-focus="cand-edit"]');
    const candInput = d.querySelector('[data-focus="cand-input"]');
    candInput.value = '下周三交论文（改）';
    candInput.dispatchEvent(new w.Event('input'));
    click('[data-focus="cand-save"]');
    await until(() => !ix.candidate.saving);
    check('改一下再保存提交修改文本', confirmBodies.at(-1).text === '下周三交论文（改）' && ix.candidate.status === 'saved');

    setDraft('帮我记住另一句');
    await w.sendTurn();
    click('[data-focus="cand-skip"]');
    await until(() => !ix.candidate.saving);
    check('跳过收起确认按钮', ix.candidate.status === 'skipped' && !d.querySelector('[data-focus="cand-save"]'));

    setDraft('帮我记住会过期的一句');
    await w.sendTurn();
    candidateExpiredOnce = true;
    click('[data-focus="cand-save"]');
    await until(() => !ix.candidate.saving);
    check('候选过期收起按钮并提示', ix.candidate.status === 'expired' && !d.querySelector('[data-focus="cand-save"]') && d.querySelector('.candidate-note').textContent.includes('超时'));

    const memItems = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'status', topic: '近况', text: '最近在练吉他', version: 1, confirmed_at: new Date().toISOString(), expires_at: new Date().toISOString() },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'status', topic: '近况', text: '下周三交论文', version: 1, confirmed_at: new Date().toISOString(), expires_at: new Date().toISOString() },
    ];
    const patchBodies = [], deleteCalls = [];
    let conflictOnce = true;
    w.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('/api/memories?')) return Promise.resolve(w.Response.json({ memories: memItems, total: memItems.length, offset: 0, limit: 20 }));
      if (u.includes('/api/memories/') && init?.method === 'PATCH') {
        const payload = JSON.parse(init.body);
        patchBodies.push(payload);
        if (conflictOnce) { conflictOnce = false; memItems[0].version = 2; memItems[0].text = '别处改过的文本'; return Promise.resolve(response('VERSION_CONFLICT', 409)); }
        return Promise.resolve(w.Response.json({ ...memItems[0], text: payload.text, version: payload.version + 1 }));
      }
      if (u.includes('/api/memories/') && init?.method === 'DELETE') { deleteCalls.push(u); return Promise.resolve(new w.Response(null, { status: 204 })); }
      return native(url, init);
    };
    click('#settings-toggle');
    await until(() => w.eval('mem.status') !== 'loading');
    check('设置打开加载记忆列表', d.querySelectorAll('.mem-item').length === 2);
    check('关于入口无障碍名称包含记忆管理', d.getElementById('settings-toggle').getAttribute('aria-label').includes('记忆管理'));
    await contrastCheck('记忆管理', ['.mem-count', '.mem-head .textbtn', '.mem-text', '.mem-meta', '.mem-keys .textbtn']);
    click(`[data-focus="mem-edit-${memItems[0].id}"]`);
    const memInput = d.querySelector(`[data-focus="mem-input-${memItems[0].id}"]`);
    memInput.value = '我在练吉他';
    memInput.dispatchEvent(new w.Event('input'));
    click(`[data-focus="mem-save-${memItems[0].id}"]`);
    await until(() => !w.eval('mem.busy') && w.eval('mem.status') !== 'loading');
    check('版本冲突刷新列表保留待修改文本', patchBodies.length === 1 && w.eval('mem.editing') === memItems[0].id && w.eval('mem.editDraft') === '我在练吉他' && d.querySelector('.mem-note').textContent.includes('别处'));
    click(`[data-focus="mem-save-${memItems[0].id}"]`);
    await until(() => !w.eval('mem.busy'));
    check('冲突后按新版本保存成功', patchBodies[1].version === 2 && w.eval('mem.editing') === null && d.querySelector('.mem-text').textContent === '我在练吉他');
    click(`[data-focus="mem-delete-${memItems[1].id}"]`);
    check('删除需二次确认', !!d.querySelector(`[data-focus="mem-confirm-${memItems[1].id}"]`) && deleteCalls.length === 0);
    click(`[data-focus="mem-confirm-${memItems[1].id}"]`);
    await until(() => !w.eval('mem.busy'));
    check('删除204移除条目', deleteCalls.length === 1 && d.querySelectorAll('.mem-item').length === 1);
    w.fetch = (url, init) => String(url).includes('/api/memories?') ? Promise.resolve(w.Response.json({ memories: [], total: 0, offset: 0, limit: 20 })) : native(url, init);
    click('[data-focus="mem-refresh"]');
    await until(() => w.eval('mem.status') !== 'loading');
    check('空列表有引导文案', d.querySelector('.mem-empty').textContent.includes('还没有保存过'));
    w.fetch = (url, init) => String(url).includes('/api/memories?') ? Promise.resolve(response('STORAGE_UNAVAILABLE', 503)) : native(url, init);
    click('[data-focus="mem-refresh"]');
    await until(() => w.eval('mem.status') !== 'loading');
    check('加载失败区别于空列表', d.querySelector('.mem-empty').textContent.includes('没能读到'));
    await contrastCheck('记忆空态与错误', ['.mem-empty']);
    click('#settings-toggle');
    w.fetch = native;
    ix = await openMode(['photo']);
    check('图片互动先上传再续聊且不套完成态', !!ix && !!d.querySelector('.photo-file') && !d.querySelector('[data-focus="turn-input"]') && !d.querySelector('.ticket-stamp') && !d.querySelector('[data-focus="completed"]'));
    await w.uploadPhoto(new w.File(['invalid'], 'invalid.txt', { type: 'text/plain' }));
    check('图片类型拒绝后保留上传入口', d.querySelector('.photo-error')?.textContent.includes('JPEG') && !!d.querySelector('[data-focus="photo"]') && !ix.uploadBusy);
    const image = await (await native('/icon-512.png')).blob();
    await w.uploadPhoto(new w.File([image.slice(0, 32)], 'invalid.png', { type: 'image/png' }));
    check('服务端拒绝损坏图片后可重新上传', d.querySelector('.photo-error')?.textContent.includes('没能读取') && ix.messages.length === 0 && !ix.uploadBusy);
    await setEnv('MODEL_ENDPOINT', 'http://127.0.0.1:8766/ambiguous');
    await w.uploadPhoto(new w.File([image], 'fixture.png', { type: 'image/png' }));
    check('真实上传入口歧义时先问不伪造词卡', ix.messages.length === 2 && !d.querySelector('.word-card') && !!d.querySelector('.msg-img') && ix.version === 2, JSON.stringify({ msgs: ix.messages.map(m => ({ role: m.role, status: m.status, text: m.text, hasWord: !!m.word })), version: ix.version, dom: d.querySelectorAll('.msg').length, sending: ix.sending, uploadBusy: ix.uploadBusy }));
    await w.uploadPhoto(new w.File([image], 'fixture-again.png', { type: 'image/png' }));
    check('歧义时重拍推进版本并保留会话', ixOf() === ix && ix.version === 3 && d.querySelectorAll('.msg-img').length === 2 && d.querySelector('[data-focus="photo"]').textContent === '重拍或换一张', JSON.stringify({ version: ix.version, imgs: d.querySelectorAll('.msg-img').length, label: d.querySelector('[data-focus="photo"]')?.textContent, msgs: ix.messages.length, sending: ix.sending }));
    await contrastCheck('图片上传', ['.mode-photo', '.photo-pick', '.photo-hint']);
    await setEnv('MODEL_ENDPOINT', 'http://127.0.0.1:8766/valid');
    setDraft('左边的订书机');
    await w.sendTurn();
    check('图片澄清续聊呈现完整词卡', d.querySelector('.word-en')?.textContent === 'stapler' && !!d.querySelector('.word-ipa') && !!d.querySelector('.word-meaning') && !!d.querySelector('.word-practice') && ix.version === 4, JSON.stringify({ version: ix.version, word: d.querySelector('.word-en')?.textContent, msgs: ix.messages.map(m => ({ role: m.role, status: m.status, text: m.text })), dom: d.querySelectorAll('.msg').length, sending: ix.sending }));
    await contrastCheck('图片词卡', ['.mode-photo', '.photo-pick', '.photo-hint', '.word-en', '.word-ipa', '.word-meaning', '.word-practice']);
    for (const [width, font] of [[320, 16], [390, 16], [768, 16], [320, 32]]) {
      frame.style.width = `${width}px`; d.documentElement.style.fontSize = `${font}px`;
      await pause(200);
      check(`图片对话${width}px/${font / 16 * 100}%无横滚且输入上传可用`, d.documentElement.scrollWidth === d.documentElement.clientWidth && [...d.querySelectorAll('.turn-input,.turn-send,.photo-pick')].every(n => n.getBoundingClientRect().height >= 44));
    }
    frame.style.width = '390px'; d.documentElement.style.fontSize = '16px';
    await w.endInteraction();
    check('图片结束仅显示结束状态及16px图标而无印章', !!d.querySelector('.ix-closed') && d.querySelector('.ix-closed svg').getBoundingClientRect().width === 16 && !d.querySelector('.ticket-stamp'));
    await setEnv('MODEL_API_KEY', null);
    await setEnv('MODEL_ENDPOINT', null);
  }
  w.fetch = native;
  check('无脚本异常', errors.length === 0, errors.join(';'));
  window.b3 = w;
  window.b3Report = [...(window.b3Report || []), ...results];
  return { group, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed), results };
}
