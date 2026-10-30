// Menus Claude Code draws in the terminal itself, outside the permission relay:
// "switch to Sonnet?" after the safety check flags a message, AskUserQuestion,
// plan approval, /model... The daemon reads the session's screen (tmux, or a
// Terminal.app tab via AppleScript) and picks an option by sending arrow keys.
// The same keys stop, rename and end a session started at the Mac.

export type MenuOption = { label: string; detail?: string }
export type Menu = { title: string; options: MenuOption[]; selected: number }

// the hint line under a menu, e.g. "Enter to confirm · Esc to cancel"
const FOOTER = /Esc to (cancel|exit|go back)|Enter to (confirm|select|set)|↑\/↓ to navigate/
const BORDER = /^\s*[─━═]{8,}/
const BOX = /^[│┃]\s?|\s?[│┃]$/g

/** The menu at the bottom of a terminal screen, if Claude Code is showing one. */
export function parseMenu(screen: string): Menu | undefined {
  const lines = screen.replace(/\r/g, '').trimEnd().split('\n').map(l => l.replace(BOX, '').trimEnd()).slice(-45)
  // the last ❯ on screen: a menu's highlighted option, or the prompt you type in
  const i = lines.findLastIndex(l => /^\s*❯ \S/.test(l))
  if (i < 0) return undefined
  const col = lines[i]!.indexOf('❯') + 2
  const isOption = (l: string) => l.length > col && l.slice(0, col).trim() === '' && l[col] !== ' '
  const isDetail = (l: string) => l.length > col && l.slice(0, col + 1).trim() === ''
  // options sit in one column; deeper lines describe the option above them
  let top = i
  while (top > 0 && (isOption(lines[top - 1]!) || isDetail(lines[top - 1]!))) top--
  while (top < i && !isOption(lines[top]!)) top++
  let end = i
  while (end + 1 < lines.length && (isOption(lines[end + 1]!) || isDetail(lines[end + 1]!))) end++
  const rows = lines.slice(top, end + 1)
  const options: MenuOption[] = []
  let selected = -1
  for (const [k, row] of rows.entries()) {
    const text = row.slice(col).trim().replace(/\s{2,}/g, ' · ')
    if (top + k === i || isOption(row)) {
      if (top + k === i) selected = options.length
      options.push({ label: text.replace(/^\d+\.\s+/, '') })
    } else {
      const o = options.at(-1)!
      o.detail = o.detail ? `${o.detail} ${text}` : text
    }
  }
  for (const o of options) if (o.detail === o.label) delete o.detail
  const below = lines.slice(end + 1).filter(l => l.trim()).slice(0, 4)
  if (options.length < 2 || !below.some(l => FOOTER.test(l))) return undefined
  // the question: the lines above the options, up to the dialog's top border
  const title: string[] = []
  for (let k = top - 1; k >= 0 && title.length < 8; k--) {
    const l = lines[k]!
    if (BORDER.test(l)) break
    if (l.trim()) title.unshift(l.trim().replace(/^[☐☒✔]\s*/, ''))
  }
  return { title: title.join('\n'), options, selected }
}

/** Same question and options: the same menu, still open. */
export function sameMenu(a: Menu, b: Menu) {
  return a.title === b.title && a.options.map(o => o.label).join('\n') === b.options.map(o => o.label).join('\n')
}

type Where = { kind: 'tmux'; pane: string } | { kind: 'terminal'; tty: string }

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(p.stdout).text()
    return { ok: (await p.exited) === 0, out }
  } catch {
    return { ok: false, out: '' }
  }
}

/** AppleScript that finds the Terminal.app tab on this tty and runs body on it, named TAB there.
 *  (Not a variable: `contents of t` would give the reference itself, not the tab's text.) */
function inTab(tty: string, body: string) {
  return `tell application "Terminal"
repeat with w from 1 to count windows
repeat with i from 1 to count tabs of window w
if tty of tab i of window w is "/dev/${tty}" then
${body.replaceAll('TAB', 'tab i of window w')}
end if
end repeat
end repeat
end tell`
}

export class Terminals {
  private where = new Map<string, Where | null>()

  /** Where a Claude process draws its screen: a tmux pane, or a Terminal.app tab. */
  private async locate(pid: string): Promise<Where | null> {
    if (this.where.has(pid)) return this.where.get(pid)!
    let found: Where | null = null
    const tty = (await run(['ps', '-o', 'tty=', '-p', pid])).out.trim()
    if (tty && tty !== '??') {
      const panes = Bun.which('tmux') ? await run(['tmux', 'list-panes', '-a', '-F', '#{pane_tty} #{pane_id}']) : { ok: false, out: '' }
      const pane = panes.ok ? panes.out.split('\n').find(l => l.startsWith(`/dev/${tty} `))?.split(' ')[1] : undefined
      if (pane) found = { kind: 'tmux', pane }
      // only a Terminal.app tab answers; iTerm or an editor's terminal stays out of reach
      else if (process.platform === 'darwin' && (await run(['osascript', '-e', inTab(tty, 'return "yes"')])).out.trim() === 'yes') {
        found = { kind: 'terminal', tty }
      }
    }
    this.where.set(pid, found)
    return found
  }

  forget(pid: string) {
    this.where.delete(pid)
  }

  /** Look the session up now, so reachable() knows the answer. */
  async find(pid: string): Promise<boolean> {
    return !!(await this.locate(pid))
  }

  /** Whether keys can be sent to this session (after find()). */
  reachable(pid: string): boolean {
    return !!this.where.get(pid)
  }

  /** The text on the session's screen right now. */
  async screen(pid: string): Promise<string | undefined> {
    const w = await this.locate(pid)
    if (!w) return undefined
    const r = w.kind === 'tmux'
      ? await run(['tmux', 'capture-pane', '-p', '-t', w.pane])
      : await run(['osascript', '-e', inTab(w.tty, 'return contents of TAB')])
    return r.ok && r.out.trim() ? r.out : undefined
  }

  /** Move the highlight from one option to another and press Enter. */
  async choose(pid: string, from: number, to: number): Promise<boolean> {
    const w = await this.locate(pid)
    if (!w) return false
    const n = Math.abs(to - from)
    if (w.kind === 'tmux') {
      const key = to > from ? 'Down' : 'Up'
      return (await run(['tmux', 'send-keys', '-t', w.pane, ...Array(n).fill(key), 'Enter'])).ok
    }
    // the newline `do script` adds after the carriage return is harmless
    const arrow = `(ASCII character 27) & "[${to > from ? 'B' : 'A'}"`
    return this.doScript(w.tty, [...Array(n).fill(arrow), CR].join(' & '))
  }

  /** Type a line into Claude's prompt and press Enter, as at the Mac. */
  async type(pid: string, text: string): Promise<boolean> {
    const w = await this.locate(pid)
    if (!w) return false
    if (w.kind === 'tmux') return (await run(['tmux', 'send-keys', '-t', w.pane, '-l', text])).ok && (await run(['tmux', 'send-keys', '-t', w.pane, 'Enter'])).ok
    if (!(await this.doScript(w.tty, `"${text.replace(/[\\"]/g, '\\$&')}"`))) return false
    // Enter apart from the text: in one go it would count as pasted, and not be sent
    await Bun.sleep(400)
    return this.doScript(w.tty, CR)
  }

  /** Stop what Claude is doing, as Esc does. A Terminal.app tab can't be sent a bare Esc
   *  (the newline after it makes it Alt+Enter), so it gets Ctrl+C, which Claude takes the same
   *  way mid-task. Idle, a second Ctrl+C would quit Claude: only send it while it works. */
  async interrupt(pid: string): Promise<boolean> {
    const w = await this.locate(pid)
    if (!w) return false
    if (w.kind === 'tmux') return (await run(['tmux', 'send-keys', '-t', w.pane, 'Escape'])).ok
    return this.doScript(w.tty, '(ASCII character 3)')
  }

  /** /exit, then Enter for the "background tasks are still running" question if it comes.
   *  Ctrl+C first clears the prompt (a stopped task puts its message back there), so /exit
   *  isn't typed after other words. On an empty prompt it only asks for a second Ctrl+C. */
  async exit(pid: string): Promise<boolean> {
    const w = await this.locate(pid)
    if (!w) return false
    if (w.kind === 'tmux') await run(['tmux', 'send-keys', '-t', w.pane, 'C-c'])
    else await this.doScript(w.tty, '(ASCII character 3)')
    await Bun.sleep(400)
    if (!(await this.type(pid, '/exit'))) return false
    await Bun.sleep(1500)
    if (w.kind === 'tmux') await run(['tmux', 'send-keys', '-t', w.pane, 'Enter'])
    else await this.doScript(w.tty, CR)
    return true
  }

  /** `do script` types its text into the tab and then a newline. */
  private async doScript(tty: string, keys: string): Promise<boolean> {
    return (await run(['osascript', '-e', inTab(tty, `do script (${keys}) in TAB`)])).ok
  }
}

// a bare newline isn't Enter in Claude's prompt; a carriage return is
const CR = '(ASCII character 13)'
