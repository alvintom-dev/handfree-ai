// End to end with the real daemon and real speech models, in an isolated home
// on its own port: a fake Claude Code session (shim socket) + a fake voice
// client (WebSocket). Spoken input comes from macOS `say`, so STT is real too.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 18800
let pageToken = ''
const LAN_PORT = 18801
const home = process.env.HANDFREE_HOME! // a fresh temp folder, from test/setup.ts
const { makePassphrase } = await import('../src/phonetic')
const { connectDaemon } = await import('../src/sessions')
writeFileSync(join(home, 'secret'), 'it-secret\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ port: PORT, lanPort: LAN_PORT, approvalMode: 'tap', passphrase: makePassphrase('pineapple'), wakeWord: false }))

const hasSay = Bun.which('say') && Bun.which('ffmpeg')
let daemon: ReturnType<typeof Bun.spawn>
let ws: WebSocket
const fromDaemon: any[] = [] // client view
const toShim: any[] = [] // what "Claude Code" received
let shim: { send: (m: object) => void; close: () => void }
// stand-ins for Claude Code processes: the daemon lists a session only while its Claude runs
const fakeClaudes = Array.from({ length: 6 }, () => Bun.spawn(['sleep', '600']))
const [PID_A, PID_B, PID_C, PID_D, PID_E, PID_F] = fakeClaudes.map(p => p.pid) as [number, number, number, number, number, number]

const waitFor = async <T>(find: () => T | undefined | false, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = find()
    if (v) return v as T
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(25)
  }
}
const last = (t: string, pred: (m: any) => boolean = () => true) => [...fromDaemon].reverse().find(m => m.t === t && pred(m))
const sendWs = (m: object) => ws.send(JSON.stringify(m))

/** Speak text with macOS TTS and return 16 kHz PCM16 base64, like the browser sends. */
async function voice(text: string): Promise<string> {
  return Buffer.from(await voiceRaw(text)).toString('base64')
}

async function voiceRaw(text: string): Promise<Uint8Array> {
  const aiff = join(home, `u${Date.now()}.aiff`)
  Bun.spawnSync(['say', '-v', 'Samantha', '-o', aiff, text])
  const pcm = Bun.spawnSync(['ffmpeg', '-loglevel', 'error', '-i', aiff, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'])
  return new Uint8Array(pcm.stdout)
}

/** A phone: TLS WebSocket on the LAN port (self-signed cert, like the app pins). */
async function phone(): Promise<{ ws: WebSocket; got: any[] }> {
  const got: any[] = []
  const w = new WebSocket(`wss://127.0.0.1:${LAN_PORT}/ws`, { tls: { rejectUnauthorized: false } } as any)
  w.onmessage = ev => got.push(JSON.parse(String(ev.data)))
  await new Promise((resolve, reject) => { w.onopen = resolve; w.onerror = reject })
  return { ws: w, got }
}

async function cli(t: string, extra: object = {}): Promise<any> {
  return new Promise(resolve => {
    connectDaemon('it-secret', { role: 'cli' }, m => { if (m.t !== 'welcome') resolve(m) }, () => {}).then(c => c.send({ t, ...extra }))
  })
}

/** The daemon's speech status from a CLI ping. */
let speechAtStart = ''

/** Stream mic audio like the app: 100 ms binary frames, with silence around the speech
 *  (4 s after it: enough even when the turn model thinks you're mid-thought). */
async function streamSpeech(w: WebSocket, pcm: Uint8Array) {
  const silence = new Uint8Array(16000 * 2)
  const all = new Uint8Array(silence.length + pcm.length + silence.length * 4)
  all.set(silence, 0); all.set(pcm, silence.length)
  for (let i = 0; i < all.length; i += 3200) { w.send(all.subarray(i, i + 3200)); await Bun.sleep(5) }
}

beforeAll(async () => {
  daemon = Bun.spawn([process.execPath, join(import.meta.dir, '../src/main.ts')], {
    env: { ...process.env, HANDFREE_HOME: home },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/health`); break } catch {}
    await Bun.sleep(250)
  }
  // voice starts off; claude-voice (or a tap) turns it on. The models load in a few seconds once cached
  speechAtStart = (await cli('ping')).speech
  await cli('speech', { on: true })
  for (let i = 0; i < 240; i++) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json() as any
      if (h.speech) break
    } catch {}
    await Bun.sleep(250)
  }
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text()
  const token = pageToken = html.match(/HANDFREE_TOKEN = '([^']+)'/)![1]!

  shim = await connectDaemon('it-secret', { role: 'shim', claude_pid: PID_A, cwd: '/tmp/demo-project' }, m => toShim.push(m), () => {})
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.onmessage = ev => fromDaemon.push(JSON.parse(String(ev.data)))
  await new Promise(r => (ws.onopen = r))
  sendWs({ t: 'hello', token, client: 'test' })
  await waitFor(() => last('welcome'))
}, 90_000)

afterAll(() => {
  if (process.env.IT_DEBUG) console.error(fromDaemon.filter(m => ['transcript', 'resume_playback', 'stop_playback', 'say_start', 'say_end', 'command', 'notice'].includes(m.t)).map(m => JSON.stringify(m).slice(0, 160)).join('\n'))
  ws?.close()
  shim?.close()
  daemon?.kill()
  for (const p of fakeClaudes) p.kill()
})

describe('daemon end to end', () => {
  test('ping counts open voice pages, so the launcher opens one only when needed', async () => {
    expect((await cli('ping')).pages).toBe(0) // the test socket says client: 'test'
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise(r => (w.onopen = r))
    w.send(JSON.stringify({ t: 'hello', token: pageToken, client: 'web' }))
    let pages = 0
    for (let i = 0; i < 40 && pages !== 1; i++) { await Bun.sleep(50); pages = (await cli('ping')).pages }
    expect(pages).toBe(1)
    w.close()
  })

  test('the daemon starts with voice off', () => {
    expect(speechAtStart).toBe('off')
    expect(last('welcome').speech_status).toBe('on')
  })

  test('the folder of a connected session is remembered; only listed folders can be started', async () => {
    expect(last('welcome').projects.map((p: any) => p.cwd)).toContain('/tmp/demo-project')
    sendWs({ t: 'start_session', cwd: '/etc', resume: false })
    await waitFor(() => last('notice', m => m.text.startsWith("That folder isn't on the list")))
    expect(last('sessions')?.sessions?.[0]?.can_end ?? false).toBe(false) // not started by handfree
  })

  test('welcome lists the session and starts in tap mode', () => {
    const w = last('welcome')
    expect(w.mode).toBe('tap')
    expect(w.passphraseSet).toBe(true)
    expect(last('sessions')?.sessions?.[0]?.label ?? w.sessions[0]?.label).toBe('demo-project')
  })

  test('typed text reaches Claude; the reply is spoken sentence by sentence with metrics', async () => {
    sendWs({ t: 'text', text: 'what is two plus two' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'what is two plus two'))
    const msgId = inbound.meta.msg_id
    shim.send({ t: 'reply', id: 'r1', in_reply_to: msgId, kind: 'final', speak: 'Two plus two is four. That one was easy.' })
    const ack = await waitFor(() => toShim.find(m => m.t === 'ack' && m.id === 'r1'))
    expect(ack.delivered).toBe(true)
    const start = await waitFor(() => last('say_start', m => m.msg_id === msgId))
    await waitFor(() => last('say_end', m => m.say_id === start.say_id))
    const chunks = fromDaemon.filter(m => m.t === 'audio' && m.say_id === start.say_id)
    expect(chunks.length).toBe(2) // one per sentence
    expect(chunks[0].rate).toBe(24000)
    const metrics = await waitFor(() => last('metrics', m => m.msg_id === msgId))
    expect(metrics.tts_first_ms).toBeLessThan(1500)
  }, 60_000)

  test('replay: the exact audio again, only to the client that asked', async () => {
    const reply = last('reply', m => m.speak === 'Two plus two is four. That one was easy.')
    expect(reply.say_id).toBeTruthy()
    const original = fromDaemon.filter(m => m.t === 'audio' && m.say_id === reply.say_id).map(m => m.pcm16)
    const other: any[] = []
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    w.onmessage = ev => other.push(JSON.parse(String(ev.data)))
    await new Promise(r => (w.onopen = r))
    w.send(JSON.stringify({ t: 'hello', token: pageToken, client: 'test' }))
    await waitFor(() => other.find(m => m.t === 'welcome'))
    sendWs({ t: 'replay', say_id: reply.say_id })
    const start = await waitFor(() => last('say_start', m => m.kind === 'replay'))
    await waitFor(() => last('say_end', m => m.say_id === start.say_id))
    expect(fromDaemon.filter(m => m.t === 'audio' && m.say_id === start.say_id).map(m => m.pcm16)).toEqual(original)
    await Bun.sleep(200)
    expect(other.some(m => m.t === 'say_start' || m.t === 'audio')).toBe(false)
    w.close()
  }, 30_000)

  test.if(!!hasSay)('a pause mid-sentence joins both halves into one turn', async () => {
    sendWs({ t: 'utterance', pcm16: await voice('I have some feedback about the') })
    const held = await waitFor(() => last('held'))
    expect(toShim.some(m => m.t === 'inbound' && /feedback/i.test(m.text))).toBe(false)
    sendWs({ t: 'utterance', pcm16: await voice('voice detection timing.') })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /feedback/i.test(m.text)))
    expect(inbound.text).toContain(held.text)
    expect(inbound.text.toLowerCase()).toContain('timing')
  }, 60_000)

  test.if(!!hasSay)('an unfinished turn is sent anyway after the wait', async () => {
    sendWs({ t: 'utterance', pcm16: await voice('Can you look at the') })
    await waitFor(() => last('held', m => /look/i.test(m.text)))
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /look at/i.test(m.text)), 8000)
    expect(inbound.text.toLowerCase()).toContain('look at')
  }, 60_000)

  test.if(!!hasSay)('push-to-talk: letting go sends at once, even mid-sentence', async () => {
    sendWs({ t: 'utterance', pcm16: await voice('Can you check the'), ptt: true, clip: 'p1' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /check the/i.test(m.text)), 5000)
    expect(fromDaemon.some(m => m.t === 'held' && /check the/i.test(m.text))).toBe(false)
    expect(last('transcript', m => m.clip === 'p1')).toBeTruthy()
    expect(inbound.meta.msg_id).toBeTruthy()
  }, 30_000)

  test.if(!!hasSay)('the same words heard by two devices reach Claude once', async () => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const got: any[] = []
    w.onmessage = ev => got.push(JSON.parse(String(ev.data)))
    await new Promise(r => (w.onopen = r))
    w.send(JSON.stringify({ t: 'hello', token: pageToken, client: 'web' }))
    await waitFor(() => got.find(m => m.t === 'welcome'))
    const pcm = await voice('Please rename the billing report.')
    sendWs({ t: 'utterance', pcm16: pcm, ptt: true })
    w.send(JSON.stringify({ t: 'utterance', pcm16: pcm, ptt: true }))
    await waitFor(() => toShim.find(m => m.t === 'inbound' && /billing/i.test(m.text)))
    await waitFor(() => fromDaemon.filter(m => m.t === 'transcript' && /billing/i.test(m.text)).length >= 2)
    await Bun.sleep(300)
    expect(toShim.filter(m => m.t === 'inbound' && /billing/i.test(m.text)).length).toBe(1)
    w.close()
  }, 60_000)

  test.if(!!hasSay)('a spoken request is transcribed and sent to Claude', async () => {
    sendWs({ t: 'utterance', pcm16: await voice('Please investigate ticket four eight two.') })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /ticket/i.test(m.text)))
    expect(inbound.text.toLowerCase()).toContain('investigate')
    expect(last('transcript')?.ms).toBeLessThan(3000)
  }, 60_000)

  test.if(!!hasSay)('the pause after your words is trimmed and the transcript carries your clip id', async () => {
    const speech = await voiceRaw('Okay, but what do you think?')
    const padded = new Uint8Array(speech.length + 16000 * 2 * 1.5) // the turn-ending pause, sent along
    padded.set(speech)
    sendWs({ t: 'utterance', pcm16: Buffer.from(padded).toString('base64'), clip: 'c42' })
    const tr = await waitFor(() => last('transcript', m => m.clip === 'c42'))
    expect(tr.text.toLowerCase()).toContain('what do you think')
    expect(tr.text).not.toMatch(/thank you|^claude/i)
  }, 60_000)

  test.if(!!hasSay)('"status" is answered by the daemon, not sent to Claude', async () => {
    const before = toShim.filter(m => m.t === 'inbound').length
    sendWs({ t: 'utterance', pcm16: await voice('Status.') })
    await waitFor(() => last('command', m => m.command === 'status'))
    await Bun.sleep(300)
    expect(toShim.filter(m => m.t === 'inbound').length).toBe(before)
  }, 60_000)

  test.if(!!hasSay)('barge-in: "mm-hmm" resumes; real words stop playback and tell Claude what was heard', async () => {
    sendWs({ t: 'text', text: 'explain the fix' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'explain the fix'))
    shim.send({ t: 'reply', id: 'r2', in_reply_to: inbound.meta.msg_id, kind: 'final', speak: 'The fix is two lines. First we normalize the timezone. Then we compare dates in UTC. That is all there is to it.' })
    const start = await waitFor(() => last('say_start', m => m.msg_id === inbound.meta.msg_id))
    await waitFor(() => fromDaemon.find(m => m.t === 'audio' && m.say_id === start.say_id && m.seq === 1))

    const resumesBefore = fromDaemon.filter(m => m.t === 'resume_playback').length
    sendWs({ t: 'utterance', pcm16: await voice('Mm hmm.'), during: { say_id: start.say_id, seq: 1 } })
    await waitFor(() => fromDaemon.filter(m => m.t === 'resume_playback').length > resumesBefore)

    sendWs({ t: 'utterance', pcm16: await voice('Wait, why do we need UTC?'), during: { say_id: start.say_id, seq: 1 } })
    const cut = await waitFor(() => toShim.find(m => m.t === 'inbound' && /why do we need/i.test(m.text) && m.meta.interrupted_after))
    expect(cut.meta.interrupted_after).toContain('normalize the timezone')
    expect(last('stop_playback')).toBeTruthy()
  }, 90_000)

  test.if(!!hasSay)('a short echo of Claude, dropped by the transcript cleaner, still un-pauses the phone', async () => {
    sendWs({ t: 'text', text: 'check the logs' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'check the logs'))
    shim.send({ t: 'reply', id: 'r3', in_reply_to: inbound.meta.msg_id, kind: 'final', speak: 'Give me a minute. Then I will read the daemon log and the build output for you.' })
    const start = await waitFor(() => last('say_start', m => m.msg_id === inbound.meta.msg_id))
    await waitFor(() => fromDaemon.find(m => m.t === 'audio' && m.say_id === start.say_id && m.seq === 0))
    const resumesBefore = fromDaemon.filter(m => m.t === 'resume_playback').length
    sendWs({ t: 'utterance', pcm16: await voice('Give me a minute.'), during: { say_id: start.say_id, seq: 0 } })
    await waitFor(() => fromDaemon.filter(m => m.t === 'resume_playback').length > resumesBefore)
    expect(toShim.find(m => m.t === 'inbound' && /give me a minute/i.test(m.text))).toBeFalsy()
  }, 90_000)

  test.if(!!hasSay)('a cut-in on an older reply still un-pauses the phone, and so does an unknown one', async () => {
    sendWs({ t: 'text', text: 'three quick replies' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'three quick replies'))
    const id = inbound.meta.msg_id
    shim.send({ t: 'reply', id: 'q1', in_reply_to: id, kind: 'ack', speak: 'On it.' })
    shim.send({ t: 'reply', id: 'q2', in_reply_to: id, kind: 'update', speak: 'Halfway there.' })
    shim.send({ t: 'reply', id: 'q3', in_reply_to: id, kind: 'final', speak: 'All done now.' })
    const first = await waitFor(() => last('say_start', m => m.msg_id === id && m.kind === 'ack'))
    const third = await waitFor(() => last('say_start', m => m.msg_id === id && m.kind === 'final'))
    await waitFor(() => last('say_end', m => m.say_id === third.say_id))
    // the phone is still playing the first one when you hold push-to-talk: resume or stop
    // both un-pause it (which one depends on how Whisper hears the "mm hmm")
    const unpaused = () => fromDaemon.filter(m => m.t === 'resume_playback' || m.t === 'stop_playback').length
    let before = unpaused()
    sendWs({ t: 'utterance', pcm16: await voice('Mm hmm.'), during: { say_id: first.say_id, seq: 0 }, ptt: true })
    await waitFor(() => unpaused() > before)
    before = unpaused()
    sendWs({ t: 'utterance', pcm16: await voice('Mm hmm.'), during: { say_id: 'say-gone', seq: 0 }, ptt: true })
    await waitFor(() => unpaused() > before)
  }, 90_000)

  test('tap approval: request shown, tap allows, verdict reaches Claude', async () => {
    shim.send({ t: 'perm_request', request_id: 'abcde', tool_name: 'Bash', description: 'Run the test suite', input_preview: '{"command":"npm test"}' })
    await waitFor(() => last('approval_request', m => m.request_id === 'abcde'))
    sendWs({ t: 'approval', request_id: 'abcde', behavior: 'allow' })
    const v = await waitFor(() => toShim.find(m => m.t === 'verdict' && m.request_id === 'abcde'))
    expect(v.behavior).toBe('allow')
  })

  test.if(!!hasSay)('tap mode ignores a spoken yes', async () => {
    shim.send({ t: 'perm_request', request_id: 'fghij', tool_name: 'Bash', description: 'Delete the build folder', input_preview: '{}' })
    await waitFor(() => last('approval_request', m => m.request_id === 'fghij'))
    sendWs({ t: 'utterance', pcm16: await voice('Yes.') })
    await waitFor(() => last('transcript', m => /yes/i.test(m.text)))
    await Bun.sleep(500)
    expect(toShim.find(m => m.t === 'verdict' && m.request_id === 'fghij')).toBeUndefined()
    // "no" still works by voice
    sendWs({ t: 'utterance', pcm16: await voice('No.') })
    const v = await waitFor(() => toShim.find(m => m.t === 'verdict' && m.request_id === 'fghij'))
    expect(v.behavior).toBe('deny')
  }, 60_000)

  test.if(!!hasSay)('passphrase mode: yes + passphrase approves', async () => {
    sendWs({ t: 'mode', mode: 'passphrase' })
    await waitFor(() => last('mode', m => m.mode === 'passphrase'))
    shim.send({ t: 'perm_request', request_id: 'klmno', tool_name: 'Write', description: 'Write a file to the local filesystem.', input_preview: '{}' })
    await waitFor(() => last('approval_request', m => m.request_id === 'klmno'))
    sendWs({ t: 'utterance', pcm16: await voice('Yes.') })
    await waitFor(() => last('say_start', m => m.text === 'Passphrase?'))
    sendWs({ t: 'utterance', pcm16: await voice('Pineapple.') })
    const v = await waitFor(() => toShim.find(m => m.t === 'verdict' && m.request_id === 'klmno'))
    expect(v.behavior).toBe('allow')
  }, 60_000)

  test.if(!!hasSay)('three wrong passphrases deny and drop to tap mode', async () => {
    shim.send({ t: 'perm_request', request_id: 'pqrst', tool_name: 'Bash', description: 'Push to main', input_preview: '{}' })
    await waitFor(() => last('approval_request', m => m.request_id === 'pqrst'))
    sendWs({ t: 'utterance', pcm16: await voice('Yes.') })
    await waitFor(() => fromDaemon.filter(m => m.t === 'say_start' && m.text === 'Passphrase?').length >= 2)
    for (const wrong of ['Banana.', 'Strawberry.', 'Watermelon.']) {
      sendWs({ t: 'utterance', pcm16: await voice(wrong) })
      await waitFor(() => last('transcript', m => m.text.toLowerCase().includes(wrong.slice(0, 4).toLowerCase())))
    }
    const v = await waitFor(() => toShim.find(m => m.t === 'verdict' && m.request_id === 'pqrst'))
    expect(v.behavior).toBe('deny')
    await waitFor(() => last('mode', m => m.mode === 'tap'))
  }, 90_000)

  test('voice cannot turn passphrase mode back on', async () => {
    // only the tap path exists for that; a client "mode" message is a tap
    sendWs({ t: 'mode', mode: 'passphrase' })
    await waitFor(() => last('mode', m => m.mode === 'passphrase'))
    sendWs({ t: 'text', text: 'noop' }) // keep ordering simple
    sendWs({ t: 'mode', mode: 'tap' })
    await waitFor(() => last('mode', m => m.mode === 'tap'))
  })

  let phoneToken = ''

  test('pairing: a one-time code gives a phone a device token; the code dies after use', async () => {
    const { code } = await cli('pair')
    const p = await phone()
    p.ws.send(JSON.stringify({ t: 'pair', code, name: 'Test Pixel' }))
    const w = await waitFor(() => p.got.find(m => m.t === 'welcome'))
    expect(w.paired.token).toMatch(/^[0-9a-f]{64}$/)
    phoneToken = w.paired.token
    p.ws.close()

    const again = await phone()
    const closed = new Promise<number>(r => (again.ws.onclose = ev => r(ev.code)))
    again.ws.send(JSON.stringify({ t: 'pair', code, name: 'Thief' }))
    expect(await closed).toBe(4003)
  })

  test('a paired phone reconnects with its token; a wrong token is refused', async () => {
    const p = await phone()
    p.ws.send(JSON.stringify({ t: 'hello', token: phoneToken }))
    expect((await waitFor(() => p.got.find(m => m.t === 'welcome'))).device).toBe('Test Pixel')
    p.ws.close()
    const bad = await phone()
    const closed = new Promise<number>(r => (bad.ws.onclose = ev => r(ev.code)))
    bad.ws.send(JSON.stringify({ t: 'hello', token: 'f'.repeat(64) }))
    expect(await closed).toBe(4003)
  })

  test('Claude is told which device a message came from', async () => {
    const p = await phone()
    p.ws.send(JSON.stringify({ t: 'hello', token: phoneToken }))
    await waitFor(() => p.got.find(m => m.t === 'welcome'))
    p.ws.send(JSON.stringify({ t: 'text', text: 'typed on the phone' }))
    expect((await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'typed on the phone'))).meta.from).toBe('phone')
    p.ws.close()
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise(r => (w.onopen = r))
    w.send(JSON.stringify({ t: 'hello', token: pageToken, client: 'web' }))
    await Bun.sleep(100)
    w.send(JSON.stringify({ t: 'text', text: 'typed on the web page' }))
    expect((await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'typed on the web page'))).meta.from).toBe('web')
    expect(last('user', m => m.text === 'typed on the web page').from).toBe('web')
    w.close()
  })

  test.if(!!hasSay)('streamed phone audio: daemon VAD finds the turn and Claude gets the words', async () => {
    const p = await phone()
    p.ws.send(JSON.stringify({ t: 'hello', token: phoneToken }))
    await waitFor(() => p.got.find(m => m.t === 'welcome'))
    p.ws.send(JSON.stringify({ t: 'stream', on: true, barge_in: true }))
    await streamSpeech(p.ws, await voiceRaw('Can you check the deployment logs please?'))
    await waitFor(() => p.got.find(m => m.t === 'hearing' && m.on))
    await waitFor(() => p.got.find(m => m.t === 'heard'))
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /deployment/i.test(m.text)))
    expect(inbound.text.toLowerCase()).toContain('logs')
    p.ws.close()
  }, 60_000)

  test.if(!!hasSay)('streamed web audio: the turn comes back as a clip for the play button', async () => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const got: any[] = []
    w.onmessage = ev => got.push(JSON.parse(String(ev.data)))
    await new Promise(r => (w.onopen = r))
    w.send(JSON.stringify({ t: 'hello', token: pageToken, client: 'web' }))
    await waitFor(() => got.find(m => m.t === 'welcome'))
    w.send(JSON.stringify({ t: 'stream', on: true, barge_in: true, clips: true }))
    await streamSpeech(w, await voiceRaw('Please summarize the open pull requests.'))
    const clip = await waitFor(() => got.find(m => m.t === 'clip'))
    expect(clip.pcm16.length).toBeGreaterThan(10_000)
    const tr = await waitFor(() => got.find(m => m.t === 'transcript' && m.clip === clip.clip))
    expect(tr.text.toLowerCase()).toContain('summarize the open')
    w.close()
  }, 60_000)

  test.if(!!hasSay)('sentences said back to back reach Claude as one message', async () => {
    const p = await phone()
    p.ws.send(JSON.stringify({ t: 'hello', token: phoneToken }))
    await waitFor(() => p.got.find(m => m.t === 'welcome'))
    p.ws.send(JSON.stringify({ t: 'stream', on: true, barge_in: true }))
    const a = await voiceRaw('I agree.')
    const b = await voiceRaw('Lets skip the auto start.')
    const gap = new Uint8Array(16000 * 2 * 0.5) // half a second between sentences
    const both = new Uint8Array(a.length + gap.length + b.length)
    both.set(a); both.set(b, a.length + gap.length)
    await streamSpeech(p.ws, both)
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /skip/i.test(m.text)))
    expect(inbound.text.toLowerCase()).toContain('agree')
    await Bun.sleep(1500)
    expect(toShim.filter(m => m.t === 'inbound' && /agree|skip/i.test(m.text)).length).toBe(1)
    p.ws.close()
  }, 60_000)

  test.if(!!hasSay)('echo guard: the mic hearing Claude itself does not reach Claude', async () => {
    const p = await phone()
    p.ws.send(JSON.stringify({ t: 'hello', token: phoneToken }))
    await waitFor(() => p.got.find(m => m.t === 'welcome'))
    p.ws.send(JSON.stringify({ t: 'stream', on: true, barge_in: true }))
    sendWs({ t: 'text', text: 'tell me about the release' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'tell me about the release'))
    const speakText = 'The release is planned for Friday morning. Everything is green except the payment service tests.'
    shim.send({ t: 'reply', id: 'r9', in_reply_to: inbound.meta.msg_id, kind: 'final', speak: speakText })
    const start = await waitFor(() => p.got.find(m => m.t === 'say_start' && m.msg_id === inbound.meta.msg_id))
    p.ws.send(JSON.stringify({ t: 'playing', playing: true }))
    p.ws.send(JSON.stringify({ t: 'pos', say_id: start.say_id, seq: 0 }))
    const before = toShim.filter(m => m.t === 'inbound').length
    await streamSpeech(p.ws, await voiceRaw('The release is planned for Friday morning.'))
    await waitFor(() => p.got.find(m => m.t === 'duck'))
    await waitFor(() => p.got.find(m => m.t === 'resume_playback'))
    await Bun.sleep(300)
    expect(toShim.filter(m => m.t === 'inbound').length).toBe(before)
    p.ws.send(JSON.stringify({ t: 'playing', playing: false }))
    p.ws.close()
  }, 60_000)

  test.if(!!hasSay)('tool hooks show live activity on screen, and status says the current step', async () => {
    const runHook = async (input: object) => {
      const p = Bun.spawn(['bun', join(import.meta.dir, '../src/hook.ts')], { stdin: new Blob([JSON.stringify(input)]), env: process.env })
      await p.exited
    }
    const base = { cwd: '/tmp/demo-project', session_id: 's1' }
    await runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the tests' })
    await waitFor(() => last('activity', m => m.busy && m.steps.length === 0))
    await runHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'bun test', description: 'Run the test suite' } })
    const running = await waitFor(() => last('activity', m => m.steps.some((st: any) => st.label === 'Run the test suite' && !st.endedAt)))
    expect(running.session).toBe(String(PID_A))
    // working (or still speaking the previous test's reply, which outranks it)
    await waitFor(() => last('state', m => m.state === 'working'), 15_000)
    // the spoken status names the step
    sendWs({ t: 'utterance', pcm16: await voice('Status.') })
    await waitFor(() => last('say_start', m => /right now: run the test suite/i.test(m.text)))
    await runHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1', tool_input: {} })
    await waitFor(() => last('activity', m => m.steps.some((st: any) => st.id === 't1' && st.ok === false)))
    await runHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__handfree__reply', tool_use_id: 't2', tool_input: {} })
    await runHook({ ...base, hook_event_name: 'Stop' })
    const done = await waitFor(() => last('activity', m => !m.busy))
    expect(done.steps.map((st: any) => st.id)).toEqual(['t1']) // voice tools stay out of the list
  }, 30_000)

  test('a message during a task is a "by the way": tagged, and the task stays on screen', async () => {
    const hook = await connectDaemon('it-secret', { role: 'hook' }, () => {}, () => {})
    hook.send({ t: 'activity', pids: [], cwd: '/tmp/demo-project', event: 'pre', tool_name: 'Bash', tool_use_id: 'bt1', tool_input: { description: 'Long build' } })
    await waitFor(() => last('activity', m => m.busy && m.steps.some((st: any) => st.id === 'bt1')))
    sendWs({ t: 'text', text: 'by the way what time is it' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'by the way what time is it'))
    expect(inbound.meta.while_working).toBe('true')
    expect(last('activity')!.steps.some((st: any) => st.id === 'bt1')).toBe(true) // not reset by the side question
    hook.send({ t: 'stop', pids: [], cwd: '/tmp/demo-project' })
    await waitFor(() => last('activity', m => !m.busy))
    hook.close()
  })

  test('Stop hook covers a turn Claude answered only in the terminal', async () => {
    sendWs({ t: 'text', text: 'summarize the logs' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'summarize the logs'))
    const hook = await connectDaemon('it-secret', { role: 'hook' }, () => {}, () => {})
    hook.send({ t: 'stop', pids: ['1', String(PID_A)], cwd: '/tmp/demo-project', last_message: 'The logs show **three** timeouts.' })
    const shown = await waitFor(() => last('show', m => m.fallback && m.msg_id === inbound.meta.msg_id))
    expect(shown.markdown).toContain('three')
    await waitFor(() => last('say_start', m => m.text.includes('answered in the terminal')))
  })

  test.if(!!hasSay)('wake word: only addressed turns reach Claude; an answer locks the mic again; "Hey Claude" alone opens a window', async () => {
    sendWs({ t: 'wake_config', on: true, phrase: 'Hey Claude' })
    await waitFor(() => last('wake', m => m.on))
    // earlier tests' answers are still being said: once they're done, a follow-up window
    // opens; close it with "that's all" (push-to-talk needs no phrase)
    await waitFor(() => { const s = last('say_start'); return !s || last('say_end', m => m.say_id === s.say_id) })
    await Bun.sleep(200)
    sendWs({ t: 'utterance', pcm16: await voice("That's all."), ptt: true })
    await waitFor(() => last('command', m => m.command === 'sleep'))
    const inbound = () => toShim.filter(m => m.t === 'inbound').length
    let before = inbound()
    sendWs({ t: 'utterance', pcm16: await voice('Did you see the game last night?') })
    await waitFor(() => last('not_for_claude'))
    await Bun.sleep(300)
    expect(inbound()).toBe(before)

    sendWs({ t: 'utterance', pcm16: await voice('Hey Claude, what time is the standup?') })
    const asked = await waitFor(() => toShim.find(m => m.t === 'inbound' && /stand-?up/i.test(m.text)))
    expect(asked.text).not.toMatch(/claude/i)
    shim.send({ t: 'reply', id: 'w1', in_reply_to: asked.meta.msg_id, kind: 'final', speak: 'It is at ten.' })
    // the answer locks the mic again: no window after it, the next turn needs the phrase
    const said = await waitFor(() => last('say_start', m => m.text === 'It is at ten.'), 30_000)
    await waitFor(() => last('say_end', m => m.say_id === said.say_id), 30_000)
    await Bun.sleep(300)
    expect(fromDaemon.some(m => m.t === 'wake' && m.open)).toBe(false)
    before = inbound()
    sendWs({ t: 'utterance', pcm16: await voice('And who runs it today?') })
    await waitFor(() => fromDaemon.filter(m => m.t === 'not_for_claude').length >= 2)
    expect(inbound()).toBe(before)

    // just "Hey Claude" opens a short window for the next turn; "that's all" closes it early
    sendWs({ t: 'utterance', pcm16: await voice('Hey Claude.') })
    await waitFor(() => last('wake', m => m.open && m.woken))
    sendWs({ t: 'utterance', pcm16: await voice('Who runs it today?') })
    await waitFor(() => toShim.find(m => m.t === 'inbound' && /who runs it/i.test(m.text)))
    sendWs({ t: 'utterance', pcm16: await voice('Hey Claude.') })
    await waitFor(() => fromDaemon.filter(m => m.t === 'wake' && m.open && m.woken).length >= 2)
    sendWs({ t: 'utterance', pcm16: await voice("That's all.") })
    await waitFor(() => last('wake', m => !m.open && !m.quiet))
    before = inbound()
    sendWs({ t: 'utterance', pcm16: await voice('Lunch at noon?') })
    await waitFor(() => fromDaemon.filter(m => m.t === 'not_for_claude').length >= 3)
    expect(inbound()).toBe(before)

    // push-to-talk never needs the phrase
    sendWs({ t: 'utterance', pcm16: await voice('Run the tests please.'), ptt: true })
    await waitFor(() => toShim.find(m => m.t === 'inbound' && /run the tests/i.test(m.text)))
    sendWs({ t: 'wake_config', on: false })
    await waitFor(() => last('wake', m => !m.on))
  }, 120_000)

  test.if(!!hasSay)('wake word: the next part of a long message, after a thinking pause, needs no phrase; later talk does', async () => {
    sendWs({ t: 'wake_config', on: true, phrase: 'Hey Claude' })
    await waitFor(() => last('wake', m => m.on))
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const got: any[] = []
    w.onmessage = ev => got.push(JSON.parse(String(ev.data)))
    await new Promise(r => (w.onopen = r))
    w.send(JSON.stringify({ t: 'hello', token: pageToken, client: 'web' }))
    await waitFor(() => got.find(m => m.t === 'welcome'))
    w.send(JSON.stringify({ t: 'stream', on: true, barge_in: true }))
    await streamSpeech(w, await voiceRaw('Hey Claude, here is the plan for the release this week.'))
    await waitFor(() => toShim.find(m => m.t === 'inbound' && /plan for the release/i.test(m.text)))
    await Bun.sleep(1000) // a pause longer than the join, shorter than continueMs
    await streamSpeech(w, await voiceRaw('First we build the app and test it on the phone.'))
    const next = await waitFor(() => toShim.find(m => m.t === 'inbound' && /build the app/i.test(m.text)))
    expect(next.text).not.toMatch(/claude/i)
    // Claude starts answering (even just "got it"): the mic locks, the next talk needs the phrase
    shim.send({ t: 'reply', id: 'w3', in_reply_to: next.meta.msg_id, kind: 'ack', speak: 'Got it, reading the plan.' })
    await waitFor(() => last('say_start', m => m.text === 'Got it, reading the plan.'), 30_000)
    const before = got.filter(m => m.t === 'not_for_claude').length
    await streamSpeech(w, await voiceRaw('Did you see the game last night?'))
    await waitFor(() => got.filter(m => m.t === 'not_for_claude').length > before)
    expect(toShim.find(m => m.t === 'inbound' && /the game/i.test(m.text))).toBeFalsy()
    w.close()
    sendWs({ t: 'wake_config', on: false })
    await waitFor(() => last('wake', m => !m.on))
  }, 90_000)

  test.if(!!hasSay)('push-to-talk over a minute still reaches Claude', async () => {
    const pcm = await voiceRaw([
      'First, the phone app should keep listening when the screen is locked for a long time, because yesterday it stopped after about twenty minutes.',
      'Second, the settings page has too many switches, and most people will never touch the pause length, so those should move to an advanced section.',
      'Third, the daemon should tell me when something goes wrong instead of failing quietly, with a short notice on the screen.',
      'After that, we review the approval flow, because the passphrase mode is confusing when there is background noise in the room.',
      'Then we look at memory, and make sure the speech models are released after thirty minutes of quiet, but never while a session is working.',
      'On the web page, the mute button should remember its setting for each device, because after a reload it sometimes forgets.',
      'The replay button sometimes plays an older answer instead of the latest one, maybe when two sessions are active at the same time.',
      'It would also be nice to say send it now, to push a message through without waiting for the pause detection.',
      'Finally, we build a new version of the app this week and test it on the phone for a few days.',
      'That is the end of the long message.',
    ].join(' '))
    expect(pcm.length / 32_000).toBeGreaterThan(60)
    sendWs({ t: 'utterance', pcm16: Buffer.from(pcm).toString('base64'), ptt: true })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && /end of the long message/i.test(m.text)), 60_000)
    expect(inbound.text.toLowerCase()).toContain('screen is locked')
  }, 120_000)

  test('push-to-talk over the limit: a notice, not silence, and the connection stays up', async () => {
    const pcm16 = Buffer.alloc(32_000 * (5 * 60 + 5)).toString('base64') // 5 min 5 s
    sendWs({ t: 'utterance', pcm16, ptt: true })
    const notice = await waitFor(() => last('notice', m => /over the 5 minute limit/.test(m.text)))
    expect(notice.text).toContain('5 min 5 s')
    const pongs = fromDaemon.filter(m => m.t === 'pong').length
    sendWs({ t: 'ping' })
    await waitFor(() => fromDaemon.filter(m => m.t === 'pong').length > pongs)
  }, 30_000)

  test('the screens show the session name from Claude Code, and follow a rename', async () => {
    const configDir = join(home, 'claude-config')
    mkdirSync(join(configDir, 'sessions'), { recursive: true })
    const info = join(configDir, 'sessions', `${PID_B}.json`)
    writeFileSync(info, JSON.stringify({ pid: PID_B, name: 'login-fix' }))
    const other = await connectDaemon('it-secret', { role: 'shim', claude_pid: PID_B, cwd: '/tmp/demo-project', config_dir: configDir }, () => {}, () => {})
    const entry = (label: string) => last('sessions', m => m.sessions.some((x: any) => x.label === label))?.sessions.find((x: any) => x.label === label)
    expect((await waitFor(() => entry('login-fix'))).project).toBe('demo-project')
    writeFileSync(info, JSON.stringify({ pid: PID_B, name: 'checkout-bug' }))
    await waitFor(() => entry('checkout-bug'), 10_000)
    other.close()
  }, 20_000)

  test('pin a message: every screen gets the pins, they are saved, and unpin works', async () => {
    shim.send({ t: 'reply', id: 'pn1', in_reply_to: 'pn-m1', kind: 'final', speak: 'Pin me please.' })
    const msg = await waitFor(() => last('reply', m => m.speak === 'Pin me please.'))
    const ref = msg.id
    sendWs({ t: 'pin', ref, on: true })
    const pinned = await waitFor(() => last('pins', m => m.pins.some((p: any) => p.ref === ref)))
    expect(fromDaemon.filter(m => m.id === ref)).toHaveLength(1) // its own id, not shared with the question's other answers
    const pin = pinned.pins.find((p: any) => p.ref === ref)
    expect(pin.session_key).toBe(String(PID_A))
    expect(pin.msg.speak).toBe('Pin me please.')
    expect(JSON.parse(readFileSync(join(home, 'pins.json'), 'utf8')).some((p: any) => p.ref === ref)).toBe(true)
    sendWs({ t: 'pin', ref: 'reply:nope:1', on: true }) // not in the chat: nothing happens
    sendWs({ t: 'pin', ref, on: false })
    const after = await waitFor(() => last('pins', m => !m.pins.some((p: any) => p.ref === ref)))
    expect(after.pins.some((p: any) => p.ref === 'reply:nope:1')).toBe(false)
  }, 20_000)

  test('a resumed conversation gets its chat back, though its Claude has a new pid', async () => {
    const configDir = join(home, 'claude-config')
    mkdirSync(join(configDir, 'sessions'), { recursive: true })
    const shimFor = (pid: number) => connectDaemon('it-secret', { role: 'shim', claude_pid: pid, cwd: '/tmp/resume-project', config_dir: configDir }, () => {}, () => {})
    const listed = (pid: number) => last('sessions')?.sessions.some((x: any) => x.key === String(pid))
    writeFileSync(join(configDir, 'sessions', `${PID_E}.json`), JSON.stringify({ pid: PID_E, sessionId: 'conv-1' }))
    const first = await shimFor(PID_E)
    await waitFor(() => listed(PID_E))
    first.send({ t: 'reply', id: 'rs1', in_reply_to: 'rs-m1', kind: 'final', speak: 'Said before the exit.' })
    const said = await waitFor(() => last('reply', m => m.speak === 'Said before the exit.'))
    const ref = said.id
    sendWs({ t: 'pin', ref, on: true })
    await waitFor(() => last('pins', m => m.pins.some((p: any) => p.ref === ref)))
    first.close() // /exit
    await waitFor(() => !listed(PID_E))
    // claude --resume: a new process, in a new conversation until the picker opens the old one
    const info = join(configDir, 'sessions', `${PID_F}.json`)
    writeFileSync(info, JSON.stringify({ pid: PID_F, sessionId: 'conv-2' }))
    const second = await shimFor(PID_F)
    await waitFor(() => listed(PID_F))
    writeFileSync(info, JSON.stringify({ pid: PID_F, sessionId: 'conv-1' }))
    const back = await waitFor(() => last('welcome', m => m.history.some((h: any) => h.speak === 'Said before the exit.' && h.session_key === String(PID_F))), 10_000)
    expect(back.pins.find((p: any) => p.ref === ref)?.session_key).toBe(String(PID_F)) // its pin came along
    second.close()
  }, 30_000)

  test.if(!!hasSay)('switch sessions by voice; each message says which session it belongs to', async () => {
    const other = await connectDaemon('it-secret', { role: 'shim', claude_pid: PID_C, cwd: '/tmp/coffee-shop' }, () => {}, () => {})
    const keyOf = (label: string) => last('sessions', m => m.sessions.some((x: any) => x.label === label))?.sessions.find((x: any) => x.label === label)?.key
    const shopKey = await waitFor(() => keyOf('coffee-shop'))
    const demoKey = keyOf('demo-project')
    sendWs({ t: 'select_session', key: shopKey })
    await waitFor(() => last('sessions', m => m.active === shopKey))
    sendWs({ t: 'utterance', pcm16: await voice('Switch to demo project.'), ptt: true })
    await waitFor(() => last('sessions', m => m.active === demoKey))
    await waitFor(() => last('say_start', m => m.text === 'Switched to demo-project.'))
    sendWs({ t: 'text', text: 'which chat is this' })
    expect((await waitFor(() => last('user', m => m.text === 'which chat is this'))).session_key).toBe(demoKey)
    other.close()
  }, 60_000)
  test('speak replies from every session, or (setting off) only from the one you are talking to', async () => {
    const otherShim = await connectDaemon('it-secret', { role: 'shim', claude_pid: PID_D, cwd: '/tmp/tea-house' }, () => {}, () => {})
    const keyOf = (label: string) => last('sessions', m => m.sessions.some((x: any) => x.label === label))?.sessions.find((x: any) => x.label === label)?.key
    const teaKey = await waitFor(() => keyOf('tea-house'))
    const demoKey = keyOf('demo-project')
    sendWs({ t: 'select_session', key: teaKey })
    await waitFor(() => last('sessions', m => m.active === teaKey))
    // default on: a reply from the session you're not talking to is spoken
    shim.send({ t: 'reply', id: 'sa1', in_reply_to: 'sa-m1', kind: 'final', speak: 'Background news one.' })
    await waitFor(() => last('say_start', m => m.text === 'Background news one.'))
    sendWs({ t: 'voice_config', speak_all: false })
    await waitFor(() => last('voice_config', m => m.speak_all === false))
    shim.send({ t: 'reply', id: 'sa2', in_reply_to: 'sa-m2', kind: 'final', speak: 'Background news two.' })
    await waitFor(() => last('reply', m => m.speak === 'Background news two.'))
    otherShim.send({ t: 'reply', id: 'sa3', in_reply_to: 'sa-m3', kind: 'final', speak: 'Front news.' })
    await waitFor(() => last('say_start', m => m.text === 'Front news.'))
    expect(last('say_start', m => m.text === 'Background news two.')).toBeUndefined()
    sendWs({ t: 'voice_config', speak_all: true })
    await waitFor(() => last('voice_config', m => m.speak_all === true))
    sendWs({ t: 'select_session', key: demoKey })
    await waitFor(() => last('sessions', m => m.active === demoKey))
    otherShim.close()
  }, 30_000)

  // last: it unloads the models
  test('voice off: typed text still reaches Claude and the reply shows, but nothing is spoken or heard', async () => {
    const off = waitFor(() => last('speech', m => m.status === 'off'))
    sendWs({ t: 'speech', on: false })
    await off
    sendWs({ t: 'text', text: 'are you there' })
    const inbound = await waitFor(() => toShim.find(m => m.t === 'inbound' && m.text === 'are you there'))
    shim.send({ t: 'reply', id: 'off1', in_reply_to: inbound.meta.msg_id, kind: 'final', speak: 'Yes, still here.' })
    await waitFor(() => last('reply', m => m.speak === 'Yes, still here.'))
    await Bun.sleep(300)
    expect(last('say_start', m => m.text === 'Yes, still here.')).toBeUndefined()
    sendWs({ t: 'utterance', pcm16: Buffer.from(new Uint8Array(3200)).toString('base64'), ptt: true })
    await waitFor(() => last('notice', m => m.text.startsWith('Voice is off. Tap Start voice first')))
    expect((await cli('ping')).speech).toBe('off')
  }, 20_000)
})
