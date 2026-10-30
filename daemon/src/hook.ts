#!/usr/bin/env bun
// Claude Code hooks: tell the daemon what Claude is doing.
//   Stop          a turn ended, so a voice message Claude answered only in the
//                 terminal still gets a spoken notice (runs in the foreground)
//   StopFailure   a turn ended by an API error (safety flag, rate limit...)
//   PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit
//                 live activity for the screen (async: never slows Claude down)
// Must stay fast and silent: it never blocks or prints.

import { loadSecret } from './paths'
import { connectDaemon } from './sessions'

/** Our ancestors' pids; one of them is the Claude Code process. */
function ancestors(): string[] {
  const pids: string[] = []
  let pid = process.ppid
  for (let i = 0; i < 5 && pid > 1; i++) {
    pids.push(String(pid))
    const r = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)])
    pid = Number(r.stdout.toString().trim())
  }
  return pids
}

const EVENTS: Record<string, 'prompt' | 'pre' | 'post' | 'fail'> = {
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre',
  PostToolUse: 'post',
  PostToolUseFailure: 'fail',
}

// only the fields the screen describes, cut short: no file contents or edits
const INPUT_FIELDS = ['command', 'description', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill']
function slim(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (input && typeof input === 'object') {
    for (const k of INPUT_FIELDS) {
      const v = (input as Record<string, unknown>)[k]
      if (typeof v === 'string') out[k] = v.slice(0, 200)
    }
  }
  return out
}

try {
  const input = JSON.parse(await Bun.stdin.text())
  const conn = await connectDaemon(loadSecret(), { role: 'hook' }, () => {}, () => {})
  const base = { pids: ancestors(), cwd: input.cwd ?? process.cwd() }
  const event = EVENTS[input.hook_event_name]
  if (event) {
    conn.send({ t: 'activity', ...base, event, tool_name: input.tool_name, tool_input: slim(input.tool_input), tool_use_id: input.tool_use_id })
  } else {
    conn.send({
      t: 'stop',
      ...base,
      last_message: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined,
      transcript_path: input.transcript_path,
      ...(input.hook_event_name === 'StopFailure' && { error: String(input.error_details || input.error || 'an API error').slice(0, 400) }),
    })
  }
  await Bun.sleep(50)
  conn.close()
} catch {
  // daemon not running or odd input: nothing to do
}
process.exit(0)
