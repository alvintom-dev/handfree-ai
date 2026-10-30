// Passphrase matching by sound, so speech-to-text spelling slips still pass
// ("pine apple", "Pineapple.", "pineaple" all match "pineapple").
// Only a salted hash of the sound key is stored, never the word itself.

import { createHash } from 'node:crypto'

/** A rough English sound key: same-sounding spellings collapse to the same key. */
export function soundKey(text: string): string {
  let s = text.toLowerCase().replace(/[^a-z]/g, '')
  if (!s) return ''
  s = s
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/wh/g, 'w')
    .replace(/gh/g, 'g')
    .replace(/kn/g, 'n')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
  // vowels carry little in a misspelling; keep only the first letter's
  return s[0] + s.slice(1).replace(/[aeiou]/g, '')
}

export function hashKey(key: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${key}`).digest('hex')
}

export function makePassphrase(word: string): { salt: string; hash: string } {
  const key = soundKey(word)
  if (key.length < 3) throw new Error('pick a longer passphrase (2-3 syllables works best)')
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')
  return { salt, hash: hashKey(key, salt) }
}

/**
 * True if any run of 1-3 consecutive spoken words sounds like the passphrase,
 * so "the passphrase is pineapple" or "pine apple" both pass.
 */
export function matchesPassphrase(spoken: string, stored: { salt: string; hash: string }): boolean {
  const words = spoken.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      if (hashKey(soundKey(words.slice(i, i + n).join('')), stored.salt) === stored.hash) return true
    }
  }
  return false
}
