// Start and end Claude sessions from the phone. Each one runs claude-voice in a
// detached tmux session, so a Mac with no screen needs no terminal; `tmux attach`
// shows it again at a screen. Only folders from a list can be started (recent,
// pinned, or inside a workspace), never a typed path.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { HOME, ROOT, type PinnedFolder, type Workspace } from './paths'

export type Project = {
  cwd: string
  name: string
  /** CLAUDE_CONFIG_DIR of the last session there; unset is the default profile */
  configDir?: string
  /** the extra claude flags it was started with (no --continue / --resume) */
  args: string[]
  lastUsed: number
}

const PROJECTS_FILE = join(HOME, 'projects.json')
const MAX_PROJECTS = 30
/** tmux sessions handfree started are named hf-<project> */
const PREFIX = 'hf-'
const WARNING = 'I am using this for local development'
/** Claude's first-run question in a folder; its cursor starts on "No, exit" */
const TRUST = 'Yes, I trust this folder'

/** Folders where voice sessions ran, most recent first. Kept in ~/.handfree/projects.json. */
export class Projects {
  list: Project[] = []

  constructor(private file = PROJECTS_FILE) {
    try { this.list = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  }

  get(cwd: string): Project | undefined {
    return this.list.find(p => p.cwd === cwd)
  }

  remember(cwd: string, configDir: string | undefined, args: string[]) {
    if (!cwd || cwd === '/') return
    this.list = [
      { cwd, name: basename(cwd), configDir: configDir || undefined, args, lastUsed: Date.now() },
      ...this.list.filter(p => p.cwd !== cwd),
    ].slice(0, MAX_PROJECTS)
    this.save()
  }

  forget(cwd: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(p => p.cwd !== cwd)
    if (this.list.length === before) return false
    this.save()
    return true
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.list, null, 2) + '\n', { mode: 0o600 })
  }
}

/** ~ and relative bits resolved: a workspace path as written in the config. */
export function expandHome(p: string): string {
  return resolve(p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
}

/** The Claude config folder for a profile name; default is ~/.claude (undefined). */
export function profileDir(profile: string): string | undefined {
  return !profile || profile === 'default' ? undefined : join(homedir(), `.claude-${profile.replace(/^claude-/, '')}`)
}

/** The profile name for a Claude config folder, as the phone shows it: the listed name
 *  whose folder it is (default for ~/.claude), else what the folder is called. */
export function profileName(configDir: string | undefined, profiles: string[]): string {
  const dir = configDir === join(homedir(), '.claude') ? undefined : configDir
  return profiles.find(p => profileDir(p) === dir) ?? (dir ? basename(dir).replace(/^\.claude-/, '') : 'default')
}

/** The profiles the phone can pick: the config's list, else the ones the workspaces and pinned folders name. */
export function profileChoices(c: { profiles: string[]; workspaces: Workspace[]; pinned: PinnedFolder[] }): string[] {
  if (c.profiles.length) return c.profiles
  return [...new Set([...c.workspaces.map(w => w.profile), ...c.pinned.map(p => p.profile ?? '')].filter(Boolean))]
}

/** The pinned entry for a folder, if it's on your list. */
export function pinnedFor(cwd: string, pinned: PinnedFolder[]): PinnedFolder | undefined {
  return pinned.find(p => expandHome(p.path) === cwd)
}

/** Your pinned folders that exist, in the order you wrote them. */
export function pinnedFolders(pinned: PinnedFolder[]): { cwd: string; name: string }[] {
  return pinned.map(p => expandHome(p.path)).filter(cwd => {
    try { return statSync(cwd).isDirectory() } catch { return false }
  }).map(cwd => ({ cwd, name: basename(cwd) }))
}

/** The workspace a project folder sits directly inside (the most specific one), if any.
 *  A workspace folder itself is not a project. */
export function workspaceFor(cwd: string, workspaces: Workspace[]): Workspace | undefined {
  if (resolve(cwd) !== cwd || basename(cwd).startsWith('.')) return undefined
  const roots = workspaces.map(w => ({ ...w, path: expandHome(w.path) }))
  if (roots.some(w => w.path === cwd)) return undefined
  const parent = dirname(cwd)
  return roots.find(w => w.path === parent)
}

export type WorkspaceList = { name: string; path: string; profile: string; folders: { cwd: string; name: string }[] }

/** Each workspace with its project folders, A to Z. */
export function workspaceFolders(workspaces: Workspace[]): WorkspaceList[] {
  const roots = new Set(workspaces.map(w => expandHome(w.path)))
  return workspaces.map(w => {
    const path = expandHome(w.path)
    let folders: { cwd: string; name: string }[] = []
    try {
      folders = readdirSync(path, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !roots.has(join(path, d.name)))
        .map(d => ({ cwd: join(path, d.name), name: d.name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    } catch {}
    return { name: basename(path), path, profile: w.profile, folders }
  })
}

export type Chat = { id: string; title: string; updated: number }

/** Past Claude Code chats in a folder, newest first: the title Claude or /rename gave it,
 *  else your first message. Read from the profile's own history files. */
export function pastChats(cwd: string, configDir: string | undefined, limit = 15): Chat[] {
  const dir = join(configDir ?? join(homedir(), '.claude'), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  let files: { id: string; path: string; updated: number }[] = []
  try {
    files = readdirSync(dir)
      .filter(f => /^[0-9a-f-]{36}\.jsonl$/.test(f))
      .map(f => ({ id: f.slice(0, -6), path: join(dir, f), updated: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.updated - a.updated)
  } catch { return [] }
  const chats: Chat[] = []
  for (const f of files) {
    if (chats.length >= limit) break
    const title = chatTitle(f.path)
    if (title) chats.push({ id: f.id, title, updated: Math.round(f.updated) })
  }
  return chats
}

function chatTitle(path: string): string | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  let custom: string | undefined, ai: string | undefined, first: string | undefined
  for (const line of text.split('\n')) {
    if (line.includes('"custom-title"') || line.includes('"ai-title"')) {
      try {
        const o = JSON.parse(line)
        if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle
        if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle
      } catch {}
    } else if (!first && line.includes('"type":"user"')) {
      try {
        const c = JSON.parse(line).message?.content
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x.type === 'text')?.text : undefined
        // skip the scaffolding Claude Code logs as user turns (commands, caveats, channel tags)
        // a voice message arrives wrapped in a <channel> tag: keep what was said
        const said = t?.startsWith('<channel') ? t.replace(/^<channel[^>]*>|<\/channel>\s*$/g, '') : t
        if (said && !said.startsWith('<')) {
          const one = said.replace(/\s+/g, ' ').trim()
          first = one.length > 80 ? one.slice(0, 79) + '…' : one
        }
      } catch {}
    }
  }
  // nothing at all: opened and closed without a word, not worth resuming
  return custom ?? ai ?? first
}

/** A session name as typed on the phone: one line, no control keys, at most 60 characters. */
export function cleanTitle(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim()
}

export type Started = { ok: true; pid: string; name: string } | { ok: false; error: string }

function tmux(...args: string[]) {
  const r = Bun.spawnSync(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

/** claude-voice flags for the profile a project last used. */
export function profileArgs(configDir?: string): { flags: string[]; env: string[] } {
  if (!configDir || configDir === join(homedir(), '.claude')) return { flags: ['--which-claude=default'], env: [] }
  const m = basename(configDir).match(/^\.claude-(.+)$/)
  if (m && dirname(configDir) === homedir()) return { flags: [`--which-claude=${m[1]}`], env: [] }
  return { flags: [], env: [`CLAUDE_CONFIG_DIR=${configDir}`] }
}

export class Launcher {
  private caffeinate: ReturnType<typeof Bun.spawn> | null = null

  /** The tmux session a Claude process runs in, if handfree started it. */
  tmuxName(pid: string): string | undefined {
    if (!Bun.which('tmux')) return undefined
    const r = tmux('list-panes', '-a', '-F', '#{pane_pid} #{session_name}')
    if (!r.ok) return undefined
    for (const line of r.out.split('\n')) {
      const [panePid, name] = line.split(' ')
      if (panePid === pid && name?.startsWith(PREFIX)) return name
    }
    return undefined
  }

  /** Start claude-voice in a new tmux session and get it past the channels warning.
   *  Resolves once Claude is running; its shim connects to the daemon shortly after. */
  async start(p: Project, opts: { chat?: string; trust: boolean }): Promise<Started> {
    if (!Bun.which('tmux')) return { ok: false, error: 'tmux is not installed. On the Mac: brew install tmux' }
    if (!existsSync(p.cwd)) return { ok: false, error: 'that folder no longer exists' }
    const name = this.freeName(p.name)
    const { flags, env } = profileArgs(p.configDir)
    if (process.env.HANDFREE_HOME) env.push(`HANDFREE_HOME=${process.env.HANDFREE_HOME}`)
    const cmd = [join(ROOT, 'scripts', 'claude-voice'), '--no-browser', '--no-voice', ...flags, ...p.args, ...(opts.chat ? ['--resume', opts.chat] : [])]
    const r = tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', p.cwd, ...env.flatMap(e => ['-e', e]), '--', ...cmd)
    if (!r.ok) return { ok: false, error: r.err || 'tmux failed' }
    // claude-voice execs claude, so the pane's process is Claude itself: its pid is the session key
    const pane = `=${name}:` // exact session name (a bare name also matches prefixes)
    const pid = tmux('display', '-p', '-t', pane, '#{pane_pid}').out
    // the development-channels warning waits for Enter (its first choice is the right one);
    // a folder Claude hasn't opened before asks first whether you trust it
    let screen = ''
    let trusted = false
    for (let i = 0; i < 75; i++) {
      await Bun.sleep(400)
      const cap = tmux('capture-pane', '-p', '-t', pane)
      if (!cap.ok) return { ok: false, error: lastLines(screen) || 'it exited straight away' }
      screen = cap.out
      if (!trusted && screen.includes(TRUST)) {
        if (!opts.trust) {
          tmux('kill-session', '-t', `=${name}`)
          return { ok: false, error: 'Claude hasn\'t opened that folder before. Open it once on the Mac, or add its workspace to the config' }
        }
        if (/❯\s*Yes, I trust this folder/.test(screen)) { tmux('send-keys', '-t', pane, 'Enter'); trusted = true }
        else tmux('send-keys', '-t', pane, 'Down')
        continue
      }
      if (screen.includes(WARNING)) {
        tmux('send-keys', '-t', pane, 'Enter')
        return { ok: true, pid, name }
      }
    }
    return { ok: false, error: `no channels warning after 30 s. On the Mac: tmux attach -t ${name}` }
  }

  /** Ask Claude to exit (after interrupting whatever it's doing); kill it if it won't. */
  end(name: string) {
    const pane = `=${name}:`
    tmux('send-keys', '-t', pane, 'Escape')
    setTimeout(() => {
      tmux('send-keys', '-t', pane, '-l', '/exit')
      tmux('send-keys', '-t', pane, 'Enter')
    }, 500)
    setTimeout(() => { if (tmux('has-session', '-t', `=${name}`).ok) tmux('kill-session', '-t', `=${name}`) }, 15_000)
  }

  /** Press Esc in a session, as at the Mac: Claude stops what it's doing and waits. */
  interrupt(name: string) {
    tmux('send-keys', '-t', `=${name}:`, 'Escape')
  }

  /** Type /rename into a session's prompt, as you would at the Mac. Only while Claude is idle:
   *  mid-task, the line would wait in the prompt instead. */
  rename(name: string, title: string) {
    const pane = `=${name}:`
    tmux('send-keys', '-t', pane, '-l', `/rename ${title}`)
    tmux('send-keys', '-t', pane, 'Enter')
  }

  /** Keep the Mac from idle-sleeping while any Claude session runs. */
  stayAwake(on: boolean) {
    if (process.platform !== 'darwin') return
    if (on && !this.caffeinate) {
      // -w: it ends with the daemon, even if the daemon is killed
      try { this.caffeinate = Bun.spawn(['caffeinate', '-i', '-w', String(process.pid)], { stdout: 'ignore', stderr: 'ignore' }) } catch {}
    } else if (!on && this.caffeinate) {
      this.caffeinate.kill()
      this.caffeinate = null
    }
  }

  private freeName(project: string): string {
    // tmux names can't hold . or :
    const base = PREFIX + (project.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'session')
    let name = base
    for (let n = 2; tmux('has-session', '-t', `=${name}`).ok; n++) name = `${base}-${n}`
    return name
  }
}

function lastLines(screen: string): string {
  return screen.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' · ')
}
