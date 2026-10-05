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
 *     visitors: { total, governorates: {slug: n} } }   ← one visitor = one IP
 */

import { SYNC, hasApi } from './config.js';

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
  let totals = empty();
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
    const t = readLocal();
    t.total += n;
    for (const [k, v] of batch) {
      const [gov, char] = k.split('|');
      t.characters[char] = (t.characters[char] || 0) + v;
      t.governorates[gov] = (t.governorates[gov] || 0) + v;
      (t.matrix[gov] ||= {})[char] = (t.matrix[gov][char] || 0) + v;
    }
    localStorage.setItem(LOCAL_KEY, JSON.stringify(t));
    setTotals(t);
    bc?.postMessage(t);
  }

  function setTotals(t) {
    totals = t;
    onTotals?.(t);
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
        await api.connect((t) => setTotals({ ...empty(), ...t }), onStatus);
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
      }
      return v;
    },
  };
}
