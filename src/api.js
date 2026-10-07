/**
 * api.js — talks to the Cloudflare Worker in /worker (lazy-loaded).
 *
 * Live totals arrive over a WebSocket (server pushes ≤ 1/s when something
 * changes); if the socket can't connect we fall back to polling /totals.
 * Clicks go out as `text/plain` POSTs (no CORS preflight) and, on page close,
 * through navigator.sendBeacon so the last batch isn't lost.
 */

import { API_URL } from './config.js';

let online = false;
let onTotalsCb, onStatusCb;
let ws = null;
let retry = 0;
let pollTimer = 0;

function setOnline(v) {
  if (v === online) return;
  online = v;
  onStatusCb?.(v ? 'online' : 'offline');
}

async function poll() {
  try {
    const r = await fetch(`${API_URL}/totals`, { cache: 'no-store' });
    if (r.ok) {
      onTotalsCb(await r.json());
      setOnline(true);
    }
  } catch {
    setOnline(false);
  }
}

function openSocket() {
  try {
    ws = new WebSocket(API_URL.replace(/^http/, 'ws') + '/ws');
  } catch {
    return startPolling();
  }
  ws.onopen = () => {
    retry = 0;
    stopPolling();
    setOnline(true);
  };
  ws.onmessage = (e) => {
    try {
      onTotalsCb(JSON.parse(e.data));
    } catch {}
  };
  ws.onclose = () => {
    ws = null;
    startPolling();
    // reconnect with backoff: 1s, 2s, 4s … max 30s
    setTimeout(openSocket, Math.min(30000, 1000 * 2 ** retry++));
  };
}

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(poll, 4000);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = 0;
}

export async function connect(onTotals, onStatus) {
  onTotalsCb = onTotals;
  onStatusCb = onStatus;
  await poll(); // first paint of real numbers, also proves the API is reachable
  if (!online) throw new Error('api unreachable');
  openSocket();
  addEventListener('online', poll);
}

/** Send one batch. Throws only on network failure (caller re-queues). */
export async function push(batch) {
  if (!online && !navigator.onLine) throw Object.assign(new Error('offline'), { code: 'offline' });
  let r;
  try {
    r = await fetch(`${API_URL}/flush`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ batch }),
      keepalive: true,
    });
  } catch (err) {
    setOnline(false);
    throw Object.assign(err, { code: 'offline' });
  }
  setOnline(true);
  const res = await r.json().catch(() => ({}));
  if (res.totals) onTotalsCb(res.totals);
  // 400 = rejected batch, 429 = this IP is over its rate limit: either way the
  // clicks are dropped (retrying would only hammer the server).
  return res;
}

/** Fire-and-forget for page close. */
export function beacon(batch) {
  const body = JSON.stringify({ batch });
  if (navigator.sendBeacon?.(`${API_URL}/flush`, new Blob([body], { type: 'text/plain' }))) return true;
  fetch(`${API_URL}/flush`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).catch(() => {});
  return true;
}

/** Cast or move this visitor's vote. Resolves to the server reply ({myVote, totals} or {error}). */
export async function vote(slug) {
  const r = await fetch(`${API_URL}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ slug }),
  });
  const res = await r.json().catch(() => ({ error: 'bad_reply' }));
  if (res.totals) onTotalsCb(res.totals);
  return res;
}
