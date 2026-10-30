// macOS asks before an app reads Downloads, Documents, Desktop or other apps' data,
// and remembers the answer per app. For sessions the phone starts, that app is the
// daemon (bun): with nobody at the screen, the popup waits and the session stalls.
// Full Disk Access for bun, given once, covers all of those, and survives bun upgrades
// (it's signed). Automation, Contacts and Calendar still ask once each.

import { closeSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Whether this process has Full Disk Access: true, false, or null off macOS.
 *  Reads a file only Full Disk Access opens; that never shows a popup itself. */
export function fullDiskAccess(): boolean | null {
  if (process.platform !== 'darwin') return null
  try {
    closeSync(openSync(join(homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'), 'r'))
    return true
  } catch (err: any) {
    return err?.code === 'ENOENT' ? null : false
  }
}
