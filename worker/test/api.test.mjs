/**
 * End-to-end tests for the counters API + its protection rules.
 * Run against `npm run dev` (DEV=1 lets X-Test-IP simulate different visitors):
 *   node test/api.test.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
};

const ip = () => `10.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}`;
const flush = (batch, testIp, raw) =>
  fetch(`${BASE}/flush`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...(testIp ? { 'X-Test-IP': testIp } : {}) },
    body: raw ?? JSON.stringify({ batch }),
  });
const totals = () => fetch(`${BASE}/totals`).then((r) => r.json());

const t0 = await totals();
ok(typeof t0.total === 'number' && t0.visitors, 'GET /totals returns the totals shape');

/* --- valid flush increments every counter atomically --- */
const A = ip();
let r = await flush([['aleppo|bashar', 7], ['aleppo|maher', 3]], A);
let body = await r.json();
ok(r.status === 200 && body.accepted === 10, 'valid flush accepted', `status ${r.status}, accepted ${body.accepted}`);
const t1 = await totals();
ok(t1.total - t0.total === 10, 'total +10');
ok((t1.characters.bashar || 0) - (t0.characters.bashar || 0) === 7, 'bashar +7');
ok((t1.governorates.aleppo || 0) - (t0.governorates.aleppo || 0) === 10, 'aleppo +10');
ok((t1.matrix.aleppo?.maher || 0) - (t0.matrix.aleppo?.maher || 0) === 3, 'matrix aleppo/maher +3');
ok(t1.visitors.total - t0.visitors.total === 1, 'new IP counted as 1 visitor');

/* --- same IP again = still one visitor --- */
await flush([['aleppo|bashar', 1]], A);
const t2 = await totals();
ok(t2.visitors.total === t1.visitors.total, 'same IP is not counted twice');

/* --- validation --- */
for (const [name, batch, raw] of [
  ['unknown character rejected', [['aleppo|someone', 1]]],
  ['unknown governorate rejected', [['paris|bashar', 1]]],
  ['zero count rejected', [['homs|bashar', 0]]],
  ['negative count rejected', [['homs|bashar', -50]]],
  ['fractional count rejected', [['homs|bashar', 1.5]]],
  ['> 200 clicks in one flush rejected', [['homs|bashar', 201]]],
  ['split > 200 across entries rejected', [['homs|bashar', 150], ['homs|maher', 60]]],
  ['extra "|" in key rejected', [['homs|bashar|x', 1]]],
  ['invalid JSON rejected', null, '{nope'],
  ['oversized body rejected', null, 'x'.repeat(5000)],
]) {
  const before = (await totals()).total;
  const res = await flush(batch, ip(), raw);
  const after = (await totals()).total;
  ok(res.status === 400 && after === before, name, `status ${res.status}`);
}

/* --- per-IP token bucket: burst 800, refill 80/s --- */
const B = ip();
let accepted = 0;
for (let i = 0; i < 5; i++) {
  const res = await flush([['damascus|samir', 200]], B);
  accepted += (await res.json()).accepted;
}
ok(accepted >= 800 && accepted <= 830, 'one IP capped at ~800 clicks per burst', `accepted ${accepted} of 1000`);
const res429 = await flush([['damascus|samir', 200]], B);
const j429 = await res429.json();
ok(res429.status === 429 || j429.accepted < 50, 'further flood from same IP throttled', `status ${res429.status}, accepted ${j429.accepted}`);
const C = ip();
const other = await flush([['damascus|samir', 5]], C);
ok(other.status === 200, 'a different IP is not affected');
await new Promise((r) => setTimeout(r, 1000));
const refill = await (await flush([['damascus|samir', 200]], B)).json();
ok(refill.accepted >= 60 && refill.accepted <= 140, 'bucket refills ~80/s', `accepted ${refill.accepted} after 1 s`);

/* --- realtime: a WebSocket client sees another visitor's clicks --- */
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
const msgs = [];
ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
await new Promise((r) => setTimeout(r, 300));
const before = msgs.at(-1)?.total;
await flush([['quneitra|nasrallah', 4]], ip());
await new Promise((r) => setTimeout(r, 1800));
const last = msgs.at(-1);
ok(before != null && last && last.total === before + 4 && last.governorates.quneitra >= 4, 'WebSocket pushes new totals to other visitors', `${before} → ${last?.total}`);
ws.close();

/* --- CORS --- */
const pre = await fetch(`${BASE}/flush`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
ok(!pre.headers.get('access-control-allow-origin'), 'unknown origin gets no CORS grant');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
