#!/usr/bin/env bun
// Handfree channel shim.
//
// Claude Code spawns this as an MCP server over stdio, one per session. It is a
// thin relay to the handfree daemon (local socket), which owns voice, clients
// and approvals:
//   daemon "inbound"   -> notifications/claude/channel        (user speaks)
//   reply / show tool  -> daemon                               (Claude answers)
//   permission_request -> daemon;  daemon "verdict" -> permission (approvals)
//   picture tool       -> daemon -> the image             (a picture sent from the phone or web)
//   send_picture tool  -> daemon -> the chat              (a screenshot Claude shows the user)
//
// stdout belongs to MCP. Log with console.error only.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolve } from 'node:path'
import { z } from 'zod'
import { loadSecret } from '../daemon/src/paths'
import { connectDaemon, pidAlive } from '../daemon/src/sessions'

const INSTRUCTIONS = `Messages from the user arrive as <channel source="handfree" msg_id="...">, transcribed from speech. They may contain transcription slips; read for intent. Always answer with the handfree tools, passing msg_id as in_reply_to.
- If the task takes more than a few seconds, first call reply with kind=ack: one short sentence saying what you are about to do.
- For a progress note during long work, call reply with kind=update: one short sentence, only when something worth hearing changed.
- When done, call reply with kind=final FIRST, then call show with the detail. Never write the detail before the spoken answer.
- Keep speak short: 2 to 4 short sentences (about 15 seconds aloud). Say the answer first, in plain words, like a colleague talking face to face. If you need a decision, end with one question.
- Everything else goes in show, not in speak: lists, steps, options, file names, numbers, reasoning. Say in one phrase that it is on screen. Skip show when there is nothing more to read.
- Speak longer only when the user asks you to explain or walk them through something, or says "tell me more": then talk through the detail (yours or the last show) in natural sentences.
- Never put code, file paths, URLs, tables or symbols in speak. Name things in words.
- Make show visual, so it reads at a glance: pictures first, prose last. Start with a ## title and a > [!TLDR] line, use ### for sections, keep labels short and prose to a few short bullets. Blocks the screen draws:
  - \`\`\`mermaid for flows, structures and sequences (about 8 boxes; flowchart node classes hi, ok, warn, bad, e.g. "class A ok")
    and for charts: "pie title …" then "Label" : 42 lines, or "xychart-beta" with x-axis [a, b], y-axis, bar […] / line […]
  - \`\`\`stats for numbers, one tile per line: Label | Value | note | bar:60
  - \`\`\`options for choices: a line "A* Title | effort 1-3" per option (* = the one you recommend), then "+ pro" / "- con" lines
  - \`\`\`steps for plans and progress, one per line: done|next|todo|fail | Title | detail
  - \`\`\`wireframe for screen layouts (mobile or web front end): a line "phone | Title" (or browser, tablet) starts a screen, then one element per line "kind | label": bar, header, text, input, search, select, button (button* = main), link, image | label | height, card | title | subtitle, list | a | b | c, tabs / chips / nav / sidebar | A | B* | C (* = active), toggle, check, radio, avatar, grid | a | b, table | col | col, divider, space, fab, row | button Yes | button No. Add a cell "note: ..." to pin a numbered note on an element. Several screens in one block draw side by side as a flow.
  - \`\`\`tiles for an overview grid (two to a row) of topics, results or articles: Title | short note | https picture link (optional). Write each tile's detail as a "### Title" section after it: a tap opens it (a tile without one asks you for more)
  - pictures from the web (an article's photo, a chart image): ![what it shows](https link)
  - \`\`\`design for a link card to a finished design: Title | https link | note. When the user wants a polished screen design and your tools can make a Claude Design artifact, make it there and link it with this block; keep wireframes for quick sketches while talking.
  - tables for side-by-side comparisons (✓ ✗ ~), > [!TIP], > [!WARNING] for risks, and > [!DECIDE] with a short list of possible answers when you need a decision
  A one-line answer needs no blocks.
- A tag's from says where the user spoke or typed: phone (the Android app) or web (the page on the Mac). Write the same reply either way; each screen lays it out for its size.
- If a tag carries interrupted_after, the user cut you off after hearing that text; take it into account.
- If a tag carries picture, the user sent a picture with the message: call picture with that id to see it before you answer.
- To show the user a screenshot or other image file from this Mac (a test run's screenshot, a chart you rendered), call send_picture with its path: it appears in their chat. PNG, JPEG, WebP or GIF, up to 5 MB.
- If a tag carries while_working, the user spoke while you were mid-task (a "by the way"). Answer it right away with reply kind=final for that msg_id in one or two sentences, then carry on with the task. Only stop or change course if the message asks you to.
- Keep words in other languages and domain terms as the user said them; don't translate them.`

// answer_with rides on every message: resumed sessions sometimes lose track of
// the connect-time instructions (tool names, short speech), or repeat an old
// "I have no tool" conclusion.
const ANSWER_WITH = 'mcp__handfree__reply, 2 to 4 short sentences (then mcp__handfree__show with the detail, if any)'

// Without this, sessions with many MCP tools defer ours behind tool search, and
// Claude may answer in the terminal instead of loading them first.
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true }

// --- daemon link ------------------------------------------------------------------

type Link = { send: (m: object) => void; close: () => void }
let link: Link | null = null
let nextReq = 1
const acks = new Map<string, (ack: any | null) => void>()

async function connect() {
  try {
    const conn = await connectDaemon(
      loadSecret(),
      { role: 'shim', claude_pid: process.ppid, cwd: process.cwd(), config_dir: process.env.CLAUDE_CONFIG_DIR, launch_args: process.env.HANDFREE_LAUNCH_ARGS, features: ['picture'] },
      onDaemonMessage,
      () => {
        if (link === conn) link = null
        for (const [, resolve] of acks) resolve(null)
        acks.clear()
        setTimeout(connect, 2000)
      },
    )
    link = conn
    console.error('[handfree] connected to daemon')
  } catch {
    setTimeout(connect, 2000)
  }
}

async function onDaemonMessage(msg: any) {
  if (msg.t === 'inbound') {
    const meta: Record<string, string> = { answer_with: ANSWER_WITH }
    for (const [k, v] of Object.entries(msg.meta ?? {})) if (/^\w+$/.test(k)) meta[k] = String(v)
    await mcp.notification({ method: 'notifications/claude/channel', params: { content: String(msg.text), meta } })
  } else if (msg.t === 'verdict') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: msg.request_id, behavior: msg.behavior === 'allow' ? 'allow' : 'deny' },
    })
  } else if (msg.t === 'ack') {
    acks.get(msg.id)?.(msg)
    acks.delete(msg.id)
  }
}

/** Sends to the daemon and waits for its ack (null if there's no daemon). */
function ask(msg: object): Promise<any | null> {
  if (!link) return Promise.resolve(null)
  const id = `r${nextReq++}`
  return new Promise(resolve => {
    const timer = setTimeout(() => { acks.delete(id); resolve(null) }, 3000)
    acks.set(id, ack => { clearTimeout(timer); resolve(ack) })
    link!.send({ ...msg, id })
  })
}

/** Sends to the daemon: true if a voice client got it, null if no daemon. */
async function relay(msg: object): Promise<boolean | null> {
  const ack = await ask(msg)
  return ack ? !!ack.delivered : null
}

// --- MCP server -------------------------------------------------------------------

const mcp = new Server(
  { name: 'handfree', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Speak to the user. This is the only way the user hears you. Call it before show.',
      inputSchema: {
        type: 'object',
        properties: {
          in_reply_to: { type: 'string', description: 'msg_id from the <channel> tag' },
          kind: { type: 'string', enum: ['ack', 'update', 'final'] },
          speak: { type: 'string', description: 'What to say aloud: 2 to 4 short sentences, answer first, natural and face to face; no code, paths, URLs or tables (those go in show)' },
        },
        required: ['in_reply_to', 'kind', 'speak'],
      },
      _meta: ALWAYS_LOAD,
    },
    {
      name: 'show',
      description: 'Show the detailed answer on the user\'s screen as markdown. Call it after reply.',
      inputSchema: {
        type: 'object',
        properties: {
          in_reply_to: { type: 'string', description: 'msg_id from the <channel> tag' },
          markdown: { type: 'string', description: 'Visual markdown: ## title, > [!TLDR], then mermaid (diagrams, charts) / stats / options / steps / wireframe / tiles / design blocks, web pictures, tables, > [!WARNING], > [!DECIDE] (formats in the server instructions)' },
        },
        required: ['in_reply_to', 'markdown'],
      },
      _meta: ALWAYS_LOAD,
    },
    {
      name: 'picture',
      description: 'See a picture the user sent from the phone or the web page (a <channel> tag with picture="..."). Returns the image.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the picture attribute of the <channel> tag, like p3' } },
        required: ['id'],
      },
      _meta: ALWAYS_LOAD,
    },
    {
      name: 'send_picture',
      description: 'Show the user an image file from this Mac (a screenshot from a test run, a chart) in their chat. PNG, JPEG, WebP or GIF, up to 5 MB.',
      inputSchema: {
        type: 'object',
        properties: {
          in_reply_to: { type: 'string', description: 'msg_id from the <channel> tag' },
          path: { type: 'string', description: 'the image file, absolute or relative to the working directory' },
          caption: { type: 'string', description: 'optional short line under the picture' },
        },
        required: ['in_reply_to', 'path'],
      },
      _meta: ALWAYS_LOAD,
    },
  ],
}))

const ReplyArgs = z.object({ in_reply_to: z.string(), kind: z.enum(['ack', 'update', 'final']), speak: z.string().min(1) })
const ShowArgs = z.object({ in_reply_to: z.string(), markdown: z.string().min(1) })
const PictureArgs = z.object({ id: z.string().min(1) })
const SendPictureArgs = z.object({ in_reply_to: z.string(), path: z.string().min(1), caption: z.string().optional() })

const toolError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] })
const toolText = (text: string) => ({ content: [{ type: 'text', text }] })

function outcome(delivered: boolean | null, done: string) {
  if (delivered === null) return toolText('the handfree daemon is not reachable; the user did not get this. Answer in the terminal.')
  return toolText(delivered ? done : 'no voice client is connected; the user did not get this')
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params
  if (name === 'reply') {
    const a = ReplyArgs.safeParse(args)
    if (!a.success) return toolError(`invalid reply arguments: ${z.prettifyError(a.error)}`)
    return outcome(await relay({ t: 'reply', ...a.data }), 'spoken')
  }
  if (name === 'show') {
    const a = ShowArgs.safeParse(args)
    if (!a.success) return toolError(`invalid show arguments: ${z.prettifyError(a.error)}`)
    return outcome(await relay({ t: 'show', ...a.data }), 'shown')
  }
  if (name === 'picture') {
    const a = PictureArgs.safeParse(args)
    if (!a.success) return toolError(`invalid picture arguments: ${z.prettifyError(a.error)}`)
    const ack = await ask({ t: 'picture_get', picture: a.data.id })
    if (!ack) return toolError('the handfree daemon is not reachable')
    if (!ack.delivered) return toolError(String(ack.error ?? 'no such picture'))
    return { content: [{ type: 'image', data: String(ack.data), mimeType: String(ack.mime) }] }
  }
  if (name === 'send_picture') {
    const a = SendPictureArgs.safeParse(args)
    if (!a.success) return toolError(`invalid send_picture arguments: ${z.prettifyError(a.error)}`)
    const file = Bun.file(resolve(a.data.path))
    if (!(await file.exists())) return toolError(`no such file: ${a.data.path}`)
    if (file.size > 5 * 1024 * 1024) return toolError(`that file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 5 MB`)
    const data = Buffer.from(await file.arrayBuffer()).toString('base64')
    const ack = await ask({ t: 'picture_send', in_reply_to: a.data.in_reply_to, data, caption: a.data.caption })
    if (!ack) return toolText('the handfree daemon is not reachable; the user did not get this')
    if (ack.error) return toolError(String(ack.error))
    return outcome(!!ack.delivered, 'shown')
  }
  return toolError(`unknown tool: ${name}`)
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // daemon down: the terminal dialog still works
  link?.send({ t: 'perm_request', ...params })
})

await mcp.connect(new StdioServerTransport())
connect()

// Claude can quit without stopping us (Esc on the resume picker), and the daemon
// socket alone keeps this process alive, still listed as a session. Go with it.
const claudePid = process.ppid
process.stdin.on('end', () => process.exit(0))
setInterval(() => { if (!pidAlive(claudePid)) process.exit(0) }, 2000).unref()
