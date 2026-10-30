import { expect, test } from 'bun:test'
import { parseMenu, sameMenu } from '../src/terminal'

// screens copied from a real Terminal.app tab (Claude Code 2.1.312)
const QUESTION = `❯ Use the AskUserQuestion tool to ask me to pick one color: red, green,
  blue or yellow. Nothing else.
────────────────────────────────────────────────────────────────────────────
 ☐ Color

Pick one color: red, green, blue or yellow?

❯ 1. Red
     Pick red
  2. Green
     Pick green
  3. Blue
     Pick blue
  4. Yellow
     Pick yellow
  5. Type something.
────────────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`

const MODEL = `❯ /model
────────────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the default for new
  sessions. For other/previous model names, specify with --model.

    1. Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
  ❯ 2. Opus ✔                 Opus 5.5 · Best for everyday, complex tasks
    3. Fable                  Fable 5.1 · Most capable for your hardest
                              and longest-running tasks
    4. Sonnet                 Sonnet 5.5 · Efficient for routine tasks
    5. Haiku                  Haiku 5.5 · Fastest for quick answers

  ◉ xHigh effort ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel
`

const TRUST = `────────────────────────────────────────────────────────────────────────────
 Accessing workspace:
 Quick safety check: Is this a project you created or one you trust?
 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`

const PROMPT = `⏺ You picked blue.
✻ Cooked for 3s · done 10:35 AM
────────────────────────────────────────────────────────────────────────────
❯ 1. this looks like a list
  2. but it is what I typed
────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`

test('reads an AskUserQuestion menu', () => {
  const m = parseMenu(QUESTION)!
  expect(m.title).toBe('Color\nPick one color: red, green, blue or yellow?')
  expect(m.options.map(o => o.label)).toEqual(['Red', 'Green', 'Blue', 'Yellow', 'Type something.'])
  expect(m.options[0]!.detail).toBe('Pick red')
  expect(m.selected).toBe(0)
})

test('reads a menu whose highlight is not on the first option', () => {
  const m = parseMenu(MODEL)!
  expect(m.title.startsWith('Select model')).toBe(true)
  expect(m.options).toHaveLength(5)
  expect(m.options[2]).toEqual({ label: 'Fable · Fable 5.1 · Most capable for your hardest', detail: 'and longest-running tasks' })
  expect(m.selected).toBe(1)
})

test('blank rows under the menu (a tall Terminal window) are skipped', () => {
  expect(parseMenu(QUESTION + '\n'.repeat(60))?.options).toHaveLength(5)
})

test('reads an unnumbered menu', () => {
  const m = parseMenu(TRUST)!
  expect(m.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
  expect(m.title).toContain('Quick safety check')
})

test('the prompt you type in is not a menu', () => {
  expect(parseMenu(PROMPT)).toBeUndefined()
  expect(parseMenu('')).toBeUndefined()
})

test('same question and options are the same menu', () => {
  const a = parseMenu(MODEL)!
  expect(sameMenu(a, { ...a, selected: 3 })).toBe(true)
  expect(sameMenu(a, parseMenu(TRUST)!)).toBe(false)
})
