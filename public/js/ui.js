// Interface primitives: avatars, modals, menus, popovers, toasts, form fields.
import { h, clear, icon, state, userOf, initials, uploadFiles } from './core.js';

/* ---------------------------------------------------------------- layers (Esc closes the top one) */

const layers = [];
function pushLayer(close) { layers.push(close); return () => { const i = layers.indexOf(close); if (i >= 0) layers.splice(i, 1); }; }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && layers.length) { e.preventDefault(); e.stopPropagation(); layers[layers.length - 1](); }
}, true);
export const hasLayers = () => layers.length > 0;

/* ---------------------------------------------------------------- avatars */

export function avatar(userOrId, size = 32, { status = false } = {}) {
  const u = typeof userOrId === 'object' ? userOrId : userOf(userOrId);
  const el = h('span.avatar', { style: { '--size': size + 'px', '--tint': u.color || '#5d7473' } });
  if (u.avatar_url) el.append(h('img', { src: u.avatar_url, alt: '', loading: 'lazy', draggable: false }));
  else el.append(h('span.avatar-initials', initials(u.display_name)));
  if (status) el.append(h('span.status-dot', { class: 's-' + (u.status || 'offline'), title: u.status }));
  return el;
}
// Square icon for servers and group chats.
export function tile(name, url, size = 44) {
  const el = h('span.tile', { style: { '--size': size + 'px' } });
  if (url) el.append(h('img', { src: url, alt: '', draggable: false }));
  else el.append(h('span', initials(name)));
  return el;
}

/* ---------------------------------------------------------------- toasts */

let toastHost;
export function toast(text, { kind = 'info', actions, sticky, ms = 3800 } = {}) {
  toastHost ||= document.body.appendChild(h('div.toasts', { role: 'status' }));
  const close = () => el.remove();
  const el = h('div.toast', { class: kind }, h('span.toast-text', text),
    (actions || []).map((a) => h('button.btn.small', { class: a.primary ? 'primary' : 'ghost', onclick: () => { close(); a.onClick?.(); } }, a.label)));
  toastHost.append(el);
  if (!sticky) setTimeout(close, ms);
  return close;
}
export const oops = (e) => toast(e?.message || String(e), { kind: 'error' });
// Run a server call and surface a failure instead of swallowing it.
export const attempt = (promise) => promise.catch((e) => { oops(e); return undefined; });

/* ---------------------------------------------------------------- modals */

export function modal({ title, body, actions, cls = '', onClose, dismissable = true }) {
  let closed = false;
  const close = () => { if (closed) return; closed = true; pop(); wrap.remove(); onClose?.(); };
  const box = h('div.modal', { class: cls, role: 'dialog', 'aria-modal': 'true' },
    title && h('header.modal-head', h('h2', title), dismissable && h('button.icon-btn', { onclick: close, 'aria-label': 'Close' }, icon('x'))),
    h('div.modal-body', body),
    actions && h('footer.modal-foot', actions));
  const wrap = h('div.overlay', { onmousedown: (e) => { if (e.target === wrap && dismissable) close(); } }, box);
  const pop = pushLayer(() => dismissable && close());
  document.body.append(wrap);
  queueMicrotask(() => (box.querySelector('[autofocus], input:not([type=file]), textarea') || box.querySelector('button.primary, button.danger'))?.focus());
  return { close, el: box };
}

export function confirmDialog({ title, text, confirm = 'Confirm', danger = false, extra }) {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal({
      title, cls: 'narrow', body: [h('p.muted', text), extra], onClose: () => resolve(ok),
      actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn', { class: danger ? 'danger' : 'primary', onclick: () => { ok = true; m.close(); } }, confirm)],
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'Save', hint, maxLength = 100 }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, placeholder, maxLength, autofocus: true });
    const done = () => { result = input.value.trim(); m.close(); };
    const m = modal({
      title, cls: 'narrow', onClose: () => resolve(result),
      body: h('form', { onsubmit: (e) => { e.preventDefault(); done(); } }, field(label, input, hint)),
      actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { onclick: done }, confirm)],
    });
    input.select();
  });
}

/* ---------------------------------------------------------------- floating things */

function place(el, { x, y, anchor, side = 'bottom', align = 'start', gap = 8 }) {
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth, ht = el.offsetHeight, vw = innerWidth, vh = innerHeight;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    if (side === 'right' || side === 'left') {
      x = side === 'right' ? r.right + gap : r.left - w - gap;
      if (x + w > vw - 8) x = r.left - w - gap;
      if (x < 8) x = r.right + gap;
      y = align === 'end' ? r.bottom - ht : r.top;
    } else {
      y = side === 'bottom' ? r.bottom + gap : r.top - ht - gap;
      if (y + ht > vh - 8) y = r.top - ht - gap;
      if (y < 8) y = r.bottom + gap;
      x = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    }
  }
  el.style.left = Math.max(8, Math.min(x, vw - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, vh - ht - 8)) + 'px';
}

// A panel anchored to something; closes on outside click or Esc.
export function popover(content, opts) {
  let closed = false;
  const el = h('div.popover', { class: opts.cls || '' }, content);
  const outside = (e) => { if (!el.contains(e.target) && !e.target.closest?.('.menu, .popover')) close(); };
  const close = () => {
    if (closed) return; closed = true;
    el.remove(); pop(); document.removeEventListener('mousedown', outside, true); opts.onClose?.();
  };
  const pop = pushLayer(close);
  document.body.append(el);
  place(el, opts);
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  return { close, el, reposition: () => place(el, opts) };
}

// items: { label, icon, danger, checked, disabled, hint, onClick } | '-' | { heading }
export function menu(items, opts) {
  let closed = false;
  const el = h('div.menu', { role: 'menu' });
  const close = () => { if (closed) return; closed = true; el.remove(); pop(); document.removeEventListener('mousedown', outside, true); opts.onClose?.(); };
  const outside = (e) => { if (!el.contains(e.target)) close(); };
  let lastSep = true;
  for (const it of items.filter(Boolean)) {
    if (it === '-') { if (!lastSep) el.append(h('div.menu-sep')); lastSep = true; continue; }
    lastSep = false;
    if (it.heading) { el.append(h('div.menu-heading', it.heading)); continue; }
    el.append(h('button.menu-item', {
      class: it.danger ? 'danger' : '', disabled: it.disabled, role: 'menuitem',
      onclick: (e) => { if (!it.keepOpen) close(); it.onClick?.(e); },
    }, it.swatch !== undefined && h('span.swatch', { style: { background: it.swatch || 'var(--text-3)' } }),
    h('span.menu-label', it.label), it.hint && h('span.menu-hint', it.hint),
    it.checked ? icon('check', 16) : it.icon && icon(it.icon, 16)));
  }
  if (el.lastChild?.classList.contains('menu-sep')) el.lastChild.remove();
  const pop = pushLayer(close);
  document.body.append(el);
  place(el, opts);
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  return { close, el };
}

/* ---------------------------------------------------------------- form bits */

export const field = (label, control, hint) => h('label.field', h('span.field-label', label), control, hint && h('span.field-hint', hint));

export function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label.toggle', input, h('span.toggle-track'), label && h('span.toggle-label', label));
}

export function tabs(list, current, onPick) {
  return h('div.tabs', { role: 'tablist' }, list.map(([id, label, badge]) =>
    h('button.tab', { class: id === current ? 'active' : '', role: 'tab', onclick: () => onPick(id) }, label, badge ? h('span.badge', badge) : null)));
}

// Pick an image, upload it, hand back its URL.
export function pickImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.onchange = async () => {
      if (!input.files[0]) return resolve(null);
      try { resolve((await uploadFiles([input.files[0]]))[0].url); } catch (e) { oops(e); resolve(null); }
    };
    input.click();
  });
}

export const COLOR_CHOICES = ['#f5c84b', '#f29e4c', '#ef6b5a', '#e56b9f', '#b388eb', '#5aa9e6', '#58c4dd', '#4fc3a1', '#7bd389', '#d4a373', '#9fb3b1'];
export function colorPicker(value, onChange, { allowNone = false } = {}) {
  const wrap = h('div.colors');
  const draw = () => {
    clear(wrap, 
      allowNone && h('button.color.none', { type: 'button', class: !value ? 'on' : '', title: 'No color', onclick: () => set('') }, icon('slash', 14)),
      ...COLOR_CHOICES.map((c) => h('button.color', { type: 'button', class: c === value ? 'on' : '', style: { background: c }, title: c, onclick: () => set(c) })),
      h('label.color.custom', { title: 'Custom color' }, h('input', { type: 'color', value: value || '#f5c84b', oninput: (e) => set(e.target.value) })));
  };
  const set = (c) => { value = c; onChange(c); draw(); };
  draw();
  return wrap;
}

export async function copyText(text, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = h('textarea', { value: text }); document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  toast(done);
}

/* ---------------------------------------------------------------- sound */

let audioCtx;
export function chime(kind = 'message') {
  if (!state.prefs.sounds) return;
  try {
    audioCtx ||= new AudioContext();
    const notes = { message: [660, 880], join: [440, 660], leave: [660, 440], ring: [587, 784, 587, 784] }[kind];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.11;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.25);
    });
  } catch { /* audio is optional */ }
}
