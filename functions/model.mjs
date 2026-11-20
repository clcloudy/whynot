// Server-only model call. Never log the key, the prompt context or raw responses.

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-flash';
const VISION_MODEL = 'qwen-vl-flash';
const TIMEOUT_MS = 7000;
const MAX_ATTEMPTS = 2;

export const CATEGORIES = ['rest', 'observe', 'listen', 'tidy', 'explore'];
const LOW_CATEGORIES = new Set(['rest', 'observe', 'listen', 'tidy']);

const SCENE_TEXT = {
  waiting: '等饭／排队（要听得到叫号，不能离开队伍）',
  desk: '在桌前',
  outside: '在路上（先确保可以安全停留）',
  home: '在家／宿舍',
};
const ENERGY_TEXT = {
  low: '有点累（适合放空或休息，低负担）',
  steady: '还可以',
  high: '精神好（可以观察一个设计或尝试一个小创作）',
};

const SYSTEM = [
  '你是 WhyNot 的建议生成器。用户是大学生，处在碎片时间里，想要一件现在就能开始的小事。',
  '只输出一个 JSON 对象，不要输出任何其他内容。字段：',
  'title（做什么，不超过 20 字）、first_step（第一步，具体到马上能做，不超过 40 字）、',
  'detail（一两句邀请式补充，不超过 60 字）、minutes（包含准备在内的预计耗时，整数，不超过时间预算）、',
  'category（rest、observe、listen、tidy、explore 之一）。',
  '要求：时间是上限，预计耗时必须在预算内；第一步原地就能开始，不需要下载、查教程或准备材料；',
  '文案用邀请的口吻，用户可以随时结束；按场景选择方便做的事；按精力选择难度，',
  '有点累时给休息或放空类建议，category 不要用 explore。',
].join('\n');

export function validateCard(raw, budget, energy) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const first = typeof raw.first_step === 'string' ? raw.first_step.trim() : '';
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  if (!title || title.length > 40 || !first || first.length > 80 || !detail || detail.length > 160) return null;
  if (/[\u0000-\u001f]/.test(title + first + detail)) return null;
  if (!Number.isInteger(raw.minutes) || raw.minutes < 1 || raw.minutes > budget) return null;
  if (!CATEGORIES.includes(raw.category)) return null;
  if (energy === 'low' && !LOW_CATEGORIES.has(raw.category)) return null;
  return { action: 'model', title, first, detail, minutes: raw.minutes, category: raw.category };
}

async function chatJSON({ apiKey, messages, maxTokens, endpoint = ENDPOINT, model = MODEL, jsonMode = true }) {
  if (!apiKey) return null;
  const body = JSON.stringify({
    model,
    messages,
    temperature: 0.9,
    max_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500) continue;
        return null;
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') continue;
      try { return JSON.parse(content); } catch { continue; }
    } catch {
      // Timeout or network failure: bounded retry, then the caller falls back.
    }
  }
  return null;
}

export async function generateSuggestion({ apiKey, budget, energy, scene, recentTitles = [], liked = [], disliked = [], endpoint = ENDPOINT }) {
  const lines = [
    `时间预算：${budget} 分钟`,
    `精力：${ENERGY_TEXT[energy]}`,
    `场景：${scene ? SCENE_TEXT[scene] : '未提供。不要假定身边有窗户、桌子或其他物品，给任何地方都能做的建议。'}`,
  ];
  if (recentTitles.length) lines.push(`最近已推荐过，避免重复：${recentTitles.join('、')}`);
  if (liked.length) lines.push(`用户喜欢过的类型，可优先考虑：${liked.join('、')}`);
  if (disliked.length) lines.push(`用户不喜欢的类型，避免：${disliked.join('、')}`);
  lines.push('请给一条新的建议。');
  const parsed = await chatJSON({
    apiKey, maxTokens: 400, endpoint,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines.join('\n') }],
  });
  return parsed ? validateCard(parsed, budget, energy) : null;
}

const OPENING_SYSTEM = {
  chat: [
    '你是 WhyNot 的聊天开场生成器。用户是大学生，处在碎片时间里，想轻松地聊几句近况。',
    '只输出一个 JSON 对象，不要输出任何其他内容。字段：',
    'title（话题名，不超过 20 字）、first_step（围绕指定话题的一个开场问题，不超过 40 字）、',
    'detail（一句邀请式补充，不超过 60 字）、minutes（聊一轮的预计耗时，整数，不超过时间预算）。',
    '必须围绕给定的话题发问，不要换话题；口吻轻松，用户随时可以不回答。',
  ].join('\n'),
  discuss: [
    '你是 WhyNot 的讨论开场生成器。用户是大学生，处在碎片时间里，想讨论一个有意思的小问题。',
    '只输出一个 JSON 对象，不要输出任何其他内容。字段：',
    'title（话题名，不超过 20 字）、first_step（围绕指定话题的一个讨论问题，不超过 40 字）、',
    'detail（一句邀请式补充，不超过 60 字）、minutes（讨论一轮的预计耗时，整数，不超过时间预算）。',
    '必须围绕给定的话题发问，不要换话题；问题没有标准答案，邀请用户说出自己的理由。',
  ].join('\n'),
};

export function validateOpening(raw, budget) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const first = typeof raw.first_step === 'string' ? raw.first_step.trim() : '';
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  if (!title || title.length > 40 || !first || first.length > 80 || !detail || detail.length > 160) return null;
  if (/[\u0000-\u001f]/.test(title + first + detail)) return null;
  if (!Number.isInteger(raw.minutes) || raw.minutes < 1 || raw.minutes > budget) return null;
  return { title, first, detail, minutes: raw.minutes };
}

export async function generateOpening({ apiKey, mode, topic, budget, energy, scene, endpoint = ENDPOINT }) {
  const system = OPENING_SYSTEM[mode];
  if (!system) return null;
  const lines = [
    `本轮话题：${topic.title}——${topic.first}`,
    `时间预算：${budget} 分钟`,
    `精力：${ENERGY_TEXT[energy]}`,
    `场景：${scene ? SCENE_TEXT[scene] : '未提供'}`,
    '请围绕这个话题生成开场。',
  ];
  const parsed = await chatJSON({
    apiKey, maxTokens: 400, endpoint,
    messages: [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }],
  });
  return parsed ? validateOpening(parsed, budget) : null;
}

const REPLY_SYSTEM = {
  chat: [
    '你是 WhyNot 的聊天伙伴。用户是大学生，正在和你聊近况。',
    '只输出一个 JSON 对象，不要输出任何其他内容。字段：text（你的一句回应，不超过 60 字）。',
    '围绕用户刚说的话自然地追问一句；口吻轻松具体，不说教，不虚构用户没说过的事。',
  ].join('\n'),
  discuss: [
    '你是 WhyNot 的讨论伙伴。用户是大学生，正在和你讨论一个小问题。',
    '只输出一个 JSON 对象，不要输出任何其他内容。字段：text（你的一句回应，不超过 60 字）。',
    '顺着用户给出的理由继续讨论，可以追问或提供一个新角度；不评判对错，不虚构事实。',
  ].join('\n'),
  photo: [
    '你是 WhyNot 的看图学词伙伴。用户刚通过照片学了一个英文词，正在练习。',
    '只输出一个 JSON 对象，不要输出任何其他内容。字段：text（你的一句回应，不超过 60 字）。',
    '围绕刚学的词简短回应；用户要求再念一次时，原样给出音标并说明重音位置；不虚构词义或用户没说过的事。',
  ].join('\n'),
};

const CANDIDATE_LINES = [
  '如果用户明确说「帮我记住」，或提到一个以后值得跟进的近况，可以额外输出 memory 对象：',
  'text（拟保存的一句话，不超过 60 字，只能写用户亲口说过的内容，不得添加推断或背景信息）、',
  'kind（status 或 word）、topic（不超过 20 字的主题）。没有值得记的内容就不要输出 memory。',
].join('\n');

export function validateCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
  if (!text || text.length > 60 || /[\u0000-\u001f]/.test(text)) return null;
  if (!topic || topic.length > 20 || /[\u0000-\u001f]/.test(topic)) return null;
  if (!['status', 'word'].includes(raw.kind)) return null;
  return { text, kind: raw.kind, topic };
}

export function validateReply(raw, allowCandidate = false) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text || text.length > 160 || /[\u0000-\u001f]/.test(text)) return null;
  const candidate = allowCandidate && raw.memory != null ? validateCandidate(raw.memory) : null;
  return { text, candidate };
}

export async function generateReply({ apiKey, mode, opening, history, text, budget, energy, scene, word = null, memory = null, allowCandidate = false, endpoint = ENDPOINT }) {
  const system = REPLY_SYSTEM[mode];
  if (!system) return null;
  const lines = [
    `时间预算：${budget} 分钟`,
    `精力：${ENERGY_TEXT[energy]}`,
    `场景：${scene ? SCENE_TEXT[scene] : '未提供'}`,
  ];
  if (word) lines.push(`刚学的词：${word.word} ${word.ipa}（${word.meaning}）`);
  if (memory) lines.push(`用户确认过的近况（只可引用原话，不得扩写）：${memory}`);
  if (allowCandidate && mode === 'chat') lines.push(CANDIDATE_LINES);
  const messages = [
    { role: 'system', content: [system, ...lines].join('\n') },
    { role: 'assistant', content: [opening.title, opening.first_step, opening.detail].join('\n') },
  ];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.user_text || '（已发送图片）' });
    messages.push({ role: 'assistant', content: turn.reply_text });
  }
  messages.push({ role: 'user', content: text });
  const parsed = await chatJSON({ apiKey, messages, maxTokens: 300, endpoint });
  return parsed ? validateReply(parsed, allowCandidate && mode === 'chat') : null;
}

const VISION_SYSTEM = [
  '你是 WhyNot 的看图学词助手。用户拍了一张照片，想学图中一样物品的英文说法。',
  '只输出一个 JSON 对象，不要输出任何其他内容。',
  '如果图中有多个同样显眼的物品、无法确定用户指的是哪个，只输出 question（不超过 40 字），询问用户指的是哪个物品。',
  '否则选一个清晰可见的物品，输出：word（英文单词或短语，不超过 40 个字符）、',
  'ipa（美式音标，放在 / / 内并标注重音，不超过 60 个字符）、meaning（中文词义，不超过 40 字）、',
  'practice（一个马上能做的简短练习，不超过 80 字）。',
  '只描述清晰可见的物品，不要猜测背景、文字招牌或画面外的内容。',
].join('\n');

export function validateVision(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.question != null) {
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    if (!question || question.length > 80 || /[\u0000-\u001f]/.test(question)) return null;
    return { ambiguous: question };
  }
  const word = typeof raw.word === 'string' ? raw.word.trim() : '';
  const ipa = typeof raw.ipa === 'string' ? raw.ipa.trim() : '';
  const meaning = typeof raw.meaning === 'string' ? raw.meaning.trim() : '';
  const practice = typeof raw.practice === 'string' ? raw.practice.trim() : '';
  if (!/^[A-Za-z][A-Za-z .'-]{0,39}$/.test(word)) return null;
  if (!/^\/[^/]+\/$/.test(ipa) || !ipa.includes('ˈ') || ipa.length > 60
    || !meaning || meaning.length > 40 || !practice || practice.length > 80) return null;
  if (/[\u0000-\u001f]/.test(word + ipa + meaning + practice)) return null;
  return { word, ipa, meaning, practice };
}

export async function generateVisionWord({ apiKey, mime, base64, hint = null, endpoint = ENDPOINT }) {
  const messages = [
    { role: 'system', content: VISION_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        { type: 'text', text: hint ? `用户补充说：${hint}。请据此确定用户指的是哪个物品。` : '请识别图中用户想学英文的物品。' },
      ],
    },
  ];
  const parsed = await chatJSON({ apiKey, messages, maxTokens: 400, endpoint, model: VISION_MODEL, jsonMode: false });
  return parsed ? validateVision(parsed) : null;
}
