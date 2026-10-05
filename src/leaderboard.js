/**
 * leaderboard.js — ranked lists with FLIP re-ordering animation (lazy-loaded).
 * update() is throttled by main.js (≈1/s), so the layout reads here never
 * touch the click hot path.
 */

import { reducedMotion } from './fx.js';

const MEDALS = ['🥇', '🥈', '🥉'];

function createList(ol, items, { thumb, highlight }) {
  const rows = new Map();
  let order = items.map((it) => it.slug);

  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.slug = it.slug;
    li.innerHTML = `
      <span class="row__rank"></span>
      ${thumb ? `<img class="row__thumb" width="40" height="40" alt="" loading="lazy" decoding="async">` : ''}
      <span class="row__name"></span>
      <span class="row__val"></span>
      <span class="row__move" aria-hidden="true"></span>
      <span class="row__bar" aria-hidden="true"><i></i></span>`;
    li.querySelector('.row__name').textContent = it.name;
    ol.appendChild(li);
    rows.set(it.slug, {
      li,
      rank: li.querySelector('.row__rank'),
      val: li.querySelector('.row__val'),
      move: li.querySelector('.row__move'),
      bar: li.querySelector('.row__bar i'),
      img: li.querySelector('.row__thumb'),
      name: li.querySelector('.row__name'),
    });
  }

  /** values: slug → n; thumbs: slug → image base path (optional). */
  function update(values, fmt, thumbs, mine) {
    const next = [...order].sort((a, b) => (values[b] || 0) - (values[a] || 0) || order.indexOf(a) - order.indexOf(b));
    const max = Math.max(1, ...next.map((s) => values[s] || 0));
    const changed = next.some((s, i) => s !== order[i]);

    // FLIP: First — remember where every row is.
    const before = changed ? new Map(next.map((s) => [s, rows.get(s).li.getBoundingClientRect().top])) : null;

    next.forEach((slug, i) => {
      const r = rows.get(slug);
      const v = values[slug] || 0;
      const prev = order.indexOf(slug);
      r.rank.textContent = MEDALS[i] || fmt(i + 1);
      r.li.classList.toggle('is-first', i === 0 && v > 0);
      r.li.classList.toggle('is-mine', slug === (mine || highlight));
      r.val.textContent = fmt(v);
      r.bar.style.transform = `scaleX(${v / max})`;
      if (r.img && thumbs?.[slug]) {
        const src = `${thumbs[slug]}-256.webp`;
        if (r.img.getAttribute('src') !== src) r.img.src = src;
        r.img.hidden = false;
      } else if (r.img) r.img.hidden = true;
      if (changed && prev !== i) {
        r.move.textContent = i < prev ? '▲' : '▼';
        r.move.className = 'row__move ' + (i < prev ? 'is-up' : 'is-down');
        r.move.getAnimations().forEach((a) => a.cancel());
        r.move.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 2200, fill: 'forwards' });
      }
    });

    if (!changed) return;
    // Last — re-order the DOM; Invert + Play — slide rows from old to new spot.
    next.forEach((s) => ol.appendChild(rows.get(s).li));
    if (!reducedMotion.matches) {
      for (const s of next) {
        const li = rows.get(s).li;
        const dy = before.get(s) - li.getBoundingClientRect().top;
        if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
    order = next;
  }

  return { update };
}

export function createBoards({ govsEl, characters, governorates }) {
  const govs = createList(govsEl, governorates, { thumb: true });
  const charImg = Object.fromEntries(characters.map((c) => [c.slug, c.img]));

  return {
    /** view = sync.view(); fmt = number formatter; myGov = current pick. */
    update(view, fmt, myGov) {
      // Each governorate shows a tiny face of whoever gets howled at most there.
      const topThumb = {};
      for (const g of governorates) {
        const row = view.matrix?.[g.slug];
        if (!row) continue;
        let best = null;
        for (const c in row) if (!best || row[c] > row[best]) best = c;
        if (best && charImg[best]) topThumb[g.slug] = charImg[best];
      }
      govs.update(view.governorates, fmt, topThumb, myGov);
    },
  };
}
