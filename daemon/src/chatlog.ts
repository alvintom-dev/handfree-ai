// The chat on screen, kept across daemon restarts: the last messages of your most
// recent sessions (what you said, Claude's answers, the details on screen). Notices,
// transcripts and timings are for the moment only. Kept in ~/.handfree/chat.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const CHAT_KEEP = {
  perSession: 200, // about 65 exchanges: your words, the spoken answer, the detail
  sessions: 20, // the ones you talked to last
}

const KEPT = new Set(['user', 'reply', 'show', 'picture'])

type Msg = { t?: string; session_key?: string; at?: number }

/** The part of the history worth keeping, in its original order. */
export function keepable<M extends Msg>(history: M[]): M[] {
  const bySession = new Map<string, M[]>()
  for (const m of history) {
    if (!m.t || !KEPT.has(m.t) || !m.session_key) continue
    const list = bySession.get(m.session_key) ?? []
    list.push(m)
    bySession.set(m.session_key, list)
  }
  const recent = [...bySession.values()].sort((a, b) => (b.at(-1)!.at ?? 0) - (a.at(-1)!.at ?? 0)).slice(0, CHAT_KEEP.sessions)
  const keep = new Set(recent.flatMap(list => list.slice(-CHAT_KEEP.perSession)))
  return history.filter(m => keep.has(m))
}

export function loadChat(file: string): object[] {
  if (!existsSync(file)) return []
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(list) ? keepable(list) : []
  } catch (err) {
    console.error(`[handfree] ignoring unreadable ${file}:`, err)
    return []
  }
}

export function saveChat(file: string, history: object[]) {
  writeFileSync(file, JSON.stringify(keepable(history)), { mode: 0o600 })
}

/** The highest number used in ids like v12 or say7, so new ones don't repeat them. */
export function lastId(history: object[], field: string, prefix: string): number {
  let max = 0
  for (const m of history as Record<string, unknown>[]) {
    const v = m[field]
    if (typeof v === 'string' && v.startsWith(prefix)) max = Math.max(max, Number(v.slice(prefix.length)) || 0)
  }
  return max
}
