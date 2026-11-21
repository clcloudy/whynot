import catalog from './activity-catalog.v1.json' with { type: 'json' };
import { eligibleCard, validateCatalog } from './activity-catalog.mjs';

if (validateCatalog(catalog, { requireCoverage: true }).length) throw new Error('INVALID_ACTIVITY_CATALOG');
export const ACTIVITY_CATALOG = catalog;

export const SCENES = ['waiting', 'desk', 'outside', 'home'];
export const ENERGIES = ['low', 'steady', 'high'];
export const BUDGETS = [3, 5, 10, 15];

export const SCENE_ACTIONS = {
  waiting: [
    { action: 'window', title: '看看远处的颜色', first: '把视线从屏幕移开，挑一种远处的颜色。', detail: '让眼睛在那种颜色上停一会儿。轮到你时，随时收尾。', minutes: 2, category: 'observe', anywhere: false },
    { action: 'sounds', title: '听听身边的三种声音', first: '先听一听，离你最近的声音是什么？', detail: '再找一种稍远的声音。要是愿意，试着分辨最远的那一种。', minutes: 2, category: 'listen', anywhere: false },
    { action: 'queue', title: '发现一个顺手的设计', first: '看看附近的标识，找一个一眼就懂的符号。', detail: '想想它靠颜色、形状还是位置让你看懂。', minutes: 3, category: 'explore', anywhere: false },
  ],
  desk: [
    { action: 'pen', title: '给桌面留一点空白', first: '把手边一件暂时用不到的小东西放回原处。', detail: '看看腾出来的那一小块地方，一件就够了。', minutes: 2, category: 'tidy', anywhere: false },
    { action: 'focus', title: '把目光送到远处', first: '抬起头，选一个房间另一端的物件。', detail: '慢慢看清它的轮廓，再把目光带回眼前。', minutes: 1, category: 'observe', anywhere: false },
    { action: 'deskshape', title: '找一组藏起来的形状', first: '在桌面上找一个圆形，再找一个方形。', detail: '看看哪种形状更常见，猜猜设计者为什么选它。', minutes: 3, category: 'explore', anywhere: false },
  ],
  outside: [
    { action: 'sky', title: '抬头收集一片天空', first: '先在安全的位置站定，抬头看一小片天空。', detail: '看看它今天是什么颜色，也可以留意楼顶和天空的交界线。', minutes: 2, category: 'observe', anywhere: false },
    { action: 'streetsound', title: '听一听街角的声音', first: '在安全的地方停下，留意身边一种声音。', detail: '听它靠近或远去，给这段街头声音想个名字。', minutes: 2, category: 'listen', anywhere: false },
    { action: 'sign', title: '找一个街角的小细节', first: '在安全的位置站定，看看附近的一块招牌。', detail: '挑一个有意思的笔画，顺着它的轮廓看一圈。', minutes: 3, category: 'explore', anywhere: false },
  ],
  home: [
    { action: 'light', title: '追一小块光影', first: '看看房间里，哪儿有一块亮一些的地方？', detail: '顺着它的边缘看一圈，找找光是从哪里来的。', minutes: 2, category: 'observe', anywhere: false },
    { action: 'shelf', title: '让一件小物归位', first: '挑一件就在手边的小物件。', detail: '把它放到下次最容易找到的位置，到这里就可以了。', minutes: 2, category: 'tidy', anywhere: false },
    { action: 'homelisten', title: '听听房间自己的声音', first: '安静片刻，听听房间里持续最久的声音。', detail: '留意它中间的停顿，再慢慢把注意力放回来。', minutes: 2, category: 'listen', anywhere: false },
  ],
};

export const EXTRAS = {
  low: [
    { action: 'pause', title: '给自己一分钟放空', first: '在方便停留的地方歇一会儿，把手机放低。', detail: '让肩膀自然放松。什么都不用完成，休息一会儿就好。', minutes: 1, category: 'rest', anywhere: true },
  ],
  steady: [
    { action: 'headline', title: '给此刻起个名字', first: '看看身边，选一个最吸引你注意的小细节。', detail: '把它放进一个短短的标题里，就当是今天生活的一行注脚。', minutes: 3, category: 'explore', anywhere: true },
    { action: 'palette', title: '收集一组今日配色', first: '停下来，先选出身边最显眼的一种颜色。', detail: '再找两种和它相配的颜色，给这组配色起个名字。', minutes: 5, category: 'observe', anywhere: true },
  ],
  high: [
    { action: 'invent', title: '试一次小小的发明', first: '在方便停留的地方，挑一样眼前的日常用品。', detail: '为它想一种新用途，越具体越有趣。', minutes: 3, category: 'explore', anywhere: false },
    { action: 'story', title: '给眼前的小物编个故事', first: '选一件眼前的小物，想象它是故事的主角。', detail: '想一想它刚从哪里来，又打算去哪里。把故事浓缩成三句话。', minutes: 5, category: 'explore', anywhere: false },
  ],
};

export const ANYWHERE = [
  { action: 'breathe', title: '跟着呼吸数四轮', first: '舒服地坐好或站定，慢慢吸气四拍。', detail: '再缓缓呼气四拍，重复四轮。随时可以停下。', minutes: 1, category: 'rest', anywhere: true },
  { action: 'stretch', title: '给肩颈松一松', first: '坐直或站定，让肩膀慢慢向后绕一圈。', detail: '再绕两圈，配合一次深呼吸。幅度以舒服为准。', minutes: 2, category: 'rest', anywhere: true },
  { action: 'colors', title: '找三种今天的颜色', first: '抬眼看看四周，先找到一种最显眼的颜色。', detail: '再找两种不一样的，在心里给它们起个名字。', minutes: 2, category: 'observe', anywhere: true },
  { action: 'ambient', title: '捕捉一种持续的声音', first: '停下来，听听环境里持续最久的一种声音。', detail: '留意它的起伏和停顿，听半分钟就好。', minutes: 2, category: 'listen', anywhere: true },
  { action: 'plan', title: '想一件待会儿的小期待', first: '想一想今天剩下的时间里，有什么让你有一点期待。', detail: '把它变成一句话，比如「回去路上听那首歌」。', minutes: 3, category: 'explore', anywhere: true },
  { action: 'tale', title: '编一个三句话故事', first: '用「今天、忽然、原来」开头，在心里起一个故事。', detail: '三句话就好，不用写下来，讲给自己听。', minutes: 3, category: 'explore', anywhere: true },
];

export function legacyOptions(scene, energy, budget, inventory = catalog) {
  const pool = [...(scene ? SCENE_ACTIONS[scene] : []), ...EXTRAS[energy], ...ANYWHERE];
  return pool.filter(item => item.minutes <= budget
    && (scene || item.anywhere)
    && (energy !== 'low' || item.category !== 'explore'))
    .map(item => {
      const version = catalog.cards.find(card => card.sources.some(source => source.kind === 'builtin' && source.action === item.action));
      const current = version && inventory.cards.find(card => card.id === version.id);
      return version && (!current || current.status === 'published') && eligibleCard(version, { scene, energy, budget })
        ? { ...version, action: version.id, first: version.first_step, anywhere: version.scenes.includes(null) } : null;
    }).filter(Boolean);
}

export function options(scene, energy, budget, { inventory = catalog, fallback = legacyOptions } = {}) {
  const candidates = inventory.cards.filter(card => eligibleCard(card, { scene, energy, budget }))
    .map(card => ({ ...card, action: card.id, first: card.first_step, anywhere: card.scenes.includes(null) }));
  return candidates.length ? candidates : fallback(scene, energy, budget, inventory);
}

const normalizedTitle = title => (title ?? '').replace(/[\s\p{P}]/gu, '');
export function prototypeFor(entry, inventory = catalog) {
  const action = typeof entry === 'string' ? entry : entry.action;
  const index = [...inventory.cards, ...inventory.history];
  const exact = index.find(item => item.id === action);
  if (exact) return exact.prototype_id;
  if (typeof entry !== 'string' && action === 'model') {
    return index.find(item => normalizedTitle(item.title) === normalizedTitle(entry.title))?.prototype_id ?? null;
  }
  return null;
}

export function pickBuiltin({ scene, energy, budget, candidates = options(scene, energy, budget), recent = [],
  scores = {}, inventory = catalog, random = Math.random, onGap = () => {} }) {
  const groups = new Map();
  for (const card of candidates) {
    if (!groups.has(card.prototype_id)) groups.set(card.prototype_id, []);
    groups.get(card.prototype_id).push(card);
  }
  if (groups.size < 2) onGap({ version: inventory.version, scene, energy, budget, prototypes: groups.size });
  if (!groups.size) return null;
  const history = recent.slice(0, 3).map(entry => prototypeFor(entry, inventory));
  let blocked = new Set(history.filter(Boolean));
  let choices = [...groups.keys()].filter(id => !blocked.has(id));
  for (let i = history.length - 1; !choices.length && i >= 0; i--) {
    blocked = new Set(history.slice(0, i).filter(Boolean));
    choices = [...groups.keys()].filter(id => !blocked.has(id));
  }
  if (!choices.length) choices = [...groups.keys()];
  const weights = choices.map(id => 2 ** Math.max(-2, Math.min(2, scores[groups.get(id)[0].category] ?? 0)));
  let roll = random() * weights.reduce((sum, weight) => sum + weight, 0);
  let selected = choices.at(-1);
  for (let i = 0; i < choices.length; i++) {
    roll -= weights[i];
    if (roll < 0) { selected = choices[i]; break; }
  }
  let versions = groups.get(selected);
  const previous = recent[0];
  if (previous && versions.length > 1) {
    const different = versions.filter(card => card.action !== previous.action
      && normalizedTitle(card.title) !== normalizedTitle(previous.title));
    if (different.length) versions = different;
  }
  return versions[Math.floor(random() * versions.length)];
}