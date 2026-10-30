// Permission prompts relayed from Claude Code. The daemon, never Claude,
// decides: Tap mode needs a button press; Passphrase mode needs "yes" and the
// passphrase spoken. Voice can only make the guard stricter, never looser.

import { isNo, isYes } from './commands'
import { matchesPassphrase } from './phonetic'
import type { ApprovalMode } from './paths'

export type PermissionRequest = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
  sessionKey: string
  createdAt: number
}

type Dialog = { request_id: string; stage: 'confirm' | 'passphrase'; tries: number; reprompts: number; startedAt: number }

export type ApprovalDeps = {
  getMode: () => ApprovalMode
  setMode: (mode: ApprovalMode) => void
  getPassphrase: () => { salt: string; hash: string } | undefined
  speak: (text: string) => void
  broadcast: (msg: object) => void
  sendVerdict: (req: PermissionRequest, behavior: 'allow' | 'deny') => void
}

const DIALOG_TIMEOUT_MS = 120_000

export class Approvals {
  pending = new Map<string, PermissionRequest>()
  dialog: Dialog | null = null

  constructor(private deps: ApprovalDeps) {}

  get mode(): ApprovalMode {
    return this.deps.getMode()
  }

  request(req: PermissionRequest) {
    this.pending.set(req.request_id, req)
    this.deps.broadcast({ t: 'approval_request', ...req, mode: this.mode })
    if (this.mode === 'passphrase' && this.deps.getPassphrase() && !this.dialog) this.startDialog(req)
    else if (this.mode === 'tap') this.deps.speak(`Claude needs approval to ${describe(req)}. Tap approve or deny on your screen.`)
  }

  /** A button press in the app or on the web page. Works in both modes. */
  tap(request_id: string, behavior: 'allow' | 'deny') {
    const req = this.pending.get(request_id)
    if (!req) return false
    this.resolve(req, behavior, 'tap')
    return true
  }

  /** Returns true when the utterance belonged to an approval and must not reach Claude. */
  handleUtterance(text: string): boolean {
    this.expireDialog()
    const latest = [...this.pending.values()].at(-1)
    if (!latest) return false

    // "no" always works by voice, in both modes
    if (isNo(text)) {
      const target = this.dialog ? this.pending.get(this.dialog.request_id) ?? latest : latest
      this.resolve(target, 'deny', 'voice')
      this.deps.speak('Denied.')
      return true
    }

    if (!this.dialog) {
      if (this.mode === 'tap' && isYes(text)) {
        this.deps.speak('Tap mode is on, so please tap approve on your screen.')
        return true
      }
      return false
    }

    const req = this.pending.get(this.dialog.request_id)
    if (!req) { this.dialog = null; return false }

    if (this.dialog.stage === 'confirm') {
      if (isYes(text)) {
        this.dialog.stage = 'passphrase'
        this.deps.speak('Passphrase?')
      } else if (++this.dialog.reprompts >= 2) {
        this.dialog = null
        this.deps.speak('I left the approval on your screen. Tap it when ready.')
      } else {
        this.deps.speak('Claude is waiting on this approval. Say yes or no.')
      }
      return true
    }

    // stage: passphrase
    const stored = this.deps.getPassphrase()
    if (stored && matchesPassphrase(text, stored)) {
      this.resolve(req, 'allow', 'voice')
      this.deps.speak('Approved.')
    } else if (++this.dialog.tries >= 3) {
      this.resolve(req, 'deny', 'voice')
      this.setMode('tap', 'voice')
      this.deps.speak('Three wrong tries. I denied it and switched to tap mode.')
    } else {
      this.deps.speak("That didn't match. Try again.")
    }
    return true
  }

  /** Voice may switch to tap only; going back to passphrase needs a tap. */
  setMode(mode: ApprovalMode, via: 'voice' | 'tap'): { ok: boolean; reason?: string } {
    if (mode === 'passphrase' && via !== 'tap') return { ok: false, reason: 'Passphrase mode can only be turned on with a tap.' }
    if (mode === 'passphrase' && !this.deps.getPassphrase()) return { ok: false, reason: 'Set a passphrase first: handfree set-passphrase' }
    this.deps.setMode(mode)
    if (mode === 'tap') this.dialog = null
    this.deps.broadcast({ t: 'mode', mode })
    return { ok: true }
  }

  /** Claude moved on in that session, so its open prompts were answered in the terminal. */
  resolvedElsewhere(sessionKey: string) {
    for (const req of [...this.pending.values()]) {
      if (req.sessionKey !== sessionKey) continue
      this.pending.delete(req.request_id)
      if (this.dialog?.request_id === req.request_id) this.dialog = null
      this.deps.broadcast({ t: 'approval_resolved', request_id: req.request_id, behavior: 'unknown', via: 'terminal' })
    }
  }

  private startDialog(req: PermissionRequest) {
    this.dialog = { request_id: req.request_id, stage: 'confirm', tries: 0, reprompts: 0, startedAt: Date.now() }
    this.deps.speak(`Claude wants to ${describe(req)}. Say yes to approve, or no to deny.`)
  }

  private resolve(req: PermissionRequest, behavior: 'allow' | 'deny', via: 'tap' | 'voice') {
    this.pending.delete(req.request_id)
    if (this.dialog?.request_id === req.request_id) this.dialog = null
    this.deps.sendVerdict(req, behavior)
    this.deps.broadcast({ t: 'approval_resolved', request_id: req.request_id, behavior, via })
    // next queued prompt gets its own dialog
    const next = [...this.pending.values()][0]
    if (next && this.mode === 'passphrase' && this.deps.getPassphrase() && !this.dialog) this.startDialog(next)
  }

  private expireDialog() {
    if (this.dialog && Date.now() - this.dialog.startedAt > DIALOG_TIMEOUT_MS) this.dialog = null
  }
}

/** "run a shell command", "write a file to the local filesystem", ... for speech. */
export function describe(req: Pick<PermissionRequest, 'tool_name' | 'description'>): string {
  let d = req.description.trim().replace(/\.$/, '')
  if (!d || d === 'Run shell command') d = req.tool_name === 'Bash' ? 'run a shell command' : `use ${req.tool_name}`
  d = d.charAt(0).toLowerCase() + d.slice(1)
  return d.length > 140 ? d.slice(0, 137) + '...' : d
}
