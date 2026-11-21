export const MEMORY_TOPICS = [
  { id: 'thesis', label: '论文', aliases: ['毕业论文', '学位论文', '论文'] },
  { id: 'course-report', label: '课程报告', aliases: ['课程报告', '课程作业', '实验报告', '报告'] },
  { id: 'rehearsal', label: '排练', aliases: ['校庆排练', '校庆演出', '排练', '彩排', '演出'] },
  { id: 'basketball', label: '打球', aliases: ['篮球', '打球', '球赛'] },
  { id: 'exhibition', label: '看展', aliases: ['看展', '展览', '画展'] },
  { id: 'exam', label: '考试', aliases: ['体测', '考试', '期末考', '复习'] },
];

const clean = text => text.toLowerCase().replace(/[\s，。！？、：；“”「」,.!?:;"']/g, '');
const mentioned = text => MEMORY_TOPICS.filter(topic => topic.aliases.some(alias => text.includes(alias)));
export function memoryTopic(text) {
  const matches = mentioned(text);
  return matches.length === 1 ? matches[0].id : null;
}
export function memoryLabel(memory) {
  if (memory.text.includes('校庆排练')) return '校庆排练';
  return MEMORY_TOPICS.find(topic => topic.id === (memoryTopic(memory.text) ?? memory.topic_id))?.label
    ?? memory.text.slice(0, 20);
}

export function recallIntent(text) {
  if (/^(?:请|麻烦)?帮我记住/.test(text.trim())) return null;
  if (/(?:不想|不要|不用|别)(?:再)?(?:回忆|查|列|提)|换(?:个|一个)?话题|不想细讲|不聊了/.test(text)) return null;
  if (/(?:列出|列一下|查看|看看|翻看).{0,12}(?:记忆|记录)(?:列表|清单)?[吧呢吗？?。!！]*$|(?:保存|记住|记下|记录)(?:过|了|的)?(?:哪些|什么)[吧呢吗？?。!！]*$|(?:有哪些|什么).{0,6}(?:记忆|记录)[吧呢吗？?。!！]*$/.test(text)) return 'list';
  const reference = /(?:上次|之前|以前|前面).{0,16}(?:说|提|讲|记)|(?:记得|记住|记下|保存|记录)|(?:说|提到)过/;
  const question = /什么时候|哪(?:天|个|件|一|些)|什么|几(?:点|号|时)|多少|怎么|是否|有没有|还记得|[？?]|(?:吗|没|呢)[。！!]?$/;
  return reference.test(text) && question.test(text) ? 'specific' : null;
}

function queryTerms(text) {
  const remainder = clean(text)
    .replace(/我(?:的)?|你(?:的)?|我们|帮我|帮忙|请|还记得|记得|上次|之前|以前|前面|说过|说的|提到过|提到|说|讲|确认|保存过|保存|记住|记下|记录|什么时候|哪一天|哪天|哪个|哪件|什么|几号|几点|多少|是|在|要|会|了|过|吗|呢|来着/g, '');
  if (!remainder || /^(?:准备|忙)$/.test(remainder)) return [];
  return remainder.length < 2 ? [remainder] : Array.from({ length: remainder.length - 1 }, (_, i) => remainder.slice(i, i + 2));
}

export function retrieveMemories(memories, text, intent) {
  if (intent === 'list') return { kind: 'list', memories };
  const topics = mentioned(text).map(topic => topic.id);
  const terms = queryTerms(text);
  const broad = !topics.length && !terms.length;
  const ranked = memories.map(memory => {
    const ids = new Set([memory.topic_id, ...mentioned(memory.text).map(topic => topic.id)]);
    const topical = topics.some(id => ids.has(id));
    const lexical = terms.filter(term => clean(memory.text).includes(term)).length;
    const score = topics.length ? (topical ? 100 + lexical : 0) : broad ? 1 : lexical;
    return { memory, score, subject: memoryTopic(memory.text) ?? memory.topic_id ?? clean(memory.text) };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score
    || Date.parse(b.memory.confirmed_at) - Date.parse(a.memory.confirmed_at)
    || a.memory.id.localeCompare(b.memory.id));
  if (!ranked.length) return { kind: 'none', memories: [] };
  const top = ranked[0];
  const alternative = ranked.find(entry => entry.subject !== top.subject && entry.score === top.score);
  if (alternative) return { kind: 'clarify', memories: [top.memory, alternative.memory] };
  return { kind: 'specific', memories: [top.memory] };
}

export function recallReply(result) {
  if (!result.memories.length) return '没有找到你保存过的相关记录。';
  if (result.kind === 'clarify') return `你指${result.memories.map(memoryLabel).join('还是')}？`;
  if (result.kind === 'list') return `你确认保存过这些：${result.memories.map(memory => `「${memory.text}」`).join('、')}。`;
  return `你说「${result.memories[0].text}」。`;
}
