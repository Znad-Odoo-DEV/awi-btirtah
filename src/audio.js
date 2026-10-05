/**
 * audio.js — synthesized dog howls & barks.
 *
 * All sounds are rendered ONCE at load time with OfflineAudioContext (no user
 * gesture needed for that), then kept as AudioBuffers. A click only creates a
 * cheap AudioBufferSourceNode, so rapid clicks overlap with zero decode lag.
 * The live AudioContext is created on the first user gesture (autoplay policy).
 */

import { SFX_FILES } from './config.js';

const SR = 44100;
const MAX_VOICES = 10;

let ctx = null;
let master = null;
let muted = false;
let buffers = []; // [{buf, kind: 'howl'|'bark'}]
let voices = [];
let last = -1;
let lastAt = 0;

/* ---------- synthesis helpers ---------- */

function noise(oc, dur) {
  const b = oc.createBuffer(1, Math.ceil(dur * oc.sampleRate), oc.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = oc.createBufferSource();
  src.buffer = b;
  return src;
}

/** Vocal-ish chain: two formant band-passes in parallel → out. */
function formants(oc, input, out, freqs) {
  for (const [f, q, g] of freqs) {
    const bp = oc.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = q;
    const gain = oc.createGain();
    gain.gain.value = g;
    input.connect(bp).connect(gain).connect(out);
  }
}

/** A howl: rising then falling pitch glide with vibrato ("awoooo"). */
function howl(oc, { at = 0, dur = 1.1, f0 = 380, f1 = 760, f2 = 520, level = 0.9 }) {
  const env = oc.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.09);
  env.gain.setValueAtTime(level, at + dur * 0.55);
  env.gain.exponentialRampToValueAtTime(0.001, at + dur);
  env.connect(oc.destination);

  const mix = oc.createGain();
  mix.gain.value = 0.5;
  formants(oc, mix, env, [
    [f1 * 1.05, 2.5, 1.0],
    [1500, 4, 0.5],
    [2600, 6, 0.18],
  ]);

  const lfo = oc.createOscillator();
  const lfoGain = oc.createGain();
  lfo.frequency.value = 5.5;
  lfoGain.gain.setValueAtTime(0, at);
  lfoGain.gain.linearRampToValueAtTime(14, at + dur * 0.5);
  lfo.connect(lfoGain);

  for (const [type, mult, g] of [
    ['sawtooth', 1, 0.6],
    ['triangle', 2, 0.35],
  ]) {
    const o = oc.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * mult, at);
    o.frequency.exponentialRampToValueAtTime(f1 * mult, at + dur * 0.3);
    o.frequency.exponentialRampToValueAtTime(f2 * mult, at + dur);
    lfoGain.connect(o.frequency);
    const og = oc.createGain();
    og.gain.value = g;
    o.connect(og).connect(mix);
    o.start(at);
    o.stop(at + dur);
  }
  // a little breath
  const n = noise(oc, dur);
  const ng = oc.createGain();
  ng.gain.value = 0.06;
  n.connect(ng).connect(mix);
  n.start(at);
  lfo.start(at);
  lfo.stop(at + dur);
}

/** A bark: fast pitch drop + noise burst through mouth-like formants ("woof"). */
function bark(oc, { at = 0, dur = 0.17, f = 320, level = 1 }) {
  const env = oc.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.006);
  env.gain.exponentialRampToValueAtTime(level * 0.35, at + dur * 0.4);
  env.gain.exponentialRampToValueAtTime(0.001, at + dur);
  env.connect(oc.destination);

  const mix = oc.createGain();
  formants(oc, mix, env, [
    [f * 2.2, 1.6, 1.0],
    [f * 4.5, 3, 0.55],
    [2800, 5, 0.15],
  ]);

  const o = oc.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f * 1.5, at);
  o.frequency.exponentialRampToValueAtTime(f, at + dur * 0.25);
  o.frequency.exponentialRampToValueAtTime(f * 0.6, at + dur);
  const og = oc.createGain();
  og.gain.value = 0.7;
  o.connect(og).connect(mix);
  o.start(at);
  o.stop(at + dur);

  const n = noise(oc, dur);
  const ng = oc.createGain();
  ng.gain.setValueAtTime(0.5, at);
  ng.gain.exponentialRampToValueAtTime(0.01, at + dur * 0.5);
  n.connect(ng).connect(mix);
  n.start(at);
}

async function render(dur, build) {
  const oc = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
  build(oc);
  const buf = await oc.startRendering();
  normalize(buf, 0.85);
  return buf;
}

function normalize(buf, peak) {
  const d = buf.getChannelData(0);
  let max = 0;
  for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
  if (max > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / max;
}

/** Drop the MP3 encoder's leading silence so the bark hits on the click. */
function trimStart(oc, buf) {
  const d = buf.getChannelData(0);
  let i = 0;
  while (i < d.length && Math.abs(d[i]) < 0.01) i++;
  i = Math.max(0, i - 64);
  if (!i) return buf;
  const out = oc.createBuffer(buf.numberOfChannels, buf.length - i, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(i), c);
  return out;
}

/** The synthesized fallback variations. */
const RECIPES = [
  { kind: 'howl', dur: 1.15, build: (oc) => howl(oc, {}) },
  { kind: 'howl', dur: 0.6, build: (oc) => howl(oc, { dur: 0.6, f0: 480, f1: 820, f2: 600 }) },
  { kind: 'bark', dur: 0.2, build: (oc) => bark(oc, {}) },
  { kind: 'bark', dur: 0.26, build: (oc) => bark(oc, { dur: 0.24, f: 210 }) },
  {
    kind: 'bark',
    dur: 0.42,
    build: (oc) => {
      bark(oc, { f: 300, dur: 0.15 });
      bark(oc, { at: 0.2, f: 340, dur: 0.17, level: 0.9 });
    },
  },
  { kind: 'bark', dur: 0.13, build: (oc) => bark(oc, { f: 560, dur: 0.11 }) }, // yip
];

/* ---------- public API ---------- */

/** Pre-render everything. Safe to call before any user gesture. */
export async function preload() {
  if (typeof OfflineAudioContext === 'undefined') return;
  if (SFX_FILES.length) {
    try {
      const tmp = new OfflineAudioContext(1, SR, SR);
      buffers = await Promise.all(
        SFX_FILES.map(async (url) => ({
          kind: 'bark',
          buf: trimStart(tmp, await tmp.decodeAudioData(await (await fetch(url)).arrayBuffer())),
        })),
      );
      return;
    } catch (err) {
      console.warn('[audio] sfx file failed, using synth', err);
    }
  }
  buffers = await Promise.all(RECIPES.map(async (r) => ({ kind: r.kind, buf: await render(r.dur, r.build) })));
}

/** Call from inside a user gesture (pointerdown/keydown). Idempotent. */
export function unlock() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC({ latencyHint: 'interactive' });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.8;
  master.connect(comp).connect(ctx.destination);
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.02);
}

/** Play one random variation with ±10% pitch. Cheap enough for every click. */
export function play() {
  if (!ctx || muted || !buffers.length) return;
  const now = performance.now();
  // Hammering fast → short barks; slower, deliberate clicks → the odd long howl.
  const fast = now - lastAt < 220;
  lastAt = now;
  let i;
  do {
    i = Math.floor(Math.random() * buffers.length);
  } while (buffers.length > 1 && (i === last || (fast && buffers[i].kind === 'howl' && Math.random() < 0.85)));
  last = i;

  const src = ctx.createBufferSource();
  src.buffer = buffers[i].buf;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const g = ctx.createGain();
  g.gain.value = fast ? 0.7 : 1;
  src.connect(g).connect(master);
  src.start();
  src.onended = () => {
    const k = voices.indexOf(src);
    if (k >= 0) voices.splice(k, 1);
  };
  voices.push(src);
  if (voices.length > MAX_VOICES) {
    try {
      voices.shift().stop();
    } catch {}
  }
}
