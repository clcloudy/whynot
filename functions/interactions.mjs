// Interaction modes, topic pools and the weighted opening draw.
// Weights and decay factors are trial starting points from the backend plan.
import { options } from './suggestions.mjs';

export const MODE_WEIGHTS = { chat: 35, discuss: 20, micro: 20, photo: 25 };
export const RECENT_DECAY = [0.2, 0.5, 0.5];

export const CHAT_TOPICS = [
  { topic: 'week-focus', title: '聊聊这周的时间', first: '这周你花在什么事情上的时间最多？', detail: '想到什么说什么，一句话就够。', minutes: 2 },
  { topic: 'small-win', title: '聊聊最近的小进展', first: '最近有没有一件让你觉得「还不错」的小事？', detail: '多小都算，说说它就行。', minutes: 2 },
  { topic: 'ongoing', title: '聊聊正在忙的事', first: '最近你在忙什么？随便挑一件说说。', detail: '不用完整，想到哪儿说到哪儿。', minutes: 2 },
  { topic: 'rest-plan', title: '聊聊想要的休息', first: '如果现在能安心休息十分钟，你最想做什么？', detail: '说一个就好，不用真的去做。', minutes: 2 },
];

export const DISCUSS_TOPICS = [
  { topic: 'campus-hours', title: '讨论一个校园选择题', first: '如果学校能延长一处设施的开放时间，你会选哪里？', detail: '说说你的理由，想到什么都可以。', minutes: 3 },
  { topic: 'daily-choice', title: '讨论一个日常选择题', first: '如果只能保留手机里的一类应用，你会留哪一类？', detail: '先给答案，再说说为什么。', minutes: 3 },
  { topic: 'imagine', title: '讨论一道想象题', first: '如果明天醒来你多了一项新技能，你希望是什么？', detail: '说说你会拿它做的第一件事。', minutes: 3 },
  { topic: 'campus-space', title: '讨论一个校园改造题', first: '如果能给校园添一个小角落，你希望它是什么样的？', detail: '一个能坐下来的地方也算，说说理由。', minutes: 3 },
];

const MODE_CATEGORIES = { chat: 'chat', discuss: 'discuss' };

export const PHOTO_OPENING = {
  topic: 'photo-word', title: '看图学一个英文词',
  first: '拍一样你想知道英文怎么说的东西。',
  detail: '对准一样清晰可见的物品拍一张，我来告诉你它的英文和读音。',
  minutes: 3, category: 'explore',
};

// One round must fit the budget. Discussing takes more effort than chatting,
// so low energy keeps only chat and micro-actions. Photo needs image support
// on both sides and a scene where stopping to take a photo is safe.
export function eligibleModes({ scene, energy, budget }, { imageReady = false } = {}) {
  const modes = [];
  if (budget >= 2) modes.push('chat');
  if (budget >= 3 && energy !== 'low') modes.push('discuss');
  if (options(scene, energy, budget).length) modes.push('micro');
  if (imageReady && scene !== 'outside' && budget >= 3) modes.push('photo');
  return modes;
}

// history: latest three committed openings, newest first, as { mode, topic }.
// Only each mode's most recent position matters.
export function modeWeights(modes, history) {
  const weights = {};
  for (const mode of modes) {
    const position = history.findIndex(entry => entry.mode === mode);
    const factor = position === -1 ? 1 : RECENT_DECAY[position] ?? 1;
    weights[mode] = MODE_WEIGHTS[mode] * factor;
  }
  return weights;
}

export function weightedPick(entries, weights, roll) {
  const total = entries.reduce((sum, entry) => sum + weights[entry], 0);
  let cursor = roll * total;
  for (const entry of entries) {
    cursor -= weights[entry];
    if (cursor < 0) return entry;
  }
  return entries[entries.length - 1];
}

function topicEntries(mode, context) {
  if (mode === 'chat') return CHAT_TOPICS.map(item => item.topic);
  if (mode === 'discuss') return DISCUSS_TOPICS.map(item => item.topic);
  if (mode === 'photo') return [PHOTO_OPENING.topic];
  return options(context.scene, context.energy, context.budget).map(item => item.action);
}

function topicWeights(mode, entries, history) {
  const recent = history.filter(entry => entry.mode === mode).map(entry => entry.topic);
  const weights = {};
  for (const entry of entries) {
    const position = recent.indexOf(entry);
    weights[entry] = position === -1 ? 1 : RECENT_DECAY[position] ?? 1;
  }
  return weights;
}

export function builtinOpening(mode, topic, context) {
  if (mode === 'photo') return { ...PHOTO_OPENING };
  if (mode === 'micro') {
    const item = options(context.scene, context.energy, context.budget).find(entry => entry.action === topic);
    return { title: item.title, first: item.first, detail: item.detail, minutes: item.minutes, category: item.category };
  }
  const pool = mode === 'chat' ? CHAT_TOPICS : DISCUSS_TOPICS;
  const item = pool.find(entry => entry.topic === topic);
  return { title: item.title, first: item.first, detail: item.detail, minutes: item.minutes, category: MODE_CATEGORIES[mode] };
}

// exclude: { mode, topic } of the card being replaced. Skip the current mode
// when alternatives exist; otherwise switch topic, repeating only when the
// pool has a single candidate.
export function pickOpening({ context, history, exclude = null, imageReady = false, random = Math.random }) {
  let modes = eligibleModes(context, { imageReady });
  if (exclude && modes.length > 1) modes = modes.filter(mode => mode !== exclude.mode);
  const mode = weightedPick(modes, modeWeights(modes, history), random());
  let entries = topicEntries(mode, context);
  if (exclude && exclude.mode === mode && entries.length > 1) entries = entries.filter(entry => entry !== exclude.topic);
  const topic = weightedPick(entries, topicWeights(mode, entries, history), random());
  return { mode, topic };
}
