// Chat markdown → DOM nodes. Nothing here ever touches innerHTML, so message text cannot inject markup.
import { h, state, userByName, nameOf } from './core.js';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
const URL_RE = /^https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/;

// ctx: { serverId, onUser(id, el), onChannel(id) }
export function renderMarkdown(text, ctx = {}) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  if (text.length <= 40 && EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text)) {
    frag.append(h('span.jumbo', text));
    return frag;
  }
  // Fenced code first, then everything between fences line by line.
  const fence = /```(?:([a-z0-9+#-]+)\n)?\n?([\s\S]*?)```/gi;
  let last = 0, m;
  while ((m = fence.exec(text))) {
    blocks(text.slice(last, m.index), frag, ctx);
    frag.append(h('pre', h('code', { 'data-lang': m[1] || null }, m[2].replace(/\n$/, ''))));
    last = m.index + m[0].length;
  }
  blocks(text.slice(last), frag, ctx);
  return frag;
}

function blocks(text, out, ctx) {
  if (!text) return;
  const lines = text.replace(/^\n+|\n+$/g, '').split('\n');
  let quote = null, first = true;
  const br = () => { if (!first) out.append(h('br')); first = false; };
  for (const line of lines) {
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      if (!quote) { quote = h('blockquote'); out.append(quote); first = true; } else quote.append(h('br'));
      quote.append(...inline(q[1], ctx));
      continue;
    }
    quote = null;
    const head = /^(#{1,3})\s+(.+)$/.exec(line);
    if (head) { out.append(h('span.md-h' + head[1].length, inline(head[2], ctx))); first = true; continue; }
    const li = /^\s*[-*]\s+(.+)$/.exec(line);
    if (li) { out.append(h('span.md-li', inline(li[1], ctx))); first = true; continue; }
    br();
    out.append(...inline(line, ctx));
  }
}

const wrap = (tag) => (m, ctx) => h(tag, inline(m[1], ctx));
const RULES = [
  [/^\\([\\*_~`|>#@[\]])/, (m) => m[1]],
  [/^`([^`\n]+)`/, (m) => h('code', m[1])],
  [/^\|\|([\s\S]+?)\|\|/, (m, ctx) => h('span.spoiler', { tabIndex: 0, title: 'Spoiler — click to reveal', onclick: (e) => e.currentTarget.classList.add('shown') }, inline(m[1], ctx))],
  [/^\*\*([\s\S]+?)\*\*(?!\*)/, wrap('strong')],
  [/^__([\s\S]+?)__(?!_)/, wrap('u')],
  [/^\*(?=\S)([\s\S]*?\S)\*(?!\*)/, wrap('em')],
  [/^_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}])/u, wrap('em'), 'word'],
  [/^~~([\s\S]+?)~~/, wrap('s')],
  [/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, (m) => link(m[2], m[1])],
  [URL_RE, (m) => link(m[0], m[0])],
  [/^@(everyone|here)\b/, (m) => h('span.mention', '@' + m[1]), 'word'],
  [/^@([a-z0-9_.]{2,32})/i, mention, 'word'],
  [/^#([\p{L}\p{N}_-]{1,50})/u, channelRef, 'word'],
];

function link(url, label) {
  // In-app links (invites, channels) stay in this tab; everything else opens a new one.
  const own = url.startsWith(location.origin + '/');
  return h('a', { href: url, target: own ? null : '_blank', rel: 'noopener noreferrer', dataset: own ? { internal: '1' } : {} }, label);
}

function mention(m, ctx) {
  // "@sam." should still find sam: peel trailing dots until a username matches.
  let name = m[1];
  while (name.length >= 2) {
    const u = userByName(name);
    if (u) {
      m.used = name.length + 1;
      const el = h('span.mention', { class: u.id === state.me?.id ? 'self' : '', role: 'button', tabIndex: 0 }, '@' + nameOf(u.id, ctx.serverId));
      el.onclick = (e) => { e.stopPropagation(); ctx.onUser?.(u.id, el); };
      return el;
    }
    if (!/[._]$/.test(name)) break;
    name = name.slice(0, -1);
  }
  return null;
}

function channelRef(m, ctx) {
  const ch = ctx.serverId && state.servers.get(ctx.serverId)?.channels.find((c) => c.type === 'text' && c.name === m[1].toLowerCase());
  if (!ch) return null;
  return h('span.mention.channel', { role: 'button', tabIndex: 0, onclick: (e) => { e.stopPropagation(); ctx.onChannel?.(ch.id); } }, '#' + ch.name);
}

function inline(src, ctx) {
  const out = [];
  let buf = '', i = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  outer: while (i < src.length) {
    const rest = src.slice(i);
    const c = rest[0];
    if ('\\`|*_~[h@#'.includes(c)) {
      const prev = i ? src[i - 1] : ' ';
      for (const [re, make, mode] of RULES) {
        if (mode === 'word' && /[\p{L}\p{N}]/u.test(prev)) continue;
        const m = re.exec(rest);
        if (!m) continue;
        const node = make(m, ctx);
        if (node == null) continue;
        flush();
        out.push(node);
        i += m.used || m[0].length;
        continue outer;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// Links worth previewing under a message.
export function extractEmbeds(text) {
  const out = [];
  const seen = new Set();
  for (const m of text.replace(/```[\s\S]*?```|`[^`\n]+`/g, '').matchAll(/https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    let u; try { u = new URL(url); } catch { continue; }
    if (/\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname)) out.push({ kind: 'image', url });
    else if (/\.(mp4|webm)$/i.test(u.pathname)) out.push({ kind: 'video', url });
    else {
      const yt = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url);
      if (yt) out.push({ kind: 'youtube', id: yt[1], url });
    }
    if (out.length >= 3) break;
  }
  return out;
}
