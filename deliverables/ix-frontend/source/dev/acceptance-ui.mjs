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
  const select = (name, value) => click(`input[name="${name}"][value="${value}"]`);
  const feedback = kind => { d.querySelector(`[data-focus="${kind}"]`).focus(); return w.sendFeedback(kind); };
  const response = (code, status = 400) => w.Response.json({ error: code }, { status });
  const style = d.createElement('style');
  style.textContent = ':root { scrollbar-width: none; }';
  d.head.append(style);
  await w.ensureSession();
  check('首屏不抢焦点', d.activeElement === d.body);
  await w.ask();
  check('主按钮生成后焦点到标题', d.activeElement.id === 'card-title');
  check('整卡不是 live region', !d.getElementById('result').hasAttribute('aria-live'));
  check('卡片关联标题与第一步', d.querySelector('.card').getAttribute('aria-labelledby') === 'card-title' && d.querySelector('.card').getAttribute('aria-describedby') === 'card-first');

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
    w.fetch = async (url, init) => { if (String(url).endsWith('/api/recommendations')) { seen.push(JSON.parse(init.body)); await gate.promise; } return native(url, init); };
    select('budget', '10');
    state().sessionReady = false;
    const pending = w.ask();
    select('budget', '3');
    gate.resolve(); await pending;
    check('会话等待前快照条件', seen.length === 1 && seen[0].budget === 10 && state().conditions.budget === 10);
    check('改条件不自动提交', seen.length === 1);
    check('旧条件标注与新条件按钮', d.querySelector('.condition-note').textContent === '按 10 分钟生成' && d.querySelector('[data-focus="swap"]').textContent === '按新条件再来一条');
    check('编辑表单期间返回不抢焦点', d.activeElement.id === 'b3');
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
    click('.retry');
    while (state().busy) await pause(10);
    check('重试仍使用失败请求快照', recovered.length === 1 && recovered[0].budget === 10 && state().card.minutes <= 10 && w.conditions().budget === 3);

    w.fetch = native;
    await w.ask();
    let feedbackCalls = 0;
    w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) { feedbackCalls++; return native(String(url).replace(state().card.id, 'invalid-id'), init); } return native(url, init); };
    await feedback('like');
    check('无效编号实际API返回404，仅留换一个', feedbackCalls === 1 && !d.querySelector('.card') && d.querySelector('.retry').textContent === '换一个' && d.querySelector('.notice-title').textContent.includes('这条建议找不到了'));

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
      check(`${code}不重试`, calls === 1 && !d.querySelector('.retry') && d.querySelector('.notice-title').textContent.includes('刷新页面'));
    }
    w.fetch = async (url, init) => String(url).endsWith('/api/recommendations') ? new w.Response('{bad') : native(url, init);
    await w.ask();
    check('无效响应可手动重试', d.querySelector('.notice-title').textContent.includes('不完整') && !!d.querySelector('.retry'));
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
    check('生成中aria-busy且条件可用', d.getElementById('result').getAttribute('aria-busy') === 'true' && !d.querySelector('#b3').disabled);
    await pause(8100);
    check('8秒只更新视觉文案', d.querySelector('.sk-text').textContent === '还在找，再等一下' && d.getElementById('status').textContent === '正在找建议');
    await pending;
    check('真实25秒超时文案且保留旧卡', timeoutMs === 25000 && d.querySelector('.notice-title').textContent.includes('等太久了') && state().card.id === retained);
    check('结束清理加载状态', d.getElementById('result').getAttribute('aria-busy') === 'false' && !d.getElementById('ask').disabled && !d.querySelector('.skeleton'));
    w.AbortSignal.timeout = nativeTimeout;
    w.fetch = native;
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => false });
    await w.ask();
    check('离线保留卡片并禁用换一个', !!d.querySelector('.card') && d.querySelector('[data-focus="swap"]').disabled && d.querySelector('.notice-title').getAttribute('role') === 'status');
    let sent = 0;
    w.fetch = (url, init) => { sent++; return native(url, init); };
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => true });
    w.dispatchEvent(new w.Event('online'));
    check('网络恢复就地提示，不自动提交', sent === 0 && d.querySelector('.notice-title').textContent.includes('网络回来了') && !d.querySelector('.retry').disabled);
    click('.retry'); while (state().busy) await pause(10);
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
      check(`${width}px四键一行且均≥44`, sizes.every(r => r.width >= 44 && r.height >= 44 && r.top === sizes[0].top), JSON.stringify(sizes.map(r => [r.width, r.height])));
      check(`${width}px四键等宽`, Math.max(...sizes.map(r => r.width)) - Math.min(...sizes.map(r => r.width)) < 1);
      if (width === 390) check('390px卡宽350', card.width === 350);
      if (width === 768) check('768px单列480居中', d.querySelector('.page').offsetWidth === 480 && d.querySelector('.page').getBoundingClientRect().left === 144);
    }
    frame.style.width = '320px'; frame.style.height = '568px';
    d.documentElement.style.fontSize = '32px';
    await pause(50);
    const keys = [...d.querySelectorAll('.card-actions button')].map(e => e.getBoundingClientRect());
    const segments = [...d.querySelectorAll('.seg label')].map(e => e.getBoundingClientRect());
    check('200%无横向滚动', d.documentElement.scrollWidth === d.documentElement.clientWidth);
    check('200%四键2×2且≥44', keys[0].top === keys[1].top && keys[2].top === keys[3].top && keys[2].top > keys[0].top && keys.every(r => r.height >= 44 && r.width >= 44));
    check('200%分段2×2', segments[0].top === segments[1].top && segments[2].top === segments[3].top && segments[2].top > segments[0].top);
    check('200%第一步与耗时不裁切', d.querySelector('.first-text').scrollHeight <= d.querySelector('.first-text').clientHeight && d.querySelector('.badge').scrollHeight <= d.querySelector('.badge').clientHeight);
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
        select('theme', theme);
        const expected = theme === 'dark' || (theme === 'system' && dark);
        check(`CSS系统${dark ? '深' : '浅'}色/选择${theme}`, w.getComputedStyle(d.body).backgroundColor === (expected ? 'rgb(24, 33, 28)' : 'rgb(246, 241, 231)') && w.getComputedStyle(root).colorScheme === (expected ? 'dark' : 'light'));
        check(`主题${theme}/系统${dark}同步meta及阴影`, [...d.querySelectorAll('meta[name="theme-color"]')].every(meta => meta.content === ((theme === 'dark' || (theme === 'system' && meta.media.includes('dark'))) ? '#18211c' : '#f6f1e7')) && (w.getComputedStyle(d.querySelector('.card')).boxShadow === 'none') === expected);
      }
    }
    media.forEach((rule, i) => { rule.media.mediaText = originalMedia[i]; });
    select('theme', 'dark');
    check('显式主题写入存储', w.localStorage.getItem(key) === 'dark');
    select('theme', 'system');
    check('跟随系统清除覆盖值', w.localStorage.getItem(key) === null && !root.hasAttribute('data-theme'));
    const setItem = w.Storage.prototype.setItem;
    w.Storage.prototype.setItem = () => { throw new w.DOMException('test', 'QuotaExceededError'); };
    select('theme', 'dark');
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
    check('外部app运行前已是深色且回访引导隐藏', p.document.documentElement.dataset.theme === 'dark' && p.getComputedStyle(p.document.body).backgroundColor === 'rgb(24, 33, 28)' && p.getComputedStyle(p.document.getElementById('guide')).display === 'none');
    check('外部app运行前主题meta已同步', [...p.document.querySelectorAll('meta[name="theme-color"]')].every(m => m.content === '#18211c'));
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
    for (const [path, size] of [['/apple-touch-icon.png', 180], ['/icon-192.png', 192], ['/icon-512.png', 512]]) {
      const r = await native(path), image = await w.createImageBitmap(await r.blob());
      check(`安装图标${size}px有效`, r.ok && r.headers.get('content-type').includes('image/png') && image.width === size && image.height === size);
      image.close();
    }
    check('文档关联manifest及Apple图标', d.querySelector('link[rel="manifest"]').getAttribute('href') === '/manifest.webmanifest' && d.querySelector('link[rel="apple-touch-icon"]').getAttribute('sizes') === '180x180');
  }
  if (group === 'ix') {
    const until = async fn => { for (let i = 0; i < 800 && !fn(); i++) await pause(10); };
    const ixOf = () => w.eval('state.ix');
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
    check('第一轮回复上卡且版本推进', ix.messages.length === 2 && ix.messages[1].role === 'ai' && ix.version === 2 && d.querySelectorAll('.msg').length === 2);

    const bodies = [];
    w.fetch = (url, init) => { if (String(url).endsWith('/turns')) bodies.push(JSON.parse(init.body)); return native(url, init); };
    setDraft('第二轮的话');
    await w.sendTurn();
    check('第二轮使用第一次回复的版本', bodies[0].version === 2 && ix.version === 3 && ix.messages.length === 4);

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
    check('重试复用同一UUID版本与内容', retryBodies[1].request_id === failedId && retryBodies[1].version === failedVersion && retryBodies[1].text === '会失败的一句' && ix.messages.at(-1).status === 'sent');

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
    await w.sendFeedback('completed');
    check('小行动完成态沿用分享行', w.eval('state.card.completed') && !!d.querySelector('.done-row'));

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
    click('#settings-toggle');
    w.fetch = native;
    await setEnv('MODEL_API_KEY', null);
    await setEnv('MODEL_ENDPOINT', null);
  }
  w.fetch = native;
  check('无脚本异常', errors.length === 0, errors.join(';'));
  window.b3 = w;
  window.b3Report = [...(window.b3Report || []), ...results];
  return { group, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed), results };
}
