/**
 * config.js — every knob of the site lives here.
 *
 * 1) Paste your Firebase web-app keys into FIREBASE (see README → "Firebase setup").
 *    While they still start with "PASTE_", the site runs in local-only mode.
 * 2) Characters: add a new one by dropping a photo in /pic, adding it to
 *    scripts/process-faces.py, re-running it, and adding an entry below
 *    (and to the slug whitelist in database.rules.json).
 */

export const FIREBASE = {
  apiKey: 'PASTE_API_KEY',
  authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://PASTE_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId: 'PASTE_PROJECT_ID',
  appId: 'PASTE_APP_ID',
};

/** Firebase JS SDK, loaded lazily from the official CDN (no bundler needed). */
export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

const params = new URLSearchParams(location.search);

/** `?emulator=1` → talk to the Firebase Emulator Suite on localhost instead. */
export const useEmulator = params.has('emulator');

/** True once real keys are pasted in. `?local=1` forces local mode for testing. */
export const hasFirebase = useEmulator || (!FIREBASE.apiKey.startsWith('PASTE_') && !params.has('local'));

export const firebaseConfig = useEmulator
  ? { apiKey: 'demo-key', projectId: 'demo-awi', databaseURL: 'http://127.0.0.1:9000?ns=demo-awi' }
  : FIREBASE;

export const SYNC = {
  flushMs: 3000, // batch window — same idea as popcat
  maxPerFlush: 200, // must match the cap in database.rules.json
  maxPending: 2000, // anything beyond this is dropped (nobody howls that fast)
};

/**
 * Face geometry, all as fractions (0..1) of the square 512px cutout.
 *   jawY   – the lip line where the head splits (tune with ?debug=1)
 *   mouthX – horizontal centre of the mouth
 *   mouthW – width of the dark mouth cavity
 *   jawW   – half-width of the moving jaw piece at its widest
 *   chinY  – bottom of the chin
 *   drop   – how far the jaw drops when open
 */
export const CHARACTERS = [
  {
    slug: 'bashar',
    name: 'بشار الأسد',
    img: 'assets/faces/bashar',
    face: { jawY: 0.768, mouthX: 0.505, mouthW: 0.15, jawW: 0.19, chinY: 0.915, drop: 0.1 },
  },
  {
    slug: 'maher',
    name: 'ماهر الأسد',
    img: 'assets/faces/maher',
    face: { jawY: 0.778, mouthX: 0.5, mouthW: 0.15, jawW: 0.2, chinY: 0.92, drop: 0.1 },
  },
  {
    slug: 'nasrallah',
    name: 'حسن نصر الله',
    img: 'assets/faces/nasrallah',
    face: { jawY: 0.735, mouthX: 0.5, mouthW: 0.13, jawW: 0.19, chinY: 0.95, drop: 0.09 },
  },
  {
    slug: 'ghazwan',
    name: 'غزوان محمد',
    img: 'assets/faces/ghazwan',
    face: { jawY: 0.77, mouthX: 0.51, mouthW: 0.14, jawW: 0.2, chinY: 0.955, drop: 0.09 },
  },
  {
    slug: 'samir',
    name: 'سمير متيني',
    img: 'assets/faces/samir',
    face: { jawY: 0.84, mouthX: 0.46, mouthW: 0.17, jawW: 0.2, chinY: 0.965, drop: 0.08 },
  },
];

/** The 14 governorates. Slugs are whitelisted in database.rules.json. */
export const GOVERNORATES = [
  { slug: 'damascus', name: 'دمشق' },
  { slug: 'rif-dimashq', name: 'ريف دمشق' },
  { slug: 'aleppo', name: 'حلب' },
  { slug: 'homs', name: 'حمص' },
  { slug: 'hama', name: 'حماة' },
  { slug: 'latakia', name: 'اللاذقية' },
  { slug: 'tartus', name: 'طرطوس' },
  { slug: 'idlib', name: 'إدلب' },
  { slug: 'deir-ez-zor', name: 'دير الزور' },
  { slug: 'raqqa', name: 'الرقة' },
  { slug: 'hasakah', name: 'الحسكة' },
  { slug: 'daraa', name: 'درعا' },
  { slug: 'sweida', name: 'السويداء' },
  { slug: 'quneitra', name: 'القنيطرة' },
];

/** Click sound(s). One real bark, cut by scripts/extract-bark.py. Leave empty
 *  to fall back to the synthesized howls/barks in audio.js. */
export const SFX_FILES = ['assets/sfx/bark.mp3'];
