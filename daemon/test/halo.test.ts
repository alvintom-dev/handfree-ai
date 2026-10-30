import { describe, expect, test } from 'bun:test'

const { createTracker, pinchRatio, isCallMe, isCurled, nearestTarget, pickHand } = require('../public/halo-core.js')

type P = { x: number; y: number; z: number }

/** A flat hand: wrist at (wx, wy), hand size 0.2, index tip at (tx, ty), thumb tip `gap` hand sizes away. */
function hand({ wx = 0.5, wy = 0.8, tx = 0.5, ty = 0.4, gap = 0.8 } = {}): P[] {
  const lm: P[] = Array.from({ length: 21 }, () => ({ x: wx, y: wy - 0.1, z: 0 }))
  lm[0] = { x: wx, y: wy, z: 0 }
  lm[9] = { x: wx, y: wy - 0.2, z: 0 }
  lm[8] = { x: tx, y: ty, z: 0 }
  lm[4] = { x: tx + gap * 0.2, y: ty, z: 0 }
  return lm
}

const types = (evs: any[]) => evs.map(e => e.type)

/** A hand with real joints: knuckles at y 0.7, middle joints at 0.6; `out` fingers reach up, the rest curl into the palm. */
function anat(out: { thumb?: boolean; index?: boolean; middle?: boolean; ring?: boolean; pinky?: boolean }): P[] {
  const p = (x: number, y: number) => ({ x, y, z: 0 })
  const lm: P[] = Array.from({ length: 21 }, () => p(0.5, 0.8))
  lm[0] = p(0.5, 0.9)
  const fingers: [number, number, keyof typeof out][] = [[5, 0.42, 'index'], [9, 0.48, 'middle'], [13, 0.54, 'ring'], [17, 0.6, 'pinky']]
  for (const [mcp, x, name] of fingers) {
    lm[mcp] = p(x, 0.7)
    lm[mcp + 1] = p(x, 0.6)
    lm[mcp + 2] = out[name] ? p(x, 0.52) : p(x, 0.66)
    lm[mcp + 3] = out[name] ? p(x, 0.45) : p(x, 0.72)
  }
  lm[1] = p(0.44, 0.86); lm[2] = p(0.39, 0.81)
  if (out.thumb) { lm[3] = p(0.32, 0.76); lm[4] = p(0.25, 0.71) } else { lm[3] = p(0.41, 0.76); lm[4] = p(0.44, 0.72) }
  return lm
}

/** Feed `ms` of frames every 33 ms; returns all events. */
function run(tr: any, from: number, ms: number, frame: (t: number) => any) {
  const out: any[] = []
  for (let t = from; t <= from + ms; t += 33) out.push(...tr.update(frame(t), t).map((e: any) => ({ ...e, t })))
  return out
}

describe('halo tracker', () => {
  test('pinch ratio measures thumb to index in hand sizes', () => {
    expect(pinchRatio(hand({ gap: 0.2 }))).toBeCloseTo(0.2, 5)
    expect(pinchRatio(hand({ gap: 1 }))).toBeCloseTo(1, 5)
  })

  test('a hand appears, the pointer follows the index tip, mirrored', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 400, () => ({ landmarks: hand({ tx: 0.3, ty: 0.3 }), gesture: 'Pointing_Up', score: 0.9 }))
    expect(evs[0].type).toBe('found')
    const last = evs.filter(e => e.type === 'move').at(-1)
    expect(last.x).toBeGreaterThan(0.5) // index on the left of the camera image = right of the screen
    expect(last.y).toBeLessThan(0.5)
  })

  test('pinch fires once on close and ends on open, without flapping in between', () => {
    const tr = createTracker()
    run(tr, 0, 200, () => ({ landmarks: hand({ gap: 0.8 }), gesture: 'None' }))
    const close = run(tr, 233, 200, () => ({ landmarks: hand({ gap: 0.2 }), gesture: 'None' }))
    expect(types(close).filter(t => t === 'pinch-start')).toHaveLength(1)
    const between = run(tr, 466, 200, () => ({ landmarks: hand({ gap: 0.4 }), gesture: 'None' }))
    expect(types(between)).not.toContain('pinch-end')
    const open = run(tr, 699, 100, () => ({ landmarks: hand({ gap: 0.8 }), gesture: 'None' }))
    expect(types(open)).toContain('pinch-end')
  })

  test('the pointer holds still while a pinch closes, and the click lands there', () => {
    const tr = createTracker()
    run(tr, 0, 300, () => ({ landmarks: hand({ tx: 0.5, gap: 0.8 }), gesture: 'None' }))
    const aimed = tr.pointer
    // fingers close while the hand drifts sideways: the pointer must not follow
    const closing = run(tr, 333, 300, t => {
      const k = (t - 333) / 300
      return { landmarks: hand({ tx: 0.5 + 0.08 * k, wx: 0.5 + 0.08 * k, gap: 0.55 - 0.35 * k }), gesture: 'None' }
    })
    const start = closing.find(e => e.type === 'pinch-start')
    expect(start).toBeTruthy()
    expect(Math.abs(start.x - aimed.x)).toBeLessThan(0.02)
    const prog = closing.filter(e => e.type === 'pinch-progress').map(e => e.p)
    expect(prog.length).toBeGreaterThan(2)
    expect(Math.max(...prog)).toBeGreaterThan(0.5)
    // open again: the pointer follows the finger again
    const open = run(tr, 666, 300, () => ({ landmarks: hand({ tx: 0.3, wx: 0.3, gap: 0.9 }), gesture: 'None' }))
    expect(types(open)).toContain('pinch-end')
    expect(tr.pointer.x).toBeGreaterThan(0.6)
  })

  test('the halo snaps to a nearby button and keeps it until clearly away', () => {
    const rects = [{ left: 100, top: 100, right: 140, bottom: 130 }, { left: 150, top: 100, right: 190, bottom: 130 }, { left: 0, top: 0, right: 400, bottom: 300 }]
    expect(nearestTarget(rects.slice(0, 2), 120, 115)).toBe(0) // on it
    expect(nearestTarget(rects.slice(0, 2), 120, 150)).toBe(0) // 20 px below: snaps
    expect(nearestTarget(rects.slice(0, 2), 120, 200)).toBe(-1) // too far
    expect(nearestTarget(rects, 120, 115)).toBe(0) // inside a big card too: the small button wins
    expect(nearestTarget(rects.slice(0, 2), 146, 115, { current: 0 })).toBe(0) // between the two: stays on the current one
    expect(nearestTarget(rects.slice(0, 2), 165, 115, { current: 0 })).toBe(1) // clearly on the next
  })

  test('with two hands in view, it stays with the first', () => {
    expect(pickHand([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }], null)).toBe(0)
    expect(pickHand([{ x: 0.2, y: 0.5 }, { x: 0.78, y: 0.52 }], { x: 0.8, y: 0.5 })).toBe(1)
    expect(pickHand([], { x: 0.8, y: 0.5 })).toBe(-1)
  })

  test('a thumbs up held still fires once', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 2000, () => ({ landmarks: hand(), gesture: 'Thumb_Up', score: 0.9 }))
    const holds = evs.filter(e => e.type === 'hold')
    expect(holds).toHaveLength(1)
    expect(holds[0].gesture).toBe('Thumb_Up')
    expect(holds[0].t).toBeGreaterThanOrEqual(750)
  })

  test('the call-me sign is read from the landmarks', () => {
    expect(isCallMe(anat({ thumb: true, pinky: true }))).toBe(true)
    expect(isCallMe(anat({ index: true }))).toBe(false) // pointing
    expect(isCallMe(anat({ thumb: true, index: true, middle: true, ring: true, pinky: true }))).toBe(false) // open palm
    expect(isCallMe(anat({ index: true, pinky: true }))).toBe(false) // rock sign
    expect(isCallMe(anat({ pinky: true }))).toBe(false) // thumb tucked in
  })

  test('a call-me sign held still fires once, whatever label the model gave it', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 1500, () => ({ landmarks: anat({ thumb: true, pinky: true }), gesture: 'None', score: 0.9 }))
    expect(evs.filter(e => e.type === 'hold').map(e => e.gesture)).toEqual(['Call_Me'])
    expect(tr.gesture).toBe('Call_Me')
  })

  test('a rock sign held still fires once', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 1500, () => ({ landmarks: hand(), gesture: 'ILoveYou', score: 0.9 }))
    expect(evs.filter(e => e.type === 'hold').map(e => e.gesture)).toEqual(['ILoveYou'])
  })

  test('a recognizer flicker does not fire the same command twice', () => {
    const tr = createTracker()
    const evs = [
      ...run(tr, 0, 900, () => ({ landmarks: hand(), gesture: 'Thumb_Up', score: 0.9 })),
      ...run(tr, 933, 100, () => ({ landmarks: hand(), gesture: 'None', score: 0.9 })),
      ...run(tr, 1066, 900, () => ({ landmarks: hand(), gesture: 'Thumb_Up', score: 0.9 })),
    ]
    expect(evs.filter(e => e.type === 'hold')).toHaveLength(1)
    // after the cooldown, the same gesture works again
    const later = run(tr, 2100, 1800, () => ({ landmarks: hand(), gesture: 'Thumb_Up', score: 0.9 }))
    expect(later.filter(e => e.type === 'hold')).toHaveLength(1)
  })

  test('a gesture while the hand moves is not a hold', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 1500, t => ({ landmarks: hand({ wx: 0.3 + (t % 600) / 2000, tx: 0.3 + (t % 600) / 2000 }), gesture: 'Open_Palm', score: 0.9 }))
    expect(types(evs)).not.toContain('hold')
  })

  test('a low-confidence gesture is ignored', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 1500, () => ({ landmarks: hand(), gesture: 'Thumb_Down', score: 0.3 }))
    expect(types(evs)).not.toContain('hold')
  })

  test('a closed fist talks, opening the hand stops', () => {
    const tr = createTracker()
    const closed = run(tr, 0, 400, () => ({ landmarks: hand({ gap: 0.8 }), gesture: 'Closed_Fist', score: 0.9 }))
    const start = closed.find(e => e.type === 'fist-start')
    expect(start.t).toBeGreaterThanOrEqual(250)
    expect(tr.fist).toBe(true)
    const open = run(tr, 433, 500, () => ({ landmarks: hand({ gap: 0.8 }), gesture: 'Open_Palm', score: 0.9 }))
    const end = open.find(e => e.type === 'fist-end')
    expect(end.t - 433).toBeGreaterThanOrEqual(330)
    expect(tr.fist).toBe(false)
  })

  test('a quick sweep to the right is a swipe, and not a palm hold', () => {
    const tr = createTracker()
    run(tr, 0, 200, () => ({ landmarks: hand({ wx: 0.7, tx: 0.7 }), gesture: 'Open_Palm', score: 0.9 }))
    // camera x falls 0.7 -> 0.35 in 300 ms: on the mirrored screen the hand moves right
    const evs = run(tr, 233, 300, t => {
      const x = 0.7 - ((t - 233) / 300) * 0.35
      return { landmarks: hand({ wx: x, tx: x }), gesture: 'Open_Palm', score: 0.9 }
    })
    const swipes = evs.filter(e => e.type === 'swipe')
    expect(swipes).toHaveLength(1)
    expect(swipes[0].dir).toBe('right')
    expect(types(evs)).not.toContain('hold')
  })

  test('losing the hand ends a fist and reports lost', () => {
    const tr = createTracker()
    run(tr, 0, 400, () => ({ landmarks: hand(), gesture: 'Closed_Fist', score: 0.9 }))
    const gone = run(tr, 433, 600, () => ({ landmarks: null }))
    expect(types(gone).filter(t => t !== 'hold-progress')).toEqual(['fist-end', 'lost']) // a fist is a hold too (home): its progress resets
  })

  test('one jittery frame of a far hand does not freeze the pointer', () => {
    const tr = createTracker()
    // fingers apart (0.8), one noisy frame reads 0.55, then apart again
    const gaps = [0.8, 0.8, 0.8, 0.8, 0.55, 0.8, 0.8]
    let i = 0
    const evs = run(tr, 0, 33 * (gaps.length - 1), t => ({ landmarks: hand({ gap: gaps[i++], tx: 0.3 + t / 3000 }), gesture: 'None' }))
    expect(evs.filter(e => e.type === 'pinch-progress' && e.p > 0)).toEqual([])
    expect(evs.filter(e => e.type === 'pinch-start')).toEqual([])
  })

  test('the open palm (wake / sleep) needs a longer hold: 1.5 s', () => {
    const tr = createTracker()
    const early = run(tr, 0, 1000, () => ({ landmarks: hand(), gesture: 'Open_Palm', score: 0.9 }))
    expect(early.some(e => e.type === 'hold')).toBe(false)
    const later = run(tr, 1033, 700, () => ({ landmarks: hand(), gesture: 'Open_Palm', score: 0.9 }))
    expect(later.filter(e => e.type === 'hold')).toHaveLength(1)
  })

  test('two fingers up and a hand moving up scrolls; the pointer holds still', () => {
    const tr = createTracker()
    run(tr, 0, 200, () => ({ landmarks: hand(), gesture: 'Pointing_Up', score: 0.9 }))
    const evs = run(tr, 233, 600, t => ({ landmarks: hand({ wy: 0.8 - (t - 233) / 3000, ty: 0.4 - (t - 233) / 3000 }), gesture: 'Victory', score: 0.9 }))
    expect(evs.filter(e => e.type === 'scroll-start')).toHaveLength(1)
    const scrolls = evs.filter(e => e.type === 'scroll')
    expect(scrolls.length).toBeGreaterThan(5)
    expect(scrolls.every(e => e.dy < 0)).toBe(true)
    const moves = evs.filter(e => e.type === 'move')
    expect(moves.at(-1).y).toBeCloseTo(moves[0].y, 5)
    // a frame without the label doesn't end it; a pointing hand does, after a moment
    expect(types(run(tr, 866, 0, () => ({ landmarks: hand({ wy: 0.6 }), gesture: 'None', score: 0.9 })))).not.toContain('scroll-end')
    expect(types(run(tr, 899, 400, () => ({ landmarks: hand({ wy: 0.6 }), gesture: 'Pointing_Up', score: 0.9 })))).toContain('scroll-end')
  })

  test('a still hand with two fingers up does not scroll, and never clicks', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 800, () => ({ landmarks: hand({ gap: 0.2 }), gesture: 'Victory', score: 0.9 }))
    expect(evs.filter(e => e.type === 'scroll')).toEqual([])
    expect(evs.filter(e => e.type === 'pinch-start')).toEqual([])
  })

  test('a fast hand move is never a click, even if one blurred frame puts the fingertips together', () => {
    const tr = createTracker()
    run(tr, 0, 200, () => ({ landmarks: hand({ gap: 0.8 }), gesture: 'Pointing_Up', score: 0.9 }))
    // sweeping across the camera in 300 ms; the tips read as touching for a frame, then for two
    const gaps = [0.8, 0.8, 0.15, 0.8, 0.8, 0.15, 0.15, 0.8, 0.8, 0.8]
    let i = 0
    const evs = run(tr, 233, 33 * (gaps.length - 1), t => {
      const x = 0.2 + (t - 233) / 500
      return { landmarks: hand({ wx: x, tx: x, gap: gaps[i++] }), gesture: 'Pointing_Up', score: 0.9 }
    })
    expect(evs.filter(e => e.type === 'pinch-start')).toEqual([])
  })

  test('a single blurred frame on a still hand is not a click either', () => {
    const tr = createTracker()
    const gaps = [0.8, 0.8, 0.8, 0.8, 0.1, 0.8, 0.8]
    let i = 0
    const evs = run(tr, 0, 33 * (gaps.length - 1), () => ({ landmarks: hand({ gap: gaps[i++] }), gesture: 'None' }))
    expect(evs.filter(e => e.type === 'pinch-start')).toEqual([])
  })

  test('a fist held still fires once (home)', () => {
    const tr = createTracker()
    const evs = run(tr, 0, 1200, () => ({ landmarks: anat({}), gesture: 'Closed_Fist', score: 0.9 }))
    expect(evs.filter(e => e.type === 'hold' && e.gesture === 'Closed_Fist')).toHaveLength(1)
  })

  test('closing the hand into a fist never clicks, even with the thumb on the index', () => {
    const tr = createTracker()
    const curling = anat({})
    curling[4] = { ...curling[7], z: 0 } // thumb tip right on the curled index
    expect(isCurled(curling)).toBe(true)
    expect(isCurled(anat({ index: true }))).toBe(false)
    run(tr, 0, 200, () => ({ landmarks: anat({ index: true }), gesture: 'Pointing_Up', score: 0.9 }))
    const evs = run(tr, 233, 300, () => ({ landmarks: curling, gesture: 'None', score: 0.9 }))
    expect(evs.filter(e => e.type === 'pinch-start')).toEqual([])
  })
})
