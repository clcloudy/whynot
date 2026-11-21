import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_CATALOG = fileURLToPath(new URL('../functions/activity-catalog.v1.json', import.meta.url));
export const DEFAULT_EXAMPLES = fileURLToPath(new URL('../deliverables/activity-examples/activity-examples.v1.jsonl', import.meta.url));
export const HELP = `离线活动卡生成与人工发布（不会修改正式库）

node dev/activity-content.mjs --help
node dev/activity-content.mjs generate TASK.json OUTPUT.json [--catalog CATALOG.json] [--examples EXAMPLES.jsonl]
node dev/activity-content.mjs publish DRAFT.json OUTPUT.json --reviewer NAME [--catalog PREVIOUS.json]
node dev/activity-content.mjs coverage [CATALOG.json]

TASK.json 是一个任务、任务数组或 {"tasks":[...]}。
排队低精力3分钟的小试任务：deliverables/activity-examples/generation-tasks.v1.json（3原型各2稿）。
任务必填：id、prototype_id、scene、energy、budget、category、variation。
scene: null/waiting/desk/outside/home；energy: low/steady/high；budget: 3/5/10/15。
category: rest/observe/listen/tidy/explore，须匹配原型；low 不允许 explore。
id 必须是新卡 ID。variation 是这次变化的非空简短描述。
默认主库：functions/activity-catalog.v1.json；示例只用于参考，不用 time_band 推断 minutes。

环境：MODEL_API_KEY 必填；MODEL_ENDPOINT 默认 https://api.deepseek.com/chat/completions；
MODEL 默认 deepseek-flash（兼容 MODEL_MODEL）。只允许 HTTPS 或 loopback HTTP，不跟随重定向。
每次请求最多7秒、最多2次尝试。无密钥不调用。样例段 UTF-8 字节上界200，实际 token 以 usage 为准。
草稿包仅保存 draft 卡及非原文 generation 元数据；部分或全部失败仍保存计费记录，并以状态码1退出。
编辑后人工显式 publish --reviewer 才会批准仍在 cards 中的稿件。淘汰可移除 cards 中的卡，
但必须保留 generation 的所有尝试记录；失败、重试和淘汰的 usage 全部计入每批准卡成本。
缺 usage 显示 unknown（并列已知小计），库存推荐 token=0。
发布在 --catalog 指定的完整旧库上追加卡及历史，输出新版本；不会覆盖、删除或 retire 旧卡。
新一轮生成/发布请用 --catalog 指向上次输出；默认库不会自动切换。
启用新版：审核输出后，将 functions/suggestions.mjs 的 JSON import 改为新版库文件并重启服务。
卡版本保留生成模型、时间和实际样例引用；命令输出的报告包含失败与淘汰成本。
OUTPUT 必须显式提供，父目录必须已存在，wx 拒绝覆盖任何文件。不会创建目录、联网发布或自动提交。
`;

function cliError(code) { const error = new Error(code); error.code = code; return error; }
function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { command: 'help' };
  const [command, ...args] = argv;
  if (!['generate', 'publish', 'coverage'].includes(command)) throw cliError('USAGE_ERROR');
  const allowed = command === 'generate' ? ['--catalog', '--examples'] : command === 'publish' ? ['--catalog', '--reviewer'] : [];
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith('-')) {
      if (!allowed.includes(argument) || Object.hasOwn(options, argument) || !args[index + 1] || args[index + 1].startsWith('-')) {
        throw cliError('USAGE_ERROR');
      }
      options[argument] = args[++index];
    } else positional.push(argument);
  }
  if (command === 'coverage' ? positional.length > 1 : positional.length !== 2) throw cliError('USAGE_ERROR');
  if (command === 'publish' && !options['--reviewer']?.trim()) throw cliError('REVIEWER_REQUIRED');
  return { command, positional, options };
}
async function readJSON(file, io) {
  try { return JSON.parse(await io.readFile(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw cliError('INVALID_JSON_FILE'); throw error; }
}
async function checkOutput(output, catalogPath, io) {
  if ([DEFAULT_CATALOG, catalogPath].some(file => path.resolve(file) === output)) throw cliError('CATALOG_OVERWRITE_FORBIDDEN');
  if (!(await io.stat(path.dirname(output))).isDirectory()) throw cliError('OUTPUT_PARENT_NOT_DIRECTORY');
  try { await io.lstat(output); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw cliError('OUTPUT_EXISTS');
}
async function writeJSON(file, value, io) {
  await io.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
function generationReport(draft) {
  return { draft_cards: draft.cards.length, failed_tasks: draft.generation.tasks.filter(task => task.error).length,
    tasks: draft.generation.tasks.map(task => ({ id: task.task.id, card_id: task.card_id, error: task.error })),
    usage: draft.generation.usage };
}

// Injectable I/O keeps CLI tests entirely in memory. No tests need a key or a live endpoint.
export async function runCli(argv, { io = fs, env = process.env, fetchImpl = globalThis.fetch,
  timeoutMs, maxAttempts, now, stdout = value => console.log(value), stderr = value => console.error(value) } = {}) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') { stdout(HELP); return 0; }
    const { command, positional, options } = parsed;
    const catalogPath = path.resolve(command === 'coverage' ? positional[0] || DEFAULT_CATALOG : options['--catalog'] || DEFAULT_CATALOG);
    // --help does not load a catalog or require the generation implementation.
    const { validateCatalog, coverageReport } = await import('../functions/activity-catalog.mjs');
    const catalog = await readJSON(catalogPath, io);
    if (validateCatalog(catalog).length) throw cliError('INVALID_CATALOG');
    if (command === 'coverage') {
      stdout(JSON.stringify({ version: catalog.version, inventory_recommendation_tokens: 0, coverage: coverageReport(catalog) }, null, 2));
      return 0;
    }
    const output = path.resolve(positional[1]);
    await checkOutput(output, catalogPath, io);
    const { generateDraft, parseExamples, publishDraft } = await import('../functions/activity-generation.mjs');
    const input = await readJSON(path.resolve(positional[0]), io);
    if (command === 'generate') {
      const tasks = Array.isArray(input) ? input : Array.isArray(input?.tasks) ? input.tasks : [input];
      const examples = parseExamples(await io.readFile(path.resolve(options['--examples'] || DEFAULT_EXAMPLES), 'utf8'));
      const draft = await generateDraft({ tasks, catalog, examples, env, fetchImpl, timeoutMs, maxAttempts, now });
      await writeJSON(output, draft, io);
      const report = generationReport(draft);
      stdout(JSON.stringify({ output, ...report }, null, 2));
      return report.failed_tasks ? 1 : 0;
    }
    const { catalog: next, report } = publishDraft({ draft: input, previous: catalog, reviewer: options['--reviewer'], now });
    await writeJSON(output, next, io);
    stdout(JSON.stringify({ output, ...report }, null, 2));
    return 0;
  } catch (error) {
    // Never echo a filesystem/transport message: it may embed a prompt, response or secret.
    const known = ['USAGE_ERROR', 'REVIEWER_REQUIRED', 'INVALID_JSON_FILE', 'CATALOG_OVERWRITE_FORBIDDEN',
      'OUTPUT_PARENT_NOT_DIRECTORY', 'OUTPUT_EXISTS', 'ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'INVALID_CATALOG'];
    const code = error?.name === 'ActivityContentError' || known.includes(error?.code) ? error.code : 'ACTIVITY_CONTENT_FAILED';
    stderr(JSON.stringify({ error: code }));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
