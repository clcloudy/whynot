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

    for (const [code, http] of [['STORAGE_UNAVAILABLE', 503], ['unique_violation', 409]]) {
      const times = [];
      w.fetch = (url, init) => { if (String(url).endsWith('/feedback')) { times.push(performance.now()); return Promise.resolve(response(code, http)); } return native(url, init); };
      await feedback('dislike');
      check(`${http}只重试一次且退避800ms`, times.length === 2 && times[1] - times[0] >= 790 && d.getElementById('feedback-status').textContent.includes('现在有点忙'));
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
    check('200%第一步与耗时不裁切', d.querySelector('.first-text').scrollHeight <= d.querySelector('.first-text').clientHeight && d.querySelector('.gauge-label').scrollHeight <= d.querySelector('.gauge-label').clientHeight);
  }
  if (group === 'polish') {
    const root = d.documentElement, css = node => w.getComputedStyle(node);
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
    check('首访三行引导在外部脚本前可见且措辞准确', [...p.document.querySelectorAll('.guide p')].map(n => n.textContent).join('/') === '选好时间与精力/出一张现在能做的事/不合适就换一张' && p.getComputedStyle(p.document.getElementById('guide')).display !== 'none');
    check('首帧显式深色与页外文字同步', p.document.documentElement.dataset.theme === 'dark' && p.getComputedStyle(p.document.querySelector('.guide p')).color === 'rgb(167, 177, 201)' && !p.document.querySelector('script[src="/app.js"]') && typeof p.ask !== 'function');
    p = await load(html); await p.ensureSession();
    const pFetch = p.fetch.bind(p);
    p.fetch = (url, init) => String(url).endsWith('/api/recommendations') ? Promise.reject(new TypeError('test offline')) : pFetch(url, init);
    await p.ask();
    check('首次出票失败不收起引导也不写seen', !p.document.getElementById('guide').hidden && p.localStorage.getItem('whynot-guide') === null);
    p.fetch = pFetch;
    const pending = p.ask();
    check('生成中可访问名称含出票中且条件仍可编辑', p.document.getElementById('ask').getAttribute('aria-label').includes('出票中') && !p.document.querySelector('#b3').disabled);
    await pending;
    check('首次成功收起引导并写seen而条件常驻', p.document.getElementById('guide').hidden && p.localStorage.getItem('whynot-guide') === 'seen' && p.getComputedStyle(p.document.querySelector('.panel')).display !== 'none');
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
    probe.remove();
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
    check('页眉显示本地日期且主按钮名称含可见文案', d.getElementById('masthead-date').textContent === `${date.getMonth() + 1}月${date.getDate()}日` && d.getElementById('ask').getAttribute('aria-label').includes('出一张现在'));
    click('#settings-toggle');
    d.getElementById('feedback-status').textContent = '记为喜欢，可以改。';
    const rgb = color => color.match(/[\d.]+/g).map(Number);
    const luminance = color => rgb(color).slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
    const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const background = node => {
      while (node) { const color = css(node).backgroundColor, values = rgb(color); if (values.length === 3 || values[3] === 1) return color; node = node.parentElement; }
      return 'rgb(255,255,255)';
    };
    const rules = [...d.styleSheets].flatMap(sheet => [...sheet.cssRules]);
    const media = rules.filter(rule => rule.media?.mediaText.includes('prefers-color-scheme'));
    const savedMedia = media.map(rule => rule.media.mediaText);
    const activeRule = rules.find(rule => rule.selectorText === '.primary:active');
    const ask = d.getElementById('ask'), cardId = state().card.id;
    let themeRequests = 0;
    w.fetch = (url, init) => { themeRequests++; return native(url, init); };
    const textSelectors = ['.masthead .brand-name', '.masthead-date', '.guide p', '.panel legend', '.scene-label', '.scene-value', '.foot', '.settings', '.about h2', '.about p', '.about legend', '.share-note', '.card h2', '.first-label', '.first-text', '.detail', '.cat', '.gauge-label', '.feedback button', '.swap', '.primary'];
    for (const dark of [false, true]) {
      media.forEach(rule => { rule.media.mediaText = dark ? 'all' : 'not all'; });
      for (const theme of ['system', 'light', 'dark']) {
        w.applyTheme(theme); await pause(200);
        const key = `系统${dark ? '深' : '浅'}/${theme}`;
        const contrasts = textSelectors.flatMap(selector => [...d.querySelectorAll(selector)].map(node => ({ selector, ratio: contrast(css(node).color, background(node)) })));
        check(`${key}页外与票面普通文字对比度≥4.5`, contrasts.every(x => x.ratio >= 4.5), JSON.stringify(contrasts));
        const shadows = [...d.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().width > 0 && css(node).boxShadow !== 'none');
        const expectedDark = theme === 'dark' || (theme === 'system' && dark);
        check(`${key}仅浅色票面有黑色8px投影`, expectedDark ? shadows.length === 0 : shadows.length === 1 && shadows[0].classList.contains('card') && css(shadows[0]).boxShadow === 'rgba(0, 0, 0, 0.14) 0px 4px 8px 0px');
        activeRule.selectorText = '.primary.test-active'; ask.classList.add('test-active');
        await pause(150);
        check(`${key}按压态米白字对深橙≥4.5`, css(ask).color === 'rgb(246, 242, 232)' && contrast(css(ask).color, css(ask).backgroundColor) >= 4.5);
        ask.classList.remove('test-active'); activeRule.selectorText = '.primary:active'; await pause(150);
        check(`${key}场景主题与换票不扩散橙色`, [...d.querySelectorAll('input[name="scene"]:checked + label,input[name="theme"]:checked + label')].every(n => css(n).backgroundColor !== css(ask).backgroundColor) && css(d.querySelector('.swap')).color === 'rgb(27, 35, 52)');
        for (const node of [settings, d.querySelector('.card h2')]) {
          node.focus({ preventScroll: true });
          check(`${key}/${node === settings ? '页脚' : '票面'}焦点对表面≥3`, css(node).outlineStyle === 'solid' && contrast(css(node).outlineColor, background(node)) >= 3);
        }
        d.getElementById('theme-system').focus({ preventScroll: true });
        const themeLabel = d.querySelector('label[for="theme-system"]');
        check(`${key}主题单选外圈对页底≥3`, css(themeLabel).outlineStyle === 'solid' && contrast(css(themeLabel).outlineColor, css(d.body).backgroundColor) >= 3);
      }
    }
    media.forEach((rule, i) => { rule.media.mediaText = savedMedia[i]; });
    check('切换主题不改票据或提交请求', state().card.id === cardId && !state().busy && themeRequests === 0);
    w.fetch = native;
    const boxes = () => [...d.querySelectorAll('.masthead,.panel,.primary,.card,.card *,.foot,.about,.about *')].map(node => { const r = node.getBoundingClientRect(); return [r.left + w.scrollX, r.top + w.scrollY, r.width, r.height]; });
    for (const [width, font] of [[320, 16], [390, 16], [768, 16], [320, 32]]) {
      frame.style.width = `${width}px`; root.style.fontSize = `${font}px`;
      w.applyTheme('light'); await pause(200); const light = boxes();
      w.applyTheme('dark'); await pause(200); const dark = boxes();
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
      return [r.top, r.left, r.width, r.height];
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
      const beforeChange = geometry();
      await w.sendFeedback(kind);
      check(`${key}改选图形不引发布局位移`, sameGeometry(beforeChange, geometry()));
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
    check('印章出现时出票按钮不可见', css(d.getElementById('ask')).visibility === 'hidden');
    failedGate.resolve(); await failed;
    check('完成失败完整回滚且按钮恢复', !state().card.completed && !d.querySelector('.ticket-stamp, .done-row') && css(d.querySelector('.card')).maskImage === 'none' && css(d.querySelector('.g-line line')).strokeDasharray !== 'none' && css(d.getElementById('ask')).visibility === 'visible' && d.activeElement.dataset.focus === 'completed' && !!d.getElementById('feedback-status').textContent);

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
    check('完成票退场期间主按钮仍隐藏', css(d.getElementById('ask')).visibility === 'hidden');
    check('完成票实际播放160ms退场动画', css(d.querySelector('.card')).animationName === 'out' && css(d.querySelector('.card')).animationDuration === '0.16s');
    await pause(200);
    check('骨架接管后主按钮恢复且在途禁用', !!d.querySelector('.skeleton') && css(d.getElementById('ask')).visibility === 'visible' && d.getElementById('ask').disabled);
    swapGate.resolve(); await swap;
    check('换票失败保留完成票及重试入口', !!d.querySelector('.ticket-done') && !!d.querySelector('.retry') && css(d.getElementById('ask')).visibility === 'hidden' && recommendations === 1 && sent === 0);
    check('换票失败回显保留完成区高度', Math.abs(d.querySelector('.done-row').getBoundingClientRect().height - retainedHeight) < 1);
    const seen = [];
    select('budget', '3');
    w.fetch = (url, init) => { if (String(url).endsWith('/api/recommendations')) seen.push(JSON.parse(init.body)); return native(url, init); };
    click('.retry'); while (state().busy) await pause(10);
    check('完成后失败重试仍重放条件快照', seen.length === 1 && seen[0].budget === 10 && w.conditions().budget === 3 && !state().card.completed && css(d.getElementById('ask')).visibility === 'visible');

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
        select('theme', theme);
        const expected = theme === 'dark' || (theme === 'system' && dark);
        check(`CSS系统${dark ? '深' : '浅'}色/选择${theme}`, w.getComputedStyle(d.body).backgroundColor === (expected ? 'rgb(16, 24, 39)' : 'rgb(234, 240, 248)') && w.getComputedStyle(root).colorScheme === (expected ? 'dark' : 'light'));
        check(`主题${theme}/系统${dark}同步meta及阴影`, [...d.querySelectorAll('meta[name="theme-color"]')].every(meta => meta.content === ((theme === 'dark' || (theme === 'system' && meta.media.includes('dark'))) ? '#101827' : '#eaf0f8')) && (w.getComputedStyle(d.querySelector('.card')).boxShadow === 'none') === expected);
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
    check('外部app运行前已是深色且回访引导隐藏', p.document.documentElement.dataset.theme === 'dark' && p.getComputedStyle(p.document.body).backgroundColor === 'rgb(16, 24, 39)' && p.getComputedStyle(p.document.getElementById('guide')).display === 'none');
    check('外部app运行前主题meta已同步', [...p.document.querySelectorAll('meta[name="theme-color"]')].every(m => m.content === '#101827'));
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
    w.fetch = (url, init) => { network++; return native(url, init); };
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
  w.fetch = native;
  check('无脚本异常', errors.length === 0, errors.join(';'));
  window.b3 = w;
  window.b3Report = [...(window.b3Report || []), ...results];
  return { group, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed), results };
}
