// Halo: hand gestures from the camera turned into pointer moves and commands.
// Pure logic, no DOM: halo.js feeds it one frame at a time (21 hand landmarks
// plus the recognizer's gesture label) and acts on the events it returns.
// Loaded as a plain script in the page, and with require() by the tests.
'use strict'
;(function (root) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  /** Wrist to the middle finger's knuckle: a size that doesn't change with the pose. */
  function handSize(lm) { return dist(lm[0], lm[9]) || 1e-6 }

  /** Thumb tip to index tip, in hand sizes: under ~0.33 the fingers touch. */
  function pinchRatio(lm) { return dist(lm[4], lm[8]) / handSize(lm) }

  /** 🤙 "call me": thumb and little finger out, the three middle fingers curled in.
   *  The gesture model has no label for it, so it's read from the landmarks. */
  function isCallMe(lm) {
    const w = lm[0], size = handSize(lm)
    const out = (tip, pip) => dist(lm[tip], w) > dist(lm[pip], w) * 1.15
    const curled = (tip, pip) => dist(lm[tip], w) < dist(lm[pip], w) * 1.05
    const thumbOut = dist(lm[4], lm[5]) / size > 0.6 && dist(lm[4], w) > dist(lm[3], w)
    return thumbOut && out(20, 18) && curled(8, 6) && curled(12, 10) && curled(16, 14)
  }

  /** All four fingers curled toward the palm: a fist, or a hand on its way to one.
   *  The thumb crosses the index meanwhile, which mustn't count as a pinch. */
  function isCurled(lm) {
    const w = lm[0]
    return [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => dist(lm[tip], w) < dist(lm[pip], w) * 1.05)
  }

  /** A 1€ filter: steady when the hand is still, quick when it moves. */
  function oneEuro(minCutoff = 1.0, beta = 0.06, dCutoff = 1) {
    let x = null, dx = 0, t = 0
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
    return (value, now) => {
      if (x === null) { x = value; t = now; return x }
      const dt = Math.max(1e-3, (now - t) / 1000)
      t = now
      const d = (value - x) / dt
      dx += alpha(dCutoff, dt) * (d - dx)
      x += alpha(minCutoff + beta * Math.abs(dx), dt) * (value - x)
      return x
    }
  }

  const HOLDS = new Set(['Open_Palm', 'Thumb_Up', 'Thumb_Down', 'Victory', 'ILoveYou', 'Call_Me', 'Closed_Fist'])

  /**
   * Turns frames into events:
   *   move {x, y}            pointer, 0..1 of the screen (mirrored like a selfie)
   *   pinch-progress {p}     0..1 as thumb and index close in (the pointer holds still meanwhile)
   *   pinch-start {x, y}     a click, where the pointer was when the fingers started closing
   *   pinch-end
   *   hold-progress {gesture, p}   0..1 while a command gesture is held still
   *   hold {gesture}         Open_Palm, Thumb_Up, Thumb_Down, Victory, ILoveYou, Call_Me or Closed_Fist held long enough
   *                          (the open palm wakes and sleeps Halo, so it takes longer: wakeMs)
   *   scroll-start / scroll {dy} / scroll-end   ✌️ two fingers up, the hand moved up or down
   *                          (dy: camera heights since the last frame; the pointer holds still meanwhile)
   *   fist-start / fist-end  push to talk
   *   swipe {dir}            'left' | 'right', a quick sideways sweep of the hand
   *   found / lost
   */
  function createTracker(opts = {}) {
    const o = {
      box: 0.16, // camera margin left out, so the screen edges are easy to reach
      pinchOn: 0.33, pinchOff: 0.5, approach: 0.6, // below `approach` the fingers are closing: the pointer freezes
      pinchMaxSpeed: 3, // hand sizes per second: faster, the camera blurs the fingertips, so a touch can't be trusted
      holdMs: 750, wakeMs: 1500, fistMs: 250, fistOffMs: 350, lostMs: 600,
      scrollGraceMs: 250, scrollDead: 0.0015, // the model drops "Victory" for a frame or two in a fast move
      swipeMs: 350, swipeDx: 0.22, swipeDy: 0.12, swipeCooldown: 900,
      stillMove: 0.06, minScore: 0.55, holdCooldown: 2000,
      ...opts,
    }
    const fx = oneEuro(), fy = oneEuro()
    const trail = [] // {t, x, y} pointer, for the position just before a pinch
    const wrist = [] // {t, x, y} mirrored wrist, for swipes and "held still"
    let present = false, lastSeen = -1e9
    let pinching = false
    let hold = null // {gesture, since, fired}
    let fist = false, fistSince = null, fistGone = null
    let lastSwipe = -1e9
    const firedAt = {} // gesture -> time it last fired: a flicker in the recognizer is not a second command
    let pointer = { x: 0.5, y: 0.5 }
    let current = 'None'
    let frozen = null // pointer held still while a pinch closes, so the click lands where you aimed
    let lastProgress = 0
    let ratio = null // pinch ratio, lightly smoothed: a far hand's jitter mustn't freeze the pointer
    let scroll = null // {y, at}: smoothed palm height, and the pointer held where the scroll began
    let victoryAt = -1e9

    const prune = (arr, now, ms) => { while (arr.length && now - arr[0].t > ms) arr.shift() }
    const mapBox = v => Math.min(1, Math.max(0, (v - o.box) / (1 - 2 * o.box)))

    function endAll(events) {
      if (pinching) { pinching = false; events.push({ type: 'pinch-end' }) }
      if (fist) { fist = false; events.push({ type: 'fist-end' }) }
      fistSince = fistGone = null
      if (hold && !hold.fired) events.push({ type: 'hold-progress', gesture: hold.gesture, p: 0 })
      hold = null
    }

    function update(frame, now) {
      const events = []
      const lm = frame && frame.landmarks
      if (!lm || lm.length < 21) {
        if (present && now - lastSeen > o.lostMs) {
          present = false
          ratio = null
          if (scroll) { scroll = null; events.push({ type: 'scroll-end' }) }
          endAll(events)
          trail.length = wrist.length = 0
          events.push({ type: 'lost' })
        }
        return events
      }
      lastSeen = now
      if (!present) { present = true; events.push({ type: 'found' }) }

      const gesture = isCallMe(lm) ? 'Call_Me' : frame.score == null || frame.score >= o.minScore ? frame.gesture || 'None' : 'None'
      current = gesture

      // pointer: the index fingertip, mirrored, smoothed; frozen while a pinch closes or a scroll runs
      const r = pinchRatio(lm)
      ratio = ratio === null ? r : ratio * 0.4 + r * 0.6
      const tip = lm[8]
      const live = { x: fx(mapBox(1 - tip.x), now), y: fy(mapBox(tip.y), now) }
      if (gesture === 'Victory') victoryAt = now
      const scrolling = !pinching && !fist && now - victoryAt <= (scroll ? o.scrollGraceMs : 0)
      const noPinch = gesture === 'Closed_Fist' || scrolling || isCurled(lm)
      if (!frozen && ratio < o.approach && !noPinch) frozen = trail.find(p => now - p.t <= 80) || live
      else if (frozen && !pinching && (ratio > o.approach + 0.05 || noPinch)) frozen = null
      // scroll: ✌️ and move the hand; the page follows it (hand up, the page moves up), like dragging
      const palmY = lm[9].y
      if (scrolling && !scroll) { scroll = { y: palmY, at: frozen || live }; events.push({ type: 'scroll-start' }) }
      else if (scrolling) {
        const y = scroll.y + (palmY - scroll.y) * 0.5
        const dy = y - scroll.y
        if (Math.abs(dy) > o.scrollDead) { scroll.y = y; events.push({ type: 'scroll', dy }) }
      } else if (scroll) { scroll = null; events.push({ type: 'scroll-end' }) }
      pointer = scroll ? scroll.at : frozen || live
      trail.push({ t: now, ...live })
      prune(trail, now, 400)
      events.push({ type: 'move', ...pointer })
      const progress = frozen && !pinching ? Math.min(1, Math.max(0, (o.approach - ratio) / (o.approach - o.pinchOn))) : 0
      if (progress !== lastProgress) { lastProgress = progress; events.push({ type: 'pinch-progress', p: progress }) }

      wrist.push({ t: now, x: 1 - lm[0].x, y: lm[0].y })
      prune(wrist, now, Math.max(o.swipeMs, 300))

      // pinch (with hysteresis), at the frozen pointer: before the thumb dragged the finger along.
      // A fast-moving hand is blurred, and one blurred frame can put thumb and index tips together:
      // so the touch must hold for two frames (smoothed ratio too) and the hand must be nearly still
      const back = wrist.find(p => now - p.t <= 120) ?? wrist.at(-1)
      const speed = now > back.t ? Math.hypot(wrist.at(-1).x - back.x, wrist.at(-1).y - back.y) / ((now - back.t) / 1000) / handSize(lm) : 0
      if (!pinching && r < o.pinchOn && ratio < o.pinchOn && speed < o.pinchMaxSpeed && !noPinch) {
        pinching = true
        events.push({ type: 'pinch-start', x: pointer.x, y: pointer.y })
      } else if (pinching && r > o.pinchOff) {
        pinching = false
        events.push({ type: 'pinch-end' })
      }

      // fist: talk while it's closed
      if (gesture === 'Closed_Fist' && !pinching) {
        fistGone = null
        if (!fist) {
          fistSince ??= now
          if (now - fistSince >= o.fistMs) { fist = true; events.push({ type: 'fist-start' }) }
        }
      } else {
        fistSince = null
        if (fist) {
          fistGone ??= now
          if (now - fistGone >= o.fistOffMs) { fist = false; fistGone = null; events.push({ type: 'fist-end' }) }
        }
      }

      // swipe: a fast sideways sweep with an open hand
      const first = wrist[0]
      const span = wrist.at(-1)
      let swiped = false
      if (first && now - lastSwipe > o.swipeCooldown && !pinching && !fist && gesture !== 'Closed_Fist') {
        const dx = span.x - first.x, dy = span.y - first.y
        if (Math.abs(dx) > o.swipeDx && Math.abs(dy) < o.swipeDy && now - first.t <= o.swipeMs + 50) {
          lastSwipe = now
          swiped = true
          wrist.length = 0
          events.push({ type: 'swipe', dir: dx > 0 ? 'right' : 'left' })
        }
      }

      // command gestures: held still long enough, then fire once
      const recent = wrist.filter(p => now - p.t <= 300)
      const moved = recent.length > 1 ? Math.hypot(recent.at(-1).x - recent[0].x, recent.at(-1).y - recent[0].y) : 0
      const cooling = now - (firedAt[gesture] ?? -1e9) < o.holdCooldown
      if (HOLDS.has(gesture) && !pinching && !swiped && moved < o.stillMove && !cooling) {
        if (!hold || hold.gesture !== gesture) {
          if (hold && !hold.fired) events.push({ type: 'hold-progress', gesture: hold.gesture, p: 0 })
          hold = { gesture, since: now, fired: false }
        }
        if (!hold.fired) {
          const p = Math.min(1, (now - hold.since) / (gesture === 'Open_Palm' ? o.wakeMs : o.holdMs))
          events.push({ type: 'hold-progress', gesture, p })
          if (p >= 1) { hold.fired = true; firedAt[gesture] = now; events.push({ type: 'hold', gesture }) }
        }
      } else if (hold && (hold.gesture !== gesture || swiped || moved >= o.stillMove)) {
        if (!hold.fired) events.push({ type: 'hold-progress', gesture: hold.gesture, p: 0 })
        hold = null
      }
      return events
    }

    return { update, get pointer() { return pointer }, get pinching() { return pinching }, get closing() { return !!frozen }, get scrolling() { return !!scroll }, get fist() { return fist }, get gesture() { return current } }
  }

  /**
   * Which button the halo is on: the one under it, else the nearest within `radius` px
   * (fingertips jitter, buttons are small). The current one is kept until the halo
   * leaves it by more than `keep` px, so it doesn't flicker between neighbours.
   * rects: [{left, top, right, bottom}]; returns an index or -1.
   */
  function nearestTarget(rects, x, y, { radius = 30, current = -1, keep = 16 } = {}) {
    const gap = r => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))
    if (current >= 0 && rects[current] && gap(rects[current]) <= keep) return current
    let best = -1, bestGap = Infinity, bestArea = Infinity
    rects.forEach((r, i) => {
      const g = gap(r), area = (r.right - r.left) * (r.bottom - r.top)
      // inside several (a button in a card)? the smallest wins; else the nearest
      if (g < bestGap - 0.5 || (Math.abs(g - bestGap) <= 0.5 && area < bestArea)) { best = i; bestGap = g; bestArea = area }
    })
    return bestGap <= radius ? best : -1
  }

  /** With two hands in view, stay with the one you started with (nearest to its last wrist). */
  function pickHand(wrists, prev) {
    if (!wrists.length) return -1
    if (!prev) return 0
    let best = 0
    wrists.forEach((w, i) => { if (Math.hypot(w.x - prev.x, w.y - prev.y) < Math.hypot(wrists[best].x - prev.x, wrists[best].y - prev.y)) best = i })
    return best
  }

  const api = { createTracker, pinchRatio, handSize, oneEuro, isCallMe, isCurled, nearestTarget, pickHand }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.HaloCore = api
})(typeof self !== 'undefined' ? self : this)
