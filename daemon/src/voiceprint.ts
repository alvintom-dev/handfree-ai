// "My voice only": was this utterance you, close to the mic? For each utterance the
// speech sidecar sends a speaker embedding and how loud it was; this keeps your voiceprint
// (the running average of your embeddings) and how loud you usually are on each device,
// and learns only from messages it's sure are you. Kept in ~/.handfree/voiceprint.json:
// numbers, never audio.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type VoiceFeatures = { emb: number[]; level_db: number; snr_db: number; secs: number }
export type MyVoiceMode = 'off' | 'watch' | 'on'
export type Verdict =
  | { kind: 'learning' } // still building your voiceprint: let it through
  | { kind: 'short' } // too short to tell who it is: let it through
  | { kind: 'you'; score: number }
  | { kind: 'unsure'; score: number } // let it through, but don't learn from it
  | { kind: 'other'; score: number } // doesn't sound like you
  | { kind: 'far'; gapDb: number } // much quieter than you usually are on this device

export const VOICE = {
  learnFirst: 10, // messages that build the voiceprint before it judges anyone
  minSecs: 1.0, // shorter clips ("yes") are too short to tell who it is
  sure: 0.7, // at or above: you, and it learns from it
  other: 0.45, // below: not you
  farDb: 12, // this much quieter than your usual level on that device: far away
  levelsFirst: 10, // your messages on a device before the far check starts there
  window: 200, // past this many, older messages fade out (a running average)
}

type Level = { mean: number; n: number }
type State = { sum: number[]; n: number; levels: Record<string, Level>; counts: Record<string, number> }

export type VoiceSummary = { learned: number; ready: boolean; counts: Record<string, number> }

export const drops = (v: Verdict) => v.kind === 'other' || v.kind === 'far'

export function describe(v: Verdict): string {
  switch (v.kind) {
    case 'other': return `didn't sound like you (match ${Math.round(v.score * 100)}%)`
    case 'far': return `${Math.round(v.gapDb)} dB quieter than you usually are: someone further away`
    case 'you': return `you (match ${Math.round(v.score * 100)}%)`
    case 'unsure': return `not sure it's you (match ${Math.round(v.score * 100)}%)`
    case 'short': return 'too short to tell'
    case 'learning': return 'still learning your voice'
  }
}

export class Voiceprint {
  private s: State = { sum: [], n: 0, levels: {}, counts: {} }

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try { this.s = { ...this.s, ...JSON.parse(readFileSync(file, 'utf8')) } } catch (err) { console.error(`[handfree] ignoring unreadable ${file}:`, err) }
    }
  }

  /** Who it was, and whether it came from close by. Counts it for the summary. */
  judge(f: VoiceFeatures, device: string): Verdict {
    const v = this.verdict(f, device)
    this.s.counts[v.kind] = (this.s.counts[v.kind] ?? 0) + 1
    this.save()
    return v
  }

  private verdict(f: VoiceFeatures, device: string): Verdict {
    const level = this.s.levels[device]
    if (level && level.n >= VOICE.levelsFirst && level.mean - f.level_db >= VOICE.farDb) return { kind: 'far', gapDb: level.mean - f.level_db }
    if (f.secs < VOICE.minSecs) return { kind: 'short' }
    if (this.s.n < VOICE.learnFirst) return { kind: 'learning' }
    const score = this.score(f.emb)
    if (score >= VOICE.sure) return { kind: 'you', score }
    if (score < VOICE.other) return { kind: 'other', score }
    return { kind: 'unsure', score }
  }

  /** Cosine similarity with the voiceprint (embeddings arrive unit length). */
  score(emb: number[]): number {
    const norm = Math.hypot(...this.s.sum) || 1
    let dot = 0
    for (let i = 0; i < emb.length; i++) dot += (emb[i] ?? 0) * (this.s.sum[i] ?? 0)
    return dot / norm
  }

  /** A message that reached Claude: learn from it if it's surely you (or the print is still young). */
  learn(f: VoiceFeatures, device: string, v: Verdict) {
    if (v.kind !== 'you' && v.kind !== 'learning') return
    const n = this.s.n
    const keep = n < VOICE.window ? 1 : 1 - 1 / VOICE.window
    this.s.sum = f.emb.map((x, i) => (this.s.sum[i] ?? 0) * keep + x)
    this.s.n = Math.min(n + 1, VOICE.window)
    const l = this.s.levels[device] ?? { mean: f.level_db, n: 0 }
    const k = Math.min(l.n + 1, VOICE.window)
    this.s.levels[device] = { mean: l.mean + (f.level_db - l.mean) / k, n: k }
    this.save()
  }

  reset() {
    this.s = { sum: [], n: 0, levels: {}, counts: {} }
    this.save()
  }

  summary(): VoiceSummary {
    return { learned: this.s.n, ready: this.s.n >= VOICE.learnFirst, counts: { ...this.s.counts } }
  }

  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.s), { mode: 0o600 })
  }
}
