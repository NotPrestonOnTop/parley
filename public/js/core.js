// Shared state, server calls, lookups and the tiny DOM helper everything else builds on.

const PREF_KEY = 'parley.prefs';
const defaultPrefs = { theme: 'harbor', density: 'cozy', sounds: true, desktop: false, showMembers: true, micId: '', lastChannel: {}, recentEmoji: [] };

export const state = {
  token: localStorage.getItem('parley.token'),
  socket: null,
  me: null,
  users: new Map(), names: new Map(),
  servers: new Map(), dms: new Map(), friends: new Map(),
  read: new Map(), mentions: new Map(), voice: new Map(),
  msgs: new Map(), typing: new Map(), drafts: new Map(),
  view: { serverId: null, channelId: null, tab: 'online' },
  P: {}, ice: [], maxUploadMb: 25,
  prefs: { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') },
};
export const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));

/* ---------------------------------------------------------------- dom */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === true) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}
// h('button.btn.primary', { onclick }, 'Save')
export function h(sel, props, ...kids) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { kids.unshift(props); props = null; }
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) if (val != null) el.style.setProperty(p, val); }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && !['list', 'form'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
export const clear = (el, ...kids) => { el.replaceChildren(); append(el, kids); return el; };

const ICONS = {
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  volume: 'M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  plus: 'M12 5v14M5 12h14',
  down: 'm6 9 6 6 6-6',
  right: 'm9 18 6-6-6-6',
  up: 'm18 15-6-6-6 6',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  headphones: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  video: 'M23 7l-7 5 7 5V7zM3 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  screen: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 21h8M12 17v4',
  pin: 'M12 17v5M5 17h14l-1.7-3.4a2 2 0 0 1-.3-1V6h1V3H6v3h1v6.6a2 2 0 0 1-.3 1L5 17z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  userPlus: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6',
  smile: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  attach: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v8M8 12h8',
  reply: 'M9 14 4 9l5-5M20 20v-7a4 4 0 0 0-4-4H4',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-1.5 10h-15L3 8z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  copy: 'M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M3 12h18M3 6h18M3 18h18',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  at: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  slash: 'M3 3l18 18',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
};
const NS = 'http://www.w3.org/2000/svg';
// Stroke icons. `off` draws a strike-through for muted and disabled states.
export function icon(name, size = 20, off = false) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('class', 'icon' + (name === 'more' ? ' heavy' : ''));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] + (off ? ICONS.slash : ''));
  svg.append(p);
  return svg;
}
// The Parley mark: a swallowtail pennant on a mast.
export function logo(size = 28) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('class', 'logo');
  svg.innerHTML = '<path class="logo-mast" d="M8 4v24" /><path class="logo-flag" d="M8 6h19l-6 6.5 6 6.5H8z" />';
  return svg;
}

/* ---------------------------------------------------------------- server calls */

export function rpc(name, data) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('You are offline. Reconnecting…'));
    state.socket.timeout(15000).emit('rpc', name, data, (err, res) => {
      if (err) reject(new Error('The server took too long to answer'));
      else if (res?.error) reject(new Error(res.error));
      else resolve(res?.data);
    });
  });
}

export async function http(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: state.token || '' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: state.token }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

/* ---------------------------------------------------------------- lookups */

export function setUser(u) {
  const old = state.users.get(u.id);
  if (old) state.names.delete(old.username.toLowerCase());
  state.users.set(u.id, u);
  state.names.set(u.username.toLowerCase(), u.id);
  if (state.me && u.id === state.me.id) Object.assign(state.me, u);
}
export const userOf = (id) => state.users.get(id) || { id, username: 'deleted', display_name: 'Deleted user', color: '#5d7473', status: 'offline', deleted: true, bio: '' };
export const userByName = (name) => state.users.get(state.names.get(String(name).toLowerCase()));
export const memberOf = (serverId, uid) => state.servers.get(serverId)?.members.get(uid);
export const nameOf = (uid, serverId = state.view.serverId) => memberOf(serverId, uid)?.nickname || userOf(uid).display_name;

export function rolesFor(serverId, uid) {
  const s = state.servers.get(serverId), m = s?.members.get(uid);
  if (!m) return [];
  return s.roles.filter((r) => m.roles.includes(r.id)); // roles are kept sorted, highest first
}
export const colorOf = (uid, serverId = state.view.serverId) => rolesFor(serverId, uid).find((r) => r.color)?.color || '';
export function permsOf(serverId, uid = state.me.id) {
  const s = state.servers.get(serverId);
  if (!s) return 0;
  if (s.owner_id === uid || userOf(uid).site_admin) return 255;
  const p = rolesFor(serverId, uid).reduce((a, r) => a | r.perms, 0);
  return p & 1 ? 255 : p;
}
export const can = (serverId, perm) => !!(permsOf(serverId) & state.P[perm]);
export function rankOf(serverId, uid = state.me.id) {
  const s = state.servers.get(serverId);
  if (!s) return 0;
  if (s.owner_id === uid) return 1e9;
  if (uid === state.me.id && state.me.site_admin) return 1e8;
  return Math.max(0, ...rolesFor(serverId, uid).map((r) => r.position));
}
export const outranks = (serverId, uid) => uid !== state.me.id && state.servers.get(serverId)?.owner_id !== uid && rankOf(serverId) > rankOf(serverId, uid);

export function findChannel(id) {
  if (state.dms.has(id)) return state.dms.get(id);
  for (const s of state.servers.values()) { const c = s.channels.find((x) => x.id === id); if (c) return c; }
  return null;
}
export const dmOther = (dm) => dm.recipients.find((id) => id !== state.me.id) ?? state.me.id;
export function dmName(dm) {
  if (dm.type === 'dm') return userOf(dmOther(dm)).display_name;
  return dm.name || dm.recipients.filter((id) => id !== state.me.id).map((id) => userOf(id).display_name).join(', ') || 'Empty group';
}
export const lastMessageId = (ch) => ch?.last_message_id || 0;
export const isUnread = (ch) => lastMessageId(ch) > (state.read.get(ch.id) || 0);

/* ---------------------------------------------------------------- formatting */

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const sameDay = (a, b) => startOfDay(a) === startOfDay(b);
export const timeOnly = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export function stamp(t) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  if (days === 0) return 'Today at ' + timeOnly(t);
  if (days === 1) return 'Yesterday at ' + timeOnly(t);
  return new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + timeOnly(t);
}
export const longDate = (t) => new Date(t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
export const shortDate = (t) => new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
export function fileSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
export const initials = (name) => (String(name).trim().match(/\p{L}|\p{N}/gu) ? String(name).trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() : '?');
export const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline' };

// Cross-module hooks (navigate, openProfile, invalidate…) are registered here by app.js.
export const actions = {};
