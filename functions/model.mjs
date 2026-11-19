// Server-only model call. Never log the key, the prompt context or raw responses.

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-flash';
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

export async function generateSuggestion({ apiKey, budget, energy, scene, recentTitles = [], liked = [], disliked = [], endpoint = ENDPOINT }) {
  if (!apiKey) return null;
  const lines = [
    `时间预算：${budget} 分钟`,
    `精力：${ENERGY_TEXT[energy]}`,
    `场景：${scene ? SCENE_TEXT[scene] : '未提供。不要假定身边有窗户、桌子或其他物品，给任何地方都能做的建议。'}`,
  ];
  if (recentTitles.length) lines.push(`最近已推荐过，避免重复：${recentTitles.join('、')}`);
  if (liked.length) lines.push(`用户喜欢过的类型，可优先考虑：${liked.join('、')}`);
  if (disliked.length) lines.push(`用户不喜欢的类型，避免：${disliked.join('、')}`);
  lines.push('请给一条新的建议。');
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines.join('\n') }],
    temperature: 0.9,
    max_tokens: 400,
    response_format: { type: 'json_object' },
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
      let parsed;
      try { parsed = JSON.parse(content); } catch { continue; }
      const card = validateCard(parsed, budget, energy);
      if (card) return card;
    } catch {
      // Timeout or network failure: bounded retry, then the caller falls back.
    }
  }
  return null;
}