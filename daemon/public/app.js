// Handfree web client: the dashboard (every Claude session at a glance), the chat
// view, mic in (on-device VAD), Claude's voice out (streamed sentence by sentence),
// approvals, and Halo (hand gestures from the camera, see halo.js).
'use strict'

const $ = id => document.getElementById(id)
const log = $('log')
const els = { state: $('state'), mic: $('mic'), hint: $('hint'), input: $('input'), bargeIn: $('bargeIn'), alerts: $('alerts'), mute: $('mute') }

// --- connection -------------------------------------------------------------------

let ws = null
let replaying = false
let online = false

let retries = 0, retryTimer = 0, retryTick = 0

function connect() {
  clearTimeout(retryTimer)
  clearInterval(retryTick)
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => send({ t: 'hello', token: window.HANDFREE_TOKEN, client: 'web' })
  ws.onmessage = ev => onMessage(JSON.parse(ev.data))
  ws.onclose = ev => {
    // 4003: the daemon restarted with a new page token. Fetch the page again
    // (not in a tight loop if something else is wrong)
    if (ev.code === 4003 && performance.now() > 10_000) return setTimeout(() => location.reload(), 1500)
    online = false
    hearingNow = false
    $('offline').hidden = false
    setState('offline', ev.code === 4003 ? 'reload the page' : 'reconnecting')
    player.stop()
    // back off (1.5 s, 3 s, … up to 10 s), counting down on the banner
    retries++
    const wait = Math.min(10_000, 1500 * 2 ** Math.min(retries - 1, 3))
    const at = Date.now() + wait
    const show = () => { $('offRetry').textContent = `Trying again in ${Math.max(1, Math.ceil((at - Date.now()) / 1000))} s…` }
    show()
    retryTick = setInterval(show, 500)
    $('offHelp').hidden = retries < 3
    retryTimer = setTimeout(connect, wait)
  }
}
$('offTry').onclick = () => { $('offRetry').textContent = 'Connecting…'; try { ws?.close() } catch {} ; connect() }

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// --- playback: queued sentences, ducking, pause/resume for barge-in ---------------

const player = {
  ctx: null,
  gain: null, // ducking
  volume: null, // mute: everything else plays on as usual, at 0
  muted: false,
  sources: [], // { src, start, end, sayId, seq }
  nextTime: 0,
  cancelled: new Set(),
  playing: false,

  ensure() {
    if (this.ctx) return
    this.ctx = new AudioContext()
    this.gain = this.ctx.createGain()
    this.volume = this.ctx.createGain()
    this.volume.gain.value = this.muted ? 0 : 1
    this.gain.connect(this.volume).connect(this.ctx.destination)
  },

  setMuted(on) {
    this.muted = on
    if (this.volume) this.volume.gain.value = on ? 0 : 1
  },

  enqueue({ say_id, seq, rate, pcm16 }) {
    if (this.cancelled.has(say_id) || !this.ctx) return
    const samples = pcm16ToFloat(pcm16)
    const buf = this.ctx.createBuffer(1, samples.length, rate)
    buf.copyToChannel(samples, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.gain)
    const start = Math.max(this.ctx.currentTime + 0.03, this.nextTime)
    src.start(start)
    this.nextTime = start + buf.duration
    const entry = { src, start, end: this.nextTime, sayId: say_id, seq }
    this.sources.push(entry)
    // tell the daemon which sentence you're hearing, so a barge-in knows where you cut in
    entry.posTimer = setTimeout(() => send({ t: 'pos', say_id, seq }), Math.max(0, (start - this.ctx.currentTime) * 1000))
    src.onended = () => {
      this.sources = this.sources.filter(s => s !== entry)
      if (!this.sources.length) {
        this.setPlaying(false)
        if (chimeAfterSpeech) { chimeAfterSpeech = false; chime('done') }
      }
    }
    this.setPlaying(true)
  },

  setPlaying(on) {
    if (on === this.playing) return
    this.playing = on
    send({ t: 'playing', playing: on })
    scheduleRender()
  },

  /** Which sentence is audible right now (for "interrupted after ..."). */
  position() {
    if (!this.ctx || !this.sources.length) return null
    const now = this.ctx.currentTime
    const s = this.sources.find(x => x.start <= now && now < x.end) ?? this.sources[0]
    return { say_id: s.sayId, seq: s.seq }
  },

  duck() { this.gain?.gain.setTargetAtTime(0.15, this.ctx.currentTime, 0.03) },
  unduck() { this.gain?.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05) },
  pause() { this.ctx?.suspend() },
  resume() { this.unduck(); this.ctx?.resume() },

  stop() {
    for (const s of this.sources) { s.src.onended = null; clearTimeout(s.posTimer); try { s.src.stop() } catch {} }
    for (const s of this.sources) this.cancelled.add(s.sayId)
    this.sources = []
    this.nextTime = 0
    chimeAfterSpeech = false
    if (this.ctx) { this.gain.gain.cancelScheduledValues(0); this.gain.gain.value = 1; this.ctx.resume() }
    this.setPlaying(false)
  },
}

/** A short up-sweep ("got it", "listening"), or down (the wake window closed). */
function earcon(down = false) {
  const ctx = player.ctx
  if (!ctx || ctx.state !== 'running') return
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.frequency.setValueAtTime(down ? 880 : 660, ctx.currentTime)
  o.frequency.exponentialRampToValueAtTime(down ? 550 : 990, ctx.currentTime + 0.08)
  g.gain.setValueAtTime(0.0001, ctx.currentTime)
  g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12)
  o.connect(g).connect(ctx.destination)
  o.start(); o.stop(ctx.currentTime + 0.13)
}

// --- mic: streamed to the daemon, which finds your turns -------------------------------
// The daemon runs voice detection plus a turn model that hears whether you've
// finished your thought, the same for this page and the phone app.

let mic = null // { stream, ctx }
let micOn = false
let pauseMs = 1200 // from the daemon's config (only used without the turn model)

// your last few turns as the recognizer got them, so you can hear what it heard.
// Browser memory only: gone on reload, never stored or sent anywhere else.
const clips = new Map()
function keepClip(id, audio) {
  clips.set(id, audio)
  while (clips.size > 10) clips.delete(clips.keys().next().value)
}

async function playClip(id, btn) {
  const audio = clips.get(id)
  if (!audio) return
  player.ensure()
  const buf = player.ctx.createBuffer(1, audio.length, 16000)
  buf.copyToChannel(audio, 0)
  const src = player.ctx.createBufferSource()
  src.buffer = buf
  src.connect(player.ctx.destination)
  // the mic would hear your own voice and send it to Claude again
  const listening = micOn
  if (listening) mic.ctx.suspend()
  btn.disabled = true
  src.onended = () => {
    btn.disabled = false
    if (listening && micOn) mic.ctx.resume()
  }
  src.start()
}

function streamOn(on) {
  send({ t: 'stream', on, barge_in: els.bargeIn.checked, clips: true })
}

/** Open the mic once; frames go to the daemon while listening, or into the
 *  push-to-talk buffer while space is held. */
async function openMic() {
  player.ensure()
  // (not resuming the player here: push-to-talk may have just paused Claude's voice)
  if (!mic) {
    hint('Starting the mic…')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule('/mic-worklet.js')
    const node = new AudioWorkletNode(ctx, 'mic-stream')
    node.port.onmessage = ev => {
      if (ptt) ptt.frames.push(new Int16Array(ev.data))
      else if (micOn && ws?.readyState === WebSocket.OPEN) ws.send(ev.data)
    }
    const source = ctx.createMediaStreamSource(stream)
    source.connect(node)
    // keep the graph referenced and pulled: while the context is suspended between
    // push-to-talk presses, Chrome otherwise garbage-collects the unreferenced
    // nodes and the mic goes silent until the page reloads
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(ctx.destination)
    mic = { stream, ctx, source, node, mute }
  }
  await mic.ctx.resume()
}

async function startMic() {
  // ask for notifications from the mic button only: a permission bubble opened
  // during push-to-talk takes the keyboard focus, and space stops reaching the page
  if (alertsOn()) askNotifyPermission()
  player.ensure()
  await player.ctx.resume()
  await openMic()
  micOn = true
  streamOn(true)
  els.mic.classList.remove('off')
  els.mic.title = 'Pause listening'
  els.mic.setAttribute('aria-label', 'Pause listening')
  hint('Listening for you. Just talk.')
  scheduleRender()
}

async function stopMic() {
  micOn = false
  streamOn(false)
  await mic?.ctx.suspend()
  els.mic.classList.remove('hearing')
  els.mic.classList.add('off')
  els.mic.title = 'Start listening'
  els.mic.setAttribute('aria-label', 'Start listening')
  hint('Paused. Tap the mic to listen again, or hold space to talk.')
  scheduleRender()
}

function toggleMic() {
  if (speechStatus === 'off') return startVoice()
  if (speechStatus === 'loading') return hint('Starting voice… about 4 seconds.')
  return micOn ? stopMic() : startMic().catch(micFailed)
}
els.mic.onclick = toggleMic
els.bargeIn.onchange = () => { if (micOn) streamOn(true) }

// --- voice on / off: the Mac loads the speech models (~4 GB) only when asked ----------
// One tap turns voice on for every device; it turns itself off after a quiet spell.

let speechStatus = 'off'
const VOICE_BTN = { off: 'Start voice', loading: 'Starting voice…', on: 'Stop voice' }

function setSpeech(status) {
  const was = speechStatus
  speechStatus = status
  const btn = $('voiceBtn')
  btn.textContent = VOICE_BTN[status] ?? status
  btn.disabled = status === 'loading'
  btn.title = status === 'on' ? 'Unload the speech models on the Mac, for every device' : 'Load the speech models on the Mac (about 4 s), for every device'
  if (status === 'off') {
    const offHint = () => hint('Voice is off on the Mac. Tap Start voice (about 4 s), or type.')
    if (micOn) stopMic().then(offHint); else offHint()
  } else if (status === 'loading') hint('Starting voice… about 4 seconds.')
  else if (was !== 'on') hint('Voice is on. Tap the mic to talk hands-free, or hold space to talk.')
  if (status === 'on' && micAfterVoice && !micOn) startMic().catch(micFailed)
  if (status !== 'loading') micAfterVoice = false
  scheduleRender()
}

let micAfterVoice = false // Halo's mic gesture asked while voice was off: turn the mic on once it's ready

function startVoice() {
  send({ t: 'speech', on: true })
  hint('Starting voice… about 4 seconds.')
}

$('voiceBtn').onclick = () => (speechStatus === 'off' ? startVoice() : send({ t: 'speech', on: false }))

// --- push to talk: hold space, talk, let go to send ---------------------------------
// Works with the mic paused or listening. Your words go as one turn the moment you
// let go: no pause detection, no waiting for more. Halo's fist does the same.

let ptt = null // { frames, during } while space is held

const typing = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)
const dialogOpen = () => [...document.querySelectorAll('dialog')].some(d => d.open)

async function pttDown() {
  if (speechStatus !== 'on') { hint(speechStatus === 'off' ? 'Voice is off. Tap Start voice first, or type.' : 'Starting voice… about 4 seconds.'); return false }
  ptt = { frames: [], during: null }
  if (micOn) streamOn(false) // the daemon's pause detection sits this one out
  if (player.playing) { ptt.during = player.position(); player.pause() } // you want the floor
  els.mic.classList.add('hearing')
  hint('Recording… let go to send.')
  scheduleRender()
  try { await openMic() } catch (err) { ptt = null; els.mic.classList.remove('hearing'); micFailed(err); scheduleRender(); return false }
  return true
}

function pttUp() {
  const p = ptt
  ptt = null
  if (!p) return
  scheduleRender()
  els.mic.classList.remove('hearing')
  if (micOn) { streamOn(true); mic.ctx.resume() } else mic?.ctx.suspend()
  const n = p.frames.reduce((a, f) => a + f.length, 0)
  if (n < 16000 * 0.3) { // a tap, not a turn
    if (p.during) player.resume()
    return hint(micOn ? 'Listening for you. Just talk.' : 'Hold space to talk, or tap the mic.')
  }
  const pcm = new Int16Array(n)
  let at = 0
  for (const f of p.frames) { pcm.set(f, at); at += f.length }
  const clip = `p${Date.now()}`
  keepClip(clip, Float32Array.from(pcm, v => v / 32768))
  earcon()
  send({ t: 'utterance', pcm16: int16ToB64(pcm), during: p.during, clip, ptt: true })
  hint('Got it…')
}

function int16ToB64(i16) {
  const bytes = new Uint8Array(i16.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && view === 'chat' && !dialogOpen() && !typing(ev.target)) return setView('home')
  if (ev.code !== 'Space' || typing(ev.target) || dialogOpen()) return
  ev.preventDefault() // no page scroll, no "click" on a focused button
  if (!ev.repeat && !ptt) pttDown()
})
document.addEventListener('keyup', ev => {
  if (ev.code !== 'Space' || !ptt) return
  ev.preventDefault()
  pttUp()
})
window.addEventListener('blur', () => { if (ptt) pttUp() }) // let go outside the window

// --- audio helpers -------------------------------------------------------------------

function pcm16ToFloat(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const i16 = new Int16Array(bytes.buffer)
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
  return f32
}

// --- small DOM helpers ----------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function button(cls, text, onclick, title) {
  const b = el('button', cls, text)
  b.type = 'button'
  if (onclick) b.onclick = onclick
  if (title) b.title = title
  return b
}

function svg(markup) {
  const t = document.createElement('template')
  t.innerHTML = markup.trim()
  return t.content.firstChild
}

const ROBOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5v2.5"/><rect x="4.5" y="5" width="15" height="11.5" rx="3"/><g class="eyes"><circle cx="9.5" cy="10.5" r="1.3"/><circle cx="14.5" cy="10.5" r="1.3"/></g><path d="M9.5 13.5h5M8 20h8M12 16.5V20M2.5 9.5v3M21.5 9.5v3"/></svg>'
const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>'

/** The robot for a session, animated by its state. */
function avatar(kind) {
  const a = el('span', `av s-${kind}`)
  a.style.setProperty('--c', KIND[kind].color)
  a.append(svg(ROBOT), el('i', 'arc'), el('i', 'rip'))
  const b = el('b', 'bdg')
  if (kind === 'needs') b.append(svg(LOCK))
  else if (kind === 'ask') b.textContent = '?'
  else if (kind === 'done') b.append(svg(CHECK))
  else if (kind === 'speaking') { const bars = el('span', 'bars'); bars.append(el('i'), el('i'), el('i'), el('i')); b.append(bars) }
  a.append(b)
  return a
}

function fmtSecs(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const h = Math.floor(s / 3600)
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`
}

/** Text that counts up every second (see the ticker below). */
function since(ms, prefix = '', suffix = '') {
  const s = el('span', 'js-since')
  s.dataset.since = String(ms)
  s.dataset.prefix = prefix
  s.dataset.suffix = suffix
  s.textContent = prefix + fmtSecs(Date.now() - ms) + suffix
  return s
}
setInterval(() => {
  for (const s of document.querySelectorAll('.js-since')) s.textContent = s.dataset.prefix + fmtSecs(Date.now() - Number(s.dataset.since)) + s.dataset.suffix
}, 1000)

function add(node) {
  // follow new messages only when you're at the bottom: reading further up, they wait behind ⬇ Latest
  const stick = atBottom()
  log.appendChild(node)
  if (!replaying && stick) log.scrollTo({ top: log.scrollHeight })
  updateLatest()
}

// --- ⬇ Latest: back to the newest message, with how many arrived while you read above ---

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80
let readUpTo = null // the last message on screen when you were last at the bottom
function updateLatest() {
  const b = $('latestBtn')
  if (atBottom()) { readUpTo = log.lastChild; b.hidden = true; return }
  let n = 0
  for (let x = readUpTo ? readUpTo.nextSibling : null; x; x = x.nextSibling) if (!x.hidden && x.dataset.session) n++
  b.textContent = n ? `⬇ Latest · ${n} new` : '⬇ Latest'
  b.hidden = false
}
log.addEventListener('scroll', updateLatest, { passive: true })
$('latestBtn').onclick = () => log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' })

function hint(text) { els.hint.textContent = text }

let globalState = 'offline'
const STATE_TEXT = { starting: 'starting voices…', idle: 'ready', transcribing: 'hearing you', working: 'Claude is working', speaking: 'speaking', approval: 'needs approval', offline: 'offline' }
function setState(state, extra) {
  globalState = state
  els.state.className = `conn ${state}`
  els.state.textContent = extra ?? STATE_TEXT[state] ?? state
  scheduleRender()
}

function setMode(mode) {
  $('modeTap').classList.toggle('on', mode === 'tap')
  $('modePass').classList.toggle('on', mode === 'passphrase')
}

// --- the dashboard model: sessions, their state, what needs you -------------------------

let sessionList = []
let activeSession = null // the daemon's active session: voice and typing go there
let projects = []
const activity = new Map() // session key -> { busy, since, steps }
const info = new Map() // session key -> { userAt, replyAt, reply, showAt, show }
const perms = new Map() // request_id -> { req, resolved }
let lastSpeakKey = null

const KIND = {
  needs: { color: 'var(--warn)', group: 'needs', order: 0 },
  ask: { color: 'var(--warn)', group: 'needs', order: 1 },
  working: { color: 'var(--accent)', group: 'working', order: 2 },
  speaking: { color: 'var(--accent)', group: 'working', order: 3 },
  done: { color: 'var(--accent)', group: 'idle', order: 4 },
  idle: { color: 'var(--idle)', group: 'idle', order: 5 },
}

const infoOf = key => { let i = info.get(key); if (!i) info.set(key, i = {}); return i }

/** Remember what each session said and asked, for its status. */
function track(m) {
  const key = m.session_key
  if (!key) return
  const at = m.at ?? Date.now()
  const i = infoOf(key)
  if (m.t === 'user') i.userAt = at
  else if (m.t === 'reply') { i.replyAt = at; i.reply = m.speak; lastSpeakKey = key }
  else if (m.t === 'show') { i.showAt = at; i.show = m.markdown }
}

const pendingFor = key => [...perms.values()].filter(p => !p.resolved && p.req.sessionKey === key).map(p => p.req)
const helpersOf = a => (a?.steps ?? []).filter(s => !s.endedAt && /^Agent:/.test(s.label)).map(s => ({ label: s.label.replace(/^Agent:\s*/, ''), since: s.startedAt }))

/** What a session is doing: needs you, asked you, working, speaking, done or idle. */
function statusOf(s) {
  const a = activity.get(s.key)
  const i = info.get(s.key) ?? {}
  const pend = pendingFor(s.key)
  const helpers = helpersOf(a)
  const base = { helpers, pend }
  if (pend.length) return { ...base, kind: 'needs', label: 'Needs your OK', line: `${pend[0].tool_name}: ${pend[0].description}`, since: pend[0].createdAt }
  if (globalState === 'speaking' && lastSpeakKey === s.key) return { ...base, kind: 'speaking', label: 'Speaking', line: i.reply ?? '', since: i.replyAt ?? Date.now() }
  if (a?.busy) {
    const cur = [...a.steps].reverse().find(st => !st.endedAt)
    return { ...base, kind: 'working', label: 'Thinking', line: cur?.label ?? 'Thinking…', since: a.since }
  }
  if ((i.showAt ?? 0) > (i.userAt ?? 0) && /\[!DECIDE\]/i.test(i.show ?? '')) return { ...base, kind: 'ask', label: 'Waiting for your answer', line: i.reply ?? 'Claude asked you something', since: i.showAt }
  const lastEnd = a?.steps?.length ? Math.max(a.since, ...a.steps.map(st => st.endedAt ?? 0)) : 0
  if (lastEnd && Date.now() - lastEnd < 30 * 60_000 && (i.replyAt ?? 0) >= (i.userAt ?? 0)) return { ...base, kind: 'done', label: 'Done · reply ready', line: i.reply ?? 'Finished', since: lastEnd }
  const last = Math.max(i.replyAt ?? 0, i.userAt ?? 0, s.connectedAt ?? 0)
  return { ...base, kind: 'idle', label: 'Idle', line: i.reply ?? 'Waiting for you', since: last || Date.now() }
}

// --- view state ---------------------------------------------------------------------------

let view = 'home' // 'home' | 'chat'
let homeTab = 'agents'
let filter = 'all'
let query = ''
try { homeTab = localStorage.getItem('handfree.tab') === 'list' ? 'list' : 'agents' } catch {}

function setView(v) {
  if (view === 'chat') saveScroll()
  view = v
  $('home').hidden = v !== 'home'
  $('chat').hidden = v !== 'chat'
  sessionFilter()
  if (v === 'chat') requestAnimationFrame(restoreScroll)
  scheduleRender()
}

function setTab(t) {
  homeTab = t
  try { localStorage.setItem('handfree.tab', t) } catch {}
  scheduleRender()
}
$('tabAgents').onclick = () => setTab('agents')
$('tabList').onclick = () => setTab('list')
$('backBtn').onclick = () => setView('home')
$('search').oninput = e => { query = e.target.value.trim().toLowerCase(); scheduleRender() }

function selectSession(key) {
  if (!key) return
  if (key !== activeSession) {
    activeSession = key
    send({ t: 'select_session', key })
  }
  sessionFilter()
  scheduleRender()
}

function openChat(key) {
  selectSession(key)
  setView('chat')
}

const matches = s => !query || [s.label, s.project, s.cwd].some(v => v && v.toLowerCase().includes(query))
const shortPath = p => (p ?? '').replace(/^\/Users\/[^/]+/, '~')
const sessionName = s => (s.project && !s.label.includes(s.project) ? `${s.label} · ${s.project}` : s.label)

/** Sessions with their status, most urgent first. */
function decorated() {
  return sessionList.map(s => ({ s, st: statusOf(s) })).sort((a, b) => KIND[a.st.kind].order - KIND[b.st.kind].order || a.s.label.localeCompare(b.s.label))
}

// --- render: batched to one per frame ---------------------------------------------------

let renderQueued = false
function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => { renderQueued = false; renderAll() })
}

function renderAll() {
  const all = decorated()
  renderTalkTo()
  renderVoiceBar()
  $('voiceBtn').hidden = false
  $('stopSpeaking').disabled = !player.playing && globalState !== 'speaking'
  if (view === 'home') {
    renderChips(all)
    $('tabAgents').classList.toggle('on', homeTab === 'agents')
    $('tabList').classList.toggle('on', homeTab === 'list')
    $('tabAgents').setAttribute('aria-pressed', String(homeTab === 'agents'))
    $('tabList').setAttribute('aria-pressed', String(homeTab === 'list'))
    const shown = all.filter(d => matches(d.s) && (filter === 'all' || KIND[d.st.kind].group === filter))
    $('mapWrap').hidden = homeTab !== 'agents'
    $('list').hidden = homeTab !== 'list'
    if (homeTab === 'agents') renderMap(shown, all.length)
    else renderList(shown)
    renderPanel(all)
  } else renderChat(all)
}

// --- when something is in the way: what happened, and how to fix it ---------------------

function problem(title, body, steps = [], actions = []) {
  $('probTitle').textContent = title
  $('probBody').textContent = body
  $('probSteps').replaceChildren(...steps.map(t => el('li', '', t)))
  $('probSteps').hidden = !steps.length
  $('probActions').replaceChildren(...actions.map(([text, fn, primary]) => button(`btn${primary ? ' primary' : ''}`, text, () => { $('problemDlg').close(); fn?.() })), button('btn', 'Close', () => $('problemDlg').close()))
  if (!$('problemDlg').open) $('problemDlg').showModal()
}
$('probClose').onclick = () => $('problemDlg').close()

const ALLOW_STEPS = what => [
  `Click the icon at the left of the address bar (the lock or sliders), then Site settings, and set ${what} to Allow.`,
  `If it is still blocked: macOS System Settings → Privacy & Security → ${what} → turn your browser on, then restart the browser.`,
]

function micFailed(err) {
  console.error(err)
  const name = err?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return problem('The microphone is blocked', 'Handfree can’t hear you because this page isn’t allowed to use the microphone.', ALLOW_STEPS('Microphone'), [['Try again', () => toggleMic(), true]])
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return problem('No microphone found', 'This Mac has no microphone the browser can use. Plug one in (or connect headphones with a mic), then try again. You can still type, or talk from the phone app.', [], [['Try again', () => toggleMic(), true]])
  hint(`Mic failed: ${err?.message || err}`)
}

function cameraFailed(err) {
  const name = err?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return problem('The camera is blocked', 'Halo needs the camera to see your hand. The picture never leaves this Mac.', ALLOW_STEPS('Camera'), [['Try again', () => window.HandfreeHalo?.start(), true]])
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return problem('No camera found', 'Halo needs a camera on this Mac (built in or USB). Connect one, then try again.', [], [['Try again', () => window.HandfreeHalo?.start(), true]])
  return problem('Halo could not start', String(err?.message || err), [], [['Try again', () => window.HandfreeHalo?.start(), true]])
}

// --- phones: paired, and connected now ------------------------------------------------------

let phones = null // { paired: [names], online: [names] }
let phoneTipHidden = false
try { phoneTipHidden = localStorage.getItem('handfree.phoneTip') === 'hide' } catch {}
function setPhones(p) {
  phones = { paired: [...new Set(p.paired ?? [])], online: [...new Set(p.online ?? [])] } // the same phone can be paired twice
  $('phoneStat').textContent = !phones.paired.length ? 'No phone paired yet' :
    phones.online.length ? `Connected: ${phones.online.join(', ')}` : `Paired: ${phones.paired.join(', ')} (not connected now)`
  scheduleRender()
}
function pairPhone() { $('settingsDlg').close(); $('pairQr').replaceChildren(); $('pairCode').textContent = '…'; $('pairDlg').showModal(); send({ t: 'pair_start' }) }

/** No phone yet: a small card offering to pair one (dismissible). */
function phoneTip() {
  if (!phones || phones.paired.length || phoneTipHidden) return null
  const c = el('div', 'tipcard')
  c.append(el('b', '', '📱 No phone paired yet'), el('span', 'note', 'Talk to your sessions from anywhere in the house with the Handfree app.'))
  const r = el('div', 'row')
  r.append(button('btn primary', 'Pair a phone', pairPhone), button('btn', 'Not now', () => { phoneTipHidden = true; try { localStorage.setItem('handfree.phoneTip', 'hide') } catch {}; scheduleRender() }))
  c.append(r)
  return c
}

// --- the voice bar: one clear state at a time ---------------------------------------------

let hearingNow = false
const VOICE_STATES = {
  offline: ['Handfree offline', 'var(--bad)', 'Can’t reach Handfree on this Mac. Reconnecting…'],
  voiceoff: ['Voice off', 'var(--muted)', 'Tap the mic or Start voice (about 4 s), or type.'],
  loading: ['Starting voice', 'var(--accent)', 'Loading the speech models on the Mac… about 4 seconds.'],
  recording: ['Recording', '#e5484d', 'Let go to send.'],
  hearing: ['Hearing you', 'var(--accent)', 'Go on… it sends when you pause.'],
  speaking: ['Claude is speaking', 'var(--accent)', 'Tap Stop speaking, or just talk, to cut in.'],
  thinking: ['Claude is thinking', 'var(--accent)', 'Working on it. You can add something while it works.'],
  listening: ['Listening', 'var(--accent)', 'Listening for you. Just talk.'],
  paused: ['Mic off', 'var(--muted)', 'Tap the mic to listen, or hold space to talk.'],
}

/** The most important thing the voice bar should say right now. */
function voiceState() {
  if (!online) return 'offline'
  if (speechStatus === 'off') return 'voiceoff'
  if (speechStatus === 'loading') return 'loading'
  if (ptt) return 'recording'
  if (hearingNow && micOn) return 'hearing'
  if (player.playing || globalState === 'speaking') return 'speaking'
  if (globalState === 'working' || activity.get(activeSession)?.busy) return 'thinking'
  return micOn ? 'listening' : 'paused'
}

let lastVs = ''
function renderVoiceBar() {
  const vs = voiceState()
  $('voicebar').dataset.vs = vs
  // yellow: the mic is on, but only "Hey Claude" gets through (Claude talking or working too);
  // green: what you say goes to Claude. Off, push-to-talk and the rest keep their own look
  $('voicebar').dataset.wake = micOn && wake.on && !wake.open && ['listening', 'hearing', 'thinking', 'speaking'].includes(vs) ? 'waiting' : 'open'
  let [text, color, tip] = VOICE_STATES[vs]
  if (vs === 'listening' && wake.on && !wake.open) [text, color, tip] = [`Say “${wake.phrase}”`, 'var(--ready)', `Listening for “${wake.phrase}”. The mic turns green when it hears it.`]
  $('vbText').textContent = text
  $('vbState').style.setProperty('--vc', color)
  $('vbMuted').hidden = !els.mute.checked
  els.mic.disabled = vs === 'offline'
  // a state change replaces a stale hint; live hints (heard words, errors) stay until then
  if (vs !== lastVs && tip) hint(tip)
  lastVs = vs
}

function renderTalkTo() {
  const s = sessionList.find(x => x.key === activeSession)
  const t = $('talkTo')
  t.replaceChildren()
  if (s) t.append('Talking to ', el('b', '', s.label))
  else t.textContent = 'No Claude session'
}

function renderChips(all) {
  const count = g => all.filter(d => KIND[d.st.kind].group === g).length
  const chips = [['all', 'All', all.length, 'var(--muted)', true], ['needs', 'Needs you', count('needs'), 'var(--warn)'], ['working', 'Working', count('working'), 'var(--accent)'], ['idle', 'Idle', count('idle'), 'var(--idle)', true]]
  const box = $('chips')
  box.replaceChildren()
  for (const [id, label, n, color, hollow] of chips) {
    const b = button(`fchip${filter === id ? ' on' : ''}`, null, () => { filter = filter === id && id !== 'all' ? 'all' : id; scheduleRender() })
    b.setAttribute('aria-pressed', String(filter === id))
    const d = el('span', `dot${hollow ? ' hollow' : ''}`)
    d.style.setProperty('--c', color)
    b.append(d, label, el('b', '', String(n)))
    box.append(b)
  }
}

// map: the core in the middle, a robot per session around it
const CX = 410, CY = 280, RX = 270, RY = 200
let mapSig = ''
let placed = [] // {a: angle, n: node, ln: line}, positioned by layoutMap()

/** Put the robots on the ring, pulled in so a whole card always fits inside the map:
 *  cards keep a minimum size, so on a short window the top one would be cut off. */
function layoutMap() {
  const map = $('map')
  const scale = map.clientWidth / 820
  if (!scale || !placed.length) return
  let halfW = 0, halfH = 0
  for (const { n } of placed) { halfW = Math.max(halfW, n.offsetWidth / 2); halfH = Math.max(halfH, n.offsetHeight / 2) }
  const pad = 8 + (map.querySelector('.node.sel') ? 14 : 0) // room for the "Talking to" tag
  // a small map: shrink the cards too (down to 65%), so they don't pile up on the core
  const fit = Math.max(0.65, Math.min(1, (130 * scale - pad) / halfH, (208 * scale - pad) / halfW))
  map.style.setProperty('--fit', fit.toFixed(3))
  halfW *= fit; halfH *= fit
  const rx = Math.max(60, Math.min(RX, CX - (halfW + pad) / scale))
  const ry = Math.max(40, Math.min(RY, CY - (halfH + pad) / scale))
  for (const { a, n, ln } of placed) {
    const x = CX + rx * Math.cos(a), y = CY + ry * Math.sin(a)
    n.style.left = `${(x / 8.2).toFixed(2)}%`
    n.style.top = `${(y / 5.6).toFixed(2)}%`
    const dx = x - CX, dy = y - CY
    ln.style.width = `${(Math.hypot(dx, dy) / 8.2).toFixed(2)}cqw`
    ln.style.transform = `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}deg)`
  }
}
new ResizeObserver(layoutMap).observe($('map'))

/** The pill on whatever your voice and typing go to. */
function talkTag() {
  const t = el('span', 'talk-tag')
  t.append(svg(MIC), 'Talking to')
  return t
}

function renderMap(shown, total) {
  const coreText = speechStatus !== 'on' ? (speechStatus === 'loading' ? 'Starting voice' : 'Voice off') : globalState === 'speaking' ? 'Speaking' : globalState === 'transcribing' ? 'Hearing you' : micOn ? 'Listening' : 'Ready'
  const sig = JSON.stringify([shown.map(d => [d.s.key, d.s.label, d.st.kind, d.st.line, d.st.helpers.length]), activeSession, coreText, total, query, total ? 0 : projects.slice(0, 3).map(p => p.cwd)])
  if (sig === mapSig) return
  mapSig = sig
  const map = $('map')
  map.replaceChildren(el('div', 'ring'))
  let items = shown
  let cluster = []
  if (items.length > 8) { cluster = items.filter(d => d.st.kind === 'idle'); items = items.filter(d => d.st.kind !== 'idle') }
  const slots = items.length + (cluster.length ? 1 : 0)
  const angle = i => (cluster.length ? 90 + (360 * (i + 1)) / slots : -90 + (360 * i) / Math.max(slots, 1)) * Math.PI / 180
  placed = []
  const lines = [], nodes = []
  items.forEach((d, i) => {
    const color = KIND[d.st.kind].color
    const sel = d.s.key === activeSession
    const ln = el('div', `line${d.st.kind === 'working' ? ' flow' : d.st.kind === 'needs' || d.st.kind === 'ask' ? ' soft' : ''}${sel ? ' sel' : ''}`)
    ln.style.setProperty('--c', d.st.kind === 'idle' && !sel ? 'var(--line)' : color)
    lines.push(ln)
    const n = button(`node${sel ? ' sel' : ''}`, null, () => selectSession(d.s.key), 'Click to select, double-click to open the chat')
    n.dataset.key = d.s.key
    n.ondblclick = () => openChat(d.s.key)
    n.style.cssText = `--c:${color};--sc:${d.st.kind === 'needs' || d.st.kind === 'ask' ? 'var(--warn)' : d.st.kind === 'idle' ? 'var(--muted)' : 'var(--accent)'}`
    const st = el('span', 'st', d.st.kind === 'working' ? `${d.st.label}${d.st.helpers.length ? ` · ${d.st.helpers.length} helper${d.st.helpers.length > 1 ? 's' : ''}` : ''}` : d.st.label)
    if (d.st.kind === 'working') { const dots = el('span', 'tdots'); dots.append(el('i'), el('i'), el('i')); st.append(dots) }
    if (sel) n.append(talkTag())
    n.append(avatar(d.st.kind), el('span', 'nm', d.s.label), st)
    nodes.push(n)
    placed.push({ a: angle(i), n, ln })
  })
  if (cluster.length) {
    const ln = el('div', 'line')
    ln.style.setProperty('--c', 'var(--line)')
    lines.push(ln)
    const n = button('node cluster', null, () => { filter = 'idle'; setTab('list') }, 'Show the idle sessions in the list')
    n.append(el('span', 'nm', `${cluster.length} idle`), el('span', 'st', 'Show in list'))
    nodes.push(n)
    placed.push({ a: Math.PI / 2, n, ln })
  }
  const core = el('div', `core${micOn ? ' live' : ''}`)
  const ci = el('i')
  ci.append(svg(MIC))
  core.append(ci)
  const label = el('div', 'core-label')
  label.append(el('b', '', 'Handfree'), el('span', '', coreText))
  map.append(...lines, core, label, ...nodes)
  layoutMap()
  if (!total) {
    const e = el('div', 'empty-card')
    e.append(el('b', '', 'No Claude sessions yet'), el('span', 'note', 'Start one here, from the phone app, or run claude-voice in a terminal.'))
    const recent = projects.slice(0, 3)
    if (recent.length) {
      e.append(el('span', 'note', 'Pick up where you left off:'))
      const r = el('div', 'row')
      for (const pr of recent) r.append(button('btn', `▶ ${pr.name}`, () => { send({ t: 'start_session', cwd: pr.cwd }); hint(`Starting a session in ${pr.name}…`) }, `Start Claude in ${pr.cwd}`))
      e.append(r)
    }
    e.append(button('btn primary', '+ New session', openNewSession))
    map.append(e)
  } else if (!shown.length) {
    const e = el('div', 'empty-card')
    e.append(el('b', '', query ? `No session matches “${query}”` : 'Nothing in this filter'))
    map.append(e)
  }
}

function renderList(shown) {
  const list = $('list')
  list.replaceChildren()
  const groups = { needs: [], working: [], idle: [] }
  for (const d of shown) groups[KIND[d.st.kind].group].push(d)
  if (!shown.length) list.append(el('div', 'empty', sessionList.length ? (query ? `No session matches “${query}”.` : 'Nothing in this filter.') : 'No Claude sessions yet. Start one with + New session.'))
  if (groups.needs.length) {
    const sec = section('Needs you', groups.needs.length, 'var(--warn)')
    const cards = el('div', 'cards')
    for (const d of groups.needs) cards.append(needsCard(d))
    sec.append(cards)
    list.append(sec)
  }
  for (const [g, title, color, hollow] of [['working', 'Working', 'var(--accent)'], ['idle', 'Idle and done', 'var(--idle)', true]]) {
    if (!groups[g].length) continue
    const sec = section(title, groups[g].length, color, hollow)
    const rows = el('div', 'rows')
    for (const d of groups[g]) rows.append(sessionRow(d))
    sec.append(rows)
    list.append(sec)
  }
  // folders where sessions ran before, not running now: start one with a click
  const running = new Set(sessionList.map(s => s.cwd))
  const idleProjects = projects.filter(p => !running.has(p.cwd) && (!query || p.name.toLowerCase().includes(query) || p.cwd.toLowerCase().includes(query)))
  if (idleProjects.length && (filter === 'all' || filter === 'idle')) {
    const sec = section('Not running', idleProjects.length, 'var(--idle)', true)
    const rows = el('div', 'rows')
    for (const p of idleProjects.slice(0, 12)) {
      const r = el('div', 'row-item')
      r.append(el('span', 'nm', p.name), el('span', 'ln', shortPath(p.cwd)), button('btn small', 'Start', () => { send({ t: 'start_session', cwd: p.cwd }); hint(`Starting a session in ${p.name}…`) }, `Start Claude in ${p.cwd}`))
      rows.append(r)
    }
    sec.append(rows)
    list.append(sec)
  }
}

function section(title, n, color, hollow) {
  const sec = el('section', 'sec')
  const h = el('h2')
  const d = el('span', `dot${hollow ? ' hollow' : ''}`)
  d.style.setProperty('--c', color)
  h.append(d, title, el('b', '', String(n)))
  sec.append(h)
  return sec
}

function needsCard(d) {
  const c = el('div', `ncard${d.s.key === activeSession ? ' sel' : ''}`)
  const head = button('head', null, () => selectSession(d.s.key))
  head.ondblclick = () => openChat(d.s.key)
  const txt = el('span')
  txt.style.cssText = 'display:flex;flex-direction:column;min-width:0'
  txt.append(el('b', '', d.s.label), el('span', 'note', d.st.label))
  head.append(avatar(d.st.kind), txt)
  if (d.s.key === activeSession) head.append(talkTag())
  c.append(head)
  if (d.st.kind === 'needs') for (const req of d.st.pend) c.append(permCard(req, true))
  else {
    c.append(el('div', '', d.st.line))
    c.append(button('btn primary', 'Answer in the chat', () => openChat(d.s.key)))
  }
  return c
}

function sessionRow(d) {
  const r = button(`row-item${d.s.key === activeSession ? ' sel' : ''}`, null, () => selectSession(d.s.key), 'Click to select, double-click to open the chat')
  r.ondblclick = () => openChat(d.s.key)
  r.append(avatar(d.st.kind), el('span', 'nm', sessionName(d.s)), el('span', 'ln', d.st.kind === 'working' ? d.st.line : d.st.label))
  if (d.s.key === activeSession) r.append(talkTag())
  if (d.st.helpers.length) r.append(el('span', 'tm', `${d.st.helpers.length} helper${d.st.helpers.length > 1 ? 's' : ''}`))
  const tm = el('span', 'tm')
  tm.append(since(d.st.since))
  r.append(tm)
  return r
}

/** A permission request with Allow / Deny, or a terminal menu with its options. */
function permCard(req, compact) {
  if (req.options) return menuCard(req)
  const c = el('div', 'pcard')
  c.append(el('span', 't', 'Permission request'), el('b', '', req.tool_name), el('span', '', req.description))
  if (req.input_preview && !compact) c.append(el('pre', '', req.input_preview))
  else if (req.input_preview) c.append(el('pre', '', req.input_preview.slice(0, 400)))
  const row = el('div', 'actions')
  row.append(button('btn ink', 'Allow', () => answerPerm(req.request_id, 'allow')), button('btn', 'Deny', () => answerPerm(req.request_id, 'deny')))
  c.append(row)
  return c
}

function answerPerm(id, behavior) {
  send({ t: 'approval', request_id: id, behavior })
}

function menuCard(req) {
  const c = el('div', 'pcard')
  c.append(el('span', 't', 'Asking in the terminal'), el('span', 'menu-q', req.description))
  c.append(menuButtons(req))
  return c
}

/** One button per option, as the terminal lists them. */
function menuButtons(req) {
  const col = el('div', 'menu-opts')
  req.options.forEach((o, i) => {
    const b = button('btn menu-opt', null, () => send({ t: 'menu_answer', request_id: req.request_id, choice: i }))
    b.append(el('b', '', o.label))
    if (o.detail) b.append(el('span', 'note', o.detail))
    col.append(b)
  })
  return col
}

function stepsList(a, max = 6) {
  const ul = el('ul', 'steplist')
  for (const st of (a?.steps ?? []).slice(-max)) {
    const li = el('li', st.endedAt ? (st.ok === false ? 'fail' : 'ok') : 'run')
    const du = el('span', 'du')
    if (st.endedAt) du.textContent = fmtSecs(st.endedAt - st.startedAt)
    else du.append(since(st.startedAt))
    li.append(el('span', 'mk', st.endedAt ? (st.ok === false ? '✗' : '✓') : '•'), el('span', 'lb', st.label), du)
    ul.append(li)
  }
  return ul
}

function renderPanel(all) {
  const p = $('panel')
  p.replaceChildren()
  const d = all.find(x => x.s.key === activeSession) ?? all[0]
  if (!d) {
    p.append(el('h2', '', 'Welcome'), el('p', 'p-sum', 'Every Claude session on this Mac shows up here as a robot. Start one, then talk to it with the mic, hold space, or turn on Halo and use your hand.'),
      button('btn primary', '+ New session', openNewSession))
    const tip = phoneTip()
    if (tip) p.append(tip)
    return
  }
  const { s, st } = d
  const head = el('div', 'p-head')
  const t = el('div')
  t.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0'
  const stl = el('span', 'p-st')
  stl.style.setProperty('--sc', st.kind === 'needs' || st.kind === 'ask' ? 'var(--warn)' : st.kind === 'idle' ? 'var(--muted)' : 'var(--accent)')
  stl.append(`${st.label} · `, since(st.since))
  t.append(stl, el('h2', '', sessionName(s)), el('span', 'p-where', shortPath(s.cwd)))
  head.append(avatar(st.kind), t)
  p.append(head)
  for (const req of st.pend) p.append(permCard(req))
  const sum = st.kind === 'working' ? (infoOf(s.key).reply ?? '') : st.line
  if (sum) p.append(el('p', 'p-sum', sum))
  const a = activity.get(s.key)
  if (a?.steps?.length) {
    const box = el('div')
    box.append(el('div', 'p-label', a.busy ? `Now: ${st.line}` : 'Last steps'), stepsList(a))
    p.append(box)
  }
  if (st.helpers.length) {
    const box = el('div')
    box.append(el('div', 'p-label', 'Helper agents'))
    for (const h of st.helpers) { const r = el('div', 'helper'); r.append(el('span', 'grow', h.label), since(h.since)); box.append(r) }
    p.append(box)
  }
  const acts = el('div', 'actions')
  acts.append(button('btn primary', 'Open chat', () => openChat(s.key)))
  acts.append(button('btn', micOn ? 'Listening…' : 'Talk to it', () => { selectSession(s.key); if (!micOn) toggleMic() }, 'Make this the session your voice goes to, and start listening'))
  if (st.kind === 'working' || st.kind === 'speaking') acts.append(button('btn danger', 'Stop', () => stopSession(s)))
  if (s.can_end) acts.append(button('btn', 'Rename', () => renameSession(s)), button('btn danger', 'End', () => endSession(s)))
  p.append(acts)
  const tip = phoneTip()
  if (tip) p.append(tip)
}

function renderChat(all) {
  const rail = $('rail')
  rail.replaceChildren()
  for (const d of all) {
    const r = button(`ri${d.s.key === activeSession ? ' sel' : ''}`, null, () => selectSession(d.s.key))
    const tx = el('span', 'tx')
    const small = el('small', '', d.st.label)
    small.style.setProperty('--sc', d.st.kind === 'needs' || d.st.kind === 'ask' ? 'var(--warn)' : d.st.kind === 'idle' ? 'var(--muted)' : 'var(--accent)')
    tx.append(el('b', '', d.s.label), small)
    const dot = el('span', `dot${d.st.kind === 'idle' ? ' hollow' : ''}`)
    dot.style.setProperty('--c', KIND[d.st.kind].color)
    r.append(dot, tx)
    if (d.s.key === activeSession) { const m = el('i', 'ri-mic'); m.append(svg(MIC)); m.title = 'Talking to this one'; r.append(m) }
    rail.append(r)
  }
  rail.append(button('btn', '+ New session', openNewSession))
  const d = all.find(x => x.s.key === activeSession)
  $('chatTitle').textContent = d ? sessionName(d.s) : 'No session'
  const cs = $('chatState')
  cs.replaceChildren()
  if (d) {
    cs.style.setProperty('--sc', d.st.kind === 'needs' || d.st.kind === 'ask' ? 'var(--warn)' : d.st.kind === 'idle' ? 'var(--muted)' : 'var(--accent)')
    cs.append(`${d.st.label} · `, since(d.st.since))
  }
  $('renameBtn').hidden = $('endBtn').hidden = !d?.s.can_end
  // a session with nothing said yet: say how to start
  let empty = $('logEmpty')
  const any = [...log.children].some(n => n !== empty && !n.hidden && n.dataset.session)
  if (!any && d) {
    if (!empty) { empty = el('div', 'log-empty'); empty.id = 'logEmpty'; log.append(empty) }
    empty.replaceChildren(el('b', '', `Nothing here yet with ${d.s.label}`), el('span', '', 'Talk (tap the mic or hold space) or type below to start.'))
  } else empty?.remove()
  const steps = $('steps')
  steps.replaceChildren()
  if (!d) return
  const big = avatar(d.st.kind)
  big.style.width = big.style.height = '64px'
  steps.append(big)
  for (const req of d.st.pend) steps.append(permCard(req))
  const a = activity.get(d.s.key)
  const now = el('div')
  now.append(el('div', 'p-label', a?.busy ? 'Now' : 'Last turn'), el('div', '', a?.busy ? d.st.line : (a?.steps?.length ? 'Done' : 'Nothing yet')))
  steps.append(now)
  if (a?.steps?.length) steps.append(stepsList(a, 8))
  if (d.st.helpers.length) {
    const box = el('div')
    box.append(el('div', 'p-label', 'Helper agents'))
    for (const h of d.st.helpers) { const r = el('div', 'helper'); r.append(el('span', 'grow', h.label), since(h.since)); box.append(r) }
    steps.append(box)
  }
  if (a?.busy) steps.append(button('btn danger', 'Stop Claude', () => stopSession(d.s)))
}

// each session keeps its own chat: messages carry session_key, and the chat view shows only that one's
let shownSession = null // whose messages the log shows now
function sessionFilter() {
  const switched = activeSession !== shownSession
  if (switched && view === 'chat') saveScroll()
  for (const n of log.children) if (n.dataset.session) n.hidden = !!activeSession && n.dataset.session !== activeSession
  if (switched) { shownSession = activeSession; if (view === 'chat') restoreScroll(); drawPins() }
  if (view === 'chat') drawDiagrams(log)
  updateLatest()
}

// --- pins: each session's pinned messages, in a column beside the chat that folds to a
// thin strip (on a narrow window, a bar above it). The daemon keeps them, with a copy of
// each message, so they stay after the message has left the chat.

let pins = [] // { ref, session_key, pinned_at, msg }
let pinsFolded = localStorage.getItem('pinsFolded') === '1'
const pinsCol = $('pins')
// a message's own id; one saved before those existed: type, msg_id and time (as the daemon does)
const pinRef = m => m.id ?? `${m.t}:${m.msg_id ?? ''}:${m.at}`
const isPinned = ref => pins.some(p => p.ref === ref)

function pinButton(m) {
  const b = button('btn pin', '📌', () => send({ t: 'pin', ref: b.dataset.pin, on: !isPinned(b.dataset.pin) }))
  b.dataset.pin = pinRef(m)
  markPin(b)
  return b
}
function markPin(b) {
  const on = isPinned(b.dataset.pin)
  b.classList.toggle('on', on)
  b.title = on ? 'Unpin' : 'Pin this message'
}

function setPins(list) {
  pins = list ?? []
  for (const b of log.querySelectorAll('.btn.pin[data-pin]')) markPin(b)
  drawPins()
}

function drawPins() {
  const mine = pins.filter(p => p.session_key === activeSession).sort((a, b) => b.pinned_at - a.pinned_at)
  $('chat').classList.toggle('pins-folded', pinsFolded)
  pinsCol.classList.toggle('folded', pinsFolded)
  pinsCol.classList.toggle('empty', !mine.length)
  const fold = () => { pinsFolded = !pinsFolded; localStorage.setItem('pinsFolded', pinsFolded ? '1' : '0'); drawPins() }
  if (pinsFolded) {
    const b = button('btn pins-open', '', fold, 'Show the pinned messages')
    b.append(el('span', '', `📌 ${mine.length}`), el('span', 'wide-hide', mine.length === 1 ? ' pinned message' : ' pinned messages'))
    return pinsCol.replaceChildren(b)
  }
  const head = el('div', 'pins-head')
  head.append(el('b', '', `📌 Pinned${mine.length ? ` (${mine.length})` : ''}`), el('span', 'grow'), button('btn small', '–', fold, 'Minimize the pins'))
  pinsCol.replaceChildren(head, ...(mine.length ? mine.map(pinCard) : [el('div', 'note', 'Tap 📌 on a message to keep it here.')]))
}

function pinCard(p) {
  const m = p.msg
  const card = el('div', 'pin-card')
  const who = el('div', 'who')
  who.append(el('span', '', m.t === 'user' ? 'You' : m.t === 'show' ? 'Detail' : m.t === 'picture' ? 'Picture from Claude' : 'Claude'))
  stampWho(who, m)
  who.append(button('btn pin on', '✕', () => send({ t: 'pin', ref: p.ref, on: false }), 'Unpin'))
  const text = el('div', 'pin-text', pinPreview(m))
  card.append(who, text)
  card.onclick = e => {
    if (e.target.closest('button, a, .tile')) return
    // in the chat: jump to it; gone from the chat (old, or its session ended): open it here
    const node = log.querySelector(`.btn.pin[data-pin="${CSS.escape(p.ref)}"]`)?.closest('.msg')
    if (node && !node.hidden) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      node.classList.remove('flash')
      void node.offsetWidth
      node.classList.add('flash')
      return
    }
    const open = !card.classList.contains('open')
    card.classList.toggle('open', open)
    if (m.t === 'show') {
      const body = open ? detailBody(m.markdown, m) : null
      text.replaceChildren(body ?? pinPreview(m))
      if (body) drawDiagrams(body)
    }
  }
  return card
}

/** A pin's first lines: the text, or a detail's markdown without its markup. */
function pinPreview(m) {
  if (m.t === 'user') return m.text
  if (m.t === 'reply') return m.speak
  if (m.t === 'picture') return m.caption || '🖼 A picture'
  return String(m.markdown ?? '').replace(/```[\s\S]*?```/g, '').split('\n')
    .map(l => l.replace(/^[\s#>*-]*(\[!\w+\])?\s*/, '').replace(/[*_`]/g, '').trim()).filter(Boolean).join(' · ')
}

// ...and its own scroll: back to a session, you're where you left it (at the bottom, you stay at the bottom)
const scrollMemo = new Map() // session key -> scrollTop, or null at the bottom
function saveScroll() { if (shownSession) scrollMemo.set(shownSession, atBottom() ? null : log.scrollTop) }
function restoreScroll() {
  log.scrollTo({ top: scrollMemo.get(shownSession) ?? log.scrollHeight })
  updateLatest()
}

/** render(), tagging what it adds with the message's session. */
function renderTagged(m) {
  track(m)
  const before = log.lastChild
  render(m)
  if (m.session_key) {
    for (let n = before ? before.nextSibling : log.firstChild; n; n = n.nextSibling) n.dataset.session = m.session_key
    sessionFilter()
  }
  scheduleRender()
}

// --- wake word: hands-free turns need the phrase, except right after an answer -------------

let wake = { on: true, phrase: 'Hey Claude', open: false }
const wakeOn = $('wakeOn'), wakePhrase = $('wakePhrase')
function setWake(w) {
  const was = wake
  wake = { on: w.on, phrase: w.phrase, open: w.open }
  scheduleRender()
  wakeOn.checked = w.on
  if (document.activeElement !== wakePhrase) wakePhrase.value = w.phrase
  if (!w.on || !micOn) return
  if (w.open) {
    if (w.woken) earcon()
    hint('Listening to you… say “that’s all” when you’re done.')
  } else if (was.open && !w.quiet) {
    earcon(true)
    hint(`Say “${w.phrase}” to talk to Claude.`)
  }
}
const sendWake = () => send({ t: 'wake_config', on: wakeOn.checked, phrase: wakePhrase.value })
wakeOn.onchange = sendWake
wakePhrase.onchange = sendWake

// replies from sessions you're not talking to: spoken too (default), or text only. Kept by the daemon, so the phone follows it
$('speakAll').onchange = e => send({ t: 'voice_config', speak_all: e.target.checked })

// "my voice only": off, watch (the chat notes what it would drop) or on. The daemon keeps it and the voiceprint
for (const b of document.querySelectorAll('[data-my-voice]')) b.onclick = () => send({ t: 'voice_config', my_voice: b.dataset.myVoice })
$('myVoiceReset').onclick = () => send({ t: 'my_voice_reset' })
for (const b of document.querySelectorAll('[data-language]')) b.onclick = () => send({ t: 'voice_config', language: b.dataset.language })
function setMyVoice(m) {
  if (m.language) for (const b of document.querySelectorAll('[data-language]')) b.classList.toggle('on', b.dataset.language === m.language)
  if (!m.my_voice) return
  for (const b of document.querySelectorAll('[data-my-voice]')) b.classList.toggle('on', b.dataset.myVoice === m.my_voice)
  const i = m.my_voice_info ?? { learned: 0, ready: false, counts: {} }
  const c = i.counts
  $('myVoiceInfo').textContent = m.my_voice === 'off' ? 'Ignore voices that aren’t yours, or are far from the mic'
    : !i.ready ? `Learning your voice from your messages: ${i.learned} of 10`
    : `Knows your voice (${i.learned} messages) · ${m.my_voice === 'on' ? 'dropped' : 'would drop'}: ${c.other ?? 0} not you, ${c.far ?? 0} far away`
  $('myVoiceRetrain').hidden = m.my_voice === 'off' || !i.learned
}

function setSessions(list, active) {
  sessionList = list
  activeSession = active ?? list[0]?.key ?? null
  sessionFilter()
  scheduleRender()
}

const permRows = new Map()

// --- live activity: what Claude is doing right now (from Claude Code's tool hooks) ---

function setActivity(key, a) {
  const was = activity.get(key)
  if (was?.busy && !a.busy && key === activeSession) alertUser('done')
  activity.set(key, { busy: a.busy, since: a.since, steps: a.steps ?? [] })
  scheduleRender()
}

// --- "done" and "needs you" alerts: look away while Claude works -------------------

let lastFinal = '' // Claude's last spoken answer, for the notification text
let chimeAfterSpeech = false
const alertsOn = () => els.alerts.checked

/** A soft chime (and a desktop notification when this tab is in the background). */
function alertUser(kind, detail = '') {
  if (!alertsOn() || replaying) return
  if (kind === 'done' && player.playing) chimeAfterSpeech = true // don't talk over the answer
  else chime(kind)
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(kind === 'done' ? 'Claude is done' : 'Claude needs your approval', {
      body: (kind === 'done' ? lastFinal : detail).slice(0, 180),
      tag: `handfree-${kind}`, // replace, don't stack
      silent: true, // the chime is the sound
    })
    n.onclick = () => { window.focus(); n.close() }
  }
}

function chime(kind) {
  player.ensure()
  const ctx = player.ctx
  if (ctx.state !== 'running') return
  // done: two soft rising notes; approval: three quick higher ones, harder to miss
  const notes = kind === 'done' ? [[523, 0], [784, 0.13]] : [[880, 0], [880, 0.16], [1175, 0.32]]
  for (const [freq, at] of notes) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at
    o.type = 'sine'
    o.frequency.setValueAtTime(freq, t)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(kind === 'done' ? 0.12 : 0.18, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    o.connect(g).connect(ctx.destination)
    o.start(t); o.stop(t + 0.4)
  }
}

// mute this page's copy of Claude's voice (say you talk through the phone, and the Mac
// shouldn't answer out loud too). It still plays here at volume 0, so nothing else changes.
try { els.mute.checked = localStorage.getItem('handfree.mute') === 'on' } catch {}
player.setMuted(els.mute.checked)
els.mute.onchange = () => {
  player.setMuted(els.mute.checked)
  scheduleRender()
  try { localStorage.setItem('handfree.mute', els.mute.checked ? 'on' : 'off') } catch {}
}

try { els.alerts.checked = localStorage.getItem('handfree.alerts') !== 'off' } catch {}
els.alerts.onchange = () => {
  try { localStorage.setItem('handfree.alerts', els.alerts.checked ? 'on' : 'off') } catch {}
  if (els.alerts.checked) askNotifyPermission()
}
function askNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {})
}

// --- theme and text size (this browser only) ---------------------------------------------

const THEMES = ['auto', 'light', 'dark']
let theme = 'auto', textSize = 'normal'
try { theme = THEMES.includes(localStorage.getItem('handfree.theme')) ? localStorage.getItem('handfree.theme') : 'auto' } catch {}
try { textSize = localStorage.getItem('handfree.size') === 'large' ? 'large' : 'normal' } catch {}
function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  document.documentElement.dataset.size = textSize
  $('themeTxt').textContent = theme[0].toUpperCase() + theme.slice(1)
  $('themeBtn').title = `Theme: ${theme} (click to change)`
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.classList.toggle('on', b.dataset.themePick === theme)
  for (const b of document.querySelectorAll('[data-size-pick]')) b.classList.toggle('on', b.dataset.sizePick === textSize)
  try { localStorage.setItem('handfree.theme', theme); localStorage.setItem('handfree.size', textSize) } catch {}
}
$('themeBtn').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; applyTheme() }
for (const b of document.querySelectorAll('[data-theme-pick]')) b.onclick = () => { theme = b.dataset.themePick; applyTheme() }
for (const b of document.querySelectorAll('[data-size-pick]')) b.onclick = () => { textSize = b.dataset.sizePick; applyTheme() }
applyTheme()

// --- full screen: the whole dashboard on the screen, nothing else (F, or the button) -----

const ENTER_ICON = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
const EXIT_ICON = 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else document.documentElement.requestFullscreen().catch(err => hint(`Full screen is not allowed here: ${err.message}`))
}
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement
  $('fullBtn').setAttribute('aria-pressed', String(on))
  $('fullBtn').title = on ? 'Leave full screen (F or Esc)' : 'Full screen (F)'
  $('fullBtn').setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen')
  $('fullIcon').setAttribute('d', on ? EXIT_ICON : ENTER_ICON)
})
$('fullBtn').onclick = toggleFullscreen
document.addEventListener('keydown', ev => {
  if (ev.key.toLowerCase() !== 'f' || ev.metaKey || ev.ctrlKey || ev.altKey || typing(ev.target) || dialogOpen()) return
  ev.preventDefault()
  toggleFullscreen()
})
if (!document.fullscreenEnabled) $('fullBtn').hidden = true

$('settingsBtn').onclick = () => $('settingsDlg').showModal()
$('setClose').onclick = () => $('settingsDlg').close()

// --- detail blocks (see blocks.js) ---------------------------------------------------

handfreeBlocks.useWith(marked)

/** A detail answer's markdown drawn: blocks, links beside handfree, copy buttons, Decide chips. */
function detailBody(markdown, m) {
  const body = el('div')
  body.innerHTML = DOMPurify.sanitize(marked.parse(markdown))
  // links (design cards too) open beside handfree, not in its place
  for (const a of body.querySelectorAll('a[href^="http"]')) Object.assign(a, { target: '_blank', rel: 'noopener' })
  for (const code of body.querySelectorAll('pre:not(.mermaid) > code')) code.parentElement.append(copyButton(() => code.textContent.replace(/\n$/, ''), 'Copy code'))
  // a decision's choices answer it: one click (or a Halo pinch) sends that choice
  for (const chip of body.querySelectorAll('.c-decide .chip')) {
    const b = button('chip', chip.textContent, () => { if (m.session_key) selectSession(m.session_key); send({ t: 'text', text: b.textContent }) }, 'Send this answer')
    chip.replaceWith(b)
  }
  // a web picture that won't load leaves no broken frame
  for (const img of body.querySelectorAll('img')) img.onerror = () => img.remove()
  return body
}

let mermaidReady = null

/** The diagram library is 3 MB, so it loads on the first diagram. */
function loadMermaid() {
  mermaidReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/vendor/mermaid.min.js'
    s.onload = () => {
      const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: getComputedStyle(document.body).fontFamily,
        themeVariables: {
          darkMode: css('color-scheme') === 'dark',
          background: css('--bg'), primaryColor: css('--card'), primaryBorderColor: css('--line'), primaryTextColor: css('--fg'),
          lineColor: css('--muted'), textColor: css('--fg'), secondaryColor: css('--accent-soft'), tertiaryColor: css('--bg'),
          actorBkg: css('--accent-soft'), actorBorder: css('--accent'), actorTextColor: css('--fg'),
          signalColor: css('--muted'), signalTextColor: css('--fg'), noteBkgColor: css('--warn-soft'), noteTextColor: css('--fg'),
          edgeLabelBackground: css('--bg'), fontSize: '14px',
        },
        flowchart: { curve: 'basis', padding: 14 },
      })
      resolve(window.mermaid)
    }
    s.onerror = () => { mermaidReady = null; reject(new Error('diagram library failed to load')) }
    document.head.append(s)
  })
  return mermaidReady
}

// a diagram drawn while hidden (another session's message, or the home view) measures its
// labels as zero and comes out as bare arrows, so each one waits until it's on screen
async function drawDiagrams(root) {
  const waiting = () => [...root.querySelectorAll('pre.mermaid:not([data-processed]):not([data-drawing])')]
  if (!waiting().length) return
  let mm
  try {
    mm = await loadMermaid()
  } catch (e) {
    for (const node of waiting()) showDiagramSource(node, e)
    return
  }
  const nodes = waiting().filter(n => n.getClientRects().length)
  for (const node of nodes) node.dataset.drawing = ''
  for (const node of nodes) {
    // one at a time, so a broken diagram shows as text and the rest still draw
    try { await mm.run({ nodes: [node] }) } catch (e) { showDiagramSource(node, e) }
  }
}

function showDiagramSource(node, err) {
  const box = node.closest('.diagram') ?? node
  const pre = el('pre', '', node.textContent)
  box.replaceWith(el('div', 'note', `Diagram could not be drawn (${String(err?.message ?? err).split('\n')[0]}):`), pre)
}

/** A small Copy button; text() is read at click time. */
function copyButton(text, title = 'Copy') {
  const b = el('button', 'btn copy', 'Copy')
  b.type = 'button'
  b.title = title
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text())
      b.textContent = 'Copied ✓'
    } catch {
      b.textContent = 'Copy failed'
    }
    setTimeout(() => { b.textContent = 'Copy' }, 1200)
  }
  return b
}

/** When the Mac stamped a message: "12:41", "Yesterday 18:05" or "25 Oct, 18:05". */
function when(at) {
  const t = new Date(at)
  const clock = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 864e5)
  return days === 0 ? clock : days === 1 ? `Yesterday ${clock}` : `${t.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${clock}`
}
/** The time, right after a message's label. */
function stampWho(who, m) {
  if (!m.at) return
  const s = el('span', 'when', `· ${when(m.at)}`)
  s.title = new Date(m.at).toLocaleString()
  who.firstChild.after(s)
}

function render(m) {
  switch (m.t) {
    case 'user': {
      const n = el('div', 'msg user')
      const who = el('div', 'who')
      who.append(el('span', '', `${m.via === 'voice' ? 'You said' : 'You typed'}${m.from ? ` · ${m.from}` : ''}`), el('span', '', m.session ?? ''))
      if (m.interrupted_after) who.append(el('span', '', '· interrupted Claude'))
      if (m.while_working) who.append(el('span', '', '· by the way, while Claude works'))
      who.append(pinButton(m))
      stampWho(who, m)
      n.append(who, el('div', '', m.text))
      if (m.picture) {
        // only the page that sent it has the picture; the daemon never sends it back
        const url = sentPictures.get(m.ref)
        if (url) { const img = el('img', 'pic'); img.src = url; img.alt = 'Picture you sent'; n.append(img) }
        else n.append(el('div', 'note', '🖼 a picture'))
      }
      return add(n)
    }
    case 'reply': {
      if (m.kind === 'final') lastFinal = m.speak
      const n = el('div', 'msg reply')
      const who = el('div', 'who')
      who.append(el('span', '', `Claude · ${m.kind}`))
      if (m.say_id) {
        // the daemon keeps the last few replies' audio in memory, and plays it on this page only
        who.append(button('btn replay', '▶', () => { player.ensure(); send({ t: 'replay', say_id: m.say_id }) }, 'Hear this again'))
      }
      who.append(copyButton(() => m.speak), pinButton(m))
      stampWho(who, m)
      n.append(who, el('div', 'speak', m.speak))
      return add(n)
    }
    case 'picture': {
      // a screenshot Claude sent: the daemon keeps it (a day, memory only) and the page loads it by id
      const n = el('div', 'msg detail')
      const who = el('div', 'who')
      who.append(el('span', '', 'Picture from Claude'), pinButton(m))
      const url = `/picture/${encodeURIComponent(m.picture)}?token=${encodeURIComponent(window.HANDFREE_TOKEN)}`
      const img = el('img', 'pic sent')
      Object.assign(img, { src: url, alt: m.caption || 'Picture from Claude', loading: 'lazy', title: 'Open full size' })
      img.onclick = () => window.open(url, '_blank', 'noopener')
      // it loads after it's added: if you were at the bottom, stay there as it grows
      img.onload = () => { if (!img.closest('[hidden]') && log.scrollHeight - log.scrollTop - log.clientHeight - img.offsetHeight < 80) log.scrollTo({ top: log.scrollHeight }) }
      img.onerror = () => img.replaceWith(el('div', 'note', '🖼 This picture is no longer kept (over a day old, or the daemon restarted)'))
      stampWho(who, m)
      n.append(who, img)
      if (m.caption) n.append(el('div', 'note', m.caption))
      return add(n)
    }
    case 'show': {
      const n = el('div', 'msg detail')
      const who = el('div', 'who')
      who.append(el('span', '', m.fallback ? 'Answered in the terminal' : 'Detail'), copyButton(() => m.markdown, 'Copy the answer as markdown'), pinButton(m))
      stampWho(who, m)
      n.append(who)
      // each tile's own section opens under the tiles when tapped, not in the answer
      const { main, details } = handfreeBlocks.tileDetails(m.markdown)
      const body = detailBody(main, m)
      for (const grid of body.querySelectorAll('.tiles')) {
        const panel = el('div', 'tile-detail')
        panel.hidden = true
        grid.after(panel)
        for (const tile of grid.querySelectorAll('.tile')) tile.onclick = () => {
          const md = details[tile.dataset.tile]
          const title = tile.querySelector('b')?.textContent.trim() ?? ''
          // no section for it: the session that wrote the overview tells more
          if (!md) { if (m.session_key) selectSession(m.session_key); return send({ t: 'text', text: `Tell me more about ${title}` }) }
          const open = !tile.classList.contains('on')
          for (const t of grid.querySelectorAll('.tile')) t.classList.toggle('on', open && t === tile)
          panel.replaceChildren(...(open ? [el('h3', '', title), detailBody(md, m)] : []))
          panel.hidden = !open
          if (open) { drawDiagrams(panel); panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
        }
      }
      n.append(body)
      drawDiagrams(body)
      return add(n)
    }
    case 'approval_request': {
      if (permRows.has(m.request_id)) return
      perms.set(m.request_id, { req: m, resolved: false })
      alertUser('approval', `${m.tool_name}: ${m.description}`)
      const n = el('div', 'msg perm')
      n.append(el('div', 'who', `Approval needed · ${m.tool_name}`))
      n.append(el('div', '', m.description))
      if (m.input_preview) n.append(el('pre', '', m.input_preview))
      const row = el('div', 'row')
      row.append(button('btn primary', 'Approve', () => answerPerm(m.request_id, 'allow')), button('btn', 'Deny', () => answerPerm(m.request_id, 'deny')))
      n.append(row)
      if (m.sessionKey) n.dataset.session = m.sessionKey
      permRows.set(m.request_id, row)
      add(n)
      sessionFilter()
      return scheduleRender()
    }
    case 'menu_request': {
      if (permRows.has(m.request_id)) return
      const req = { request_id: m.request_id, sessionKey: m.session_key, tool_name: 'Terminal', description: m.title, options: m.options }
      perms.set(m.request_id, { req, resolved: false })
      alertUser('approval', m.title)
      const n = el('div', 'msg perm')
      n.append(el('div', 'who', `Asking in the terminal · ${m.session ?? ''}`))
      n.append(el('div', 'menu-q', m.title))
      const row = menuButtons(req)
      n.append(row)
      if (m.session_key) n.dataset.session = m.session_key
      permRows.set(m.request_id, row)
      add(n)
      sessionFilter()
      return scheduleRender()
    }
    case 'menu_resolved': {
      const p = perms.get(m.request_id)
      if (p) p.resolved = true
      scheduleRender()
      permRows.get(m.request_id)?.replaceChildren(el('span', 'note', m.via === 'tap' ? `Picked: ${m.label}` : 'Answered in the terminal'))
      return
    }
    case 'approval_resolved': {
      const p = perms.get(m.request_id)
      if (p) p.resolved = true
      scheduleRender()
      const row = permRows.get(m.request_id)
      if (!row) return
      const text = m.via === 'terminal' ? 'Answered in the terminal' : `${m.behavior === 'allow' ? 'Approved' : 'Denied'} by ${m.via}`
      row.replaceChildren(el('span', 'note', text))
      return
    }
    case 'command':
      if (m.command === 'hold') return hint('Okay, take your time.')
      return add(el('div', 'note', `Voice command: ${m.command.replace('_', ' ')}`))
    case 'metrics': {
      const parts = []
      if (m.stt_ms != null) parts.push(`heard in ${m.stt_ms} ms`)
      if (m.claude_first_ms != null) parts.push(`Claude first reply ${(m.claude_first_ms / 1000).toFixed(1)} s`)
      if (m.claude_final_ms != null && m.claude_final_ms !== m.claude_first_ms) parts.push(`final ${(m.claude_final_ms / 1000).toFixed(1)} s`)
      if (m.tts_first_ms != null) parts.push(`voice started ${m.tts_first_ms} ms`)
      return add(el('div', 'metrics', parts.join(' · ')))
    }
    case 'notice':
      return add(el('div', 'note', m.text))
    case 'mode':
      return setMode(m.mode)
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      online = true
      retries = 0
      clearInterval(retryTick)
      if (m.phones) setPhones(m.phones)
      $('offline').hidden = true
      log.replaceChildren()
      permRows.clear()
      perms.clear()
      info.clear()
      replaying = true
      pins = m.pins ?? []
      shownSession = null // draw this session's pins again
      for (const h of m.history) renderTagged(h)
      for (const p of m.pending) render({ t: 'approval_request', ...p })
      for (const mm of m.menus ?? []) render(mm)
      replaying = false
      log.scrollTo({ top: log.scrollHeight })
      setState(m.state)
      setSpeech(m.speech_status ?? 'on')
      setMode(m.mode)
      projects = m.projects ?? []
      activity.clear()
      for (const [key, a] of Object.entries(m.activity ?? {})) activity.set(key, { busy: a.busy, since: a.since, steps: a.steps ?? [] })
      setSessions(m.sessions, m.active)
      if (m.pauseMs) pauseMs = m.pauseMs
      if (m.wake) setWake(m.wake)
      $('speakAll').checked = m.speak_all !== false
      setMyVoice(m)
      if (m.full_disk === false) render({ t: 'notice', text: 'Sessions started from the phone can stop at a macOS permission popup ("bun would like to access…"). Fix it once: run handfree permissions in a terminal.' })
      return
    case 'state': return setState(m.state)
    case 'speech': return setSpeech(m.status)
    case 'sessions': return setSessions(m.sessions, m.active)
    case 'pins': return setPins(m.pins)
    case 'projects': projects = m.projects ?? []; return scheduleRender()
    case 'phones': return setPhones(m)
    case 'activity': return setActivity(m.session, m)
    case 'browse': browse = m; return renderNewSession()
    case 'chats':
      if (picked && m.cwd === picked.cwd) { picked.chats = m.chats; picked.profile ??= m.profile; renderNewSession() }
      return
    case 'say_start': player.cancelled.delete(m.say_id); return
    case 'audio': player.enqueue(m); return scheduleRender()
    case 'say_end': return
    case 'stop_playback': player.stop(); return scheduleRender()
    case 'resume_playback': return player.resume()
    case 'transcript':
      if (m.text) hint(`Heard: “${m.text}”`); else hint('Didn’t catch that.')
      if (clips.has(m.clip)) {
        const n = el('div', 'heard')
        const btn = el('button', 'btn', '▶')
        btn.type = 'button'
        btn.title = 'Play what the recognizer heard'
        btn.onclick = () => playClip(m.clip, btn)
        n.append(btn, el('span', '', m.text ? `heard “${m.text}”` : 'heard no words'))
        if (activeSession) n.dataset.session = activeSession
        add(n)
      }
      return
    case 'wake': return setWake(m)
    case 'voice_config': $('speakAll').checked = m.speak_all !== false; setMyVoice(m); return
    case 'not_for_claude': return hint(`Not sent to Claude. Start with “${wake.phrase}”, or hold space to talk.`)
    case 'held': return hint(`Heard: “${m.text}” … go on, I’m waiting for the rest.`)
    case 'pong': return
    case 'pair_qr':
      $('pairQr').innerHTML = DOMPurify.sanitize(m.svg, { USE_PROFILES: { svg: true } })
      $('pairCode').textContent = `${m.code.slice(0, 4)}-${m.code.slice(4)}`
      return
    case 'hearing':
      hearingNow = m.on
      scheduleRender()
      els.mic.classList.toggle('hearing', m.on)
      els.mic.classList.remove('waiting')
      if (m.on) hint('Listening…')
      return
    case 'wait':
      els.mic.classList.add('waiting')
      return hint('Still listening… go on, take your time.')
    case 'heard': earcon(); hearingNow = false; scheduleRender(); els.mic.classList.remove('waiting'); return hint('Got it…')
    case 'duck': return player.duck()
    case 'unduck': return player.unduck()
    case 'pause': return player.pause() // resumes if it was only "mm-hmm"
    case 'clip': return keepClip(m.clip, pcm16ToFloat(m.pcm16))
    default: return renderTagged(m)
  }
}

// --- controls ---------------------------------------------------------------------------

$('pairBtn').onclick = pairPhone
$('pairClose').onclick = () => $('pairDlg').close()

// --- sessions: start one on the Mac, rename, end, stop (as on the phone) ----------------

const activeInfo = () => sessionList.find(x => x.key === activeSession)

function stopSession(s) {
  if (s?.can_end) send({ t: 'interrupt_session', key: s.key })
  else render({ t: 'notice', text: 'This session was started in a terminal. Press Esc there to stop Claude.' })
}
/** A question inside the page (the browser's own prompt/confirm would freeze it, Halo included).
 *  Resolves with the typed text (input), true (OK) or null (Cancel). */
function ask({ title, message = '', input = null, ok = 'OK', danger = false }) {
  const dlg = $('askDlg')
  $('askTitle').textContent = title
  $('askMsg').textContent = message
  $('askMsg').hidden = !message
  $('askInput').hidden = input == null
  $('askInput').value = input ?? ''
  $('askOk').textContent = ok
  $('askOk').className = `btn ${danger ? 'danger' : 'primary'}`
  dlg.returnValue = ''
  dlg.showModal()
  if (input != null) { $('askInput').focus(); $('askInput').select() }
  return new Promise(resolve => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? (input != null ? $('askInput').value : true) : null)
  })
}

async function renameSession(s) {
  if (!s) return
  const name = await ask({ title: `Rename ${s.label}`, input: s.label, ok: 'Rename' })
  if (name?.trim() && name.trim() !== s.label) send({ t: 'rename_session', key: s.key, name: name.trim() })
}
async function endSession(s) {
  if (s && await ask({ title: `End ${s.label}?`, message: 'Claude stops and the session closes.', ok: 'End session', danger: true })) send({ t: 'end_session', key: s.key })
}
$('renameBtn').onclick = () => renameSession(activeInfo())
$('endBtn').onclick = () => endSession(activeInfo())

// New session: a folder (pinned, recent or from a workspace), then the profile and a new or past chat
let browse = null // the Mac's lists
let ndTab = null
let picked = null // { cwd, name, profile?, chats? }

function openNewSession() { browse = null; picked = null; renderNewSession(); $('newDlg').showModal(); send({ t: 'browse' }) }
$('newBtn').onclick = openNewSession
$('ndClose').onclick = () => $('newDlg').close()
$('ndBack').onclick = () => { picked = null; renderNewSession() }

function pickFolder(f) {
  picked = { cwd: f.cwd, name: f.name }
  renderNewSession()
  send({ t: 'chats', cwd: f.cwd })
}

function startHere(chat) {
  send({ t: 'start_session', cwd: picked.cwd, ...(chat ? { chat } : {}), ...(picked.profile ? { profile: picked.profile } : {}) })
  $('newDlg').close()
}

function whenText(ms) {
  const d = new Date(ms)
  const day = n => new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  const days = Math.round((day(new Date()) - day(d)) / 86400000)
  if (days === 0) return `today ${d.toTimeString().slice(0, 5)}`
  if (days === 1) return 'yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderNewSession() {
  const body = $('ndBody')
  body.replaceChildren()
  $('ndBack').hidden = !picked
  $('ndTitle').textContent = picked ? picked.name : 'New session'
  if (!browse) return body.append(el('p', 'nd-note', 'Loading…'))
  if (browse.full_disk === false) body.append(el('p', 'note', 'A session started from here can stop at a macOS permission popup ("bun would like to access…"). Fix it once: run handfree permissions in a terminal.'))
  if (!picked) {
    const tabs = [
      ...(browse.pinned?.length ? [['Pinned', browse.pinned]] : []),
      ['Recent', (browse.recent ?? []).map(p => ({ ...p, recent: true }))],
      ...(browse.workspaces ?? []).map(w => [w.name, w.folders]),
    ]
    if (!tabs.some(t => t[0] === ndTab)) ndTab = tabs[0][0]
    const bar = el('div', 'nd-tabs')
    for (const [name] of tabs) bar.append(button(`btn small${name === ndTab ? ' on' : ''}`, name, () => { ndTab = name; renderNewSession() }))
    const folders = tabs.find(t => t[0] === ndTab)[1]
    const list = el('div', 'nd-list')
    for (const f of folders) {
      const row = button('nd-item', null, () => pickFolder(f), f.cwd)
      row.append(el('span', '', `📁 ${f.name}`), el('small', '', shortPath(f.cwd)))
      if (f.recent) {
        const x = button('nd-x', '✕', e => { e.stopPropagation(); send({ t: 'forget_project', cwd: f.cwd }); send({ t: 'browse' }) }, 'Remove from Recent (it comes back the next time a voice session runs there)')
        row.append(x)
      }
      list.append(row)
    }
    if (!folders.length) list.append(el('p', 'nd-note', 'Nothing here yet. Folders where voice sessions ran show up under Recent; add pinned folders and workspaces in ~/.handfree/config.json.'))
    return body.append(bar, list)
  }
  const profiles = [...new Set([...(browse.profiles ?? []), ...(picked.profile ? [picked.profile] : [])])]
  if (profiles.length > 1) {
    const bar = el('div', 'nd-tabs')
    for (const p of profiles) bar.append(button(`btn small${p === picked.profile ? ' on' : ''}`, p, () => { picked.profile = p; picked.chats = null; renderNewSession(); send({ t: 'chats', cwd: picked.cwd, profile: p }) }))
    body.append(bar)
  }
  body.append(button('btn primary', '+ New chat', () => startHere()), el('p', 'nd-note', 'Or continue a past chat:'))
  const list = el('div', 'nd-list')
  if (!picked.chats) list.append(el('p', 'nd-note', 'Loading…'))
  else if (!picked.chats.length) list.append(el('p', 'nd-note', 'No past chats in this folder.'))
  else for (const ch of picked.chats) {
    const row = button('nd-item', null, () => startHere(ch.id))
    row.append(el('span', '', ch.title), el('small', '', whenText(ch.updated)))
    list.append(row)
  }
  body.append(list, el('p', 'nd-note', 'A chat that is already open in another session should be continued there, not here.'))
}
$('modeTap').onclick = () => send({ t: 'mode', mode: 'tap' })
$('modePass').onclick = () => send({ t: 'mode', mode: 'passphrase' })
function stopSpeaking() { player.stop(); send({ t: 'stop_speaking' }); scheduleRender() }
$('stopSpeaking').onclick = stopSpeaking

// --- pictures for Claude: attach, paste or drop one, then send it with your question ---
// Shrunk here (long side 1600 px, JPEG) so a screenshot is a few hundred KB. The daemon
// keeps it in memory only, and Claude looks at it through its picture tool.

let pending = null // { data (base64), url, ref }
const sentPictures = new Map() // ref -> url, for this page's own thumbnails

async function shrink(source) {
  const bmp = await createImageBitmap(source)
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  const g = canvas.getContext('2d')
  g.fillStyle = '#fff' // transparent PNGs: white, not black, behind them
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

function setPending(url) {
  pending = { data: url.slice(url.indexOf(',') + 1), url, ref: `w${Date.now().toString(36)}` }
  $('pendingImg').src = url
  $('pending').hidden = false
  els.input.focus()
}

async function attachPicture(file) {
  if (!file || !file.type.startsWith('image/')) return
  try { setPending(await shrink(file)) } catch { hint('That picture could not be read.') }
}

function dropPending() {
  pending = null
  $('pending').hidden = true
  $('file').value = ''
}

$('attach').onclick = () => $('file').click()
$('file').onchange = () => attachPicture($('file').files[0])
$('pendingX').onclick = dropPending
els.input.addEventListener('paste', ev => {
  const item = [...(ev.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'))
  if (item) { ev.preventDefault(); attachPicture(item.getAsFile()) }
})
document.addEventListener('dragover', ev => {
  if ([...(ev.dataTransfer?.items ?? [])].some(i => i.type.startsWith('image/'))) { ev.preventDefault(); document.body.classList.add('dropping') }
})
document.addEventListener('dragleave', ev => { if (!ev.relatedTarget) document.body.classList.remove('dropping') })
document.addEventListener('drop', ev => {
  document.body.classList.remove('dropping')
  const file = [...(ev.dataTransfer?.files ?? [])].find(f => f.type.startsWith('image/'))
  if (file) { ev.preventDefault(); attachPicture(file) }
})

function sendPicture(p, text) {
  sentPictures.set(p.ref, p.url)
  send({ t: 'picture', data: p.data, text, ref: p.ref })
}

$('form').onsubmit = ev => {
  ev.preventDefault()
  const text = els.input.value.trim()
  if (!text && !pending) return
  player.ensure()
  player.ctx.resume()
  els.input.value = ''
  fitInput()
  if (pending) {
    sendPicture(pending, text)
    dropPending()
  } else send({ t: 'text', text })
}
els.input.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('form').requestSubmit() }
})
// the box grows with what you type (Shift+Enter for a new line), up to 3 lines; past that it scrolls
function fitInput() {
  const t = els.input, cs = getComputedStyle(t)
  const edges = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  const max = parseFloat(cs.lineHeight) * 3 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + edges
  t.style.height = 'auto'
  const want = t.scrollHeight + edges
  t.style.height = `${Math.min(want, max)}px`
  t.style.overflowY = want > max ? 'auto' : 'hidden'
}
els.input.addEventListener('input', fitInput)
// any click unlocks audio playback (browsers block it until the user interacts)
document.addEventListener('pointerdown', () => { player.ensure(); player.ctx.resume() }, { once: true })

// --- Halo: what each hand gesture does here ------------------------------------------------

const halo = window.HandfreeHalo
if (halo) {
  /** The newest unanswered permission, the selected session's first. */
  const newestPerm = () => {
    const open = [...perms.values()].filter(p => !p.resolved && !p.req.options).map(p => p.req)
    return open.filter(r => r.sessionKey === activeSession).at(-1) ?? open.at(-1)
  }
  halo.actions = {
    stop: stopSpeaking,
    allow() { const r = newestPerm(); if (r) answerPerm(r.request_id, 'allow'); return !!r },
    deny() { const r = newestPerm(); if (r) answerPerm(r.request_id, 'deny'); return !!r },
    talkStart() {
      if (speechStatus !== 'on') { halo.toast(speechStatus === 'off' ? 'Voice is off: tap Start voice first' : 'Voice is starting…'); return false }
      pttDown()
      return true
    },
    talkEnd() { if (ptt) pttUp() },
    home() {
      if (view === 'home') return '✊ Already home'
      setView('home')
      return '✊ Home'
    },
    chat() {
      const s = activeInfo()
      if (!s) return '👍 No session to open yet'
      if (view === 'chat') return `👍 Already in ${s.label}`
      openChat(s.key)
      return `👍 ${s.label}`
    },
    mic() {
      if (speechStatus !== 'on') {
        micAfterVoice = true
        if (speechStatus === 'off') startVoice()
        return '🎤 Starting voice… the mic turns on in a few seconds'
      }
      if (micOn) { stopMic(); return '🎤 Mic off' }
      startMic().catch(err => { micFailed(err); halo.toast('Mic failed to start') })
      return '🎤 Mic on: just talk'
    },
    swipe(dir) {
      if (view === 'home') return setTab(homeTab === 'agents' ? 'list' : 'agents')
      const keys = decorated().map(d => d.s.key)
      if (!keys.length) return
      const i = Math.max(0, keys.indexOf(activeSession))
      selectSession(keys[(i + (dir === 'right' ? 1 : keys.length - 1)) % keys.length])
    },
    snap(url) {
      if (!sessionList.length) return false
      shrink(dataUrlBlob(url)).then(small => {
        sendPicture({ data: small.slice(small.indexOf(',') + 1), url: small, ref: `c${Date.now().toString(36)}` }, 'A photo from my camera.')
      })
      return true
    },
  }
  halo.onError = cameraFailed
  halo.onAwake = on => earcon(!on) // up when Halo wakes, down when it sleeps
  halo.onChange = () => {
    const on = halo.on || halo.starting
    $('haloBtn').setAttribute('aria-pressed', String(on))
    $('camSnap').hidden = !halo.on || !halo.enabled.has('photo')
  }
  $('haloBtn').onclick = () => halo.toggle()
  $('camSnap').onclick = async () => {
    const url = halo.snapFrame()
    if (url) setPending(await shrink(dataUrlBlob(url)))
  }
}

function dataUrlBlob(url) {
  const [head, b64] = url.split(',')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: head.slice(5, head.indexOf(';')) })
}

setView('home')
setInterval(() => send({ t: 'ping' }), 30000)
connect()
