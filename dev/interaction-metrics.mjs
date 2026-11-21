import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const ratio = (value, total) => total ? value / total : null;
const percentile95 = values => values.length ? values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const count = value => Number.isSafeInteger(value) && value >= 0;

export function summarizeMetrics(events) {
  let turns = 0, openings = 0, firstReplies = 0, calls = 0, eligible = 0, hits = 0;
  const latencies = [], models = new Map();
  for (const event of events) {
    if (event?.event === 'interaction_request') {
      if (count(event.duration_ms)) latencies.push(event.duration_ms);
      if (event.success === 1 && event.replay === 0) {
        if (event.operation === 'turn') {
          turns++;
          if (event.turn_version === 1) firstReplies++;
        }
        if (event.operation === 'opening') openings++;
      }
    }
    if (event?.event === 'opening_cache' && event.eligible === true) {
      eligible++;
      if (event.hit === true) hits++;
    }
    if (event?.event !== 'model_attempt') continue;
    calls++;
    if (!/^[a-f0-9]{64}$/.test(event.config_version) || !/^[a-z0-9-]{1,64}$/.test(event.template_version)) continue;
    const key = `${event.config_version}:${event.template_version}`;
    if (!models.has(key)) models.set(key, { config_version: event.config_version, template_version: event.template_version,
      calls: 0, input_known: 0, cache_known: 0, input_tokens: 0, paired_input_tokens: 0, cached_input_tokens: 0, duration: [] });
    const model = models.get(key);
    model.calls++;
    if (count(event.duration_ms)) model.duration.push(event.duration_ms);
    if (count(event.input_tokens)) {
      model.input_known++;
      model.input_tokens += event.input_tokens;
      if (count(event.cached_input_tokens) && event.cached_input_tokens <= event.input_tokens) {
        model.cache_known++;
        model.paired_input_tokens += event.input_tokens;
        model.cached_input_tokens += event.cached_input_tokens;
      }
    }
  }
  return {
    completed_turns: turns, completed_openings: openings, first_replies: firstReplies,
    model_calls: calls, model_calls_per_100_turns: turns ? calls * 100 / turns : null,
    public_opening_reuse_rate: ratio(hits, eligible), request_p95_ms: percentile95(latencies),
    models: [...models.values()].map(model => ({
      config_version: model.config_version, template_version: model.template_version, calls: model.calls,
      input_tokens: model.input_known ? model.input_tokens : null,
      cached_input_tokens: model.cache_known ? model.cached_input_tokens : null,
      input_usage_coverage: ratio(model.input_known, model.calls), cache_usage_coverage: ratio(model.cache_known, model.calls),
      input_cache_hit_rate: ratio(model.cached_input_tokens, model.paired_input_tokens), model_p95_ms: percentile95(model.duration),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const events = [];
  for (const filename of process.argv.slice(2).length ? process.argv.slice(2) : ['-']) {
    const lines = createInterface({ input: filename === '-' ? process.stdin : createReadStream(filename), crlfDelay: Infinity });
    for await (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  console.log(JSON.stringify(summarizeMetrics(events), null, 2));
}
