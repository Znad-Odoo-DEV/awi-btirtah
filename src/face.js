/**
 * face.js — the procedural "mouth open" puppet.
 *
 * Layers (bottom → top), all the same 512² cutout:
 *   .head__base  the full face
 *   .mouth       dark cavity (teeth + tongue) sitting right under the lip line
 *   .jaw         a copy of the face clipped to the jaw polygon; it drops down
 *                on press and snaps back with an overshoot on release
 * The whole .head also squashes on press and stretches back on release.
 * Everything animated is transform/opacity only → stays on the compositor.
 */

const MIN_OPEN_MS = 70; // even a super-short tap shows the mouth opening

export function createFace(root) {
  root.innerHTML = `
    <div class="head">
      <picture><source type="image/webp"><img class="head__base" alt="" width="512" height="512" draggable="false"></picture>
      <div class="mouth"><i class="mouth__teeth"></i><i class="mouth__tongue"></i></div>
      <div class="jaw"><picture><source type="image/webp"><img alt="" width="512" height="512" draggable="false"></picture></div>
    </div>`;
  const head = root.querySelector('.head');
  const jaw = root.querySelector('.jaw');
  const mouth = root.querySelector('.mouth');
  const sources = root.querySelectorAll('source');
  const imgs = root.querySelectorAll('img');

  let geo = null;
  let openedAt = 0;
  let closeTimer = 0;

  function setCharacter(ch) {
    sources.forEach((s) => (s.srcset = `${ch.img}-512.webp`));
    imgs.forEach((i) => (i.src = `${ch.img}-512.png`));
    root.setAttribute('aria-label', `عوّي على ${ch.name}`);
    setGeometry(ch.face);
  }

  /** Push geometry into CSS vars + the jaw clip polygon. */
  function setGeometry(g) {
    geo = { ...g };
    const p = (v) => `${(v * 100).toFixed(2)}%`;
    const { jawY, mouthX: mx, mouthW: mw, jawW: jw, chinY, drop } = geo;
    head.style.setProperty('--jaw-y', p(jawY));
    head.style.setProperty('--mouth-x', p(mx - mw / 2));
    head.style.setProperty('--mouth-w', p(mw));
    head.style.setProperty('--drop', p(drop));
    // Jaw piece: starts at the mouth corners, flares out to the jaw angles,
    // then wraps around the chin (and a sliver of neck below it).
    jaw.style.clipPath = `polygon(${[
      [mx - mw / 2, jawY],
      [mx + mw / 2, jawY],
      [mx + jw, jawY + 0.05],
      [mx + jw * 0.92, chinY - 0.06],
      [mx + jw * 0.55, chinY + 0.02],
      [mx, chinY + 0.04],
      [mx - jw * 0.55, chinY + 0.02],
      [mx - jw * 0.92, chinY - 0.06],
      [mx - jw, jawY + 0.05],
    ]
      .map(([x, y]) => `${p(x)} ${p(y)}`)
      .join(',')})`;
  }

  function open() {
    clearTimeout(closeTimer);
    openedAt = performance.now();
    // Re-trigger the "pop" even if already open (multi-touch / fast keys).
    root.classList.remove('is-open');
    void root.offsetWidth; // cheap: only this element's styles are dirty
    root.classList.add('is-open');
  }

  function close() {
    const held = performance.now() - openedAt;
    clearTimeout(closeTimer);
    if (held < MIN_OPEN_MS) closeTimer = setTimeout(close, MIN_OPEN_MS - held);
    else root.classList.remove('is-open');
  }

  return { setCharacter, setGeometry, open, close, get geometry() { return geo; } };
}

/**
 * ?debug=1 — calibration overlay: sliders for every geometry value, a guide
 * line at the jaw, a "hold open" toggle and a copy-ready JSON readout.
 */
export function mountDebug(face, getChar) {
  const panel = document.createElement('div');
  panel.className = 'debug';
  panel.dir = 'ltr';
  const keys = [
    ['jawY', 0.5, 1],
    ['mouthX', 0.3, 0.7],
    ['mouthW', 0.05, 0.4],
    ['jawW', 0.08, 0.4],
    ['chinY', 0.6, 1],
    ['drop', 0, 0.2],
  ];
  panel.innerHTML = `<strong>Face calibration</strong>
    ${keys
      .map(
        ([k, min, max]) =>
          `<label>${k} <input type="range" data-k="${k}" min="${min}" max="${max}" step="0.002"><output></output></label>`,
      )
      .join('')}
    <label><input type="checkbox" id="dbg-hold"> hold open</label>
    <textarea readonly rows="3"></textarea>`;
  document.body.appendChild(panel);
  document.querySelector('.face').classList.add('is-debug');

  const out = panel.querySelector('textarea');
  const sync = () => {
    const g = face.geometry;
    panel.querySelectorAll('input[type=range]').forEach((r) => {
      r.value = g[r.dataset.k];
      r.nextElementSibling.textContent = (+g[r.dataset.k]).toFixed(3);
    });
    out.value = `${getChar().slug}: ${JSON.stringify(
      Object.fromEntries(Object.entries(g).map(([k, v]) => [k, +(+v).toFixed(3)])),
    )}`;
  };
  panel.addEventListener('input', (e) => {
    if (e.target.dataset.k) {
      face.setGeometry({ ...face.geometry, [e.target.dataset.k]: +e.target.value });
      sync();
    }
    if (e.target.id === 'dbg-hold') document.querySelector('.face').classList.toggle('is-held', e.target.checked);
  });
  // stop slider drags from counting as howls
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel.addEventListener('keydown', (e) => e.stopPropagation());
  sync();
  return { refresh: sync };
}
