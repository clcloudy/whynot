import { SCENES, ENERGIES, BUDGETS, pickBuiltin } from './suggestions.mjs';
import { generateSuggestion, generateOpening, generateReply, generateVisionWord } from './model.mjs';
import { pickOpening, builtinOpening, CHAT_TOPICS, DISCUSS_TOPICS } from './interactions.mjs';

const SCENE_SET = new Set(SCENES);
const ENERGY_SET = new Set(ENERGIES);
const BUDGET_SET = new Set(BUDGETS);
// The Sites Gateway does not forward application cookies, so the anonymous
// session travels as a bearer token in this custom header instead.
const SESSION_HEADER = 'x-whynot-session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CARD_COLUMNS = 'id,scene,energy,budget,category,title,first_step,detail,minutes,created_at,preference,completed';
const INTERACTION_COLUMNS = 'id,mode,topic,state,version,scene,energy,budget,payload_hash,word,memory_id,memory_version,last_activity,pending_image_id';
const TURN_COLUMNS = 'id,version,payload_hash,reply_text,word,recall';
const GENERIC_REPLY = '愿意的话，可以说说现在最想聊的事。';
const NO_MEMORY_REPLY = '没有找到你保存过的相关记录。';
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TTL_MS = 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_TTL_MS = { status: 30 * 24 * 60 * 60 * 1000, word: 90 * 24 * 60 * 60 * 1000 };
const REVISIT_PROBABILITY = 0.25;
const REVISIT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const RECALL_INTENT = /(上次|之前).{0,12}(说|提到|讲|记住)/;

// Ownership comes from the verified session header, never from client JSON.
export function application({ db, BackendError, env, validateImage, random = Math.random, now = Date.now }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = result => {
    if (result?.error) fail(result.error.code || 'STORAGE_UNAVAILABLE', result.error.status || 503);
    return result.data;
  };
  const at = () => new Date(now()).toISOString();
  function transaction(owner, work) {
    if (!db.transaction) fail('STORAGE_UNAVAILABLE', 503);
    return db.transaction(owner, work);
  }

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

  async function binaryInput(request, limit) {
    const reader = request.body?.getReader();
    if (!reader) fail('INVALID_BODY', 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); fail('IMAGE_TOO_LARGE', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) fail('INVALID_BODY', 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }

  function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
    return null;
  }

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function uuidFrom(seed) {
    const hex = await digest(seed);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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

  function validateInteractionContext(data) {
    const allowed = ['scene', 'energy', 'budget', 'request_id', 'replaces', 'supports'];
    const keys = Object.keys(data);
    if (keys.some(key => !allowed.includes(key))
      || !keys.includes('energy') || !keys.includes('budget') || !keys.includes('request_id')) fail('INVALID_CONTEXT', 400);
    const context = validateContext({ scene: data.scene ?? null, energy: data.energy, budget: data.budget });
    if (typeof data.request_id !== 'string' || !UUID.test(data.request_id)) fail('INVALID_CONTEXT', 400);
    const replaces = data.replaces ?? null;
    if (replaces !== null && (typeof replaces !== 'string' || !UUID.test(replaces))) fail('INVALID_CONTEXT', 400);
    const supports = data.supports ?? ['text'];
    if (!Array.isArray(supports) || !supports.length || supports.some(type => !['text', 'image'].includes(type))) fail('INVALID_CONTEXT', 400);
    return { ...context, requestId: data.request_id, replaces, supports: [...supports].sort() };
  }

  function validateTurn(data) {
    const keys = Object.keys(data);
    const allowed = ['request_id', 'version', 'text', 'image_ref'];
    if (keys.some(key => !allowed.includes(key)) || !keys.includes('request_id') || !keys.includes('version')) fail('INVALID_TURN', 400);
    if (typeof data.request_id !== 'string' || !UUID.test(data.request_id)) fail('INVALID_TURN', 400);
    if (!Number.isInteger(data.version) || data.version < 1) fail('INVALID_TURN', 400);
    const hasText = data.text !== undefined;
    const hasImage = data.image_ref !== undefined;
    if (hasText === hasImage) fail('INVALID_TURN', 400);
    if (hasImage) {
      if (typeof data.image_ref !== 'string' || !UUID.test(data.image_ref)) fail('INVALID_TURN', 400);
      return { requestId: data.request_id, version: data.version, text: null, imageRef: data.image_ref };
    }
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 500 || /[\u0000-\u001f]/.test(text)) fail('INVALID_TURN', 400);
    return { requestId: data.request_id, version: data.version, text, imageRef: null };
  }

  async function ownedInteraction(db, owner, id) {
    const [found] = rows(await db.from('interactions').select(INTERACTION_COLUMNS).eq('id', id).eq('owner', owner).limit(1));
    if (!found) fail('NOT_FOUND', 404);
    return found;
  }

  function topicFor({ mode, topic }) {
    const pool = mode === 'chat' ? CHAT_TOPICS : mode === 'discuss' ? DISCUSS_TOPICS : [];
    return pool.find(item => item.topic === topic);
  }

  async function activeMemory(db, owner, id, version, timestamp) {
    if (!id) return null;
    return rows(await db.from('memories').select('id,text,version')
      .eq('owner', owner).eq('id', id).eq('version', version).gt('expires_at', timestamp).limit(1))[0];
  }

  async function openingCard(db, owner, interaction, timestamp) {
    const [saved] = rows(await db.from('recommendations').select(CARD_COLUMNS)
      .eq('id', interaction.id).eq('owner', owner).limit(1));
    if (!saved) fail('STORAGE_UNAVAILABLE', 503);
    const card = asCard(saved);
    const memory = await activeMemory(db, owner, interaction.memory_id, interaction.memory_version, timestamp);
    if (memory) card.first_step = `上次你说「${memory.text}」，最近怎么样了？`;
    return { card, memory };
  }

  async function interactionResponse(db, owner, interaction, status, timestamp) {
    const presented = idleExpired(interaction)
      ? { ...interaction, state: 'expired', word: null, memory_id: null }
      : interaction;
    const { card } = await openingCard(db, owner, presented, timestamp);
    const { mode, topic, state, version, word } = presented;
    return json({
      ...card, mode, topic, state, version,
      expected_input: state === 'awaiting_image' ? 'image' : state === 'open' ? 'text' : 'none',
      ...(word ? { word } : {}),
    }, status);
  }

  async function openingReplay(db, owner, requestId, payloadHash, timestamp) {
    const [existing] = rows(await db.from('interactions').select(INTERACTION_COLUMNS)
      .eq('owner', owner).eq('request_id', requestId).limit(1));
    if (!existing) return null;
    if (existing.payload_hash !== payloadHash) fail('REQUEST_CONFLICT', 409);
    return interactionResponse(db, owner, existing, 200, timestamp);
  }

  async function revisitCandidate(db, owner, topic) {
    const timestamp = at();
    const cutoff = new Date(now() - REVISIT_COOLDOWN_MS).toISOString();
    const eligible = () => db.from('memories').select('id,version')
      .eq('owner', owner).eq('kind', 'status').gt('expires_at', timestamp).lt('last_prompted_at', cutoff)
      .order('last_prompted_at').order('id').limit(1);
    return rows(await eligible().eq('topic', topic))[0] ?? rows(await eligible())[0];
  }

  async function createInteraction(owner, request) {
    const { requestId, replaces, supports, ...context } = validateInteractionContext(await input(request));
    const payloadHash = await digest(JSON.stringify([context.scene, context.energy, context.budget, replaces, supports]));
    const apiKey = env?.get('MODEL_API_KEY');
    const imageReady = Boolean(apiKey) && supports.includes('image');
    const prepared = await transaction(owner, async db => {
      const replay = await openingReplay(db, owner, requestId, payloadHash, at());
      if (replay) return { replay };
      const exclude = replaces ? await ownedInteraction(db, owner, replaces) : null;
      const history = rows(await db.from('interactions').select('mode,topic')
        .eq('owner', owner).order('created_at', { ascending: false }).order('opening_seq', { ascending: false }).limit(3));
      const draw = pickOpening({ context, history, exclude, imageReady, random });
      const revisit = draw.mode === 'chat' && random() < REVISIT_PROBABILITY
        ? await revisitCandidate(db, owner, draw.topic) : null;
      return { ...draw, revisit };
    });
    if (prepared.replay) return prepared.replay;

    const { mode, topic, revisit } = prepared;
    const builtin = builtinOpening(mode, topic, context);
    const generated = apiKey && !revisit && (mode === 'chat' || mode === 'discuss')
      ? await generateOpening({
        apiKey, mode, topic: topicFor(prepared), ...context, endpoint: env?.get('MODEL_ENDPOINT') || undefined,
      }) : null;
    const card = generated ?? builtin;
    const cardId = await uuidFrom(`${owner}:${requestId}`);
    const state = mode === 'micro' ? 'card' : mode === 'photo' ? 'awaiting_image' : 'open';

    return transaction(owner, async db => {
      const timestamp = at();
      const replay = await openingReplay(db, owner, requestId, payloadHash, timestamp);
      if (replay) return replay;
      const claimed = revisit && rows(await db.from('memories').update({ last_prompted_at: timestamp })
        .eq('id', revisit.id).eq('owner', owner).eq('version', revisit.version).gt('expires_at', timestamp)
        .lt('last_prompted_at', new Date(now() - REVISIT_COOLDOWN_MS).toISOString()).select('id'))[0];
      const values = {
        ...context, action: mode === 'micro' ? topic : generated ? 'model' : 'builtin',
        category: builtin.category, title: card.title, first_step: card.first, detail: card.detail,
        minutes: card.minutes, source: generated ? 'model' : 'builtin',
      };
      const inserted = rows(await db.from('recommendations')
        .insertIfAbsent({ id: cardId, owner, ...values }, { onConflict: 'id' }).select('id'));
      if (!inserted.length) {
        // A card orphaned by a previous release can be repaired on retry.
        const repaired = rows(await db.from('recommendations').update(values).eq('id', cardId).eq('owner', owner).select('id'));
        if (!repaired.length) fail('STORAGE_UNAVAILABLE', 503);
      }
      const [interaction] = rows(await db.from('interactions').insert({
        id: cardId, owner, request_id: requestId, payload_hash: payloadHash,
        mode, topic, state, version: 1, is_replacement: Boolean(replaces), ...context,
        memory_id: claimed ? revisit.id : null, memory_version: claimed ? revisit.version : null,
        is_revisit: Boolean(claimed), created_at: timestamp, last_activity: timestamp,
      }).select(INTERACTION_COLUMNS));
      if (replaces) await db.clearInteraction(owner, replaces, 'closed');
      return interactionResponse(db, owner, interaction, 201, timestamp);
    });
  }

  function idleExpired(interaction) {
    return ['open', 'awaiting_image'].includes(interaction.state)
      && new Date(interaction.last_activity).getTime() <= now() - IDLE_TTL_MS;
  }

  function checkConversational(interaction) {
    if (interaction.state === 'expired' || idleExpired(interaction)) fail('TURN_EXPIRED', 409);
    if (!['open', 'awaiting_image'].includes(interaction.state)) fail('NOT_CONVERSATIONAL', 409);
  }

  async function candidateFor(db, owner, turnId, timestamp) {
    return rows(await db.from('memory_candidates').select('id,text,kind,topic,version,expires_at')
      .eq('owner', owner).eq('turn_id', turnId).eq('status', 'pending').gt('expires_at', timestamp).limit(1))[0];
  }

  async function dependenciesValid(db, owner, dependencies, timestamp) {
    for (const { memory_id, version } of dependencies) {
      if (!await activeMemory(db, owner, memory_id, version, timestamp)) return false;
    }
    return true;
  }

  async function dependenciesOf(db, turnId) {
    return rows(await db.from('turn_memories').select('memory_id,version').eq('turn_id', turnId));
  }

  function turnResponse(turn, candidate, status) {
    return json({
      id: turn.id, reply: turn.reply_text, version: turn.version + 1,
      ...(turn.word ? { word: turn.word } : {}),
      ...(turn.recall ? { recall: true } : {}),
      ...(candidate ? { candidate } : {}),
    }, status);
  }

  async function turnReplay(db, owner, id, requestId, payloadHash, timestamp) {
    const [prior] = rows(await db.from('turns').select(TURN_COLUMNS)
      .eq('owner', owner).eq('interaction_id', id).eq('request_id', requestId).limit(1));
    if (!prior) return null;
    if (prior.payload_hash !== payloadHash) fail('REQUEST_CONFLICT', 409);
    const dependencies = await dependenciesOf(db, prior.id);
    if (!prior.reply_text || !await dependenciesValid(db, owner, dependencies, timestamp)) {
      return turnResponse({ ...prior, reply_text: prior.recall ? NO_MEMORY_REPLY : GENERIC_REPLY, word: null }, null, 200);
    }
    return turnResponse(prior, await candidateFor(db, owner, prior.id, timestamp), 200);
  }

  async function getImage(db, owner, interaction, imageRef) {
    const query = db.from('images').select('id,mime,data,expires_at,version')
      .eq('owner', owner).eq('interaction_id', interaction.id);
    if (imageRef) query.eq('id', imageRef);
    else query.eq('version', interaction.version).order('created_at', { ascending: false }).order('id', { ascending: false });
    return rows(await query.limit(1))[0];
  }

  async function prepareTurn(db, owner, id, turn, payloadHash, recall) {
    const interaction = await ownedInteraction(db, owner, id);
    checkConversational(interaction);
    const timestamp = at();
    const replay = await turnReplay(db, owner, id, turn.requestId, payloadHash, timestamp);
    if (replay) return { replay };
    if (turn.imageRef && interaction.state !== 'awaiting_image') fail('INVALID_TURN', 400);
    if (turn.version !== interaction.version) fail('TURN_EXPIRED', 409);

    if (interaction.state === 'awaiting_image') {
      let image = await getImage(db, owner, interaction, turn.imageRef);
      if (!image && !turn.imageRef && interaction.pending_image_id) {
        image = await getImage(db, owner, interaction, interaction.pending_image_id);
      }
      if (turn.imageRef && !image) fail('NOT_FOUND', 404);
      if (!image) fail('IMAGE_REQUIRED', 409);
      if (new Date(image.expires_at).getTime() <= now()) fail('IMAGE_EXPIRED', 409);
      if (turn.imageRef && image.version !== turn.version) fail('TURN_EXPIRED', 409);
      return { interaction, image };
    }
    if (interaction.mode === 'chat' && recall) return { interaction };

    const { card, memory } = await openingCard(db, owner, interaction, timestamp);
    const history = (await db.recentTurns(owner, id, timestamp)).reverse();
    const dependencies = new Map();
    if (memory) dependencies.set(memory.id, { memory_id: memory.id, version: memory.version });
    for (const previous of history) {
      for (const dep of previous.dependencies) dependencies.set(dep.memory_id, dep);
    }
    return { interaction, card, memory, history, dependencies };
  }

  async function createTurn(owner, id, request) {
    const turn = validateTurn(await input(request));
    const payloadHash = await digest([turn.version, turn.text ?? '', turn.imageRef ?? ''].join('\u001f'));
    const recallIntent = RECALL_INTENT.test(turn.text ?? '');
    const prepared = await transaction(owner, db => prepareTurn(db, owner, id, turn, payloadHash, recallIntent));
    if (prepared.replay) return prepared.replay;

    const { interaction, card, history, image, memory, dependencies = new Map() } = prepared;
    const recall = interaction.mode === 'chat' && !image && recallIntent;
    const apiKey = env?.get('MODEL_API_KEY');
    const endpoint = env?.get('MODEL_ENDPOINT') || undefined;
    let reply, word, candidate;
    if (image) {
      const vision = apiKey && await generateVisionWord({ apiKey, mime: image.mime, base64: image.data, hint: turn.text, endpoint });
      if (vision?.ambiguous) reply = vision.ambiguous;
      else if (vision) {
        word = vision;
        reply = `${vision.word} ${vision.ipa}——${vision.meaning}。${vision.practice}`;
      }
    } else if (!recall) {
      if (interaction.mode === 'chat' && turn.text.includes('帮我记住')) {
        const text = turn.text.split('帮我记住').slice(1).join('帮我记住').replace(/^[:：,，\s]+/, '').trim();
        if (text && text.length <= 60) {
          candidate = { text, kind: 'status', topic: '近况' };
          reply = '看到了，确认一下要不要保存这句话。';
          dependencies.clear();
        }
      }
      if (!reply && apiKey) {
        const generated = await generateReply({
          apiKey, mode: interaction.mode, opening: card, history, text: turn.text,
          budget: interaction.budget, energy: interaction.energy, scene: interaction.scene,
          word: interaction.word, memory: memory?.text,
          allowCandidate: interaction.mode === 'chat', endpoint,
        });
        reply = generated?.text;
        candidate = generated?.candidate;
      }
    }

    return transaction(owner, async db => {
      const current = await ownedInteraction(db, owner, id);
      checkConversational(current);
      const timestamp = at();
      const replay = await turnReplay(db, owner, id, turn.requestId, payloadHash, timestamp);
      if (replay) return replay;
      if (current.version !== turn.version) fail('TURN_EXPIRED', 409);
      if (image) {
        const [stored] = rows(await db.from('images').select('id').eq('id', image.id)
          .eq('owner', owner).eq('interaction_id', id).gt('expires_at', timestamp).limit(1));
        if (!stored) fail('IMAGE_EXPIRED', 409);
      }
      if (recall) {
        const memories = rows(await db.from('memories').select('id,text,version')
          .eq('owner', owner).gt('expires_at', timestamp).order('confirmed_at', { ascending: false }).order('id').limit(3));
        for (const m of memories) dependencies.set(m.id, { memory_id: m.id, version: m.version });
        reply = memories.length ? `你确认保存过这些：${memories.map(m => `「${m.text}」`).join('、')}。` : NO_MEMORY_REPLY;
      } else if (!await dependenciesValid(db, owner, dependencies.values(), timestamp)) {
        reply = GENERIC_REPLY;
        candidate = null;
        dependencies.clear();
      }
      if (!reply) fail('MODEL_UNAVAILABLE', 503);

      const [saved] = rows(await db.from('turns').insert({
        interaction_id: id, owner, request_id: turn.requestId, payload_hash: payloadHash,
        version: turn.version, user_text: turn.text ?? '', reply_text: reply,
        image_ref: turn.imageRef, word: word ?? null, recall,
      }).select(TURN_COLUMNS));
      rows(await db.from('interactions').update({
        version: turn.version + 1, last_activity: timestamp,
        ...(image ? { state: word ? 'open' : 'awaiting_image', pending_image_id: word ? null : image.id } : {}),
        ...(word ? { word } : {}),
      }).eq('id', id).eq('owner', owner).select('id'));
      if (word) rows(await db.from('images').delete().eq('interaction_id', id).eq('owner', owner).select('id'));
      for (const dep of dependencies.values()) {
        rows(await db.from('turn_memories').insert({ turn_id: saved.id, ...dep }).select('turn_id'));
      }
      let candidateOut = null;
      if (candidate) {
        [candidateOut] = rows(await db.from('memory_candidates').insert({
          owner, interaction_id: id, turn_id: saved.id, ...candidate,
          expires_at: new Date(Date.parse(timestamp) + CANDIDATE_TTL_MS).toISOString(),
        }).select('id,text,kind,topic,version,expires_at'));
      }
      return turnResponse(saved, candidateOut, recall ? 200 : 201);
    });
  }

  function checkImageUpload(interaction, version) {
    checkConversational(interaction);
    if (interaction.state !== 'awaiting_image') fail('NOT_CONVERSATIONAL', 409);
    if (version !== interaction.version) fail('TURN_EXPIRED', 409);
  }

  async function uploadImage(owner, id, request) {
    const version = Number(new URL(request.url).searchParams.get('version'));
    if (!Number.isInteger(version) || version < 1) fail('INVALID_VERSION', 400);
    await transaction(owner, async db => checkImageUpload(await ownedInteraction(db, owner, id), version));
    const bytes = await binaryInput(request, IMAGE_MAX_BYTES);
    const mime = sniffImage(bytes);
    if (!mime) fail('UNSUPPORTED_IMAGE', 415);
    if (!await validateImage(bytes, mime)) fail('INVALID_IMAGE', 400);
    return transaction(owner, async db => {
      checkImageUpload(await ownedInteraction(db, owner, id), version);
      const timestamp = at();
      rows(await db.from('images').delete().eq('interaction_id', id).eq('owner', owner).lt('expires_at', timestamp).select('id'));
      const expiresAt = new Date(Date.parse(timestamp) + IMAGE_TTL_MS).toISOString();
      const [image] = rows(await db.from('images').insert({
        owner, interaction_id: id, version, mime, created_at: timestamp,
        bytes: bytes.length, data: toBase64(bytes), expires_at: expiresAt,
      }).select('id'));
      return json({ image_ref: image.id, mime, bytes: bytes.length, expires_at: expiresAt }, 201);
    });
  }

  async function endInteraction(owner, id) {
    return transaction(owner, async db => {
      await ownedInteraction(db, owner, id);
      await db.clearInteraction(owner, id, 'closed');
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    });
  }

  const MEMORY_COLUMNS = 'id,kind,topic,text,version,confirmed_at,expires_at';
  const asMemory = row => ({
    id: row.id, kind: row.kind, topic: row.topic, text: row.text,
    version: row.version, confirmed_at: row.confirmed_at, expires_at: row.expires_at,
  });

  function validMemoryText(text) {
    return typeof text === 'string' && text.trim().length >= 1 && text.trim().length <= 100
      && !/[\u0000-\u001f]/.test(text) ? text.trim() : null;
  }

  async function confirmMemory(owner, id, request) {
    const data = await input(request);
    const keys = Object.keys(data);
    const allowed = ['candidate_id', 'version', 'action', 'text'];
    if (keys.some(key => !allowed.includes(key)) || !keys.includes('candidate_id') || !keys.includes('version')) fail('INVALID_MEMORY', 400);
    if (typeof data.candidate_id !== 'string' || !UUID.test(data.candidate_id)) fail('INVALID_MEMORY', 400);
    if (!Number.isInteger(data.version) || data.version < 1) fail('INVALID_MEMORY', 400);
    const action = data.action ?? 'confirm';
    if (!['confirm', 'skip'].includes(action)) fail('INVALID_MEMORY', 400);
    let finalText = null;
    if (data.text !== undefined) {
      finalText = validMemoryText(data.text);
      if (!finalText) fail('INVALID_MEMORY', 400);
    }
    return transaction(owner, async db => {
      const interaction = await ownedInteraction(db, owner, id);
      const timestamp = at();
      const [existing] = rows(await db.from('memories').select(MEMORY_COLUMNS + ',candidate_version')
        .eq('owner', owner).eq('candidate_id', data.candidate_id).eq('candidate_interaction_id', id)
        .gt('expires_at', timestamp).limit(1));
      if (existing) {
        if (existing.candidate_version !== data.version) fail('VERSION_CONFLICT', 409);
        if (finalText && finalText !== existing.text) fail('REQUEST_CONFLICT', 409);
        return json(asMemory(existing), 200);
      }
      const [candidate] = rows(await db.from('memory_candidates').select('id,kind,topic,text,version,status,expires_at,turn_id')
        .eq('id', data.candidate_id).eq('owner', owner).eq('interaction_id', id).limit(1));
      if (!candidate) {
        if (interaction.state === 'expired') fail('CANDIDATE_EXPIRED', 409);
        fail('NOT_FOUND', 404);
      }
      if (candidate.version !== data.version) fail('VERSION_CONFLICT', 409);
      if (candidate.status === 'consumed') fail('NOT_FOUND', 404);
      if (candidate.status === 'skipped') return json({ skipped: true }, 200);
      if (new Date(candidate.expires_at).getTime() <= now() || new Date(interaction.last_activity).getTime() <= now() - IDLE_TTL_MS) {
        fail('CANDIDATE_EXPIRED', 409);
      }
      if (!await dependenciesValid(db, owner, await dependenciesOf(db, candidate.turn_id), timestamp)) fail('NOT_FOUND', 404);
      if (action === 'skip') {
        rows(await db.from('memory_candidates').update({ status: 'skipped', text: '' })
          .eq('id', candidate.id).eq('owner', owner).select('id'));
        return json({ skipped: true }, 200);
      }
      const [saved] = rows(await db.from('memories').insert({
        id: await uuidFrom(`${owner}:${candidate.id}`), owner,
        candidate_id: candidate.id, candidate_interaction_id: id, candidate_version: candidate.version,
        kind: candidate.kind, topic: candidate.topic, text: finalText ?? candidate.text, confirmed_at: timestamp,
        expires_at: new Date(Date.parse(timestamp) + MEMORY_TTL_MS[candidate.kind]).toISOString(),
      }).select(MEMORY_COLUMNS));
      rows(await db.from('memory_candidates').update({ status: 'consumed', text: '' })
        .eq('id', candidate.id).eq('owner', owner).select('id'));
      return json(asMemory(saved), 201);
    });
  }

  async function listMemories(owner, request) {
    const url = new URL(request.url);
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) fail('INVALID_QUERY', 400);
    return transaction(owner, async db => {
      const all = rows(await db.from('memories').select(MEMORY_COLUMNS)
        .eq('owner', owner).gt('expires_at', at()).order('confirmed_at', { ascending: false }).order('id').limit(1000));
      return json({ memories: all.slice(offset, offset + limit).map(asMemory), total: all.length, offset, limit });
    });
  }

  async function editMemory(owner, id, request) {
    const data = await input(request);
    const keys = Object.keys(data);
    if (keys.length !== 2 || !keys.includes('text') || !keys.includes('version')) fail('INVALID_MEMORY', 400);
    const text = validMemoryText(data.text);
    if (!text || !Number.isInteger(data.version) || data.version < 1) fail('INVALID_MEMORY', 400);
    return transaction(owner, async db => {
      const timestamp = at();
      const [memory] = rows(await db.from('memories').select(MEMORY_COLUMNS)
        .eq('id', id).eq('owner', owner).gt('expires_at', timestamp).limit(1));
      if (!memory) fail('NOT_FOUND', 404);
      if (memory.version === data.version + 1 && memory.text === text) return json(asMemory(memory));
      if (memory.version !== data.version) fail('VERSION_CONFLICT', 409);
      const [updated] = rows(await db.from('memories').update({
        text, version: data.version + 1, expires_at: new Date(Date.parse(timestamp) + MEMORY_TTL_MS[memory.kind]).toISOString(),
      }).eq('id', id).eq('owner', owner).select(MEMORY_COLUMNS));
      await db.invalidateMemoryTurns(owner, timestamp);
      return json(asMemory(updated));
    });
  }

  async function deleteMemory(owner, id) {
    return transaction(owner, async db => {
      const deleted = rows(await db.from('memories').delete().eq('id', id).eq('owner', owner).select('id'));
      if (deleted.length) {
        rows(await db.from('memory_deletions').insertIfAbsent({ id, owner }, { onConflict: 'id' }).select('id'));
        await db.invalidateMemoryTurns(owner, at());
      } else {
        const [tombstone] = rows(await db.from('memory_deletions').select('id').eq('id', id).eq('owner', owner).limit(1));
        if (!tombstone) fail('NOT_FOUND', 404);
      }
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    });
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

    if (path === '/api/interactions' && request.method === 'POST') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      return createInteraction(owner, request);
    }

    const interactionRoute = path.match(/^\/api\/interactions\/([^/]+)$/);
    if (interactionRoute && request.method === 'DELETE') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      if (!UUID.test(interactionRoute[1])) fail('NOT_FOUND', 404);
      return endInteraction(owner, interactionRoute[1]);
    }

    const turnRoute = path.match(/^\/api\/interactions\/([^/]+)\/turns$/);
    if (turnRoute && request.method === 'POST') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      if (!UUID.test(turnRoute[1])) fail('NOT_FOUND', 404);
      return createTurn(owner, turnRoute[1], request);
    }

    const imageRoute = path.match(/^\/api\/interactions\/([^/]+)\/images$/);
    if (imageRoute && request.method === 'POST') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      if (!UUID.test(imageRoute[1])) fail('NOT_FOUND', 404);
      return uploadImage(owner, imageRoute[1], request);
    }

    const confirmRoute = path.match(/^\/api\/interactions\/([^/]+)\/memories$/);
    if (confirmRoute && request.method === 'POST') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      if (!UUID.test(confirmRoute[1])) fail('NOT_FOUND', 404);
      return confirmMemory(owner, confirmRoute[1], request);
    }

    if (path === '/api/memories' && request.method === 'GET') {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      return listMemories(owner, request);
    }

    const memoryRoute = path.match(/^\/api\/memories\/([^/]+)$/);
    if (memoryRoute && ['PATCH', 'DELETE'].includes(request.method)) {
      const owner = await sessionOwner(request);
      if (!owner) fail('SESSION_REQUIRED', 401);
      if (!UUID.test(memoryRoute[1])) fail('NOT_FOUND', 404);
      return request.method === 'PATCH'
        ? editMemory(owner, memoryRoute[1], request)
        : deleteMemory(owner, memoryRoute[1]);
    }

    fail('NOT_FOUND', 404);
  };
}
