// Short utterances the daemon handles itself, without waiting for Claude.
// Only whole, short utterances match, so normal sentences go to Claude.

import { soundKey } from './phonetic'

export type Command =
  | 'stop' | 'repeat' | 'status' | 'slower' | 'faster' | 'go_on' | 'tap_mode' | 'hold' | 'sessions' | 'sleep'

const normalize = (text: string) =>
  text.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim()

const COMMANDS: [Command, RegExp][] = [
  ['stop', /^(ok(ay)? )?(stop|stop talking|stop it|be quiet|quiet|shush|enough|that's enough|cancel that)( please)?$/],
  ['repeat', /^(can you )?(repeat|repeat that|say (that|it) again|come again|what did you say|pardon)( please)?$/],
  ['status', /^(status|what's the status|are you (still )?working|how's it going|progress|any update|status update)$/],
  ['slower', /^(slower|speak slower|talk slower|slow down)( please)?$/],
  ['faster', /^(faster|speak faster|talk faster|speed up)( please)?$/],
  ['go_on', /^(go on|continue|keep going|carry on)( please)?$/],
  ['tap_mode', /^(switch to )?(tap|strict) mode( on| please)?$/],
  ['sessions', /^((which|what) sessions?( (are|is) (there|open|running|connected))?|list (the |my )?sessions)$/],
  ['sleep', /^(ok(ay)? )?(that's all|that's it|that will be all|thanks claude|thank you claude|stop listening)( for now)?( thanks| thank you)?$/],
  ['hold', /^((wait|hold on|hang on)( a (sec|second|moment|minute))?|one (sec|second|moment)|give me a (sec|second|moment)|let me think)$/],
]

export function parseCommand(text: string): Command | null {
  const t = normalize(text)
  if (t.split(' ').length > 6) return null
  for (const [cmd, re] of COMMANDS) if (re.test(t)) return cmd
  return null
}

/** "switch to web app" -> the sessions it names (by session name or project), best match first level.
 *  Only names that match a connected session count, so "switch to the main branch" still goes to Claude.
 *  Two or more back means the name was ambiguous ("handfree ai" with two sessions in that project). */
const SWITCH = /^(?:ok(?:ay)? )?(?:(?:can|could|would) you (?:please )?|please )?(?:switch|go|change|move|jump)(?: over| back)? to (?:the |our |my )?(?:session |project )?(.+?)(?: session| project)?(?: please)?$/
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The session name in "switch to <name>", squashed to letters and digits, or null if it isn't that shape. */
function switchName(text: string): string | null {
  const m = SWITCH.exec(normalize(text))
  if (!m || m[1]!.split(' ').length > 5) return null
  // Whisper writes this project's name "hands-free" as often as "handfree"
  return key(m[1]!).replace(/handsfree/g, 'handfree') || null
}

export function sessionSwitchTargets<S extends { label: string; project?: string }>(text: string, sessions: S[]): S[] {
  const said = switchName(text)
  if (!said) return []
  const levels = [
    (l: string) => key(l) === said, // exact
    (l: string) => key(l).includes(said), // part of the name ("server" for api-server)
    (l: string) => soundKey(key(l)) === soundKey(said), // how it sounds ("dash board bellia")
  ]
  for (const ok of levels) {
    const byLabel = sessions.filter(s => ok(s.label))
    if (byLabel.length === 1) return byLabel
    const hits = sessions.filter(s => ok(s.label) || (s.project != null && ok(s.project)))
    if (hits.length) return hits.length > 1 && said.length < 3 ? [] : hits
  }
  return []
}

/** "Check the logs. Then switch to web app." -> the words for the session you're on, and the
 *  session to switch to after sending them. Only "switch to" (not "go to") and only a name
 *  that matches one connected session, so "...and switch to the main branch" goes to Claude whole. */
export function splitSwitch<S extends { label: string; project?: string }>(text: string, sessions: S[]): { before: string; target: S } | null {
  const m = /^(.*?\w.*?)[\s,.;:!?-]+(?:(?:and|then|now|ok|okay)[\s,]+)*((?:can you |please )?switch(?: over| back)? to .+)$/is.exec(text.trim())
  if (!m) return null
  const targets = sessionSwitchTargets(m[2]!, sessions)
  return targets.length === 1 ? { before: m[1]!.trim(), target: targets[0]! } : null
}

/** When "switch to <name>" matches no session, the closest one by spelling or sound, if it's close enough
 *  to be worth asking about ("handsome AI FC" -> handfree-ai-fc). sure means close enough to just switch. */
export function guessSession<S extends { label: string }>(text: string, sessions: S[]): { session: S; sure: boolean } | null {
  const said = switchName(text)
  if (!said || said.length < 3) return null
  let best: { session: S; score: number } | null = null
  for (const s of sessions) {
    const score = Math.max(likeness(said, key(s.label)), likeness(soundKey(said), soundKey(key(s.label))))
    if (!best || score > best.score) best = { session: s, score }
  }
  return best && best.score >= 0.5 ? { session: best.session, sure: best.score >= 0.8 } : null
}

/** 1 for the same text, 0 for nothing in common (edit distance over the longer length). */
function likeness(a: string, b: string): number {
  if (!a || !b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length)
}

export function parseSessionSwitch<S extends { label: string; project?: string }>(text: string, sessions: S[]): S | null {
  const hits = sessionSwitchTargets(text, sessions)
  return hits.length === 1 ? hits[0]! : null
}

// how Whisper tends to spell "Claude" when it isn't sure
const NAME_SLIPS: Record<string, string> = { cloud: 'claude', clawed: 'claude', claud: 'claude', clod: 'claude', clode: 'claude', klaud: 'claude' }
const GREETINGS = new Set(['hey', 'hi', 'hay', 'a', 'eh', 'ok', 'okay'])
const LEAD_FILLERS = new Set(['um', 'uh', 'erm', 'so', 'oh', 'and'])

/** "Hey Claude, check the logs." -> "check the logs."; "Hey Claude." -> ""; not said -> null.
 *  Matches by sound, so "hey cloud" and "hi Claude" count, but only at the start. */
export function stripWake(text: string, phrase: string): string | null {
  const word = (w: string) => { const n = w.toLowerCase().replace(/[^a-z']+/g, ''); return NAME_SLIPS[n] ?? n }
  const want = phrase.split(/\s+/).map(word).filter(Boolean)
  if (!want.length) return null
  const words = text.trim().split(/\s+/)
  let s = 0
  while (s < words.length - 1 && LEAD_FILLERS.has(word(words[s]!))) s++
  const key = (ws: string[]) => soundKey(ws.map(word).join(''))
  const target = key(want)
  // a phrase split or joined differently ("hey clau de", "heyclaude"), or its greeting swapped ("hi claude")
  const tries = [want.length, want.length + 1, want.length - 1].filter(n => n > 0)
  for (const n of tries) {
    const head = words.slice(s, s + n)
    const greeted = want.length > 1 && GREETINGS.has(want[0]!)
    const swapped = greeted && head.length === want.length && GREETINGS.has(word(head[0]!)) && key(head.slice(1)) === key(want.slice(1))
    // Whisper lost the "hey": only the name spelled right counts, so "cloud computing…" doesn't
    const raw = (ws: string[]) => ws.map(w => w.toLowerCase().replace(/[^a-z']+/g, '')).join(' ')
    const dropped = greeted && head.length === want.length - 1 && raw(head) === raw(phrase.split(/\s+/).slice(1))
    if (key(head) === target || swapped || dropped) {
      return words.slice(s + n).join(' ').replace(/^[\s,.!?;:—-]+/, '')
    }
  }
  return null
}

/** Backchannel noises that shouldn't cut Claude off mid-sentence. */
export function isFiller(text: string): boolean {
  return /^(m+|m+h+m+|mm+ hmm+|uh+ huh|uh+|um+|hmm+|ah+|oh+|aha|yeah|yep|ok(ay)?|right|sure|got it|i see|cool|nice)$/.test(normalize(text))
}

/** Whisper ends finished sentences with . ? or ! and trails off with "..." */
export function soundsUnfinished(text: string): boolean {
  const t = text.trim().replace(/["'”’)\]]+$/, '')
  return !/[.?!]$/.test(t) || /(\.\.\.|…)$/.test(t)
}

export function isYes(text: string): boolean {
  return /^(yes|yeah|yep|yup|sure|approve(d)?|go ahead|do it|ok(ay)?|confirm(ed)?)\b/.test(normalize(text))
}

export function isNo(text: string): boolean {
  return /^(no|nope|nah|deny|denied|don't|do not|cancel|stop|reject)\b/.test(normalize(text))
}

/** Drops what Whisper made up: a sentence repeated word for word, and sentences
 *  that are only Claude's own recent words (the mic hearing the speaker, or the
 *  prompt copied into the transcript). Short answers that reuse Claude's words stay. */
export function cleanTranscript(heard: string, spoken: string): string {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
  const said = new Set(words(spoken))
  const sentences = heard.split(/(?<=[.!?])\s+/)
  const keys = sentences.map(x => words(x).join(' '))
  // repeats are the tell of a made-up transcript; then even short echoes go.
  // Otherwise only long ones: "Commit it." in answer to "Shall I commit it?" is you.
  const repeating = new Set(keys.filter(Boolean)).size < keys.filter(Boolean).length
  const minEcho = repeating ? 2 : 4
  const seen = new Set<string>()
  const kept: string[] = []
  sentences.forEach((sentence, i) => {
    const w = keys[i]!.split(' ').filter(Boolean)
    if (!w.length || seen.has(keys[i]!)) return // empty, or the same sentence again
    seen.add(keys[i]!)
    if (w.length >= minEcho && said.size && w.filter(x => said.has(x)).length / w.length >= 0.8) return // Claude's words
    kept.push(sentence)
  })
  return kept.join(' ').trim()
}

/** The same speech heard by two devices (the phone and the Mac's mic): most of the
 *  later transcript's words are in what the other device heard. Loose, since the
 *  two transcripts differ a little ("Hey Claude" on one, "hey cloud" on the other). */
export function heardTwice(later: string, earlier: string): boolean {
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean)
  const w = words(later)
  const had = new Set(words(earlier))
  return !!w.length && w.filter(x => had.has(x)).length / w.length >= 0.6
}
