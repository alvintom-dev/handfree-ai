// Phone access over the local network: TLS certificate, paired devices,
// one-time pairing codes and the Bonjour announcement.

import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { HOME } from './paths'

// --- TLS --------------------------------------------------------------------------

export type Tls = { cert: string; key: string; fingerprint: string }

/** Self-signed cert, created once. The app pins its SHA-256 fingerprint from the QR code. */
export function ensureCert(): Tls {
  const dir = join(HOME, 'tls')
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const r = Bun.spawnSync([
      'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-days', '3650', '-subj', `/CN=handfree-${hostname()}`, '-keyout', keyPath, '-out', certPath,
    ])
    if (r.exitCode !== 0) throw new Error(`openssl failed: ${r.stderr.toString()}`)
    Bun.spawnSync(['chmod', '600', keyPath])
  }
  const cert = readFileSync(certPath, 'utf8')
  const der = Buffer.from(cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  return { cert, key: readFileSync(keyPath, 'utf8'), fingerprint: createHash('sha256').update(der).digest('hex') }
}

// --- devices ----------------------------------------------------------------------

export type Device = { id: string; name: string; tokenHash: string; createdAt: number; lastSeen?: number }

const DEVICES_FILE = join(HOME, 'devices.json')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const randomHex = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('hex')

export class Devices {
  list: Device[] = []

  constructor() {
    try { this.list = JSON.parse(readFileSync(DEVICES_FILE, 'utf8')) } catch {}
  }

  add(name: string): { device: Device; token: string } {
    const token = randomHex(32)
    const device: Device = { id: randomHex(4), name: name.slice(0, 60) || 'phone', tokenHash: sha(token), createdAt: Date.now() }
    this.list.push(device)
    this.save()
    return { device, token }
  }

  verify(token: unknown): Device | null {
    if (typeof token !== 'string' || !token) return null
    const h = Buffer.from(sha(token), 'hex')
    const d = this.list.find(x => timingSafeEqual(Buffer.from(x.tokenHash, 'hex'), h))
    if (d) { d.lastSeen = Date.now(); this.save() }
    return d ?? null
  }

  revoke(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(d => d.id !== id)
    this.save()
    return this.list.length < before
  }

  private save() {
    writeFileSync(DEVICES_FILE, JSON.stringify(this.list, null, 2) + '\n', { mode: 0o600 })
  }
}

// --- pairing ----------------------------------------------------------------------

const PAIR_TTL_MS = 5 * 60_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I

export class Pairing {
  private active: { code: string; expires: number } | null = null

  start(): { code: string; expires: number } {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const code = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    this.active = { code, expires: Date.now() + PAIR_TTL_MS }
    return this.active
  }

  /** Single use: a code works once, then it's gone. */
  consume(code: unknown): boolean {
    const a = this.active
    if (!a || typeof code !== 'string' || Date.now() > a.expires) return false
    if (code.toUpperCase().replace(/[^A-Z0-9]/g, '') !== a.code) return false
    this.active = null
    return true
  }
}

/** What the QR code carries: where to connect, the one-time code, the cert to pin. */
export function pairingUrl(opts: { port: number; code: string; fingerprint: string }): string {
  const hosts = lanAddresses().join(',')
  return `handfree://pair?h=${hosts}&p=${opts.port}&c=${opts.code}&f=${opts.fingerprint}&n=${encodeURIComponent(hostname())}`
}

// --- network ------------------------------------------------------------------------

export function lanAddresses(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && isPrivate(a.address, true)) out.push(a.address)
  }
  return out
}

/** v1 accepts only private-network clients. Tailscale (100.64/10) is opt-in. */
export function isPrivate(ip: string, allowTailscale: boolean): boolean {
  const v4 = ip.replace(/^::ffff:/, '')
  if (v4 === '::1') return true
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return /^(fc|fd|fe80)/i.test(ip)
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (allowTailscale && a === 100 && b >= 64 && b <= 127)
}

/** Announce on the LAN so the app finds the Mac after its IP changes. macOS only for now. */
export function announce(port: number, fingerprint: string): () => void {
  if (process.platform !== 'darwin') return () => {}
  const proc = Bun.spawn(['dns-sd', '-R', `Handfree on ${hostname().replace(/\.local$/, '')}`, '_handfree._tcp', 'local', String(port), `fp=${fingerprint.slice(0, 32)}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return () => proc.kill()
}
