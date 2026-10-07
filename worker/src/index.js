/**
 * عوي بترتاح — global counters API (Cloudflare Worker + one Durable Object).
 *
 *   GET  /totals?device=<id> → current totals (JSON, plus this device's vote)
 *   POST /flush    → body: {"batch": [["gov|char", n], ...]}  (text/plain so no CORS preflight,
 *                     and navigator.sendBeacon works on page close)
 *   POST /vote     → body: {"slug": "<candidate>", "device": "<random id>"}  one vote per device
 *                     per round (can be moved), at most 10 voting devices per IP per round
 *   GET  /ws       → WebSocket; server pushes totals whenever they change (≤ 1/s)
 *
 * Identity = the visitor's IP (CF-Connecting-IP), stored only as a salted SHA-256
 * hash. Every IP is one "visitor"; each IP gets a token bucket of clicks
 * (burst 800, refill 80/s ≈ 800 clicks per 10 s) shared by everyone behind it.
 *
 * Weekly rounds: 5 characters are on stage, the rest are candidates. When a
 * round ends (Friday 00:00 Damascus time) the candidate with the most votes
 * replaces the on-stage character with the fewest howls THIS round, and that
 * one drops into the candidates. All-time counters are never reset.
 */

import { DurableObject } from 'cloudflare:workers';

/** Every character that exists (on stage or candidate). Add new ones here. */
const CHARACTERS = ['bashar', 'maher', 'nasrallah', 'ghazwan', 'samir', 'hafez', 'soleimani'];
const INITIAL_STAGE = ['bashar', 'maher', 'nasrallah', 'ghazwan', 'samir'];
const STAGE_SIZE = 5;
const GOVERNORATES = ['damascus', 'rif-dimashq', 'aleppo', 'homs', 'hama', 'latakia', 'tartus', 'idlib', 'deir-ez-zor', 'raqqa', 'hasakah', 'daraa', 'sweida', 'quneitra'];
const CHAR_SET = new Set(CHARACTERS);
const GOV_SET = new Set(GOVERNORATES);

const VOTES_PER_IP = 10; // devices that may vote from one IP per round
const MAX_PER_FLUSH = 200; // a single request can't carry more than this
const BUCKET_SIZE = 800; // burst
const REFILL_PER_SEC = 80; // sustained clicks/sec per IP
const MAX_BODY = 4096;
const BROADCAST_MS = 1000;
const TZ_OFFSET_MS = 3 * 3600_000; // Syria is UTC+3 all year
const WEEK_MS = 7 * 24 * 3600_000;

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

/** A device id is a random token the browser generates once (crypto.randomUUID). */
const validDevice = (d) => typeof d === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(d);

/** Next Friday 00:00 Damascus time strictly after `now` (ms). */
export function nextRoundEnd(now) {
  const local = new Date(now + TZ_OFFSET_MS);
  const days = (5 - local.getUTCDay() + 7) % 7; // 5 = Friday
  let end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days) - TZ_OFFSET_MS;
  if (end <= now) end += WEEK_MS;
  return end;
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
    // X-Test-IP lets local tests simulate different visitors; ignored in production.
    const visitor = () =>
      hashIp((env.DEV === '1' && request.headers.get('X-Test-IP')) || request.headers.get('CF-Connecting-IP') || '0.0.0.0', env.IP_SALT || 'dev-salt');

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      return stub.fetch(request);
    }

    if (url.pathname === '/totals' && request.method === 'GET') {
      const device = url.searchParams.get('device');
      return json(await stub.totals(validDevice(device) ? device : null), 200, h);
    }

    if (url.pathname === '/flush' && request.method === 'POST') {
      const parsed = parseBatch(await request.text());
      if (parsed.error) return json({ error: parsed.error }, 400, h);
      const res = await stub.flush(await visitor(), parsed.items, parsed.n);
      return json(res, res.accepted ? 200 : 429, h);
    }

    if (url.pathname === '/vote' && request.method === 'POST') {
      const text = await request.text();
      let body = null;
      try {
        if (text.length < 300) body = JSON.parse(text);
      } catch {}
      const slug = body?.slug;
      if (typeof slug !== 'string' || !CHAR_SET.has(slug)) return json({ error: 'bad_slug' }, 400, h);
      if (!validDevice(body.device)) return json({ error: 'bad_device' }, 400, h);
      const res = await stub.vote(await visitor(), body.device, slug);
      return json(res, res.error ? 400 : 200, h);
    }

    // Local testing only: end the current round right now.
    if (url.pathname === '/dev/roll' && request.method === 'POST' && env.DEV === '1') return json(await stub.forceRoll(), 200, h);

    return json({ error: 'not_found' }, 404, h);
  },
};

/* ---------------- Durable Object ---------------- */

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.cache = null;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS visitors (ip TEXT PRIMARY KEY, gov TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS buckets (ip TEXT PRIMARY KEY, tokens REAL NOT NULL, t INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS round_howls (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
      `);
      // v2 votes are keyed by device (v1 was one vote per IP). Old per-IP rows can't
      // be mapped to a device, so the table is recreated.
      const cols = this.sql.exec("SELECT name FROM pragma_table_info('votes')").toArray().map((r) => r.name);
      if (cols.length && !cols.includes('device')) this.sql.exec('DROP TABLE votes');
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS votes (device TEXT PRIMARY KEY, ip TEXT NOT NULL, slug TEXT NOT NULL, t INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS votes_ip ON votes (ip);
      `);
      this.loadRound();
      // Make sure the round ends even if nobody is on the site at that moment.
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(this.round.endsAt);
    });
  }

  /* ---------- rounds ---------- */

  getMeta(k) {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }

  setMeta(k, v) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  /** Load (or create) the stage line-up and the current round. */
  loadRound() {
    const stage = (this.getMeta('stage') || INITIAL_STAGE).filter((s) => CHAR_SET.has(s));
    // A character removed from CHARACTERS drops off stage; refill from the candidates.
    for (const c of CHARACTERS) if (stage.length < STAGE_SIZE && !stage.includes(c)) stage.push(c);
    this.stage = stage;
    this.round = this.getMeta('round') || { id: 1, endsAt: nextRoundEnd(Date.now()) };
    this.last = this.getMeta('last');
    this.setMeta('stage', this.stage);
    this.setMeta('round', this.round);
  }

  candidates() {
    return CHARACTERS.filter((c) => !this.stage.includes(c));
  }

  /** End every round whose time has passed (normally at most one). */
  maybeRoll(now = Date.now()) {
    let rolled = false;
    while (this.round.endsAt <= now) {
      this.roll();
      rolled = true;
    }
    if (rolled) this.cache = null;
    return rolled;
  }

  roll() {
    const cands = new Set(this.candidates());
    const tally = this.sql
      .exec('SELECT slug, COUNT(*) AS n FROM votes GROUP BY slug')
      .toArray()
      .filter((r) => cands.has(r.slug));
    const top = Math.max(0, ...tally.map((r) => r.n));
    let result = { round: this.round.id, endedAt: this.round.endsAt, winner: null, loser: null, votes: top };

    if (top > 0) {
      // Tie → whoever reached the top vote count first.
      const tied = tally
        .filter((r) => r.n === top)
        .map((r) => ({ slug: r.slug, at: this.sql.exec('SELECT t FROM votes WHERE slug = ? ORDER BY t LIMIT 1 OFFSET ?', r.slug, top - 1).one().t }))
        .sort((a, b) => a.at - b.at);
      const winner = tied[0].slug;
      // Loser = fewest howls this round; tie → fewer all-time howls; tie → later on stage.
      const howls = Object.fromEntries(this.sql.exec('SELECT slug, n FROM round_howls').toArray().map((r) => [r.slug, r.n]));
      const allTime = Object.fromEntries(
        this.sql.exec("SELECT k, n FROM counters WHERE k LIKE 'c:%'").toArray().map((r) => [r.k.slice(2), r.n]),
      );
      const loser = this.stage
        .map((slug, i) => ({ slug, i, r: howls[slug] || 0, a: allTime[slug] || 0 }))
        .sort((x, y) => x.r - y.r || x.a - y.a || y.i - x.i)[0].slug;
      this.stage[this.stage.indexOf(loser)] = winner;
      result = { ...result, winner, loser };
    }

    this.sql.exec('DELETE FROM votes');
    this.sql.exec('DELETE FROM round_howls');
    // The Friday after the one that just ended (also re-aligns after a forced roll).
    this.round = { id: this.round.id + 1, endsAt: nextRoundEnd(this.round.endsAt) };
    this.last = result;
    this.setMeta('stage', this.stage);
    this.setMeta('round', this.round);
    this.setMeta('last', this.last);
  }

  async forceRoll() {
    this.round.endsAt = Date.now();
    this.maybeRoll();
    await this.scheduleBroadcast();
    return { last: this.last, totals: await this.totals() };
  }

  /**
   * One vote per DEVICE per round (voting again just moves it), and at most
   * VOTES_PER_IP devices may vote from the same IP in a round — so a family or
   * a café can all vote, but private windows stop helping after 10.
   */
  async vote(ip, device, slug) {
    this.maybeRoll();
    if (!this.candidates().includes(slug)) return { error: 'not_candidate' };
    const prev = this.sql.exec('SELECT slug FROM votes WHERE device = ?', device).toArray()[0];
    if (!prev) {
      const used = this.sql.exec('SELECT COUNT(*) AS n FROM votes WHERE ip = ?', ip).one().n;
      if (used >= VOTES_PER_IP) return { error: 'ip_limit', limit: VOTES_PER_IP };
      this.sql.exec('INSERT INTO votes (device, ip, slug, t) VALUES (?, ?, ?, ?)', device, ip, slug, Date.now());
    } else if (prev.slug !== slug) {
      // Moving a vote keeps the IP it was first cast from (no slot shopping).
      this.sql.exec('UPDATE votes SET slug = ?, t = ? WHERE device = ?', slug, Date.now(), device);
    }
    if (prev?.slug !== slug) {
      this.cache = null;
      await this.scheduleBroadcast();
    }
    return { myVote: slug, totals: await this.totals(device) };
  }

  /* ---------- totals ---------- */

  /** Shared totals (cached until the next write), plus this device's vote if `device` is given. */
  async totals(device) {
    this.maybeRoll();
    this.cache ||= this.buildTotals();
    if (!device) return this.cache;
    const myVote = this.sql.exec('SELECT slug FROM votes WHERE device = ?', device).toArray()[0]?.slug || null;
    return { ...this.cache, myVote };
  }

  buildTotals() {
    const t = {
      total: 0,
      characters: {},
      governorates: {},
      matrix: {},
      visitors: { total: 0, governorates: {} },
      stage: [...this.stage],
      candidates: this.candidates(),
      round: { id: this.round.id, endsAt: this.round.endsAt, howls: {}, votes: {} },
      last: this.last,
    };
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
    for (const { slug, n } of this.sql.exec('SELECT slug, n FROM round_howls')) t.round.howls[slug] = n;
    for (const { slug, n } of this.sql.exec('SELECT slug, COUNT(*) AS n FROM votes GROUP BY slug')) t.round.votes[slug] = n;
    return t;
  }

  /* ---------- clicks ---------- */

  /** One flush from one visitor (IP hash). All writes happen synchronously → atomic. */
  async flush(ip, items, n) {
    const now = Date.now();
    this.maybeRoll(now);
    // token bucket per IP
    const row = this.sql.exec('SELECT tokens, t FROM buckets WHERE ip = ?', ip).toArray()[0];
    let tokens = row ? Math.min(BUCKET_SIZE, row.tokens + ((now - row.t) / 1000) * REFILL_PER_SEC) : BUCKET_SIZE;
    const allowed = Math.min(n, Math.floor(tokens));
    const saveBucket = () =>
      this.sql.exec('INSERT INTO buckets (ip, tokens, t) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET tokens = excluded.tokens, t = excluded.t', ip, tokens, now);
    if (allowed <= 0) {
      saveBucket();
      return { accepted: 0, reason: 'rate_limited' };
    }
    tokens -= allowed;

    // Trim the batch to what the bucket allows (keeps order).
    let left = allowed;
    const bump = new Map();
    const roundBump = new Map();
    const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    let lastGov = null;
    for (const [gov, char, count] of items) {
      const c = Math.min(count, left);
      if (!c) break;
      left -= c;
      add(bump, 'total', c);
      add(bump, `c:${char}`, c);
      add(bump, `g:${gov}`, c);
      add(bump, `m:${gov}:${char}`, c);
      add(roundBump, char, c);
      lastGov = gov;
    }

    saveBucket();
    for (const [k, v] of bump) this.sql.exec('INSERT INTO counters (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n', k, v);
    for (const [k, v] of roundBump) this.sql.exec('INSERT INTO round_howls (slug, n) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET n = n + excluded.n', k, v);
    // One IP = one visitor, counted in the governorate it howls from most recently.
    this.sql.exec(
      'INSERT INTO visitors (ip, gov, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET gov = excluded.gov, last_seen = excluded.last_seen',
      ip,
      lastGov,
      now,
      now,
    );

    this.cache = null;
    await this.scheduleBroadcast();
    return { accepted: allowed, dropped: n - allowed, totals: await this.totals() };
  }

  /* ---------- broadcast + round timer (one alarm does both) ---------- */

  async scheduleBroadcast() {
    const want = Date.now() + BROADCAST_MS;
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > want) await this.ctx.storage.setAlarm(want);
  }

  async alarm() {
    this.maybeRoll();
    const msg = JSON.stringify(await this.totals());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
    // Housekeeping: forget buckets that are full again (idle > 10 s).
    this.sql.exec('DELETE FROM buckets WHERE t < ?', Date.now() - 10_000);
    await this.ctx.storage.setAlarm(this.round.endsAt);
  }

  /* ---------- WebSocket (Hibernation API) ---------- */

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
