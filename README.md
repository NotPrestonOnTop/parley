# Parley

A self-hosted chat app in the style of Discord: servers, channels, direct messages, friends, roles, voice, video and screen share. One Node process, one SQLite file, no build step.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000 and create an account. **The first account you create is the instance admin** and owns the starter server, "The Harbor". Everyone who signs up after that joins it automatically.

Needs Node 22.13 or newer (it uses Node's built-in SQLite).

## Deploy to Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a new project and choose **Deploy from GitHub repo**. Railway builds it from the included `Dockerfile`; there is nothing to configure.
3. Add a **Volume** to the service (any mount path, for example `/data`). Parley finds it on its own. Without a volume the app still runs, but accounts, messages and uploads are wiped on every redeploy.
4. Under the service's networking settings, generate a public domain. Open it and sign up first so you become the admin.

Prefer the CLI? From this folder: `railway init`, then `railway up`.

Voice and camera need HTTPS, which the Railway domain provides.

## Settings

All optional, set as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. Railway sets this for you. |
| `DATA_DIR` | the Railway volume, else `./data` | Where the database and uploads live. |
| `MAX_UPLOAD_MB` | `25` | Largest file someone can attach. |
| `ICE_SERVERS` | Google's public STUN servers | JSON list of WebRTC ICE servers. Add a TURN server here if voice fails to connect for people on strict networks. |

Example: `ICE_SERVERS=[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`

## What is in it

- **Servers** with text channels, voice channels and categories; invite links; server icons
- **Messages** with markdown, code blocks, spoilers, replies, edits, reactions, pins, mentions (`@name`, `@everyone`), file and image uploads (paste, drag and drop), link and video previews, search, typing indicators, unread markers and mention badges
- **Direct messages** and group chats (up to 10 people), with voice calls
- **Friends**: requests, online list, one-click message or call
- **Voice**: join a voice channel to talk; turn on your camera or share your screen; mute, deafen, speaking rings
- **Roles and moderation**: colored roles with permissions and a hierarchy, nicknames, timeouts, kicks, bans (optionally deleting the person's messages), audit log, ownership transfer
- **Instance admin**: usage numbers, suspend or delete accounts, grant admin, join or delete any server
- **Profiles and presence**: avatars, bios, banner color, online / idle / do not disturb / invisible, custom status
- **Extras**: three themes, compact mode, desktop notifications, emoji picker with `:shortcodes:`, slash commands (`/shrug`, `/me`, `/spoiler`, `/nick`), quick switcher (Ctrl or Cmd + K), mobile layout

## How it is put together

```
server.js          Express (sign-in, uploads, static files) + Socket.IO (everything realtime) + SQLite
public/index.html  the page
public/css/app.css styles and themes
public/js/app.js       sign-in, navigation, sidebars, members, friends, voice controls
public/js/chat.js      message list and composer
public/js/settings.js  account settings, server admin, instance admin, dialogs
public/js/voice.js     WebRTC voice, camera and screen share
public/js/markdown.js  message formatting
public/js/emoji.js     emoji data and picker
public/js/ui.js, core.js  shared pieces
```

Voice and video go directly between the people in a call (a WebRTC mesh), so the server only passes along connection details. That works well for small rooms; past eight or so people in one call it will strain everyone's upload.

## Known limits

This was built for fun and for friends, not hardened for strangers. Passwords are hashed, but there is no rate limiting, email verification, password reset or per-channel permissions, and everyone on the instance can see the list of accounts. Put it behind something stricter before opening it to the public.
