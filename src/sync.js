/**
 * sync.js — click batching + totals.
 *
 * Clicks only touch an in-memory Map (zero I/O per click). Every SYNC.flushMs
 * the batch goes to the Worker API as one POST that the server applies
 * atomically (remote mode), or is merged into localStorage + broadcast to
 * other tabs (local mode, when no API_URL is configured). Unsent clicks
 * survive reloads via localStorage; on page close they go out via sendBeacon.
 *
 * Totals shape (both modes):
 *   { total, characters: {slug: n}, governorates: {slug: n}, matrix: {gov: {char: n}},
 *     visitors: { total, governorates: {slug: n} },     ← one visitor = one IP
 *     stage: [5 slugs], candidates: [slugs], myVote,
 *     round: { id, endsAt, howls: {slug: n}, votes: {slug: n} }, last: {winner, loser, …} }
 */

import { SYNC, hasApi, CHARACTERS, DEFAULT_STAGE } from './config.js';

const VOTE_KEY = 'aw.vote';

/** Next Friday 00:00 Damascus (UTC+3) — same rule as the worker; used in local mode. */
function nextRoundEnd(now) {
  const tz = 3 * 3600_000;
  const local = new Date(now + tz);
  let end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + ((5 - local.getUTCDay() + 7) % 7)) - tz;
  return end <= now ? end + 7 * 864e5 : end;
}

/** Fill in the round fields for local mode / before the server answers. */
function withRound(t) {
  if (!t.stage) {
    t.stage = DEFAULT_STAGE;
    t.candidates = CHARACTERS.map((c) => c.slug).filter((s) => !DEFAULT_STAGE.includes(s));
  }
  t.round ||= { id: 0, endsAt: nextRoundEnd(Date.now()), howls: {}, votes: {} };
  return t;
}

const PENDING_KEY = 'aw.pending';
const LOCAL_KEY = 'aw.localTotals';
const CHANNEL = 'awi-walak';

const empty = () => ({ total: 0, characters: {}, governorates: {}, matrix: {}, visitors: { total: 0, governorates: {} } });

export function createSync({ onTotals, onStatus }) {
  /** "gov|char" → n */
  const pending = new Map();
  let pendingCount = 0;
  let remote = null; // api.js module (remote mode)
  let busy = false;
  let totals = withRound(empty());
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

  // Restore clicks that never made it out last time.
  try {
    for (const [k, n] of JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')) {
      pending.set(k, (pending.get(k) || 0) + n);
      pendingCount += n;
    }
  } catch {}

  function persistPending() {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify([...pending]));
    } catch {}
  }

  /** Hot path: called on every click. Must stay trivial. */
  function add(gov, char) {
    if (pendingCount >= SYNC.maxPending) return;
    const k = gov + '|' + char;
    pending.set(k, (pending.get(k) || 0) + 1);
    pendingCount++;
  }

  /** Take up to `max` clicks out of the pending map. */
  function take(max) {
    const batch = [];
    let n = 0;
    for (const [k, v] of pending) {
      if (n >= max) break;
      const t = Math.min(v, max - n);
      batch.push([k, t]);
      n += t;
      if (t === v) pending.delete(k);
      else pending.set(k, v - t);
    }
    pendingCount -= n;
    return { batch, n };
  }

  function putBack(batch) {
    for (const [k, v] of batch) {
      pending.set(k, (pending.get(k) || 0) + v);
      pendingCount += v;
    }
  }

  async function flush() {
    if (busy || !pendingCount || (hasApi && !remote)) return;
    busy = true;
    const { batch, n } = take(SYNC.maxPerFlush);
    try {
      if (remote) await remote.push(batch);
      else localPush(batch, n);
    } catch (err) {
      putBack(batch);
      if (remote && err?.code !== 'offline') {
        onStatus?.('retry');
        console.warn('[sync] flush rejected, will retry', err?.code || err);
      }
    } finally {
      busy = false;
      persistPending();
    }
  }

  /* ---------- local-only mode ---------- */

  function readLocal() {
    try {
      return { ...empty(), ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') };
    } catch {
      return empty();
    }
  }

  function localPush(batch, n) {
    const t = withRound(readLocal());
    t.total += n;
    for (const [k, v] of batch) {
      const [gov, char] = k.split('|');
      t.characters[char] = (t.characters[char] || 0) + v;
      t.governorates[gov] = (t.governorates[gov] || 0) + v;
      (t.matrix[gov] ||= {})[char] = (t.matrix[gov][char] || 0) + v;
      t.round.howls[char] = (t.round.howls[char] || 0) + v;
    }
    localStorage.setItem(LOCAL_KEY, JSON.stringify(t));
    setTotals(t);
    bc?.postMessage(t);
  }

  function setTotals(t) {
    totals = withRound({ ...empty(), ...t });
    // WebSocket pushes don't carry myVote; keep the last one we know for this round.
    if ('myVote' in t) myVote = { round: totals.round.id, slug: t.myVote };
    if (myVote && myVote.round !== totals.round.id) myVote = null;
    try {
      localStorage.setItem(VOTE_KEY, JSON.stringify(myVote));
    } catch {}
    onTotals?.(totals);
  }

  let myVote = null;
  try {
    myVote = JSON.parse(localStorage.getItem(VOTE_KEY) || 'null');
  } catch {}

  /** Vote (or move the vote). Remote: server decides. Local mode: just remembered here. */
  async function vote(slug) {
    if (remote) {
      const res = await remote.vote(slug);
      if (res.error) throw Object.assign(new Error(res.error), { code: res.error });
      return res.myVote;
    }
    const t = structuredClone(totals);
    if (myVote?.slug) t.round.votes[myVote.slug] = Math.max(0, (t.round.votes[myVote.slug] || 1) - 1);
    t.round.votes[slug] = (t.round.votes[slug] || 0) + 1;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(t));
    } catch {}
    setTotals({ ...t, myVote: slug });
    return slug;
  }

  async function start() {
    setInterval(flush, SYNC.flushMs);
    // Last-chance flush when the tab is hidden/closed; whatever doesn't make
    // it is already in localStorage and goes out on the next visit.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    addEventListener('pagehide', () => {
      if (remote && !busy) {
        // A fetch may not survive the page closing; a beacon does.
        while (pendingCount) remote.beacon(take(SYNC.maxPerFlush).batch);
      }
      persistPending();
    });

    if (!hasApi) {
      onStatus?.('local');
      bc && (bc.onmessage = (e) => setTotals(e.data));
      addEventListener('storage', (e) => e.key === LOCAL_KEY && setTotals(readLocal()));
      setTotals(readLocal());
      return;
    }
    // Remote mode: keep trying until the API answers. Clicks made meanwhile
    // stay queued (and persisted) — they are never counted only locally.
    const api = await import('./api.js');
    for (let wait = 2000; ; wait = Math.min(wait * 2, 30000)) {
      try {
        await api.connect(setTotals, onStatus);
        remote = api;
        onStatus?.('online');
        return;
      } catch (err) {
        onStatus?.('offline');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  return {
    add,
    flush,
    start,
    vote,
    get myVote() {
      return myVote?.slug || null;
    },
    get totals() {
      return totals;
    },
    /** Server totals + not-yet-flushed local clicks, for snappy UI. */
    view() {
      if (!pendingCount) return totals;
      const v = structuredClone(totals);
      for (const [k, n] of pending) {
        const [gov, char] = k.split('|');
        v.total += n;
        v.characters[char] = (v.characters[char] || 0) + n;
        v.governorates[gov] = (v.governorates[gov] || 0) + n;
        (v.matrix[gov] ||= {})[char] = (v.matrix[gov][char] || 0) + n;
        v.round.howls[char] = (v.round.howls[char] || 0) + n;
      }
      return v;
    },
  };
}
