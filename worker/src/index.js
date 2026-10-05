/**
 * عوي بترتاح — global counters API (Cloudflare Worker + one Durable Object).
 *
 *   GET  /totals   → current totals (JSON)
 *   POST /flush    → body: {"batch": [["gov|char", n], ...]}  (text/plain so no CORS preflight,
 *                     and navigator.sendBeacon works on page close)
 *   GET  /ws       → WebSocket; server pushes totals whenever they change (≤ 1/s)
 *
 * Identity = the visitor's IP (CF-Connecting-IP), stored only as a salted SHA-256
 * hash. Every IP is one "visitor"; each IP gets a token bucket of clicks
 * (burst 800, refill 80/s ≈ 800 clicks per 10 s) shared by everyone behind it.
 */

import { DurableObject } from 'cloudflare:workers';

const CHARACTERS = ['bashar', 'maher', 'nasrallah', 'ghazwan', 'samir'];
const GOVERNORATES = ['damascus', 'rif-dimashq', 'aleppo', 'homs', 'hama', 'latakia', 'tartus', 'idlib', 'deir-ez-zor', 'raqqa', 'hasakah', 'daraa', 'sweida', 'quneitra'];
const CHAR_SET = new Set(CHARACTERS);
const GOV_SET = new Set(GOVERNORATES);

const MAX_PER_FLUSH = 200; // a single request can't carry more than this
const BUCKET_SIZE = 800; // burst
const REFILL_PER_SEC = 80; // sustained clicks/sec per IP
const MAX_BODY = 4096;
const BROADCAST_MS = 1000;

/* ---------------- helpers ---------------- */

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const ok = allowed.includes(origin) || (env.DEV === '1' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
  return ok
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    : {};
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function hashIp(ip, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip));
  return [...new Uint8Array(buf).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse + validate a flush body. Returns {items, n} or {error}. */
export function parseBatch(text) {
  if (text.length > MAX_BODY) return { error: 'too_large' };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: 'bad_json' };
  }
  if (!body || !Array.isArray(body.batch) || !body.batch.length || body.batch.length > 70) return { error: 'bad_batch' };
  const items = [];
  let n = 0;
  for (const entry of body.batch) {
    if (!Array.isArray(entry) || entry.length !== 2) return { error: 'bad_entry' };
    const [key, count] = entry;
    if (typeof key !== 'string' || !Number.isInteger(count) || count < 1) return { error: 'bad_entry' };
    const [gov, char, extra] = key.split('|');
    if (extra !== undefined || !GOV_SET.has(gov) || !CHAR_SET.has(char)) return { error: 'bad_slug' };
    items.push([gov, char, count]);
    n += count;
  }
  if (n > MAX_PER_FLUSH) return { error: 'too_many' };
  return { items, n };
}

/* ---------------- Worker entry ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const h = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const stub = env.COUNTER.getByName('global');

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      return stub.fetch(request);
    }

    if (url.pathname === '/totals' && request.method === 'GET') return json(await stub.totals(), 200, h);

    if (url.pathname === '/flush' && request.method === 'POST') {
      const parsed = parseBatch(await request.text());
      if (parsed.error) return json({ error: parsed.error }, 400, h);
      // Local testing only: simulate different visitors.
      const ip = (env.DEV === '1' && request.headers.get('X-Test-IP')) || request.headers.get('CF-Connecting-IP') || '0.0.0.0';
      const visitor = await hashIp(ip, env.IP_SALT || 'dev-salt');
      const res = await stub.flush(visitor, parsed.items, parsed.n);
      return json(res, res.accepted ? 200 : 429, h);
    }

    return json({ error: 'not_found' }, 404, h);
  },
};

/* ---------------- Durable Object ---------------- */

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS visitors (ip TEXT PRIMARY KEY, gov TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS buckets (ip TEXT PRIMARY KEY, tokens REAL NOT NULL, t INTEGER NOT NULL);
      `);
    });
    this.cache = null;
  }

  /** Build the totals object from storage (cached until the next write). */
  async totals() {
    if (this.cache) return this.cache;
    const t = { total: 0, characters: {}, governorates: {}, matrix: {}, visitors: { total: 0, governorates: {} } };
    for (const { k, n } of this.sql.exec('SELECT k, n FROM counters')) {
      const [kind, a, b] = k.split(':');
      if (kind === 'total') t.total = n;
      else if (kind === 'c') t.characters[a] = n;
      else if (kind === 'g') t.governorates[a] = n;
      else if (kind === 'm') (t.matrix[a] ||= {})[b] = n;
    }
    for (const { gov, n } of this.sql.exec('SELECT gov, COUNT(*) AS n FROM visitors GROUP BY gov')) {
      t.visitors.governorates[gov] = n;
      t.visitors.total += n;
    }
    this.cache = t;
    return t;
  }

  /** One flush from one visitor (IP hash). All writes happen synchronously → atomic. */
  async flush(ip, items, n) {
    const now = Date.now();
    // token bucket per IP
    const row = this.sql.exec('SELECT tokens, t FROM buckets WHERE ip = ?', ip).toArray()[0];
    let tokens = row ? Math.min(BUCKET_SIZE, row.tokens + ((now - row.t) / 1000) * REFILL_PER_SEC) : BUCKET_SIZE;
    const allowed = Math.min(n, Math.floor(tokens));
    if (allowed <= 0) {
      this.sql.exec('INSERT INTO buckets (ip, tokens, t) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET tokens = excluded.tokens, t = excluded.t', ip, tokens, now);
      return { accepted: 0, reason: 'rate_limited' };
    }
    tokens -= allowed;

    // Trim the batch to what the bucket allows (keeps order).
    let left = allowed;
    const bump = new Map();
    const add = (k, v) => bump.set(k, (bump.get(k) || 0) + v);
    let lastGov = null;
    for (const [gov, char, count] of items) {
      const c = Math.min(count, left);
      if (!c) break;
      left -= c;
      add('total', c);
      add(`c:${char}`, c);
      add(`g:${gov}`, c);
      add(`m:${gov}:${char}`, c);
      lastGov = gov;
    }

    this.sql.exec('INSERT INTO buckets (ip, tokens, t) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET tokens = excluded.tokens, t = excluded.t', ip, tokens, now);
    for (const [k, v] of bump) this.sql.exec('INSERT INTO counters (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n', k, v);
    // One IP = one visitor, counted in the governorate it howls from most recently.
    this.sql.exec('INSERT INTO visitors (ip, gov, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET gov = excluded.gov, last_seen = excluded.last_seen', ip, lastGov, now, now);

    this.cache = null;
    this.scheduleBroadcast();
    return { accepted: allowed, dropped: n - allowed, totals: await this.totals() };
  }

  async scheduleBroadcast() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + BROADCAST_MS);
  }

  async alarm() {
    const msg = JSON.stringify(await this.totals());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
    // Housekeeping: forget buckets that are full again (idle > 10 s).
    this.sql.exec('DELETE FROM buckets WHERE t < ?', Date.now() - 10_000);
  }

  /* WebSocket (Hibernation API) */
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(await this.totals()));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }
}
