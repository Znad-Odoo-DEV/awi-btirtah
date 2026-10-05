/**
 * config.js — every knob of the site lives here.
 *
 * API_URL: the Cloudflare Worker in /worker (see README). Leave it empty to run
 * in local-only mode (counts stay in this browser).
 * Characters: drop a photo in /pic, add it to scripts/process-faces.py, re-run
 * it, add an entry below AND to CHARACTERS in worker/src/index.js.
 */

const params = new URLSearchParams(location.search);

const PROD_API = 'https://awi-btirtah-api.znad.workers.dev';

/** `?api=http://127.0.0.1:8787` points the site at a local `wrangler dev`. */
export const API_URL = (params.get('api') || (location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? '' : PROD_API)).replace(/\/$/, '');

/** `?local=1` forces local-only mode. */
export const hasApi = !!API_URL && !API_URL.includes('PASTE_') && !params.has('local');

export const SYNC = {
  flushMs: 3000, // batch window — same idea as popcat
  maxPerFlush: 200, // must match MAX_PER_FLUSH in worker/src/index.js
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
