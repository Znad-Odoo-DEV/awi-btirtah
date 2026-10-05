/**
 * firebase.js — Realtime Database adapter (lazy-loaded only when keys exist).
 *
 * Why RTDB and not Firestore: our counters are a handful of very hot numbers.
 * Firestore caps sustained writes to a single document at ~1/s and bills per
 * write; RTDB has no per-node write cap, applies `increment()` server-side,
 * lets one atomic multi-path `update()` touch every counter at once, and
 * streams changes to all clients cheaply.
 */

import { FIREBASE_SDK, firebaseConfig, useEmulator } from './config.js';

let db, uid, sdk;
let online = false;

export async function connect(onTotals, onStatus) {
  const [app, auth, database] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-database.js`),
  ]);
  sdk = database;
  const fb = app.initializeApp(firebaseConfig);
  const a = auth.getAuth(fb);
  db = database.getDatabase(fb);
  if (useEmulator) {
    auth.connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
    database.connectDatabaseEmulator(db, '127.0.0.1', 9000);
  }
  // Session persistence → one anonymous uid per tab, so two open tabs don't
  // trip each other's per-uid rate limit.
  await auth.setPersistence(a, auth.browserSessionPersistence);
  uid = (await auth.signInAnonymously(a)).user.uid;

  const { ref, onValue } = database;
  onValue(ref(db, 'counters'), (snap) => onTotals(snap.val() || {}));
  onValue(ref(db, '.info/connected'), (snap) => {
    online = !!snap.val();
    onStatus?.(online ? 'online' : 'offline');
  });
}

/** One atomic write: every counter as a server-side increment + rate stamp. */
export async function push(batch, n) {
  if (!online) throw Object.assign(new Error('offline'), { code: 'offline' });
  const { ref, update, increment, serverTimestamp } = sdk;
  const sums = { 'counters/total': n };
  const bump = (path, v) => (sums[path] = (sums[path] || 0) + v);
  for (const [k, v] of batch) {
    const [gov, char] = k.split('|');
    bump(`counters/characters/${char}`, v);
    bump(`counters/governorates/${gov}`, v);
    bump(`counters/matrix/${gov}/${char}`, v);
  }
  const u = {};
  for (const p in sums) u[p] = increment(sums[p]);
  u[`rate/${uid}`] = { t: serverTimestamp(), n };
  await update(ref(db), u);
}
