// Drives the shim the way Claude Code does (MCP over stdio) against a fake
// daemon on a temporary socket, and checks every relay path.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

// from the repo root, daemon/test/setup.ts already set one (and paths.ts has read it)
const home = process.env.HANDFREE_HOME ?? mkdtempSync(join(tmpdir(), 'handfree-test-'))
process.env.HANDFREE_HOME = home
writeFileSync(join(home, 'secret'), 'test-secret\n', { mode: 0o600 })
const { listenSessions } = await import('../../daemon/src/sessions')

const SHIM = new URL('../handfree-channel.ts', import.meta.url).pathname
const channelEvents: { content: string; meta: Record<string, string> }[] = []
const verdicts: { request_id: string; behavior: string }[] = []
const fromShim: any[] = []
let session: any
let deliver = true
let client: Client
let listener: ReturnType<typeof listenSessions>

const waitFor = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

async function spawnShim(env: Record<string, string>) {
  const c = new Client({ name: 'fake-claude-code', version: '0' })
  c.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
    async ({ params }) => { channelEvents.push(params) },
  )
  c.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel/permission'), params: z.object({ request_id: z.string(), behavior: z.string() }) }),
    async ({ params }) => { verdicts.push(params) },
  )
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SHIM], env: { ...process.env, ...env } as Record<string, string> }))
  return c
}

beforeAll(async () => {
  listener = listenSessions('test-secret', {
    onSession: (s, connected) => { if (connected) session = s },
    onShimMessage: (_s, msg, respond) => {
      fromShim.push(msg)
      if (msg.t === 'reply' || msg.t === 'show') respond({ t: 'ack', id: msg.id, delivered: deliver })
      if (msg.t === 'picture_get') respond(msg.picture === 'p1'
        ? { t: 'ack', id: msg.id, delivered: true, mime: 'image/png', data: 'iVBORw0KGgo=' }
        : { t: 'ack', id: msg.id, delivered: false, error: 'no such picture' })
      if (msg.t === 'picture_send') respond({ t: 'ack', id: msg.id, delivered: true })
    },
    onHookStop: () => {},
    onHookActivity: () => {},
    onCli: () => {},
  })
  client = await spawnShim({ HANDFREE_HOME: home })
  await waitFor(() => !!session)
})

afterAll(async () => {
  await client.close()
  listener.stop(true)
})

test('declares channel + permission capabilities and instructions', () => {
  const caps = client.getServerCapabilities()!
  expect(caps.experimental?.['claude/channel']).toEqual({})
  expect(caps.experimental?.['claude/channel/permission']).toEqual({})
  expect(client.getInstructions()).toContain('kind=final FIRST')
})

test('exposes reply, show, picture and send_picture, marked to load upfront', async () => {
  const { tools } = await client.listTools()
  expect(tools.map(t => t.name).sort()).toEqual(['picture', 'reply', 'send_picture', 'show'])
  for (const t of tools) expect(t._meta?.['anthropic/alwaysLoad']).toBe(true)
})

test('registers with the daemon as its Claude Code session', () => {
  expect(session.key).toBe(String(process.pid)) // the shim's parent plays Claude Code here
  expect(session.cwd).toBe(process.cwd())
  expect(session.pictures).toBe(true) // it can fetch pictures for Claude
})

test('picture returns the image from the daemon, or an error Claude can read', async () => {
  const r = await client.callTool({ name: 'picture', arguments: { id: 'p1' } })
  expect(r.content).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
  expect(fromShim.at(-1)).toMatchObject({ t: 'picture_get', picture: 'p1' })
  const gone = await client.callTool({ name: 'picture', arguments: { id: 'p9' } })
  expect(gone.isError).toBe(true)
  expect((gone.content as any)[0].text).toBe('no such picture')
})

test('send_picture reads the file and hands it to the daemon', async () => {
  const file = join(home, 'shot.png')
  await Bun.write(file, Buffer.from('iVBORw0KGgo=', 'base64'))
  const r = await client.callTool({ name: 'send_picture', arguments: { in_reply_to: 'v1', path: file, caption: 'login page' } })
  expect((r.content as any)[0].text).toBe('shown')
  expect(fromShim.at(-1)).toMatchObject({ t: 'picture_send', in_reply_to: 'v1', data: 'iVBORw0KGgo=', caption: 'login page' })
  const missing = await client.callTool({ name: 'send_picture', arguments: { in_reply_to: 'v1', path: join(home, 'nope.png') } })
  expect(missing.isError).toBe(true)
})

test('daemon inbound becomes a channel event with msg_id and the reply reminder', async () => {
  session.send({ t: 'inbound', text: 'investigate ticket 482', meta: { msg_id: 'v1', interrupted_after: 'the fix is', 'bad-key': 'x' } })
  await waitFor(() => channelEvents.length === 1)
  expect(channelEvents[0]!.content).toBe('investigate ticket 482')
  expect(channelEvents[0]!.meta.msg_id).toBe('v1')
  expect(channelEvents[0]!.meta.interrupted_after).toBe('the fix is')
  expect(channelEvents[0]!.meta.answer_with).toContain('mcp__handfree__reply')
  expect(channelEvents[0]!.meta['bad-key']).toBeUndefined() // Claude Code drops non-identifier keys anyway
})

test('reply and show relay to the daemon and report delivery', async () => {
  const r = await client.callTool({ name: 'reply', arguments: { in_reply_to: 'v1', kind: 'final', speak: 'Found it.' } })
  expect((r.content as any)[0].text).toBe('spoken')
  expect(fromShim.at(-1)).toMatchObject({ t: 'reply', in_reply_to: 'v1', kind: 'final', speak: 'Found it.' })

  deliver = false
  const s = await client.callTool({ name: 'show', arguments: { in_reply_to: 'v1', markdown: '| a |' } })
  expect((s.content as any)[0].text).toContain('no voice client')
  deliver = true
})

test('invalid reply args are a tool error Claude can read', async () => {
  const r = await client.callTool({ name: 'reply', arguments: { in_reply_to: 'v1', kind: 'shout', speak: 'x' } })
  expect(r.isError).toBe(true)
})

test('permission relay: request to daemon, verdict back', async () => {
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'Create a file', input_preview: '{"command":"touch x"}' },
  })
  await waitFor(() => fromShim.some(m => m.t === 'perm_request' && m.request_id === 'abcde'))
  session.send({ t: 'verdict', request_id: 'abcde', behavior: 'allow' })
  await waitFor(() => verdicts.length === 1)
  expect(verdicts[0]).toEqual({ request_id: 'abcde', behavior: 'allow' })
})

test('without a daemon, reply tells Claude to answer in the terminal', async () => {
  const lonely = mkdtempSync(join(tmpdir(), 'handfree-nodaemon-'))
  writeFileSync(join(lonely, 'secret'), 'x\n')
  const c = await spawnShim({ HANDFREE_HOME: lonely })
  const r = await c.callTool({ name: 'reply', arguments: { in_reply_to: 'v9', kind: 'final', speak: 'hi' } })
  expect((r.content as any)[0].text).toContain('not reachable')
  await c.close()
})
