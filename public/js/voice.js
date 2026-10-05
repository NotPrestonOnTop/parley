// Voice, camera and screen share. Media flows peer to peer (WebRTC mesh); the server only relays signaling.
import { state, rpc } from './core.js';

export const voice = {
  channelId: null,
  muted: false, deaf: false, camera: false, screen: false, noMic: false,
  peers: new Map(), // userId -> { pc, polite, makingOffer, ignoreOffer, audio }
  tiles: new Map(), // key -> { userId, stream, local, kind }
  speaking: new Set(),
  onChange: () => {},
  onSpeaking: () => {},
};

let mic = null, cam = null, scr = null;
let audioCtx = null, meterTimer = null;
const meters = new Map(); // userId -> { analyser, data, source }

const signal = (to, data) => rpc('voice:signal', { to, data }).catch(() => {});
const pushState = () => rpc('voice:state', { muted: voice.muted || !mic, deaf: voice.deaf, video: voice.camera, screen: voice.screen }).catch(() => {});

async function openMic() {
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: state.prefs.micId ? { ideal: state.prefs.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    mic.getAudioTracks()[0].enabled = !voice.muted;
    voice.noMic = false;
    watch(state.me.id, mic);
  } catch {
    mic = null;
    voice.noMic = true; // still joins, listen-only
  }
}

export async function join(channelId) {
  if (voice.channelId === channelId) return;
  if (voice.channelId) await leave();
  if (!window.RTCPeerConnection || !navigator.mediaDevices) throw new Error('This browser cannot do voice. It needs HTTPS and WebRTC.');
  await openMic();
  let res;
  try { res = await rpc('voice:join', { channelId, muted: voice.muted || !mic, deaf: voice.deaf }); }
  catch (e) { stop(mic); mic = null; throw e; }
  voice.channelId = channelId;
  for (const uid of res.peers) { const p = peer(uid); addLocalTracks(p, true); }
  meterTimer = setInterval(sample, 120);
  voice.onChange();
}

export async function leave({ silent = false } = {}) {
  if (!voice.channelId) return;
  voice.channelId = null;
  if (!silent) rpc('voice:leave').catch(() => {});
  for (const uid of [...voice.peers.keys()]) dropPeer(uid);
  for (const s of [mic, cam, scr]) stop(s);
  mic = cam = scr = null;
  voice.camera = voice.screen = false;
  voice.tiles.clear();
  clearInterval(meterTimer);
  for (const uid of [...meters.keys()]) unwatch(uid);
  voice.speaking.clear();
  voice.onChange();
}

function stop(stream) { if (stream) for (const t of stream.getTracks()) t.stop(); }

function peer(uid) {
  let p = voice.peers.get(uid);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: state.ice });
  // "Perfect negotiation": if both sides offer at once, the polite one backs off.
  p = { pc, polite: state.me.id > uid, makingOffer: false, ignoreOffer: false, audio: null };
  voice.peers.set(uid, p);
  pc.onicecandidate = ({ candidate }) => candidate && signal(uid, { candidate });
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); signal(uid, { description: pc.localDescription }); }
    catch (e) { console.warn('voice offer', e); }
    finally { p.makingOffer = false; }
  };
  pc.ontrack = ({ track, streams }) => onTrack(uid, p, track, streams[0] || new MediaStream([track]));
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  return p;
}

function addLocalTracks(p, initiating = false) {
  const sending = new Set(p.pc.getSenders().map((s) => s.track));
  let any = false;
  for (const s of [mic, cam, scr]) {
    if (!s) continue;
    for (const t of s.getTracks()) { any = true; if (!sending.has(t)) p.pc.addTrack(t, s); }
  }
  // With no mic we still need a line to hear the other side.
  if (initiating && !any && !p.pc.getTransceivers().length) p.pc.addTransceiver('audio', { direction: 'recvonly' });
}

function dropPeer(uid) {
  const p = voice.peers.get(uid);
  if (!p) return;
  p.pc.ontrack = p.pc.onnegotiationneeded = p.pc.onicecandidate = null;
  p.pc.close();
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  voice.peers.delete(uid);
  unwatch(uid);
  for (const [k, t] of voice.tiles) if (t.userId === uid && !t.local) voice.tiles.delete(k);
  if (voice.speaking.delete(uid)) voice.onSpeaking(uid, false);
}

export async function onSignal({ from, data }) {
  if (!voice.channelId) return;
  const p = peer(from), pc = p.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        addLocalTracks(p);
        await pc.setLocalDescription();
        signal(from, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
    }
  } catch (e) { console.warn('voice signal', e); }
}

function onTrack(uid, p, track, stream) {
  if (track.kind === 'audio') {
    if (!p.audio) { p.audio = document.body.appendChild(new Audio()); p.audio.autoplay = true; }
    p.audio.srcObject = stream;
    p.audio.muted = voice.deaf;
    p.audio.play().catch(() => {});
    watch(uid, stream);
    return;
  }
  const key = uid + ':' + stream.id;
  const gone = () => { if (voice.tiles.delete(key)) voice.onChange(); };
  voice.tiles.set(key, { userId: uid, stream, local: false });
  stream.onremovetrack = () => { if (!stream.getVideoTracks().length) gone(); };
  track.onended = gone;
  voice.onChange();
}

// The server's roster for our channel changed: drop anyone who left and any video they stopped.
export function syncRoster(users) {
  const here = new Map(users.map((u) => [u.user_id, u]));
  for (const uid of [...voice.peers.keys()]) if (!here.has(uid)) dropPeer(uid);
  let changed = false;
  for (const [k, t] of voice.tiles) {
    const u = here.get(t.userId);
    if (!t.local && u && !u.video && !u.screen) { voice.tiles.delete(k); changed = true; }
  }
  if (changed) voice.onChange();
}

export function setMuted(on) {
  voice.muted = on;
  if (!on) voice.deaf = false;
  if (mic) mic.getAudioTracks()[0].enabled = !on;
  for (const p of voice.peers.values()) if (p.audio) p.audio.muted = voice.deaf;
  if (!on && !mic && voice.channelId) {
    // First unmute after a blocked mic: ask again, then start sending.
    openMic().then(() => { for (const p of voice.peers.values()) addLocalTracks(p); pushState(); voice.onChange(); });
  }
  if (voice.channelId) pushState();
  voice.onChange();
}
export function setDeaf(on) {
  voice.deaf = on;
  if (on) voice.muted = true;
  if (mic) mic.getAudioTracks()[0].enabled = !voice.muted;
  for (const p of voice.peers.values()) if (p.audio) p.audio.muted = on;
  if (voice.channelId) pushState();
  voice.onChange();
}

function unpublish(stream) {
  for (const t of stream.getTracks()) {
    t.stop();
    for (const p of voice.peers.values()) { const s = p.pc.getSenders().find((x) => x.track === t); if (s) p.pc.removeTrack(s); }
  }
}
export async function toggleCamera() {
  if (!voice.channelId) return;
  if (cam) { unpublish(cam); cam = null; voice.tiles.delete('me:cam'); }
  else {
    cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    voice.tiles.set('me:cam', { userId: state.me.id, stream: cam, local: true, mirror: true });
    for (const p of voice.peers.values()) addLocalTracks(p);
  }
  voice.camera = !!cam;
  pushState(); voice.onChange();
}
export async function toggleScreen() {
  if (!voice.channelId) return;
  if (scr) { unpublish(scr); scr = null; voice.tiles.delete('me:screen'); }
  else {
    scr = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    scr.getVideoTracks()[0].onended = () => { if (scr) toggleScreen(); };
    voice.tiles.set('me:screen', { userId: state.me.id, stream: scr, local: true });
    for (const p of voice.peers.values()) addLocalTracks(p);
  }
  voice.screen = !!scr;
  pushState(); voice.onChange();
}

/* ---- who is talking: a small level meter per stream */

function watch(uid, stream) {
  try {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    unwatch(uid);
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    meters.set(uid, { analyser, source, data: new Uint8Array(analyser.fftSize), hold: 0 });
  } catch { /* meters are cosmetic */ }
}
function unwatch(uid) { const m = meters.get(uid); if (m) { m.source.disconnect(); meters.delete(uid); } }
function sample() {
  for (const [uid, m] of meters) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) sum += (v - 128) ** 2;
    const loud = Math.sqrt(sum / m.data.length) / 128 > 0.02;
    m.hold = loud ? 4 : Math.max(0, m.hold - 1); // linger briefly so the ring does not flicker
    const on = m.hold > 0, was = voice.speaking.has(uid);
    if (on !== was) { on ? voice.speaking.add(uid) : voice.speaking.delete(uid); voice.onSpeaking(uid, on); }
  }
}
