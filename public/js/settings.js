// Dialogs and settings: your account, a server's admin tools, and the instance admin panel.
import {
  state, h, clear, icon, rpc, actions, savePrefs, userOf, nameOf, colorOf, can, rankOf, outranks, rolesFor, memberOf,
  dmName, shortDate, stamp, fileSize, STATUS_LABEL,
} from './core.js';
import { avatar, tile, modal, menu, toast, oops, attempt, confirmDialog, promptDialog, field, toggle, tabs, pickImage, colorPicker, copyText } from './ui.js';

export function applyPrefs() {
  document.documentElement.dataset.theme = state.prefs.theme;
  document.documentElement.dataset.density = state.prefs.density;
}

/* ---------------------------------------------------------------- settings frame */

function settingsFrame(title, sections, initial) {
  let current = initial && sections.some((s) => s.id === initial) ? initial : sections[0].id;
  const nav = h('nav.set-nav'), pane = h('div.set-pane');
  const draw = () => {
    const s = sections.find((x) => x.id === current);
    clear(nav, h('div.set-title', title), ...sections.map((x) => x.sep ? h('div.menu-sep') :
      h('button.set-link', { class: (x.id === current ? 'active' : '') + (x.danger ? ' danger' : ''), onclick: () => (x.action ? x.action() : (current = x.id, draw())) }, x.label)));
    clear(pane, h('h2', s.label), ...[].concat(s.render(draw)).filter(Boolean));
    pane.scrollTop = 0;
  };
  const m = modal({
    cls: 'settings', body: h('div.set', nav, pane, h('button.icon-btn.set-close', { onclick: () => m.close(), title: 'Close (Esc)' }, icon('x'))),
    onClose: () => { actions.settingsRefresh = null; },
  });
  // Outside changes (someone else edits a role) redraw the pane, unless you are mid-typing.
  actions.settingsRefresh = () => { if (!pane.contains(document.activeElement) || !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) draw(); };
  draw();
  return { close: m.close, redraw: draw };
}
const row = (...kids) => h('div.set-row', kids);
const note = (text) => h('p.muted', text);
const empty = (text) => h('p.empty-note', text);

/* ---------------------------------------------------------------- your settings */

export function openUserSettings(initial) {
  const sections = [
    { id: 'profile', label: 'Profile', render: profilePane },
    { id: 'account', label: 'Account', render: accountPane },
    { id: 'appearance', label: 'Appearance', render: appearancePane },
    { id: 'notifications', label: 'Notifications', render: notificationsPane },
    { id: 'voice', label: 'Voice', render: voicePane },
    state.me.site_admin && { sep: true },
    state.me.site_admin && { id: 'admin', label: 'Instance admin', render: adminPane },
    { sep: true },
    { id: 'logout', label: 'Log out', danger: true, action: () => actions.signOut() },
  ].filter(Boolean);
  return settingsFrame(state.me.display_name, sections, initial);
}

function profilePane() {
  const me = state.me;
  const draft = { display_name: me.display_name, bio: me.bio || '', avatar_url: me.avatar_url, color: me.color, banner: me.banner || '' };
  const preview = h('div.profile-preview');
  const drawPreview = () => clear(preview, 
    h('div.card-banner', { style: { background: draft.banner || draft.color } }),
    h('div.card-head', avatar({ ...me, ...draft }, 72)),
    h('div.card-body', h('strong.card-name', draft.display_name || me.username), h('span.muted', '@' + me.username), draft.bio && h('p', draft.bio)));
  drawPreview();
  const set = (k, v) => { draft[k] = v; drawPreview(); };
  const save = h('button.btn.primary', {
    onclick: async () => { try { await rpc('user:update', draft); toast('Profile saved'); } catch (e) { oops(e); } },
  }, 'Save profile');
  return h('div.split',
    h('div',
      field('Display name', h('input.input', { value: draft.display_name, maxLength: 32, oninput: (e) => set('display_name', e.target.value) })),
      field('About me', h('textarea.input', { value: draft.bio, maxLength: 300, rows: 3, oninput: (e) => set('bio', e.target.value) })),
      field('Avatar', row(
        h('button.btn', { onclick: async () => { const url = await pickImage(); if (url) set('avatar_url', url); } }, 'Upload image'),
        h('button.btn.ghost', { onclick: () => set('avatar_url', null) }, 'Remove'))),
      field('Avatar color', colorPicker(draft.color, (c) => set('color', c)), 'Shown behind your initials when you have no image.'),
      field('Banner color', colorPicker(draft.banner, (c) => set('banner', c), { allowNone: true })),
      save),
    preview);
}

function accountPane() {
  const cur = h('input.input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password' });
  return [
    field('Username', h('input.input', { value: '@' + state.me.username, disabled: true }), 'Usernames are permanent. Your display name is what people see, and you can change it under Profile.'),
    h('h3', 'Change password'),
    field('Current password', cur), field('New password', next),
    h('button.btn.primary', {
      onclick: async () => { try { await rpc('user:password', { current: cur.value, next: next.value }); cur.value = next.value = ''; toast('Password changed'); } catch (e) { oops(e); } },
    }, 'Change password'),
  ];
}

const THEMES = [['harbor', 'Harbor', 'Deep teal, the default'], ['midnight', 'Midnight', 'Darker, higher contrast'], ['daylight', 'Daylight', 'Light']];
function appearancePane(redraw) {
  return [
    h('div.theme-row', THEMES.map(([id, name, desc]) => h('button.theme-card', {
      class: state.prefs.theme === id ? 'on' : '', dataset: { theme: id },
      onclick: () => { state.prefs.theme = id; savePrefs(); applyPrefs(); redraw(); },
    }, h('span.theme-swatch', h('i'), h('i'), h('i')), h('strong', name), h('span.muted', desc)))),
    toggle(state.prefs.density === 'compact', (on) => { state.prefs.density = on ? 'compact' : 'cozy'; savePrefs(); applyPrefs(); }, 'Compact messages: tighter spacing, no avatars'),
  ];
}

function notificationsPane(redraw) {
  const blocked = 'Notification' in window && Notification.permission === 'denied';
  return [
    toggle(state.prefs.desktop && 'Notification' in window && Notification.permission === 'granted', async (on) => {
      if (on && 'Notification' in window && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
      state.prefs.desktop = on; savePrefs(); redraw();
    }, 'Desktop notifications for mentions and direct messages'),
    blocked && note('Your browser is blocking notifications for this site. Allow them in the address bar, then turn this on.'),
    toggle(state.prefs.sounds, (on) => { state.prefs.sounds = on; savePrefs(); }, 'Play a sound for mentions, direct messages and calls'),
    note('Setting your status to Do not disturb silences both.'),
  ];
}

function voicePane() {
  const select = h('select.input', { onchange: () => { state.prefs.micId = select.value; savePrefs(); toast('Microphone saved. It applies the next time you join voice.'); } }, h('option', { value: '' }, 'System default'));
  navigator.mediaDevices?.enumerateDevices().then((list) => {
    for (const d of list.filter((x) => x.kind === 'audioinput' && x.deviceId && x.deviceId !== 'default')) {
      select.append(h('option', { value: d.deviceId, selected: d.deviceId === state.prefs.micId }, d.label || 'Microphone'));
    }
  }).catch(() => {});
  return [
    field('Microphone', select, 'Device names appear after you have joined voice once and allowed microphone access.'),
    note('Voice, camera and screen share connect directly between the people in the call. Echo cancellation and noise suppression are on.'),
  ];
}

/* ---- instance admin */

function adminPane(redraw) {
  const host = h('div', h('p.muted', 'Loading…'));
  rpc('admin:overview').then((d) => {
    const act = (p) => p.then(redraw).catch(oops);
    const stat = (n, label) => h('div.stat', h('strong', n), h('span.muted', label));
    clear(host, 
      note('You run this instance. These tools reach across every server on it.'),
      h('div.stats', stat(d.stats.users, 'accounts'), stat(d.stats.online, 'online now'), stat(d.stats.servers, 'servers'), stat(d.stats.messages, 'messages'), stat(fileSize(d.stats.uploadBytes), 'of uploads')),
      h('h3', 'Accounts'),
      h('div.table', d.users.map((r) => {
        const u = userOf(r.id), self = r.id === state.me.id;
        return h('div.table-row', avatar(u, 32),
          h('div.grow', h('strong', u.display_name, r.site_admin ? h('span.tag', 'Admin') : null, r.disabled ? h('span.tag.red', 'Suspended') : null),
            h('span.muted', `@${u.username} · joined ${shortDate(r.created_at)} · ${r.messages} messages · ${r.servers} servers`)),
          !self && h('button.btn.small.ghost', { onclick: (e) => menu([
            { label: r.site_admin ? 'Remove admin access' : 'Make instance admin', icon: 'shield', onClick: () => act(rpc('admin:user', { userId: r.id, site_admin: !r.site_admin })) },
            { label: r.disabled ? 'Lift suspension' : 'Suspend account', icon: 'ban', onClick: () => act(rpc('admin:user', { userId: r.id, disabled: !r.disabled })) },
            '-',
            { label: 'Delete account', icon: 'trash', danger: true, onClick: async () => {
              if (await confirmDialog({ title: `Delete @${u.username}`, text: 'Their account is removed and they are signed out everywhere. Messages they sent stay, shown as from a deleted user. Servers they own pass to you.', confirm: 'Delete account', danger: true })) act(rpc('admin:deleteUser', { userId: r.id }));
            } },
          ], { anchor: e.currentTarget, align: 'end' }) }, 'Manage'));
      })),
      h('h3', 'Servers'),
      d.servers.length ? h('div.table', d.servers.map((s) => h('div.table-row', tile(s.name, s.icon_url, 32),
        h('div.grow', h('strong', s.name), h('span.muted', `Owned by @${userOf(s.owner_id).username} · ${s.members} members · ${s.messages} messages`)),
        !state.servers.has(s.id) && h('button.btn.small.ghost', { onclick: () => act(rpc('admin:joinServer', { serverId: s.id })) }, 'Join'),
        h('button.btn.small.danger', { onclick: async () => {
          if (await confirmDialog({ title: `Delete ${s.name}`, text: 'Every channel and message in this server is erased. This cannot be undone.', confirm: 'Delete server', danger: true })) act(rpc('admin:deleteServer', { serverId: s.id }));
        } }, 'Delete')))) : empty('No servers yet.'));
  }).catch((e) => clear(host, empty(e.message)));
  return host;
}

/* ---------------------------------------------------------------- server settings */

const PERM_INFO = [
  ['ADMIN', 'Administrator', 'Everything below, plus anything added later. Give this out carefully.'],
  ['MANAGE_SERVER', 'Manage server', 'Rename the server, change its icon, revoke invites, read the audit log, change other people’s nicknames.'],
  ['MANAGE_CHANNELS', 'Manage channels', 'Create, rename, reorder and delete channels and categories.'],
  ['MANAGE_ROLES', 'Manage roles', 'Create and edit roles below their own, and give those roles to members.'],
  ['MANAGE_MESSAGES', 'Manage messages', 'Delete and pin anyone’s messages.'],
  ['KICK', 'Kick members', 'Remove a member. They can rejoin with an invite.'],
  ['BAN', 'Ban members', 'Remove a member and stop them rejoining.'],
  ['TIMEOUT', 'Time out members', 'Stop a member sending messages for a while.'],
];

export function openServerSettings(serverId, initial) {
  const S = () => state.servers.get(serverId);
  if (!S()) return;
  const owner = S().owner_id === state.me.id || state.me.site_admin;
  const sections = [
    can(serverId, 'MANAGE_SERVER') && { id: 'overview', label: 'Overview', render: overview },
    can(serverId, 'MANAGE_ROLES') && { id: 'roles', label: 'Roles', render: rolesPane },
    { id: 'members', label: 'Members', render: membersPane },
    can(serverId, 'MANAGE_SERVER') && { id: 'invites', label: 'Invites', render: invitesPane },
    can(serverId, 'BAN') && { id: 'bans', label: 'Bans', render: bansPane },
    can(serverId, 'MANAGE_SERVER') && { id: 'audit', label: 'Audit log', render: auditPane },
    owner && { sep: true },
    owner && { id: 'danger', label: 'Ownership', danger: true, render: dangerPane },
  ].filter(Boolean);
  let frame = null;
  // The server can vanish while this is open (deleted, or you were removed).
  const gone = () => { if (!S()) { frame?.close(); return true; } return false; };

  function overview() {
    if (gone()) return [];
    const s = S();
    const draft = { name: s.name, icon_url: s.icon_url };
    const iconBox = h('div');
    const drawIcon = () => clear(iconBox, tile(draft.name, draft.icon_url, 88));
    drawIcon();
    return [
      h('div.split.start',
        h('div.icon-edit', iconBox,
          h('button.btn.small', { onclick: async () => { const url = await pickImage(); if (url) { draft.icon_url = url; drawIcon(); } } }, 'Upload icon'),
          draft.icon_url && h('button.btn.small.ghost', { onclick: () => { draft.icon_url = null; drawIcon(); } }, 'Remove')),
        h('div.grow',
          field('Server name', h('input.input', { value: draft.name, maxLength: 60, oninput: (e) => { draft.name = e.target.value; if (!draft.icon_url) drawIcon(); } })),
          h('button.btn.primary', { onclick: async () => { try { await rpc('server:update', { serverId, ...draft }); toast('Server saved'); } catch (e) { oops(e); } } }, 'Save changes'))),
    ];
  }

  let roleId = null;
  function rolesPane(redraw) {
    if (gone()) return [];
    const s = S(), myRank = rankOf(serverId), myPerms = can(serverId, 'ADMIN') ? 255 : rolesFor(serverId, state.me.id).reduce((a, r) => a | r.perms, 0);
    if (!s.roles.some((r) => r.id === roleId)) roleId = s.roles[0]?.id ?? null;
    const role = s.roles.find((r) => r.id === roleId);
    const list = h('div.role-list',
      s.roles.map((r) => h('button.role-item', { class: r.id === roleId ? 'active' : '', onclick: () => { roleId = r.id; redraw(); } },
        h('span.swatch', { style: { background: r.color || 'var(--text-3)' } }), h('span.grow', r.name),
        r.position >= myRank && icon('shield', 14))),
      h('button.btn.small', { onclick: async () => { try { roleId = (await rpc('role:create', { serverId })).id; redraw(); } catch (e) { oops(e); } } }, icon('plus', 16), 'New role'));
    if (!role) return [note('Roles group members, color their names and decide who can moderate.'), list];
    const locked = role.position >= myRank;
    const draft = { name: role.name, color: role.color, hoist: role.hoist, perms: role.perms };
    const count = [...s.members.values()].filter((m) => m.roles.includes(role.id)).length;
    const editor = h('div.role-editor',
      locked && h('p.callout', icon('shield', 16), 'This role is equal to or higher than your own, so you can view it but not change it.'),
      field('Role name', h('input.input', { value: draft.name, maxLength: 40, disabled: locked, oninput: (e) => { draft.name = e.target.value; } })),
      field('Color', locked ? h('span.swatch.big', { style: { background: role.color || 'var(--text-3)' } }) : colorPicker(draft.color, (c) => { draft.color = c; }, { allowNone: true })),
      toggle(draft.hoist, (on) => { draft.hoist = on; }, 'Show these members as their own group in the member list'),
      h('h3', 'Permissions'),
      PERM_INFO.map(([key, label, desc]) => {
        const bit = state.P[key];
        const t = toggle(!!(draft.perms & bit), (on) => { draft.perms = on ? draft.perms | bit : draft.perms & ~bit; });
        if (locked || !(myPerms & bit)) t.querySelector('input').disabled = true;
        return h('div.perm', h('div.grow', h('strong', label), h('span.muted', desc)), t);
      }),
      !locked && row(
        h('button.btn.primary', { onclick: async () => { try { await rpc('role:update', { roleId: role.id, ...draft }); toast('Role saved'); } catch (e) { oops(e); } } }, 'Save role'),
        h('button.btn.ghost', { title: 'Move up', onclick: () => attempt(rpc('role:move', { roleId: role.id, dir: 1 })) }, icon('up', 16), 'Higher'),
        h('button.btn.ghost', { title: 'Move down', onclick: () => attempt(rpc('role:move', { roleId: role.id, dir: -1 })) }, icon('down', 16), 'Lower'),
        h('span.grow'),
        h('button.btn.danger', { onclick: async () => {
          if (await confirmDialog({ title: `Delete ${role.name}`, text: `${count} member${count === 1 ? ' has' : 's have'} this role and will lose it.`, confirm: 'Delete role', danger: true })) attempt(rpc('role:delete', { roleId: role.id }));
        } }, 'Delete role')));
    return [note('Higher roles outrank lower ones. Moderators can only act on people whose highest role is below their own.'), h('div.roles', list, editor)];
  }

  let memberFilter = '';
  function membersPane(redraw) {
    if (gone()) return [];
    const s = S();
    const q = memberFilter.toLowerCase();
    const rows = [...s.members.values()]
      .filter((m) => !q || userOf(m.user_id).username.includes(q) || nameOf(m.user_id, serverId).toLowerCase().includes(q))
      .sort((a, b) => rankOf(serverId, b.user_id) - rankOf(serverId, a.user_id) || nameOf(a.user_id, serverId).localeCompare(nameOf(b.user_id, serverId)));
    const search = h('input.input', { placeholder: 'Search members', value: memberFilter, oninput: () => { memberFilter = search.value; const p = search.selectionStart; redraw(); const n = document.querySelector('.set-pane input'); n?.focus(); n?.setSelectionRange(p, p); } });
    return [
      search,
      h('div.table', rows.map((m) => {
        const u = userOf(m.user_id);
        return h('div.table-row', avatar(u, 36, { status: true }),
          h('div.grow',
            h('strong', { style: { color: colorOf(u.id, serverId) || null } }, nameOf(u.id, serverId),
              s.owner_id === u.id ? h('span.tag.gold', icon('crown', 12), 'Owner') : null,
              m.timeout_until > Date.now() ? h('span.tag.red', 'Timed out') : null),
            h('span.muted', `@${u.username} · joined ${shortDate(m.joined_at)}`),
            h('div.chips', rolesFor(serverId, u.id).map((r) => h('span.chip', h('span.swatch', { style: { background: r.color || 'var(--text-3)' } }), r.name)))),
          can(serverId, 'MANAGE_ROLES') && h('button.btn.small.ghost', { onclick: (e) => roleMenu(serverId, u.id, { anchor: e.currentTarget, align: 'end' }) }, 'Roles'),
          h('button.icon-btn', { title: 'More', onclick: (e) => actions.memberMenu(u.id, serverId, { anchor: e.currentTarget, align: 'end' }) }, icon('more')));
      })),
      !rows.length && empty('No members match that search.'),
    ];
  }

  function invitesPane(redraw) {
    const host = h('div', note('Loading…'));
    rpc('invite:list', { serverId }).then((list) => clear(host, 
      list.length ? h('div.table', list.map((inv) => h('div.table-row',
        h('div.grow', h('code', `${location.origin}/invite/${inv.code}`), h('span.muted', `Created by @${userOf(inv.creator_id).username} on ${shortDate(inv.created_at)} · used ${inv.uses} time${inv.uses === 1 ? '' : 's'}`)),
        h('button.btn.small.ghost', { onclick: () => copyText(`${location.origin}/invite/${inv.code}`, 'Invite link copied') }, 'Copy'),
        h('button.btn.small.danger', { onclick: () => rpc('invite:delete', { code: inv.code }).then(redraw).catch(oops) }, 'Revoke'))))
        : empty('No invite links yet. Create one and send it to someone.'))).catch((e) => clear(host, empty(e.message)));
    return [
      row(h('p.muted.grow', 'Anyone with an invite link can join. Revoking a link stops it working; people who already joined stay.'),
        h('button.btn.primary', { onclick: () => rpc('invite:create', { serverId, fresh: true }).then(redraw).catch(oops) }, 'Create invite link')),
      host,
    ];
  }

  function bansPane(redraw) {
    const host = h('div', note('Loading…'));
    rpc('member:bans', { serverId }).then((list) => clear(host, 
      list.length ? h('div.table', list.map((b) => { const u = userOf(b.user_id); return h('div.table-row', avatar(u, 32),
        h('div.grow', h('strong', u.display_name), h('span.muted', `@${u.username} · banned by @${userOf(b.by_id).username} on ${shortDate(b.created_at)}${b.reason ? ' · ' + b.reason : ''}`)),
        h('button.btn.small', { onclick: () => rpc('member:unban', { serverId, userId: b.user_id }).then(redraw).catch(oops) }, 'Unban')); }))
        : empty('Nobody is banned.'))).catch((e) => clear(host, empty(e.message)));
    return [note('Banned people cannot rejoin, even with a valid invite.'), host];
  }

  function auditPane() {
    const host = h('div', note('Loading…'));
    rpc('server:audit', { serverId }).then((list) => clear(host, 
      list.length ? h('div.table', list.map((a) => h('div.table-row', avatar(a.actor_id, 28),
        h('div.grow', h('span', h('strong', nameOf(a.actor_id, serverId)), ' ', a.action.charAt(0).toLowerCase() + a.action.slice(1), a.detail ? [': ', h('span.audit-detail', a.detail)] : null)),
        h('span.muted.nowrap', stamp(a.created_at)))))
        : empty('Nothing has been recorded yet. Moderation and setup changes will appear here.'))).catch((e) => clear(host, empty(e.message)));
    return [note('A record of who changed what: roles, channels, kicks, bans, timeouts and deleted messages.'), host];
  }

  function dangerPane() {
    if (gone()) return [];
    const s = S();
    const others = [...s.members.keys()].filter((id) => id !== s.owner_id);
    const pick = h('select.input', others.map((id) => h('option', { value: id }, `${nameOf(id, serverId)} (@${userOf(id).username})`)));
    return [
      h('h3', 'Transfer ownership'),
      note('The new owner gets full control, including deleting the server. You keep your roles but lose owner powers.'),
      others.length ? row(pick, h('button.btn.danger', { onclick: async () => {
        const to = Number(pick.value);
        if (await confirmDialog({ title: 'Transfer ownership', text: `Make ${nameOf(to, serverId)} the owner of ${s.name}? You cannot undo this yourself.`, confirm: 'Transfer', danger: true })) {
          try { await rpc('server:update', { serverId, owner_id: to }); toast('Ownership transferred'); frame.close(); } catch (e) { oops(e); }
        }
      } }, 'Transfer')) : empty('There is nobody else here to transfer to.'),
      h('h3', 'Delete server'),
      note('Erases every channel, message, role and invite in this server for everyone.'),
      h('button.btn.danger', { onclick: async () => {
        const typed = await promptDialog({ title: `Delete ${s.name}`, label: `Type the server name to confirm`, placeholder: s.name, confirm: 'Delete server' });
        if (typed == null) return;
        if (typed !== s.name) return oops(new Error('That did not match the server name. Nothing was deleted.'));
        try { await rpc('server:delete', { serverId }); frame.close(); toast('Server deleted'); } catch (e) { oops(e); }
      } }, 'Delete this server'),
    ];
  }
  frame = settingsFrame(S().name, sections, initial);
  return frame;
}

// Checkable list of roles for one member.
export function roleMenu(serverId, uid, pos) {
  const s = state.servers.get(serverId), m = s?.members.get(uid);
  if (!m) return;
  const myRank = rankOf(serverId);
  if (!s.roles.length) return toast('This server has no roles yet. Create one under Server settings → Roles.');
  menu([{ heading: `Roles for ${nameOf(uid, serverId)}` }, ...s.roles.map((r) => ({
    label: r.name, swatch: r.color, checked: m.roles.includes(r.id), disabled: r.position >= myRank,
    onClick: () => attempt(rpc('member:roles', { serverId, userId: uid, roleIds: m.roles.includes(r.id) ? m.roles.filter((x) => x !== r.id) : [...m.roles, r.id] })),
  }))], pos);
}

export function banDialog(serverId, uid) {
  const reason = h('input.input', { placeholder: 'Optional', maxLength: 200 });
  let purge = false;
  const m = modal({
    title: `Ban ${nameOf(uid, serverId)}`, cls: 'narrow',
    body: [h('p.muted', `@${userOf(uid).username} is removed from the server and cannot rejoin until someone unbans them.`), field('Reason', reason, 'Recorded in the audit log.'), toggle(false, (on) => { purge = on; }, 'Also delete every message they sent here')],
    actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn.danger', { onclick: async () => {
      try { await rpc('member:ban', { serverId, userId: uid, reason: reason.value, purge }); m.close(); toast(`Banned ${userOf(uid).display_name}`); } catch (e) { oops(e); }
    } }, 'Ban')],
  });
}

/* ---------------------------------------------------------------- smaller dialogs */

export function addServerDialog(initial = 'create') {
  let tab = initial, iconUrl = null;
  const body = h('div');
  const name = h('input.input', { value: `${state.me.display_name}'s server`, maxLength: 60 });
  const code = h('input.input', { placeholder: `${location.origin}/invite/…` });
  const iconBox = h('button.icon-pick', { type: 'button', title: 'Choose an icon', onclick: async () => { const url = await pickImage(); if (url) { iconUrl = url; draw(); } } });
  const go = async () => {
    try {
      if (tab === 'create') { const { id } = await rpc('server:create', { name: name.value, icon_url: iconUrl }); m.close(); actions.navigate(id); }
      else {
        const c = code.value.trim().split('/').pop();
        if (!c) return oops(new Error('Paste an invite link or code'));
        const { serverId } = await rpc('invite:join', { code: c }); m.close(); actions.navigate(serverId);
      }
    } catch (e) { oops(e); }
  };
  const draw = () => {
    clear(iconBox, iconUrl ? h('img', { src: iconUrl, alt: '' }) : [icon('image', 22), h('span', 'Icon')]);
    clear(body, 
      tabs([['create', 'Create a server'], ['join', 'Join with an invite']], tab, (t) => { tab = t; draw(); }),
      tab === 'create'
        ? h('form.stack', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p.muted', 'A server is your own space with channels, roles and voice rooms. You will be its owner.'), row(iconBox, h('div.grow', field('Server name', name))))
        : h('form.stack', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p.muted', 'Paste the invite link someone sent you.'), field('Invite link', code)));
    btn.textContent = tab === 'create' ? 'Create server' : 'Join server';
  };
  const btn = h('button.btn.primary', { onclick: go });
  const m = modal({ title: 'Add a server', cls: 'narrow', body, actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), btn] });
  draw();
}

export async function inviteDialog(serverId) {
  const s = state.servers.get(serverId);
  let code;
  try { code = (await rpc('invite:create', { serverId })).code; } catch (e) { return oops(e); }
  const url = `${location.origin}/invite/${code}`;
  const friends = [...state.friends].filter(([id, st]) => st === 'friend' && !s.members.has(id)).map(([id]) => id);
  modal({
    title: `Invite people to ${s.name}`, cls: 'narrow',
    body: [
      field('Share this link', row(h('input.input.grow', { value: url, readOnly: true, onfocus: (e) => e.target.select() }), h('button.btn.primary', { onclick: () => copyText(url, 'Invite link copied') }, 'Copy'))),
      friends.length ? h('div.field', h('span.field-label', 'Or send it to a friend'), h('div.table.scroll', friends.map((id) => {
        const b = h('button.btn.small', { onclick: async () => {
          try { const { id: ch } = await rpc('dm:open', { userId: id }); await rpc('msg:send', { channelId: ch, content: `Join me in **${s.name}**: ${url}` }); b.textContent = 'Sent'; b.disabled = true; } catch (e) { oops(e); }
        } }, 'Send');
        return h('div.table-row', avatar(id, 32, { status: true }), h('div.grow', h('strong', userOf(id).display_name), h('span.muted', '@' + userOf(id).username)), b);
      }))) : null,
    ],
  });
}

export async function joinInviteDialog(code) {
  let info;
  try { info = await rpc('invite:info', { code }); } catch (e) { return oops(e); }
  if (info.joined) return actions.navigate(info.server.id);
  const m = modal({
    title: 'You have been invited', cls: 'narrow',
    body: h('div.invite-card', tile(info.server.name, info.server.icon_url, 72), h('strong.big', info.server.name),
      h('span.muted', `${info.server.online} online · ${info.server.members} member${info.server.members === 1 ? '' : 's'}`),
      h('span.muted', `Invited by ${userOf(info.inviter_id).display_name}`)),
    actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Not now'), h('button.btn.primary', { onclick: async () => {
      try { const { serverId } = await rpc('invite:join', { code }); m.close(); actions.navigate(serverId); } catch (e) { oops(e); }
    } }, 'Join server')],
  });
}

export function createChannelDialog(serverId, parentId = null, type = 'text') {
  const s = state.servers.get(serverId);
  const name = h('input.input', { maxLength: 50, placeholder: type === 'category' ? 'Projects' : type === 'voice' ? 'Hangout' : 'new-channel' });
  const kinds = h('div.kinds');
  const drawKinds = () => clear(kinds, ...[['text', 'hash', 'Text', 'Messages, images and links'], ['voice', 'volume', 'Voice', 'Talk, share your camera or screen']].map(([id, ic, label, desc]) =>
    h('button.kind', { type: 'button', class: id === type ? 'on' : '', onclick: () => { type = id; drawKinds(); } }, icon(ic, 22), h('span', h('strong', label), h('span.muted', desc)))));
  drawKinds();
  const go = async () => {
    try { const { id } = await rpc('channel:create', { serverId, name: name.value, type, parent_id: parentId }); m.close(); if (type === 'text') actions.navigate(serverId, id); }
    catch (e) { oops(e); }
  };
  const cat = parentId && s.channels.find((c) => c.id === parentId);
  const m = modal({
    title: type === 'category' ? 'Create category' : 'Create channel', cls: 'narrow',
    body: h('form.stack', { onsubmit: (e) => { e.preventDefault(); go(); } },
      cat && h('p.muted', `In ${cat.name}`), type !== 'category' && kinds, field(type === 'category' ? 'Category name' : 'Channel name', name)),
    actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { onclick: go }, type === 'category' ? 'Create category' : 'Create channel')],
  });
}

export function channelSettingsDialog(ch) {
  const s = state.servers.get(ch.server_id);
  const name = h('input.input', { value: ch.name, maxLength: 50 });
  const topic = h('textarea.input', { value: ch.topic || '', maxLength: 300, rows: 2, placeholder: 'What is this channel for?' });
  const cats = s.channels.filter((c) => c.type === 'category');
  const parent = h('select.input', h('option', { value: '' }, 'No category'), cats.map((c) => h('option', { value: c.id, selected: c.id === ch.parent_id }, c.name)));
  const label = ch.type === 'category' ? 'category' : 'channel';
  const m = modal({
    title: `Edit ${label}`, cls: 'narrow',
    body: h('div.stack', field('Name', name), ch.type === 'text' && field('Topic', topic, 'Shown at the top of the channel.'), ch.type !== 'category' && field('Category', parent)),
    actions: [
      h('button.btn.danger', { onclick: async () => {
        if (await confirmDialog({ title: `Delete ${ch.type === 'text' ? '#' : ''}${ch.name}`, text: ch.type === 'category' ? 'The channels inside it are kept and become uncategorized.' : 'Every message in it is erased. This cannot be undone.', confirm: `Delete ${label}`, danger: true })) {
          try { await rpc('channel:delete', { channelId: ch.id }); m.close(); } catch (e) { oops(e); }
        }
      } }, `Delete ${label}`),
      h('span.grow'),
      h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        try { await rpc('channel:update', { channelId: ch.id, name: name.value, topic: topic.value, parent_id: parent.value ? Number(parent.value) : null }); m.close(); } catch (e) { oops(e); }
      } }, 'Save'),
    ],
  });
}

// Start a DM, or a group chat when more than one person is picked.
export function newDmDialog(addTo = null) {
  const picked = new Set();
  const search = h('input.input', { placeholder: 'Search by name' });
  const list = h('div.table.scroll');
  const exclude = new Set(addTo ? addTo.recipients : [state.me.id]);
  const rank = (u) => (state.friends.get(u.id) === 'friend' ? 0 : 1);
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const users = [...state.users.values()].filter((u) => !exclude.has(u.id) && (!q || u.username.includes(q) || u.display_name.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name)).slice(0, 50);
    clear(list, ...(users.length ? users.map((u) => h('label.table-row.pickable', avatar(u, 32, { status: true }),
      h('div.grow', h('strong', u.display_name), h('span.muted', '@' + u.username + (rank(u) === 0 ? ' · Friend' : ''))),
      h('input', { type: 'checkbox', checked: picked.has(u.id), onchange: (e) => { e.target.checked ? picked.add(u.id) : picked.delete(u.id); btn.textContent = label(); } })))
      : [empty(q ? 'Nobody matches that.' : 'Nobody else has signed up yet. Share your link so they can.')]));
  };
  const label = () => addTo ? 'Add to group' : picked.size > 1 ? 'Create group chat' : 'Open message';
  const btn = h('button.btn.primary', { onclick: async () => {
    if (!picked.size) return oops(new Error('Pick at least one person'));
    try {
      if (addTo) { await rpc('dm:update', { channelId: addTo.id, add: [...picked] }); m.close(); return; }
      const { id } = await rpc('dm:group', { userIds: [...picked] }); m.close(); actions.navigate(null, id);
    } catch (e) { oops(e); }
  } }, label());
  search.oninput = draw;
  const m = modal({ title: addTo ? `Add people to ${dmName(addTo)}` : 'New message', cls: 'narrow', body: [search, list, !addTo && h('p.muted', 'Pick one person for a direct message, or several for a group chat (up to 10 people).')], actions: [h('button.btn.ghost', { onclick: () => m.close() }, 'Cancel'), btn] });
  draw();
}

export function statusMenu(anchor) {
  const me = state.me;
  const pick = (status) => attempt(rpc('status:set', { status }));
  menu([
    ...['online', 'idle', 'dnd', 'invisible'].map((s) => ({ label: h('span.status-opt', h('span.status-dot.inline', { class: 's-' + (s === 'invisible' ? 'offline' : s) }), STATUS_LABEL[s]), checked: me.status_pref === s, onClick: () => pick(s) })),
    '-',
    { label: me.custom_status ? 'Edit custom status' : 'Set a custom status', icon: 'smile', onClick: async () => {
      const v = await promptDialog({ title: 'Custom status', label: 'What are you up to?', value: me.custom_status || '', placeholder: 'Out sailing', maxLength: 80, hint: 'Leave it empty to clear your status.' });
      if (v != null) attempt(rpc('status:set', { custom_status: v }));
    } },
    me.custom_status && { label: 'Clear custom status', icon: 'x', onClick: () => attempt(rpc('status:set', { custom_status: '' })) },
    '-',
    { label: 'Edit profile', icon: 'edit', onClick: () => openUserSettings('profile') },
  ], { anchor, side: 'top' });
}
