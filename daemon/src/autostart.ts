// Start the daemon at login (macOS LaunchAgent), so a Mac with no screen is
// ready for the phone: log in, and the daemon is up (speech stays off until asked).

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOG_DIR, ROOT, ensureHome } from './paths'

const LABEL = 'dev.handfree.daemon'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const target = () => `gui/${process.getuid!()}`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function plist(): string {
  const log = join(LOG_DIR, 'daemon.log')
  // launchd starts jobs with a bare PATH; keep this shell's, so bun, claude and tmux are found
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(ROOT, 'daemon', 'src', 'main.ts'))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <!-- restart after a crash; "handfree stop" exits cleanly and stays stopped until next login -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

function launchctl(...args: string[]) {
  return Bun.spawnSync(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' })
}

export function loaded(): boolean {
  return launchctl('print', `${target()}/${LABEL}`).exitCode === 0
}

export function autostartOn(): string {
  if (process.platform !== 'darwin') return 'autostart is macOS only for now'
  ensureHome()
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  if (loaded()) launchctl('bootout', `${target()}/${LABEL}`) // pick up a new PATH or bun
  writeFileSync(PLIST, plist())
  const r = launchctl('bootstrap', target(), PLIST)
  if (r.exitCode !== 0) return `could not load ${PLIST}: ${r.stderr.toString().trim()}`
  return `on: the daemon starts at login (speech stays off until you tap Start voice)\n${PLIST}`
}

export function autostartOff(): string {
  if (process.platform !== 'darwin') return 'autostart is macOS only for now'
  const wasLoaded = loaded()
  if (wasLoaded) launchctl('bootout', `${target()}/${LABEL}`)
  if (existsSync(PLIST)) unlinkSync(PLIST)
  return wasLoaded ? 'off (the daemon it started has stopped; claude-voice starts one when needed)' : 'off'
}

export function autostartStatus(): string {
  if (process.platform !== 'darwin') return 'autostart is macOS only for now'
  if (!existsSync(PLIST)) return 'off'
  return loaded() ? `on (${PLIST})` : `installed but not loaded; run: handfree autostart on`
}
