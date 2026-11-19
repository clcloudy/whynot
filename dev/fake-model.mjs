// Credential-free fake OpenAI-compatible endpoint for local model-path checks.
import { createServer } from 'node:http';

const CARD = { title: ' fake 建议', first_step: '先深呼吸一次。', detail: '这是本地测试输出。', minutes: 2, category: 'rest' };
const reply = content => ({ choices: [{ message: { content } }] });
const counts = {};

const server = createServer((request, response) => {
  const mode = new URL(request.url, 'http://x').pathname.split('/')[1];
  request.resume();
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (mode === 'counts') return send(200, counts);
  counts[mode] = (counts[mode] ?? 0) + 1;
  if (mode === 'valid') return send(200, reply(JSON.stringify(CARD)));
  if (mode === 'schema-bad') return send(200, reply(JSON.stringify({ ...CARD, minutes: 99 })));
  if (mode === 'not-json') return send(200, reply('抱歉，我无法回答。'));
  if (mode === 'http500') return send(500, { error: 'fake upstream failure' });
  if (mode === 'http401') return send(401, { error: 'fake invalid key' });
  if (mode === 'slow') return setTimeout(() => send(200, reply(JSON.stringify(CARD))), 9000);
  send(404, { error: 'unknown mode' });
});

server.listen(8766, '127.0.0.1', () => console.log('fake model  http://127.0.0.1:8766/<mode>'));