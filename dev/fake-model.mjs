// Credential-free fake OpenAI-compatible endpoint for local model-path checks.
import { createServer } from 'node:http';

const CARD = { title: ' fake 建议', first_step: '先深呼吸一次。', detail: '这是本地测试输出。', minutes: 2, category: 'rest' };
const OPENING = { title: ' fake 开场', first_step: '这周你花在什么事情上的时间最多？', detail: '这是本地测试开场。', minutes: 2 };
const REPLY = { text: ' fake 追问：那件事里最让你在意的是什么？' };
const MEMORY_REPLY = { text: ' fake 追问：听起来挺投入的，你负责哪一部分？', memory: { text: '最近在排练节目', kind: 'status', topic: '排练' } };
const VISION_WORD = { word: 'stapler', ipa: '/ˈsteɪ.plɚ/', meaning: '订书机', practice: '指着它说一遍 stapler，注意第一个音节重读。' };
const VISION_AMBIGUOUS = { question: '图里有几样东西，你想学哪一个的英文？' };
const reply = content => ({ choices: [{ message: { content } }] });
const counts = {};
let lastMessages = [];
let releaseReply;

// The interaction adapters are distinguished by their system prompt; vision
// requests carry an image_url part.
function kindOf(body) {
  const messages = body?.messages ?? [];
  if (messages.some(message => Array.isArray(message.content)
    && message.content.some(part => part.type === 'image_url'))) return 'vision';
  const system = messages[0]?.content ?? '';
  if (system.includes('开场生成器')) return 'opening';
  if (system.includes('伙伴')) return 'reply';
  return 'card';
}

const server = createServer((request, response) => {
  const mode = new URL(request.url, 'http://x').pathname.split('/')[1];
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const kind = kindOf(body);
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (mode === 'counts') return send(200, counts);
    if (mode === 'messages') return send(200, lastMessages);
    if (mode === 'release') {
      releaseReply?.();
      releaseReply = null;
      return send(200, { ok: true });
    }
    counts[mode] = (counts[mode] ?? 0) + 1;
    if (mode === 'capture' || mode === 'hold') lastMessages = body?.messages ?? [];
    if (mode === 'hold' && kind === 'reply') {
      const nearStatus = lastMessages[0].content.split('\n')
        .find(line => line.includes('用户确认过的近况'))?.split('：').at(-1);
      releaseReply = () => send(200, reply(JSON.stringify({ text: nearStatus || REPLY.text })));
      return;
    }
    if (['valid', 'capture', 'hold', 'memory-candidate'].includes(mode)) {
      if (kind === 'vision') return send(200, reply(JSON.stringify(VISION_WORD)));
      if (kind === 'opening') return send(200, reply(JSON.stringify(OPENING)));
      if (kind === 'reply') return send(200, reply(JSON.stringify(mode === 'memory-candidate' ? MEMORY_REPLY : REPLY)));
      return send(200, reply(JSON.stringify(CARD)));
    }
    if (mode === 'ambiguous') {
      if (kind === 'vision') return send(200, reply(JSON.stringify(VISION_AMBIGUOUS)));
      if (kind === 'reply') return send(200, reply(JSON.stringify(REPLY)));
      if (kind === 'opening') return send(200, reply(JSON.stringify(OPENING)));
      return send(200, reply(JSON.stringify(CARD)));
    }
    if (mode === 'schema-bad') {
      if (kind === 'vision') return send(200, reply(JSON.stringify({ word: 'x'.repeat(60) })));
      if (kind === 'reply') return send(200, reply(JSON.stringify({ text: '长'.repeat(200) })));
      if (kind === 'opening') return send(200, reply(JSON.stringify({ ...OPENING, minutes: 99 })));
      return send(200, reply(JSON.stringify({ ...CARD, minutes: 99 })));
    }
    if (mode === 'not-json') return send(200, reply('抱歉，我无法回答。'));
    if (mode === 'http500') return send(500, { error: 'fake upstream failure' });
    if (mode === 'http401') return send(401, { error: 'fake invalid key' });
    if (mode === 'slow') {
      const payload = kind === 'vision' ? VISION_WORD : kind === 'reply' ? REPLY : kind === 'opening' ? OPENING : CARD;
      return setTimeout(() => send(200, reply(JSON.stringify(payload))), 9000);
    }
    send(404, { error: 'unknown mode' });
  });
});

server.listen(8766, '127.0.0.1', () => console.log('fake model  http://127.0.0.1:8766/<mode>'));
