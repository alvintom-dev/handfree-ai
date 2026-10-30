// Voice clients. Two listeners share one client registry:
//   local  http://127.0.0.1:<port>      the web page (token embedded in the page)
//   LAN    wss://<lan-ip>:<lanPort>      paired phones (TLS, device token, private IPs only)
// Clients send JSON control frames; phones also stream raw 16 kHz PCM16 mic
// audio as binary frames, which the daemon's VAD turns into utterances.

import { join } from 'node:path'
import QRCode from 'qrcode'
import type { Server, ServerWebSocket } from 'bun'
import type { Conductor } from './conductor'
import { type Devices, type Pairing, type Tls, isPrivate, lanAddresses, pairingUrl } from './lan'
import { ROOT } from './paths'

type ClientData = { id: string; authed: boolean; lan: boolean; device?: string; page?: boolean }

const PUBLIC = join(ROOT, 'daemon', 'public')
/** push-to-talk sends the whole turn in one message: up to 5 min (about 8 s of Whisper) */
const MAX_UTTERANCE_MIN = 5
const MAX_UTTERANCE_B64 = Math.ceil(16_000 * 2 * 60 * MAX_UTTERANCE_MIN * 4 / 3) // 16 kHz PCM16, base64
const MAX_FRAME_BYTES = 16_000 * 2 // 1 s of streamed audio per frame

export type HubOptions = {
  port: number
  lanPort: number
  token: string
  tls: Tls | null
  devices: Devices
  pairing: Pairing
  allowTailscale: boolean
}

export function startHub(conductor: Conductor, opts: HubOptions) {
  const clients = new Map<string, ServerWebSocket<ClientData>>()
  let nextClient = 1

  conductor.attachHub({
    broadcast(msg) {
      const data = JSON.stringify(msg)
      for (const ws of clients.values()) if (ws.data.authed) ws.send(data)
    },
    sendTo(clientId, msg) {
      clients.get(clientId)?.send(JSON.stringify(msg))
    },
    clientCount: () => [...clients.values()].filter(c => c.data.authed).length,
    from(clientId) {
      const c = clients.get(clientId)
      return c?.data.lan ? 'phone' : c?.data.page ? 'web' : undefined
    },
    rewelcome() {
      for (const ws of clients.values()) if (ws.data.authed) welcome(ws)
    },
  })

  function authed(ws: ServerWebSocket<ClientData>, extra: object = {}) {
    ws.data.authed = true
    welcome(ws, extra)
    if (ws.data.device) broadcastPhones()
  }

  function welcome(ws: ServerWebSocket<ClientData>, extra: object = {}) {
    // phones keep these, so they can still reach the Mac over Tailscale when away from home
    const hosts = ws.data.lan ? { hosts: lanAddresses().filter(ip => isPrivate(ip, opts.allowTailscale)) } : {}
    ws.send(JSON.stringify({ ...conductor.welcome(), client_id: ws.data.id, phones: phones(), ...hosts, ...extra }))
  }

  /** Paired phones, and which are connected now: the web page shows it. */
  function phones() {
    const online = [...clients.values()].filter(c => c.data.authed && c.data.device).map(c => c.data.device!)
    return { paired: opts.devices.list.map(d => d.name), online }
  }
  function broadcastPhones() {
    const data = JSON.stringify({ t: 'phones', ...phones() })
    for (const c of clients.values()) if (c.data.authed && c.data.page) c.send(data)
  }

  async function onMessage(ws: ServerWebSocket<ClientData>, raw: string | Buffer) {
    if (typeof raw !== 'string') {
      if (ws.data.authed && raw.byteLength <= MAX_FRAME_BYTES) conductor.onAudioFrame(ws.data.id, raw.toString('base64'))
      return
    }
    let msg: any
    try { msg = JSON.parse(raw) } catch { return }

    if (!ws.data.authed) {
      if (!ws.data.lan && msg.t === 'hello' && msg.token === opts.token) {
        ws.data.page = msg.client === 'web'
        return authed(ws)
      }
      if (ws.data.lan && msg.t === 'hello') {
        const device = opts.devices.verify(msg.token)
        if (device) { ws.data.device = device.name; return authed(ws, { device: device.name }) }
      }
      if (ws.data.lan && msg.t === 'pair' && opts.pairing.consume(msg.code)) {
        const { device, token } = opts.devices.add(String(msg.name ?? 'phone'))
        ws.data.device = device.name
        console.error(`[handfree] paired device "${device.name}" (${device.id})`)
        conductor.notice(`Paired ${device.name}.`)
        return authed(ws, { paired: { device_id: device.id, token } })
      }
      return ws.close(4003, 'not authorized')
    }

    if (msg.t === 'ping') { ws.send('{"t":"pong"}'); return }
    if (msg.t === 'utterance' && typeof msg.pcm16 !== 'string') return
    if (msg.t === 'utterance' && msg.pcm16.length > MAX_UTTERANCE_B64) {
      // never silently: you'd think Claude heard you
      const secs = Math.round(msg.pcm16.length * 3 / 4 / 32_000)
      console.error(`[handfree] turn dropped: ${secs} s of push-to-talk, over the ${MAX_UTTERANCE_MIN} min limit`)
      ws.send(JSON.stringify({ t: 'notice', text: `That recording was ${Math.floor(secs / 60)} min ${secs % 60} s, over the ${MAX_UTTERANCE_MIN} minute limit, so it wasn't sent. Say it in shorter pieces.` }))
      if (msg.during) ws.send('{"t":"resume_playback"}')
      return
    }
    if (msg.t === 'pair_start') {
      // only the local page may hand out pairing codes
      if (ws.data.lan || !opts.tls) return
      const { code, expires } = opts.pairing.start()
      const url = pairingUrl({ port: opts.lanPort, code, fingerprint: opts.tls.fingerprint })
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      ws.send(JSON.stringify({ t: 'pair_qr', url, code, expires, svg }))
      return
    }
    conductor.onClientMessage(ws.data.id, msg)
  }

  const websocket = {
    // well over the push-to-talk limit, so a recording a little too long gets a notice, not a cut connection
    maxPayloadLength: 32 * 1024 * 1024,
    idleTimeout: 120,
    open(ws: ServerWebSocket<ClientData>) {
      clients.set(ws.data.id, ws)
      setTimeout(() => { if (!ws.data.authed) ws.close(4001, 'auth timeout') }, 10_000)
    },
    message: onMessage,
    close(ws: ServerWebSocket<ClientData>) {
      clients.delete(ws.data.id)
      conductor.onClientGone(ws.data.id)
      if (ws.data.device) broadcastPhones()
    },
  }

  async function page(): Promise<Response> {
    const html = (await Bun.file(join(PUBLIC, 'index.html')).text()).replace('__HANDFREE_TOKEN__', opts.token)
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
  }

  const local = Bun.serve<ClientData>({
    port: opts.port,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') {
        return srv.upgrade(req, { data: { id: `c${nextClient++}`, authed: false, lan: false } })
          ? undefined
          : new Response('upgrade failed', { status: 400 })
      }
      if (req.method !== 'GET') return new Response('not found', { status: 404 })
      if (url.pathname === '/') return page()
      if (/^\/(vendor\/)?[\w.-]+\.(js|mjs|css|svg|png|wasm|onnx|task)$/.test(url.pathname)) {
        const file = Bun.file(join(PUBLIC, url.pathname.slice(1)))
        if (await file.exists()) {
          const cache = url.pathname.startsWith('/vendor/') ? 'max-age=86400' : 'no-store'
          return new Response(file, { headers: { 'Cache-Control': cache } })
        }
      }
      // a screenshot Claude sent to the chat: the page's token as ?token=, since an <img> can't send a header
      const pic = /^\/picture\/(s\d+)$/.exec(url.pathname)
      if (pic) {
        const p = url.searchParams.get('token') === opts.token ? conductor.sentPicture(pic[1]!) : undefined
        return p
          ? new Response(p.data, { headers: { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' } })
          : new Response('not found', { status: 404 })
      }
      if (url.pathname === '/health') return Response.json({ ok: true, state: conductor.state, speech: conductor.speechStatus === 'on', speech_status: conductor.speechStatus })
      return new Response('not found', { status: 404 })
    },
    websocket,
  })

  let lan: Server<ClientData> | null = null
  if (opts.tls) {
    try {
      lan = Bun.serve<ClientData>({
        port: opts.lanPort,
        hostname: '0.0.0.0',
        tls: { cert: opts.tls.cert, key: opts.tls.key },
        fetch(req, srv) {
          const ip = srv.requestIP(req)?.address ?? ''
          if (!isPrivate(ip, opts.allowTailscale)) return new Response('forbidden', { status: 403 })
          const url = new URL(req.url)
          if (url.pathname === '/ws') {
            return srv.upgrade(req, { data: { id: `p${nextClient++}`, authed: false, lan: true } })
              ? undefined
              : new Response('upgrade failed', { status: 400 })
          }
          if (url.pathname === '/health') return Response.json({ ok: true, app: 'handfree' })
          return new Response('not found', { status: 404 })
        },
        websocket,
      })
    } catch (err) {
      console.error(`[handfree] LAN listener on ${opts.lanPort} failed (phones can't connect):`, err)
    }
  }
  /** voice pages open on this Mac (the launcher opens one only if there are none) */
  const pages = () => [...clients.values()].filter(c => c.data.authed && c.data.page).length
  return { local, lan, pages }
}
