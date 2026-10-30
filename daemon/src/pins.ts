// Pinned messages, per session. Kept apart from the chat (~/.handfree/pins.json), so
// the chat's limits never drop them; each pin holds a copy of its message.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Pin = {
  ref: string
  session_key: string
  /** Claude's conversation id: a resumed conversation gets its pins back, like its chat */
  conversation?: string
  pinned_at: number
  msg: Record<string, unknown>
}

const PINNABLE = new Set(['user', 'reply', 'show', 'picture'])

/** A message's id for pinning: its own id, or for one saved before those existed, type, msg_id and time. */
export const pinRef = (m: { id?: unknown; t?: unknown; msg_id?: unknown; at?: unknown }) => m.id ? String(m.id) : `${m.t}:${m.msg_id ?? ''}:${m.at}`

export class Pins {
  list: Pin[] = []

  constructor(private file: string) {
    if (!existsSync(file)) return
    try {
      const list = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(list)) this.list = list
    } catch (err) {
      console.error(`[handfree] ignoring unreadable ${file}:`, err)
    }
  }

  /** Pin or unpin a message; false if nothing changed. */
  set(msg: Record<string, any>, on: boolean): boolean {
    const ref = pinRef(msg)
    const i = this.list.findIndex(p => p.ref === ref)
    if (on === i >= 0) return false
    if (on) {
      if (!PINNABLE.has(msg.t) || typeof msg.session_key !== 'string') return false
      this.list.push({ ref, session_key: msg.session_key, conversation: msg.conversation, pinned_at: Date.now(), msg: { ...msg } })
    } else {
      this.list.splice(i, 1)
    }
    this.save()
    return true
  }

  /** Unpin by ref, for a pin whose message has left the chat. */
  unpin(ref: string): boolean {
    const i = this.list.findIndex(p => p.ref === ref)
    if (i < 0) return false
    this.list.splice(i, 1)
    this.save()
    return true
  }

  save() {
    writeFileSync(this.file, JSON.stringify(this.list), { mode: 0o600 })
  }
}
