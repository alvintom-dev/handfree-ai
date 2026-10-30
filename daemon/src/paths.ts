// Where handfree keeps its state, and the small config file in it.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dir, '../..')
export const HOME = process.env.HANDFREE_HOME ?? join(homedir(), '.handfree')
export const SOCKET = process.platform === 'win32' ? '\\\\.\\pipe\\handfree-daemon' : join(HOME, 'daemon.sock')
export const SECRET_FILE = join(HOME, 'secret')
export const CONFIG_FILE = join(HOME, 'config.json')
export const LOG_DIR = join(HOME, 'logs')
export const VOICEPRINT_FILE = join(HOME, 'voiceprint.json')
export const CHAT_FILE = join(HOME, 'chat.json')
export const PINS_FILE = join(HOME, 'pins.json')

export type ApprovalMode = 'tap' | 'passphrase'

/** A folder of projects the phone can start sessions in, and the Claude profile they use
 *  (a name as for claude-voice --which-claude: default, work, personal, …). */
export type Workspace = { path: string; profile: string }

/** A folder you start sessions in often, shown first on the phone; profile is the one picked by default. */
export type PinnedFolder = { path: string; profile?: string }

export type Config = {
  port: number
  /** TLS port for paired phones on the LAN */
  lanPort: number
  /** also accept Tailscale (100.64/10) addresses on the LAN port */
  allowTailscale: boolean
  /** auto picks qwen3 (GPU) on Apple Silicon, kokoro (CPU) elsewhere */
  ttsEngine: 'auto' | 'qwen3' | 'kokoro'
  /** engine voice name; empty uses the engine's default (qwen3: aiden, kokoro: af_heart) */
  voice: string
  /** speaking-style instruction for engines that take one (qwen3) */
  voiceStyle: string
  speed: number
  /** a pause this long (ms) ends your turn */
  pauseMs: number
  /** with the turn model: the longest pause while you sound mid-thought */
  maxPauseMs: number
  /** a turn that sounds unfinished (no . ? !) waits this long (ms) for you to carry on */
  holdMs: number
  /** after a finished sentence, how long (ms from the end of your words) a next sentence still joins the same message */
  joinMs: number
  /** joinMs for a long turn (dictating, not a quick question): a thinking pause between
   *  paragraphs shouldn't split one message into many */
  longJoinMs: number
  /** with the wake word: a hands-free turn that starts within this long (ms) after your
   *  last one went to Claude carries on without the phrase */
  continueMs: number
  /** Words Whisper should expect (project names, Malay domain terms). */
  vocabulary: string[]
  /** what you speak: English, rojak (Malaysian Malay and English mixed) or auto (Whisper guesses per turn) */
  language: 'en' | 'rojak' | 'auto'
  approvalMode: ApprovalMode
  /** hands-free turns reach Claude only after the wake phrase (push-to-talk and typing always do) */
  wakeWord: boolean
  wakePhrase: string
  /** after Claude's reply, how long (ms) you can answer without the wake phrase
   *  (0: none, the mic locks again and every turn starts with the phrase) */
  followUpMs: number
  /** speak replies from every session; off: only from the one you're talking to
   *  (the others still show as text, with a replay button) */
  speakAllSessions: boolean
  /** "my voice only": off (everything heard counts), watch (note what it would drop) or on
   *  (drop voices that aren't yours or are far from the mic) */
  myVoice: 'off' | 'watch' | 'on'
  /** unload the speech models after this many minutes with nothing heard or said
   *  and no Claude session working (0 = never) */
  voiceIdleMin: number
  /** the phone lists the projects one level inside each; Claude's "trust this folder"
   *  question is answered yes only there. The most specific workspace wins. */
  workspaces: Workspace[]
  /** your own list of folders for the phone's Pinned tab (any folder, a workspace itself too);
   *  trusted like workspace projects */
  pinned: PinnedFolder[]
  /** the Claude profiles the phone can pick from when it starts a session (default, work, personal, …);
   *  empty: the ones the workspaces and pinned folders name */
  profiles: string[]
  passphrase?: { salt: string; hash: string }
}

const DEFAULTS: Config = {
  port: 8790,
  lanPort: 8791,
  allowTailscale: false,
  ttsEngine: 'auto',
  voice: '',
  voiceStyle: 'Relaxed, warm and conversational, like explaining something to a colleague sitting next to you.',
  speed: 1.0,
  pauseMs: 1200,
  maxPauseMs: 3000,
  holdMs: 2000,
  joinMs: 1000,
  longJoinMs: 3000,
  continueMs: 6000,
  vocabulary: [],
  language: 'en',
  approvalMode: 'tap',
  wakeWord: true,
  wakePhrase: 'Hey Claude',
  followUpMs: 0,
  speakAllSessions: true,
  myVoice: 'off',
  voiceIdleMin: 30,
  workspaces: [],
  pinned: [],
  profiles: [],
}

export function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
}

/** Shared secret between the daemon, channel shims and hooks. Readable only by you. */
export function loadSecret(create = false): string {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim()
  if (!create) throw new Error(`no secret at ${SECRET_FILE}; is the daemon set up?`)
  ensureHome()
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
  writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 })
  return secret
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  } catch (err) {
    console.error(`[handfree] ignoring unreadable ${CONFIG_FILE}:`, err)
    return { ...DEFAULTS }
  }
}

export function saveConfig(config: Config) {
  ensureHome()
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  chmodSync(CONFIG_FILE, 0o600)
}
