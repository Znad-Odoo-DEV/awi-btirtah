/**
 * main.js — boot, state, input, and the per-click hot path.
 *
 * Hot path (< 16 ms, in practice < 1 ms): howl() only bumps numbers in memory,
 * toggles one class, starts a sound + one WAAPI animation and schedules a
 * single rAF text update. No network, no layout reads, no storage.
 */

import { CHARACTERS, GOVERNORATES, DEFAULT_STAGE } from './config.js';
import * as audio from './audio.js';
import { createFace, mountDebug } from './face.js';
import { createSync } from './sync.js';
import { pop, reducedMotion } from './fx.js';

/* ---------- persisted state ---------- */

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('aw.' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('aw.' + k, JSON.stringify(v));
    } catch {}
  },
};

const charBySlug = (s) => CHARACTERS.find((c) => c.slug === s);
const govBySlug = (s) => GOVERNORATES.find((g) => g.slug === s);

const state = {
  char: charBySlug(store.get('char')) || CHARACTERS[0],
  gov: govBySlug(store.get('gov')) || null,
  count: store.get('count', 0),
  muted: store.get('muted', false),
};
let savedCount = state.count;

/* ---------- DOM ---------- */

const $ = (s) => document.querySelector(s);
const el = {
  face: $('#face'),
  stage: $('#stage'),
  count: $('#count'),
  picker: $('#picker'),
  mute: $('#btn-mute'),
  backdrop: $('#backdrop'),
  board: $('#board'),
  toggles: [$('#board-toggle'), $('#board-chev')],
  topGov: $('#top-gov'),
  topTotal: $('#top-total'),
  myGovBtn: $('#my-gov-btn'),
  myGov: $('#my-gov'),
  myGovTotal: $('#my-gov-total'),
  dot: $('#status-dot'),
  govModal: $('#gov-modal'),
  govGrid: $('#gov-grid'),
  voteModal: $('#vote-modal'),
  voteTimer: $('#vote-timer'),
  voteGrid: $('#vote-grid'),
  voteStage: $('#vote-stage'),
  voteLast: $('#vote-last'),
  voteMsg: $('#vote-msg'),
};

const fmt = new Intl.NumberFormat('en-US').format;
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format;

/* ---------- modules ---------- */

const face = createFace(el.face);
let boards = null;
let dirty = true; // leaderboard needs a refresh
let debug = null;

const sync = createSync({
  onTotals: (t) => {
    dirty = true;
    renderStage(t.stage);
  },
  onStatus: (s) => {
    if (s === 'retry') return;
    el.dot.dataset.status = s;
    el.dot.title = s;
  },
});

/* ---------- character picker (the 5 on stage) + 🗳️ ---------- */

let stageKey = '';

/** Rebuild the circles whenever the server's line-up changes (weekly vote). */
function renderStage(stage = DEFAULT_STAGE) {
  const key = stage.join(',');
  if (key === stageKey) return;
  stageKey = key;
  el.picker.querySelectorAll('.pick:not(.pick--vote)').forEach((b) => b.remove());
  const voteBtn = el.picker.querySelector('.pick--vote');
  for (const slug of stage) {
    const c = charBySlug(slug);
    if (!c) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.dataset.slug = c.slug;
    b.title = c.name;
    const img = new Image(96, 96);
    img.src = `${c.img}-256.webp`;
    img.alt = c.name;
    const badge = document.createElement('span');
    badge.className = 'pick__count';
    badge.textContent = '0';
    b.append(img, badge);
    b.addEventListener('click', () => setChar(c));
    el.picker.insertBefore(b, voteBtn);
  }
  // The character you were on got voted off stage → jump to the first one.
  setChar(stage.includes(state.char.slug) ? state.char : charBySlug(stage[0]));
}

function buildVoteButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pick pick--vote';
  b.setAttribute('aria-label', 'التصويت');
  b.title = 'التصويت';
  b.textContent = '🗳️';
  b.addEventListener('click', openVote);
  el.picker.appendChild(b);
}

function setChar(c) {
  state.char = c;
  store.set('char', c.slug);
  face.setCharacter(c);
  el.backdrop.style.backgroundImage = `url(${c.img}-256.webp)`;
  el.picker.querySelectorAll('.pick:not(.pick--vote)').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.slug === c.slug)));
  debug?.refresh();
  dirty = true;
}

/* ---------- governorate modal ---------- */

function buildGovModal() {
  for (const g of GOVERNORATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gov-btn';
    b.textContent = g.name;
    b.dataset.slug = g.slug;
    b.addEventListener('click', () => {
      setGov(g);
      el.govModal.close();
    });
    el.govGrid.appendChild(b);
  }
  // No governorate yet → the modal can't be dismissed.
  el.govModal.addEventListener('cancel', (e) => !state.gov && e.preventDefault());
  el.govModal.addEventListener('click', (e) => e.target === el.govModal && state.gov && el.govModal.close());
}

function openGovModal() {
  el.govGrid.querySelectorAll('.gov-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.slug === state.gov?.slug)));
  pointers.clear();
  keys.clear();
  face.close();
  el.govModal.showModal();
}

function setGov(g) {
  state.gov = g;
  store.set('gov', g.slug);
  dirty = true;
  tick();
}

/* ---------- the click ---------- */

const pointers = new Set();
const keys = new Set();
let lastKeyAt = 0;
let renderQueued = false;

function howl() {
  if (!state.gov) return openGovModal();
  state.count++;
  sync.add(state.gov.slug, state.char.slug);
  face.open();
  audio.play();
  pop(el.count);
  navigator.vibrate?.(10);
  dirty = true;
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(renderCount);
  }
}

function release() {
  if (!pointers.size && !keys.size) face.close();
}

function renderCount() {
  renderQueued = false;
  el.count.textContent = fmt(state.count);
}

function bindInput() {
  el.stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // no text selection / double-tap zoom while hammering
    audio.unlock();
    pointers.add(e.pointerId); // every finger counts once
    howl();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    release();
  };
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);

  const IGNORE = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'ContextMenu', 'NumLock', 'ScrollLock', 'Unidentified']);
  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return; // holding = no auto-repeat
    if (IGNORE.has(e.key) || /^F\d+$/.test(e.key)) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, .debug')) return;
    // Other buttons keep their normal Enter/Space behaviour.
    if (t !== el.face && t.closest?.('button, a') && (e.key === 'Enter' || e.key === ' ')) return;
    e.preventDefault();
    audio.unlock();
    keys.add(e.code);
    lastKeyAt = performance.now();
    howl();
  });
  addEventListener('keyup', (e) => {
    keys.delete(e.code);
    release();
  });
  addEventListener('blur', () => {
    keys.clear();
    pointers.clear();
    release();
  });
  // Assistive-tech "clicks" (no pointer, no key) still count.
  el.face.addEventListener('click', (e) => {
    if (e.detail === 0 && performance.now() - lastKeyAt > 400 && !pointers.size) {
      audio.unlock();
      howl();
      setTimeout(release, 90);
    }
  });
}

/* ---------- toolbar + board ---------- */

function bindUi() {
  const paintMute = () => {
    el.mute.textContent = state.muted ? '🔇' : '🔊';
    el.mute.setAttribute('aria-pressed', String(state.muted));
  };
  el.mute.addEventListener('click', () => {
    state.muted = !state.muted;
    store.set('muted', state.muted);
    audio.unlock();
    audio.setMuted(state.muted);
    paintMute();
  });
  audio.setMuted(state.muted);
  paintMute();

  const toggleBoard = () => {
    const open = el.board.classList.toggle('is-open');
    el.toggles.forEach((t) => t.setAttribute('aria-expanded', String(open)));
    if (open) {
      dirty = true;
      tick();
    }
  };
  el.toggles.forEach((t) => t.addEventListener('click', toggleBoard));
  el.myGovBtn.addEventListener('click', openGovModal);
}

/* ---------- 🗳️ weekly vote ---------- */

function openVote() {
  el.voteMsg.hidden = true;
  pointers.clear();
  keys.clear();
  face.close();
  renderVote(sync.view());
  el.voteModal.showModal();
}

function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const p = (n) => String(n).padStart(2, '0');
  const hms = `${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  const ltr = `⁦${hms}⁩`; // keep 12:34:56 left-to-right inside the Arabic line
  return d ? `${d} يوم و ${ltr}` : ltr;
}

/** Fill the vote dialog: countdown, candidate cards, and who is at risk on stage. */
function renderVote(v) {
  el.voteTimer.textContent = countdown(v.round.endsAt - Date.now());
  const votes = v.round.votes || {};
  const max = Math.max(1, ...v.candidates.map((s) => votes[s] || 0));
  const mine = sync.myVote;
  const cards = v.candidates.map((slug) => {
    const c = charBySlug(slug);
    const n = votes[slug] || 0;
    return { slug, c, n, w: n / max };
  });
  if (el.voteGrid.dataset.key !== cards.map((x) => x.slug).join()) {
    el.voteGrid.dataset.key = cards.map((x) => x.slug).join();
    el.voteGrid.innerHTML = '';
    for (const { slug, c } of cards) {
      if (!c) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cand';
      b.dataset.slug = slug;
      b.innerHTML = '<img width="96" height="96" alt=""><span class="cand__name"></span><span class="cand__votes"></span><span class="cand__bar"><i></i></span>';
      b.querySelector('img').src = `${c.img}-256.webp`;
      b.querySelector('.cand__name').textContent = c.name;
      b.addEventListener('click', () => castVote(slug));
      el.voteGrid.appendChild(b);
    }
  }
  for (const { slug, n, w } of cards) {
    const b = el.voteGrid.querySelector(`[data-slug="${slug}"]`);
    if (!b) continue;
    b.setAttribute('aria-pressed', String(slug === mine));
    b.querySelector('.cand__votes').textContent = `🗳️ ${fmt(n)}`;
    b.querySelector('.cand__bar i').style.transform = `scaleX(${w})`;
  }

  // On stage: howls this round; the lowest one is the one that would drop.
  const howls = v.round.howls || {};
  const lowest = [...v.stage].sort((a, b) => (howls[a] || 0) - (howls[b] || 0) || (v.characters[a] || 0) - (v.characters[b] || 0))[0];
  el.voteStage.innerHTML = '';
  for (const slug of v.stage) {
    const c = charBySlug(slug);
    if (!c) continue;
    const d = document.createElement('div');
    d.className = 'risk' + (slug === lowest ? ' is-low' : '');
    d.innerHTML = '<img width="56" height="56" alt=""><span></span>';
    d.querySelector('img').src = `${c.img}-256.webp`;
    d.querySelector('img').alt = c.name;
    d.querySelector('span').textContent = (slug === lowest ? '⬇️ ' : '') + compact(howls[slug] || 0);
    el.voteStage.appendChild(d);
  }

  const last = v.last;
  const w = last?.winner && charBySlug(last.winner);
  const l = last?.loser && charBySlug(last.loser);
  el.voteLast.hidden = !(w && l);
  if (w && l) el.voteLast.textContent = `⬆️ ${w.name}   ⬇️ ${l.name}`;
}

async function castVote(slug) {
  el.voteMsg.hidden = true;
  try {
    await sync.vote(slug);
  } catch (err) {
    // 10 devices on this network already voted this round.
    if (err.code === 'ip_limit') {
      el.voteMsg.textContent = '🚫 هالشبكة صوّتت ١٠ مرات بهالجولة';
      el.voteMsg.hidden = false;
    } else console.warn('[vote]', err);
  }
  renderVote(sync.view());
}

/* ---------- live numbers ---------- */

function tick() {
  const v = sync.view();
  const ranked = [...GOVERNORATES].sort((a, b) => (v.governorates[b.slug] || 0) - (v.governorates[a.slug] || 0));
  const top = ranked[0];
  el.topGov.textContent = v.governorates[top.slug] ? top.name : '—';
  el.topTotal.textContent = compact(v.governorates[top.slug] || 0);
  if (state.gov) {
    el.myGov.textContent = state.gov.name;
    el.myGovTotal.textContent = fmt(v.governorates[state.gov.slug] || 0);
  }
  el.picker.querySelectorAll('.pick:not(.pick--vote)').forEach((b) => {
    const t = compact(v.characters[b.dataset.slug] || 0);
    const badge = b.lastElementChild;
    if (badge.textContent !== t) badge.textContent = t;
  });
  if (el.voteModal.open) renderVote(v);
  if (dirty && boards && el.board.classList.contains('is-open')) {
    dirty = false;
    boards.update(v, fmt, state.gov?.slug);
  }
  if (state.count !== savedCount) {
    savedCount = state.count;
    store.set('count', state.count);
  }
}

async function loadBoards() {
  const { createBoards } = await import('./leaderboard.js');
  boards = createBoards({
    govsEl: $('#list-govs'),
    characters: CHARACTERS,
    governorates: GOVERNORATES,
  });
  dirty = true;
  tick();
}

/* ---------- boot ---------- */

function boot() {
  buildVoteButton();
  renderStage(sync.view().stage);
  buildGovModal();
  el.voteModal.addEventListener('click', (e) => (e.target === el.voteModal || e.target.closest('[data-close]')) && el.voteModal.close());
  renderCount();
  bindInput();
  bindUi();
  sync.start();
  setInterval(tick, 1000);
  tick();

  if (new URLSearchParams(location.search).has('debug')) debug = mountDebug(face, () => state.char);
  if (!state.gov) openGovModal();

  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  idle(() => {
    audio.preload();
    loadBoards();
  });
  const rm = () => document.documentElement.classList.toggle('rm', reducedMotion.matches);
  reducedMotion.addEventListener?.('change', rm);
  rm();
  addEventListener('pagehide', () => store.set('count', state.count));
}

boot();
