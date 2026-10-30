// The daemon's brain: utterances in, Claude's speech out.
//
//   utterance -> speech-to-text -> approval dialog? -> voice command? -> Claude
//   reply     -> text-to-speech (sentence by sentence) -> clients
//
// Everything here works on text and events; audio bytes only pass through.

import { readFileSync } from 'node:fs'
import type { ActivityEvent } from './activity'
import { projectWords } from './vocab'
import { Approvals, type PermissionRequest } from './approvals'
import { Launcher, Projects, cleanTitle, pastChats, pinnedFolders, pinnedFor, profileChoices, profileDir, profileName, workspaceFolders, workspaceFor, type Project } from './launcher'
import { fullDiskAccess } from './access'
import { Pictures } from './pictures'
import { cleanTranscript, guessSession, heardTwice, isFiller, isNo, isYes, parseCommand, sessionSwitchTargets, soundsUnfinished, splitSwitch, stripWake, type Command } from './commands'
import { CHAT_FILE, PINS_FILE, VOICEPRINT_FILE, saveConfig, type Config } from './paths'
import { Pins, pinRef } from './pins'
import { lastId, loadChat, saveChat } from './chatlog'
import { Voiceprint, describe, drops, type VoiceFeatures } from './voiceprint'
import { conversationId, pidAlive, sessionName, type Session } from './sessions'
import { Terminals, parseMenu, sameMenu, type Menu } from './terminal'
import type { Speech, SpeechStatus, TtsChunk, TurnEnd, VadEvent } from './speech'

export type State = 'starting' | 'idle' | 'transcribing' | 'working' | 'speaking' | 'approval'

export type Hub = {
  broadcast: (msg: object) => void
  sendTo: (clientId: string, msg: object) => void
  clientCount: () => number
  /** which kind of device a client is, for the "from" on what you say */
  from: (clientId: string) => 'phone' | 'web' | undefined
  /** sends every client a fresh welcome, so it draws the chat again */
  rewelcome: () => void
}

type Position = { say_id: string; seq: number }

type Say = {
  id: string
  msgId?: string
  kind: string
  text: string
  sentences: string[]
  cancel?: () => void
  /** only this client hears it (a replay button), else everyone */
  to?: string
  /** a replay: the reply it repeats, and its kept audio if there is any */
  replayOf?: string
  kept?: TtsChunk[]
  audio?: TtsChunk[]
}

type Turn = { msgId: string; session: string; sttMs?: number; sentAt: number; firstReplyMs?: number; finalMs?: number; ttsFirstMs?: number }

const ANSWERED_IN_TERMINAL = "I answered in the terminal, and I've put it on your screen too."
const HISTORY_LIMIT = 1000
/** replies whose audio stays in memory for the replay button (never on disk) */
const REPLAY_LIMIT = 10
/** a turn this long (~10 s of talk) is dictation, not a quick question: see longJoinMs */
const LONG_TURN_WORDS = 30
/** after a bare "Hey Claude", how long it listens for what you say next */
const WAKE_LISTEN_MS = 8000
/** the language Whisper listens for. Rojak (Malaysian Malay and English mixed) is heard as Malay,
 *  which keeps English words in English when the prompt mixes both */
const WHISPER_LANGUAGE = { en: 'en', rojak: 'ms', auto: 'auto' } as const
/** Whisper copies the style of the text before your words: a rojak sentence with the
 *  particles and borrowed words people say, spelled the usual way */
const ROJAK_EXAMPLE = 'Okay lah, boleh tak you check the build dulu? Sebab dia fail tadi kan, I rasa ada bug kat login page. Takpe, nanti I tapau makan, paiseh ah.'
/** a session this quiet mid-task gets its screen read: it may be showing a menu */
const MENU_QUIET_MS = 4000
/** quiet this long (a long build, or a turn an API error ended): look less often */
const MENU_SLOW_MS = 120_000
/** how often an idle session's screen is read */
const MENU_IDLE_LOOK_MS = 30_000

/** A menu Claude Code shows in a session's terminal, put on the screens to answer. */
type OpenMenu = { request_id: string; sessionKey: string; menu: Menu }

export class Conductor {
  state: State = 'starting'
  sessions = new Map<string, Session>()
  activeKey: string | null = null
  approvals: Approvals
  history: object[] = []
  private pins = new Pins(PINS_FILE)

  private hub: Hub = { broadcast: () => {}, sendTo: () => {}, clientCount: () => 0, from: () => undefined, rewelcome: () => {} }
  private msgCounter = 0
  private sayCounter = 0
  /** each chat message's own id (msg_id is shared by a question and its answers), for pins */
  private chatCounter = 0
  private queue: Say[] = []
  private current: Say | null = null
  private lastSay: Say | null = null
  /** says started lately: a phone plays well behind TTS, so a cut-in can name an older one */
  private recentSays = new Map<string, Say>()
  private replays = new Map<string, { text: string; chunks: TtsChunk[] }>()
  /** whatever was last said aloud (system lines too), for the echo filter */
  private lastSpoken: { text: string; at: number } | null = null
  private interrupted: { remainder: string } | null = null
  private playingClients = new Set<string>()
  private transcribing = 0
  private turns = new Map<string, Turn>()
  // streaming clients (phones): mic audio arrives raw and the daemon's VAD finds turns
  private streaming = new Map<string, { bargeIn: boolean; clips: boolean }>()
  private clipCounter = 0
  private positions = new Map<string, Position>()
  private during = new Map<string, Position>()
  private ignoring = new Set<string>()
  // clients whose user is talking right now, and a turn that sounded unfinished
  private hearing = new Set<string>()
  // wake word: hands-free turns reach Claude after the phrase, or in the follow-up
  // window after a reply (openUntil); a turn that began inside the window counts too
  private openUntil = 0
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private openTurns = new Set<string>()
  // a long message with thinking pauses: when each client's turn began, and when its
  // last turn that went to Claude ended (the next part carries on without the phrase)
  private turnStart = new Map<string, number>()
  /** What each device heard lately, and when: the phone and the Mac can both hear you */
  private recentHeard: { clientId: string; text: string; from: number; to: number }[] = []
  private lastToClaude = new Map<string, number>()
  private followUp = false
  private pictures = new Pictures()
  /** "my voice only": your voiceprint and usual loudness, learned as you talk */
  private voiceprint = new Voiceprint(VOICEPRINT_FILE)
  /** screenshots Claude sends to the chat: more of them, kept for a day (still memory only) */
  private sentPictures = new Pictures(30, 24 * 60 * 60_000, undefined, 's')
  /** "Did you mean handfree-ai-fc?" waiting for a yes */
  private guessedSwitch: { session: Session; until: number } | null = null
  private held: { text: string; meta: Record<string, string>; sttMs: number; timer: ReturnType<typeof setTimeout> } | null = null
  /** last time anything was heard or said: voice unloads after config.voiceIdleMin of quiet */
  private lastVoiceUse = Date.now()
  /** Claude pids started from the phone that haven't connected yet */
  private launching = new Set<string>()
  private terminals = new Terminals()
  /** terminal menus waiting for an answer, by session key */
  private menus = new Map<string, OpenMenu>()
  private menuCounter = 0
  /** when each session's screen was last read */
  private menuLook = new Map<string, number>()
  private watchingMenus = false
  /** when Ctrl+C last went to each Terminal-tab session */
  private ctrlC = new Map<string, number>()

  constructor(
    private speech: Speech,
    private config: Config,
    readonly projects = new Projects(),
    private launcher = new Launcher(),
  ) {
    this.approvals = new Approvals({
      getMode: () => this.config.approvalMode,
      setMode: mode => { this.config.approvalMode = mode; saveConfig(this.config) },
      getPassphrase: () => this.config.passphrase,
      speak: text => this.speak(text, { kind: 'system' }),
      broadcast: msg => { this.broadcast(msg); this.updateState() },
      sendVerdict: (req, behavior) => this.sessions.get(req.sessionKey)?.send({ t: 'verdict', request_id: req.request_id, behavior }),
    })
    // the last chats from before a restart (session keys are Claude's pids, so they still match)
    this.history = loadChat(CHAT_FILE).slice(-HISTORY_LIMIT)
    this.msgCounter = lastId(this.history, 'msg_id', 'v')
    this.sayCounter = lastId(this.history, 'say_id', 'say')
    this.chatCounter = lastId(this.history, 'id', 'c')
    speech.onStatus = status => this.onSpeechStatus(status)
    speech.onVad = (clientId, event, pcm16, how) => this.onVad(clientId, event, pcm16, how)
    // a /rename in the terminal shows up on the screens within a few seconds
    setInterval(() => this.refreshNames(), 3000)
    setInterval(() => this.checkIdle(), 60_000)
    setInterval(() => void this.watchMenus(), 3000)
    this.updateState()
  }

  // --- voice on / off: the speech models (~4 GB) load only when asked -------------

  get speechStatus(): SpeechStatus {
    return this.speech.status
  }

  /** Load or unload the speech models, for every device at once. */
  setVoice(on: boolean, by: 'tap' | 'cli') {
    if (on) {
      this.lastVoiceUse = Date.now()
      if (this.speech.status === 'off') console.error(`[handfree] voice on (${by})`)
      return this.speech.start()
    }
    this.voiceOff(by === 'cli' ? 'Voice is off.' : 'Voice is off. Tap Start voice to turn it back on.')
  }

  private voiceOff(why: string) {
    if (this.speech.status === 'off') return
    this.cancelSpeech()
    this.closeWindow(true)
    this.speech.stop()
    this.notice(why)
  }

  private onSpeechStatus(status: SpeechStatus) {
    if (status === 'on') this.lastVoiceUse = Date.now()
    this.hub.broadcast({ t: 'speech', status })
    this.updateState()
  }

  /** Quiet for voiceIdleMin, and no Claude session mid-task: unload the models. */
  private checkIdle() {
    const idleMs = this.config.voiceIdleMin * 60_000
    if (!idleMs || this.speech.status === 'off') return
    if (this.current || this.queue.length || this.playingClients.size || this.hearing.size || this.transcribing || this.held) return this.touchVoice()
    if (this.approvals.pending.size || [...this.sessions.values()].some(s => s.unanswered.size || s.activity.busy)) return this.touchVoice()
    if (Date.now() - this.lastVoiceUse < idleMs) return
    this.voiceOff(`Voice turned off after ${this.config.voiceIdleMin} minutes of quiet. Tap Start voice to turn it back on.`)
  }

  /** Something was heard or said, or Claude is still busy: the idle clock starts over. */
  private touchVoice() {
    this.lastVoiceUse = Date.now()
  }

  private refreshNames() {
    let changed = false
    for (const s of this.sessions.values()) {
      // Claude quit but its shim (from before shims watched for that) still holds the socket
      if (!pidAlive(Number(s.key))) { this.onSession(s, false); continue }
      const label = sessionName(s.infoFile) ?? s.project
      if (label !== s.label) { s.label = label; changed = true }
      const conversation = conversationId(s.infoFile)
      if (conversation && conversation !== s.conversation) { s.conversation = conversation; this.adoptChat(s) }
    }
    if (changed) this.broadcastSessions()
  }

  /**
   * A resumed conversation gets its chat back. Messages carry the session key (Claude's
   * pid, new for every start), so the ones from an earlier run of this conversation
   * move over to this session, and so do its pins.
   */
  private adoptChat(s: Session) {
    if (!s.conversation) return
    let moved = false
    for (const m of this.history as any[]) {
      if (m.session_key === s.key) m.conversation ??= s.conversation // said before the id was known
      else if (m.conversation === s.conversation && !this.sessions.has(m.session_key)) {
        m.session_key = s.key
        m.session = s.label
        moved = true
      }
    }
    let pinsMoved = false
    for (const p of this.pins.list) {
      if (p.session_key === s.key) p.conversation ??= s.conversation
      else if (p.conversation === s.conversation && !this.sessions.has(p.session_key)) {
        p.session_key = s.key
        Object.assign(p.msg, { session_key: s.key, session: s.label })
        pinsMoved = true
      }
    }
    if (moved) saveChat(CHAT_FILE, this.history)
    if (pinsMoved) this.pins.save()
    if (moved || pinsMoved) this.hub.rewelcome()
  }

  /** A screenshot Claude sent, for the screens to load (/picture/<id>). */
  sentPicture(id: string) { return this.sentPictures.find(id) }

  attachHub(hub: Hub) {
    this.hub = hub
  }

  // --- snapshot for a newly connected client ---------------------------------

  welcome() {
    return {
      t: 'welcome',
      state: this.state,
      mode: this.config.approvalMode,
      passphraseSet: !!this.config.passphrase,
      voice: this.config.voice,
      speed: this.config.speed,
      pauseMs: this.config.pauseMs,
      speech: this.speech.info,
      speech_status: this.speech.status,
      sessions: this.sessionList(),
      active: this.activeKey,
      projects: this.projectList(),
      pending: [...this.approvals.pending.values()],
      menus: [...this.menus.values()].map(m => this.menuMessage(m)),
      activity: Object.fromEntries([...this.sessions.values()].map(s => [s.key, s.activity.snapshot()])),
      history: this.history,
      pins: this.pins.list,
      wake: this.wakeState(),
      ...this.voiceConfig(),
      // false: a session started from the phone can stop at a macOS permission popup on the Mac
      full_disk: fullDiskAccess(),
    }
  }

  // --- from clients ------------------------------------------------------------

  async onClientMessage(clientId: string, msg: any) {
    switch (msg.t) {
      case 'utterance': return this.onUtterance(clientId, msg.pcm16, msg.during, typeof msg.clip === 'string' ? msg.clip.slice(0, 16) : undefined, msg.ptt === true ? 'ptt' : undefined)
      case 'text':
        if (typeof msg.text !== 'string' || !msg.text.trim()) return
        this.flushHeld(true)
        return this.sendToClaude(msg.text.trim(), 'text', this.fromMeta(clientId))
      case 'picture_load': {
        // the phone asks for a screenshot Claude sent (the web page loads it over http instead)
        const p = this.sentPictures.find(String(msg.picture))
        return this.hub.sendTo(clientId, p
          ? { t: 'picture_data', picture: p.id, mime: p.mime, data: p.data.toString('base64') }
          : { t: 'picture_data', picture: String(msg.picture), error: 'gone' })
      }
      case 'picture':
        if (typeof msg.data !== 'string') return
        this.flushHeld(true)
        return this.sendPicture(Buffer.from(msg.data, 'base64'), typeof msg.text === 'string' ? msg.text.trim() : '', this.fromMeta(clientId), msg.ref)
      case 'hearing':
        if (msg.on) this.hearing.add(clientId)
        else this.hearing.delete(clientId)
        return
      case 'dropped':
        console.error(`[handfree] turn dropped by the web page: ${String(msg.reason).slice(0, 80)}`)
        return
      case 'approval': return this.approvals.tap(msg.request_id, msg.behavior === 'allow' ? 'allow' : 'deny')
      case 'menu_answer': return this.answerMenu(String(msg.request_id), Number(msg.choice))
      case 'mode': {
        const r = this.approvals.setMode(msg.mode === 'passphrase' ? 'passphrase' : 'tap', 'tap')
        if (!r.ok) this.notice(r.reason!)
        return
      }
      case 'playing':
        if (msg.playing) this.playingClients.add(clientId)
        else this.playingClients.delete(clientId)
        this.maybeFollowUp()
        return this.updateState()
      case 'wake_config': {
        if (typeof msg.on === 'boolean') this.config.wakeWord = msg.on
        const phrase = typeof msg.phrase === 'string' ? msg.phrase.replace(/[^\p{L}' ]+/gu, ' ').replace(/\s+/g, ' ').trim() : ''
        if (phrase && phrase.split(' ').length <= 4) this.config.wakePhrase = phrase
        saveConfig(this.config)
        if (!this.config.wakeWord) this.closeWindow(true)
        return this.hub.broadcast({ t: 'wake', ...this.wakeState() })
      }
      case 'voice_config':
        if (typeof msg.speak_all === 'boolean') { this.config.speakAllSessions = msg.speak_all; saveConfig(this.config) }
        if (['off', 'watch', 'on'].includes(msg.my_voice)) { this.config.myVoice = msg.my_voice; saveConfig(this.config) }
        if (['en', 'rojak', 'auto'].includes(msg.language)) { this.config.language = msg.language; saveConfig(this.config) }
        return this.sendVoiceConfig()
      case 'my_voice_reset':
        this.voiceprint.reset()
        return this.sendVoiceConfig()
      case 'stop_speaking': return this.cancelSpeech()
      case 'replay':
        if (typeof msg.say_id === 'string') this.replay(msg.say_id, clientId)
        return
      case 'stream':
        if (msg.on) this.streaming.set(clientId, { bargeIn: msg.barge_in !== false, clips: msg.clips === true })
        else { this.streaming.delete(clientId); this.speech.vadReset(clientId) }
        return
      case 'pos':
        if (typeof msg.say_id === 'string') this.positions.set(clientId, { say_id: msg.say_id, seq: Number(msg.seq) || 0 })
        return
      case 'select_session':
        if (this.sessions.has(msg.key)) { this.activeKey = msg.key; this.broadcastSessions() }
        return
      case 'pin': {
        // on: the message must still be in the chat; off also works for one that has left it
        const m = (this.history as any[]).find(h => pinRef(h) === msg.ref)
        const changed = m ? this.pins.set(m, msg.on !== false) : msg.on === false && this.pins.unpin(String(msg.ref))
        if (changed) this.hub.broadcast({ t: 'pins', pins: this.pins.list })
        return
      }
      case 'speech':
        return this.setVoice(msg.on === true, 'tap')
      case 'start_session':
        if (typeof msg.cwd === 'string') this.startSession(msg.cwd, { chat: typeof msg.chat === 'string' ? msg.chat : undefined, profile: typeof msg.profile === 'string' ? msg.profile : undefined })
        return
      case 'browse':
        return this.hub.sendTo(clientId, {
          t: 'browse',
          pinned: pinnedFolders(this.config.pinned),
          recent: this.projectList(),
          workspaces: workspaceFolders(this.config.workspaces),
          profiles: profileChoices(this.config),
          full_disk: fullDiskAccess(),
        })
      case 'chats': {
        // a folder's past chats live in the profile's own history: switching profile shows other chats
        const p = typeof msg.cwd === 'string' ? this.startable(msg.cwd, typeof msg.profile === 'string' ? msg.profile : undefined) : undefined
        return this.hub.sendTo(clientId, {
          t: 'chats',
          cwd: msg.cwd,
          profile: p ? profileName(p.configDir, profileChoices(this.config)) : undefined,
          chats: p ? pastChats(p.cwd, p.configDir) : [],
        })
      }
      case 'end_session':
        return this.endSession(String(msg.key))
      case 'rename_session':
        return this.renameSession(String(msg.key), String(msg.name ?? ''))
      case 'interrupt_session':
        return this.interruptSession(String(msg.key))
      case 'forget_project':
        if (this.projects.forget(String(msg.cwd))) this.broadcastProjects()
        return
    }
  }

  onClientGone(clientId: string) {
    this.playingClients.delete(clientId)
    this.hearing.delete(clientId)
    if (this.streaming.delete(clientId)) this.speech.vadReset(clientId)
    this.positions.delete(clientId)
    this.during.delete(clientId)
    this.ignoring.delete(clientId)
    this.turnStart.delete(clientId)
    this.lastToClaude.delete(clientId)
    this.updateState()
  }

  /** Raw mic audio from a streaming client. */
  onAudioFrame(clientId: string, pcm16: string) {
    if (this.streaming.has(clientId)) this.speech.vadAudio(clientId, pcm16)
  }

  private onVad(clientId: string, event: VadEvent, pcm16?: string, how?: TurnEnd) {
    const opts = this.streaming.get(clientId)
    if (!opts) return
    const playing = this.playingClients.has(clientId)
    if (event === 'wait') {
      // a pause, but you sound mid-thought: keep listening, and say so on screen
      if (!this.ignoring.has(clientId)) this.hub.sendTo(clientId, { t: 'wait' })
      return
    }
    if (event === 'start') {
      this.touchVoice()
      if (playing && !opts.bargeIn) { this.ignoring.add(clientId); return }
      this.turnStart.set(clientId, Date.now())
      if (Date.now() < this.openUntil) this.openTurns.add(clientId)
      this.hearing.add(clientId)
      this.hub.sendTo(clientId, { t: 'hearing', on: true })
      const pos = this.positions.get(clientId)
      if (playing && pos) { this.during.set(clientId, pos); this.hub.sendTo(clientId, { t: 'duck' }) }
      return
    }
    this.hub.sendTo(clientId, { t: 'hearing', on: false })
    this.hearing.delete(clientId)
    if (this.ignoring.delete(clientId)) { console.error('[handfree] turn dropped: talked over Claude with barge-in off'); return }
    const during = this.during.get(clientId)
    this.during.delete(clientId)
    if (event === 'misfire') {
      if (during) this.hub.sendTo(clientId, { t: 'unduck' })
      return
    }
    if (during) this.hub.sendTo(clientId, { t: 'pause' })
    this.hub.sendTo(clientId, { t: 'heard' })
    if (!pcm16) {
      if (during) this.hub.sendTo(clientId, { t: 'resume_playback' })
      return
    }
    // the web page keeps your turn in memory for its play button (localhost only)
    let clip: string | undefined
    if (opts.clips) {
      clip = `s${++this.clipCounter}`
      this.hub.sendTo(clientId, { t: 'clip', clip, pcm16 })
    }
    this.onUtterance(clientId, pcm16, during, clip, how, Date.now(), this.turnStart.get(clientId))
  }

  /** A client that paused Claude's voice for this turn only plays again on resume or
   *  stop: whichever way the turn ends, un-pause it unless it really cut Claude off. */
  private async onUtterance(clientId: string, pcm16: string, during?: { say_id: string; seq: number }, clip?: string, how?: TurnEnd, endedAt?: number, startedAt?: number) {
    const turn = { stopped: false }
    try {
      await this.takeUtterance(clientId, pcm16, during, turn, clip, how, endedAt, startedAt)
    } finally {
      if (during && !turn.stopped) this.hub.broadcast({ t: 'resume_playback' })
    }
  }

  private async takeUtterance(clientId: string, pcm16: string, during: { say_id: string; seq: number } | undefined, turn: { stopped: boolean }, clip?: string, how?: TurnEnd, endedAt?: number, startedAt?: number) {
    this.hearing.delete(clientId)
    if (typeof pcm16 !== 'string' || !pcm16) return
    if (this.speech.status === 'off') {
      return this.hub.sendTo(clientId, { t: 'notice', text: 'Voice is off. Tap Start voice first, or type.' })
    }
    this.touchVoice()
    // when you said it (the turn model's times, or arrival time minus the audio's length)
    const to = endedAt ?? Date.now()
    const from = startedAt ?? to - (pcm16.length * 3 / 4 / 2 / 16) // base64 16 kHz 16-bit: ms
    this.transcribing++
    this.updateState()
    let text = ''
    let ms = 0
    let voice: VoiceFeatures | undefined
    try {
      ;({ text, ms, voice } = await this.speech.stt(pcm16, this.sttPrompt(), this.config.myVoice !== 'off', WHISPER_LANGUAGE[this.config.language]))
    } catch (err) {
      if (this.speechStatus !== 'off') this.notice(`Speech-to-text failed: ${(err as Error).message}`)
    } finally {
      this.transcribing--
      this.updateState()
    }
    if (!/[\p{L}\p{N}]/u.test(text)) text = '' // "." or "...": Whisper heard no words
    this.broadcast({ t: 'transcript', text, ms, clip })

    const cutSay = during ? this.recentSays.get(during.say_id) ?? null : null

    if (!text) {
      console.error('[handfree] turn dropped: no words in the audio')
      // the pause you made may still be mid-sentence: give the held part its full wait again
      return this.held && this.rearmHeld()
    }

    // heard by the phone and the Mac at once: the first copy goes on, a later one is dropped
    if (this.heardElsewhere(clientId, text, from, to)) {
      console.error('[handfree] turn dropped: another device already heard it')
      return this.held && this.rearmHeld()
    }

    // "my voice only": someone else talking, or a voice far from the mic
    const device = this.hub.from(clientId) ?? 'web'
    const heard = voice && this.config.myVoice !== 'off' ? this.voiceprint.judge(voice, device) : undefined
    if (heard && drops(heard)) {
      const quote = text.length > 60 ? text.slice(0, 60) + '…' : text
      if (this.config.myVoice === 'on') {
        console.error(`[handfree] turn dropped: ${describe(heard)}`)
        this.notice(`🔇 Not sent, ${describe(heard)}: “${quote}”`)
        return this.sendVoiceConfig()
      }
      this.notice(`👂 Watch only: “${quote}” would not be sent, ${describe(heard)}`)
    }
    // "mm-hmm" while Claude talks, or the mic hearing Claude itself: carry on
    if (cutSay && (isFiller(text) || isEcho(text, cutSay.text))) {
      console.error('[handfree] turn dropped: filler or echo while Claude talked')
      return
    }
    // right after Claude spoke: the mic catching its voice's tail, or Whisper
    // copying its prompt (which ends with Claude's words) over and over
    const spoken = this.current?.text ?? (this.lastSpoken && Date.now() - this.lastSpoken.at < 15_000 ? this.lastSpoken.text : '')
    const cleaned = cleanTranscript(text, spoken)
    if (cleaned !== text) {
      console.error(`[handfree] transcript cleaned: dropped ${cleaned ? 'repeated or echoed sentences' : 'the whole turn (echo)'}`)
      this.broadcast({ t: 'transcript', text: cleaned, ms, clip, cleaned: true })
      if (!cleaned) return
      text = cleaned
    }

    // wake word: talk that isn't for Claude (a chat with a colleague) stays in the room.
    // Push-to-talk, a sentence you're halfway through, the next part of a long message,
    // an answer to an approval prompt and "stop" while Claude talks all skip it.
    const inWindow = this.openTurns.delete(clientId) || Date.now() < this.openUntil
    const lastEnd = this.lastToClaude.get(clientId)
    const continuing = !!(startedAt && lastEnd && startedAt - lastEnd <= this.config.continueMs)
    if (this.config.wakeWord && how !== 'ptt' && !this.held) {
      const rest = stripWake(text, this.config.wakePhrase)
      if (rest === null && !inWindow && !continuing && !(cutSay && parseCommand(text))) {
        if (this.approvals.pending.size && this.approvals.handleUtterance(text)) return
        console.error('[handfree] turn not for Claude: no wake phrase')
        this.hub.sendTo(clientId, { t: 'not_for_claude' })
        return
      }
      if (rest === '') return this.openWindow(WAKE_LISTEN_MS, true) // just "Hey Claude": listen for the next turn
      if (rest) text = rest
    }
    if (endedAt) this.lastToClaude.set(clientId, endedAt) // hands-free only: push-to-talk has no pauses to bridge

    let interruptedAfter: string | undefined
    if (cutSay) {
      const seq = Math.max(0, Math.min(during!.seq, cutSay.sentences.length - 1))
      const heard = cutSay.sentences.slice(0, seq + 1).join(' ')
      interruptedAfter = heard.length > 240 ? '…' + heard.slice(-240) : heard
      const heardIdx = cutSay.text.indexOf(cutSay.sentences[seq] ?? '')
      this.interrupted = heardIdx >= 0 ? { remainder: cutSay.text.slice(heardIdx).trim() } : null
      this.cancelSpeech()
      turn.stopped = true
    }

    const meta: Record<string, string> = { ...this.fromMeta(clientId), ...(interruptedAfter ? { interrupted_after: interruptedAfter } : {}) }

    // it's going to Claude: if it's surely you, the voiceprint learns from it
    if (voice && heard) { this.voiceprint.learn(voice, device, heard); this.sendVoiceConfig() }

    // the rest of a sentence you paused in, or your next sentence
    if (this.held) return this.carryOn(text, meta, ms, how, endedAt)

    if (this.approvals.handleUtterance(text)) return

    const guessed = this.guessedSwitch
    this.guessedSwitch = null
    if (guessed && Date.now() < guessed.until && this.sessions.has(guessed.session.key)) {
      if (isYes(text)) return this.switchSession(guessed.session)
      if (isNo(text)) return this.speak('Okay, staying here.', { kind: 'system' })
    }

    const cmd = parseCommand(text)
    if (cmd) return this.runCommand(cmd)

    const targets = sessionSwitchTargets(text, [...this.sessions.values()])
    if (targets.length === 1) return this.switchSession(targets[0]!)
    if (targets.length > 1) return this.askWhichSession(targets)
    const guess = guessSession(text, [...this.sessions.values()])
    if (guess?.sure) return this.switchSession(guess.session)
    if (guess) {
      this.guessedSwitch = { session: guess.session, until: Date.now() + 30_000 }
      return this.speak(`Did you mean ${guess.session.label}? Say yes to switch.`, { kind: 'system' })
    }

    this.route(text, meta, ms, how, endedAt)
  }

  /** Did another device hear these words over the same few seconds? Remembers this one too. */
  private heardElsewhere(clientId: string, text: string, from: number, to: number): boolean {
    const slack = 3_000
    this.recentHeard = this.recentHeard.filter(h => h.to > Date.now() - 30_000)
    const others = this.recentHeard.filter(h => h.clientId !== clientId && h.from - slack < to && from < h.to + slack)
    if (others.length && heardTwice(text, others.map(h => h.text).join(' '))) return true
    this.recentHeard.push({ clientId, text, from, to })
    return false
  }

  /** Send a voice turn now, or hold it a moment for the rest of what you're saying. */
  private route(text: string, meta: Record<string, string>, sttMs: number, how?: TurnEnd, endedAt?: number) {
    // "do this... switch to <session>": this session gets the words and keeps working, then
    // you're on the other one (a held sentence and the switch would otherwise go to Claude as one)
    const split = splitSwitch(text, [...this.sessions.values()])
    if (split) {
      this.sendToClaude(split.before, 'voice', meta, sttMs)
      return this.switchSession(split.target)
    }
    // dictating rather than asking: a thinking pause between paragraphs gets a longer wait
    const long = text.split(/\s+/).filter(Boolean).length >= LONG_TURN_WORDS
    // the words sound cut off: wait for the rest (unless you were already given the
    // longest pause, or let go of push-to-talk: then you're done)
    if (how !== 'max' && how !== 'ptt' && soundsUnfinished(text)) return this.hold(text, meta, sttMs, long ? Math.max(this.config.holdMs, this.config.longJoinMs) : this.config.holdMs, 'unfinished')
    // the turn model ends a turn after every finished sentence, so "I agree. Let's skip it."
    // would reach Claude as two messages: give you a beat to carry on before sending
    if ((how === 'turn' || (how === 'pause' && long)) && endedAt) {
      const wait = (long ? this.config.longJoinMs : this.config.joinMs) - (Date.now() - endedAt)
      if (wait > 0) return this.hold(text, meta, sttMs, wait, 'join')
    }
    this.sendToClaude(text, 'voice', meta, sttMs)
  }

  // --- unfinished turns: a pause mid-sentence shouldn't send half a thought -------

  private hold(text: string, meta: Record<string, string>, sttMs: number, waitMs: number, why: 'unfinished' | 'join') {
    this.held = { text, meta, sttMs, timer: setTimeout(() => this.flushHeld(), waitMs) }
    if (why === 'join') return // a beat after a finished sentence: nothing to show
    this.hub.broadcast({ t: 'held', text })
    console.error('[handfree] turn held: sounded unfinished')
  }

  private carryOn(text: string, meta: Record<string, string>, sttMs: number, how?: TurnEnd, endedAt?: number) {
    const h = this.held!
    clearTimeout(h.timer)
    this.held = null
    const merged = { ...meta, ...h.meta } // the first piece knows what it interrupted
    this.route(`${h.text} ${text}`, merged, h.sttMs + sttMs, how, endedAt)
  }

  private rearmHeld() {
    clearTimeout(this.held!.timer)
    this.held!.timer = setTimeout(() => this.flushHeld(), this.config.holdMs)
  }

  /** Send the held turn, unless you're still talking (then check again shortly). */
  private flushHeld(now = false) {
    const h = this.held
    if (!h) return
    clearTimeout(h.timer)
    if (!now && (this.hearing.size || this.transcribing)) {
      h.timer = setTimeout(() => this.flushHeld(), 300)
      return
    }
    this.held = null
    this.sendToClaude(h.text, 'voice', h.meta, h.sttMs)
  }

  private runCommand(cmd: Command) {
    this.broadcast({ t: 'command', command: cmd })
    switch (cmd) {
      case 'stop':
        return this.cancelSpeech()
      case 'repeat':
        return this.lastSay ? this.replay(this.lastSay.id) : this.speak('Nothing to repeat yet.', { kind: 'system' })
      case 'go_on': {
        const rest = this.interrupted?.remainder
        this.interrupted = null
        return this.speak(rest || 'Nothing to continue.', { kind: 'system' })
      }
      case 'status':
        return this.speak(this.statusLine(), { kind: 'system' })
      case 'sessions':
        return this.speak(this.sessionsLine(), { kind: 'system' })
      case 'sleep': // "that's all": back to waiting for the wake phrase
        this.followUp = false
        this.lastToClaude.clear()
        return this.closeWindow(false)
      case 'slower':
      case 'faster': {
        const delta = cmd === 'slower' ? -0.1 : 0.1
        this.config.speed = Math.round(Math.min(1.4, Math.max(0.7, this.config.speed + delta)) * 10) / 10
        saveConfig(this.config)
        return this.speak(cmd === 'slower' ? 'Okay, slower.' : 'Okay, faster.', { kind: 'system' })
      }
      case 'hold':
        // "wait" / "hold on": nothing goes to Claude; a half-said turn gets a longer wait
        if (this.held) {
          clearTimeout(this.held.timer)
          this.held.timer = setTimeout(() => this.flushHeld(), this.config.holdMs * 3)
        }
        return
      case 'tap_mode': {
        this.approvals.setMode('tap', 'voice')
        return this.speak('Tap mode is on.', { kind: 'system' })
      }
    }
  }

  private switchSession(s: Session) {
    this.broadcast({ t: 'command', command: 'switch_session', session: s.label })
    if (s.key === this.activeKey) return this.speak(`You're already on ${s.label}.`, { kind: 'system' })
    this.activeKey = s.key
    this.broadcastSessions()
    this.speak(`Switched to ${s.label}.`, { kind: 'system' })
  }

  /** Claude can't switch sessions, so an ambiguous name is answered here rather than passed on. */
  private askWhichSession(targets: Session[]) {
    const labels = targets.map(s => s.label)
    this.speak(`That matches ${labels.length}: ${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}. Say switch to, and the full name.`, { kind: 'system' })
  }

  private sessionsLine(): string {
    const labels = [...this.sessions.values()].map(s => s.key === this.activeKey ? `${s.label}, the one you're on` : s.label)
    if (!labels.length) return 'No Claude session is connected.'
    if (labels.length === 1) return `Just one: ${labels[0]}.`
    return `${labels.length} sessions: ${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}. Say switch to, and a name.`
  }

  private statusLine(): string {
    if (this.approvals.pending.size) return 'Claude is waiting for your approval.'
    const s = this.active()
    if (!s) return 'No Claude session is connected.'
    const oldest = Math.min(...s.unanswered.values(), s.activity.busy ? s.activity.since : Infinity)
    if (Number.isFinite(oldest)) {
      const secs = Math.round((Date.now() - oldest) / 1000)
      const step = s.activity.current()
      return `Still working. It's been ${secs < 90 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`}.`
        + (step ? ` Right now: ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}.` : '')
    }
    return `Idle, connected to ${s.label}. Ready when you are.`
  }

  // --- to Claude ---------------------------------------------------------------

  /** A picture (plus what you typed with it) for the session you're on. Claude gets its id
   *  and looks at it through the picture tool; the screens get a note, not the picture. */
  private sendPicture(data: Buffer, caption: string, meta: Record<string, string>, ref: unknown) {
    const s = this.active()
    if (!s) return this.notice('No Claude session is connected. Start one first, then send the picture.')
    if (!s.pictures) return this.notice(`${s.label} started before pictures worked. End it and start it again (pick it from past chats), then send the picture.`)
    const p = this.pictures.add(data, s.key)
    if ('error' in p) return this.notice(`Couldn't send the picture: ${p.error}.`)
    console.error(`[handfree] picture ${p.id} for ${s.label} (${Math.round(data.length / 1024)} KB, ${p.mime})`)
    this.sendToClaude(caption || 'Have a look at this picture.', 'text', { ...meta, picture: p.id }, undefined, typeof ref === 'string' ? { ref: ref.slice(0, 40) } : {})
  }

  sendToClaude(text: string, via: 'voice' | 'text', meta: Record<string, string> = {}, sttMs?: number, shown: Record<string, string> = {}) {
    const s = this.active()
    if (!s) {
      this.notice('No Claude session is connected. Start one with claude-voice.')
      if (via === 'voice') this.speak('No Claude session is connected. Start one with claude voice.', { kind: 'system' })
      return
    }
    const msgId = `v${++this.msgCounter}`
    // said while Claude is mid-task: a "by the way", answered between steps
    // without dropping the task (and the activity panel keeps showing the task)
    if (s.activity.busy) meta = { ...meta, while_working: 'true' }
    s.unanswered.set(msgId, Date.now())
    this.closeWindow(true) // reopens when the reply has been said
    this.turns.set(msgId, { msgId, session: s.key, sttMs, sentAt: Date.now() })
    s.send({ t: 'inbound', text, meta: { msg_id: msgId, ...meta } })
    if (!meta.while_working) {
      s.activity.apply({ event: 'prompt' })
      this.hub.broadcast({ t: 'activity', session: s.key, ...s.activity.snapshot() })
    }
    this.broadcast({ t: 'user', msg_id: msgId, text, via, session: s.label, session_key: s.key, ...meta, ...shown })
    this.updateState()
  }

  // --- from channel shims ------------------------------------------------------

  onSession(s: Session, connected: boolean) {
    if (connected) {
      this.sessions.set(s.key, s)
      this.activeKey = s.key
      s.tmux = this.launcher.tmuxName(s.key)
      // started at the Mac: Stop, Rename and End work too when its Terminal tab can be reached
      if (!s.tmux) void this.terminals.find(s.key).then(ok => { if (ok && this.sessions.get(s.key) === s) this.broadcastSessions() })
      this.projects.remember(s.cwd, s.configDir, s.launchArgs)
      this.adoptChat(s)
      this.broadcastProjects()
      console.error(`[handfree] session connected: ${s.label} (pid ${s.key}${s.tmux ? `, tmux ${s.tmux}` : ''})`)
      if (this.launching.delete(s.key)) this.notice(`${s.label} is ready.`)
      // after the handshake, so a big repo never delays connecting
      setTimeout(() => {
        try { s.words = projectWords(s.cwd) } catch {}
        console.error(`[handfree] ${s.words.length} project words for speech recognition`)
      }, 0)
    } else {
      if (this.sessions.get(s.key) !== s) return
      this.sessions.delete(s.key)
      this.approvals.resolvedElsewhere(s.key)
      this.closeMenu(s.key, { via: 'terminal' })
      this.terminals.forget(s.key)
      this.menuLook.delete(s.key)
      this.ctrlC.delete(s.key)
      if (this.activeKey === s.key) this.activeKey = [...this.sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt)[0]?.key ?? null
      console.error(`[handfree] session disconnected: ${s.label} (pid ${s.key})`)
    }
    this.launcher.stayAwake(this.sessions.size > 0)
    this.broadcastSessions()
    this.updateState()
  }

  onShimMessage(s: Session, msg: any, respond: (m: object) => void) {
    switch (msg.t) {
      case 'reply': {
        respond({ t: 'ack', id: msg.id, delivered: this.hub.clientCount() > 0 })
        this.approvals.resolvedElsewhere(s.key)
        const turn = this.turns.get(msg.in_reply_to)
        if (turn && turn.firstReplyMs == null) turn.firstReplyMs = Date.now() - turn.sentAt
        if (msg.kind === 'final') {
          s.unanswered.delete(msg.in_reply_to)
          if (turn) turn.finalMs = Date.now() - turn.sentAt
        }
        const sayId = msg.speak?.trim() ? this.nextSayId() : undefined
        this.broadcast({ t: 'reply', msg_id: msg.in_reply_to, kind: msg.kind, speak: msg.speak, session: s.label, session_key: s.key, say_id: sayId })
        if (this.voiced(s)) this.speak(msg.speak, { id: sayId, msgId: msg.in_reply_to, kind: msg.kind })
        return this.updateState()
      }
      case 'show':
        respond({ t: 'ack', id: msg.id, delivered: this.hub.clientCount() > 0 })
        this.approvals.resolvedElsewhere(s.key)
        return this.broadcast({ t: 'show', msg_id: msg.in_reply_to, markdown: msg.markdown, session: s.label, session_key: s.key })
      case 'picture_send': {
        const p = this.sentPictures.add(Buffer.from(String(msg.data ?? ''), 'base64'), s.key)
        if ('error' in p) return respond({ t: 'ack', id: msg.id, delivered: false, error: p.error })
        respond({ t: 'ack', id: msg.id, delivered: this.hub.clientCount() > 0 })
        this.approvals.resolvedElsewhere(s.key)
        const caption = typeof msg.caption === 'string' ? msg.caption.trim().slice(0, 500) : ''
        return this.broadcast({ t: 'picture', msg_id: msg.in_reply_to, picture: p.id, ...(caption ? { caption } : {}), session: s.label, session_key: s.key })
      }
      case 'picture_get': {
        const p = this.pictures.get(String(msg.picture), s.key)
        return respond(p
          ? { t: 'ack', id: msg.id, delivered: true, mime: p.mime, data: p.data.toString('base64') }
          : { t: 'ack', id: msg.id, delivered: false, error: 'no such picture: it was sent to another session, or it is over an hour old, or the daemon restarted since' })
      }
      case 'perm_request': {
        const req: PermissionRequest = {
          request_id: String(msg.request_id),
          tool_name: String(msg.tool_name),
          description: String(msg.description),
          input_preview: String(msg.input_preview),
          sessionKey: s.key,
          createdAt: Date.now(),
        }
        return this.approvals.request(req)
      }
    }
  }

  private hookSession(msg: { pids?: string[]; cwd?: string }): Session | undefined {
    return [...this.sessions.values()].find(x => msg.pids?.includes(x.key))
      ?? [...this.sessions.values()].find(x => x.cwd === msg.cwd)
  }

  /** A tool started or finished, or a prompt was typed in the terminal. */
  onHookActivity(msg: ActivityEvent & { pids: string[]; cwd: string }) {
    const s = this.hookSession(msg)
    if (s?.activity.apply(msg)) this.broadcastActivity(s)
  }

  private broadcastActivity(s: Session) {
    // live only, not replayed: a client that connects later gets the snapshot in welcome
    this.hub.broadcast({ t: 'activity', session: s.key, ...s.activity.snapshot() })
    this.updateState()
  }

  /** Claude finished a turn. If a voice message got no spoken answer, cover for it. */
  onHookStop(msg: { pids: string[]; cwd: string; last_message?: string; transcript_path?: string; error?: string }) {
    const s = this.hookSession(msg)
    if (s?.activity.apply({ event: 'stop' })) this.broadcastActivity(s)
    // an API error ended the turn (the safety check, a rate limit...): its message is the answer
    if (s && msg.error) {
      const text = `${s.label} stopped: ${msg.error}`
      this.broadcast({ t: 'notice', text, session_key: s.key })
      if (this.voiced(s)) this.speak(`${s.label} stopped with an error. It's on your screen.`, { kind: 'system' })
      s.unanswered.clear()
      return this.updateState()
    }
    if (!s || s.unanswered.size === 0) return
    const msgId = [...s.unanswered.keys()].at(-1)!
    s.unanswered.clear()
    const last = msg.last_message?.trim() || lastAssistantText(msg.transcript_path)
    if (last) this.broadcast({ t: 'show', msg_id: msgId, markdown: last, session: s.label, session_key: s.key, fallback: true })
    if (this.voiced(s)) this.speak(last ? ANSWERED_IN_TERMINAL : 'Claude finished, but I could not find its answer.', { msgId, kind: 'system' })
    this.updateState()
  }

  // --- menus in the terminal ----------------------------------------------------

  /** Read the screens of sessions that went quiet mid-task, and of those showing a menu. */
  private async watchMenus() {
    if (this.watchingMenus) return
    this.watchingMenus = true
    try {
      const now = Date.now()
      for (const s of [...this.sessions.values()]) {
        const open = this.menus.get(s.key)
        const quiet = now - s.activity.lastAt
        if (!open) {
          const since = now - (this.menuLook.get(s.key) ?? 0)
          // idle sessions too, now and then: a menu from before a daemon restart
          if (!s.unanswered.size && !s.activity.busy) { if (since < MENU_IDLE_LOOK_MS) continue }
          else if (quiet < MENU_QUIET_MS || (quiet > MENU_SLOW_MS && since < 15_000)) continue
          // a tool's permission prompt already has its own card
          if ([...this.approvals.pending.values()].some(r => r.sessionKey === s.key)) continue
        }
        this.menuLook.set(s.key, now)
        const screen = await this.terminals.screen(s.key)
        if (!this.sessions.has(s.key)) continue
        const menu = screen ? parseMenu(screen) : undefined
        if (open && menu && sameMenu(open.menu, menu)) { open.menu.selected = menu.selected; continue }
        if (open) this.closeMenu(s.key, { via: 'terminal' })
        if (menu) this.openMenu(s, menu)
      }
    } finally {
      this.watchingMenus = false
    }
  }

  private openMenu(s: Session, menu: Menu) {
    const m: OpenMenu = { request_id: `m${++this.menuCounter}`, sessionKey: s.key, menu }
    this.menus.set(s.key, m)
    console.error(`[handfree] menu in ${s.label}: ${menu.title.split('\n')[0]}`)
    this.broadcast(this.menuMessage(m))
    if (this.voiced(s)) this.speak(`${s.label} is asking in the terminal. Pick an option on your screen.`, { kind: 'system' })
    this.updateState()
  }

  private menuMessage(m: OpenMenu) {
    const s = this.sessions.get(m.sessionKey)
    return { t: 'menu_request', request_id: m.request_id, title: m.menu.title, options: m.menu.options, session: s?.label, session_key: m.sessionKey }
  }

  private closeMenu(sessionKey: string, how: { via: 'tap' | 'terminal'; label?: string }) {
    const m = this.menus.get(sessionKey)
    if (!m) return
    this.menus.delete(sessionKey)
    this.broadcast({ t: 'menu_resolved', request_id: m.request_id, via: how.via, label: how.label, session_key: sessionKey })
    this.updateState()
  }

  /** A tap on an option: check the menu is still there, then pick it in the terminal. */
  private async answerMenu(requestId: string, choice: number) {
    const m = [...this.menus.values()].find(x => x.request_id === requestId)
    if (!m || !Number.isInteger(choice) || !m.menu.options[choice]) return
    const screen = await this.terminals.screen(m.sessionKey)
    const now = screen ? parseMenu(screen) : undefined
    if (this.menus.get(m.sessionKey) !== m) return // answered meanwhile
    if (!now || !sameMenu(now, m.menu)) return this.closeMenu(m.sessionKey, { via: 'terminal' })
    if (!(await this.terminals.choose(m.sessionKey, now.selected, choice))) {
      return this.notice("Couldn't reach that terminal. Answer it at the Mac.")
    }
    // give Claude a moment to move on before the screen is read again
    const s = this.sessions.get(m.sessionKey)
    if (s) s.activity.lastAt = Date.now()
    this.closeMenu(m.sessionKey, { via: 'tap', label: m.menu.options[choice]!.label })
  }

  // --- speech out --------------------------------------------------------------

  /** Whether this session's replies are spoken: all of them, or (setting off) only the one you're talking to. */
  private voiced(s: Session) {
    return this.config.speakAllSessions || s.key === this.activeKey
  }

  speak(text: string, opts: { id?: string; msgId?: string; kind: string; to?: string; replayOf?: string; kept?: TtsChunk[] }) {
    // voice off: replies still reach the screens as text, they just aren't spoken
    if (!text.trim() || this.speech.status === 'off') return
    const { id = this.nextSayId(), ...rest } = opts
    this.queue.push({ id, ...rest, text, sentences: [] })
    this.pump()
  }

  private voiceConfig() {
    return { speak_all: this.config.speakAllSessions, language: this.config.language, my_voice: this.config.myVoice, my_voice_info: this.voiceprint.summary() }
  }

  private sendVoiceConfig() {
    this.hub.broadcast({ t: 'voice_config', ...this.voiceConfig() })
  }

  private fromMeta(clientId: string): Record<string, string> {
    const from = this.hub.from(clientId)
    return from ? { from } : {}
  }

  private nextSayId() {
    return `say${++this.sayCounter}`
  }

  /** Say a reply again, queued like any speech: its exact audio if it's still in
   *  memory, else fresh TTS from the text. `to` limits it to the client that asked. */
  replay(sayId: string, to?: string) {
    const kept = this.replays.get(sayId)
    const text = kept?.text ?? (this.history as any[]).find(h => h.t === 'reply' && h.say_id === sayId)?.speak
    if (!text) return to ? this.hub.sendTo(to, { t: 'notice', text: 'That reply is too old to replay.' }) : undefined
    if (this.speech.status === 'off') return to ? this.hub.sendTo(to, { t: 'notice', text: 'Voice is off. Tap Start voice to hear replies.' }) : undefined
    this.speak(text, { kind: 'replay', to, replayOf: sayId, kept: kept?.chunks })
  }

  cancelSpeech() {
    this.queue = []
    this.current?.cancel?.()
    this.hub.broadcast({ t: 'stop_playback' })
  }

  private async pump() {
    if (this.current || !this.queue.length) return
    const say = this.queue.shift()!
    this.current = say
    this.touchVoice()
    this.recentSays.set(say.id, say)
    if (this.recentSays.size > REPLAY_LIMIT) this.recentSays.delete(this.recentSays.keys().next().value!)
    const out = (msg: object) => say.to ? this.hub.sendTo(say.to, msg) : this.hub.broadcast(msg)
    out({ t: 'say_start', say_id: say.id, msg_id: say.msgId, kind: say.kind, text: say.text })
    // wake word on: Claude answering locks the mic again, so talk in the room doesn't slip
    // in as "the rest of your message". Your next turn starts with the phrase again
    if (this.config.wakeWord && say.kind !== 'system') this.lastToClaude.clear()
    this.updateState()
    try {
      const turn = say.msgId ? this.turns.get(say.msgId) : undefined
      const send = (chunk: TtsChunk) => {
        say.sentences[chunk.seq] = chunk.text
        out({ t: 'audio', say_id: say.id, seq: chunk.seq, rate: chunk.rate, pcm16: chunk.pcm16, text: chunk.text })
      }
      let cancelled = false
      if (say.kept) {
        say.kept.forEach(send)
      } else {
        say.audio = []
        const job = this.speech.tts(say.text, { voice: this.config.voice, speed: this.config.speed }, chunk => { say.audio!.push(chunk); send(chunk) })
        say.cancel = job.cancel
        const result = await job.done
        cancelled = result.cancelled
        if (turn && say.kind === 'final' && turn.ttsFirstMs == null) {
          turn.ttsFirstMs = result.first_ms ?? undefined
          this.broadcast({ t: 'metrics', msg_id: turn.msgId, session_key: turn.session, stt_ms: turn.sttMs, claude_first_ms: turn.firstReplyMs, claude_final_ms: turn.finalMs, tts_first_ms: turn.ttsFirstMs })
          this.turns.delete(turn.msgId)
        }
        // Claude's replies stay replayable (in memory only); a cut-off one gets fresh TTS next time
        if (!cancelled && say.kind !== 'system') this.keepAudio(say.replayOf ?? say.id, say.text, say.audio)
      }
      out({ t: 'say_end', say_id: say.id, cancelled })
    } catch (err) {
      if (this.speech.status !== 'off') this.notice(`Text-to-speech failed: ${(err as Error).message}`) // not when voice was just turned off
      out({ t: 'say_end', say_id: say.id, cancelled: true })
    } finally {
      // "repeat that" means Claude's last words, not the daemon's own "Okay, slower."
      if (say.kind !== 'system' && !say.replayOf) this.lastSay = say
      this.lastSpoken = { text: say.text, at: Date.now() }
      // an answer (not "on it" or a progress note) opens the follow-up window once it's been heard
      if (say.kind !== 'ack' && say.kind !== 'update') this.followUp = true
      this.current = null
      this.updateState()
      this.pump()
      this.maybeFollowUp()
    }
  }

  // --- wake word ------------------------------------------------------------------

  wakeState() {
    return { on: this.config.wakeWord, phrase: this.config.wakePhrase, open: Date.now() < this.openUntil, follow_up_ms: this.config.followUpMs }
  }

  /** Claude's answer has finished playing everywhere: you can reply without the phrase. */
  private maybeFollowUp() {
    if (!this.followUp || this.current || this.queue.length || this.playingClients.size) return
    this.followUp = false
    if (this.config.wakeWord && this.config.followUpMs > 0) this.openWindow(this.config.followUpMs, false)
  }

  private openWindow(ms: number, woken: boolean) {
    this.openUntil = Date.now() + ms
    if (this.openTimer) clearTimeout(this.openTimer)
    const expire = () => {
      // still talking at the deadline: that turn counts, close once you're done
      if (this.hearing.size) { this.openTimer = setTimeout(expire, 1000); return }
      this.closeWindow(false)
    }
    this.openTimer = setTimeout(expire, ms)
    this.hub.broadcast({ t: 'wake', ...this.wakeState(), woken })
  }

  /** quiet: closed because a turn went to Claude, not because the window ran out */
  private closeWindow(quiet: boolean) {
    const wasOpen = this.openTimer !== null
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
    this.openUntil = 0
    if (wasOpen) this.hub.broadcast({ t: 'wake', ...this.wakeState(), quiet })
  }

  private keepAudio(sayId: string, text: string, chunks: TtsChunk[]) {
    this.replays.delete(sayId)
    this.replays.set(sayId, { text, chunks })
    while (this.replays.size > REPLAY_LIMIT) this.replays.delete(this.replays.keys().next().value!)
  }

  // --- state + plumbing ----------------------------------------------------------

  active(): Session | undefined {
    return this.activeKey ? this.sessions.get(this.activeKey) : undefined
  }

  /** Whisper reads its prompt as the text just before your words, so it gets a
   *  natural sentence (a bare word list leaks into transcripts as "Claude: …")
   *  plus the last thing Claude said, which makes replies like "what do you think?" likely. */
  private sttPrompt(): string {
    const s = this.active()
    // the other sessions' names too, so "switch to web app" is heard right
    const names = [...this.sessions.values()].filter(x => x !== s).map(x => x.label.replace(/[-_]+/g, ' '))
    // not the wake phrase: Whisper skips words it was just "told", and drops "Hey Claude" from your turn
    const words = [...new Set([...this.config.vocabulary, ...(s?.words ?? []), ...names].filter(Boolean))]
    let prompt = `I'm talking with Claude${s ? ` about ${s.label}` : ''}${words.length ? `: ${words.join(', ')}` : ''}.`
    if (this.config.language === 'rojak') prompt = `${ROJAK_EXAMPLE} ${prompt}`
    const said = (this.current ?? this.lastSay)?.text
    // no speaker label: Whisper copies labels like "Claude said:" into the transcript
    if (said) prompt += ` ${said.length > 300 ? '…' + said.slice(-300) : said}`
    return prompt
  }

  private sessionList() {
    return [...this.sessions.values()].map(s => ({ key: s.key, label: s.label, project: s.project, cwd: s.cwd, connectedAt: s.connectedAt, can_end: !!s.tmux || this.terminals.reachable(s.key) }))
  }

  // --- sessions started from the phone -----------------------------------------------

  private projectList() {
    return this.projects.list.map(p => ({ cwd: p.cwd, name: p.name, last_used: p.lastUsed }))
  }

  private broadcastProjects() {
    this.hub.broadcast({ t: 'projects', projects: this.projectList() })
  }

  /** A folder a session may be started in: one from the recent list, a pinned one, or a
   *  project directly inside a workspace from the config (never any other path a client sends).
   *  Its profile is the one asked for (from the config's list), else pinned, recent, workspace. */
  private startable(cwd: string, profile?: string): Project | undefined {
    const recent = this.projects.get(cwd)
    const pin = pinnedFor(cwd, this.config.pinned)
    const ws = workspaceFor(cwd, this.config.workspaces)
    if (!recent && !pin && !ws) return undefined
    const p: Project = recent ?? { cwd, name: cwd.split('/').at(-1)!, configDir: profileDir(ws?.profile ?? ''), args: [], lastUsed: 0 }
    const pick = profile && profileChoices(this.config).includes(profile) ? profile : pin?.profile
    return pick ? { ...p, configDir: profileDir(pick) } : p
  }

  /** Start claude-voice in a listed folder: a new chat, or a past one by id. */
  private async startSession(cwd: string, opts: { chat?: string; profile?: string }) {
    const p = this.startable(cwd, opts.profile)
    if (!p) return this.notice('That folder isn\'t on the list. Start a voice session there from the Mac once, or add it to pinned or workspaces in the config.')
    // only a chat that's really in this folder's history
    const chat = opts.chat ? pastChats(p.cwd, p.configDir, 200).find(c => c.id === opts.chat) : undefined
    if (opts.chat && !chat) return this.notice(`That chat isn't in ${p.name}'s history any more.`)
    this.notice(`Starting a session in ${p.name} (${profileName(p.configDir, profileChoices(this.config))})${chat ? `, back in "${chat.title}"` : ''}…`)
    // Claude asks whether you trust a folder it hasn't opened: yes, for your pinned folders and workspaces only
    const trust = !!pinnedFor(cwd, this.config.pinned) || !!workspaceFor(cwd, this.config.workspaces)
    const r = await this.launcher.start(p, { chat: chat?.id, trust })
    if (!r.ok) return this.notice(`Couldn't start ${p.name}: ${r.error}`)
    console.error(`[handfree] started ${p.name} in tmux ${r.name} (pid ${r.pid})`)
    if (this.sessions.has(r.pid)) return
    this.launching.add(r.pid)
    setTimeout(() => {
      if (this.launching.delete(r.pid)) this.notice(`${p.name} didn't connect within a minute. On the Mac: tmux attach -t ${r.name}`)
    }, 60_000)
  }

  private async endSession(key: string) {
    const s = this.sessions.get(key)
    if (!s) return
    if (s.tmux) {
      this.notice(`Ending ${s.label}…`)
      return this.launcher.end(s.tmux)
    }
    if (!this.terminals.reachable(s.key)) return this.notice(`${s.label} runs outside Terminal and tmux. End it at the Mac with /exit.`)
    this.notice(`Ending ${s.label}…`)
    // mid-task, stop it first (as the tmux end does with Esc), else /exit waits in the prompt
    if (s.unanswered.size || s.activity.busy) { await this.terminals.interrupt(s.key); await Bun.sleep(800) }
    if (!(await this.terminals.exit(s.key))) this.notice(`Couldn't reach ${s.label}'s terminal. End it at the Mac with /exit.`)
  }

  /** Esc from the phone. Claude doesn't run its Stop hook when interrupted, so its
   *  turn is closed here: nothing left to answer, not busy any more. */
  private async interruptSession(key: string) {
    const s = this.sessions.get(key)
    if (!s) return
    if (s.tmux) this.launcher.interrupt(s.tmux)
    else if (!this.terminals.reachable(s.key)) return this.notice(`${s.label} runs outside Terminal and tmux. Press Esc there to stop it.`)
    else {
      // a Terminal tab gets Ctrl+C, and Ctrl+C twice on an idle Claude quits it: so only
      // while it works, and once in a few seconds (a double tap stays one Stop)
      if (!s.unanswered.size && !s.activity.busy) return this.notice(`${s.label} isn't doing anything right now.`)
      const last = this.ctrlC.get(s.key) ?? 0
      if (Date.now() - last < 3000) return
      this.ctrlC.set(s.key, Date.now())
      if (!(await this.terminals.interrupt(s.key))) return this.notice(`Couldn't reach ${s.label}'s terminal. Press Esc there.`)
    }
    this.notice(`Stopped ${s.label}.`)
    s.unanswered.clear()
    if (s.activity.apply({ event: 'stop' })) this.broadcastActivity(s)
    this.updateState()
  }

  /** The name shows on every screen once Claude Code saves it (refreshNames, within a few seconds). */
  private renameSession(key: string, name: string) {
    const s = this.sessions.get(key)
    if (!s) return
    if (!s.tmux && !this.terminals.reachable(s.key)) return this.notice(`${s.label} runs outside Terminal and tmux. At the Mac: /rename`)
    const title = cleanTitle(name)
    if (!title) return
    if (s.unanswered.size || s.activity.busy) return this.notice(`${s.label} is busy. Rename it once Claude is done.`)
    if (s.tmux) this.launcher.rename(s.tmux, title)
    else void this.terminals.type(s.key, `/rename ${title}`)
  }

  private broadcastSessions() {
    this.hub.broadcast({ t: 'sessions', sessions: this.sessionList(), active: this.activeKey })
  }

  /** Broadcast and keep in the replay history for clients that connect later. */
  private broadcast(msg: object) {
    const key = (msg as { session_key?: string }).session_key
    const conversation = key ? this.sessions.get(key)?.conversation : undefined
    const stamped = { ...msg, ...(key && { id: `c${++this.chatCounter}` }), ...(conversation && { conversation }), at: Date.now() }
    this.history.push(stamped)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    this.hub.broadcast(stamped)
    if ('session_key' in msg) saveChat(CHAT_FILE, this.history)
  }

  notice(text: string) {
    console.error(`[handfree] ${text}`)
    this.broadcast({ t: 'notice', text })
  }

  updateState() {
    const next: State = this.speech.status === 'loading' ? 'starting'
      : this.approvals.pending.size || this.menus.size ? 'approval'
      : this.current || this.playingClients.size ? 'speaking'
      : this.transcribing ? 'transcribing'
      : [...this.sessions.values()].some(s => s.unanswered.size || s.activity.busy) ? 'working'
      : 'idle'
    if (next !== this.state) {
      this.state = next
      this.hub.broadcast({ t: 'state', state: next })
    }
  }
}

/** True when a transcript is mostly Claude's own words coming back through the mic. */
export function isEcho(heard: string, spoken: string): boolean {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(w => w.length > 2)
  const h = words(heard)
  if (h.length < 3) return false
  const said = new Set(words(spoken))
  return h.filter(w => said.has(w)).length / h.length >= 0.7
}

/** Last assistant text in a Claude Code transcript (JSONL), for the Stop-hook fallback. */
export function lastAssistantText(path?: string): string | undefined {
  if (!path) return undefined
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
      const o = JSON.parse(lines[i]!)
      if (o.type !== 'assistant') continue
      const parts = (o.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text)
      if (parts.length) return parts.join('\n\n')
    }
  } catch {}
  return undefined
}
