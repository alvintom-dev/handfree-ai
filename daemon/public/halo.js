// Halo: control the page with your hand in front of the Mac's camera.
// The camera picture stays in this browser: MediaPipe's gesture model runs here
// (WebAssembly, on the GPU when it can) and only the commands it finds act on the page.
// The gesture rules are in halo-core.js; app.js plugs in what each command does.
'use strict'
;(function () {
  // What Halo may do. Kept small on purpose: add the others back one at a time.
  //   pointer: ☝️ the ring follows your finger   click: 🤏 pinch clicks under the ring
  //   talk: ✊ hold to talk                       stop: ✋ palm stops Claude speaking
  //   allow / deny: 👍 / 👎 answer a permission     photo: ✌️ sends Claude a photo
  //   swipe: 👋 switch view or session            mic: 🤙 call-me sign turns the mic on or off
  //   wake: ✋ palm held 1.5 s puts Halo to sleep / wakes it (asleep, nothing else counts)
  //   scroll: ✌️ two fingers up, move the hand up or down
  //   home: ✊ fist held: back to the home screen     chat: 👍 thumbs up held: open the selected session's chat
  // (stop and wake both use the open palm, allow and chat the thumbs up, talk and home the fist: enable one of each)
  const ENABLED = new Set(['pointer', 'click', 'mic', 'wake', 'scroll', 'home', 'chat'])
  const FEATURE_OF = { Open_Palm: ENABLED.has('wake') ? 'wake' : 'stop', Thumb_Up: ENABLED.has('chat') ? 'chat' : 'allow', Thumb_Down: 'deny', Victory: 'photo', Call_Me: 'mic', Closed_Fist: 'home' }
  const HELP = [
    ['pointer', '☝️', 'Point: the halo sits on your fingertip in the mirror'], ['click', '🤏', 'Pinch (thumb to index tip) to click what it is on'],
    ['talk', '✊', 'Make a fist to talk, open your hand to send'], ['stop', '✋', 'Hold an open palm still: stop Claude speaking'],
    ['allow', '👍', 'Hold thumbs up: allow'], ['deny', '👎', 'Hold thumbs down: deny'],
    ['swipe', '👋', 'Swipe left or right: switch view or project'], ['photo', '✌️', 'Hold a victory sign: send Claude a photo'],
    ['mic', '🤙', 'Hold the call-me sign (thumb and little finger out) still for a second: mic on / off'],
    ['scroll', '✌️', 'Two fingers up, move your hand up or down: scroll what the halo is on'],
    ['chat', '👍', 'Hold thumbs up: open the chat of the selected session'], ['home', '✊', 'Hold a fist: back to the home screen'],
    ['wake', '✋', 'Hold an open palm still for 1.5 s: Halo sleeps / wakes. Asleep, it ignores every other gesture (except 🤙 mic, if the card says so)'],
  ]

  const H = {
    on: false,
    awake: true, // asleep: the camera stays on, but only the wake gesture (✋ held) does anything
    enabled: ENABLED,
    starting: false,
    actions: {}, // stop, allow, deny, talkStart, talkEnd, swipe(dir), snap(dataUrl): set by app.js
    onChange: null,
  }
  let video = null, canvas = null, stream = null, recognizer = null, tracker = null
  let raf = 0, lastT = 0, lastVideoTime = -1
  let delegate = '?'
  // pace: full speed (30/s) with a hand in view (and for a few seconds after: a far hand
  // flickers in and out), a quick look 8 times a second without one (4 when asleep), and
  // asleep after IDLE_SLEEP_MS with no hand: the camera stays on so a hand can wake it
  const FULL_MS = 32, SCAN_MS = 120, SLEEP_SCAN_MS = 250, HAND_GRACE_MS = 3000, IDLE_SLEEP_MS = 120_000
  let lastHandAt = 0
  const perf = { frames: 0, since: 0, ms: 0 }
  let hover = null, pointer = { x: -100, y: -100 }
  // Mirror: the camera fills the screen, see-through, so your fingertip is where it points
  let mirrorOpacity = 22
  try { mirrorOpacity = Math.min(50, Math.max(5, Number(localStorage.getItem('handfree.haloMirror')) || 22)) } catch {}
  // the camera card folds into a small "● Halo" pill (the default) so it stays out of the way;
  // the red dot always shows that the camera is on
  let cardOpen = false
  try { cardOpen = localStorage.getItem('handfree.haloCard') === 'open' } catch {}
  // semi-lock: asleep, the 🤙 call-me sign still turns the mic on or off (off: asleep ignores it too)
  let micAsleep = false
  try { micAsleep = localStorage.getItem('handfree.haloMicAsleep') === 'on' } catch {}
  const sleepText = () => '😴 Halo asleep · hold ✋ still to wake' + (micAsleep && ENABLED.has('mic') ? ' · 🤙 mic' : '')
  const ui = {}

  const CONNECT = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]]
  const GESTURE_TEXT = { Pointing_Up: '☝️ pointing', Open_Palm: '✋ open palm: hold to sleep', Closed_Fist: '✊ fist: hold for Home', Thumb_Up: '👍 thumbs up: hold for Chat', Thumb_Down: '👎 thumbs down', Victory: '✌️ victory', ILoveYou: '🤟 rock sign', Call_Me: '🤙 call-me sign: hold for mic', None: '✋ hand' }
  const HOLD_TEXT = { Open_Palm: ENABLED.has('wake') ? 'Sleep' : 'Stop', Closed_Fist: 'Home', Thumb_Up: ENABLED.has('chat') ? 'Chat' : 'Allow', Thumb_Down: 'Deny', Victory: 'Photo', Call_Me: 'Mic' }
  const allowed = gesture => ENABLED.has(FEATURE_OF[gesture])

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }

  function build() {
    if (ui.cursor) return
    ui.cursor = el('div', 'halo-cursor')
    ui.cursor.setAttribute('aria-hidden', 'true')
    ui.cursor.append(el('i', 'halo-ring'), el('b', 'halo-label'))
    ui.cam = el('div', 'halo-cam')
    ui.cam.setAttribute('role', 'region')
    ui.cam.setAttribute('aria-label', 'Halo camera')
    video = el('video')
    video.muted = true
    video.playsInline = true
    canvas = el('canvas')
    canvas.width = 320
    canvas.height = 240
    const frame = el('div', 'halo-frame')
    frame.append(video, canvas)
    const head = el('div', 'halo-head')
    const live = el('span', 'halo-live', 'Camera on')
    ui.status = el('span', 'halo-status', 'Starting…')
    const help = el('button', 'halo-x', '?')
    help.type = 'button'
    help.title = 'Show the gestures'
    help.setAttribute('aria-label', 'Show the gestures')
    help.onclick = () => showHelp(true)
    const close = el('button', 'halo-x', '✕')
    close.type = 'button'
    close.title = 'Turn Halo off (camera off)'
    close.setAttribute('aria-label', 'Turn Halo off')
    close.onclick = () => stop()
    const fold = el('button', 'halo-x halo-fold')
    fold.type = 'button'
    fold.onclick = () => openCard(!cardOpen)
    live.onclick = () => { if (!cardOpen) openCard(true) }
    head.append(live, fold, help, close)
    ui.fold = fold
    ui.prog = el('div', 'halo-prog')
    ui.prog.append(el('i'))
    const see = el('label', 'halo-see')
    const range = el('input')
    Object.assign(range, { type: 'range', min: '5', max: '50', value: String(mirrorOpacity) })
    range.setAttribute('aria-label', 'Mirror see-through')
    range.oninput = () => {
      mirrorOpacity = Number(range.value)
      ui.mirror.style.opacity = String((H.awake ? mirrorOpacity : mirrorOpacity * 0.35) / 100)
      try { localStorage.setItem('handfree.haloMirror', range.value) } catch {}
    }
    see.append(el('span', '', 'Mirror'), range)
    const semi = el('label', 'halo-see halo-semi')
    const box = el('input')
    Object.assign(box, { type: 'checkbox', checked: micAsleep })
    box.onchange = () => {
      micAsleep = box.checked
      try { localStorage.setItem('handfree.haloMicAsleep', micAsleep ? 'on' : 'off') } catch {}
      ui.sleepText.textContent = sleepText()
    }
    semi.title = 'Semi-lock: while Halo is asleep, holding the call-me sign still turns the mic on or off'
    semi.append(box, el('span', '', '🤙 Mic works while asleep'))
    ui.cam.classList.add('mirror')
    ui.perf = el('span', 'halo-perf', '')
    ui.perf.title = 'Hand tracking speed: frames per second, time per frame, and whether the GPU or CPU runs it'
    if (!ENABLED.has('mic') || !ENABLED.has('wake')) semi.hidden = true
    ui.cam.append(head, frame, see, semi, ui.prog, ui.status, ui.perf)
    openCard(cardOpen)
    ui.mirror = el('video', 'halo-mirror')
    ui.mirror.muted = true
    ui.mirror.playsInline = true
    ui.mirror.setAttribute('aria-hidden', 'true')
    ui.mirror.style.setProperty('--reach', String(REACH))
    ui.mirror.style.opacity = String(mirrorOpacity / 100)
    document.body.append(ui.mirror)
    ui.toast = el('div', 'halo-toast')
    ui.toast.setAttribute('role', 'status')
    ui.toast.setAttribute('aria-live', 'polite')
    ui.help = el('div', 'halo-help')
    const list = el('ul')
    for (const [feature, icon, text] of HELP) {
      if (!ENABLED.has(feature)) continue
      const li = el('li')
      li.append(el('span', '', icon), text)
      list.append(li)
    }
    ui.help.append(el('b', '', 'Halo gestures'), list)
    const ok = el('button', 'btn small', 'Got it')
    ok.type = 'button'
    ok.onclick = () => showHelp(false)
    ui.help.append(ok)
    ui.sleep = el('div', 'halo-sleep')
    ui.sleep.setAttribute('role', 'status')
    ui.sleepText = el('span', '', sleepText())
    ui.sleep.append(ui.sleepText, el('i'))
    document.body.append(ui.cursor, ui.cam, ui.toast, ui.help, ui.sleep)
  }

  /** The full camera card, or just the small pill. */
  function openCard(open) {
    cardOpen = open
    try { localStorage.setItem('handfree.haloCard', open ? 'open' : 'pill') } catch {}
    ui.cam.classList.toggle('mini', !open)
    ui.fold.textContent = open ? '–' : '▴'
    ui.fold.title = open ? 'Fold the camera card into a small pill' : 'Show the camera card'
    ui.fold.setAttribute('aria-label', ui.fold.title)
    ui.cam.querySelector('.halo-live').textContent = open ? 'Camera on' : 'Halo'
  }

  function status(text) { if (ui.status) ui.status.textContent = text }

  let toastTimer = 0
  function toast(text, ms = 1600) {
    if (!ui.toast) return
    ui.toast.textContent = text
    ui.toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms)
  }

  let helpTimer = 0
  function showHelp(on) {
    ui.help.classList.toggle('show', on)
    clearTimeout(helpTimer)
    if (on) helpTimer = setTimeout(() => ui.help.classList.remove('show'), 9000)
  }

  async function loadRecognizer() {
    const vision = await import('/vendor/vision_bundle.mjs')
    const files = await vision.FilesetResolver.forVisionTasks('/vendor')
    const make = delegate => vision.GestureRecognizer.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/vendor/gesture_recognizer.task', delegate },
      runningMode: 'VIDEO',
      numHands: 2, // so a second hand in view can't steal the halo: we stay with the first (pickHand)
      // lower than the defaults: a hand 1 m+ away is small and scores lower, and the
      // tracker's own rules (pinch ratio, holds) already ignore half-seen hands
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    })
    try { const r = await make('GPU'); delegate = 'GPU'; return r } catch { delegate = 'CPU'; return await make('CPU') }
  }

  async function start() {
    if (H.on || H.starting) return
    H.starting = true
    build()
    ui.cam.classList.add('show')
    changed()
    try {
      status('Asking for the camera…')
      // 640×480 at 30 fps: the hand model crops the hand out of the picture, so a far (small)
      // hand needs the pixels; 30 fps keeps the work down
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' }, audio: false })
      video.srcObject = stream
      await video.play()
      ui.mirror.srcObject = stream
      await ui.mirror.play()
      ui.mirror.classList.add('show')
      status('Loading hand tracking…')
      recognizer ??= await loadRecognizer()
      tracker = HaloCore.createTracker({ box: 0 }) // 1:1 with the mirror: no margin
      H.on = true
      setAwake(true, true)
      lastHandAt = performance.now() // the 2-minute idle clock starts now
      perf.frames = 0; perf.since = lastHandAt
      document.body.classList.add('halo-on')
      watchTargets()
      status('Show your hand')
      showHelp(true)
      loop()
    } catch (err) {
      stopStream()
      ui.cam.classList.remove('show')
      console.error('[halo]', err)
      if (H.onError) H.onError(err)
      else toast(err?.name === 'NotAllowedError' ? 'Camera blocked: allow it in the browser to use Halo' : `Halo could not start: ${err?.message || err}`, 4000)
    } finally {
      H.starting = false
      changed()
    }
  }

  function stopStream() {
    for (const t of stream?.getTracks() ?? []) t.stop()
    stream = null
    if (video) video.srcObject = null
    if (ui.mirror) { ui.mirror.srcObject = null; ui.mirror.classList.remove('show') }
  }

  function stop() {
    cancelAnimationFrame(raf)
    if (raf && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(raf)
    raf = 0
    if (tracker?.fist && ENABLED.has('talk')) H.actions.talkEnd?.()
    tracker = null
    stopStream()
    unwatchTargets()
    H.on = false
    H.awake = true
    document.body.classList.remove('halo-on', 'halo-asleep')
    setHover(null)
    scrollBox = null
    for (const k of ['cam', 'cursor', 'help', 'sleep']) ui[k]?.classList.remove('show')
    changed()
  }

  function changed() { H.onChange?.() }

  // every new camera frame, as soon as it arrives (falls back to animation frames)
  const nextFrame = () => { raf = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop) }
  let lockWrist = null, lockSeen = 0
  function loop() {
    if (!H.on) return
    nextFrame()
    if (!video || video.readyState < 2 || video.currentTime === lastVideoTime) return
    const now = performance.now()
    const handNow = now - lastHandAt < HAND_GRACE_MS
    if (now - lastT < (handNow ? FULL_MS : H.awake ? SCAN_MS : SLEEP_SCAN_MS)) return
    if (H.awake && !handNow && ENABLED.has('wake') && now - lastHandAt > (H.idleSleepMs ?? IDLE_SLEEP_MS)) setAwake(false, false, '😴 Halo asleep: no hand for 2 minutes. Hold ✋ to wake')
    lastT = now
    lastVideoTime = video.currentTime
    let res
    try { res = recognizer.recognizeForVideo(video, now) } catch (e) { console.error('[halo]', e); return }
    meter(now, performance.now() - now)
    // two hands may be in view: stay with the one we were following (released after 1 s without hands)
    if (now - lockSeen > 1000) lockWrist = null
    const i = HaloCore.pickHand((res.landmarks ?? []).map(h => h[0]), lockWrist)
    const lm = i >= 0 ? res.landmarks[i] : null
    const g = i >= 0 ? res.gestures?.[i]?.[0] : null
    if (lm) { lockWrist = { x: lm[0].x, y: lm[0].y }; lockSeen = now; lastHandAt = now }
    if (!ui.cam.classList.contains('mirror')) draw(lm)
    const events = tracker.update(lm ? { landmarks: lm, gesture: g?.categoryName, score: g?.score } : null, now)
    for (const e of events) handle(e)
    if (lm) status(!H.awake ? (tracker.gesture === 'Open_Palm' ? '✋ keep holding to wake…' : tracker.gesture === 'Call_Me' && micAsleep ? '🤙 keep holding for mic…' : '😴 asleep: hold ✋ still to wake') : tracker.fist && ENABLED.has('talk') ? '✊ talking… open your hand to send' : tracker.pinching && ENABLED.has('click') ? '🤏 pinch' : tracker.scrolling && ENABLED.has('scroll') ? '✌️ scrolling' : GESTURE_TEXT[tracker.gesture] ?? '✋ hand')
  }

  function draw(lm) {
    const g = canvas.getContext('2d')
    g.clearRect(0, 0, canvas.width, canvas.height)
    if (!lm) return
    const css = getComputedStyle(document.documentElement)
    g.strokeStyle = css.getPropertyValue('--accent').trim() || '#2E7D67'
    g.lineWidth = 2
    for (const [a, b] of CONNECT) {
      g.beginPath()
      g.moveTo(lm[a].x * canvas.width, lm[a].y * canvas.height)
      g.lineTo(lm[b].x * canvas.width, lm[b].y * canvas.height)
      g.stroke()
    }
    g.fillStyle = '#fff'
    for (const p of lm) { g.beginPath(); g.arc(p.x * canvas.width, p.y * canvas.height, 2.5, 0, Math.PI * 2); g.fill() }
  }

  const CLICKABLE = 'button, a[href], input, textarea, select, summary, [data-halo]'
  // Only buttons on screen matter to the halo. The browser tells us which ones are
  // (IntersectionObserver: hidden sessions, scrolled-away messages and closed dialogs
  // never are), so the work stays the same however long the chat gets.
  const onScreen = new Set()
  let seen = null, added = null
  function watchTargets() {
    seen = new IntersectionObserver(entries => {
      for (const en of entries) en.isIntersecting ? onScreen.add(en.target) : onScreen.delete(en.target)
      targetsAt = 0
    })
    const each = (n, fn) => { if (n.nodeType !== 1) return; if (n.matches(CLICKABLE)) fn(n); for (const e of n.querySelectorAll(CLICKABLE)) fn(e) }
    each(document.body, e => seen.observe(e))
    added = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) each(n, e => seen.observe(e))
        for (const n of m.removedNodes) each(n, e => { seen.unobserve(e); onScreen.delete(e) })
      }
    })
    added.observe(document.body, { childList: true, subtree: true })
  }
  function unwatchTargets() {
    seen?.disconnect(); added?.disconnect()
    seen = added = null
    onScreen.clear()
  }
  // where those buttons are, refreshed a few times a second (the page re-renders)
  let targets = [], targetsAt = 0
  function visibleTargets(now) {
    if (now - targetsAt < 300) return targets
    targetsAt = now
    const dlg = [...document.querySelectorAll('dialog')].find(d => d.open) // a dialog takes the halo too
    targets = [...onScreen]
      .filter(e => e.isConnected && !e.disabled && (!dlg || dlg.contains(e)) && !e.closest('.halo-cursor'))
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(t => t.r.width > 0 && t.r.height > 0 && t.r.bottom > 0 && t.r.right > 0 && t.r.top < innerHeight && t.r.left < innerWidth)
    return targets
  }
  /** The button the halo is on: under it, or the nearest within 30 px; sticky until clearly left. */
  function targetAt(x, y) {
    const list = visibleTargets(performance.now())
    const i = HaloCore.nearestTarget(list.map(t => t.r), x, y, { radius: 30, current: list.findIndex(t => t.e === hover), keep: 16 })
    return i >= 0 ? list[i].e : null
  }

  function setHover(t) {
    if (hover === t) return
    hover?.classList.remove('halo-hover')
    hover = t
    hover?.classList.add('halo-hover')
    ui.cursor?.classList.toggle('over', !!t)
  }

  function handle(e) {
    const c = ui.cursor
    // asleep: only the wake gesture gets through (and the mic, in semi-lock)
    if (!H.awake) {
      if ((e.type === 'hold-progress' || e.type === 'hold') && e.gesture === 'Open_Palm') return wakeHold(e)
      if (micAsleep && allowed('Call_Me') && e.gesture === 'Call_Me') {
        if (e.type === 'hold-progress') return setProgress(e.p > 0 && e.p < 1 ? e.p : 0)
        if (e.type === 'hold') { setProgress(0); return command('Call_Me') }
      }
      if (e.type === 'lost') { setProgress(0); wakeProgress(0); status('😴 asleep: hold ✋ still to wake') }
      return
    }
    switch (e.type) {
      case 'found': if (ENABLED.has('pointer')) c.classList.add('show'); return
      case 'lost': c.classList.remove('show'); setHover(null); setProgress(0); status('Show your hand'); return
      case 'move':
        if (!ENABLED.has('pointer')) return
        pointer = toScreen(e.x, e.y)
        c.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`
        setHover(targetAt(pointer.x, pointer.y))
        return
      case 'pinch-progress':
        if (ENABLED.has('click')) c.style.setProperty('--pinch', String(e.p))
        return
      case 'pinch-start': {
        if (!ENABLED.has('click')) return
        c.classList.add('pinch')
        c.style.setProperty('--pinch', '0')
        // what's highlighted is what gets clicked
        const t = hover ?? targetAt(...Object.values(toScreen(e.x, e.y)))
        if (!t) return
        if (t.matches('input, textarea, select')) t.focus()
        else t.click()
        t.classList.add('halo-clicked')
        setTimeout(() => t.classList.remove('halo-clicked'), 300)
        return
      }
      case 'pinch-end': c.classList.remove('pinch'); return
      case 'hold-progress':
        if (!allowed(e.gesture)) return
        setProgress(e.p > 0 && e.p < 1 ? e.p : 0)
        c.style.setProperty('--hold', String(e.p))
        c.querySelector('.halo-label').textContent = e.p > 0 && e.p < 1 ? HOLD_TEXT[e.gesture] ?? '' : ''
        c.classList.toggle('holding', e.p > 0 && e.p < 1)
        return
      case 'hold':
        if (!allowed(e.gesture)) return
        setProgress(0)
        c.classList.remove('holding')
        c.style.setProperty('--hold', '0')
        c.querySelector('.halo-label').textContent = ''
        return command(e.gesture)
      case 'fist-start':
        if (!ENABLED.has('talk')) return
        c.classList.add('talk')
        if (H.actions.talkStart?.() !== false) toast('✊ Talking… open your hand to send')
        return
      case 'fist-end':
        if (!ENABLED.has('talk')) return
        c.classList.remove('talk')
        H.actions.talkEnd?.()
        return
      case 'scroll-start':
        if (!ENABLED.has('scroll')) return
        scrollBox = scrollableAt(pointer.x, pointer.y)
        c.classList.add('scroll')
        return
      case 'scroll':
        if (!ENABLED.has('scroll') || !scrollBox) return
        // the page follows the hand, like dragging it: hand up, the page moves up
        scrollBox.scrollBy({ top: -e.dy * innerHeight * SCROLL_GAIN, behavior: 'instant' })
        return
      case 'scroll-end': scrollBox = null; c.classList.remove('scroll'); return
      case 'swipe':
        if (!ENABLED.has('swipe')) return
        toast(e.dir === 'left' ? '👈 Swipe' : '👉 Swipe', 900)
        H.actions.swipe?.(e.dir)
        return
    }
  }

  function command(gesture) {
    const a = H.actions
    if (gesture === 'Open_Palm' && ENABLED.has('wake')) return setAwake(false)
    if (gesture === 'Open_Palm') { a.stop?.(); return toast('✋ Stopped') }
    if (gesture === 'Closed_Fist') return toast(a.home?.() || '✊ Home')
    if (gesture === 'Thumb_Up' && ENABLED.has('chat')) return toast(a.chat?.() || '👍 Chat')
    if (gesture === 'Thumb_Up') return toast(a.allow?.() ? '👍 Allowed' : '👍 Nothing waiting for approval')
    if (gesture === 'Thumb_Down') return toast(a.deny?.() ? '👎 Denied' : '👎 Nothing waiting for approval')
    if (gesture === 'Victory') return countdownPhoto()
    if (gesture === 'Call_Me') return toast(a.mic?.() || '🤙')
  }

  // --- asleep / awake --------------------------------------------------------------

  /** Sleep: drop whatever is going on, hide the halo, dim the mirror; awake: all gestures again. */
  function setAwake(on, quiet = false, text) {
    if (H.awake === on && !quiet) return
    H.awake = on
    const c = ui.cursor
    if (!on) {
      if (tracker?.fist && ENABLED.has('talk')) H.actions.talkEnd?.()
      setHover(null)
      scrollBox = null
      c?.classList.remove('show', 'pinch', 'talk', 'holding', 'scroll')
      c?.style.setProperty('--hold', '0')
      if (c) c.querySelector('.halo-label').textContent = ''
    } else if (tracker && performance.now() - lastHandAt < 500 && ENABLED.has('pointer')) c?.classList.add('show')
    setProgress(0)
    wakeProgress(0)
    document.body.classList.toggle('halo-asleep', !on)
    ui.sleep?.classList.toggle('show', H.on && !on)
    if (ui.mirror) ui.mirror.style.opacity = String((on ? mirrorOpacity : mirrorOpacity * 0.35) / 100)
    if (!quiet) { toast(text ?? (on ? '✋ Halo awake' : '😴 Halo asleep: hold ✋ to wake'), 2200); H.onAwake?.(on) }
    changed()
  }

  /** The open palm held while asleep: fill the "asleep" badge, wake at the end. */
  function wakeHold(e) {
    if (e.type === 'hold') return setAwake(true)
    setProgress(e.p > 0 && e.p < 1 ? e.p : 0)
    wakeProgress(e.p > 0 && e.p < 1 ? e.p : 0)
  }
  function wakeProgress(p) { ui.sleep?.style.setProperty('--p', String(p)) }

  // --- scroll -------------------------------------------------------------------------

  const SCROLL_GAIN = 2.5 // a hand move of a fifth of the camera height scrolls half a screen
  let scrollBox = null
  /** What a scroll moves: the scrollable box under the halo, else the page's main list. */
  function scrollableAt(x, y) {
    const scrolls = e => { const st = getComputedStyle(e); return /(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 4 }
    for (let e = document.elementFromPoint(x, y); e && e !== document.body; e = e.parentElement) if (scrolls(e)) return e
    return ['#log', '#list', '#panel'].map(q => document.querySelector(q)).find(e => e && !e.closest('[hidden]') && scrolls(e)) ?? document.scrollingElement
  }

  /** Mirrored camera point (0..1) to the screen, through the same crop and zoom the mirror shows
   *  ("cover", then REACH× around the middle, so the screen edges sit inside the camera picture).
   *  Fixed on purpose: a zoom that follows the hand moves the mirror under you. */
  const REACH = 1.2
  function toScreen(mx, my) {
    const vw = video.videoWidth || 640, vh = video.videoHeight || 480
    const s = Math.max(innerWidth / vw, innerHeight / vh)
    const offX = (innerWidth - vw * s) / 2, offY = (innerHeight - vh * s) / 2
    const x = innerWidth - ((1 - mx) * vw * s + offX), y = my * vh * s + offY
    return { x: innerWidth / 2 + (x - innerWidth / 2) * REACH, y: innerHeight / 2 + (y - innerHeight / 2) * REACH }
  }

  /** fps, ms per frame and GPU/CPU, shown small in the Halo card (handy on a new Mac or browser). */
  function meter(now, ms) {
    perf.frames++
    perf.ms = perf.ms ? perf.ms * 0.9 + ms * 0.1 : ms
    if (now - perf.since >= 1000) {
      const fps = perf.frames * 1000 / (now - perf.since)
      if (ui.perf) ui.perf.textContent = `${Math.round(fps)} fps · ${perf.ms.toFixed(1)} ms/frame · ${delegate}`
      perf.frames = 0
      perf.since = now
    }
  }

  function setProgress(p) {
    ui.prog?.firstChild.style.setProperty('width', `${Math.round(p * 100)}%`)
    ui.prog?.classList.toggle('on', p > 0)
  }

  let photoBusy = false
  async function countdownPhoto() {
    if (photoBusy) return
    photoBusy = true
    for (const n of ['3', '2', '1']) { toast(`📸 Photo for Claude in ${n}…`, 1100); await new Promise(r => setTimeout(r, 900)) }
    const url = snapFrame()
    photoBusy = false
    if (!url) return toast('No camera picture yet')
    ui.cam.classList.add('flash')
    setTimeout(() => ui.cam.classList.remove('flash'), 300)
    const sent = H.actions.snap?.(url)
    toast(sent === false ? 'Start a Claude session first' : '📸 Sent to Claude')
  }

  /** The camera picture as a JPEG data URL (as the camera sees it, not mirrored). */
  function snapFrame() {
    if (!video || !video.videoWidth) return null
    const c = document.createElement('canvas')
    c.width = video.videoWidth
    c.height = video.videoHeight
    c.getContext('2d').drawImage(video, 0, 0)
    return c.toDataURL('image/jpeg', 0.85)
  }

  Object.assign(H, { start, stop, toggle: () => (H.on || H.starting ? stop() : start()), snapFrame, toast })
  window.HandfreeHalo = H
})()
