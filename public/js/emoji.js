// Emoji data, the picker, and :shortcode: lookup.
import { h, clear, state, savePrefs } from './core.js';
import { popover } from './ui.js';

const RAW = {
  'Smileys': '😀 grinning|😃 smiley|😄 smile|😁 grin|😆 laughing|😅 sweat_smile|🤣 rofl|😂 joy|🙂 slight_smile|🙃 upside_down|🫠 melting|😉 wink|😊 blush|😇 innocent|🥰 smiling_hearts|😍 heart_eyes|🤩 star_struck|😘 kissing_heart|😋 yum|😛 tongue|😜 wink_tongue|🤪 zany|🤨 raised_eyebrow|🧐 monocle|🤓 nerd|😎 sunglasses cool|🥳 partying|😏 smirk|😒 unamused|😞 disappointed|😔 pensive|😟 worried|😕 confused|🙁 frowning|😣 persevere|😖 confounded|😫 tired|😩 weary|🥺 pleading|😢 cry|😭 sob|😤 triumph|😠 angry|😡 rage|🤬 cursing|🤯 exploding_head mind_blown|😳 flushed|🥵 hot|🥶 cold|😱 scream|😨 fearful|😰 anxious|😥 sad_relieved|😓 sweat|🤗 hugging|🤔 thinking|🫡 salute|🤭 hand_over_mouth|🫣 peeking|🤫 shushing|🤥 lying|😶 no_mouth|😐 neutral|😑 expressionless|😬 grimacing|🙄 eye_roll|😯 hushed|😮 open_mouth|😲 astonished|🥱 yawning|😴 sleeping|🤤 drooling|😵 dizzy|🤐 zipper_mouth|🥴 woozy|🤢 nauseated|🤮 vomiting|🤧 sneezing|😷 mask|🤒 sick|🥲 smiling_tear|🤠 cowboy|🤡 clown|😈 imp|💩 poop|👻 ghost|💀 skull|👽 alien|🤖 robot|😺 smiley_cat',
  'People': '👍 thumbsup +1 yes|👎 thumbsdown -1 no|👏 clap|🙌 raised_hands|🙏 pray thanks|🤝 handshake|👋 wave hello|✌️ peace v|🤞 fingers_crossed|🤟 love_you|🤘 metal|👌 ok_hand|🤌 pinched|👈 point_left|👉 point_right|👆 point_up|👇 point_down|✋ raised_hand|💪 muscle strong|🫶 heart_hands|✍️ writing|👀 eyes|🧠 brain|🫂 hug|🙈 see_no_evil|🙉 hear_no_evil|🙊 speak_no_evil|💃 dancer|🕺 man_dancing|🤷 shrug|🤦 facepalm|🙋 raising_hand',
  'Symbols': '❤️ heart love|🧡 orange_heart|💛 yellow_heart|💚 green_heart|💙 blue_heart|💜 purple_heart|🖤 black_heart|🤍 white_heart|💔 broken_heart|💕 two_hearts|💖 sparkling_heart|💯 100|✨ sparkles|🔥 fire lit|⭐ star|🌟 glowing_star|💫 dizzy_star|💥 boom|💢 anger|💤 zzz|💬 speech|✅ check done|❌ x cross|❓ question|❗ exclamation|⚠️ warning|🚫 no_entry|➕ plus|➖ minus|🔴 red_circle|🟢 green_circle|🔵 blue_circle|🟡 yellow_circle|🆗 ok|🆒 cool_button|🔝 top',
  'Nature': '🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦉 owl|🐺 wolf|🐴 horse|🦄 unicorn|🐝 bee|🦋 butterfly|🐢 turtle|🐍 snake|🐙 octopus|🦀 crab|🐬 dolphin|🐳 whale|🦈 shark|🌵 cactus|🌲 evergreen|🌴 palm|🍀 clover luck|🌸 blossom|🌹 rose|🌻 sunflower|🌈 rainbow|☀️ sun|🌙 moon|⚡ zap|❄️ snowflake|🌊 ocean|🌍 earth',
  'Food': '🍎 apple|🍌 banana|🍓 strawberry|🍉 watermelon|🍇 grapes|🍑 peach|🍍 pineapple|🥑 avocado|🌶️ hot_pepper|🌽 corn|🍞 bread|🧀 cheese|🍳 cooking egg|🥓 bacon|🍔 burger|🍟 fries|🍕 pizza|🌭 hotdog|🌮 taco|🌯 burrito|🍜 ramen|🍣 sushi|🍩 donut|🍪 cookie|🎂 birthday cake|🍰 shortcake|🍫 chocolate|🍿 popcorn|🍦 icecream|☕ coffee|🍵 tea|🧋 boba|🍺 beer|🍻 cheers|🥂 clinking_glasses|🍷 wine|🧃 juice',
  'Activities': '⚽ soccer|🏀 basketball|🏈 football|⚾ baseball|🎾 tennis|🏐 volleyball|🎱 8ball|🏓 ping_pong|🥊 boxing|🏆 trophy win|🥇 first_place|🎮 video_game controller|🕹️ joystick|🎲 dice|🧩 puzzle|🎯 dart bullseye|🎨 art|🎬 clapper|🎤 microphone|🎧 headphones|🎸 guitar|🎹 piano|🥁 drum|🎉 tada party|🎊 confetti|🎁 gift|🎈 balloon',
  'Objects': '🚀 rocket ship|✈️ airplane|🚗 car|🚲 bike|⛵ sailboat|⚓ anchor|🏠 house|🏝️ island|⛰️ mountain|💡 bulb idea|💻 laptop computer|🖥️ desktop|⌨️ keyboard|📱 phone|📷 camera|🔒 lock|🔑 key|🔨 hammer|🛠️ tools|⚙️ gear|🧪 test_tube|📌 pushpin|📎 paperclip|✏️ pencil|📝 memo|📚 books|📅 calendar|📈 chart_up|📉 chart_down|💰 money_bag|💸 money_wings|💎 gem|🔔 bell|📣 megaphone|⏰ alarm|⏳ hourglass|🚩 red_flag|🏁 checkered_flag|🏴‍☠️ pirate_flag',
};

export const CATEGORIES = Object.entries(RAW).map(([name, raw]) => ({
  name, items: raw.split('|').map((s) => { const [char, ...names] = s.split(' '); return { char, names }; }),
}));
export const ALL = CATEGORIES.flatMap((c) => c.items);
export const BY_NAME = new Map(ALL.flatMap((e) => e.names.map((n) => [n, e.char])));
export const QUICK = ['👍', '❤️', '😂', '🎉', '👀'];

export const searchEmoji = (q, limit = 60) => {
  q = q.toLowerCase();
  const starts = [], contains = [];
  for (const e of ALL) {
    if (e.names.some((n) => n.startsWith(q))) starts.push(e); else if (e.names.some((n) => n.includes(q))) contains.push(e);
  }
  return [...starts, ...contains].slice(0, limit);
};

export function rememberEmoji(char) {
  state.prefs.recentEmoji = [char, ...state.prefs.recentEmoji.filter((c) => c !== char)].slice(0, 16);
  savePrefs();
}
// Replace :shortcode: with the emoji it names.
export const expandShortcodes = (text) => text.replace(/:([a-z0-9_+-]{2,32}):/g, (m, n) => BY_NAME.get(n) || m);

export function emojiPicker(anchor, onPick, { side = 'top', align = 'end', keepOpen = false } = {}) {
  const grid = h('div.emoji-grid');
  const search = h('input.input', { placeholder: 'Search emoji', autofocus: true });
  const cell = (e) => h('button.emoji-cell', { type: 'button', title: ':' + e.names[0] + ':', onclick: () => { rememberEmoji(e.char); onPick(e.char); if (!keepOpen) pop.close(); } }, e.char);
  const section = (name, items) => items.length ? [h('div.emoji-heading', { dataset: { cat: name } }, name), h('div.emoji-row', items.map(cell))] : [];
  const draw = () => {
    const q = search.value.trim();
    if (q) {
      const found = searchEmoji(q, 120);
      clear(grid, ...(found.length ? section('Results', found) : [h('p.empty-note', `No emoji match “${q}”.`)]));
    } else {
      const recent = state.prefs.recentEmoji.map((c) => ALL.find((e) => e.char === c)).filter(Boolean);
      clear(grid, ...section('Recently used', recent), ...CATEGORIES.flatMap((c) => section(c.name, c.items)));
    }
    grid.scrollTop = 0;
  };
  search.oninput = draw;
  search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); grid.querySelector('.emoji-cell')?.click(); } };
  const jump = h('div.emoji-tabs', CATEGORIES.map((c) => h('button', {
    type: 'button', title: c.name,
    onclick: () => { search.value = ''; draw(); grid.querySelector(`[data-cat="${c.name}"]`)?.scrollIntoView({ block: 'start' }); },
  }, c.items[0].char)));
  draw();
  const pop = popover(h('div.emoji-picker', search, jump, grid), { anchor, side, align, cls: 'flush' });
  search.focus();
  return pop;
}
