// Words Whisper should expect in a project: the unusual names you'll say out loud
// (project, packages, folders, files) that a general speech model would misspell.
// Scanned once when a session connects; only names, never file contents.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const MAX_WORDS = 25
const MAX_FILES = 3000
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'vendor', '.venv', 'venv', '__pycache__', '.dart_tool', 'Pods', '.idea', '.vscode', 'target', 'coverage', '.next'])
const NOISE = new Set(['src', 'lib', 'test', 'tests', 'spec', 'docs', 'assets', 'public', 'config', 'index', 'main', 'readme', 'license', 'package', 'lock', 'json', 'yaml', 'yml', 'toml', 'md', 'txt', 'js', 'ts', 'tsx', 'jsx', 'py', 'dart', 'php', 'kt', 'xml', 'html', 'css', 'png', 'svg', 'ios', 'android', 'macos', 'linux', 'windows', 'web', 'gradle', 'gitignore',
  'mipmap', 'hdpi', 'mdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi', 'drawable', 'res', 'debug', 'tsconfig', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'favicon', 'stat', 'utils', 'util', 'impl', 'env'])

let dictionary: Set<string> | null = null
function common(word: string): boolean {
  if (!dictionary) {
    try {
      dictionary = new Set(readFileSync('/usr/share/dict/words', 'utf8').toLowerCase().split('\n'))
    } catch {
      dictionary = new Set() // no word list (Windows): keep everything that isn't noise
    }
  }
  const w = word.toLowerCase()
  // the word list has no plurals: "scripts", "approvals", "classes"
  return dictionary.has(w) || (w.endsWith('s') && dictionary.has(w.slice(0, -1))) || (w.endsWith('es') && dictionary.has(w.slice(0, -2)))
}

/** "handfree-channel.ts" -> ["handfree", "channel"]; "HomeScreen" -> ["Home", "Screen"] */
export function splitName(name: string): string[] {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(w => w.length >= 3 && /^[A-Za-z]/.test(w) && !/\d{2,}/.test(w)) // no "47s", "1080x1920"
}

function projectFiles(cwd: string): string[] {
  if (existsSync(join(cwd, '.git'))) {
    const r = Bun.spawnSync(['git', '-C', cwd, 'ls-files'], { stderr: 'ignore' })
    if (r.exitCode === 0) return r.stdout.toString().split('\n').filter(Boolean).slice(0, MAX_FILES)
  }
  const out: string[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 3 || out.length >= MAX_FILES) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), path, depth + 1)
      else out.push(path)
    }
  }
  walk(cwd, '', 0)
  return out
}

/** Package names and their dependencies, from the manifests a project usually has. */
function packageNames(cwd: string): string[] {
  const names: string[] = []
  const read = (f: string) => { try { return readFileSync(join(cwd, f), 'utf8') } catch { return '' } }
  for (const f of ['package.json', 'composer.json']) {
    try {
      const j = JSON.parse(read(f) || '{}')
      if (j.name) names.push(String(j.name).split('/').pop()!)
      for (const k of ['dependencies', 'devDependencies', 'require']) names.push(...Object.keys(j[k] ?? {}).map(n => n.split('/').pop()!))
    } catch {}
  }
  const pubspec = read('pubspec.yaml')
  if (pubspec) {
    names.push(...[...pubspec.matchAll(/^name:\s*(\S+)/gm)].map(m => m[1]!))
    names.push(...[...pubspec.matchAll(/^ {2}([a-z_][a-z0-9_]*):/gm)].map(m => m[1]!))
  }
  const pyproject = read('pyproject.toml')
  if (pyproject) names.push(...[...pyproject.matchAll(/^\s*"([A-Za-z0-9_.-]+)/gm)].map(m => m[1]!))
  return names
}

/** The most useful unusual words to give Whisper for this project. */
export function projectWords(cwd: string): string[] {
  if (!cwd || !existsSync(cwd)) return []
  const score = new Map<string, number>()
  const original = new Map<string, string>() // keep the usual spelling, e.g. "Qwen"
  const add = (word: string, weight: number) => {
    const key = word.toLowerCase()
    if (NOISE.has(key) || common(key) || /^[a-z]{1,3}\d*$/i.test(word)) return
    score.set(key, (score.get(key) ?? 0) + weight)
    if (!original.has(key) || /[A-Z]/.test(word)) original.set(key, word)
  }
  for (const w of splitName(basename(cwd))) add(w, 100) // the project itself
  for (const n of packageNames(cwd)) for (const w of splitName(n)) add(w, 5)
  for (const path of projectFiles(cwd)) {
    const parts = path.split('/')
    parts.forEach((part, i) => { for (const w of splitName(part)) add(w, i < parts.length - 1 ? 2 : 1) })
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WORDS)
    .map(([key]) => original.get(key)!)
}
