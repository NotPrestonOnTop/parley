// The message list and the composer.
import {
  state, h, clear, icon, rpc, uploadFiles, actions, findChannel, userOf, nameOf, colorOf, can, memberOf, dmName, dmOther,
  isUnread, lastMessageId, sameDay, timeOnly, stamp, longDate, fileSize,
} from './core.js';
import { avatar, menu, oops, attempt, confirmDialog, copyText, modal } from './ui.js';
import { renderMarkdown, extractEmbeds } from './markdown.js';
import { emojiPicker, searchEmoji, expandShortcodes, QUICK, rememberEmoji } from './emoji.js';

const el = {};
let chId = null;
let atBottom = true, loading = false, newMarker = null, editingId = null;
let reply = null, pending = [], busy = false, lastTyping = 0;
let ac = { items: [], index: 0, start: 0, end: 0 };

const cache = () => state.msgs.get(chId);
const me = () => state.me.id;
const serverId = () => findChannel(chId)?.server_id || null;
const touch = matchMedia('(pointer: coarse)').matches;

/* ---------------------------------------------------------------- build */

export function buildChat() {
  el.input = h('textarea.composer-input', {
    rows: 1, maxLength: 4000, 'aria-label': 'Message',
    oninput: () => { autosize(); updateAc(); pingTyping(); },
    onkeydown: onKey, onpaste: onPaste, onblur: () => setTimeout(closeAc, 150),
  });
  el.file = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles(el.file.files); el.file.value = ''; } });
  el.emojiBtn = h('button.icon-btn', { type: 'button', title: 'Emoji', onclick: () => emojiPicker(el.emojiBtn, insertAtCaret, { keepOpen: true }) }, icon('smile'));
  el.send = h('button.icon-btn.send', { type: 'button', title: 'Send message', onclick: send }, icon('send', 18));
  el.root = h('section.chat', {
    ondragover: (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); el.root.classList.add('dropping'); } },
    ondragleave: (e) => { if (!el.root.contains(e.relatedTarget)) el.root.classList.remove('dropping'); },
    ondrop: (e) => { e.preventDefault(); el.root.classList.remove('dropping'); addFiles(e.dataTransfer.files); },
  },
  h('div.drop-hint', h('div', icon('attach', 32), h('strong', 'Drop to attach'))),
  el.scroller = h('div.scroller', { onscroll: onScroll }, el.intro = h('div.intro'), el.list = h('div.msg-list')),
  el.jump = h('button.jump-bar', { type: 'button', hidden: true, onclick: jumpToPresent }),
  h('div.composer-wrap',
    el.ac = h('div.autocomplete', { hidden: true }),
    el.replyBar = h('div.reply-bar', { hidden: true }),
    el.tray = h('div.tray', { hidden: true }),
    el.composer = h('div.composer', h('button.icon-btn', { type: 'button', title: 'Attach files', onclick: () => el.file.click() }, icon('attach')), el.file, el.input, el.emojiBtn, el.send),
    el.notice = h('div.composer-notice', { hidden: true }),
    el.typing = h('div.typing')));
  window.addEventListener('focus', ack);
  // Keep the newest message in view when the list is resized (stage opens, keyboard appears, composer grows).
  new ResizeObserver(() => { if (atBottom) el.scroller.scrollTop = el.scroller.scrollHeight; }).observe(el.scroller);
  return el.root;
}

/* ---------------------------------------------------------------- loading */

async function load(channelId, params = {}) {
  const res = await rpc('msg:fetch', { channelId, limit: 50, ...params });
  const c = state.msgs.get(channelId);
  if (params.before && c) { c.list.unshift(...res.messages); c.hasOlder = res.hasOlder; }
  else if (params.after && c) { c.list.push(...res.messages); c.hasNewer = res.hasNewer; }
  else state.msgs.set(channelId, { list: res.messages, hasOlder: res.hasOlder, hasNewer: res.hasNewer });
  return state.msgs.get(channelId);
}

export async function showChannel() {
  if (chId && el.input.value.trim()) state.drafts.set(chId, el.input.value); else state.drafts.delete(chId);
  chId = state.view.channelId;
  const ch = findChannel(chId);
  reply = null; pending = []; editingId = null;
  closeAc(); renderReply(); renderTray();
  if (!ch) return;
  el.input.value = state.drafts.get(chId) || '';
  autosize();
  refreshComposer();
  renderTyping();
  const seen = state.read.get(chId) || 0;
  newMarker = isUnread(ch) && seen ? seen : null;
  let c = cache();
  if (c && c.list.length > 150) { c.list = c.list.slice(-100); c.hasOlder = true; }
  if (!c || c.hasNewer) {
    clear(el.intro, );
    clear(el.list, h('div.loading', 'Loading messages…'));
    const want = chId;
    try { c = await load(want); } catch (e) { if (chId === want) clear(el.list, h('div.loading', e.message)); return; }
    if (chId !== want) return;
  }
  renderAll();
  scrollToBottom();
  ack();
  if (!touch) el.input.focus();
}

// After a reconnect: anything we were showing may be stale.
export async function reload() {
  state.msgs.clear();
  if (!findChannel(chId)) return;
  const want = chId, keep = atBottom;
  try { await load(want); } catch { return; }
  if (chId !== want) return;
  renderAll();
  if (keep) scrollToBottom();
}

async function loadOlder() {
  const c = cache();
  if (loading || !c?.hasOlder || !c.list.length) return;
  loading = true;
  const want = chId;
  try {
    await load(want, { before: c.list[0].id });
    if (chId !== want) return;
    const before = el.scroller.scrollHeight;
    renderAll();
    el.scroller.scrollTop += el.scroller.scrollHeight - before;
  } catch (e) { oops(e); } finally { loading = false; }
}
async function loadNewer() {
  const c = cache();
  if (loading || !c?.hasNewer) return;
  loading = true;
  const want = chId;
  try { await load(want, { after: c.list.at(-1).id }); if (chId === want) renderAll(); }
  catch (e) { oops(e); } finally { loading = false; }
}

export async function jumpTo(channelId, messageId) {
  const ch = findChannel(channelId);
  if (!ch) return;
  if (channelId !== chId) await actions.navigate(ch.server_id || null, channelId);
  if (chId !== channelId) return;
  if (!cache()?.list.some((m) => m.id === messageId)) {
    try { await load(channelId, { around: messageId }); } catch (e) { return oops(e); }
    renderAll();
  }
  const node = el.list.querySelector(`[data-id="${messageId}"]`);
  if (!node) return oops(new Error('That message was deleted'));
  node.scrollIntoView({ block: 'center' });
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
}

async function jumpToPresent() {
  if (cache()?.hasNewer) { state.msgs.delete(chId); await load(chId); renderAll(); }
  scrollToBottom();
  ack();
}

/* ---------------------------------------------------------------- scrolling + read state */

function scrollToBottom() { el.scroller.scrollTop = el.scroller.scrollHeight; atBottom = true; updateJump(); }
function onScroll() {
  const s = el.scroller;
  atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  if (s.scrollTop < 300) loadOlder();
  if (atBottom) { if (cache()?.hasNewer) loadNewer(); else ack(); }
  updateJump();
}
function updateJump() {
  const c = cache(), s = el.scroller;
  const far = s.scrollHeight - s.scrollTop - s.clientHeight > 900;
  el.jump.hidden = !(c?.hasNewer || far);
  if (!el.jump.hidden) clear(el.jump, h('span', c?.hasNewer ? 'You are viewing older messages' : 'Scrolled up'), h('strong', 'Jump to present'), icon('arrowDown', 16));
}
export const isLive = () => atBottom && !cache()?.hasNewer && document.hasFocus();

export function ack() {
  const ch = findChannel(chId), c = cache();
  if (!ch || !c || c.hasNewer || !atBottom || !document.hasFocus()) return;
  const last = lastMessageId(ch);
  if (!last || (last <= (state.read.get(chId) || 0) && !state.mentions.get(chId))) return;
  state.read.set(chId, last);
  state.mentions.delete(chId);
  rpc('ack', { channelId: chId, messageId: last }).catch(() => {});
  actions.invalidate('rail', 'side', 'title');
}

/* ---------------------------------------------------------------- rendering */

const divider = (text, cls = '') => h('div.divider', { class: cls }, h('span', text));

function renderIntro() {
  const c = cache(), ch = findChannel(chId);
  if (!ch || !c || c.hasOlder) return clear(el.intro, );
  if (ch.server_id) {
    clear(el.intro, h('div.intro-mark', icon('hash', 30)), h('h1', `Welcome to #${ch.name}`),
      h('p', ch.topic || `This is the very first message space in #${ch.name}. Say something.`));
  } else if (ch.type === 'dm') {
    const u = userOf(dmOther(ch));
    clear(el.intro, avatar(u, 72), h('h1', u.display_name), h('p', `@${u.username} · This is the start of your direct messages with ${u.display_name}.`));
  } else {
    clear(el.intro, h('div.intro-mark', icon('users', 30)), h('h1', dmName(ch)), h('p', 'This is the start of this group chat.'));
  }
}

function renderAll() {
  const c = cache();
  if (!c) return;
  const nodes = [];
  let prev = null;
  for (const m of c.list) {
    if (!prev || !sameDay(prev.created_at, m.created_at)) nodes.push(divider(longDate(m.created_at)));
    if (newMarker != null && m.id > newMarker && (!prev || prev.id <= newMarker) && m.author_id !== me()) nodes.push(divider('New', 'new'));
    nodes.push(messageEl(m, prev));
    prev = m;
  }
  clear(el.list, ...nodes);
  renderIntro();
  updateJump();
}
// Names, colors or permissions changed somewhere: redraw without moving the reader.
let redrawTimer = 0;
export function redraw() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    if (!cache() || editingId) return;
    const keep = atBottom, top = el.scroller.scrollTop;
    renderAll();
    if (keep) scrollToBottom(); else el.scroller.scrollTop = top;
    refreshComposer();
  }, 60);
}

// One-line preview of a message with the markdown symbols taken out.
const plain = (text) => text.replace(/```[a-z0-9+#-]*\n?|[*_~`|]{1,3}|^>\s?/gim, '').replace(/\s+/g, ' ').trim();

const isHead = (m, prev) => !prev || prev.type !== 'default' || prev.author_id !== m.author_id || !!m.reply_to
  || m.created_at - prev.created_at > 7 * 60000 || !sameDay(prev.created_at, m.created_at);

function systemEl(m) {
  const who = h('button.link-name', { onclick: (e) => actions.openProfile(m.author_id, e.currentTarget) }, nameOf(m.author_id, serverId()));
  let body, ic = 'userPlus';
  if (m.type === 'join') body = [who, ' joined the server.'];
  else if (m.type === 'pin') { ic = 'pin'; body = [who, ' pinned ', m.reply && !m.reply.deleted ? h('button.link-name', { onclick: () => jumpTo(chId, m.reply.id) }, 'a message') : 'a message', ' to this channel.']; }
  else body = [who, ' ', renderMarkdown(m.content, { serverId: serverId() })];
  return h('article.msg.system', { dataset: { id: m.id } }, h('span.gutter', icon(ic, 16)), h('div.sys-body', body, h('time', stamp(m.created_at))));
}

function messageEl(m, prev) {
  if (m.type !== 'default') return systemEl(m);
  const sid = serverId(), head = isHead(m, prev), mine = m.author_id === me();
  const author = userOf(m.author_id);
  const pinged = !mine && (m.everyone || m.mentions.includes(me()));
  const node = h('article.msg', { class: (head ? 'head' : '') + (pinged ? ' pinged' : ''), dataset: { id: m.id } });

  if (m.reply) {
    node.append(h('div.reply-ref', m.reply.deleted
      ? h('span.muted', 'Original message was deleted')
      : [avatar(m.reply.author_id, 16), h('span.reply-name', { style: { color: colorOf(m.reply.author_id, sid) || null } }, nameOf(m.reply.author_id, sid)),
        h('button.reply-snip', { onclick: () => jumpTo(chId, m.reply.id) }, plain(m.reply.content) || (m.reply.has_attach ? 'Attachment' : ''))]));
  }

  const open = (e) => actions.openProfile(m.author_id, e.currentTarget);
  const gutter = head
    ? h('button.gutter.avatar-btn', { onclick: open, oncontextmenu: (e) => userMenu(e, m.author_id), 'aria-label': author.display_name }, avatar(author, 40))
    : h('span.gutter', h('time', timeOnly(m.created_at)));
  const body = h('div.msg-body');
  if (head) {
    body.append(h('header',
      h('button.author', { style: { color: colorOf(m.author_id, sid) || null }, onclick: open, oncontextmenu: (e) => userMenu(e, m.author_id) }, nameOf(m.author_id, sid)),
      h('time', { title: new Date(m.created_at).toLocaleString() }, stamp(m.created_at))));
  }
  if (m.content) {
    const md = h('div.md', renderMarkdown(m.content, { serverId: sid, onUser: actions.openProfile, onChannel: (id) => actions.navigate(sid, id) }));
    if (m.edited_at) md.append(h('span.edited', { title: 'Edited ' + stamp(m.edited_at) }, ' (edited)'));
    body.append(md);
  }
  if (m.attachments.length) body.append(h('div.attachments', m.attachments.map(attachmentEl)));
  const embeds = m.content ? extractEmbeds(m.content) : [];
  if (embeds.length) body.append(h('div.attachments', embeds.map(embedEl)));
  if (m.reactions.length) {
    body.append(h('div.reactions',
      m.reactions.map((r) => h('button.reaction', {
        class: r.users.includes(me()) ? 'mine' : '', title: r.users.map((u) => nameOf(u, sid)).join(', '),
        onclick: () => react(m.id, r.emoji),
      }, h('span.r-emoji', r.emoji), h('span.r-count', r.users.length))),
      h('button.reaction.add', { title: 'Add reaction', onclick: (e) => emojiPicker(e.currentTarget, (c) => react(m.id, c), { align: 'start' }) }, icon('smile', 16))));
  }
  node.append(gutter, body, toolbar(m, mine));
  node.oncontextmenu = (e) => { if (e.target.closest('a, .author, .avatar-btn, .mention, input, textarea')) return; e.preventDefault(); messageMenu(m, { x: e.clientX, y: e.clientY }); };
  if (touch) {
    // Long-press opens the message menu where hover tools are not available.
    let timer = 0;
    const cancel = () => clearTimeout(timer);
    node.addEventListener('touchstart', (e) => { const t = e.touches[0]; timer = setTimeout(() => messageMenu(m, { x: t.clientX, y: t.clientY }), 480); }, { passive: true });
    node.addEventListener('touchend', cancel); node.addEventListener('touchmove', cancel, { passive: true });
  }
  return node;
}

function toolbar(m, mine) {
  const more = h('button.icon-btn', { title: 'More', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); messageMenu(m, { x: r.left, y: r.bottom + 4 }); } }, icon('more', 18));
  return h('div.msg-tools',
    QUICK.slice(0, 3).map((c) => h('button.icon-btn.quick', { title: 'React ' + c, onclick: () => react(m.id, c) }, c)),
    h('button.icon-btn', { title: 'Add reaction', onclick: (e) => emojiPicker(e.currentTarget, (c) => react(m.id, c)) }, icon('smile', 18)),
    h('button.icon-btn', { title: 'Reply', onclick: () => startReply(m) }, icon('reply', 18)),
    mine && h('button.icon-btn', { title: 'Edit', onclick: () => startEdit(m.id) }, icon('edit', 18)),
    more);
}

const canModerate = () => { const s = serverId(); return s ? can(s, 'MANAGE_MESSAGES') : true; };
function messageMenu(m, pos) {
  const mine = m.author_id === me(), s = serverId();
  menu([
    { label: 'Add reaction', icon: 'smile', onClick: () => { const n = el.list.querySelector(`[data-id="${m.id}"] .msg-tools`) || el.list; emojiPicker(n, (c) => react(m.id, c)); } },
    { label: 'Reply', icon: 'reply', onClick: () => startReply(m) },
    mine && { label: 'Edit message', icon: 'edit', onClick: () => startEdit(m.id) },
    canModerate() && { label: m.pinned ? 'Unpin message' : 'Pin message', icon: 'pin', onClick: () => attempt(rpc('msg:pin', { id: m.id, pinned: !m.pinned })) },
    '-',
    m.content && { label: 'Copy text', icon: 'copy', onClick: () => copyText(m.content) },
    { label: 'Copy message link', icon: 'link', onClick: () => copyText(`${location.origin}/channels/${s || '@me'}/${chId}?m=${m.id}`, 'Link copied') },
    '-',
    (mine || (s && can(s, 'MANAGE_MESSAGES'))) && { label: 'Delete message', icon: 'trash', danger: true, onClick: (e) => deleteMessage(m, e.shiftKey) },
  ], pos);
}
function userMenu(e, uid) { e.preventDefault(); e.stopPropagation(); actions.memberMenu(uid, serverId(), { x: e.clientX, y: e.clientY }); }

async function deleteMessage(m, skipConfirm) {
  if (!skipConfirm) {
    const preview = h('div.quote-preview', h('strong', nameOf(m.author_id, serverId())), h('div', m.content.slice(0, 300) || 'Attachment'));
    if (!await confirmDialog({ title: 'Delete message', text: 'This removes the message for everyone. Hold Shift while clicking Delete to skip this check.', confirm: 'Delete', danger: true, extra: preview })) return;
  }
  attempt(rpc('msg:delete', { id: m.id }));
}
const react = (id, emoji) => { rememberEmoji(emoji); attempt(rpc('msg:react', { id, emoji })); };

/* ---- attachments and link previews */

function fit(w, ht, maxW = 420, maxH = 320) {
  if (!w || !ht) return null;
  const k = Math.min(maxW / w, maxH / ht, 1);
  return { width: Math.round(w * k), height: Math.round(ht * k) };
}
function imageEl(url, name, w, ht) {
  const size = fit(w, ht);
  const img = h('img', { src: url, alt: name || '', loading: 'lazy' });
  if (size) { img.width = size.width; img.height = size.height; }
  else img.onload = () => { if (atBottom) scrollToBottom(); };
  return h('button.att-image', { class: size ? '' : 'unsized', title: name || '', onclick: () => lightbox(url, name) }, img);
}
function attachmentEl(a) {
  if (a.type.startsWith('image/')) return imageEl(a.url, a.name, a.w, a.h);
  if (a.type.startsWith('video/')) return h('video.att-video', { src: a.url, controls: true, preload: 'metadata' });
  if (a.type.startsWith('audio/')) return h('div.att-file', icon('volume', 22), h('div.att-meta', h('span.att-name', a.name), h('audio', { src: a.url, controls: true, preload: 'none' })));
  return h('div.att-file', icon('file', 26),
    h('div.att-meta', h('a.att-name', { href: a.url, download: a.name, target: '_blank' }, a.name), h('span.muted', fileSize(a.size))),
    h('a.icon-btn', { href: a.url, download: a.name, title: 'Download' }, icon('download', 18)));
}
function embedEl(e) {
  if (e.kind === 'image') return imageEl(e.url, '', 0, 0);
  if (e.kind === 'video') return h('video.att-video', { src: e.url, controls: true, preload: 'metadata' });
  const box = h('button.att-yt', { title: 'Play video', onclick: () => box.replaceWith(h('iframe.att-yt', { src: `https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1`, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowFullscreen: true })) },
    h('img', { src: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, alt: '', loading: 'lazy' }), h('span.play', icon('right', 30)));
  return box;
}
function lightbox(url, name) {
  const m = modal({
    cls: 'lightbox', body: [h('img', { src: url, alt: name || '', onclick: () => m.close() }),
      h('a.muted', { href: url, target: '_blank', rel: 'noopener' }, 'Open original')],
  });
}

/* ---------------------------------------------------------------- live updates */

export function onNew(m) {
  const c = state.msgs.get(m.channel_id);
  if (!c || c.hasNewer) return;
  if (c.list.some((x) => x.id === m.id)) return;
  const prev = c.list.at(-1);
  c.list.push(m);
  if (m.channel_id !== chId) return;
  const stick = atBottom || m.author_id === me();
  if (!prev || !sameDay(prev.created_at, m.created_at)) el.list.append(divider(longDate(m.created_at)));
  if (!el.list.querySelector('.divider.new') && m.author_id !== me() && !isLive()) { newMarker = prev?.id ?? 0; el.list.append(divider('New', 'new')); }
  el.list.querySelector('.loading')?.remove();
  el.list.append(messageEl(m, prev));
  if (stick) scrollToBottom();
  ack();
}
export function onUpdate(m) {
  const c = state.msgs.get(m.channel_id);
  const i = c ? c.list.findIndex((x) => x.id === m.id) : -1;
  if (i < 0) return;
  c.list[i] = m;
  if (m.channel_id !== chId || editingId === m.id) return;
  const stick = atBottom;
  el.list.querySelector(`[data-id="${m.id}"]`)?.replaceWith(messageEl(m, c.list[i - 1]));
  if (stick) scrollToBottom();
}
export function onDelete(channelId, ids) {
  const c = state.msgs.get(channelId);
  if (!c) return;
  const gone = new Set(ids);
  c.list = c.list.filter((m) => !gone.has(m.id));
  if (channelId !== chId) return;
  if (gone.has(editingId)) editingId = null;
  if (reply && gone.has(reply.id)) { reply = null; renderReply(); }
  const top = el.scroller.scrollTop;
  renderAll();
  el.scroller.scrollTop = top;
}

export function renderTyping() {
  const sid = serverId();
  const names = [...(state.typing.get(chId)?.keys() || [])].filter((u) => u !== me()).map((u) => nameOf(u, sid));
  if (!names.length) return clear(el.typing, );
  const text = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
    : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]} are typing` : 'Several people are typing';
  clear(el.typing, h('span.dots', h('i'), h('i'), h('i')), h('span', h('strong', text), '…'));
}

/* ---------------------------------------------------------------- composer */

export function refreshComposer() {
  const ch = findChannel(chId);
  if (!ch) return;
  const until = ch.server_id ? memberOf(ch.server_id, me())?.timeout_until || 0 : 0;
  const locked = until > Date.now();
  el.composer.hidden = locked;
  el.notice.hidden = !locked;
  if (locked) clear(el.notice, icon('clock', 18), `You are timed out in this server until ${stamp(until)}. You can read but not send.`);
  el.input.placeholder = ch.server_id ? `Message #${ch.name}` : ch.type === 'dm' ? `Message @${userOf(dmOther(ch)).display_name}` : `Message ${dmName(ch)}`;
}
function autosize() { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, innerHeight * 0.4) + 'px'; }
export function insertAtCaret(text) {
  const i = el.input;
  i.setRangeText(text, i.selectionStart, i.selectionEnd, 'end');
  autosize(); i.focus();
}
export const focusComposer = () => el.input?.focus();
function pingTyping() {
  if (!el.input.value.trim() || Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  rpc('typing', { channelId: chId }).catch(() => {});
}

function startReply(m) { reply = m; renderReply(); el.input.focus(); }
function renderReply() {
  el.replyBar.hidden = !reply;
  if (reply) clear(el.replyBar, h('span', 'Replying to ', h('strong', nameOf(reply.author_id, serverId()))), h('button.icon-btn', { title: 'Cancel reply', onclick: () => { reply = null; renderReply(); } }, icon('x', 16)));
}

function addFiles(list) {
  for (const file of list) {
    if (pending.length >= 10) { oops(new Error('You can attach up to 10 files per message')); break; }
    if (file.size > state.maxUploadMb * 1048576) { oops(new Error(`${file.name} is larger than ${state.maxUploadMb} MB`)); continue; }
    const p = { file, name: file.name || 'pasted-image.png' };
    if (file.type.startsWith('image/')) {
      p.url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { p.w = img.naturalWidth; p.h = img.naturalHeight; };
      img.src = p.url;
    }
    pending.push(p);
  }
  renderTray();
  el.input.focus();
}
function renderTray() {
  el.tray.hidden = !pending.length;
  clear(el.tray, ...pending.map((p) => h('div.tray-item',
    p.url ? h('img', { src: p.url, alt: '' }) : h('div.tray-file', icon('file', 28)),
    h('span.tray-name', p.name),
    h('button.icon-btn.tray-x', { title: 'Remove', onclick: () => { pending = pending.filter((x) => x !== p); renderTray(); } }, icon('x', 14)))));
}
function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
}

const COMMANDS = [
  ['shrug', 'Add ¯\\_(ツ)_/¯ to your message'], ['tableflip', 'Add (╯°□°)╯︵ ┻━┻'], ['unflip', 'Add ┬─┬ ノ( ゜-゜ノ)'],
  ['me', 'Say it in italics'], ['spoiler', 'Hide your message until clicked'], ['nick', 'Change your nickname in this server'],
];
// Returns the text to send, or null if the command did its own thing.
function applyCommand(text) {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return text;
  const arg = (m[2] || '').trim();
  switch (m[1]) {
    case 'shrug': return (arg + ' ¯\\\\\\_(ツ)\\_/¯').trim();
    case 'tableflip': return (arg + ' (╯°□°)╯︵ ┻━┻').trim();
    case 'unflip': return (arg + ' ┬─┬ ノ( ゜-゜ノ)').trim();
    case 'me': return arg ? `_${arg}_` : text;
    case 'spoiler': return arg ? `||${arg}||` : text;
    case 'nick':
      if (!serverId()) { oops(new Error('Nicknames only exist inside servers')); return null; }
      attempt(rpc('member:nick', { serverId: serverId(), nickname: arg }));
      return null;
    default: return text;
  }
}

async function send() {
  if (busy) return;
  const raw = el.input.value, files = pending, replying = reply, channelId = chId;
  if (!raw.trim() && !files.length) return;
  const text = applyCommand(raw);
  el.input.value = ''; pending = []; reply = null; lastTyping = 0;
  state.drafts.delete(chId);
  renderTray(); renderReply(); autosize(); closeAc();
  if (text === null) return;
  try {
    let attachments = [];
    if (files.length) {
      busy = true; el.composer.classList.add('busy');
      const up = await uploadFiles(files.map((f) => f.file));
      attachments = up.map((u, i) => ({ ...u, w: files[i].w, h: files[i].h }));
    }
    await rpc('msg:send', { channelId, content: expandShortcodes(text), attachments, replyTo: replying?.id });
    files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  } catch (e) {
    oops(e);
    if (chId === channelId && !el.input.value) { el.input.value = raw; pending = files; reply = replying; renderTray(); renderReply(); autosize(); }
  } finally { busy = false; el.composer.classList.remove('busy'); }
}

function onKey(e) {
  if (!el.ac.hidden && ac.items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length; drawAc(); return; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptAc(ac.items[ac.index]); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAc(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); send(); }
  else if (e.key === 'Escape' && reply) { reply = null; renderReply(); }
  else if (e.key === 'ArrowUp' && !el.input.value) {
    const last = cache()?.list.findLast((m) => m.author_id === me() && m.type === 'default');
    if (last) { e.preventDefault(); startEdit(last.id); }
  }
}

/* ---- inline editing */

function startEdit(id) {
  const c = cache(), m = c?.list.find((x) => x.id === id);
  const node = el.list.querySelector(`[data-id="${id}"]`);
  if (!m || !node) return;
  if (editingId) cancelEdit();
  editingId = id;
  const box = h('textarea.composer-input.edit-input', { value: m.content, maxLength: 4000 });
  const done = () => { editingId = null; node.replaceWith(messageEl(m, c.list[c.list.indexOf(m) - 1])); el.input.focus(); };
  const save = async () => {
    const text = expandShortcodes(box.value.trim());
    if (text === m.content) return done();
    if (!text && !m.attachments.length) { done(); return deleteMessage(m, false); }
    try { await rpc('msg:edit', { id, content: text }); editingId = null; const fresh = cache()?.list.find((x) => x.id === id); if (fresh) onUpdate(fresh); el.input.focus(); }
    catch (e) { oops(e); }
  };
  box.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
  };
  box.oninput = () => { box.style.height = 'auto'; box.style.height = box.scrollHeight + 'px'; };
  const editor = h('div.editor', box, h('div.edit-hint', 'Escape to ', h('button.link', { onclick: done }, 'cancel'), ' · Enter to ', h('button.link', { onclick: save }, 'save')));
  const md = node.querySelector('.md');
  if (md) md.replaceWith(editor); else node.querySelector('.msg-body').prepend(editor);
  node.classList.add('editing');
  box.oninput();
  box.focus(); box.setSelectionRange(box.value.length, box.value.length);
}
function cancelEdit() {
  const id = editingId; editingId = null;
  const c = cache(), i = c ? c.list.findIndex((x) => x.id === id) : -1;
  if (i >= 0) el.list.querySelector(`[data-id="${id}"]`)?.replaceWith(messageEl(c.list[i], c.list[i - 1]));
}

/* ---- @mention, #channel, :emoji: and /command suggestions */

function closeAc() { el.ac.hidden = true; ac.items = []; }
function updateAc() {
  const pos = el.input.selectionStart, before = el.input.value.slice(0, pos);
  const ch = findChannel(chId), sid = ch?.server_id;
  let items = [], start = 0;
  const cmd = /^\/(\w*)$/.exec(before);
  const tok = /(^|\s)([@#:])([^\s@#:]*)$/.exec(before);
  if (cmd) {
    items = COMMANDS.filter(([n]) => n.startsWith(cmd[1].toLowerCase())).map(([n, d]) => ({ left: h('span.ac-glyph', '/'), label: n, hint: d, insert: '/' + n }));
  } else if (tok) {
    const q = tok[3].toLowerCase();
    start = pos - tok[3].length - 1;
    if (tok[2] === '@' && ch) {
      const ids = sid ? [...state.servers.get(sid).members.keys()] : ch.recipients;
      const scored = [];
      for (const id of ids) {
        const u = userOf(id), names = [u.username, u.display_name, nameOf(id, sid)].map((s) => s.toLowerCase());
        const rank = names.some((n) => n.startsWith(q)) ? 0 : names.some((n) => n.includes(q)) ? 1 : 2;
        if (rank < 2) scored.push([rank + (u.status === 'offline' ? 0.5 : 0), u]);
      }
      scored.sort((a, b) => a[0] - b[0] || a[1].username.localeCompare(b[1].username));
      items = scored.slice(0, 8).map(([, u]) => ({ left: avatar(u, 24), label: nameOf(u.id, sid), hint: '@' + u.username, color: colorOf(u.id, sid), insert: '@' + u.username }));
      if (sid) for (const n of ['everyone', 'here']) if (n.startsWith(q)) items.push({ left: h('span.ac-glyph', '@'), label: '@' + n, hint: n === 'here' ? 'Notify everyone in this server' : 'Notify everyone in this server', insert: '@' + n });
    } else if (tok[2] === '#' && sid) {
      items = state.servers.get(sid).channels.filter((c) => c.type === 'text' && c.name.includes(q)).slice(0, 8)
        .map((c) => ({ left: h('span.ac-glyph', icon('hash', 16)), label: c.name, insert: '#' + c.name }));
    } else if (tok[2] === ':' && q.length >= 2) {
      items = searchEmoji(q, 8).map((e) => ({ left: h('span.ac-emoji', e.char), label: ':' + e.names[0] + ':', insert: e.char }));
    }
  }
  if (!items.length) return closeAc();
  ac = { items, index: 0, start, end: pos };
  el.ac.hidden = false;
  drawAc();
}
function drawAc() {
  clear(el.ac, ...ac.items.map((it, i) => h('button.ac-item', {
    type: 'button', class: i === ac.index ? 'on' : '',
    onmousedown: (e) => { e.preventDefault(); acceptAc(it); }, onmouseenter: () => { if (ac.index !== i) { ac.index = i; drawAc(); } },
  }, it.left, h('span.ac-label', { style: { color: it.color || null } }, it.label), it.hint && h('span.ac-hint', it.hint))));
}
function acceptAc(it) {
  el.input.setRangeText(it.insert + ' ', ac.start, ac.end, 'end');
  closeAc(); autosize(); el.input.focus();
}
