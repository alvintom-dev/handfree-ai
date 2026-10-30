#!/usr/bin/env bun
// handfree CLI.
//   ensure            start the daemon if it isn't running, wait until it answers
//   status            show daemon state
//   open              open the voice page in the browser, unless one is already open
//   set-passphrase    choose the spoken approval passphrase (typed, hidden)
//   pair              show a QR code to pair a phone (valid 5 minutes, single use)
//   devices           list paired phones
//   revoke <id>       unpair a phone
//   voice on|off      load or unload the speech models (~4 GB) for every device
//   autostart on|off|status   start the daemon at login (macOS), for a Mac with no screen
//   permissions       check the daemon can read files without macOS popups; open the setting if not
//   stop              shut the daemon down

import { openSync } from 'node:fs'
import QRCode from 'qrcode'
import { join } from 'node:path'
import { autostartOff, autostartOn, autostartStatus } from './autostart'
import { makePassphrase, soundKey } from './phonetic'
import { LOG_DIR, ROOT, ensureHome, loadConfig, loadSecret, saveConfig } from './paths'
import { connectDaemon } from './sessions'

async function ask(t: string, timeoutMs = 1500, extra: object = {}): Promise<any | null> {
  let secret: string
  try { secret = loadSecret() } catch { return null }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    connectDaemon(secret, { role: 'cli' }, msg => {
      if (msg.t === 'welcome') return
      clearTimeout(timer)
      resolve(msg)
    }, () => {}).then(c => c.send({ t, ...extra }), () => { clearTimeout(timer); resolve(null) })
  })
}

/** Open the voice page in the background (the terminal keeps focus for Claude's
 *  prompt), unless a page is already open. A tab left from before a daemon restart
 *  reconnects within a couple of seconds, so give it that long to show up. */
async function openPage() {
  let r: any = null
  for (let i = 0; i < 10; i++) {
    r = await ask('ping', 500)
    if (r?.pages) return
    await Bun.sleep(300)
  }
  if (!r) return
  const url = `http://127.0.0.1:${r.port}`
  const argv = process.platform === 'darwin' ? ['open', '-g', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url]
  try { Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' }) } catch {}
}

async function ensure() {
  const up = await ask('ping')
  if (up) return console.error(`handfree: daemon running (${up.state}) on http://127.0.0.1:${up.port}`)
  ensureHome()
  const log = openSync(join(LOG_DIR, 'daemon.log'), 'a')
  const proc = Bun.spawn([process.execPath, join(ROOT, 'daemon', 'src', 'main.ts')], {
    stdio: ['ignore', log, log],
    detached: true,
  })
  proc.unref()
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(250)
    const r = await ask('ping', 500)
    if (r) return console.error(`handfree: daemon started on http://127.0.0.1:${r.port} (voice is off until you turn it on)`)
  }
  console.error(`handfree: daemon did not start; see ${join(LOG_DIR, 'daemon.log')}`)
  process.exit(1)
}

async function setPassphrase() {
  process.stdout.write('Passphrase word (hidden): ')
  const word = await readHidden()
  const key = soundKey(word)
  const config = loadConfig()
  config.passphrase = makePassphrase(word)
  saveConfig(config)
  await ask('reload_config')
  console.log(`\nSaved. Matching is by sound (key length ${key.length}). Switch to Passphrase mode with a tap in the app.`)
}

function readHidden(): Promise<string> {
  return new Promise(resolve => {
    const stdin = process.stdin
    let value = ''
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.on('data', (buf: Buffer) => {
      for (const ch of buf.toString()) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode?.(false); stdin.pause(); return resolve(value.trim()) }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
      }
    })
  })
}

/** Sessions the phone starts run under the daemon, so macOS asks *it* (as "bun") for Downloads,
 *  Documents, other apps' data… Full Disk Access, once, answers all of those ahead of time. */
async function permissions() {
  const r = await ask('ping')
  if (!r) { console.error('handfree: daemon not running (handfree ensure)'); process.exit(1) }
  if (r.full_disk === null || r.full_disk === undefined) return console.log('Nothing to do: not macOS.')
  if (r.full_disk) return console.log(`OK: the daemon (${r.exec}) has Full Disk Access, so sessions from the phone won't stop at file popups.`)
  console.log(`The daemon (${r.exec}) has no Full Disk Access, so a session started from the phone
can stop at a macOS popup ("bun would like to access files in your Downloads folder") until
someone clicks it at the Mac. To fix it once:

  1. In System Settings (opening now) > Privacy & Security > Full Disk Access, click +.
  2. Press Cmd+Shift+G, paste ${r.exec}, press Enter, then Open. Make sure its switch is on.
     (Or drag bun from the Finder window that opens into the list.)
  3. Restart the daemon so it picks it up:
       ${autostartStatus().startsWith('on') ? `launchctl kickstart -k gui/${process.getuid?.()}/dev.handfree.daemon` : 'handfree stop && handfree ensure'}
  4. Check: handfree permissions

Automation, Contacts and Calendar popups aren't covered: answer each once at the Mac, and macOS remembers.`)
  Bun.spawn(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { stdout: 'ignore', stderr: 'ignore' })
  Bun.spawn(['open', '-R', r.exec], { stdout: 'ignore', stderr: 'ignore' })
}

const cmd = process.argv[2]
if (cmd === 'ensure') await ensure()
else if (cmd === 'status') console.log(JSON.stringify(await ask('ping') ?? { running: false }))
else if (cmd === 'open') await openPage()
else if (cmd === 'set-passphrase') await setPassphrase()
else if (cmd === 'pair') {
  const r = await ask('pair')
  if (!r) { console.error('handfree: daemon not running (start a voice session, or: handfree ensure)'); process.exit(1) }
  if (r.t === 'error') { console.error(`handfree: ${r.message}`); process.exit(1) }
  console.log(await QRCode.toString(r.url, { type: 'terminal', small: true }))
  console.log(`Scan with the Handfree app, or enter code ${r.code.slice(0, 4)}-${r.code.slice(4)} (valid 5 minutes).`)
} else if (cmd === 'devices') {
  const r = await ask('devices')
  for (const d of r?.devices ?? []) console.log(`${d.id}  ${d.name}  paired ${new Date(d.createdAt).toLocaleString()}${d.lastSeen ? `  last seen ${new Date(d.lastSeen).toLocaleString()}` : ''}`)
  if (!r?.devices?.length) console.log('no paired devices')
} else if (cmd === 'revoke') {
  const r = await ask('revoke', 1500, { id: process.argv[3] })
  console.log(r?.revoked ? 'revoked' : 'no such device')
}
else if (cmd === 'voice' && (process.argv[3] === 'on' || process.argv[3] === 'off')) {
  const r = await ask('speech', 1500, { on: process.argv[3] === 'on' })
  if (!r) { console.error('handfree: daemon not running (handfree ensure)'); process.exit(1) }
  console.error(`handfree: voice ${r.speech === 'loading' ? 'loading (about 4 s)' : r.speech}`)
} else if (cmd === 'autostart' && process.argv[3] === 'on') console.log(`autostart ${autostartOn()}`)
else if (cmd === 'autostart' && process.argv[3] === 'off') console.log(`autostart ${autostartOff()}`)
else if (cmd === 'autostart') console.log(`autostart ${autostartStatus()}`)
else if (cmd === 'permissions') await permissions()
else if (cmd === 'stop') console.log((await ask('shutdown')) ? 'stopped' : 'not running')
else {
  console.error('usage: handfree <ensure|status|open|set-passphrase|pair|devices|revoke <id>|voice on|off|autostart on|off|status|permissions|stop>')
  process.exit(2)
}
process.exit(0)
