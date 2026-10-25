// What the web recorder (record.mjs) draws over the page while recording, so
// a GIF shows what the pointer and keyboard do. Headless Chromium draws no
// cursor of its own.
//
// It runs in the page, as an init script on every page the context opens,
// so it is plain JS in a string (overlay.test.mjs runs it in jsdom). A fixed
// layer on the root element with pointer-events off can't change what the
// page does, and every listener is on window's capture phase, so the page
// can't hide an event from it. It adds its layer once, however often it runs.
//   - A black arrow follows the pointer (and stays where it was across a
//     page load, from the tab's session storage), a red ring shows the moment
//     a button goes down, where it went down, and fades slowly once it's let
//     go (or the press is cancelled), and fading dots trail a drag.
//   - A wheel turn shows an arrow by the pointer, pointing the way the page
//     scrolls.
//   - A key press shows its name (timeline.mjs's keyLabel) by what has
//     focus, a frame after the key has done its work (a Tab's focus, the
//     scroll or animation it set off): under it, or over it if that would
//     leave the recorded area (window.__prGifClip, set by recordFrames; the
//     viewport otherwise), and inside that area either way. With nothing
//     focused in shot, it sits at the bottom of the area, in the middle.
//     Characters typed one after another build up into the text typed. The
//     label fades 600 ms after the last key.
//   - Pointer moves are kept on window.__prGifMoves, for recordFrames to
//     tell when the pointer rested out of shot, and while recording, each
//     animation frame notes whether anything in shot moved
//     (window.__prGifTicks), for it to tell a stall from a still page.
// A <dialog> opened with showModal(), or a popover, sits in the browser's
// top layer, above any z-index: over one, the pointer can't be drawn.

import { keyLabel } from './timeline.mjs';

/** The id of the layer the overlay draws on. */
export const LAYER_ID = 'pr-gif-pointer';

export const OVERLAY_SCRIPT = `
(() => {
const keyLabel = ${keyLabel.toString()};
const start = () => {
  if (document.getElementById('${LAYER_ID}')) return;
  window.__prGifMoves = [];
  const layer = document.createElement('div');
  layer.id = '${LAYER_ID}';
  layer.dataset.prGif = 'layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden';
  const arrow = document.createElement('div');
  arrow.dataset.prGif = 'arrow';
  arrow.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15.5 L12.5 22.5 L15.5 21 L12 14 L19 14 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  arrow.style.cssText = 'position:absolute;left:-60px;top:-60px;margin:-3px 0 0 -5px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))';
  const ring = document.createElement('div');
  ring.dataset.prGif = 'ring';
  ring.style.cssText = 'position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;box-sizing:border-box;border-radius:50%;border:3px solid #e11d48;background:rgba(225,29,72,.18);opacity:0;transform:scale(.4)';
  const wheel = document.createElement('div');
  wheel.dataset.prGif = 'wheel';
  wheel.style.cssText = 'position:absolute;width:30px;height:30px;margin:-15px 0 0 22px;border-radius:50%;background:rgba(225,29,72,.9);color:#fff;font:bold 18px/30px system-ui,sans-serif;text-align:center;opacity:0;transition:opacity .25s';
  const key = document.createElement('div');
  key.dataset.prGif = 'key';
  key.style.cssText = 'position:absolute;left:0;top:0;padding:4px 10px;border-radius:8px;background:rgba(17,17,17,.88);color:#fff;font:600 15px/20px system-ui,sans-serif;white-space:pre;box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:0;transition:opacity .2s';
  layer.append(ring, wheel, key, arrow);
  document.documentElement.appendChild(layer);
  const place = (x, y) => {
    arrow.style.left = ring.style.left = wheel.style.left = x + 'px';
    arrow.style.top = ring.style.top = wheel.style.top = y + 'px';
  };
  // Where the pointer was on the page before, if this load came from a
  // click: kept in the tab's session storage, so a new page doesn't lose it.
  try {
    const was = JSON.parse(sessionStorage.getItem('prGif:pointer'));
    if (was) place(was.x, was.y);
  } catch {}
  // While recording (window.__prGifClip is set), each animation frame notes
  // whether anything in the recorded area moved since the one before: an
  // animation or transition running there (paused ones, and ones off the
  // area, don't count), or the pointer, a key or the wheel. recordFrames
  // reads them to tell a stall in Chrome's painting, cut from the GIF, from
  // a page standing still, held (timeline.mjs's timeline).
  let stirred = false;
  window.__prGifTicks = [];
  const inArea = (el, area) => {
    if (!el || !el.getBoundingClientRect) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > area.x && r.left < area.x + area.width && r.bottom > area.y && r.top < area.y + area.height;
  };
  const tick = () => {
    const area = window.__prGifClip;
    if (area) {
      const moving = stirred || (document.getAnimations ? document.getAnimations() : [])
        .some((a) => a.playState === 'running' && inArea(a.effect && a.effect.target, area));
      window.__prGifTicks.push({ t: Date.now(), moving });
      stirred = false;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let down = false;
  const dot = (x, y) => {
    const d = document.createElement('div');
    d.dataset.prGif = 'trail';
    d.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:rgba(225,29,72,.45);transition:opacity .6s';
    layer.insertBefore(d, ring);
    requestAnimationFrame(() => requestAnimationFrame(() => { d.style.opacity = '0'; }));
    setTimeout(() => d.remove(), 700);
  };
  const move = (e) => {
    place(e.clientX, e.clientY);
    try { sessionStorage.setItem('prGif:pointer', JSON.stringify({ x: e.clientX, y: e.clientY })); } catch {}
    window.__prGifMoves.push({ x: e.clientX, y: e.clientY, t: Date.now() });
    stirred = true;
  };
  const capture = { capture: true, passive: true };
  addEventListener('pointermove', (e) => {
    move(e);
    if (down) dot(e.clientX, e.clientY);
  }, capture);
  let fade;
  addEventListener('wheel', (e) => {
    const across = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    wheel.textContent = across ? (e.deltaX < 0 ? '\\u2190' : '\\u2192') : e.deltaY < 0 ? '\\u2191' : '\\u2193';
    wheel.style.opacity = '1';
    stirred = true;
    clearTimeout(fade);
    fade = setTimeout(() => { wheel.style.opacity = '0'; }, 400);
  }, capture);
  // At once on a press, where it was pressed (even with no move before it),
  // so even a short one shows in a frame; slowly away.
  addEventListener('pointerdown', (e) => {
    move(e);
    down = true; ring.style.transition = 'none'; ring.style.opacity = '1'; ring.style.transform = 'scale(1)';
  }, capture);
  const release = () => {
    down = false; ring.style.transition = 'opacity .35s,transform .35s'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.6)';
  };
  addEventListener('pointerup', release, capture);
  addEventListener('pointercancel', release, capture);
  let keyFade;
  let typed = '';
  addEventListener('keydown', (e) => {
    stirred = true;
    const label = keyLabel(e);
    if (!label) return;
    // A character, or a space between characters, adds to what's being typed.
    const char = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key !== ' ' || typed !== '');
    typed = char ? typed + e.key : '';
    const text = char ? typed : label;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      key.textContent = text;
      const area = window.__prGifClip || { x: 0, y: 0, width: innerWidth, height: innerHeight };
      const right = area.x + area.width, bottom = area.y + area.height;
      const focused = document.activeElement;
      // What has focus, if any of it is in shot: one off it (scrolled away,
      // or a stand-in on screen for it) would pin the label to an edge, far
      // from anything the GIF shows.
      const r = focused && focused !== document.body ? focused.getBoundingClientRect() : null;
      const box = r && r.width > 0 && r.right > area.x && r.left < right && r.bottom > area.y && r.top < bottom ? r : null;
      const w = key.offsetWidth, h = key.offsetHeight;
      let x = box ? box.left + box.width / 2 - w / 2 : area.x + area.width / 2 - w / 2;
      let y = box ? box.bottom + 8 : bottom - h - 12;
      if (box && y + h > bottom - 4) y = box.top - h - 8;
      x = Math.max(area.x + 4, Math.min(x, right - w - 4));
      y = Math.max(area.y + 4, Math.min(y, bottom - h - 4));
      key.style.left = x + 'px';
      key.style.top = y + 'px';
      key.style.opacity = '1';
      clearTimeout(keyFade);
      keyFade = setTimeout(() => { key.style.opacity = '0'; typed = ''; }, 600);
    }));
  }, true);
};
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
else start();
})();
`;
