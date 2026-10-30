// Preloaded before every test file (bunfig.toml). Bun runs all test files in one
// process and paths.ts reads HANDFREE_HOME once, at first import: set it here, so
// no test can reach the real daemon's socket or files.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HANDFREE_HOME = mkdtempSync(join(tmpdir(), 'handfree-it-'))
