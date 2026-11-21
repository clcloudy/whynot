// Interaction modes, topic pools and the weighted opening draw.
// Weights and decay factors are trial starting points from the backend plan.
import { options, pickBuiltin } from './suggestions.mjs';

export const MODE_WEIGHTS = { chat: 35, discuss: 20, micro: 20, photo: 25 };
export const RECENT_DECAY = [0.2, 0.5, 0.5];

const ALL_SCENES = [null, 'waiting', 'desk', 'outside', 'home'];
const ALL_ENERGIES = ['low', 'steady', 'high'];
const ACTIVE_ENERGIES = ['steady', 'high'];
// Memory themes are stable IDs, independent of opening wording.
const PROGRESS_MEMORY_TOPICS = ['thesis', 'rehearsal', 'basketball', 'exhibition', 'course-report', 'exam'];

export const CHAT_TOPICS = [
  { topic: 'week-focus', group: 'progress', scenes: [null, 'waiting', 'desk', 'home'], energies: ACTIVE_ENERGIES, memoryTopics: PROGRESS_MEMORY_TOPICS,
    title: '聊聊这周的时间', first: '这周你花在什么事情上的时间最多？', detail: '想到什么说什么，一句话就够。', minutes: 2 },
  { topic: 'small-win', group: 'small-joy', scenes: ALL_SCENES, energies: ALL_ENERGIES, memoryTopics: [],
    title: '聊聊最近的小进展', first: '最近有没有一件让你觉得「还不错」的小事？', detail: '多小都算，说说它就行。', minutes: 2 },
  { topic: 'ongoing', group: 'progress', scenes: [null, 'waiting', 'desk', 'home'], energies: ACTIVE_ENERGIES, memoryTopics: PROGRESS_MEMORY_TOPICS,
    title: '聊聊正在忙的事', first: '最近你在忙什么？随便挑一件说说。', detail: '不用完整，想到哪儿说到哪儿。', minutes: 2 },
  { topic: 'rest-plan', group: 'rest', scenes: ALL_SCENES, energies: ALL_ENERGIES, memoryTopics: [],
    title: '聊聊想要的休息', first: '如果现在能安心休息十分钟，你最想做什么？', detail: '说一个就好，不用真的去做。', minutes: 2 },
  { topic: 'waiting-sound', group: 'sensory', scenes: ['waiting'], energies: ALL_ENERGIES, memoryTopics: [],
    title: '聊聊等待时的声音', first: '刚才等待时，有什么声音引起你注意？', detail: '只说一个声音就好，轮到你时随时停下。', minutes: 1 },
  { topic: 'familiar-taste', group: 'taste', scenes: ALL_SCENES, energies: ALL_ENERGIES, memoryTopics: [],
    title: '聊聊熟悉的味道', first: '想到一种你喜欢的食物，你最先想起它的什么味道？', detail: '一个词也可以，不用现在找来吃。', minutes: 1 },
];

export const DISCUSS_TOPICS = [
  { topic: 'campus-hours', group: 'campus', scenes: ALL_SCENES, energies: ACTIVE_ENERGIES, memoryTopics: [],
    title: '讨论一个校园选择题', first: '如果学校能延长一处设施的开放时间，你会选哪里？', detail: '说说你的理由，想到什么都可以。', minutes: 3 },
  { topic: 'daily-choice', group: 'digital-life', scenes: ALL_SCENES, energies: ACTIVE_ENERGIES, memoryTopics: [],
    title: '讨论一个日常选择题', first: '如果只能保留手机里的一类应用，你会留哪一类？', detail: '先给答案，再说说为什么。', minutes: 3 },
  { topic: 'imagine', group: 'imagination', scenes: ALL_SCENES, energies: ACTIVE_ENERGIES, memoryTopics: [],
    title: '讨论一道想象题', first: '如果明天醒来你多了一项新技能，你希望是什么？', detail: '说说你会拿它做的第一件事。', minutes: 3 },
  { topic: 'campus-space', group: 'campus', scenes: ALL_SCENES, energies: ACTIVE_ENERGIES, memoryTopics: [],
    title: '讨论一个校园改造题', first: '如果能给校园添一个小角落，你希望它是什么样的？', detail: '一个能坐下来的地方也算，说说理由。', minutes: 3 },
  { topic: 'quiet-or-lively', group: 'rest', scenes: ALL_SCENES, energies: ACTIVE_ENERGIES, memoryTopics: [],
    title: '讨论两种放松方式', first: '休息时，独处的安静和与朋友相处的热闹，你更喜欢哪一种？', detail: '选一种，说一个它适合你的理由。', minutes: 3 },
  { topic: 'repair-or-replace', group: 'everyday-design', scenes: ['desk', 'home'], energies: ACTIVE_ENERGIES, memoryTopics: [],
    title: '讨论小物的去留', first: '如果手边一件小物坏了，你会先试着修，还是换新的？', detail: '挑一件具体的小物，说说什么会影响你的选择，不用动手。', minutes: 5 },
];

const MODE_CATEGORIES = { chat: 'chat', discuss: 'discuss' };

export const PHOTO_OPENING = {
  topic: 'photo-word', title: '看图学一个英文词',
  first: '拍一样你想知道英文怎么说的东西。',
  detail: '对准一样清晰可见的物品拍一张，我来告诉你它的英文和读音。',
  minutes: 3, category: 'explore',
};

function topicPool(mode) {
  if (mode === 'chat') return CHAT_TOPICS;
  if (mode === 'discuss') return DISCUSS_TOPICS;
  return [];
}

export function topicGroup(mode, topic) {
  return topicPool(mode).find(item => item.topic === topic)?.group ?? null;
}

export function eligibleTopics(mode, { scene = null, energy, budget }) {
  return topicPool(mode).filter(item => item.scenes.includes(scene)
    && item.energies.includes(energy) && item.minutes <= budget);
}

export function eligibleModes({ scene, energy, budget }, { imageReady = false, microCandidates = options(scene, energy, budget) } = {}) {
  const modes = [];
  const context = { scene, energy, budget };
  if (eligibleTopics('chat', context).length) modes.push('chat');
  if (eligibleTopics('discuss', context).length) modes.push('discuss');
  if (microCandidates.length) modes.push('micro');
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
  if (mode === 'photo') return [PHOTO_OPENING.topic];
  return eligibleTopics(mode, context).map(item => item.topic);
}

function topicWeights(mode, entries, history) {
  // Intervening cards count toward decay; sibling topics share one penalty.
  const recent = history.slice(0, RECENT_DECAY.length).map(entry => topicGroup(entry.mode, entry.topic));
  const weights = {};
  for (const entry of entries) {
    const group = topicGroup(mode, entry);
    const position = group === null ? -1 : recent.indexOf(group);
    weights[entry] = position === -1 ? 1 : RECENT_DECAY[position];
  }
  return weights;
}

export function builtinOpening(mode, topic, context, microCandidates = options(context.scene, context.energy, context.budget)) {
  if (mode === 'photo') return { ...PHOTO_OPENING };
  if (mode === 'micro') {
    return microCandidates.find(entry => entry.action === topic) ?? null;
  }
  const pool = mode === 'chat' ? CHAT_TOPICS : DISCUSS_TOPICS;
  const item = pool.find(entry => entry.topic === topic);
  return { title: item.title, first: item.first, detail: item.detail, minutes: item.minutes, category: MODE_CATEGORIES[mode] };
}

// exclude: { mode, topic } of the card being replaced. Skip the current mode
// when alternatives exist; otherwise switch topic, repeating only when the
// pool has a single candidate.
export function pickOpening({ context, history, exclude = null, imageReady = false, random = Math.random,
  microCandidates = options(context.scene, context.energy, context.budget), recent = [], scores = {} }) {
  let modes = eligibleModes(context, { imageReady, microCandidates });
  if (exclude && modes.length > 1) modes = modes.filter(mode => mode !== exclude.mode);
  const mode = weightedPick(modes, modeWeights(modes, history), random());
  if (mode === 'micro') {
    const card = pickBuiltin({ ...context, candidates: microCandidates, recent, scores, random });
    return { mode, topic: card.action, card };
  }
  let entries = topicEntries(mode, context);
  if (exclude && exclude.mode === mode && entries.length > 1) entries = entries.filter(entry => entry !== exclude.topic);
  const topic = weightedPick(entries, topicWeights(mode, entries, history), random());
  return { mode, topic };
}
