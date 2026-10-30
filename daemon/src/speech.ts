// Runs the Python speech sidecar and gives the daemon a small async API over it.

import { join } from 'node:path'
import type { VoiceFeatures } from './voiceprint'
import { ROOT } from './paths'

export type SpeechInfo = { stt: string; tts: string; load_ms: number }
/** off: the models aren't loaded (the daemon starts this way); loading: ~4 s */
export type SpeechStatus = 'off' | 'loading' | 'on'
export type TtsChunk = { seq: number; pcm16: string; rate: number; text: string }
export type TtsResult = { first_ms: number | null; total_ms: number; cancelled: boolean }

type Pending =
  | { kind: 'stt'; resolve: (r: { text: string; ms: number; voice?: VoiceFeatures }) => void; reject: (e: Error) => void }
  | { kind: 'tts'; onChunk: (c: TtsChunk) => void; resolve: (r: TtsResult) => void; reject: (e: Error) => void }

const PYTHON = process.platform === 'win32'
  ? join(ROOT, 'speech', '.venv', 'Scripts', 'python.exe')
  : join(ROOT, 'speech', '.venv', 'bin', 'python')

/** wait: the turn model hears you mid-thought, so the daemon keeps listening */
export type VadEvent = 'start' | 'misfire' | 'wait' | 'end'
/** why a turn ended: the turn model heard you finish, the longest pause ran out,
 *  the plain pause rule, or you let go of push-to-talk */
export type TurnEnd = 'turn' | 'max' | 'pause' | 'ptt'

export class Speech {
  info: SpeechInfo | null = null
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private pending = new Map<string, Pending>()
  private nextId = 1
  private readyWaiters: ((info: SpeechInfo) => void)[] = []
  /** true until start(), and after stop(): a crash restarts only while it's false */
  private stopping = true
  /** streaming VAD events for clients that send raw mic audio */
  onVad: (stream: string, event: VadEvent, pcm16?: string, how?: TurnEnd) => void = () => {}
  /** the models finished loading, or the sidecar went away */
  onStatus: (status: SpeechStatus) => void = () => {}

  constructor(private env: Record<string, string> = {}) {}

  get status(): SpeechStatus {
    // between a crash and its restart it counts as loading, not off
    return this.stopping ? 'off' : this.info ? 'on' : 'loading'
  }

  start() {
    this.stopping = false
    if (this.proc) return
    const proc = Bun.spawn([PYTHON, '-u', join(ROOT, 'speech', 'sidecar.py')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...this.env },
    })
    this.proc = proc
    this.readLines(proc.stdout as ReadableStream<Uint8Array>, line => this.onLine(line))
    this.readLines(proc.stderr as ReadableStream<Uint8Array>, line => {
      // whisper.cpp and onnxruntime are chatty; keep only our own lines and errors
      if (/^\[speech\]|Traceback|^\w*(Error|Exception)\b/.test(line)) console.error(line)
    })
    proc.exited.then(code => {
      if (this.proc !== proc) return
      this.proc = null
      this.info = null
      for (const [, p] of this.pending) p.reject(new Error(`speech sidecar exited (${code})`))
      this.pending.clear()
      if (!this.stopping) {
        console.error(`[handfree] speech sidecar exited with ${code}; restarting in 2s`)
        setTimeout(() => { if (!this.stopping) this.start() }, 2000)
      }
      this.onStatus(this.status)
    })
    this.onStatus(this.status)
  }

  /** Unload the models (frees ~4 GB). Anything in flight fails. */
  stop() {
    if (this.stopping) return
    this.stopping = true
    this.proc?.kill()
    this.onStatus(this.status)
  }

  ready(): Promise<SpeechInfo> {
    if (this.info) return Promise.resolve(this.info)
    return new Promise(resolve => this.readyWaiters.push(resolve))
  }

  /** voice: also who spoke and how loud (for "my voice only"); language: Whisper's code, or auto */
  stt(pcm16: string, prompt?: string, voice = false, language?: string): Promise<{ text: string; ms: number; voice?: VoiceFeatures }> {
    const id = `s${this.nextId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: 'stt', resolve, reject })
      this.send({ op: 'stt', id, pcm16, rate: 16000, prompt, language, ...(voice ? { voice: true } : {}) })
    })
  }

  /** Streams one chunk per sentence. Cancel stops after the sentence in progress. */
  tts(text: string, opts: { voice?: string; speed?: number }, onChunk: (c: TtsChunk) => void) {
    const id = `t${this.nextId++}`
    const done = new Promise<TtsResult>((resolve, reject) => {
      this.pending.set(id, { kind: 'tts', onChunk, resolve, reject })
      this.send({ op: 'tts', id, text, voice: opts.voice, speed: opts.speed })
    })
    return { id, done, cancel: () => this.send({ op: 'tts_cancel', id }) }
  }

  vadAudio(stream: string, pcm16: string) {
    if (this.info) this.send({ op: 'vad_audio', stream, pcm16 })
  }

  vadReset(stream: string) {
    if (this.info) this.send({ op: 'vad_reset', stream })
  }

  private send(msg: object) {
    const stdin = this.proc?.stdin
    if (!stdin || typeof stdin === 'number') throw new Error('speech sidecar not running')
    stdin.write(JSON.stringify(msg) + '\n')
    stdin.flush()
  }

  private onLine(line: string) {
    let ev: any
    try { ev = JSON.parse(line) } catch { return console.error('[handfree] speech sent non-JSON:', line.slice(0, 200)) }
    if (ev.op === 'ready') {
      this.info = { stt: ev.stt, tts: ev.tts, load_ms: ev.load_ms }
      console.error(`[handfree] speech ready: ${ev.stt}, ${ev.tts} (${ev.load_ms} ms)`)
      for (const w of this.readyWaiters.splice(0)) w(this.info)
      this.onStatus(this.status)
      return
    }
    if (ev.op === 'vad') return this.onVad(ev.stream, ev.event, ev.pcm16, ev.how)
    const p = ev.id ? this.pending.get(ev.id) : undefined
    if (ev.op === 'error') {
      console.error(`[handfree] speech error: ${ev.message}`)
      if (p) { this.pending.delete(ev.id); p.reject(new Error(ev.message)) }
      return
    }
    if (!p) return
    if (ev.op === 'stt' && p.kind === 'stt') {
      this.pending.delete(ev.id)
      p.resolve({ text: ev.text, ms: ev.ms, ...(ev.voice ? { voice: ev.voice } : {}) })
    } else if (ev.op === 'tts_chunk' && p.kind === 'tts') {
      p.onChunk({ seq: ev.seq, pcm16: ev.pcm16, rate: ev.rate, text: ev.text })
    } else if (ev.op === 'tts_done' && p.kind === 'tts') {
      this.pending.delete(ev.id)
      p.resolve({ first_ms: ev.first_ms, total_ms: ev.total_ms, cancelled: ev.cancelled })
    }
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    }
  }
}
