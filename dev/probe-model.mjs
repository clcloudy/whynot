const endpoint = process.env.MODEL_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) { console.error('缺少 MODEL_API_KEY 环境变量'); process.exit(1); }

let valid = false;
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'Reply with exactly the uppercase word OK.' }],
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(15000),
    });
    console.log('尝试', attempt, 'HTTP', response.status);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.log('error type:', data?.error?.type ?? 'unknown', '| code:', data?.error?.code ?? 'unknown');
      if (response.status < 500) break;
      continue;
    }
    const choice = data?.choices?.[0];
    valid = choice?.message?.content?.trim() === 'OK';
    if (valid) break;
    console.log('响应结构:', JSON.stringify({ finish: choice?.finish_reason, contentLength: choice?.message?.content?.length }));
  } catch (error) {
    console.log('网络失败:', error.name);
  }
}
console.log('模型响应正常:', valid);
process.exitCode = valid ? 0 : 1;
