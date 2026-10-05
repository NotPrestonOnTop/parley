// Boot, sign-in, realtime events, and everything around the chat: rail, sidebar, header, members, friends, voice.
import {
  state, h, clear, $, icon, logo, rpc, http, actions, savePrefs, setUser, userOf, nameOf, colorOf, can, outranks, rolesFor, memberOf,
  findChannel, dmOther, dmName, isUnread, lastMessageId, stamp, shortDate, STATUS_LABEL,
} from './core.js';
import { avatar, tile, modal, menu, popover, toast, oops, attempt, confirmDialog, promptDialog, tabs, chime, hasLayers } from './ui.js';
import * as chat from './chat.js';
import { voice, join as voiceJoin, leave as voiceLeave, onSignal, syncRoster, setMuted, setDeaf, toggleCamera, toggleScreen } from './voice.js';
import { renderMarkdown } from './markdown.js';
import {
  applyPrefs, openUserSettings, openServerSettings, roleMenu, banDialog, addServerDialog, inviteDialog, joinInviteDialog,
  createChannelDialog, channelSettingsDialog, newDmDialog, statusMenu,
} from './settings.js';

const ui = {};
let built = false, lastHome = null, search = null; // search: { q, list }
let addNote = null; // result line under the add-friend form
const collapsed = new Set();
const me = () => state.me.id;

/* ---------------------------------------------------------------- boot + sign-in */

applyPrefs();
const inviteInUrl = /^\/invite\/([\w-]+)/.exec(location.pathname)?.[1];
if (inviteInUrl) sessionStorage.setItem('parley.invite', inviteInUrl);
if (state.token) connect(); else showAuth();

function showAuth(mode = location.pathname.startsWith('/login') ? 'login' : 'register') {
  const root = $('#app');
  const error = h('p.auth-error', { role: 'alert' });
  const username = h('input.input', { autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 32, required: true });
  const display = h('input.input', { autocomplete: 'nickname', maxLength: 32, placeholder: 'Optional' });
  const password = h('input.input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
  const submit = h('button.btn.primary.wide', { type: 'submit' }, mode === 'login' ? 'Log in' : 'Create account');
  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; error.textContent = '';
      try {
        const { token } = await http('/api/' + mode, { username: username.value, password: password.value, displayName: display.value });
        localStorage.setItem('parley.token', token);
        state.token = token;
        history.replaceState({}, '', '/');
        connect();
      } catch (err) { error.textContent = err.message; submit.disabled = false; }
    },
  },
  h('h1', mode === 'login' ? 'Welcome back' : 'Create your account'),
  sessionStorage.getItem('parley.invite') && h('p.callout', icon('userPlus', 16), 'You have an invite waiting. It opens right after you sign in.'),
  h('label.field', h('span.field-label', 'Username'), username, mode === 'register' && h('span.field-hint', 'Letters, numbers, dots and underscores. This is how people find you.')),
  mode === 'register' && h('label.field', h('span.field-label', 'Display name'), display),
  h('label.field', h('span.field-label', 'Password'), password),
  error, submit,
  h('p.auth-switch', mode === 'login' ? 'New here? ' : 'Already have an account? ',
    h('button.link', { type: 'button', onclick: () => showAuth(mode === 'login' ? 'register' : 'login') }, mode === 'login' ? 'Create an account' : 'Log in')));
  clear(root, h('div.auth',
    h('div.auth-art', h('div.auth-brand', logo(44), h('span', 'Parley')),
      h('p.auth-line', 'Pull up a chair.'),
      h('p.auth-sub', 'Servers, channels, direct messages, voice and screen share, on a server you run yourself.'),
      h('div.pennants', { 'aria-hidden': 'true' }, Array.from({ length: 9 }, (_, i) => h('i', { style: { '--i': i } })))),
    h('div.auth-panel', form)));
  username.focus();
}

function signOut(tellServer = true, message) {
  if (tellServer) http('/api/logout').catch(() => {});
  localStorage.removeItem('parley.token');
  state.socket?.disconnect();
  if (message) sessionStorage.setItem('parley.notice', message);
  location.href = '/login';
}

function connect() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  socket.on('connect', async () => {
    try { applyReady(await rpc('ready')); } catch (e) { return oops(e); }
    document.body.classList.remove('offline');
    if (!built) { build(); await route(true); afterFirstLoad(); }
    else { invalidate('all'); chat.reload(); }
  });
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') signOut(false); else document.body.classList.add('offline'); });
  socket.on('disconnect', () => { document.body.classList.add('offline'); voiceLeave({ silent: true }); });
  bind(socket);
}

function afterFirstLoad() {
  const code = sessionStorage.getItem('parley.invite');
  if (code) { sessionStorage.removeItem('parley.invite'); joinInviteDialog(code); }
  const notice = sessionStorage.getItem('parley.notice');
  if (notice) { sessionStorage.removeItem('parley.notice'); toast(notice); }
}

/* ---------------------------------------------------------------- state from the server */

const numMap = (obj) => new Map(Object.entries(obj || {}).map(([k, v]) => [Number(k), v]));
function addServer(s) {
  for (const c of s.channels) state.voice.delete(c.id);
  for (const [id, list] of Object.entries(s.voice || {})) state.voice.set(Number(id), list);
  state.servers.set(s.id, { ...s, voice: undefined, members: new Map(s.members.map((m) => [m.user_id, m])) });
}
function addDm(dm) {
  if (dm.voice?.length) state.voice.set(dm.id, dm.voice); else state.voice.delete(dm.id);
  state.dms.set(dm.id, dm);
}
function applyReady(d) {
  state.me = d.me;
  state.users.clear(); state.names.clear(); state.servers.clear(); state.dms.clear(); state.voice.clear();
  d.users.forEach(setUser);
  d.servers.forEach(addServer);
  d.dms.forEach(addDm);
  state.friends = numMap(d.friends); state.read = numMap(d.read); state.mentions = numMap(d.mentions);
  state.P = d.perms; state.ice = d.ice; state.maxUploadMb = d.maxUploadMb;
}

function bind(socket) {
  const on = (ev, fn) => socket.on(ev, (d) => { if (state.me && built) fn(d); });

  on('user:update', (u) => { setUser(u); invalidate('all'); chat.redraw(); });
  on('user:delete', ({ id }) => {
    const u = state.users.get(id);
    if (u) state.names.delete(u.username.toLowerCase());
    state.users.delete(id); state.friends.delete(id);
    invalidate('all'); chat.redraw();
  });
  on('presence', (p) => {
    const u = state.users.get(p.id);
    if (!u) return;
    u.status = p.status; u.custom_status = p.custom_status;
    if (p.id === me()) Object.assign(state.me, p);
    invalidate('side', 'aside', 'friends', 'user', 'top');
  });
  on('me:status', (d) => { state.me.status_pref = d.status_pref; invalidate('user'); });

  on('server:add', (s) => { addServer(s); invalidate('rail'); });
  on('server:sync', (s) => { if (state.servers.has(s.id)) { addServer(s); invalidate('all'); chat.redraw(); actions.settingsRefresh?.(); } });
  on('server:update', (s) => { const cur = state.servers.get(s.id); if (cur) { Object.assign(cur, s); invalidate('all'); actions.settingsRefresh?.(); } });
  on('server:remove', ({ serverId }) => {
    const s = state.servers.get(serverId);
    if (!s) return;
    if (s.channels.some((c) => c.id === voice.channelId)) voiceLeave({ silent: true });
    for (const c of s.channels) { state.msgs.delete(c.id); state.voice.delete(c.id); }
    state.servers.delete(serverId);
    if (state.view.serverId === serverId) { navigate(null); toast(`You are no longer in ${s.name}`); }
    actions.settingsRefresh?.();
    invalidate('all');
  });
  on('server:roles', ({ serverId, roles }) => { const s = state.servers.get(serverId); if (s) { s.roles = roles; invalidate('all'); chat.redraw(); actions.settingsRefresh?.(); } });

  on('member:add', ({ serverId, member, user }) => { setUser(user); state.servers.get(serverId)?.members.set(member.user_id, member); invalidate('aside'); actions.settingsRefresh?.(); });
  on('member:update', ({ serverId, member }) => {
    if (!member) return;
    state.servers.get(serverId)?.members.set(member.user_id, member);
    invalidate('all'); chat.redraw(); actions.settingsRefresh?.();
  });
  on('member:remove', ({ serverId, userId }) => { state.servers.get(serverId)?.members.delete(userId); invalidate('aside', 'side'); actions.settingsRefresh?.(); });

  on('channel:upsert', (ch) => {
    const s = state.servers.get(ch.server_id);
    if (!s) return;
    const i = s.channels.findIndex((c) => c.id === ch.id);
    if (i >= 0) s.channels[i] = { ...s.channels[i], ...ch }; else s.channels.push(ch);
    invalidate('side', 'top');
    if (ch.id === state.view.channelId) chat.refreshComposer();
  });
  on('channel:delete', ({ serverId, channelId }) => {
    const s = state.servers.get(serverId);
    if (!s) return;
    s.channels = s.channels.filter((c) => c.id !== channelId);
    state.msgs.delete(channelId); state.voice.delete(channelId);
    if (voice.channelId === channelId) voiceLeave({ silent: true });
    if (state.view.channelId === channelId) navigate(serverId);
    invalidate('side', 'rail');
  });

  on('msg:new', ({ message: m, serverId }) => {
    const ch = findChannel(m.channel_id);
    if (!ch) return;
    ch.last_message_id = Math.max(ch.last_message_id || 0, m.id);
    clearTyping(m.channel_id, m.author_id);
    const mine = m.author_id === me();
    const seen = state.view.channelId === m.channel_id && chat.isLive();
    chat.onNew(m);
    if (mine) state.read.set(m.channel_id, m.id);
    else if (!seen && m.type === 'default' && (!serverId || m.everyone || m.mentions.includes(me()))) {
      state.mentions.set(m.channel_id, (state.mentions.get(m.channel_id) || 0) + 1);
      notify(m, ch);
    }
    invalidate('rail', 'side', 'title');
  });
  on('msg:update', (m) => chat.onUpdate(m));
  on('msg:delete', ({ id, channelId }) => chat.onDelete(channelId, [id]));
  on('msg:bulkDelete', ({ channelId, ids }) => chat.onDelete(channelId, ids));
  on('typing', ({ channelId, userId }) => {
    if (userId === me()) return;
    if (!state.typing.has(channelId)) state.typing.set(channelId, new Map());
    const map = state.typing.get(channelId);
    clearTimeout(map.get(userId));
    map.set(userId, setTimeout(() => clearTyping(channelId, userId), 7000));
    if (channelId === state.view.channelId) chat.renderTyping();
  });
  on('ack', ({ channelId, messageId }) => {
    state.read.set(channelId, Math.max(state.read.get(channelId) || 0, messageId));
    state.mentions.delete(channelId);
    invalidate('rail', 'side', 'title');
  });

  on('dm:upsert', (dm) => { addDm(dm); invalidate('side', 'top', 'aside', 'rail'); });
  on('dm:remove', ({ channelId }) => {
    state.dms.delete(channelId); state.msgs.delete(channelId);
    if (voice.channelId === channelId) voiceLeave();
    if (state.view.channelId === channelId) navigate(null);
    invalidate('side', 'rail');
  });
  on('friend:update', ({ userId, status }) => {
    const before = state.friends.get(userId);
    if (status) state.friends.set(userId, status); else state.friends.delete(userId);
    if (status === 'in') { toast(`${userOf(userId).display_name} sent you a friend request`, { actions: [{ label: 'Accept', primary: true, onClick: () => attempt(rpc('friend:accept', { userId })) }] }); chime('message'); }
    else if (status === 'friend' && before === 'out') toast(`${userOf(userId).display_name} accepted your friend request`);
    invalidate('friends', 'side', 'rail', 'title');
  });

  on('voice:update', ({ channelId, users }) => {
    const before = state.voice.get(channelId)?.length || 0;
    if (users.length) state.voice.set(channelId, users); else state.voice.delete(channelId);
    if (channelId === voice.channelId) {
      syncRoster(users);
      if (users.length !== before) chime(users.length > before ? 'join' : 'leave');
    }
    invalidate('side', 'top', 'voice');
  });
  on('voice:signal', onSignal);
  on('voice:kicked', () => { voiceLeave({ silent: true }); toast('Voice disconnected. You may have joined from another tab.'); });
  on('call:ring', ({ channelId, from }) => {
    if (state.me.status_pref === 'dnd') return;
    chime('ring');
    const dm = state.dms.get(channelId);
    toast(dm?.type === 'group' ? `${userOf(from).display_name} started a call in ${dmName(dm)}` : `${userOf(from).display_name} is calling you`, {
      ms: 20000, actions: [{ label: 'Join call', primary: true, onClick: () => { navigate(null, channelId); joinVoice(channelId); } }, { label: 'Dismiss' }],
    });
  });
  on('session:ended', () => signOut(false, 'You were signed out by an admin.'));
}

function clearTyping(channelId, userId) {
  const map = state.typing.get(channelId);
  if (!map?.has(userId)) return;
  clearTimeout(map.get(userId)); map.delete(userId);
  if (channelId === state.view.channelId) chat.renderTyping();
}

function notify(m, ch) {
  if (state.me.status_pref === 'dnd') return;
  chime('message');
  if (!state.prefs.desktop || !('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  const where = ch.server_id ? `#${ch.name}` : ch.type === 'group' ? dmName(ch) : null;
  const n = new Notification(userOf(m.author_id).display_name + (where ? ` in ${where}` : ''), { body: m.content || 'Sent an attachment', tag: 'parley-' + ch.id });
  n.onclick = () => { window.focus(); navigate(ch.server_id || null, ch.id); n.close(); };
}

/* ---------------------------------------------------------------- shell + render scheduling */

function build() {
  built = true;
  ui.rail = h('nav.rail', { 'aria-label': 'Servers' });
  ui.sideMain = h('div.side-main');
  ui.voicePanel = h('div.voice-panel', { hidden: true });
  ui.userPanel = h('div.user-panel');
  ui.top = h('header.top');
  ui.stage = h('div.stage', { hidden: true });
  ui.aside = h('aside.aside');
  ui.body = h('div.body', chat.buildChat(), ui.aside);
  ui.friends = h('section.friends', { hidden: true });
  ui.blank = h('section.blank', { hidden: true });
  $('#app').replaceChildren(h('div.app',
    h('div.offline-bar', 'Connection lost. Reconnecting…'),
    h('div.drawer', ui.rail, h('aside.side', ui.sideMain, ui.voicePanel, ui.userPanel)),
    h('div.scrim', { onclick: () => document.body.classList.remove('drawer-open', 'aside-open') }),
    h('main.main', ui.top, ui.stage, ui.body, ui.friends, ui.blank)));

  Object.assign(actions, { navigate, invalidate, openProfile, memberMenu, signOut });
  voice.onChange = () => invalidate('voice', 'side', 'user', 'top');
  voice.onSpeaking = (uid, on) => { for (const n of document.querySelectorAll(`[data-vu="${uid}"]`)) n.classList.toggle('speaking', on); };

  window.addEventListener('popstate', () => route(true));
  document.addEventListener('click', (e) => {
    // Links to this app (invites, channels, messages) open in place.
    const a = e.target.closest?.('a[data-internal]');
    if (!a) return;
    e.preventDefault();
    const url = new URL(a.href);
    const inv = /^\/invite\/([\w-]+)/.exec(url.pathname);
    if (inv) return joinInviteDialog(inv[1]);
    history.pushState({}, '', url.pathname + url.search);
    route(true);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); return; }
    // Start typing anywhere to write a message.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !hasLayers() && state.view.channelId
      && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) chat.focusComposer();
  });
  watchIdle();
}

let dirty = new Set(), frame = 0;
function invalidate(...parts) {
  for (const p of parts) dirty.add(p);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const d = dirty; dirty = new Set();
    const has = (p) => d.has('all') || d.has(p);
    if (has('rail')) renderRail();
    if (has('side')) renderSide();
    if (has('user') || has('voice')) { renderUserPanel(); renderVoicePanel(); }
    if (has('voice')) renderStage();
    if (has('top')) renderTop();
    if (has('aside')) renderAside();
    if (has('friends')) renderFriends();
    if (has('title') || has('rail')) renderTitle();
    if (d.has('all')) renderLayout();
  });
}

function renderLayout() {
  const v = state.view;
  ui.body.hidden = !v.channelId;
  ui.friends.hidden = !!(v.serverId || v.channelId);
  ui.blank.hidden = !(v.serverId && !v.channelId);
  if (!ui.blank.hidden) {
    const s = state.servers.get(v.serverId);
    clear(ui.blank, h('div.empty-state', icon('hash', 40), h('h2', 'No text channels'),
      h('p', can(v.serverId, 'MANAGE_CHANNELS') ? 'This server has no text channels yet.' : 'This server has no text channels yet. Someone with the right role needs to create one.'),
      s && can(v.serverId, 'MANAGE_CHANNELS') && h('button.btn.primary', { onclick: () => createChannelDialog(v.serverId) }, 'Create channel')));
  }
}

/* ---------------------------------------------------------------- navigation */

const textChannels = (s) => sortedChannels(s).filter((c) => c.type === 'text');
function sortedChannels(s) {
  // Uncategorized first, then each category followed by its channels.
  const byPos = (a, b) => a.position - b.position || a.id - b.id;
  const cats = s.channels.filter((c) => c.type === 'category').sort(byPos);
  const catIds = new Set(cats.map((c) => c.id));
  const loose = s.channels.filter((c) => c.type !== 'category' && !catIds.has(c.parent_id)).sort(byPos);
  return [...loose, ...cats.flatMap((cat) => [cat, ...s.channels.filter((c) => c.parent_id === cat.id && c.type !== 'category').sort(byPos)])];
}

async function navigate(serverId, channelId, { replace = false } = {}) {
  serverId = serverId || null;
  if (serverId) {
    const s = state.servers.get(serverId);
    if (!s) return navigate(null, null, { replace });
    const texts = textChannels(s);
    const ch = texts.find((c) => c.id === channelId) || texts.find((c) => c.id === state.prefs.lastChannel[serverId]) || texts[0];
    channelId = ch?.id ?? null;
    if (channelId) state.prefs.lastChannel[serverId] = channelId;
  } else {
    channelId = state.dms.has(channelId) ? channelId : null;
    lastHome = channelId;
  }
  state.prefs.lastView = { serverId, channelId };
  savePrefs();
  const changed = state.view.channelId !== channelId || state.view.serverId !== serverId;
  state.view.serverId = serverId; state.view.channelId = channelId;
  search = null;
  const path = `/channels/${serverId || '@me'}${channelId ? '/' + channelId : ''}`;
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path);
  document.body.classList.remove('drawer-open', 'aside-open');
  invalidate('all');
  renderLayout();
  if (channelId && (changed || !built)) await chat.showChannel();
  else if (!channelId) await chat.showChannel();
}

async function route(replace) {
  const m = /^\/channels\/(@me|\d+)(?:\/(\d+))?/.exec(location.pathname);
  const jump = Number(new URLSearchParams(location.search).get('m')) || 0;
  if (m) {
    await navigate(m[1] === '@me' ? null : Number(m[1]), m[2] ? Number(m[2]) : null, { replace });
    if (jump && state.view.channelId) chat.jumpTo(state.view.channelId, jump);
    return;
  }
  const last = state.prefs.lastView;
  if (last?.serverId && state.servers.has(last.serverId)) return navigate(last.serverId, last.channelId, { replace: true });
  if (last && !last.serverId && last.channelId) return navigate(null, last.channelId, { replace: true });
  const first = state.servers.values().next().value;
  return navigate(first ? first.id : null, null, { replace: true });
}

/* ---------------------------------------------------------------- server rail */

const pendingIn = () => [...state.friends.values()].filter((s) => s === 'in').length;
const serverMentions = (s) => s.channels.reduce((n, c) => n + (state.mentions.get(c.id) || 0), 0);
const serverUnread = (s) => s.channels.some((c) => c.type === 'text' && isUnread(c));

function railItem({ active, title, unread, badge, content, onclick, oncontextmenu, cls = '' }) {
  return h('div.rail-item', { class: cls + (active ? ' active' : '') + (unread ? ' unread' : '') },
    h('span.rail-flag'),
    h('button.rail-btn', { title, 'aria-label': title, onclick, oncontextmenu }, content),
    badge ? h('span.badge.rail-badge', badge > 99 ? '99+' : badge) : null);
}
function renderRail() {
  const v = state.view;
  const dmsWaiting = [...state.dms.values()].filter((d) => state.mentions.get(d.id)).sort((a, b) => lastMessageId(b) - lastMessageId(a));
  clear(ui.rail, 
    railItem({ cls: 'home', active: !v.serverId, title: 'Direct messages and friends', badge: pendingIn(), content: logo(26), onclick: () => navigate(null, lastHome) }),
    ...dmsWaiting.map((d) => railItem({
      title: dmName(d), badge: state.mentions.get(d.id), onclick: () => navigate(null, d.id),
      content: d.type === 'dm' ? avatar(dmOther(d), 46) : tile(dmName(d), d.icon_url, 46),
    })),
    h('div.rail-sep'),
    ...[...state.servers.values()].map((s) => railItem({
      active: v.serverId === s.id, title: s.name, unread: serverUnread(s), badge: serverMentions(s), content: tile(s.name, s.icon_url, 46),
      onclick: () => navigate(s.id), oncontextmenu: (e) => { e.preventDefault(); serverMenu(s, { x: e.clientX, y: e.clientY }); },
    })),
    railItem({ cls: 'add', title: 'Add a server', content: icon('plus', 22), onclick: () => addServerDialog() }));
}

function markRead(channels) {
  for (const c of channels) {
    const last = lastMessageId(c);
    if (!last || (!isUnread(c) && !state.mentions.get(c.id))) continue;
    state.read.set(c.id, last); state.mentions.delete(c.id);
    rpc('ack', { channelId: c.id, messageId: last }).catch(() => {});
  }
  invalidate('rail', 'side', 'title');
}

function serverMenu(s, pos) {
  const manage = can(s.id, 'MANAGE_CHANNELS');
  menu([
    { label: 'Invite people', icon: 'userPlus', onClick: () => inviteDialog(s.id) },
    { label: 'Server settings', icon: 'settings', onClick: () => openServerSettings(s.id) },
    manage && { label: 'Create channel', icon: 'plus', onClick: () => createChannelDialog(s.id) },
    manage && { label: 'Create category', icon: 'plus', onClick: () => createChannelDialog(s.id, null, 'category') },
    '-',
    { label: 'Change my nickname', icon: 'edit', onClick: () => changeNick(s.id, me()) },
    { label: 'Mark as read', icon: 'check', onClick: () => markRead(s.channels) },
    '-',
    s.owner_id !== me() && { label: 'Leave server', icon: 'logout', danger: true, onClick: async () => {
      if (await confirmDialog({ title: `Leave ${s.name}`, text: 'You will need a new invite to come back.', confirm: 'Leave server', danger: true })) attempt(rpc('server:leave', { serverId: s.id }));
    } },
  ], pos);
}
async function changeNick(serverId, uid) {
  const cur = memberOf(serverId, uid)?.nickname || '';
  const v = await promptDialog({ title: uid === me() ? 'Change my nickname' : `Nickname for ${userOf(uid).display_name}`, label: 'Nickname in this server', value: cur, placeholder: userOf(uid).display_name, maxLength: 32, hint: 'Leave it empty to use the display name.' });
  if (v != null) attempt(rpc('member:nick', { serverId, userId: uid, nickname: v }));
}

/* ---------------------------------------------------------------- channel sidebar */

function renderSide() {
  const v = state.view;
  if (v.serverId) renderServerSide(state.servers.get(v.serverId)); else renderHomeSide();
}

function voiceUsers(chId) {
  return (state.voice.get(chId) || []).map((u) => h('button.vu', {
    class: voice.speaking.has(u.user_id) ? 'speaking' : '', dataset: { vu: u.user_id },
    onclick: (e) => openProfile(u.user_id, e.currentTarget), oncontextmenu: (e) => { e.preventDefault(); memberMenu(u.user_id, state.view.serverId, { x: e.clientX, y: e.clientY }); },
  }, avatar(u.user_id, 24), h('span.vu-name', nameOf(u.user_id)),
  u.screen && h('span.live', 'Live'), u.video && icon('video', 14), u.muted && icon('mic', 14, true), u.deaf && icon('headphones', 14, true)));
}

function renderServerSide(s) {
  if (!s) return clear(ui.sideMain, );
  const v = state.view, manage = can(s.id, 'MANAGE_CHANNELS');
  const chMenu = (e, c) => {
    e.preventDefault(); e.stopPropagation();
    menu([
      c.type === 'text' && { label: 'Mark as read', icon: 'check', onClick: () => markRead([c]) },
      c.type !== 'category' && { label: 'Copy link', icon: 'link', onClick: () => navigator.clipboard?.writeText(`${location.origin}/channels/${s.id}/${c.id}`).then(() => toast('Link copied')) },
      manage && '-',
      manage && { label: c.type === 'category' ? 'Edit category' : 'Edit channel', icon: 'edit', onClick: () => channelSettingsDialog(c) },
      manage && c.type === 'category' && { label: 'Create channel here', icon: 'plus', onClick: () => createChannelDialog(s.id, c.id) },
      manage && { label: 'Move up', icon: 'up', onClick: () => attempt(rpc('channel:move', { channelId: c.id, dir: -1 })) },
      manage && { label: 'Move down', icon: 'down', onClick: () => attempt(rpc('channel:move', { channelId: c.id, dir: 1 })) },
    ], { x: e.clientX, y: e.clientY });
  };
  const rows = [];
  let hidden = false;
  for (const c of sortedChannels(s)) {
    if (c.type === 'category') {
      hidden = collapsed.has(c.id);
      rows.push(h('div.cat', { oncontextmenu: (e) => chMenu(e, c) },
        h('button.cat-name', { 'aria-expanded': String(!hidden), onclick: () => { collapsed.has(c.id) ? collapsed.delete(c.id) : collapsed.add(c.id); renderSide(); } }, icon(hidden ? 'right' : 'down', 12), h('span', c.name)),
        manage && h('button.icon-btn.tiny', { title: 'Create channel', onclick: () => createChannelDialog(s.id, c.id) }, icon('plus', 16))));
      continue;
    }
    if (!c.parent_id) hidden = false;
    const active = v.channelId === c.id, unread = c.type === 'text' && isUnread(c), pings = state.mentions.get(c.id);
    const inVoice = c.type === 'voice' && state.voice.has(c.id);
    if (hidden && !active && !unread && !inVoice) continue;
    if (c.type === 'voice') {
      rows.push(h('button.ch.voice', { class: voice.channelId === c.id ? 'active' : '', title: 'Join voice', onclick: () => joinVoice(c.id), oncontextmenu: (e) => chMenu(e, c) }, icon('volume', 18), h('span.ch-name', c.name)));
      if (inVoice) rows.push(h('div.vu-list', voiceUsers(c.id)));
    } else {
      rows.push(h('a.ch', {
        class: (active ? 'active' : '') + (unread ? ' unread' : ''), href: `/channels/${s.id}/${c.id}`,
        onclick: (e) => { e.preventDefault(); navigate(s.id, c.id); }, oncontextmenu: (e) => chMenu(e, c),
      }, icon('hash', 18), h('span.ch-name', c.name), pings ? h('span.badge', pings) : null,
      manage && h('button.icon-btn.tiny.ch-gear', { title: 'Edit channel', onclick: (e) => { e.preventDefault(); e.stopPropagation(); channelSettingsDialog(c); } }, icon('settings', 14))));
    }
  }
  const head = h('button.side-head', { onclick: (e) => serverMenu(s, { anchor: e.currentTarget, gap: 4 }) }, h('span.side-title', s.name), icon('down', 16));
  clear(ui.sideMain, head, h('div.side-scroll', { oncontextmenu: (e) => { if (e.target === e.currentTarget && manage) { e.preventDefault(); menu([{ label: 'Create channel', icon: 'plus', onClick: () => createChannelDialog(s.id) }, { label: 'Create category', icon: 'plus', onClick: () => createChannelDialog(s.id, null, 'category') }], { x: e.clientX, y: e.clientY }); } } },
    rows, !rows.length && h('p.empty-note', 'No channels yet.')));
}

function renderHomeSide() {
  const v = state.view, waiting = pendingIn();
  const dms = [...state.dms.values()].sort((a, b) => lastMessageId(b) - lastMessageId(a) || b.id - a.id);
  clear(ui.sideMain, 
    h('div.side-head.plain', h('span.side-title', 'Parley')),
    h('div.side-scroll',
      h('a.ch.big', { class: !v.channelId ? 'active' : '', href: '/channels/@me', onclick: (e) => { e.preventDefault(); navigate(null, null); } }, icon('users', 20), h('span.ch-name', 'Friends'), waiting ? h('span.badge', waiting) : null),
      h('div.cat', h('span.cat-name.static', 'Direct messages'), h('button.icon-btn.tiny', { title: 'New message', onclick: () => newDmDialog() }, icon('plus', 16))),
      dms.map((d) => {
        const other = d.type === 'dm' ? userOf(dmOther(d)) : null;
        const pings = state.mentions.get(d.id);
        return h('a.ch.dm', {
          class: (v.channelId === d.id ? 'active' : '') + (isUnread(d) ? ' unread' : ''), href: `/channels/@me/${d.id}`,
          onclick: (e) => { e.preventDefault(); navigate(null, d.id); },
          oncontextmenu: (e) => { if (other) { e.preventDefault(); memberMenu(other.id, null, { x: e.clientX, y: e.clientY }); } },
        },
        other ? avatar(other, 32, { status: true }) : tile(dmName(d), d.icon_url, 32),
        h('span.dm-text', h('span.ch-name', dmName(d)), h('span.dm-sub', other ? other.custom_status || '' : `${d.recipients.length} members`)),
        state.voice.has(d.id) && icon('phone', 14),
        pings ? h('span.badge', pings) : null,
        h('button.icon-btn.tiny.ch-gear', { title: d.type === 'dm' ? 'Close conversation' : 'Leave group', onclick: async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (d.type === 'group' && !await confirmDialog({ title: `Leave ${dmName(d)}`, text: 'You will stop getting messages from this group unless someone adds you back.', confirm: 'Leave group', danger: true })) return;
          attempt(rpc('dm:close', { channelId: d.id }));
        } }, icon('x', 14)));
      }),
      !dms.length && h('p.empty-note', 'No conversations yet. Press + to message someone.')));
}

/* ---------------------------------------------------------------- user + voice panels */

function renderUserPanel() {
  const u = state.me;
  const shown = { ...u, status: u.status_pref === 'invisible' ? 'offline' : u.status };
  clear(ui.userPanel, 
    h('button.me', { title: 'Set status', onclick: (e) => statusMenu(e.currentTarget), dataset: { vu: u.id }, class: voice.speaking.has(u.id) ? 'speaking' : '' },
      avatar(shown, 34, { status: true }), h('span.me-text', h('strong', u.display_name), h('span', u.custom_status || STATUS_LABEL[u.status_pref] || 'Online'))),
    h('button.icon-btn', { class: voice.muted ? 'off' : '', title: voice.muted ? 'Unmute' : 'Mute', 'aria-pressed': String(voice.muted), onclick: () => setMuted(!voice.muted) }, icon('mic', 18, voice.muted)),
    h('button.icon-btn', { class: voice.deaf ? 'off' : '', title: voice.deaf ? 'Undeafen' : 'Deafen', 'aria-pressed': String(voice.deaf), onclick: () => setDeaf(!voice.deaf) }, icon('headphones', 18, voice.deaf)),
    h('button.icon-btn', { title: 'Settings', onclick: () => openUserSettings() }, icon('settings', 18)));
}

function renderVoicePanel() {
  const ch = voice.channelId && findChannel(voice.channelId);
  ui.voicePanel.hidden = !ch;
  if (!ch) return;
  const where = ch.server_id ? `${ch.name} / ${state.servers.get(ch.server_id)?.name}` : dmName(ch);
  const media = (fn) => () => fn().catch((e) => { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') oops(e); else toast('Permission was not granted.'); });
  clear(ui.voicePanel, 
    h('div.vp-info', h('strong', 'Voice connected'), h('span', where), voice.noMic && h('span.warn', 'No microphone. Listening only.')),
    h('div.vp-actions',
      h('button.icon-btn', { class: voice.camera ? 'on' : '', title: voice.camera ? 'Turn camera off' : 'Turn camera on', onclick: media(toggleCamera) }, icon('video', 18, !voice.camera)),
      h('button.icon-btn', { class: voice.screen ? 'on' : '', title: voice.screen ? 'Stop sharing' : 'Share your screen', onclick: media(toggleScreen) }, icon('screen', 18)),
      h('button.icon-btn.hangup', { title: 'Disconnect', onclick: () => voiceLeave() }, icon('phone', 18, true))));
}

async function joinVoice(channelId) {
  if (voice.channelId === channelId) return;
  try { await voiceJoin(channelId); if (voice.noMic) toast('Joined without a microphone. Allow mic access in your browser, then unmute to talk.'); }
  catch (e) { oops(e); }
}

// Camera and screen tiles. Nodes are reused so playing video is never detached and restarted.
function renderStage() {
  const keep = new Set();
  for (const [key, t] of voice.tiles) {
    keep.add(key);
    if (ui.stage.querySelector(`[data-key="${CSS.escape(key)}"]`)) continue;
    const video = h('video', { autoplay: true, playsInline: true, muted: true, class: t.mirror ? 'mirror' : '' });
    video.srcObject = t.stream;
    const box = h('div.stage-tile', { dataset: { key, vu: t.userId } }, video,
      h('span.stage-name', nameOf(t.userId, null) + (t.local ? ' (you)' : '')),
      h('button.icon-btn.stage-full', { title: 'Full screen', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen?.()) }, icon('expand', 16)));
    ui.stage.append(box);
    video.play().catch(() => {});
  }
  for (const n of [...ui.stage.children]) if (!keep.has(n.dataset.key)) n.remove();
  ui.stage.hidden = !voice.tiles.size;
}

/* ---------------------------------------------------------------- header */

function renderTop() {
  const v = state.view, ch = v.channelId && findChannel(v.channelId);
  const burger = h('button.icon-btn.burger', { title: 'Open navigation', onclick: () => document.body.classList.toggle('drawer-open') }, icon('menu'));
  if (!ch) {
    if (v.serverId) return clear(ui.top, burger, h('h1.top-title', state.servers.get(v.serverId)?.name || ''));
    const waiting = pendingIn();
    return clear(ui.top, burger, icon('users', 22), h('h1.top-title', 'Friends'),
      tabs([['online', 'Online'], ['all', 'All'], ['pending', 'Pending', waiting || null], ['add', 'Add friend']], v.tab, (t) => { v.tab = t; addNote = null; invalidate('top', 'friends'); }));
  }
  const call = state.voice.get(ch.id)?.length;
  const searchBox = h('input.input.search', {
    type: 'search', placeholder: ch.server_id ? 'Search this server' : 'Search', value: search?.q || '', 'aria-label': 'Search messages',
    onkeydown: (e) => { if (e.key === 'Enter') runSearch(e.target.value.trim(), ch); if (e.key === 'Escape') { e.target.value = ''; closeSearch(); e.target.blur(); } },
    onsearch: (e) => { if (!e.target.value) closeSearch(); },
  });
  const hasList = ch.server_id || ch.type === 'group' || ch.type === 'dm';
  clear(ui.top, burger,
    ch.server_id ? icon('hash', 22) : ch.type === 'dm' ? avatar(dmOther(ch), 26, { status: true }) : icon('users', 22),
    h('h1.top-title', ch.server_id ? ch.name : dmName(ch)),
    ch.server_id && ch.topic ? h('button.top-topic', { title: 'Show full topic', onclick: () => modal({ title: '#' + ch.name, cls: 'narrow', body: h('div.md', renderMarkdown(ch.topic, { serverId: ch.server_id })) }) }, ch.topic) : h('span.grow'),
    !ch.server_id && (voice.channelId === ch.id
      ? h('button.btn.small.danger', { onclick: () => voiceLeave() }, icon('phone', 16, true), 'Leave call')
      : h('button.btn.small', { class: call ? 'primary' : 'ghost', title: call ? 'Join the call' : 'Start a voice call', onclick: () => joinVoice(ch.id) }, icon('phone', 16), call ? 'Join call' : 'Call')),
    ch.type === 'group' && h('button.icon-btn', { title: 'Add people', onclick: () => newDmDialog(ch) }, icon('userPlus')),
    ch.type === 'group' && h('button.icon-btn', { title: 'Rename group', onclick: async () => { const n = await promptDialog({ title: 'Rename group', label: 'Group name', value: ch.name || '', maxLength: 60 }); if (n != null) attempt(rpc('dm:update', { channelId: ch.id, name: n })); } }, icon('edit')),
    h('button.icon-btn', { title: 'Pinned messages', onclick: (e) => showPins(ch, e.currentTarget) }, icon('pin')),
    hasList && h('button.icon-btn', { class: state.prefs.showMembers ? 'on' : '', title: state.prefs.showMembers ? 'Hide member list' : 'Show member list', onclick: toggleAside }, icon('users')),
    searchBox);
}
function toggleAside() {
  if (matchMedia('(max-width: 900px)').matches) { document.body.classList.toggle('aside-open'); state.prefs.showMembers = true; }
  else state.prefs.showMembers = !state.prefs.showMembers;
  savePrefs(); invalidate('top', 'aside');
}

async function showPins(ch, anchor) {
  let list;
  try { list = await rpc('msg:pins', { channelId: ch.id }); } catch (e) { return oops(e); }
  const pop = popover(h('div.pins',
    h('h3', 'Pinned messages'),
    list.length ? list.map((m) => resultCard(m, () => { pop.close(); chat.jumpTo(ch.id, m.id); }, { showChannel: false }))
      : h('p.empty-note', 'Nothing is pinned here. Right-click a message and choose Pin message.')), { anchor, align: 'end' });
}

function resultCard(m, onOpen, { showChannel = true } = {}) {
  const ch = findChannel(m.channel_id);
  return h('button.result', { onclick: onOpen },
    h('span.result-head', avatar(m.author_id, 20), h('strong', nameOf(m.author_id, ch?.server_id)), h('time', stamp(m.created_at)), showChannel && ch?.server_id ? h('span.muted', '#' + ch.name) : null),
    h('span.md', m.content ? renderMarkdown(m.content.slice(0, 400), { serverId: ch?.server_id }) : h('em.muted', m.attachments.length ? 'Attachment' : '')));
}

async function runSearch(q, ch) {
  if (!q) return closeSearch();
  try {
    const list = await rpc('msg:search', ch.server_id ? { serverId: ch.server_id, q } : { channelId: ch.id, q });
    search = { q, list };
    document.body.classList.add('aside-open');
    invalidate('aside');
  } catch (e) { oops(e); }
}
function closeSearch() { if (search) { search = null; document.body.classList.remove('aside-open'); invalidate('aside'); } }

/* ---------------------------------------------------------------- member list / search results */

function memberRow(uid, serverId, dim) {
  const u = userOf(uid), s = serverId && state.servers.get(serverId);
  return h('button.member', {
    class: dim ? 'dim' : '', onclick: (e) => openProfile(uid, e.currentTarget),
    oncontextmenu: (e) => { e.preventDefault(); memberMenu(uid, serverId, { x: e.clientX, y: e.clientY }); },
  }, avatar(u, 32, { status: true }),
  h('span.member-text',
    h('span.member-name', { style: { color: colorOf(uid, serverId) || null } }, nameOf(uid, serverId), s?.owner_id === uid ? h('span.crown', { title: 'Server owner' }, icon('crown', 14)) : null),
    u.custom_status && !dim ? h('span.member-sub', u.custom_status) : null));
}

function renderAside() {
  const v = state.view, ch = v.channelId && findChannel(v.channelId);
  if (search) {
    ui.aside.hidden = false;
    ui.aside.classList.add('wide');
    return clear(ui.aside, 
      h('div.aside-head', h('strong', `${search.list.length}${search.list.length === 50 ? '+' : ''} result${search.list.length === 1 ? '' : 's'} for “${search.q}”`), h('button.icon-btn', { title: 'Close search', onclick: closeSearch }, icon('x', 16))),
      h('div.aside-scroll', search.list.length ? search.list.map((m) => resultCard(m, () => chat.jumpTo(m.channel_id, m.id)))
        : h('p.empty-note', 'No messages match. Search looks for the exact words in message text.')));
  }
  ui.aside.classList.remove('wide');
  ui.aside.hidden = !ch || !state.prefs.showMembers;
  if (ui.aside.hidden) return;
  const byName = (sid) => (a, b) => nameOf(a, sid).localeCompare(nameOf(b, sid));
  if (ch.server_id) {
    const s = state.servers.get(ch.server_id);
    const hoisted = s.roles.filter((r) => r.hoist);
    const groups = new Map(), online = [], offline = [];
    for (const m of s.members.values()) {
      if (userOf(m.user_id).status === 'offline') { offline.push(m.user_id); continue; }
      const r = hoisted.find((x) => m.roles.includes(x.id));
      if (!r) online.push(m.user_id);
      else { if (!groups.has(r.id)) groups.set(r.id, []); groups.get(r.id).push(m.user_id); }
    }
    const section = (label, ids, dim) => ids.length ? [h('div.aside-label', `${label}, ${ids.length}`), ...ids.sort(byName(s.id)).map((id) => memberRow(id, s.id, dim))] : [];
    return clear(ui.aside, h('div.aside-scroll',
      hoisted.flatMap((r) => section(r.name, groups.get(r.id) || [])), section('Online', online), section('Offline', offline, true)));
  }
  if (ch.type === 'group') {
    return clear(ui.aside, h('div.aside-scroll', h('div.aside-label', `Members, ${ch.recipients.length}`),
      [...ch.recipients].sort(byName(null)).map((id) => memberRow(id, null, userOf(id).status === 'offline'))));
  }
  clear(ui.aside, h('div.aside-scroll.flush', profileCard(dmOther(ch), null, { inline: true })));
}

/* ---------------------------------------------------------------- friends */

function renderFriends() {
  if (state.view.serverId || state.view.channelId) return;
  const tab = state.view.tab;
  const of = (st) => [...state.friends].filter(([, s]) => s === st).map(([id]) => id).sort((a, b) => userOf(a).display_name.localeCompare(userOf(b).display_name));
  const friendRow = (id, sub, buttons) => {
    const u = userOf(id);
    return h('div.friend', { oncontextmenu: (e) => { e.preventDefault(); memberMenu(id, null, { x: e.clientX, y: e.clientY }); } },
      h('button.friend-main', { onclick: (e) => openProfile(id, e.currentTarget) }, avatar(u, 40, { status: true }),
        h('span.friend-text', h('strong', u.display_name, h('span.muted', ' @' + u.username)), h('span.muted', sub ?? (u.custom_status || STATUS_LABEL[u.status])))),
      buttons);
  };
  const act = (title, ic, fn, cls = '') => h('button.icon-btn.round', { title, class: cls, onclick: fn }, icon(ic, 18));
  const msg = (id) => act('Message', 'message', () => openDm(id));
  let content;
  if (tab === 'add') {
    const input = h('input.input', { placeholder: 'Their username', maxLength: 33, autocapitalize: 'none', spellcheck: false });
    const result = h('p.add-result', { role: 'status', class: addNote?.cls || '' }, addNote?.text || '');
    const send = async (e) => {
      e.preventDefault();
      const name = input.value.trim().replace(/^@/, '');
      if (!name) return;
      try { const r = await rpc('friend:add', { username: name }); addNote = { cls: 'ok', text: r.status === 'friend' ? `You and ${name} are now friends.` : `Friend request sent to ${name}.` }; }
      catch (err) { addNote = { cls: 'bad', text: err.message }; }
      renderFriends();
    };
    const others = [...state.users.values()].filter((u) => u.id !== me() && !state.friends.has(u.id)).sort((a, b) => a.display_name.localeCompare(b.display_name)).slice(0, 100);
    content = [
      h('h2', 'Add a friend'), h('p.muted', 'Friends show up here with their status, and you can message or call them in one click.'),
      h('form.add-form', { onsubmit: send }, input, h('button.btn.primary', { type: 'submit' }, 'Send friend request')), result,
      others.length ? [h('div.aside-label', `Other people here, ${others.length}`), ...others.map((u) => friendRow(u.id, null, [msg(u.id), act('Add friend', 'userPlus', () => attempt(rpc('friend:add', { userId: u.id })))]))] : null,
    ];
  } else if (tab === 'pending') {
    const incoming = of('in'), outgoing = of('out');
    content = incoming.length + outgoing.length ? [
      incoming.length ? h('div.aside-label', `Received, ${incoming.length}`) : null,
      ...incoming.map((id) => friendRow(id, 'Wants to be friends', [act('Accept', 'check', () => attempt(rpc('friend:accept', { userId: id })), 'good'), act('Decline', 'x', () => attempt(rpc('friend:remove', { userId: id })), 'bad')])),
      outgoing.length ? h('div.aside-label', `Sent, ${outgoing.length}`) : null,
      ...outgoing.map((id) => friendRow(id, 'Request sent', [act('Cancel request', 'x', () => attempt(rpc('friend:remove', { userId: id })), 'bad')])),
    ] : h('div.empty-state', icon('userPlus', 40), h('h2', 'No pending requests'), h('p', 'Requests you send or receive wait here until someone answers.'));
  } else {
    const ids = of('friend').filter((id) => tab === 'all' || userOf(id).status !== 'offline');
    content = ids.length ? [h('div.aside-label', `${tab === 'all' ? 'All friends' : 'Online'}, ${ids.length}`),
      ...ids.map((id) => friendRow(id, null, [msg(id), act('Call', 'phone', async () => { const ch = await openDm(id); if (ch) joinVoice(ch); }), act('More', 'more', (e) => memberMenu(id, null, { anchor: e.currentTarget, align: 'end' }))]))]
      : h('div.empty-state', icon('users', 40), h('h2', of('friend').length ? 'Nobody is online right now' : 'No friends yet'),
        h('p', of('friend').length ? 'Check the All tab to message someone anyway.' : 'Add someone by username to see them here.'),
        h('button.btn.primary', { onclick: () => { state.view.tab = 'add'; invalidate('top', 'friends'); } }, 'Add a friend'));
  }
  clear(ui.friends, h('div.friends-inner', content));
}

async function openDm(userId) {
  try { const { id } = await rpc('dm:open', { userId }); await navigate(null, id); return id; } catch (e) { oops(e); return null; }
}

/* ---------------------------------------------------------------- profiles + moderation menu */

function profileCard(uid, serverId, { inline = false, onAction = () => {} } = {}) {
  const u = userOf(uid), self = uid === me();
  const s = serverId && state.servers.get(serverId), m = s?.members.get(uid);
  const rel = state.friends.get(uid);
  const shared = [...state.servers.values()].filter((x) => x.members.has(uid));
  const friendBtn = self || u.deleted ? null
    : rel === 'friend' ? h('button.btn.small.ghost', { onclick: () => { onAction(); attempt(rpc('friend:remove', { userId: uid })); } }, 'Remove friend')
    : rel === 'out' ? h('button.btn.small.ghost', { disabled: true }, 'Request sent')
    : rel === 'in' ? h('button.btn.small.primary', { onclick: () => attempt(rpc('friend:accept', { userId: uid })).then(onAction) }, 'Accept request')
    : h('button.btn.small', { onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Request sent'; attempt(rpc('friend:add', { userId: uid })); } }, 'Add friend');
  return h('div.profile', { class: inline ? 'inline' : '' },
    h('div.card-banner', { style: { background: u.banner || u.color } }),
    h('div.card-head', avatar(u, 80, { status: true }),
      h('div.card-tags', s?.owner_id === uid && h('span.tag.gold', icon('crown', 12), 'Owner'), u.site_admin && h('span.tag', icon('shield', 12), 'Instance admin'))),
    h('div.card-body',
      h('strong.card-name', m?.nickname || u.display_name),
      h('span.muted', u.deleted ? 'This account was deleted' : `@${u.username}` + (m?.nickname ? ` · ${u.display_name}` : '')),
      u.custom_status && h('p.card-status', u.custom_status),
      m && m.timeout_until > Date.now() && h('p.callout', icon('clock', 16), `Timed out until ${stamp(m.timeout_until)}`),
      u.bio && [h('span.card-label', 'About me'), h('div.md', renderMarkdown(u.bio, { serverId }))],
      m && rolesFor(serverId, uid).length ? [h('span.card-label', 'Roles'), h('div.chips', rolesFor(serverId, uid).map((r) => h('span.chip', h('span.swatch', { style: { background: r.color || 'var(--text-3)' } }), r.name)))] : null,
      !u.deleted && [h('span.card-label', 'Member since'), h('span', shortDate(u.created_at) + (m ? ` · joined this server ${shortDate(m.joined_at)}` : ''))],
      inline && !self && shared.length ? [h('span.card-label', `Servers in common, ${shared.length}`), h('div.shared', shared.map((x) => h('button.shared-row', { onclick: () => navigate(x.id) }, tile(x.name, x.icon_url, 24), x.name)))] : null,
      !u.deleted && h('div.card-actions',
        self ? h('button.btn.small', { onclick: () => { onAction(); openUserSettings('profile'); } }, 'Edit profile')
          : !inline && h('button.btn.small.primary', { onclick: () => { onAction(); openDm(uid); } }, 'Message'),
        friendBtn,
        !self && h('button.icon-btn', { title: 'More', onclick: (e) => memberMenu(uid, serverId, { anchor: e.currentTarget, align: 'end' }, onAction) }, icon('more')))));
}

function openProfile(uid, anchor) {
  const serverId = state.view.serverId && memberOf(state.view.serverId, uid) ? state.view.serverId : null;
  const pop = popover(profileCard(uid, serverId, { onAction: () => pop.close() }), anchor instanceof Element ? { anchor, side: 'right', cls: 'flush' } : { ...anchor, cls: 'flush' });
  return pop;
}

function memberMenu(uid, serverId, pos, after = () => {}) {
  const u = userOf(uid), self = uid === me();
  const s = serverId && state.servers.get(serverId), m = s?.members.get(uid);
  const mod = m && outranks(serverId, uid);
  const rel = state.friends.get(uid);
  const timedOut = m && m.timeout_until > Date.now();
  const timeout = (minutes) => attempt(rpc('member:timeout', { serverId, userId: uid, minutes }));
  const durations = [['60 seconds', 1], ['5 minutes', 5], ['10 minutes', 10], ['1 hour', 60], ['1 day', 1440], ['1 week', 10080]];
  if (u.deleted) return;
  const run = (fn) => (e) => { after(); fn(e); };
  menu([
    { label: 'View profile', icon: 'users', onClick: () => openProfile(uid, pos.anchor ? { ...pos } : pos) },
    !self && { label: 'Message', icon: 'message', onClick: run(() => openDm(uid)) },
    state.view.channelId && { label: 'Mention', icon: 'at', onClick: run(() => chat.insertAtCaret(`@${u.username} `)) },
    !self && !rel && { label: 'Add friend', icon: 'userPlus', onClick: () => attempt(rpc('friend:add', { userId: uid })) },
    !self && rel === 'in' && { label: 'Accept friend request', icon: 'check', onClick: () => attempt(rpc('friend:accept', { userId: uid })) },
    !self && rel === 'friend' && { label: 'Remove friend', icon: 'x', onClick: () => attempt(rpc('friend:remove', { userId: uid })) },
    !self && rel === 'out' && { label: 'Cancel friend request', icon: 'x', onClick: () => attempt(rpc('friend:remove', { userId: uid })) },
    m && '-',
    m && (self || (mod && can(serverId, 'MANAGE_SERVER'))) && { label: self ? 'Change my nickname' : 'Change nickname', icon: 'edit', onClick: run(() => changeNick(serverId, uid)) },
    m && can(serverId, 'MANAGE_ROLES') && { label: 'Roles…', icon: 'shield', onClick: () => roleMenu(serverId, uid, pos) },
    mod && can(serverId, 'TIMEOUT') && (timedOut
      ? { label: 'Remove timeout', icon: 'clock', onClick: () => timeout(0) }
      : { label: 'Time out…', icon: 'clock', onClick: () => menu([{ heading: `Time out ${nameOf(uid, serverId)} for` }, ...durations.map(([label, mins]) => ({ label, onClick: () => timeout(mins) }))], pos) }),
    mod && can(serverId, 'KICK') && { label: `Kick ${nameOf(uid, serverId)}`, icon: 'logout', danger: true, onClick: run(async () => {
      if (await confirmDialog({ title: `Kick ${nameOf(uid, serverId)}`, text: 'They are removed from the server but can rejoin with an invite.', confirm: 'Kick', danger: true })) attempt(rpc('member:kick', { serverId, userId: uid }));
    }) },
    mod && can(serverId, 'BAN') && { label: `Ban ${nameOf(uid, serverId)}…`, icon: 'ban', danger: true, onClick: run(() => banDialog(serverId, uid)) },
    m && !self && (s.owner_id === me() || state.me.site_admin) && s.owner_id !== uid && '-',
    m && !self && (s.owner_id === me() || state.me.site_admin) && s.owner_id !== uid && { label: 'Transfer ownership…', icon: 'crown', onClick: run(() => openServerSettings(serverId, 'danger')) },
  ], pos);
}

/* ---------------------------------------------------------------- misc */

function renderTitle() {
  const n = [...state.mentions.values()].reduce((a, b) => a + b, 0) + pendingIn();
  const v = state.view, ch = v.channelId && findChannel(v.channelId);
  const where = ch ? (ch.server_id ? `#${ch.name}` : dmName(ch)) : v.serverId ? state.servers.get(v.serverId)?.name : 'Friends';
  document.title = `${n ? `(${n}) ` : ''}${where ? where + ' | ' : ''}Parley`;
}

// Ctrl/Cmd+K: jump to any channel, conversation or person.
function quickSwitcher() {
  if (document.querySelector('.switcher')) return;
  const input = h('input.input', { placeholder: 'Where to?', autofocus: true });
  const list = h('div.table.scroll');
  let items = [], index = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = [];
    for (const d of state.dms.values()) items.push({ label: dmName(d), hint: d.type === 'dm' ? 'Direct message' : 'Group chat', left: d.type === 'dm' ? avatar(dmOther(d), 24) : icon('users', 20), go: () => navigate(null, d.id) });
    for (const s of state.servers.values()) for (const c of textChannels(s)) items.push({ label: c.name, hint: s.name, left: icon('hash', 20), go: () => navigate(s.id, c.id) });
    for (const u of state.users.values()) if (u.id !== me() && ![...state.dms.values()].some((d) => d.type === 'dm' && dmOther(d) === u.id)) items.push({ label: u.display_name, hint: '@' + u.username, left: avatar(u, 24), go: () => openDm(u.id) });
    items = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 12);
    index = Math.min(index, Math.max(0, items.length - 1));
    clear(list, ...(items.length ? items.map((it, i) => h('button.table-row.pickable', { class: i === index ? 'on' : '', onclick: () => { m.close(); it.go(); } }, it.left, h('div.grow', h('strong', it.label)), h('span.muted', it.hint)))
      : [h('p.empty-note', 'Nothing matches.')]));
  };
  input.oninput = () => { index = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % (items.length || 1); draw(); }
    else if (e.key === 'Enter' && items[index]) { m.close(); items[index].go(); }
  };
  const m = modal({ cls: 'narrow switcher', body: [input, list, h('p.muted.small', 'Arrow keys to move, Enter to open, Esc to close.')] });
  draw();
}

// After five quiet minutes others see you as idle.
function watchIdle() {
  let timer, idle = false;
  const wake = () => {
    if (idle) { idle = false; rpc('idle', { idle: false }).catch(() => {}); }
    clearTimeout(timer);
    timer = setTimeout(() => { idle = true; rpc('idle', { idle: true }).catch(() => {}); }, 5 * 60000);
  };
  for (const ev of ['mousemove', 'keydown', 'pointerdown', 'focus']) window.addEventListener(ev, wake, { passive: true });
  wake();
}
