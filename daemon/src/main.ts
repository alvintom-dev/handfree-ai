#!/usr/bin/env bun
// handfreed: the long-running daemon. One per machine; Claude Code sessions
// come and go through their channel shims.

import { fullDiskAccess } from './access'
import { Conductor } from './conductor'
import { startHub } from './hub'
import { Devices, Pairing, announce, ensureCert, lanAddresses, pairingUrl, type Tls } from './lan'
import { ensureHome, loadConfig, loadSecret, SOCKET } from './paths'
import { connectDaemon, listenSessions } from './sessions'
import { Speech } from './speech'

// every log line gets the time, so a lost turn can be matched to what the screens showed
const logLine = console.error.bind(console)
console.error = (...args: unknown[]) => logLine(new Date().toLocaleString('sv-SE'), ...args) // 2026-10-25 15:20:03

ensureHome()
const secret = loadSecret(true)
const config = loadConfig()

// refuse to start twice
const alreadyRunning = await connectDaemon(secret, { role: 'cli' }, () => {}, () => {})
  .then(c => { c.close(); return true })
  .catch(() => false)
if (alreadyRunning) {
  console.error(`[handfree] daemon already running (${SOCKET})`)
  process.exit(0)
}

const speech = new Speech({ HANDFREE_TTS_ENGINE: config.ttsEngine, HANDFREE_VOICE: config.voice, HANDFREE_VOICE_STYLE: config.voiceStyle, HANDFREE_PAUSE_MS: String(config.pauseMs), HANDFREE_MAX_PAUSE_MS: String(config.maxPauseMs) })
// the models (~4 GB) load only when someone taps Start voice, or claude-voice asks
const conductor = new Conductor(speech, config)

// The web page gets this token embedded; other local pages can't read it.
const pageToken = crypto.randomUUID()

listenSessions(secret, {
  onSession: (s, connected) => conductor.onSession(s, connected),
  onShimMessage: (s, msg, respond) => conductor.onShimMessage(s, msg, respond),
  onHookStop: msg => conductor.onHookStop(msg),
  onHookActivity: msg => conductor.onHookActivity(msg),
  onCli: (msg, respond) => {
    if (msg.t === 'ping') respond({ t: 'pong', state: conductor.state, speech: speech.status, port: config.port, sessions: conductor.sessions.size, pages: pages(), full_disk: fullDiskAccess(), exec: process.execPath })
    else if (msg.t === 'speech') {
      conductor.setVoice(msg.on === true, 'cli')
      respond({ t: 'ok', speech: speech.status })
    }
    else if (msg.t === 'reload_config') {
      Object.assign(config, loadConfig())
      conductor.updateState()
      respond({ t: 'ok', mode: config.approvalMode, passphraseSet: !!config.passphrase })
    } else if (msg.t === 'pair') {
      if (!tls) return respond({ t: 'error', message: 'phone access disabled (no TLS certificate)' })
      const { code, expires } = pairing.start()
      respond({ t: 'pair', code, expires, url: pairingUrlFor(code) })
    } else if (msg.t === 'devices') {
      respond({ t: 'devices', devices: devices.list.map(({ tokenHash, ...d }) => d) })
    } else if (msg.t === 'revoke') {
      respond({ t: 'ok', revoked: devices.revoke(String(msg.id)) })
    } else if (msg.t === 'shutdown') {
      respond({ t: 'ok' })
      unannounce()
      speech.stop()
      setTimeout(() => process.exit(0), 100)
    }
  },
})

let tls: Tls | null = null
try { tls = ensureCert() } catch (err) { console.error('[handfree] no TLS certificate, phone access disabled:', err) }
const devices = new Devices()
const pairing = new Pairing()
const { lan, pages } = startHub(conductor, { port: config.port, lanPort: config.lanPort, token: pageToken, tls, devices, pairing, allowTailscale: config.allowTailscale })
const unannounce = lan && tls ? announce(config.lanPort, tls.fingerprint) : () => {}
console.error(`[handfree] daemon up: http://127.0.0.1:${config.port}  (socket ${SOCKET})`)
if (lan) console.error(`[handfree] phones: wss://${lanAddresses()[0] ?? '<lan-ip>'}:${config.lanPort}  (${devices.list.length} paired)`)

function pairingUrlFor(code: string) {
  return pairingUrl({ port: config.lanPort, code, fingerprint: tls!.fingerprint })
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { unannounce(); speech.stop(); process.exit(0) })
}
