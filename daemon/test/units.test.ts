import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Activity, describeTool } from '../src/activity'
import { plist } from '../src/autostart'
import { Projects, cleanTitle, pastChats, pinnedFolders, pinnedFor, profileArgs, profileChoices, profileDir, profileName, workspaceFolders, workspaceFor } from '../src/launcher'
import { projectWords, splitName } from '../src/vocab'
import { describe as describeReq } from '../src/approvals'
import { Pictures, pictureType } from '../src/pictures'
import { VOICE, Voiceprint, drops } from '../src/voiceprint'
import { CHAT_KEEP, keepable, lastId, loadChat, saveChat } from '../src/chatlog'
import { cleanTranscript, heardTwice, isFiller, isNo, isYes, parseCommand, guessSession, parseSessionSwitch, sessionSwitchTargets, soundsUnfinished, splitSwitch, stripWake } from '../src/commands'
import { makePassphrase, matchesPassphrase, soundKey } from '../src/phonetic'

test('sound keys collapse spelling slips', () => {
  for (const v of ['Pineapple.', 'pine apple', 'pineaple', 'PINEAPPLE']) expect(soundKey(v.replace(/\s/g, ''))).toBe(soundKey('pineapple'))
  expect(soundKey('phoenix')).toBe(soundKey('feenix'))
  expect(soundKey('pineapple')).not.toBe(soundKey('banana'))
})

test('passphrase matches inside a sentence and across a split word', () => {
  const p = makePassphrase('pineapple')
  expect(matchesPassphrase('Pineapple.', p)).toBe(true)
  expect(matchesPassphrase('the passphrase is pine apple', p)).toBe(true)
  expect(matchesPassphrase('banana', p)).toBe(false)
  expect(matchesPassphrase('', p)).toBe(false)
  expect(JSON.stringify(p)).not.toContain('pine') // only a salted hash is stored
})

test('too-short passphrases are refused', () => {
  expect(() => makePassphrase('ok')).toThrow()
})

test('a command then "switch to" splits: the words stay here, then the switch', () => {
  const sessions = [{ label: 'web-app' }, { label: 'handfree-ai' }, { label: 'docs-site' }]
  const r = splitSwitch('Please add the ticket estimate. Then switch to docs site.', sessions)
  expect(r?.before).toBe('Please add the ticket estimate')
  expect(r?.target.label).toBe('docs-site')
  expect(splitSwitch('Fix the login bug, and then switch to web app', sessions)?.before).toBe('Fix the login bug')
  expect(splitSwitch('Check it and switch to the main branch', sessions)).toBeNull() // not a session
  expect(splitSwitch('Switch to web app.', sessions)).toBeNull() // a plain switch, handled before
  expect(splitSwitch('Open the page and go to web app', sessions)).toBeNull() // only "switch to"
})

test('switching sessions by voice needs a name that matches a connected session', () => {
  const sessions = [{ label: 'web-app' }, { label: 'handfree-ai' }, { label: 'api-server' }]
  expect(parseSessionSwitch('Switch to web app.', sessions)?.label).toBe('web-app')
  expect(parseSessionSwitch('go to the handfree AI session', sessions)?.label).toBe('handfree-ai')
  expect(parseSessionSwitch('switch to server please', sessions)?.label).toBe('api-server')
  expect(parseSessionSwitch('Switch to hand free AI.', sessions)?.label).toBe('handfree-ai')
  expect(parseSessionSwitch('switch to the main branch', sessions)).toBeNull()
  expect(parseSessionSwitch('switch to a', [{ label: 'alpha' }, { label: 'gamma' }])).toBeNull() // ambiguous
  expect(parseSessionSwitch('can you switch to web app and fix the login bug', sessions)).toBeNull()
  // named sessions answer to their name or, when it's the only one, their project
  const named = [{ label: 'login-fix', project: 'handfree-ai' }, { label: 'checkout-bug', project: 'handfree-ai' }, { label: 'web-app', project: 'web-app' }]
  expect(parseSessionSwitch('switch to login fix', named)?.label).toBe('login-fix')
  expect(parseSessionSwitch('switch to handfree AI', named)).toBeNull() // two sessions in that project
  expect(parseSessionSwitch('switch to web app', [named[0]!, named[2]!])?.label).toBe('web-app')
  expect(parseSessionSwitch('switch to handfree AI', [named[0]!, named[2]!])?.label).toBe('login-fix')
  expect(sessionSwitchTargets('switch to handfree AI', named).map(s => s.label)).toEqual(['login-fix', 'checkout-bug']) // answered, not passed to Claude
  expect(sessionSwitchTargets('switch to a', [{ label: 'alpha' }, { label: 'gamma' }])).toEqual([]) // too short to be sure it's a session
  // how speech actually phrases it
  const live = [{ label: 'handfree-ai-fc', project: 'handfree-ai' }, { label: 'headless-setup', project: 'handfree-ai' }]
  expect(parseSessionSwitch('Switch to hands-free AI FC.', live)?.label).toBe('handfree-ai-fc')
  expect(parseSessionSwitch('Can you switch to handsfree AI FC?', live)?.label).toBe('handfree-ai-fc')
  expect(parseSessionSwitch('Switch to our session, handfree AI FC.', live)?.label).toBe('handfree-ai-fc')
  expect(parseSessionSwitch('please switch to headless setup', live)?.label).toBe('headless-setup')
  // no match: guess the closest, switching outright only when it's very close
  const sessions3 = [...live, { label: 'web-app-2', project: 'web-app' }]
  expect(guessSession('switch to hand free AI FC 2', sessions3)).toMatchObject({ session: { label: 'handfree-ai-fc' }, sure: true })
  expect(guessSession('switch to handsome AI FC', sessions3)).toMatchObject({ session: { label: 'handfree-ai-fc' }, sure: false })
  expect(guessSession('switch to headless set up please', sessions3)?.session.label).toBe('headless-setup')
  expect(guessSession('switch to the main branch', sessions3)).toBeNull()
  expect(guessSession('switch to dark mode', sessions3)).toBeNull()
  expect(guessSession('fix the login bug', sessions3)).toBeNull()
  expect(parseCommand('Which sessions are open?')).toBe('sessions')
})

test('the wake phrase is found by sound at the start, and stripped', () => {
  expect(stripWake('Hey Claude, check the logs.', 'Hey Claude')).toBe('check the logs.')
  expect(stripWake('Hey cloud. What time is it?', 'Hey Claude')).toBe('What time is it?')
  expect(stripWake('Hi Claude, run it', 'Hey Claude')).toBe('run it')
  expect(stripWake('Um, hey Claude, fix it', 'Hey Claude')).toBe('fix it')
  expect(stripWake('Claude, run it', 'Hey Claude')).toBe('run it')
  expect(stripWake('Hey Claude.', 'Hey Claude')).toBe('')
  expect(stripWake('So I told him hey Claude is cool', 'Hey Claude')).toBeNull()
  expect(stripWake('Cloud computing is great', 'Hey Claude')).toBeNull()
  expect(stripWake('Hey, how are you?', 'Hey Claude')).toBeNull()
  expect(stripWake('Okay Jarvis, deploy', 'Okay Jarvis')).toBe('deploy')
  expect(parseCommand("That's all for now.")).toBe('sleep')
  expect(parseCommand('Thanks Claude.')).toBe('sleep')
  expect(parseCommand('Thank you.')).toBeNull() // still a message to Claude
})

test('commands match whole short utterances only', () => {
  expect(parseCommand('Stop.')).toBe('stop')
  expect(parseCommand('okay stop talking')).toBe('stop')
  expect(parseCommand('Can you repeat that?')).toBe('repeat')
  expect(parseCommand("What's the status?")).toBe('status')
  expect(parseCommand('slow down please')).toBe('slower')
  expect(parseCommand('switch to tap mode')).toBe('tap_mode')
  expect(parseCommand('stop the dev server and restart it')).toBeNull()
  expect(parseCommand('what is the status of ticket 482 in clickup right now')).toBeNull()
})

test('fillers, yes and no', () => {
  for (const f of ['Mm-hmm.', 'MMM.', 'uh huh', 'Yeah.', 'okay']) expect(isFiller(f)).toBe(true)
  expect(isFiller('wait why')).toBe(false)
  expect(isYes('Yes, go ahead.')).toBe(true)
  expect(isNo("No, don't.")).toBe(true)
  expect(isYes('No.')).toBe(false)
})

test('approval descriptions read naturally', () => {
  expect(describeReq({ tool_name: 'Write', description: 'Write a file to the local filesystem.' })).toBe('write a file to the local filesystem')
  expect(describeReq({ tool_name: 'Bash', description: 'Run shell command' })).toBe('run a shell command')
})

test('a turn without an ending sounds unfinished', () => {
  for (const t of ['I actually have some feedback for', 'on how you', 'and then...', 'so the thing is…']) expect(soundsUnfinished(t)).toBe(true)
  for (const t of ['Yes.', 'Is it possible?', 'Stop!', 'He said "go."']) expect(soundsUnfinished(t)).toBe(false)
})

test('activity: steps upsert by tool id, in any order, and stop closes the turn', () => {
  const a = new Activity()
  a.apply({ event: 'prompt' }, 1000)
  expect(a.busy).toBe(true)
  // async hooks: "done" can beat "started"
  a.apply({ event: 'post', tool_name: 'Read', tool_use_id: 'r', tool_input: { file_path: '/x/conductor.ts' } }, 1200)
  a.apply({ event: 'pre', tool_name: 'Read', tool_use_id: 'r', tool_input: { file_path: '/x/conductor.ts' } }, 1100)
  a.apply({ event: 'pre', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'bun test' } }, 1300)
  expect(a.steps.map(s => [s.label, s.ok])).toEqual([['Reading conductor.ts', true], ['Running bun test', undefined]])
  expect(a.current()?.label).toBe('Running bun test')
  expect(a.apply({ event: 'pre', tool_name: 'mcp__handfree__reply' })).toBe(false)
  a.apply({ event: 'stop' }, 2000)
  expect(a.busy).toBe(false)
  expect(a.current()).toBeUndefined()
  expect(a.steps.every(s => s.endedAt)).toBe(true)
})

test('tool descriptions read like the terminal', () => {
  expect(describeTool('Bash', { command: 'bun test', description: 'Run daemon tests' })).toBe('Run daemon tests')
  expect(describeTool('Edit', { file_path: '/a/b/app.js' })).toBe('Editing app.js')
  expect(describeTool('Grep', { pattern: 'onHookStop' })).toBe('Searching for “onHookStop”')
  expect(describeTool('WebFetch', { url: 'https://code.claude.com/docs/en/hooks' })).toBe('Reading code.claude.com')
  expect(describeTool('mcp__claude_ai_Gmail__search_threads', {})).toBe('Gmail: search threads')
})

test('project words: unusual names from folders, files and packages, not plain English', () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  const dir = join(mkdtempSync(join(require('node:os').tmpdir(), 'hf-')), 'baratech')
  mkdirSync(join(dir, 'pages', 'warisan'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'leftpadx'), { recursive: true })
  writeFileSync(join(dir, 'pages', 'warisan', 'AnyamGallery.tsx'), '')
  writeFileSync(join(dir, 'pages', 'scripts.ts'), '')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'baratech-site', dependencies: { zustand: '1' } }))
  writeFileSync(join(dir, 'node_modules', 'leftpadx', 'index.js'), '')
  const words = projectWords(dir).map(w => w.toLowerCase())
  expect(words[0]).toBe('baratech') // the project itself comes first
  for (const w of ['warisan', 'anyam', 'zustand']) expect(words).toContain(w)
  for (const w of ['pages', 'scripts', 'gallery', 'leftpadx']) expect(words).not.toContain(w) // plain English, or skipped folders
  expect(splitName('handfree-channel.ts')).toEqual(['handfree', 'channel'])
  expect(splitName('HomeScreen.dart')).toEqual(['Home', 'Screen'])
  expect(splitName('1080x1920.png')).toEqual([])
})

test('transcript cleaning drops made-up repeats and echoes of Claude, keeps your short answers', () => {
  const spoken = "Okay. I'll carry on."
  expect(cleanTranscript("I'll carry on. Thank you. I'll carry on. I'll carry on, but I'll carry on. What's that?", spoken)).toBe("Thank you. What's that?")
  expect(cleanTranscript('Commit it.', 'Shall I commit it?')).toBe('Commit it.')
  expect(cleanTranscript('The release is planned for Friday morning.', 'The release is planned for Friday morning. All green.')).toBe('')
  expect(cleanTranscript('Please carry on with the tests.', spoken)).toBe('Please carry on with the tests.')
  expect(cleanTranscript('Run the tests.', '')).toBe('Run the tests.')
})

test('detail blocks draw stats, options, steps, diagrams and callouts', async () => {
  await import('../public/blocks.js')
  const { code, blockquote } = (globalThis as any).handfreeBlocks

  const stats = code('Effort | ~1 day | web first | bar:60\nFiles | 4', 'stats')
  expect(stats).toContain('<div class="v">~1 day</div>')
  expect(stats).toContain('width:60%')
  expect(stats.match(/class="stat"/g)).toHaveLength(2)

  const opts = code('A* Diagram blocks | effort 1\n+ builds on markdown\n- adds a library\nB Custom JSON | effort 3\n- new format', 'options')
  expect(opts.match(/class="opt[ "]/g)).toHaveLength(2)
  expect(opts).toContain('opt best')
  expect(opts).toContain('RECOMMENDED')
  expect(opts.match(/class="pro"/g)).toHaveLength(1)
  expect(opts.match(/class="con"/g)).toHaveLength(2)
  expect(opts.match(/<i class="on">/g)).toHaveLength(4)

  const steps = code('done | Agree on the look\nnext | Build it | web first\nShip it', 'steps')
  expect(steps).toContain('<li class="done"><span class="dot">✓')
  expect(steps).toContain('<li class="now"><span class="dot">2')
  expect(steps).toContain('<b>Ship it</b>') // no status: a to-do step
  expect(steps).toContain('To do')

  const flow = code('flowchart LR\n  A[<b>x</b>] --> B', 'mermaid')
  expect(flow).toContain('<pre class="mermaid">flowchart LR')
  expect(flow).toContain('&lt;b&gt;x&lt;/b&gt;') // escaped; mermaid reads it back as text
  expect(flow).toContain('classDef ok')
  expect(code('sequenceDiagram\n  A->>B: hi', 'mermaid')).not.toContain('classDef')

  expect(code('const x = 1', 'ts')).toBeNull()
  expect(code('x', undefined)).toBeNull()

  const tip = blockquote('<p>[!WARNING]\nBig diagrams get cramped.</p>\n')
  expect(tip).toContain('callout c-warn')
  expect(tip).toContain('Watch out')
  expect(tip).not.toContain('[!WARNING]')
  const decide = blockquote('<p>[!DECIDE]\nGo with A?</p>\n<ul>\n<li>Yes, go</li>\n<li>Try B</li>\n</ul>\n')
  expect(decide).toContain('<span class="chip">Yes, go</span>')
  expect(blockquote('<p>Just a quote</p>')).toBeNull()
  expect(blockquote('<p>[!UNKNOWN] hi</p>')).toBeNull()
})

test('script blocks in options and stats are escaped', async () => {
  await import('../public/blocks.js')
  const { code } = (globalThis as any).handfreeBlocks
  const html = code('A <script>x</script> | effort 1\n+ <img src=x onerror=y>', 'options') + code('<b>k</b> | v', 'stats')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<b>k')
})

test('tiles draw a grid, and each tile takes its own section out of the answer', async () => {
  await import('../public/blocks.js')
  const { code, tileDetails } = (globalThis as any).handfreeBlocks

  const grid = code('🏛️ **AI Governance Bill** | 9 articles | https://e.com/a.jpg | in Parliament\nPRN Melaka | <img src=x onerror=y>', 'tiles')
  expect(grid).toContain('<button class="tile" type="button" data-tile="ai governance bill"><img src="https://e.com/a.jpg" alt="" loading="lazy">')
  expect(grid).toContain('<span>9 articles · in Parliament</span>')
  expect(grid).not.toContain('<img src=x')

  const md = '## Overview\n```tiles\nAI Governance Bill | 9\nPRN Melaka | 6\nSpain crash | 7\n```\n### AI governance bill\nDelayed.\n```mermaid\npie\n### inside a fence\n```\n### PRN Melaka\nPolling 14 Nov\n---\n## After\n### Other\nkept'
  const { main, details } = tileDetails(md)
  expect(details['ai governance bill']).toBe('Delayed.\n```mermaid\npie\n### inside a fence\n```')
  expect(details['prn melaka']).toBe('Polling 14 Nov')
  expect(details['spain crash']).toBeUndefined() // no section: the tile asks the session
  expect(main).toContain('```tiles')
  expect(main).toContain('---\n## After\n### Other\nkept')
  expect(main).not.toContain('Delayed')
})

test('wireframes draw framed screens with elements, flows and notes', async () => {
  await import('../public/blocks.js')
  const { code } = (globalThis as any).handfreeBlocks

  const login = code('phone | Login\nheader | Welcome back\ninput | Email | note: shows an error under the field\nbutton* | Sign in\nbutton Create account\nrow | button Google | button Apple\nnav | Home* | Profile', 'wireframe')
  expect(login).toContain('<figure class="wf-screen phone"><div class="wf phone">')
  expect(login).toContain('<figcaption>Login</figcaption>')
  expect(login).toContain('<div class="w-btn main">Sign in</div>')
  expect(login).toContain('<div class="w-btn">Create account</div>') // "kind label" without a pipe
  expect(login).toContain('<div class="w-row"><div class="w-btn">Google</div><div class="w-btn">Apple</div></div>')
  expect(login).toContain('<span class="on"><i></i>Home</span>')
  expect(login).toContain('<span class="w-pin">1</span>')
  expect(login).toContain('<li><span class="w-pin">1</span>shows an error under the field</li>')
  expect(login.indexOf('w-nav')).toBeGreaterThan(login.indexOf('Sign in')) // nav sits at the bottom

  const flow = code('phone | Cart\nlist | Shoes | Hat\nphone | Pay\nbutton* | Pay now', 'wireframe')
  expect(flow.match(/class="wf-screen /g)).toHaveLength(2)
  expect(flow).toContain('<div class="w-arrow">→</div>')

  const web = code('browser | shop.test/admin\nsidebar | Orders* | Settings\ntable | Order | Total\nwhatever this is', 'wireframe')
  expect(web).toContain('<span class="wf-url">shop.test/admin</span>')
  expect(web).toContain('<div class="wf-page"><div class="w-side">')
  expect(web).toContain('--cols:2')
  expect(web).toContain('<div class="w-box">whatever this is</div>') // unknown lines still show

  expect(code('button Go', 'wireframe')).toContain('wf phone') // no frame line: a phone
})

test('design cards link only to https pages, and wireframe text is escaped', async () => {
  await import('../public/blocks.js')
  const { code } = (globalThis as any).handfreeBlocks

  const card = code('Checkout | https://claude.ai/artifact/abc | 3 screens', 'design')
  expect(card).toContain('<a class="design-card" href="https://claude.ai/artifact/abc">')
  expect(card).toContain('Open design')
  const bad = code('Evil | javascript:alert(1)\nQuote | https://x.test/"onmouseover="y', 'design')
  expect(bad).not.toContain('<a ')
  expect(bad).not.toContain('href')

  const html = code('phone | <script>x</script>\nbutton | <img src=x onerror=y>\nimage | pic | 9999', 'wireframe')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).toContain('height:400px')
})

test.if(process.platform === 'darwin')('the login item is a valid plist that runs the daemon with this PATH', () => {
  const out = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', '-'], { stdin: Buffer.from(plist()) })
  expect(out.exitCode).toBe(0)
  const p = JSON.parse(out.stdout.toString())
  expect(p.ProgramArguments[1]).toEndWith('daemon/src/main.ts')
  expect(p.EnvironmentVariables.PATH).toBe(process.env.PATH)
  expect(p.KeepAlive.SuccessfulExit).toBe(false)
})

test('projects: the most recent folder first, one entry per folder, forget removes it', () => {
  const file = join(tmpdir(), `hf-projects-${Date.now()}.json`)
  const p = new Projects(file)
  p.remember('/work/shop', undefined, [])
  p.remember('/work/blog', '/Users/x/.claude-personal', ['--permission-mode', 'auto'])
  p.remember('/work/shop', undefined, ['--model', 'opus'])
  expect(p.list.map(x => x.name)).toEqual(['shop', 'blog'])
  expect(p.get('/work/shop')!.args).toEqual(['--model', 'opus'])
  p.remember('/', undefined, [])
  expect(p.list.length).toBe(2)
  expect(new Projects(file).list.length).toBe(2) // kept on disk
  expect(p.forget('/work/blog')).toBe(true)
  expect(p.forget('/nowhere')).toBe(false)
  expect(new Projects(file).list.map(x => x.cwd)).toEqual(['/work/shop'])
})

test('projects start with the profile they last used', () => {
  expect(profileArgs(undefined).flags).toEqual(['--which-claude=default'])
  expect(profileArgs(join(homedir(), '.claude')).flags).toEqual(['--which-claude=default'])
  expect(profileArgs(join(homedir(), '.claude-personal')).flags).toEqual(['--which-claude=personal'])
  expect(profileArgs('/opt/claude-x')).toEqual({ flags: [], env: ['CLAUDE_CONFIG_DIR=/opt/claude-x'] })
})

test('workspaces: projects one level in, the most specific workspace wins, nothing else passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'hf-ws-'))
  for (const d of ['work/shop', 'work/.hidden', 'work/mine/blog']) mkdirSync(join(root, d), { recursive: true })
  const ws = [{ path: join(root, 'work/mine'), profile: 'personal' }, { path: join(root, 'work'), profile: 'work' }]
  expect(workspaceFolders(ws).map(w => w.folders.map(f => f.name))).toEqual([['blog'], ['shop']]) // "mine" is a workspace, not a project
  expect(workspaceFor(join(root, 'work/shop'), ws)?.profile).toBe('work')
  expect(workspaceFor(join(root, 'work/mine/blog'), ws)?.profile).toBe('personal')
  expect(workspaceFor(join(root, 'work/mine'), ws)).toBeUndefined()
  expect(workspaceFor(join(root, 'work/.hidden'), ws)).toBeUndefined()
  expect(workspaceFor(join(root, 'work/mine/../shop/x'), ws)).toBeUndefined()
  expect(workspaceFor('/etc', ws)).toBeUndefined()
  expect(profileDir('default')).toBeUndefined()
  expect(profileDir('personal')).toBe(join(homedir(), '.claude-personal'))
})

test('pictures: real images only, for the session they were sent to, the last few for an hour', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
  expect(pictureType(png)).toBe('image/png')
  expect(pictureType(jpg)).toBe('image/jpeg')
  expect(pictureType(Buffer.from('%PDF-1.7 not a picture'))).toBeUndefined()
  let now = 0
  const store = new Pictures(2, 60_000, () => now)
  expect(store.add(Buffer.from('<svg/>'), 's1')).toHaveProperty('error')
  expect(store.add(Buffer.alloc(6 * 1024 * 1024, 0xff), 's1')).toHaveProperty('error') // over 5 MB
  const a = store.add(png, 's1') as { id: string }
  expect(store.get(a.id, 's1')?.mime).toBe('image/png')
  expect(store.get(a.id, 's2')).toBeUndefined() // another session can't read it
  const b = store.add(jpg, 's1') as { id: string }
  store.add(jpg, 's1')
  expect(store.get(a.id, 's1')).toBeUndefined() // only the last 2 kept
  expect(store.get(b.id, 's1')).toBeDefined()
  now = 61_000
  expect(store.get(b.id, 's1')).toBeUndefined() // and only for the ttl
  const sent = new Pictures(2, 60_000, () => now, 's')
  const c = sent.add(png, 's1') as { id: string }
  expect(c.id).toMatch(/^s\d+$/) // Claude's screenshots don't share ids with yours
  expect(sent.find(c.id)?.mime).toBe('image/png') // the screens load any session's
})

test('a session name from the phone is one plain line', () => {
  expect(cleanTitle('  login   fix ')).toBe('login fix')
  expect(cleanTitle('a\nb\x1b[2Jc')).toBe('a b [2Jc') // no Enter or escape keys reach the terminal
  expect(cleanTitle('x'.repeat(80))).toHaveLength(60)
  expect(cleanTitle(' \n ')).toBe('')
})

test('pinned folders: any folder you list, in your order; profiles to pick from', () => {
  const root = mkdtempSync(join(tmpdir(), 'hf-pin-'))
  for (const d of ['work/app', 'work/mine/blog']) mkdirSync(join(root, d), { recursive: true })
  const pinned = [{ path: join(root, 'work/mine/blog'), profile: 'personal' }, { path: join(root, 'work') }, { path: join(root, 'gone') }]
  expect(pinnedFolders(pinned).map(f => f.name)).toEqual(['blog', 'work']) // a workspace itself is fine here; a missing folder isn't
  expect(pinnedFor(join(root, 'work'), pinned)).toBeDefined()
  expect(pinnedFor(join(root, 'work/app'), pinned)).toBeUndefined() // only the folder itself, not what's inside
  expect(profileChoices({ profiles: [], workspaces: [{ path: '~/w', profile: 'work' }], pinned })).toEqual(['work', 'personal'])
  expect(profileChoices({ profiles: ['personal', 'work'], workspaces: [], pinned: [] })).toEqual(['personal', 'work'])
  expect(profileName(undefined, ['default', 'personal'])).toBe('default')
  expect(profileName(join(homedir(), '.claude'), ['default', 'personal'])).toBe('default')
  expect(profileName(join(homedir(), '.claude-personal'), ['default', 'personal'])).toBe('personal')
  expect(profileName(join(homedir(), '.claude-side'), ['default'])).toBe('side')
  expect(profileName(undefined, [])).toBe('default')
})

test('past chats: newest first, titled by /rename, then Claude, then your first words', () => {
  const config = mkdtempSync(join(tmpdir(), 'hf-cfg-'))
  const cwd = '/work/my_app'
  const dir = join(config, 'projects', '-work-my-app')
  mkdirSync(dir, { recursive: true })
  const line = (o: object) => JSON.stringify(o) + '\n'
  const user = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })
  const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444']
  writeFileSync(join(dir, `${ids[0]}.jsonl`), user('fix the login bug') + line({ type: 'ai-title', aiTitle: 'Login bug' }) + line({ type: 'custom-title', customTitle: 'login-fix' }))
  writeFileSync(join(dir, `${ids[1]}.jsonl`), user('<channel source="handfree" msg_id="v1">add a dark   mode</channel>'))
  writeFileSync(join(dir, `${ids[2]}.jsonl`), line({ type: 'summary' })) // opened and closed
  writeFileSync(join(dir, `${ids[3]}.jsonl`), user('x'.repeat(100)))
  const chats = pastChats(cwd, config)
  expect(chats.find(c => c.id === ids[0])!.title).toBe('login-fix')
  expect(chats.find(c => c.id === ids[1])!.title).toBe('add a dark mode')
  expect(chats.find(c => c.id === ids[2])).toBeUndefined()
  expect(chats.find(c => c.id === ids[3])!.title).toHaveLength(80)
  expect(pastChats('/nowhere', config)).toEqual([])
})

test('a big message over the local socket arrives whole, and the next one after it', async () => {
  const { Outbox } = await import('../src/sessions')
  const path = join(mkdtempSync(join(tmpdir(), 'hf-sock-')), 's.sock')
  const big = 'x'.repeat(3_000_000)
  let out: InstanceType<typeof Outbox> | undefined
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) { out = new Outbox(s); out.send({ t: 'picture', data: big }); out.send({ t: 'ack' }) },
      drain() { out?.drain() },
      data() {},
    },
  })
  let buf = ''
  const lines: any[] = []
  const done = new Promise<void>(resolve => {
    Bun.connect({ unix: path, socket: { data(_s, c) {
      buf += c.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
      if (lines.length === 2) resolve()
    } } })
  })
  await done
  server.stop(true)
  expect(lines[0].data.length).toBe(big.length)
  expect(lines[1].t).toBe('ack')
})

test('my voice only: learns you first, then tells you from others and from far voices', () => {
  const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n) }
  const me = (jitter = 0) => ({ emb: unit([1, 0.1 + jitter, 0, 0]), level_db: -20, snr_db: 25, secs: 2 })
  const vp = new Voiceprint()
  for (let i = 0; i < VOICE.learnFirst; i++) {
    const v = vp.judge(me(i * 0.01), 'phone')
    expect(v.kind).toBe('learning')
    vp.learn(me(i * 0.01), 'phone', v)
  }
  expect(vp.summary()).toMatchObject({ learned: VOICE.learnFirst, ready: true })
  expect(vp.judge(me(0.02), 'phone').kind).toBe('you')
  const someone = { emb: unit([0, 0, 1, 0.2]), level_db: -22, snr_db: 20, secs: 2 }
  const other = vp.judge(someone, 'phone')
  expect(other.kind).toBe('other')
  expect(drops(other)).toBe(true)
  vp.learn(someone, 'phone', other) // never learns a voice that isn't yours
  expect(vp.judge(someone, 'phone').kind).toBe('other')
  expect(vp.judge({ ...me(), level_db: -40 }, 'phone').kind).toBe('far') // you, but 20 dB quieter: across the room
  expect(vp.judge({ ...me(), level_db: -40 }, 'web').kind).toBe('you') // each device has its own levels
  expect(vp.judge({ ...someone, secs: 0.5 }, 'phone').kind).toBe('short') // "yes": too short to tell
  vp.reset()
  expect(vp.summary().learned).toBe(0)
})

test('heardTwice: the same speech from two mics, despite small transcript differences', () => {
  expect(heardTwice('Hey cloud, can you check the build?', 'Hey Claude, can you check the build?')).toBe(true)
  expect(heardTwice('check the build', 'Hey Claude, can you check the build? And the tests.')).toBe(true)
  expect(heardTwice('Yes.', 'yes')).toBe(true)
  expect(heardTwice('Now deploy it to staging please.', 'Can you check the build?')).toBe(false)
  expect(heardTwice('', 'anything')).toBe(false)
})

test('chat log: keeps the last chats of the recent sessions, and survives a restart', () => {
  const msg = (t: string, session_key: string, at: number, extra: object = {}) => ({ t, session_key, at, ...extra })
  const history: any[] = [
    { t: 'notice', text: 'Starting…', at: 1 }, // for the moment only
    msg('transcript', 'a', 2), // so are transcripts
    ...Array.from({ length: CHAT_KEEP.perSession + 5 }, (_, i) => msg('user', 'a', 10 + i, { msg_id: `v${i + 1}` })),
    msg('reply', 'a', 1000, { msg_id: `v${CHAT_KEEP.perSession + 5}`, say_id: 'say9' }), // 'a' is the session talked to last
  ]
  for (let i = 0; i < CHAT_KEEP.sessions + 2; i++) history.push(msg('show', `s${i}`, 300 + i))
  const kept = keepable(history)
  expect(kept.some(m => m.t === 'notice' || m.t === 'transcript')).toBe(false)
  expect(kept.filter(m => m.session_key === 'a').length).toBe(CHAT_KEEP.perSession)
  expect(kept.find(m => m.session_key === 'a')!.msg_id).toBe('v7') // the oldest ones went
  expect(new Set(kept.map(m => m.session_key)).size).toBe(CHAT_KEEP.sessions)
  expect(kept.some(m => m.session_key === 's0')).toBe(false) // the least recent sessions went
  expect(lastId(kept, 'msg_id', 'v')).toBe(CHAT_KEEP.perSession + 5)
  expect(lastId(kept, 'say_id', 'say')).toBe(9)

  const file = join(mkdtempSync(join(tmpdir(), 'hf-chat-')), 'chat.json')
  expect(loadChat(file)).toEqual([])
  saveChat(file, history)
  expect(loadChat(file)).toEqual(kept)
  writeFileSync(file, '{not json')
  expect(loadChat(file)).toEqual([])
})
