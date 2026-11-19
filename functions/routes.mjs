import { SCENES, ENERGIES, BUDGETS, pickBuiltin } from './suggestions.mjs';
import { generateSuggestion } from './model.mjs';

const SCENE_SET = new Set(SCENES);
const ENERGY_SET = new Set(ENERGIES);
const BUDGET_SET = new Set(BUDGETS);
// The Sites Gateway does not forward application cookies, so the anonymous
// session travels as a bearer token in this custom header instead.
const SESSION_HEADER = 'x-whynot-session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CARD_COLUMNS = 'id,scene,energy,budget,category,title,first_step,detail,minutes,created_at,preference,completed';

// Dependency injection is only for local tests. index.ts retains Deno.serve.
// Ownership comes from the HttpOnly session cookie, never from client JSON.
export function application({ db, BackendError, env }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = result => {
    if (result?.error) fail(result.error.code || 'STORAGE_UNAVAILABLE', result.error.status || 503);
    return result.data;
  };

  async function digest(token) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function sessionToken(request) {
    const token = request.headers.get(SESSION_HEADER);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return token;
  }

  async function sessionOwner(request) {
    const token = sessionToken(request);
    if (!token) return null;
    const owner = await digest(token);
    const found = rows(await db.from('sessions').select('owner').eq('owner', owner).limit(1));
    return found?.length ? owner : null;
  }

  function newToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }

  function json(data, status = 200) {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    return new Response(JSON.stringify(data), { status, headers });
  }

  async function input(request) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('JSON_REQUIRED', 415);
    const reader = request.body?.getReader();
    if (!reader) fail('INVALID_BODY', 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2048) { await reader.cancel(); fail('INVALID_BODY', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) fail('INVALID_BODY', 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_BODY', 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_BODY', 400);
    return data;
  }

  function asCard(row) {
    return {
      id: row.id, scene: row.scene, energy: row.energy, budget: row.budget,
      category: row.category ?? null,
      title: row.title, first_step: row.first_step, detail: row.detail,
      minutes: row.minutes, created: row.created_at,
      preference: row.preference ?? null, completed: Boolean(row.completed),
    };
  }

  function validateContext(data) {
    const keys = Object.keys(data);
    if (keys.some(key => !['scene', 'energy', 'budget'].includes(key))
      || !keys.includes('energy') || !keys.includes('budget')) fail('INVALID_CONTEXT', 400);
    const { scene = null, energy, budget } = data;
    if (typeof energy !== 'string' || !ENERGY_SET.has(energy)
      || typeof budget !== 'number' || !Number.isInteger(budget) || !BUDGET_SET.has(budget)
      || (scene !== null && (typeof scene !== 'string' || !SCENE_SET.has(scene)))) fail('INVALID_CONTEXT', 400);
    return { scene, energy, budget };
  }

  async function recommend(owner, context) {
    const { scene, energy, budget } = context;
    const recent = rows(await db.from('recommendations').select('action,title,scene')
      .eq('owner', owner).order('created_at', { ascending: false }).limit(20))
      .filter(row => row.scene === scene).slice(0, 3);
    const feedback = rows(await db.from('recommendations').select('category,preference')
      .eq('owner', owner).limit(500));
    const scores = {};
    for (const row of feedback) {
      if (row.preference === 'like') scores[row.category] = (scores[row.category] ?? 0) + 1;
      if (row.preference === 'dislike') scores[row.category] = (scores[row.category] ?? 0) - 1;
    }
    let card = null;
    let source = 'builtin';
    const apiKey = env?.get('MODEL_API_KEY');
    if (apiKey) {
      card = await generateSuggestion({
        apiKey, budget, energy, scene,
        endpoint: env?.get('MODEL_ENDPOINT') || undefined,
        recentTitles: recent.map(row => row.title),
        liked: Object.keys(scores).filter(category => scores[category] > 0),
        disliked: Object.keys(scores).filter(category => scores[category] < 0),
      });
      if (card) source = 'model';
    }
    if (!card) {
      card = pickBuiltin({ scene, energy, budget, recentActions: recent.map(row => row.action), scores });
    }
    const id = crypto.randomUUID();
    rows(await db.from('recommendations').insert({
      id, owner, scene, energy, budget,
      action: card.action, category: card.category, title: card.title,
      first_step: card.first, detail: card.detail, minutes: card.minutes, source,
    }).select('id'));
    const saved = rows(await db.from('recommendations').select(CARD_COLUMNS).eq('id', id).limit(1));
    if (!saved?.length) fail('STORAGE_UNAVAILABLE', 503);
    return asCard(saved[0]);
  }

  async function feedback(owner, id, data) {
    if (Object.keys(data).length !== 1 || !['like', 'dislike', 'completed'].includes(data.kind)) fail('INVALID_FEEDBACK', 400);
    const found = rows(await db.from('recommendations').select('id').eq('id', id).eq('owner', owner).limit(1));
    if (!found?.length) fail('NOT_FOUND', 404);
    if (data.kind === 'completed') {
      rows(await db.from('recommendations').update({ completed: true })
        .eq('id', id).eq('owner', owner).eq('completed', false).select('id'));
    } else {
      rows(await db.from('recommendations').update({ preference: data.kind })
        .eq('id', id).eq('owner', owner).select('id'));
    }
    const saved = rows(await db.from('recommendations').select(CARD_COLUMNS).eq('id', id).eq('owner', owner).limit(1));
    if (!saved?.length) fail('NOT_FOUND', 404);
    return asCard(saved[0]);
  }

  return async ctx => {
    const request = ctx.request;
    // Gateway preserves the suffix but replaces app with the deployment's
    // physical Function name. Provider may strip /functions/v1 before invocation.
    const pathname = new URL(request.url).pathname;
    const match = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!match) fail('NOT_FOUND', 404);
    const path = match[1] || '/';

    if (path === '/api/health' && request.method === 'GET') return json({ ok: true });

    if (path === '/api/session' && request.method === 'POST') {
      if (await sessionOwner(request)) return json({ ok: true });
      const token = newToken();
      rows(await db.from('sessions').insertIfAbsent({ owner: await digest(token) }, { onConflict: 'owner' }).select('owner'));
      return json({ ok: true, token });
    }

    if (path === '/api/recommendations' && request.method === 'POST') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      const context = validateContext(await input(request));
      return json(await recommend(owner, context), 201);
    }

    const item = path.match(/^\/api\/recommendations\/([^/]+)\/feedback$/);
    if (item && request.method === 'POST') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      if (!UUID.test(item[1])) fail('NOT_FOUND', 404);
      return json(await feedback(owner, item[1], await input(request)));
    }

    fail('NOT_FOUND', 404);
  };
}