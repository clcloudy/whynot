const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

export default async function run(group = 'state') {
  const results = [];
  const check = (name, condition, detail = '') => results.push({ name, passed: !!condition, detail });
  document.getElementById('b3-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'b3-frame';
  frame.title = 'B3 本地验收';
  frame.style.cssText = 'width:390px;height:844px;border:0;display:block;margin:auto';
  const loaded = new Promise(resolve => frame.onload = resolve);
  frame.src = `${location.origin}/?b3=${Date.now()}`;
  document.body.append(frame);
  await loaded;
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
      await new Promise(resolve => w.requestAnimationFrame(resolve));
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
    await new Promise(resolve => w.requestAnimationFrame(resolve));
    const keys = [...d.querySelectorAll('.card-actions button')].map(e => e.getBoundingClientRect());
    const segments = [...d.querySelectorAll('.seg label')].map(e => e.getBoundingClientRect());
    check('200%无横向滚动', d.documentElement.scrollWidth === d.documentElement.clientWidth);
    check('200%四键2×2且≥44', keys[0].top === keys[1].top && keys[2].top === keys[3].top && keys[2].top > keys[0].top && keys.every(r => r.height >= 44 && r.width >= 44));
    check('200%分段2×2', segments[0].top === segments[1].top && segments[2].top === segments[3].top && segments[2].top > segments[0].top);
    check('200%第一步与耗时不裁切', d.querySelector('.first-text').scrollHeight <= d.querySelector('.first-text').clientHeight && d.querySelector('.badge').scrollHeight <= d.querySelector('.badge').clientHeight);
  }
  w.fetch = native;
  check('无脚本异常', errors.length === 0, errors.join(';'));
  window.b3 = w;
  window.b3Report = [...(window.b3Report || []), ...results];
  return { group, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed), results };
}
