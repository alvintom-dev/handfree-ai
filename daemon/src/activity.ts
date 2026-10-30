// What Claude is doing right now, per session, from Claude Code's tool hooks.
// Hooks run async (they never slow Claude down), so a tool's "done" can arrive
// before its "started": every event upserts by tool_use_id.

import { basename } from 'node:path'

export type Step = { id: string; label: string; startedAt: number; endedAt?: number; ok?: boolean }

export type ActivityEvent = {
  event: 'prompt' | 'pre' | 'post' | 'fail' | 'stop'
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
}

const KEEP = 8

// our own voice tools already show up as replies on screen
const HIDDEN = new Set(['mcp__handfree__reply', 'mcp__handfree__show'])

export class Activity {
  busy = false
  since = 0
  steps: Step[] = []
  /** when Claude last did anything (a session quiet mid-task may be waiting on a menu) */
  lastAt = 0

  /** Returns true when something visible changed. */
  apply(e: ActivityEvent, now = Date.now()): boolean {
    this.lastAt = now
    switch (e.event) {
      case 'prompt':
        this.start(now)
        return true
      case 'stop':
        if (!this.busy) return false
        this.busy = false
        for (const s of this.steps) if (!s.endedAt) s.endedAt = now
        return true
      case 'pre':
      case 'post':
      case 'fail': {
        if (!e.tool_name || HIDDEN.has(e.tool_name)) return false
        if (e.event === 'pre' && !this.busy) this.start(now)
        const id = e.tool_use_id || `${e.tool_name}:${now}`
        let step = this.steps.find(s => s.id === id)
        if (!step) {
          step = { id, label: describeTool(e.tool_name, e.tool_input ?? {}), startedAt: now }
          this.steps.push(step)
          if (this.steps.length > KEEP) this.steps.shift()
        }
        if (e.event !== 'pre') {
          step.endedAt = now
          step.ok = e.event === 'post'
        }
        return true
      }
    }
  }

  /** The step in progress, if any. */
  current(): Step | undefined {
    return this.busy ? [...this.steps].reverse().find(s => !s.endedAt) : undefined
  }

  snapshot() {
    return { busy: this.busy, since: this.since, steps: this.steps }
  }

  private start(now: number) {
    this.busy = true
    this.since = now
    this.steps = []
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const clip = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const file = (v: unknown) => basename(str(v)) || 'a file'

/** A short, readable line for a tool call, like the terminal shows. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': {
      const d = str(input.description)
      return d ? clip(d) : `Running ${clip(str(input.command).split('\n')[0] ?? '', 60)}`
    }
    case 'Read': return `Reading ${file(input.file_path)}`
    case 'Edit':
    case 'MultiEdit': return `Editing ${file(input.file_path)}`
    case 'Write': return `Writing ${file(input.file_path)}`
    case 'NotebookEdit': return `Editing ${file(input.notebook_path)}`
    case 'Grep': return `Searching for “${clip(str(input.pattern), 40)}”`
    case 'Glob': return `Finding files: ${clip(str(input.pattern), 40)}`
    case 'WebFetch': {
      try { return `Reading ${new URL(str(input.url)).host}` } catch { return 'Reading a web page' }
    }
    case 'WebSearch': return `Searching the web: ${clip(str(input.query), 50)}`
    case 'Agent':
    case 'Task': return `Agent: ${clip(str(input.description) || 'working', 50)}`
    case 'Skill': return `Using the ${str(input.skill) || 'a'} skill`
    case 'ToolSearch': return 'Loading tools'
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate': return 'Updating the task list'
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]!.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ')}: ${mcp[2]!.replace(/[_-]+/g, ' ')}`
  return name
}
