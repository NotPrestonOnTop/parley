// Parley — a self-hosted chat server.
// One process: Express (auth, uploads, static files) + Socket.IO (everything realtime) + SQLite.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// On Railway, attach a volume and this picks it up automatically so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.ICE_SERVERS) {
  try { ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS is not valid JSON, using defaults'); }
}

/* ------------------------------------------------------------------ database */

const db = new DatabaseSync(path.join(DATA_DIR, 'parley.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  avatar_url TEXT, color TEXT, banner TEXT, bio TEXT DEFAULT '',
  status TEXT DEFAULT 'online', custom_status TEXT DEFAULT '',
  site_admin INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon_url TEXT,
  owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  server_id INTEGER NOT NULL, user_id INTEGER NOT NULL, nickname TEXT,
  timeout_until INTEGER DEFAULT 0, joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, name TEXT NOT NULL,
  color TEXT DEFAULT '', hoist INTEGER DEFAULT 0, perms INTEGER DEFAULT 0, position INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role_id INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS bans (
  server_id INTEGER NOT NULL, user_id INTEGER NOT NULL, reason TEXT, by_id INTEGER, created_at INTEGER,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, type TEXT NOT NULL,
  name TEXT, topic TEXT DEFAULT '', parent_id INTEGER, position INTEGER DEFAULT 0,
  owner_id INTEGER, icon_url TEXT, last_message_id INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_server ON channels(server_id);
CREATE TABLE IF NOT EXISTS dm_members (
  channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL, closed INTEGER DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_members_user ON dm_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, author_id INTEGER NOT NULL,
  content TEXT DEFAULT '', attachments TEXT DEFAULT '[]', reply_to INTEGER,
  mentions TEXT DEFAULT '[]', everyone INTEGER DEFAULT 0, type TEXT DEFAULT 'default',
  pinned INTEGER DEFAULT 0, edited_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS mentions (message_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mentions_user ON mentions(user_id, channel_id, message_id);
CREATE TABLE IF NOT EXISTS read_state (
  user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, last_read_id INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL, other_id INTEGER NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (user_id, other_id)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, server_id INTEGER NOT NULL, creator_id INTEGER NOT NULL,
  uses INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, actor_id INTEGER NOT NULL,
  action TEXT NOT NULL, detail TEXT DEFAULT '', created_at INTEGER NOT NULL
);
`);

const stmts = new Map();
const st = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
const get = (sql, ...a) => st(sql).get(...a);
const all = (sql, ...a) => st(sql).all(...a);
const run = (sql, ...a) => st(sql).run(...a);
const marks = (n) => Array(n).fill('?').join(',');
const now = () => Date.now();
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const int = (v) => { const n = Number(v); if (!Number.isInteger(n)) fail('Bad request'); return n; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/* ------------------------------------------------------------------ permissions */

const P = { ADMIN: 1, MANAGE_SERVER: 2, MANAGE_CHANNELS: 4, MANAGE_ROLES: 8, MANAGE_MESSAGES: 16, KICK: 32, BAN: 64, TIMEOUT: 128 };
const ALL_PERMS = 255;

const getUser = (id) => get('SELECT * FROM users WHERE id=?', id);
const getServer = (id) => get('SELECT * FROM servers WHERE id=?', id) || fail('That server no longer exists');
const isMember = (sid, uid) => !!get('SELECT 1 FROM members WHERE server_id=? AND user_id=?', sid, uid);
const memberRoles = (sid, uid) => all('SELECT r.* FROM roles r JOIN member_roles mr ON mr.role_id=r.id WHERE mr.server_id=? AND mr.user_id=?', sid, uid);

function permsOf(server, user) {
  if (server.owner_id === user.id || user.site_admin) return ALL_PERMS;
  let p = 0;
  for (const r of memberRoles(server.id, user.id)) p |= r.perms;
  return p & P.ADMIN ? ALL_PERMS : p;
}
function rankOf(server, user) {
  if (server.owner_id === user.id) return 1e9;
  if (user.site_admin) return 1e8;
  return Math.max(0, ...memberRoles(server.id, user.id).map((r) => r.position));
}
function need(server, user, perm) {
  if (!isMember(server.id, user.id) && !user.site_admin) fail('You are not in this server');
  if (!(permsOf(server, user) & perm)) fail('You do not have permission to do that');
}
// Moderation only works downward: you need a higher role than the person you act on.
function needOutrank(server, actor, targetId) {
  const target = getUser(targetId) || fail('User not found');
  if (target.id === actor.id) fail('You cannot do that to yourself');
  if (server.owner_id === target.id) fail('The owner cannot be moderated');
  if (rankOf(server, actor) <= rankOf(server, { ...target, site_admin: 0 })) fail('Their role is equal to or higher than yours');
  return target;
}
const audit = (sid, actorId, action, detail = '') =>
  run('INSERT INTO audit_log(server_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)', sid, actorId, action, detail, now());

/* ------------------------------------------------------------------ http */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.use(express.json({ limit: '1mb' }));

const hashPass = (pw, salt = crypto.randomBytes(12).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
const checkPass = (pw, stored) => { const [salt] = stored.split(':'); return hashPass(pw, salt) === stored; };
const newSession = (uid) => { const t = crypto.randomBytes(24).toString('hex'); run('INSERT INTO sessions VALUES(?,?,?)', t, uid, now()); return t; };
const userFromToken = (t) => t && get('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=?', String(t));
const COLORS = ['#f5c84b', '#ef6b5a', '#4fc3a1', '#5aa9e6', '#b388eb', '#f29e4c', '#e56b9f', '#7bd389', '#58c4dd', '#d4a373'];
const api = (fn) => (req, res) => {
  try { res.json(fn(req, res)); }
  catch (e) { if (!(e instanceof Fail)) console.error(e); res.status(e instanceof Fail ? 400 : 500).json({ error: e instanceof Fail ? e.message : 'Something went wrong' }); }
};

app.post('/api/register', api((req) => {
  const username = str(req.body.username, 32).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_.]{2,32}$/.test(username)) fail('Usernames are 2–32 characters: letters, numbers, dots and underscores');
  if (['everyone', 'here'].includes(username)) fail('That username is reserved');
  if (password.length < 3) fail('Use a password with at least 3 characters');
  if (get('SELECT 1 FROM users WHERE username=?', username)) fail('That username is taken');
  const first = !get('SELECT 1 FROM users LIMIT 1');
  const { lastInsertRowid: id } = run(
    'INSERT INTO users(username,display_name,pass_hash,color,site_admin,created_at) VALUES(?,?,?,?,?,?)',
    username, str(req.body.displayName, 32) || username, hashPass(password), COLORS[Math.floor(Math.random() * COLORS.length)], first ? 1 : 0, now());
  const user = getUser(Number(id));
  io.emit('user:update', publicUser(user));
  // The very first account owns the instance and the starter server; everyone after joins it.
  let home = Number(get("SELECT value FROM meta WHERE key='default_server'")?.value || 0);
  if (first) {
    home = createServer(user, 'The Harbor');
    run("INSERT OR REPLACE INTO meta VALUES('default_server',?)", String(home));
  } else if (home && get('SELECT 1 FROM servers WHERE id=?', home)) joinServer(home, user);
  return { token: newSession(user.id) };
}));

app.post('/api/login', api((req) => {
  const user = get('SELECT * FROM users WHERE username=?', str(req.body.username, 32));
  if (!user || !checkPass(String(req.body.password || ''), user.pass_hash)) fail('Wrong username or password');
  if (user.disabled) fail('This account has been suspended');
  return { token: newSession(user.id) };
}));

app.post('/api/logout', api((req) => { run('DELETE FROM sessions WHERE token=?', String(req.headers.authorization || '')); return {}; }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(10).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
});
app.post('/api/upload', (req, res, next) => {
  if (!userFromToken(req.headers.authorization)) return res.status(401).json({ error: 'Log in again to upload' });
  upload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${MAX_UPLOAD_MB} MB` : 'Upload failed' });
    res.json((req.files || []).map((f) => ({
      url: '/uploads/' + f.filename, size: f.size, type: f.mimetype,
      name: Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200),
    })));
  });
});

app.get('/healthz', (_req, res) => res.send('ok'));
// Uploaded files are served as-is; anything a browser could run as a page is forced to download instead.
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '30d', immutable: true,
  setHeaders: (res, file) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|ogg|wav|m4a|pdf|txt)$/i.test(file)) res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(channels|invite|login|register)(\/.*)?$/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ------------------------------------------------------------------ presence + payloads */

const online = new Map(); // userId -> Set<socket>
const voice = new Map(); // channelId -> Map<userId, {socketId, muted, deaf, video, screen}>

function statusOf(u) {
  const socks = online.get(u.id);
  if (!socks || !socks.size || u.status === 'invisible') return 'offline';
  if (u.status === 'online' && [...socks].every((s) => s.data.idle)) return 'idle';
  return u.status || 'online';
}
function publicUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, color: u.color,
    banner: u.banner, bio: u.bio, custom_status: u.custom_status, status: statusOf(u),
    site_admin: !!u.site_admin, created_at: u.created_at,
  };
}
const emitPresence = (uid) => { const u = getUser(uid); if (u) io.emit('presence', { id: u.id, status: statusOf(u), custom_status: u.custom_status }); };
const emitUser = (uid) => { const u = getUser(uid); if (u) io.emit('user:update', publicUser(u)); };

function memberPayload(sid, uid) {
  const m = get('SELECT * FROM members WHERE server_id=? AND user_id=?', sid, uid);
  if (!m) return null;
  return {
    user_id: uid, nickname: m.nickname, joined_at: m.joined_at, timeout_until: m.timeout_until,
    roles: all('SELECT role_id FROM member_roles WHERE server_id=? AND user_id=?', sid, uid).map((r) => r.role_id),
  };
}
const rolesOf = (sid) => all('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC', sid).map((r) => ({ ...r, hoist: !!r.hoist }));
const voiceList = (chId) => [...(voice.get(chId) || new Map())].map(([user_id, v]) => ({ user_id, muted: v.muted, deaf: v.deaf, video: v.video, screen: v.screen }));

function serverPayload(s) {
  const roleMap = new Map();
  for (const r of all('SELECT user_id, role_id FROM member_roles WHERE server_id=?', s.id)) {
    if (!roleMap.has(r.user_id)) roleMap.set(r.user_id, []);
    roleMap.get(r.user_id).push(r.role_id);
  }
  const channels = all('SELECT id,server_id,type,name,topic,parent_id,position,last_message_id FROM channels WHERE server_id=? ORDER BY position,id', s.id);
  const v = {};
  for (const c of channels) if (voice.has(c.id)) v[c.id] = voiceList(c.id);
  return {
    id: s.id, name: s.name, icon_url: s.icon_url, owner_id: s.owner_id, created_at: s.created_at,
    channels, roles: rolesOf(s.id), voice: v,
    members: all('SELECT user_id,nickname,joined_at,timeout_until FROM members WHERE server_id=?', s.id).map((m) => ({ ...m, roles: roleMap.get(m.user_id) || [] })),
  };
}
function dmPayload(c) {
  return {
    id: c.id, type: c.type, name: c.name, owner_id: c.owner_id, icon_url: c.icon_url, last_message_id: c.last_message_id,
    recipients: all('SELECT user_id FROM dm_members WHERE channel_id=?', c.id).map((r) => r.user_id),
    voice: voice.has(c.id) ? voiceList(c.id) : [],
  };
}
function readyPayload(user) {
  const read = {};
  for (const r of all('SELECT channel_id,last_read_id FROM read_state WHERE user_id=?', user.id)) read[r.channel_id] = r.last_read_id;
  const mentions = {};
  for (const r of all(`SELECT mt.channel_id, COUNT(*) n FROM mentions mt
      LEFT JOIN read_state r ON r.channel_id=mt.channel_id AND r.user_id=mt.user_id
      WHERE mt.user_id=? AND mt.message_id > COALESCE(r.last_read_id,0) GROUP BY mt.channel_id`, user.id)) mentions[r.channel_id] = r.n;
  const friends = {};
  for (const f of all('SELECT other_id,status FROM friends WHERE user_id=?', user.id)) friends[f.other_id] = f.status;
  return {
    me: { ...publicUser(user), status_pref: user.status },
    users: all('SELECT * FROM users').map(publicUser),
    servers: all('SELECT s.* FROM servers s JOIN members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY m.joined_at', user.id).map(serverPayload),
    dms: all('SELECT c.* FROM channels c JOIN dm_members d ON d.channel_id=c.id WHERE d.user_id=? AND d.closed=0', user.id).map(dmPayload),
    friends, read, mentions, ice: ICE_SERVERS, maxUploadMb: MAX_UPLOAD_MB, perms: P,
  };
}

/* ------------------------------------------------------------------ shared operations */

function createServer(owner, name, icon_url = null) {
  const t = now();
  const sid = Number(run('INSERT INTO servers(name,icon_url,owner_id,created_at) VALUES(?,?,?,?)', name, icon_url, owner.id, t).lastInsertRowid);
  run('INSERT INTO members(server_id,user_id,joined_at) VALUES(?,?,?)', sid, owner.id, t);
  const mk = (type, nm, parent, pos, topic = '') =>
    Number(run('INSERT INTO channels(server_id,type,name,topic,parent_id,position,created_at) VALUES(?,?,?,?,?,?,?)', sid, type, nm, topic, parent, pos, t).lastInsertRowid);
  const text = mk('category', 'Text channels', null, 0);
  mk('text', 'general', text, 1, 'Say hello. Everything starts here.');
  mk('text', 'off-topic', text, 2);
  const vc = mk('category', 'Voice channels', null, 3);
  mk('voice', 'Lounge', vc, 4);
  mk('voice', 'Focus room', vc, 5);
  run('INSERT INTO roles(server_id,name,color,hoist,perms,position) VALUES(?,?,?,?,?,?)', sid, 'Admin', '#ef6b5a', 1, P.ADMIN, 2);
  run('INSERT INTO roles(server_id,name,color,hoist,perms,position) VALUES(?,?,?,?,?,?)', sid, 'Moderator', '#4fc3a1', 1, P.MANAGE_MESSAGES | P.KICK | P.TIMEOUT, 1);
  io.in('u:' + owner.id).socketsJoin('s:' + sid);
  io.to('u:' + owner.id).emit('server:add', serverPayload(getServer(sid)));
  return sid;
}

function joinServer(sid, user) {
  if (isMember(sid, user.id)) return;
  run('INSERT INTO members(server_id,user_id,joined_at) VALUES(?,?,?)', sid, user.id, now());
  // Start a newcomer fully caught up rather than with every channel unread.
  run(`INSERT OR REPLACE INTO read_state(user_id,channel_id,last_read_id)
       SELECT ?, id, last_message_id FROM channels WHERE server_id=? AND last_message_id IS NOT NULL`, user.id, sid);
  io.to('s:' + sid).emit('member:add', { serverId: sid, member: memberPayload(sid, user.id), user: publicUser(user) });
  io.in('u:' + user.id).socketsJoin('s:' + sid);
  io.to('u:' + user.id).emit('server:add', serverPayload(getServer(sid)));
  const ch = get("SELECT * FROM channels WHERE server_id=? AND type='text' ORDER BY position,id LIMIT 1", sid);
  if (ch) postMessage(ch, user, { type: 'join' });
}

function removeMember(sid, uid) {
  for (const [chId, room] of voice) {
    if (room.has(uid) && get('SELECT 1 FROM channels WHERE id=? AND server_id=?', chId, sid)) {
      const sock = io.sockets.sockets.get(room.get(uid).socketId);
      if (sock) { sock.emit('voice:kicked'); leaveVoice(sock); }
    }
  }
  run('DELETE FROM members WHERE server_id=? AND user_id=?', sid, uid);
  run('DELETE FROM member_roles WHERE server_id=? AND user_id=?', sid, uid);
  io.to('u:' + uid).emit('server:remove', { serverId: sid });
  io.in('u:' + uid).socketsLeave('s:' + sid);
  io.to('s:' + sid).emit('member:remove', { serverId: sid, userId: uid });
}

function wipeChannel(chId) {
  run('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id=?)', chId);
  run('DELETE FROM mentions WHERE channel_id=?', chId);
  run('DELETE FROM messages WHERE channel_id=?', chId);
  run('DELETE FROM read_state WHERE channel_id=?', chId);
  run('DELETE FROM dm_members WHERE channel_id=?', chId);
  run('DELETE FROM channels WHERE id=?', chId);
  const room = voice.get(chId);
  if (room) for (const v of room.values()) { const s = io.sockets.sockets.get(v.socketId); if (s) { s.emit('voice:kicked'); s.data.voice = null; } }
  voice.delete(chId);
}

function deleteServer(sid) {
  io.to('s:' + sid).emit('server:remove', { serverId: sid });
  io.in('s:' + sid).socketsLeave('s:' + sid);
  tx(() => {
    for (const c of all('SELECT id FROM channels WHERE server_id=?', sid)) wipeChannel(c.id);
    for (const t of ['members', 'roles', 'member_roles', 'bans', 'invites', 'audit_log']) run(`DELETE FROM ${t} WHERE server_id=?`, sid);
    run('DELETE FROM servers WHERE id=?', sid);
  });
}

// Who can see a channel: server members, or the people in a DM.
function access(user, channelId) {
  const ch = get('SELECT * FROM channels WHERE id=?', int(channelId)) || fail('That channel no longer exists');
  if (ch.server_id ? !isMember(ch.server_id, user.id) : !get('SELECT 1 FROM dm_members WHERE channel_id=? AND user_id=?', ch.id, user.id)) fail('You cannot see that channel');
  return ch;
}
const dmUserIds = (chId) => all('SELECT user_id FROM dm_members WHERE channel_id=?', chId).map((r) => r.user_id);
function emitChannel(ch, ev, data) {
  if (ch.server_id) io.to('s:' + ch.server_id).emit(ev, data);
  else for (const uid of dmUserIds(ch.id)) io.to('u:' + uid).emit(ev, data);
}

function hydrate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const reacts = new Map();
  for (const r of db.prepare(`SELECT message_id,emoji,user_id FROM reactions WHERE message_id IN (${marks(ids.length)}) ORDER BY rowid`).all(...ids)) {
    if (!reacts.has(r.message_id)) reacts.set(r.message_id, new Map());
    const m = reacts.get(r.message_id);
    if (!m.has(r.emoji)) m.set(r.emoji, []);
    m.get(r.emoji).push(r.user_id);
  }
  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) {
    for (const r of db.prepare(`SELECT id,author_id,content,attachments FROM messages WHERE id IN (${marks(replyIds.length)})`).all(...replyIds)) {
      replies.set(r.id, { id: r.id, author_id: r.author_id, content: r.content.slice(0, 240), has_attach: r.attachments !== '[]' });
    }
  }
  return rows.map((r) => ({
    id: r.id, channel_id: r.channel_id, author_id: r.author_id, content: r.content,
    attachments: JSON.parse(r.attachments), reply_to: r.reply_to,
    reply: r.reply_to ? replies.get(r.reply_to) || { deleted: true } : null,
    reactions: [...(reacts.get(r.id) || new Map())].map(([emoji, users]) => ({ emoji, users })),
    mentions: JSON.parse(r.mentions), everyone: !!r.everyone, type: r.type,
    pinned: !!r.pinned, edited_at: r.edited_at, created_at: r.created_at,
  }));
}
const oneMessage = (id) => hydrate(all('SELECT * FROM messages WHERE id=?', id))[0];

function postMessage(ch, author, { content = '', attachments = [], replyTo = null, type = 'default', nonce } = {}) {
  const mentioned = new Set();
  let everyone = false;
  if (type === 'default') {
    if (ch.server_id) {
      everyone = /(^|\s)@(everyone|here)\b/.test(content);
      for (const m of content.matchAll(/@([a-z0-9_.]{2,32})/gi)) {
        const u = get('SELECT u.id FROM users u JOIN members m ON m.user_id=u.id AND m.server_id=? WHERE u.username=?', ch.server_id, m[1].replace(/\.+$/, ''));
        if (u) mentioned.add(u.id);
      }
    }
    if (replyTo) { const r = get('SELECT author_id FROM messages WHERE id=? AND channel_id=?', replyTo, ch.id); if (r) mentioned.add(r.author_id); else replyTo = null; }
  }
  const id = Number(run(
    'INSERT INTO messages(channel_id,author_id,content,attachments,reply_to,mentions,everyone,type,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ch.id, author.id, content, JSON.stringify(attachments), replyTo, JSON.stringify([...mentioned]), everyone ? 1 : 0, type, now()).lastInsertRowid);
  run('UPDATE channels SET last_message_id=? WHERE id=?', id, ch.id);
  // The mentions table drives unread badges. In DMs every message counts.
  let notify = mentioned;
  if (type !== 'default') notify = new Set();
  else if (!ch.server_id) notify = new Set(dmUserIds(ch.id));
  else if (everyone) notify = new Set(all('SELECT user_id FROM members WHERE server_id=?', ch.server_id).map((r) => r.user_id));
  notify.delete(author.id);
  for (const uid of notify) run('INSERT INTO mentions VALUES(?,?,?)', id, ch.id, uid);
  if (!ch.server_id) {
    // A new message reopens the conversation for anyone who had closed it.
    if (get('SELECT 1 FROM dm_members WHERE channel_id=? AND closed=1', ch.id)) {
      run('UPDATE dm_members SET closed=0 WHERE channel_id=?', ch.id);
      emitChannel(ch, 'dm:upsert', dmPayload(get('SELECT * FROM channels WHERE id=?', ch.id)));
    }
  }
  run(`INSERT INTO read_state(user_id,channel_id,last_read_id) VALUES(?,?,?)
       ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_id=excluded.last_read_id`, author.id, ch.id, id);
  const message = oneMessage(id);
  emitChannel(ch, 'msg:new', { message, nonce, serverId: ch.server_id });
  return message;
}

function leaveVoice(socket) {
  const chId = socket.data.voice;
  if (!chId) return;
  socket.data.voice = null;
  const room = voice.get(chId);
  if (!room || room.get(socket.data.userId)?.socketId !== socket.id) return;
  room.delete(socket.data.userId);
  if (!room.size) voice.delete(chId);
  const ch = get('SELECT * FROM channels WHERE id=?', chId);
  if (ch) emitChannel(ch, 'voice:update', { channelId: chId, serverId: ch.server_id, users: voiceList(chId) });
}

/* ------------------------------------------------------------------ realtime handlers */

const h = {};

h.ready = ({ user }) => readyPayload(user);

// ---- account
h['user:update'] = ({ user }, d) => {
  const next = {
    display_name: d.display_name !== undefined ? str(d.display_name, 32) || user.username : user.display_name,
    bio: d.bio !== undefined ? str(d.bio, 300) : user.bio,
    avatar_url: d.avatar_url !== undefined ? d.avatar_url || null : user.avatar_url,
    color: d.color !== undefined ? str(d.color, 9) : user.color,
    banner: d.banner !== undefined ? str(d.banner, 9) || null : user.banner,
  };
  run('UPDATE users SET display_name=?,bio=?,avatar_url=?,color=?,banner=? WHERE id=?', next.display_name, next.bio, next.avatar_url, next.color, next.banner, user.id);
  emitUser(user.id);
};
h['user:password'] = ({ user }, d) => {
  if (!checkPass(String(d.current || ''), user.pass_hash)) fail('Current password is wrong');
  if (String(d.next || '').length < 3) fail('Use a password with at least 3 characters');
  run('UPDATE users SET pass_hash=? WHERE id=?', hashPass(String(d.next)), user.id);
};
h['status:set'] = ({ user }, d) => {
  const status = ['online', 'idle', 'dnd', 'invisible'].includes(d.status) ? d.status : user.status;
  const custom = d.custom_status !== undefined ? str(d.custom_status, 80) : user.custom_status;
  run('UPDATE users SET status=?, custom_status=? WHERE id=?', status, custom, user.id);
  io.to('u:' + user.id).emit('me:status', { status_pref: status });
  emitPresence(user.id);
};
h.idle = ({ user, socket }, d) => { if (socket.data.idle !== !!d.idle) { socket.data.idle = !!d.idle; emitPresence(user.id); } };

// ---- servers
h['server:create'] = ({ user }, d) => ({ id: createServer(user, str(d.name, 60) || `${user.display_name}'s server`, d.icon_url || null) });
h['server:update'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  if (d.owner_id !== undefined) {
    if (s.owner_id !== user.id && !user.site_admin) fail('Only the owner can transfer ownership');
    const to = int(d.owner_id);
    if (!isMember(s.id, to)) fail('The new owner has to be a member');
    run('UPDATE servers SET owner_id=? WHERE id=?', to, s.id);
    audit(s.id, user.id, 'Transferred ownership', `to @${getUser(to).username}`);
  } else {
    need(s, user, P.MANAGE_SERVER);
    const name = d.name !== undefined ? str(d.name, 60) || s.name : s.name;
    const icon = d.icon_url !== undefined ? d.icon_url || null : s.icon_url;
    run('UPDATE servers SET name=?, icon_url=? WHERE id=?', name, icon, s.id);
    if (name !== s.name) audit(s.id, user.id, 'Renamed the server', `${s.name} → ${name}`);
  }
  const n = getServer(s.id);
  io.to('s:' + s.id).emit('server:update', { id: n.id, name: n.name, icon_url: n.icon_url, owner_id: n.owner_id });
};
h['server:delete'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  if (s.owner_id !== user.id && !user.site_admin) fail('Only the owner can delete a server');
  deleteServer(s.id);
};
h['server:leave'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  if (s.owner_id === user.id) fail('Transfer ownership or delete the server before leaving');
  removeMember(s.id, user.id);
};
h['server:audit'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.MANAGE_SERVER);
  return all('SELECT * FROM audit_log WHERE server_id=? ORDER BY id DESC LIMIT 200', s.id);
};

// ---- invites
const inviteCode = () => crypto.randomBytes(6).toString('base64url');
h['invite:create'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  if (!isMember(s.id, user.id)) fail('You are not in this server');
  const existing = !d.fresh && get('SELECT code FROM invites WHERE server_id=? AND creator_id=? ORDER BY created_at DESC', s.id, user.id);
  if (existing) return existing;
  const code = inviteCode();
  run('INSERT INTO invites(code,server_id,creator_id,created_at) VALUES(?,?,?,?)', code, s.id, user.id, now());
  return { code };
};
h['invite:list'] = ({ user }, d) => { const s = getServer(int(d.serverId)); need(s, user, P.MANAGE_SERVER); return all('SELECT * FROM invites WHERE server_id=? ORDER BY created_at DESC', s.id); };
h['invite:delete'] = ({ user }, d) => {
  const inv = get('SELECT * FROM invites WHERE code=?', str(d.code)) || fail('Invite not found');
  need(getServer(inv.server_id), user, P.MANAGE_SERVER);
  run('DELETE FROM invites WHERE code=?', inv.code);
};
h['invite:info'] = ({ user }, d) => {
  const inv = get('SELECT * FROM invites WHERE code=?', str(d.code)) || fail('This invite is invalid or has been revoked');
  const s = getServer(inv.server_id);
  const ids = all('SELECT user_id FROM members WHERE server_id=?', s.id).map((r) => r.user_id);
  return {
    code: inv.code, inviter_id: inv.creator_id, joined: ids.includes(user.id),
    server: { id: s.id, name: s.name, icon_url: s.icon_url, members: ids.length, online: ids.filter((i) => online.has(i)).length },
  };
};
h['invite:join'] = ({ user }, d) => {
  const inv = get('SELECT * FROM invites WHERE code=?', str(d.code)) || fail('This invite is invalid or has been revoked');
  if (get('SELECT 1 FROM bans WHERE server_id=? AND user_id=?', inv.server_id, user.id)) fail('You are banned from this server');
  if (!isMember(inv.server_id, user.id)) { run('UPDATE invites SET uses=uses+1 WHERE code=?', inv.code); joinServer(inv.server_id, user); }
  return { serverId: inv.server_id };
};

// ---- channels
const cleanChannelName = (type, name) => (type === 'text' ? str(name, 50).toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') : str(name, 50));
const channelRow = (id) => get('SELECT id,server_id,type,name,topic,parent_id,position,last_message_id FROM channels WHERE id=?', id);
h['channel:create'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.MANAGE_CHANNELS);
  const type = ['text', 'voice', 'category'].includes(d.type) ? d.type : 'text';
  const name = cleanChannelName(type, d.name) || fail('Give the channel a name');
  const parent = type !== 'category' && d.parent_id ? int(d.parent_id) : null;
  const pos = (get('SELECT MAX(position) p FROM channels WHERE server_id=?', s.id).p ?? 0) + 1;
  const id = Number(run('INSERT INTO channels(server_id,type,name,parent_id,position,created_at) VALUES(?,?,?,?,?,?)', s.id, type, name, parent, pos, now()).lastInsertRowid);
  audit(s.id, user.id, `Created ${type === 'category' ? 'category' : type + ' channel'}`, name);
  io.to('s:' + s.id).emit('channel:upsert', channelRow(id));
  return { id };
};
h['channel:update'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  if (!ch.server_id) fail('Not a server channel');
  const s = getServer(ch.server_id);
  need(s, user, P.MANAGE_CHANNELS);
  const name = d.name !== undefined ? cleanChannelName(ch.type, d.name) || ch.name : ch.name;
  const topic = d.topic !== undefined ? str(d.topic, 300) : ch.topic;
  const parent = d.parent_id !== undefined && ch.type !== 'category' ? (d.parent_id ? int(d.parent_id) : null) : ch.parent_id;
  run('UPDATE channels SET name=?, topic=?, parent_id=? WHERE id=?', name, topic, parent, ch.id);
  if (name !== ch.name) audit(s.id, user.id, 'Renamed channel', `${ch.name} → ${name}`);
  io.to('s:' + s.id).emit('channel:upsert', channelRow(ch.id));
};
h['channel:move'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  if (!ch.server_id) fail('Not a server channel');
  need(getServer(ch.server_id), user, P.MANAGE_CHANNELS);
  // Swap places with the nearest sibling in the same group.
  const sibs = all('SELECT id,position FROM channels WHERE server_id=? AND parent_id IS ? AND (type=\'category\')=? ORDER BY position,id', ch.server_id, ch.parent_id, ch.type === 'category' ? 1 : 0);
  const i = sibs.findIndex((c) => c.id === ch.id), j = i + (d.dir < 0 ? -1 : 1);
  if (j < 0 || j >= sibs.length) return;
  run('UPDATE channels SET position=? WHERE id=?', sibs[j].position, sibs[i].id);
  run('UPDATE channels SET position=? WHERE id=?', sibs[i].position, sibs[j].id);
  io.to('s:' + ch.server_id).emit('channel:upsert', channelRow(sibs[i].id));
  io.to('s:' + ch.server_id).emit('channel:upsert', channelRow(sibs[j].id));
};
h['channel:delete'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  if (!ch.server_id) fail('Not a server channel');
  const s = getServer(ch.server_id);
  need(s, user, P.MANAGE_CHANNELS);
  tx(() => { run('UPDATE channels SET parent_id=NULL WHERE parent_id=?', ch.id); wipeChannel(ch.id); });
  audit(s.id, user.id, 'Deleted channel', ch.name);
  io.to('s:' + s.id).emit('channel:delete', { serverId: s.id, channelId: ch.id });
};

// ---- roles
const emitRoles = (sid) => io.to('s:' + sid).emit('server:roles', { serverId: sid, roles: rolesOf(sid) });
function manageableRole(user, roleId) {
  const role = get('SELECT * FROM roles WHERE id=?', int(roleId)) || fail('Role not found');
  const s = getServer(role.server_id);
  need(s, user, P.MANAGE_ROLES);
  if (role.position >= rankOf(s, user)) fail('That role is equal to or higher than yours');
  return { role, s };
}
h['role:create'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.MANAGE_ROLES);
  run('UPDATE roles SET position=position+1 WHERE server_id=?', s.id);
  const id = Number(run('INSERT INTO roles(server_id,name,position) VALUES(?,?,1)', s.id, 'New role').lastInsertRowid);
  audit(s.id, user.id, 'Created role', 'New role');
  emitRoles(s.id);
  return { id };
};
h['role:update'] = ({ user }, d) => {
  const { role, s } = manageableRole(user, d.roleId);
  const mine = permsOf(s, user);
  const name = d.name !== undefined ? str(d.name, 40) || role.name : role.name;
  // You can only hand out permissions you hold yourself.
  const perms = d.perms !== undefined ? (int(d.perms) & mine) | (role.perms & ~mine) : role.perms;
  run('UPDATE roles SET name=?, color=?, hoist=?, perms=? WHERE id=?', name,
    d.color !== undefined ? str(d.color, 9) : role.color, d.hoist !== undefined ? (d.hoist ? 1 : 0) : role.hoist, perms, role.id);
  audit(s.id, user.id, 'Updated role', name);
  emitRoles(s.id);
};
h['role:move'] = ({ user }, d) => {
  const { role, s } = manageableRole(user, d.roleId);
  const other = d.dir > 0
    ? get('SELECT * FROM roles WHERE server_id=? AND position>? ORDER BY position LIMIT 1', s.id, role.position)
    : get('SELECT * FROM roles WHERE server_id=? AND position<? ORDER BY position DESC LIMIT 1', s.id, role.position);
  if (!other) return;
  if (other.position >= rankOf(s, user)) fail('You cannot move a role above your own');
  run('UPDATE roles SET position=? WHERE id=?', other.position, role.id);
  run('UPDATE roles SET position=? WHERE id=?', role.position, other.id);
  emitRoles(s.id);
};
h['role:delete'] = ({ user }, d) => {
  const { role, s } = manageableRole(user, d.roleId);
  run('DELETE FROM member_roles WHERE role_id=?', role.id);
  run('DELETE FROM roles WHERE id=?', role.id);
  audit(s.id, user.id, 'Deleted role', role.name);
  io.to('s:' + s.id).emit('server:sync', serverPayload(s));
};

// ---- members
const emitMember = (sid, uid) => io.to('s:' + sid).emit('member:update', { serverId: sid, member: memberPayload(sid, uid) });
h['member:roles'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.MANAGE_ROLES);
  const uid = int(d.userId);
  if (!isMember(s.id, uid)) fail('They are no longer in this server');
  const rank = rankOf(s, user);
  const have = new Set(memberPayload(s.id, uid).roles);
  const want = new Set((d.roleIds || []).map(int));
  for (const r of rolesOf(s.id)) {
    if (have.has(r.id) === want.has(r.id)) continue;
    if (r.position >= rank) fail(`The ${r.name} role is equal to or higher than yours`);
    if (want.has(r.id)) run('INSERT OR IGNORE INTO member_roles VALUES(?,?,?)', s.id, uid, r.id);
    else run('DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?', s.id, uid, r.id);
    audit(s.id, user.id, want.has(r.id) ? 'Gave role' : 'Removed role', `${r.name} · @${getUser(uid).username}`);
  }
  emitMember(s.id, uid);
};
h['member:nick'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  const uid = d.userId ? int(d.userId) : user.id;
  if (uid !== user.id) { need(s, user, P.MANAGE_SERVER); needOutrank(s, user, uid); }
  if (!isMember(s.id, uid)) fail('They are no longer in this server');
  run('UPDATE members SET nickname=? WHERE server_id=? AND user_id=?', str(d.nickname, 32) || null, s.id, uid);
  emitMember(s.id, uid);
};
h['member:kick'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.KICK);
  const target = needOutrank(s, user, int(d.userId));
  removeMember(s.id, target.id);
  audit(s.id, user.id, 'Kicked', `@${target.username}`);
};
h['member:ban'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.BAN);
  const target = needOutrank(s, user, int(d.userId));
  run('INSERT OR REPLACE INTO bans VALUES(?,?,?,?,?)', s.id, target.id, str(d.reason, 200), user.id, now());
  if (d.purge) {
    // Optionally sweep their messages out with them.
    for (const c of all('SELECT id FROM channels WHERE server_id=?', s.id)) {
      const ids = all('SELECT id FROM messages WHERE channel_id=? AND author_id=?', c.id, target.id).map((r) => r.id);
      for (const id of ids) { run('DELETE FROM reactions WHERE message_id=?', id); run('DELETE FROM mentions WHERE message_id=?', id); run('DELETE FROM messages WHERE id=?', id); }
      if (ids.length) io.to('s:' + s.id).emit('msg:bulkDelete', { channelId: c.id, ids });
    }
  }
  removeMember(s.id, target.id);
  audit(s.id, user.id, 'Banned', `@${target.username}${d.reason ? ' · ' + str(d.reason, 200) : ''}`);
};
h['member:unban'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.BAN);
  run('DELETE FROM bans WHERE server_id=? AND user_id=?', s.id, int(d.userId));
  audit(s.id, user.id, 'Unbanned', `@${getUser(int(d.userId))?.username || 'deleted user'}`);
};
h['member:bans'] = ({ user }, d) => { const s = getServer(int(d.serverId)); need(s, user, P.BAN); return all('SELECT * FROM bans WHERE server_id=? ORDER BY created_at DESC', s.id); };
h['member:timeout'] = ({ user }, d) => {
  const s = getServer(int(d.serverId));
  need(s, user, P.TIMEOUT);
  const target = needOutrank(s, user, int(d.userId));
  const mins = Math.max(0, Math.min(Number(d.minutes) || 0, 60 * 24 * 28));
  run('UPDATE members SET timeout_until=? WHERE server_id=? AND user_id=?', mins ? now() + mins * 60000 : 0, s.id, target.id);
  audit(s.id, user.id, mins ? 'Timed out' : 'Removed timeout', `@${target.username}${mins ? ` · ${mins} min` : ''}`);
  emitMember(s.id, target.id);
};

// ---- messages
h['msg:send'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  if (!['text', 'dm', 'group'].includes(ch.type)) fail('You cannot send messages there');
  if (ch.server_id) {
    const m = get('SELECT timeout_until FROM members WHERE server_id=? AND user_id=?', ch.server_id, user.id);
    if (m && m.timeout_until > now()) fail(`You are timed out for another ${Math.ceil((m.timeout_until - now()) / 60000)} min`);
  }
  const content = String(d.content ?? '').slice(0, 4000).trim();
  const attachments = (Array.isArray(d.attachments) ? d.attachments : []).slice(0, 10).map((a) => ({
    url: str(a.url, 300), name: str(a.name, 200), size: Number(a.size) || 0, type: str(a.type, 100),
    w: Number(a.w) || undefined, h: Number(a.h) || undefined,
  })).filter((a) => a.url.startsWith('/uploads/'));
  if (!content && !attachments.length) fail('Nothing to send');
  return postMessage(ch, user, { content, attachments, replyTo: d.replyTo ? int(d.replyTo) : null, nonce: d.nonce });
};
function ownMessageOrMod(user, id, allowMod) {
  const msg = get('SELECT * FROM messages WHERE id=?', int(id)) || fail('That message was deleted');
  const ch = access(user, msg.channel_id);
  const mod = ch.server_id ? !!(permsOf(getServer(ch.server_id), user) & P.MANAGE_MESSAGES) : false;
  if (msg.author_id !== user.id && !(allowMod && mod)) fail('You can only change your own messages');
  return { msg, ch, mod };
}
h['msg:edit'] = ({ user }, d) => {
  const { msg, ch } = ownMessageOrMod(user, d.id, false);
  const content = String(d.content ?? '').slice(0, 4000).trim();
  if (!content && msg.attachments === '[]') fail('A message cannot be empty');
  run('UPDATE messages SET content=?, edited_at=? WHERE id=?', content, now(), msg.id);
  emitChannel(ch, 'msg:update', oneMessage(msg.id));
};
h['msg:delete'] = ({ user }, d) => {
  const { msg, ch } = ownMessageOrMod(user, d.id, true);
  run('DELETE FROM reactions WHERE message_id=?', msg.id);
  run('DELETE FROM mentions WHERE message_id=?', msg.id);
  run('DELETE FROM messages WHERE id=?', msg.id);
  if (msg.author_id !== user.id) audit(ch.server_id, user.id, 'Deleted a message', `by @${getUser(msg.author_id)?.username || 'deleted user'} in #${ch.name}`);
  emitChannel(ch, 'msg:delete', { id: msg.id, channelId: ch.id });
};
h['msg:react'] = ({ user }, d) => {
  const msg = get('SELECT * FROM messages WHERE id=?', int(d.id)) || fail('That message was deleted');
  const ch = access(user, msg.channel_id);
  const emoji = str(d.emoji, 32) || fail('Pick an emoji');
  if (get('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', msg.id, user.id, emoji)) run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', msg.id, user.id, emoji);
  else {
    if (get('SELECT COUNT(DISTINCT emoji) n FROM reactions WHERE message_id=?', msg.id).n >= 20) fail('This message has the maximum number of reactions');
    run('INSERT INTO reactions VALUES(?,?,?)', msg.id, user.id, emoji);
  }
  emitChannel(ch, 'msg:update', oneMessage(msg.id));
};
h['msg:pin'] = ({ user }, d) => {
  const msg = get('SELECT * FROM messages WHERE id=?', int(d.id)) || fail('That message was deleted');
  const ch = access(user, msg.channel_id);
  if (ch.server_id) need(getServer(ch.server_id), user, P.MANAGE_MESSAGES);
  run('UPDATE messages SET pinned=? WHERE id=?', d.pinned ? 1 : 0, msg.id);
  emitChannel(ch, 'msg:update', oneMessage(msg.id));
  if (d.pinned) postMessage(ch, user, { type: 'pin', replyTo: msg.id });
};
h['msg:pins'] = ({ user }, d) => { const ch = access(user, d.channelId); return hydrate(all('SELECT * FROM messages WHERE channel_id=? AND pinned=1 ORDER BY id DESC LIMIT 50', ch.id)); };
h['msg:fetch'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  const limit = Math.min(Number(d.limit) || 50, 100);
  let rows;
  if (d.before) rows = all('SELECT * FROM messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT ?', ch.id, int(d.before), limit).reverse();
  else if (d.after) rows = all('SELECT * FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT ?', ch.id, int(d.after), limit);
  else if (d.around) {
    const half = Math.ceil(limit / 2);
    rows = [
      ...all('SELECT * FROM messages WHERE channel_id=? AND id<=? ORDER BY id DESC LIMIT ?', ch.id, int(d.around), half).reverse(),
      ...all('SELECT * FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT ?', ch.id, int(d.around), half),
    ];
  } else rows = all('SELECT * FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT ?', ch.id, limit).reverse();
  return {
    messages: hydrate(rows),
    hasOlder: rows.length ? !!get('SELECT 1 FROM messages WHERE channel_id=? AND id<? LIMIT 1', ch.id, rows[0].id) : false,
    hasNewer: rows.length ? !!get('SELECT 1 FROM messages WHERE channel_id=? AND id>? LIMIT 1', ch.id, rows.at(-1).id) : false,
  };
};
h['msg:search'] = ({ user }, d) => {
  const q = str(d.q, 100);
  if (!q) return [];
  let ids;
  if (d.serverId) {
    const s = getServer(int(d.serverId));
    if (!isMember(s.id, user.id)) fail('You are not in this server');
    ids = all("SELECT id FROM channels WHERE server_id=? AND type='text'", s.id).map((c) => c.id);
  } else ids = [access(user, d.channelId).id];
  if (!ids.length) return [];
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  return hydrate(db.prepare(`SELECT * FROM messages WHERE channel_id IN (${marks(ids.length)}) AND type='default' AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50`).all(...ids, like));
};
h.typing = ({ user }, d) => { const ch = access(user, d.channelId); emitChannel(ch, 'typing', { channelId: ch.id, userId: user.id }); };
h.ack = ({ user }, d) => {
  const ch = access(user, d.channelId);
  const id = int(d.messageId);
  run(`INSERT INTO read_state(user_id,channel_id,last_read_id) VALUES(?,?,?)
       ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_id=MAX(last_read_id, excluded.last_read_id)`, user.id, ch.id, id);
  io.to('u:' + user.id).emit('ack', { channelId: ch.id, messageId: id });
};

// ---- direct messages
function openDm(user, otherId) {
  const other = getUser(otherId) || fail('User not found');
  if (other.id === user.id) fail('You cannot message yourself');
  let ch = get(`SELECT c.* FROM channels c JOIN dm_members a ON a.channel_id=c.id AND a.user_id=?
                JOIN dm_members b ON b.channel_id=c.id AND b.user_id=? WHERE c.type='dm'`, user.id, other.id);
  if (!ch) {
    const id = Number(run("INSERT INTO channels(type,created_at) VALUES('dm',?)", now()).lastInsertRowid);
    run('INSERT INTO dm_members VALUES(?,?,0)', id, user.id);
    run('INSERT INTO dm_members VALUES(?,?,1)', id, other.id); // stays hidden for them until the first message
    ch = get('SELECT * FROM channels WHERE id=?', id);
  } else run('UPDATE dm_members SET closed=0 WHERE channel_id=? AND user_id=?', ch.id, user.id);
  io.to('u:' + user.id).emit('dm:upsert', dmPayload(ch));
  return ch;
}
h['dm:open'] = ({ user }, d) => ({ id: openDm(user, int(d.userId)).id });
h['dm:group'] = ({ user }, d) => {
  const ids = [...new Set((d.userIds || []).map(int))].filter((i) => i !== user.id && getUser(i)).slice(0, 9);
  if (!ids.length) fail('Pick at least one person');
  if (ids.length === 1) return { id: openDm(user, ids[0]).id };
  const id = Number(run("INSERT INTO channels(type,name,owner_id,created_at) VALUES('group',?,?,?)", str(d.name, 60) || null, user.id, now()).lastInsertRowid);
  for (const uid of [user.id, ...ids]) run('INSERT INTO dm_members VALUES(?,?,0)', id, uid);
  const ch = get('SELECT * FROM channels WHERE id=?', id);
  emitChannel(ch, 'dm:upsert', dmPayload(ch));
  return { id };
};
h['dm:close'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  if (ch.type === 'dm') { run('UPDATE dm_members SET closed=1 WHERE channel_id=? AND user_id=?', ch.id, user.id); io.to('u:' + user.id).emit('dm:remove', { channelId: ch.id }); }
  else if (ch.type === 'group') {
    postMessage(ch, user, { type: 'system', content: 'left the group' });
    run('DELETE FROM dm_members WHERE channel_id=? AND user_id=?', ch.id, user.id);
    io.to('u:' + user.id).emit('dm:remove', { channelId: ch.id });
    const left = dmUserIds(ch.id);
    if (!left.length) wipeChannel(ch.id);
    else {
      if (ch.owner_id === user.id) run('UPDATE channels SET owner_id=? WHERE id=?', left[0], ch.id);
      emitChannel(ch, 'dm:upsert', dmPayload(get('SELECT * FROM channels WHERE id=?', ch.id)));
    }
  }
};
h['dm:update'] = ({ user }, d) => {
  const ch = access(user, d.channelId);
  if (ch.type !== 'group') fail('Only group chats can be changed');
  if (d.name !== undefined) { run('UPDATE channels SET name=? WHERE id=?', str(d.name, 60) || null, ch.id); postMessage(ch, user, { type: 'system', content: `renamed the group to ${str(d.name, 60) || 'its default name'}` }); }
  for (const uid of (d.add || []).map(int)) {
    if (!getUser(uid) || dmUserIds(ch.id).length >= 10) continue;
    if (run('INSERT OR IGNORE INTO dm_members VALUES(?,?,0)', ch.id, uid).changes) postMessage(ch, user, { type: 'system', content: `added @${getUser(uid).username}` });
  }
  emitChannel(ch, 'dm:upsert', dmPayload(get('SELECT * FROM channels WHERE id=?', ch.id)));
};

// ---- friends
const setFriend = (a, b, status) => {
  if (status) run('INSERT OR REPLACE INTO friends VALUES(?,?,?)', a, b, status); else run('DELETE FROM friends WHERE user_id=? AND other_id=?', a, b);
  io.to('u:' + a).emit('friend:update', { userId: b, status: status || null });
};
h['friend:add'] = ({ user }, d) => {
  const other = d.userId ? getUser(int(d.userId)) : get('SELECT * FROM users WHERE username=?', str(d.username, 32).replace(/^@/, ''));
  if (!other) fail('Nobody has that username. Check the spelling.');
  if (other.id === user.id) fail('That is you');
  const rel = get('SELECT status FROM friends WHERE user_id=? AND other_id=?', user.id, other.id)?.status;
  if (rel === 'friend') fail('You are already friends');
  if (rel === 'out') fail('Request already sent');
  if (rel === 'in') { setFriend(user.id, other.id, 'friend'); setFriend(other.id, user.id, 'friend'); return { status: 'friend' }; }
  setFriend(user.id, other.id, 'out'); setFriend(other.id, user.id, 'in');
  return { status: 'out' };
};
h['friend:accept'] = ({ user }, d) => {
  const oid = int(d.userId);
  if (get('SELECT status FROM friends WHERE user_id=? AND other_id=?', user.id, oid)?.status !== 'in') fail('No pending request from them');
  setFriend(user.id, oid, 'friend'); setFriend(oid, user.id, 'friend');
};
h['friend:remove'] = ({ user }, d) => { const oid = int(d.userId); setFriend(user.id, oid, null); setFriend(oid, user.id, null); };

// ---- voice (the server only relays signaling; audio and video go peer to peer)
h['voice:join'] = ({ user, socket }, d) => {
  const ch = access(user, d.channelId);
  if (!['voice', 'dm', 'group'].includes(ch.type)) fail('That is not a voice channel');
  leaveVoice(socket);
  for (const [chId, room] of voice) {
    // One voice connection per person: joining from a new tab drops the old one.
    const old = room.get(user.id);
    if (old) { const s = io.sockets.sockets.get(old.socketId); if (s) { s.emit('voice:kicked'); leaveVoice(s); } else { room.delete(user.id); if (!room.size) voice.delete(chId); } }
  }
  if (!voice.has(ch.id)) voice.set(ch.id, new Map());
  const room = voice.get(ch.id);
  const peers = [...room.keys()];
  room.set(user.id, { socketId: socket.id, muted: !!d.muted, deaf: !!d.deaf, video: false, screen: false });
  socket.data.voice = ch.id;
  emitChannel(ch, 'voice:update', { channelId: ch.id, serverId: ch.server_id, users: voiceList(ch.id) });
  if (!ch.server_id && !peers.length) for (const uid of dmUserIds(ch.id)) if (uid !== user.id) io.to('u:' + uid).emit('call:ring', { channelId: ch.id, from: user.id });
  return { peers };
};
h['voice:leave'] = ({ socket }) => leaveVoice(socket);
h['voice:state'] = ({ user, socket }, d) => {
  const room = voice.get(socket.data.voice), me = room?.get(user.id);
  if (!me) return;
  for (const k of ['muted', 'deaf', 'video', 'screen']) if (d[k] !== undefined) me[k] = !!d[k];
  const ch = get('SELECT * FROM channels WHERE id=?', socket.data.voice);
  emitChannel(ch, 'voice:update', { channelId: ch.id, serverId: ch.server_id, users: voiceList(ch.id) });
};
h['voice:signal'] = ({ user, socket }, d) => {
  const peer = voice.get(socket.data.voice)?.get(int(d.to));
  if (peer) io.to(peer.socketId).emit('voice:signal', { from: user.id, data: d.data });
};

// ---- instance admin (the first account, plus anyone they promote)
const needSiteAdmin = (user) => { if (!user.site_admin) fail('Instance admins only'); };
h['admin:overview'] = ({ user }) => {
  needSiteAdmin(user);
  let bytes = 0;
  try { for (const f of fs.readdirSync(UPLOAD_DIR)) bytes += fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch { /* empty */ }
  return {
    stats: {
      users: get('SELECT COUNT(*) n FROM users').n, servers: get('SELECT COUNT(*) n FROM servers').n,
      messages: get('SELECT COUNT(*) n FROM messages').n, online: online.size, uploadBytes: bytes,
    },
    users: all(`SELECT u.id, u.disabled, u.site_admin, u.created_at,
        (SELECT COUNT(*) FROM messages m WHERE m.author_id=u.id) messages,
        (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id) servers FROM users u ORDER BY u.id`),
    servers: all(`SELECT s.id, s.name, s.icon_url, s.owner_id, s.created_at,
        (SELECT COUNT(*) FROM members m WHERE m.server_id=s.id) members,
        (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.server_id=s.id) messages FROM servers s ORDER BY s.id`),
  };
};
const kickSockets = (uid) => { for (const s of [...(online.get(uid) || [])]) { s.emit('session:ended'); s.disconnect(true); } };
h['admin:user'] = ({ user }, d) => {
  needSiteAdmin(user);
  const target = getUser(int(d.userId)) || fail('User not found');
  if (target.id === user.id) fail('You cannot change your own admin access');
  if (d.site_admin !== undefined) run('UPDATE users SET site_admin=? WHERE id=?', d.site_admin ? 1 : 0, target.id);
  if (d.disabled !== undefined) {
    run('UPDATE users SET disabled=? WHERE id=?', d.disabled ? 1 : 0, target.id);
    if (d.disabled) { run('DELETE FROM sessions WHERE user_id=?', target.id); kickSockets(target.id); }
  }
  emitUser(target.id);
};
h['admin:deleteUser'] = ({ user }, d) => {
  needSiteAdmin(user);
  const target = getUser(int(d.userId)) || fail('User not found');
  if (target.id === user.id) fail('You cannot delete yourself');
  run('DELETE FROM sessions WHERE user_id=?', target.id);
  kickSockets(target.id);
  // Servers they own pass to the admin who removed them, so nothing is orphaned.
  for (const s of all('SELECT * FROM servers WHERE owner_id=?', target.id)) {
    run('UPDATE servers SET owner_id=? WHERE id=?', user.id, s.id);
    if (!isMember(s.id, user.id)) joinServer(s.id, user);
    io.to('s:' + s.id).emit('server:update', { id: s.id, name: s.name, icon_url: s.icon_url, owner_id: user.id });
  }
  for (const m of all('SELECT server_id FROM members WHERE user_id=?', target.id)) removeMember(m.server_id, target.id);
  for (const f of all('SELECT other_id FROM friends WHERE user_id=?', target.id)) { setFriend(f.other_id, target.id, null); }
  run('DELETE FROM friends WHERE user_id=?', target.id);
  run('DELETE FROM read_state WHERE user_id=?', target.id);
  run('DELETE FROM mentions WHERE user_id=?', target.id);
  run('DELETE FROM users WHERE id=?', target.id);
  io.emit('user:delete', { id: target.id });
};
h['admin:deleteServer'] = ({ user }, d) => { needSiteAdmin(user); deleteServer(getServer(int(d.serverId)).id); };
h['admin:joinServer'] = ({ user }, d) => { needSiteAdmin(user); joinServer(getServer(int(d.serverId)).id, user); };

/* ------------------------------------------------------------------ sockets */

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user || user.disabled) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const uid = socket.data.userId;
  socket.join('u:' + uid);
  for (const m of all('SELECT server_id FROM members WHERE user_id=?', uid)) socket.join('s:' + m.server_id);
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket);
  emitPresence(uid);

  socket.on('rpc', (name, data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try {
      const user = getUser(uid);
      if (!user) return reply({ error: 'Your account no longer exists' });
      if (!Object.hasOwn(h, name)) return reply({ error: 'Unknown action' });
      reply({ data: h[name]({ user, socket }, data || {}) ?? null });
    } catch (e) {
      if (!(e instanceof Fail)) console.error(name, e);
      reply({ error: e instanceof Fail ? e.message : 'Something went wrong on the server' });
    }
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    const set = online.get(uid);
    if (set) { set.delete(socket); if (!set.size) online.delete(uid); }
    emitPresence(uid);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Parley is running on port ${PORT} (data in ${DATA_DIR})`));
