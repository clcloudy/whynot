// Local fixture server: serves web/ and runs the real application routes with
// a fresh PostgreSQL schema. Defaults to the embedded PostgreSQL engine.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { application } from '../functions/routes.mjs';
import { createPostgresDb } from '../functions/database.mjs';
import { connectPostgres, postgresDb } from '../functions/postgres.mjs';
import { createImageValidator } from '../functions/images.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const ASSETS = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

class LocalError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function localPostgres() {
  const url = process.env.WHYNOT_TEST_DATABASE_URL;
  let db, query, exec;
  if (url) {
    const client = connectPostgres(url);
    db = postgresDb(client);
    query = (sql, params = []) => client.unsafe(sql, params);
    exec = sql => client.unsafe(sql).simple();
  } else {
    const pg = new PGlite();
    query = async (sql, params) => (await pg.query(sql, params)).rows;
    exec = sql => pg.exec(sql);
    db = createPostgresDb(query, work => pg.transaction(async tx => work(async (sql, params) => (
      await tx.query(sql, params)
    ).rows)));
  }

  // Refuse an existing app schema so acceptance never touches deployed data.
  await exec('CREATE SCHEMA app');
  for (const file of ['schema.sql', ...await readdir(join(ROOT, 'migrations')).then(files =>
    files.filter(file => file.endsWith('.sql')).sort().map(file => `migrations/${file}`))]) {
    await exec(await readFile(join(ROOT, file), 'utf8'));
  }
  return { db, query, exec };
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

const { db, query, exec } = await localPostgres();
const require = createRequire(import.meta.url);
const validateImage = createImageValidator(() => readFile(require.resolve('@imagemagick/magick-wasm/magick.wasm')));
const handle = application({ db, BackendError: LocalError, env: { get: name => process.env[name] }, random: () => rng(), now, validateImage });
const port = Number(process.argv[2] || 8765);
const maintenance = () => db.purgeExpired(new Date(now()).toISOString());
const maintenanceInterval = setInterval(() => {
  maintenance().catch(() => console.error('Local cleanup failed'));
}, Number(process.env.CLEANUP_INTERVAL_MS || 1000));
maintenanceInterval.unref();

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
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
    const bytes = await readFile(join(WEB, asset[0]));
    outgoing.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store' });
    outgoing.end(bytes);
  } catch {
    outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'local_failure' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`WhyNot local fixture  http://127.0.0.1:${port}/  (PostgreSQL, fresh schema)`);
});
