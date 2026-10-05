/** fx.js — tiny shared animation helpers. */

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function pop(el, scale = 1.08) {
  if (reducedMotion.matches) return;
  el.animate([{ transform: `scale(${scale})` }, { transform: 'scale(1)' }], {
    duration: 160,
    easing: 'cubic-bezier(.3,1.6,.5,1)',
  });
}
