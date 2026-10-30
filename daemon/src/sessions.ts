// Local socket for channel shims (one per Claude Code session), the Stop hook
// and the CLI. JSON lines; the first line must carry the shared secret.

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Socket } from 'bun'
import { Activity, type ActivityEvent } from './activity'
import { SOCKET } from './paths'

export type Session = {
  key: string // the Claude Code process id, shared by its shim and its hooks
  cwd: string
  /** the session's name in Claude Code (its own or from /rename), else the project folder */
  label: string
  /** the project folder's name */
  project: string
  /** Claude Code's file for this process, which holds the session's name */
  infoFile: string
  /** Claude Code's id for the conversation, the same after --resume (the process, and so key, is new) */
  conversation?: string
  /** CLAUDE_CONFIG_DIR of the session (the Claude profile); unset is the default one */
  configDir?: string
  /** the extra claude flags claude-voice was started with, to start the next one the same way */
  launchArgs: string[]
  /** the tmux session it runs in, when the phone started it (then the phone can end it) */
  tmux?: string
  connectedAt: number
  /** voice messages sent to Claude that haven't had a final reply yet */
  unanswered: Map<string, number>
  /** what Claude is doing right now, from the tool hooks */
  activity: Activity
  /** unusual names from the project, for the speech recognizer (filled in after connect) */
  words: string[]
  /** its shim has the picture tool (older shims, in sessions started before it existed, don't) */
  pictures: boolean
  send: (msg: object) => void
}

export type SessionEvents = {
  onSession: (s: Session, connected: boolean) => void
  onShimMessage: (s: Session, msg: any, respond: (msg: object) => void) => void
  onHookStop: (msg: { pids: string[]; cwd: string; last_message?: string; transcript_path?: string }) => void
  onHookActivity: (msg: ActivityEvent & { pids: string[]; cwd: string }) => void
  onCli: (msg: any, respond: (msg: object) => void) => void
}

type Conn = { buf: string; out: Outbox; role?: 'shim' | 'hook' | 'cli'; session?: Session }

/**
 * Bun's socket write sends only what fits in the socket buffer right now (8 KB on
 * macOS) and drops the rest, which cut pictures short and spoiled the next message.
 * What doesn't fit waits here and goes out on drain.
 */
export class Outbox {
  private rest: Buffer | null = null
  constructor(private sock: { write(data: Uint8Array): number }) {}

  send(msg: object) {
    const line = Buffer.from(JSON.stringify(msg) + '\n')
    this.rest = this.rest ? Buffer.concat([this.rest, line]) : line
    this.drain()
  }

  /** Call from the socket's drain handler. */
  drain() {
    if (!this.rest) return
    const n = this.sock.write(this.rest)
    this.rest = n >= this.rest.length ? null : this.rest.subarray(Math.max(n, 0))
  }
}

export function listenSessions(secret: string, events: SessionEvents) {
  if (process.platform !== 'win32' && existsSync(SOCKET)) unlinkSync(SOCKET)

  const write = (sock: Socket<Conn>, msg: object) => sock.data.out.send(msg)

  function handle(sock: Socket<Conn>, msg: any) {
    const conn = sock.data
    if (!conn.role) {
      if (msg?.t !== 'hello' || msg.secret !== secret) {
        write(sock, { t: 'error', message: 'bad hello' })
        return sock.end()
      }
      conn.role = msg.role
      // a shim left behind by a Claude that quit (Esc on the resume picker): its pid is
      // gone or it was handed to launchd, so it gets no session
      if (msg.role === 'shim' && pidAlive(Number(msg.claude_pid))) {
        const project = basename(String(msg.cwd ?? '')) || 'session'
        const configDir = typeof msg.config_dir === 'string' && msg.config_dir ? msg.config_dir : undefined
        // no config_dir: the session runs on the default profile (whatever the daemon itself was started with)
        const infoFile = join(configDir ?? join(homedir(), '.claude'), 'sessions', `${msg.claude_pid}.json`)
        const session: Session = {
          key: String(msg.claude_pid),
          cwd: String(msg.cwd ?? ''),
          label: sessionName(infoFile) ?? project,
          conversation: conversationId(infoFile),
          project,
          infoFile,
          configDir,
          launchArgs: typeof msg.launch_args === 'string' && msg.launch_args ? msg.launch_args.split('\n') : [],
          connectedAt: Date.now(),
          unanswered: new Map(),
          activity: new Activity(),
          words: [],
          pictures: Array.isArray(msg.features) && msg.features.includes('picture'),
          send: m => write(sock, m),
        }
        conn.session = session
        events.onSession(session, true)
      }
      write(sock, { t: 'welcome' })
      return
    }
    if (conn.role === 'shim' && conn.session) {
      events.onShimMessage(conn.session, msg, r => write(sock, r))
    } else if (conn.role === 'hook' && msg.t === 'stop') {
      events.onHookStop(msg)
      sock.end()
    } else if (conn.role === 'hook' && msg.t === 'activity') {
      events.onHookActivity(msg)
      sock.end()
    } else if (conn.role === 'cli') {
      events.onCli(msg, r => write(sock, r))
    }
  }

  return Bun.listen<Conn>({
    unix: SOCKET,
    socket: {
      open(sock) { sock.data = { buf: '', out: new Outbox(sock) } },
      drain(sock) { sock.data.out.drain() },
      data(sock, chunk) {
        sock.data.buf += chunk.toString()
        let i
        while ((i = sock.data.buf.indexOf('\n')) >= 0) {
          const line = sock.data.buf.slice(0, i)
          sock.data.buf = sock.data.buf.slice(i + 1)
          if (!line.trim()) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          handle(sock, msg)
        }
      },
      close(sock) {
        if (sock.data.session) events.onSession(sock.data.session, false)
      },
    },
  })
}

/** Whether a Claude Code process still runs (pid 1 is launchd, the parent of orphans). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/** A string field of Claude Code's per-process file. */
function infoField(infoFile: string, field: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(infoFile, 'utf8'))[field]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  } catch {
    return undefined
  }
}

/** The name Claude Code shows for a running session, from its per-process file. */
export const sessionName = (infoFile: string) => infoField(infoFile, 'name')

/** The conversation a session is in. It changes when the resume picker (or /resume) opens another one. */
export const conversationId = (infoFile: string) => infoField(infoFile, 'sessionId')

/** Client side, used by the shim, the hook and the CLI. */
export async function connectDaemon(
  secret: string,
  hello: Record<string, unknown>,
  onMessage: (msg: any) => void,
  onClose: () => void,
) {
  let buf = ''
  let out: Outbox | undefined
  const sock = await Bun.connect({
    unix: SOCKET,
    socket: {
      drain() { out?.drain() },
      data(_s, chunk) {
        buf += chunk.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line.trim()) { try { onMessage(JSON.parse(line)) } catch {} }
        }
      },
      close: onClose,
      error: onClose,
    },
  })
  const box = (out = new Outbox(sock))
  box.send({ t: 'hello', secret, ...hello })
  return {
    send: (msg: object) => box.send(msg),
    close: () => sock.end(),
  }
}
