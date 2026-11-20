import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [file, expectedWord, expectedMeaning, expectedIpa] = process.argv.slice(2);
if (!file || !expectedWord || !expectedMeaning || !expectedIpa?.includes('ˈ')) {
  throw new Error('用法：node dev/acceptance-vision-real.mjs <照片路径> <英文词> <中文词义> <带重音的音标>');
}

const base = process.env.BASE || 'http://127.0.0.1:8765';
const prefix = `${base}/functions/v1/app`;
const photo = await readFile(file);
const session = await fetch(`${prefix}/api/session`, { method: 'POST' });
assert.equal(session.status, 200, '创建会话');
const { token } = await session.json();
const headers = { 'x-whynot-session': token };

// With a new owner the first seed's roll falls in the photo interval [0.75, 1).
const control = await fetch(`${base}/__local/env`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'RNG_SEED', value: 4 }),
});
assert.equal(control.status, 200, '设置本地验收随机种子');
const opening = await fetch(`${prefix}/api/interactions`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ scene: 'desk', energy: 'steady', budget: 5, request_id: randomUUID(), supports: ['text', 'image'] }),
});
await fetch(`${base}/__local/env`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'RNG_SEED', value: null }),
});
assert.equal(opening.status, 201, '打开互动');
const card = await opening.json();
assert.equal(card.mode, 'photo', '开启看图学词（需要服务端模型配置）');

const upload = await fetch(`${prefix}/api/interactions/${card.id}/images?version=${card.version}`, {
  method: 'POST', headers, body: photo,
});
assert.equal(upload.status, 201, '上传真实照片');
const { image_ref } = await upload.json();
const recognition = await fetch(`${prefix}/api/interactions/${card.id}/turns`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ request_id: randomUUID(), version: card.version, image_ref }),
});
assert.equal(recognition.status, 201, '视觉模型完成识别');
const { word } = await recognition.json();
assert.ok(word, '物品无歧义且返回词条');
assert.equal(word.word.toLowerCase(), expectedWord.toLowerCase(), '英文词');
assert.ok(word.meaning.includes(expectedMeaning), '中文词义');
assert.equal(word.ipa, expectedIpa, '音标与重音');
console.log('照片上传、英文词、中文词义和带重音的音标均通过');
