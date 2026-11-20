// Local fixture server: serves web/ and runs the real application routes with
// an in-memory database. No cloud credentials. Data resets on restart.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { application } from '../functions/routes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const ASSETS = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/__local/acceptance-ui.mjs': ['../dev/acceptance-ui.mjs', 'text/javascript'],
};

class LocalError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function createMemoryDb() {
  const tables = { sessions: [], recommendations: [] };
  const primaryKey = { sessions: 'owner', recommendations: 'id' };
  const defaults = {
    sessions: () => ({ created_at: new Date().toISOString() }),
    recommendations: () => ({ id: randomUUID(), scene: null, preference: null, completed: false, created_at: new Date().toISOString() }),
  };
  function from(table) {
    if (!(table in tables)) throw new LocalError('invalid_table', 400);
    const filters = [], order = [];
    let mode = 'read', values, conflict, columns, count = 1000;
    const query = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      order(key, options = {}) { order.push([key, options.ascending !== false]); return query; },
      limit(value) { count = value; return query; },
      insert(value) { mode = 'insert'; values = value; return query; },
      insertIfAbsent(value, options) { mode = 'insert'; values = value; conflict = options.onConflict.split(','); return query; },
      update(value) { mode = 'update'; values = value; return query; },
      then(fulfilled, rejected) {
        return Promise.resolve().then(() => {
          let result;
          if (mode === 'insert') {
            if (conflict && tables[table].some(row => conflict.every(key => row[key] === values[key]))) result = [];
            else {
              const row = { ...defaults[table](), ...values };
              const pk = primaryKey[table];
              if (tables[table].some(existing => existing[pk] === row[pk])) return { data: null, error: { code: 'unique_violation', status: 409 } };
              if (table === 'recommendations' && !tables.sessions.some(session => session.owner === row.owner)) {
                return { data: null, error: { code: 'foreign_key_violation', status: 409 } };
              }
              tables[table].push(row);
              result = [row];
            }
          } else {
            result = tables[table].filter(row => filters.every(([key, value]) => row[key] === value));
            if (mode === 'update') result.forEach(row => Object.assign(row, values));
          }
          for (const [key, asc] of [...order].reverse()) {
            result = [...result].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (asc ? 1 : -1));
          }
          result = result.slice(0, count).map(row => columns
            ? Object.fromEntries(columns.split(',').map(key => [key, row[key]]))
            : { ...row });
          return { data: result, error: null };
        }).then(fulfilled, rejected);
      },
    };
    return query;
  }
  return { from, tables };
}

const db = createMemoryDb();
const handle = application({ db, BackendError: LocalError, env: { get: name => process.env[name] } });
const port = Number(process.argv[2] || 8765);

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    if (url.pathname === '/__local/db' && incoming.method === 'GET') {
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify(db.tables));
      return;
    }
    if (url.pathname === '/__local/env' && incoming.method === 'POST') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const { name, value } = JSON.parse(Buffer.concat(chunks).toString());
      if (!['MODEL_API_KEY', 'MODEL_ENDPOINT'].includes(name)) throw new LocalError('invalid_control', 400);
      if (value === null) delete process.env[name];
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
  console.log(`WhyNot local fixture  http://127.0.0.1:${port}/  (in-memory data, no cloud)`);
});