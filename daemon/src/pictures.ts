// Pictures sent from the phone or the web page for Claude to look at. Memory only,
// like replay audio: the last few, for an hour, gone when the daemon restarts.
// Claude fetches one through the shim's picture tool, and only the session it was
// sent to can. The other way, screenshots Claude sends to the chat wait here too, for
// the screens to load by id.

export type Picture = { id: string; mime: string; data: Buffer; sessionKey: string; at: number }

/** Claude reads images up to 5 MB; the apps shrink screenshots well below that. */
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024

/** The image type from the file's first bytes (what a client says it is doesn't count). */
export function pictureType(b: Buffer): string | undefined {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif'
  return undefined
}

export class Pictures {
  private list: Picture[] = []
  private counter = 0

  constructor(private max = 20, private ttlMs = 60 * 60_000, private now = () => Date.now(), private prefix = 'p') {}

  add(data: Buffer, sessionKey: string): Picture | { error: string } {
    if (data.length > MAX_PICTURE_BYTES) return { error: `that picture is ${(data.length / 1048576).toFixed(1)} MB; the limit is 5 MB` }
    const mime = pictureType(data)
    if (!mime) return { error: 'that isn\'t a JPEG, PNG, WebP or GIF picture' }
    this.prune()
    const p = { id: `${this.prefix}${++this.counter}`, mime, data, sessionKey, at: this.now() }
    this.list.push(p)
    if (this.list.length > this.max) this.list.shift()
    return p
  }

  get(id: string, sessionKey: string): Picture | undefined {
    this.prune()
    return this.list.find(p => p.id === id && p.sessionKey === sessionKey)
  }

  /** Any session's: for the screens, which show every session's chat. */
  find(id: string): Picture | undefined {
    this.prune()
    return this.list.find(p => p.id === id)
  }

  private prune() {
    const cutoff = this.now() - this.ttlMs
    this.list = this.list.filter(p => p.at >= cutoff)
  }
}
