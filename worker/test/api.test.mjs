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

/* --- weekly rounds: voting + stage swap --- */
const vote = (slug, testIp, raw) =>
  fetch(`${BASE}/vote`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Test-IP': testIp }, body: raw ?? JSON.stringify({ slug }) });
const roll = () => fetch(`${BASE}/dev/roll`, { method: 'POST' }).then((r) => r.json());
const totalsAs = (testIp) => fetch(`${BASE}/totals`, { headers: { 'X-Test-IP': testIp } }).then((r) => r.json());

await roll(); // start from a clean round (whatever earlier runs left behind)
let s = await totals();
ok(s.stage?.length === 5 && s.candidates?.length >= 1 && s.stage.every((c) => !s.candidates.includes(c)), 'stage has 5, candidates are the rest', `stage ${s.stage}, candidates ${s.candidates}`);
const end = new Date(s.round.endsAt + 3 * 3600_000);
ok(end.getUTCDay() === 5 && end.getUTCHours() === 0 && end.getUTCMinutes() === 0, 'round ends Friday 00:00 Damascus time', new Date(s.round.endsAt).toISOString());
ok(s.round.endsAt > Date.now() && s.round.endsAt <= Date.now() + 7 * 864e5, 'round ends within the next 7 days');

const [X, Y] = s.candidates;
const V1 = ip(), V2 = ip(), V3 = ip();
r = await vote(X, V1);
body = await r.json();
ok(r.status === 200 && body.myVote === X && body.totals.round.votes[X] === 1, 'vote for a candidate counts');
ok((await totalsAs(V1)).myVote === X, 'GET /totals tells the visitor their own vote');
await vote(X, V1);
ok((await totals()).round.votes[X] === 1, 'same IP voting again does not add a vote');
await vote(Y, V1);
s = await totals();
ok(!s.round.votes[X] && s.round.votes[Y] === 1, 'same IP can move its vote', JSON.stringify(s.round.votes));
r = await vote(s.stage[0], V2);
ok(r.status === 400, 'cannot vote for a character already on stage', `status ${r.status}`);
r = await vote('nobody', V2);
ok(r.status === 400, 'cannot vote for an unknown slug');
r = await vote(null, V2, '{bad');
ok(r.status === 400, 'bad vote JSON rejected');

// Howl for every stage character except stage[2] → it must be the one that drops.
const stage = [...s.stage];
const loser = stage[2];
for (const c of stage) if (c !== loser) await flush([[`homs|${c}`, 3]], ip());
const loserAllTime = (await totals()).characters[loser] || 0;
await vote(X, V1); // V1 moves back to X
await vote(X, V2);
await vote(Y, V3); // X: 2, Y: 1
const rolled = await roll();
s = rolled.totals;
ok(rolled.last.winner === X && rolled.last.loser === loser, 'most-voted candidate wins, fewest round howls loses', JSON.stringify(rolled.last));
ok(s.stage[2] === X && s.candidates.includes(loser) && s.candidates.includes(Y), 'winner takes the loser\'s place; loser becomes a candidate', `stage ${s.stage}`);
ok(Object.keys(s.round.votes).length === 0 && Object.keys(s.round.howls).length === 0, 'new round starts with zero votes and zero round howls');
ok((s.characters[loser] || 0) === loserAllTime, 'loser keeps its all-time howls', `${loserAllTime}`);

const before2 = [...s.stage];
s = (await roll()).totals;
ok(JSON.stringify(s.stage) === JSON.stringify(before2), 'no votes → nobody is swapped');

// Tie: both candidates get 1 vote; the one that got it first wins.
const [P, Q] = s.candidates;
await vote(P, ip());
await new Promise((r) => setTimeout(r, 20));
await vote(Q, ip());
const tie = await roll();
ok(tie.last.winner === P, 'tie → the candidate that reached the count first wins', JSON.stringify(tie.last));

/* --- CORS --- */
const pre = await fetch(`${BASE}/flush`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
ok(!pre.headers.get('access-control-allow-origin'), 'unknown origin gets no CORS grant');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
