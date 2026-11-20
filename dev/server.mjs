import { createServer } from 'node:http';
import { mkdirSync, realpathSync } from 'node:fs';
import { createServer as createLockServer } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { application } from '../functions/routes.mjs';
import { createPostgresDb } from '../functions/database.mjs';
import { connectPostgres, postgresDb } from '../functions/postgres.mjs';
import { createImageValidator } from '../functions/images.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const localMode = process.argv.includes('--local');
const port = Number(process.argv.slice(2).find(arg => arg !== '--local') || (localMode ? 8787 : 8765));
const origin = `http://127.0.0.1:${port}`;
const dataDir = resolve(process.env.WHYNOT_DATA_DIR || join(ROOT, '.local', 'data'));
const ASSETS = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/__local/acceptance-ui.mjs': ['../dev/acceptance-ui.mjs', 'text/javascript'],
};

class LocalError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function lockDataDirectory() {
  mkdirSync(dataDir, { recursive: true });
  const canonical = realpathSync(dataDir);
  const hash = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const lock = createLockServer(socket => socket.destroy());
  // The OS releases this reservation even after forced termination; no stale PID can reopen the database twice.
  const address = process.platform === 'win32'
    ? { path: `\\\\.\\pipe\\whynot-${hash}`, exclusive: true }
    : { host: '127.0.0.1', port: 20000 + parseInt(hash.slice(0, 8), 16) % 20000, exclusive: true };
  await new Promise((resolve, reject) => {
    lock.once('error', () => reject(new Error('本地数据库锁已被占用，请使用已打开的本地版。')));
    lock.listen(address, resolve);
  });
  return lock;
}

async function localPostgres() {
  const url = localMode ? null : process.env.WHYNOT_TEST_DATABASE_URL;
  const files = ['schema.sql', ...await readdir(join(ROOT, 'migrations')).then(files =>
    files.filter(file => file.endsWith('.sql')).sort().map(file => `migrations/${file}`))];
  let db, query, exec, close;
  if (url) {
    const client = connectPostgres(url);
    db = postgresDb(client);
    query = (sql, params = []) => client.unsafe(sql, params);
    exec = sql => client.unsafe(sql).simple();
    close = () => client.end();
  } else {
    const lock = localMode ? await lockDataDirectory() : null;
    const pg = new PGlite(localMode ? dataDir : undefined);
    query = async (sql, params) => (await pg.query(sql, params)).rows;
    exec = sql => pg.exec(sql);
    close = async () => {
      await pg.close();
      if (lock) await new Promise(resolve => lock.close(resolve));
    };
    db = createPostgresDb(query, work => pg.transaction(async tx => work(async (sql, params) => (
      await tx.query(sql, params)
    ).rows)));
    if (localMode) {
      try {
        await pg.transaction(async tx => {
          await tx.exec('CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE IF NOT EXISTS app.local_migrations (name text PRIMARY KEY, checksum text NOT NULL)');
          const { rows } = await tx.query('SELECT name, checksum FROM app.local_migrations');
          const applied = new Map(rows.map(row => [row.name, row.checksum]));
          for (const file of files) {
            const sql = await readFile(join(ROOT, file), 'utf8');
            const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
            if (applied.has(file)) {
              if (applied.get(file) !== checksum) throw new Error(`已执行的数据库迁移被修改：${file}`);
              continue;
            }
            await tx.exec(sql);
            await tx.query('INSERT INTO app.local_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
          }
        });
      } catch (error) {
        await close();
        throw error;
      }
      return { db, query, exec, close };
    }
  }

  // Refuse an existing app schema so acceptance never touches deployed data.
  await exec('CREATE SCHEMA app');
  for (const file of files) await exec(await readFile(join(ROOT, file), 'utf8'));
  return { db, query, exec, close };
}

const TABLES = [
  'sessions', 'recommendations', 'interactions', 'turns', 'images',
  'memory_candidates', 'memories', 'memory_revisions', 'turn_memories', 'memory_deletions',
];
const FAULTS = {
  interaction: ['INSERT', 'interactions'],
  advance: ['UPDATE', 'interactions'],
  consume: ['UPDATE', 'memory_candidates'],
};

// Reproducible draw for acceptance: mulberry32 seeded via RNG_SEED.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = process.env.RNG_SEED != null ? seededRandom(Number(process.env.RNG_SEED)) : Math.random;
// Acceptance can advance the clock to exercise expiry and cooldown paths.
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

const { db, query, exec, close } = await localPostgres();
const require = createRequire(import.meta.url);
const validateImage = createImageValidator(() => readFile(require.resolve('@imagemagick/magick-wasm/magick.wasm')));
const handle = application({
  db, BackendError: LocalError, env: { get: name => process.env[name] }, localModelSettings: localMode,
  random: () => rng(), now, validateImage,
});
const maintenance = () => db.purgeExpired(new Date(now()).toISOString());
const maintenanceInterval = setInterval(() => {
  maintenance().catch(() => console.error('Local cleanup failed'));
}, Number(process.env.CLEANUP_INTERVAL_MS || (localMode ? 300000 : 1000)));
maintenanceInterval.unref();

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    if (localMode) {
      const host = incoming.headers.host;
      if (![new URL(origin).host, `localhost:${port}`].includes(host)
        || (incoming.headers.origin && incoming.headers.origin !== `http://${host}`)
        || incoming.headers['sec-fetch-site'] === 'cross-site') {
        outgoing.writeHead(403, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'FORBIDDEN' }));
        return;
      }
      if (url.pathname.startsWith('/__local/')) {
        outgoing.writeHead(404, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }
    }
    if (url.pathname === '/__local/db' && incoming.method === 'GET') {
      const tables = await Promise.all(TABLES.map(async name => [name, await query(`SELECT * FROM app.${name}`)]));
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify(Object.fromEntries(tables)));
      return;
    }
    if (url.pathname === '/__local/fault' && incoming.method === 'POST') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const { name, enabled } = JSON.parse(Buffer.concat(chunks).toString());
      if (!Object.hasOwn(FAULTS, name)) throw new LocalError('invalid_control', 400);
      const [operation, table] = FAULTS[name];
      await exec(enabled ? `
        CREATE OR REPLACE FUNCTION app.fixture_fault() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'acceptance fault'; END; $$;
        CREATE TRIGGER fixture_${name} BEFORE ${operation} ON app.${table}
        FOR EACH ROW EXECUTE FUNCTION app.fixture_fault()`
        : `DROP TRIGGER IF EXISTS fixture_${name} ON app.${table}`);
      outgoing.writeHead(204);
      outgoing.end();
      return;
    }
    if (url.pathname === '/__local/env' && incoming.method === 'POST') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const { name, value } = JSON.parse(Buffer.concat(chunks).toString());
      if (!['MODEL_API_KEY', 'MODEL_ENDPOINT', 'RNG_SEED', 'CLOCK_OFFSET_MS'].includes(name)) throw new LocalError('invalid_control', 400);
      if (name === 'RNG_SEED') rng = value === null ? Math.random : seededRandom(Number(value));
      else if (name === 'CLOCK_OFFSET_MS') clockOffset = value === null ? 0 : Number(value);
      else if (value === null) delete process.env[name];
      else process.env[name] = String(value);
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname.startsWith('/functions/v1/app')) {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      let response;
      try { response = await handle({ request, requestId: randomUUID() }); }
      catch (error) {
        response = error instanceof LocalError
          ? Response.json({ error: error.code }, { status: error.status })
          : Response.json({ error: 'STORAGE_UNAVAILABLE' }, { status: 503 });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const asset = ASSETS[url.pathname];
    if (!asset) {
      outgoing.writeHead(404, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'NOT_FOUND' }));
      return;
    }
    let bytes = await readFile(join(WEB, asset[0]));
    if (url.pathname === '/') {
      let html = bytes.toString('utf8');
      html = html.replace('data-image="0"', 'data-image="1"');
      if (localMode) {
        html = html.replace('data-local-settings="0"', 'data-local-settings="1"')
          .replace('<main class="page">', '<main class="page"><p class="share-note">本地版 · 数据保存在这台电脑，重启后保留。</p>')
          .replace('保存在服务端，用来生成回应和调整建议。', '保存在这台电脑的本地数据库，用来生成回应和调整建议。')
          .replace('此设备只保存匿名会话、主题和引导状态。', '浏览器只保存匿名会话、主题和引导状态。')
          .replace('清除浏览器数据不会删除服务端记录。', '清除浏览器数据不会删除本地数据库记录，但会失去当前匿名会话的访问入口。');
      }
      bytes = Buffer.from(html);
    }
    outgoing.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store' });
    outgoing.end(bytes);
  } catch {
    outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'local_failure' }));
  }
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenanceInterval);
  await new Promise(resolve => server.close(resolve));
  await close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.once('error', async error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请使用现有页面或指定其他端口。` : '本地服务启动失败。');
  await shutdown();
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`WhyNot ${localMode ? '本地版' : 'local fixture'}  ${origin}/`);
  if (localMode) {
    console.log('数据已启用本地持久化。按 Ctrl+C 停止。');
    console.log('在网页的「设置 → AI 模型」中配置 API。');
  }
});
