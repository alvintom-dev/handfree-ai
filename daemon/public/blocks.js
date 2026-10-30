// Visual blocks for Claude's detail answers, on top of plain markdown:
//   ```mermaid   a drawn diagram (flowchart, sequence, ...)
//   ```stats     number tiles:   Label | Value | note | bar:60
//   ```options   option cards:   A* Title | effort 2   then  + pro / - con lines
//   ```steps     a step plan:    done|next|todo|fail | Title | detail
//   ```wireframe screen sketches: phone|browser|tablet | Title   then  kind | label lines
//   ```design    link cards:     Title | https://claude.ai/... | note
//   ```tiles     an overview grid: Title | note | https picture   (tap: its "### Title" section)
//   > [!TLDR] / [!NOTE] / [!TIP] / [!WARNING] / [!DECIDE]   callout boxes
// Pure string in, HTML out (sanitised by the caller), so bun tests can load it.
'use strict'

;(() => {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  let inline = esc
  const cells = line => line.split('|').map(s => s.trim())
  const lines = src => src.split('\n').map(s => s.trim()).filter(Boolean)

  // Flowcharts get the style classes without having to declare them
  const FLOW_CLASSES = '\n  classDef hi stroke-width:2px\n  classDef ok stroke-width:2px\n  classDef warn stroke-width:2px\n  classDef bad stroke-width:2px'

  function mermaid(src) {
    const flow = /^\s*(flowchart|graph)\b/.test(src)
    return `<div class="diagram"><pre class="mermaid">${esc(src.trimEnd() + (flow ? FLOW_CLASSES : ''))}</pre></div>`
  }

  function stats(src) {
    const tiles = lines(src).map(line => {
      const [k = '', v = '', ...rest] = cells(line)
      let bar = ''
      const notes = rest.filter(r => {
        const m = /^bar:\s*(\d{1,3})%?$/.exec(r)
        if (m) bar = `<div class="bar"><i style="width:${Math.min(100, +m[1])}%"></i></div>`
        return !m
      })
      return `<div class="stat"><div class="k">${inline(k)}</div><div class="v">${inline(v)}</div>${notes.map(n => `<div class="n">${inline(n)}</div>`).join('')}${bar}</div>`
    })
    return `<div class="stats">${tiles.join('')}</div>`
  }

  function options(src) {
    const cards = []
    for (const line of lines(src)) {
      const point = /^([+-])\s+(.*)$/.exec(line)
      if (point && cards.length) {
        cards.at(-1).points.push(`<li class="${point[1] === '+' ? 'pro' : 'con'}">${inline(point[2])}</li>`)
        continue
      }
      const [head, ...rest] = cells(line)
      const m = /^(\S{1,3}?)(\*)?\s+(.+)$/.exec(head)
      const effort = rest.map(r => /^effort\s*(\d)$/i.exec(r)).find(Boolean)
      cards.push({ key: m ? m[1] : '', best: !!m?.[2], title: m ? m[3] : head, effort: effort ? Math.min(3, +effort[1]) : 0, points: [] })
    }
    const html = cards.map(c => {
      const meter = c.effort ? `<div class="meter"><span>Effort</span>${[1, 2, 3].map(i => `<i class="${i <= c.effort ? 'on' : ''}"></i>`).join('')}</div>` : ''
      return `<div class="opt${c.best ? ' best' : ''}">${c.best ? '<span class="badge">RECOMMENDED</span>' : ''}`
        + `${c.key ? `<div class="letter">${esc(c.key)}</div>` : ''}<h4>${inline(c.title)}</h4>`
        + `${c.points.length ? `<ul>${c.points.join('')}</ul>` : ''}${meter}</div>`
    })
    return `<div class="options">${html.join('')}</div>`
  }

  const STEP = { done: ['done', '✓', 'ok', 'Done'], next: ['now', '', 'run', 'Next'], now: ['now', '', 'run', 'Now'], todo: ['', '', 'todo', 'To do'], fail: ['fail', '✕', 'bad', 'Failed'] }

  function steps(src) {
    const items = lines(src).map((line, i) => {
      let [status, title = '', detail = ''] = cells(line)
      if (!STEP[status.toLowerCase()]) [status, title, detail] = ['todo', status, title]
      const [cls, mark, tag, label] = STEP[status.toLowerCase()]
      return `<li class="${cls}"><span class="dot">${mark || i + 1}</span><div><b>${inline(title)}</b>${detail ? `<div class="d">${inline(detail)}</div>` : ''}</div><span class="tag ${tag}">${label}</span></li>`
    })
    return `<ol class="steps">${items.join('')}</ol>`
  }

  // Wireframes: "phone | Title" (or browser, tablet) starts a screen, then one element
  // per line: kind | label | ...   A * marks the main button or the active tab.
  // A "note: ..." cell pins a numbered note on that element, listed under the screens.
  const FRAMES = new Set(['phone', 'browser', 'tablet'])
  const WIRE_KINDS = new Set(['bar', 'header', 'title', 'text', 'input', 'search', 'select', 'button', 'link', 'image', 'card',
    'list', 'tabs', 'chips', 'nav', 'sidebar', 'toggle', 'check', 'radio', 'divider', 'space', 'avatar', 'grid', 'table', 'fab', 'row'])
  const starred = s => /^\*|\*$/.test(s)
  const unstar = s => s.replace(/^\*\s*|\s*\*$/g, '')

  /** "button* | Sign in" or "button Sign in" -> { kind, main, args } */
  function wireLine(line) {
    const parts = cells(line)
    let head = parts.shift()
    const word = /^(\w+\*?)\s+(.+)$/.exec(head)
    const kindOf = h => h.replace('*', '').toLowerCase()
    if (word && (WIRE_KINDS.has(kindOf(word[1])) || FRAMES.has(kindOf(word[1])))) {
      head = word[1]
      parts.unshift(word[2])
    }
    head = head.toLowerCase()
    const kind = head.replace('*', '')
    return { kind, main: head.endsWith('*'), args: parts, known: WIRE_KINDS.has(kind) || FRAMES.has(kind) }
  }

  function wireItem({ kind, main, args, known }, line) {
    const [a = '', b = ''] = args
    const tabs = cls => `<div class="${cls}">${args.map(t => `<span class="${starred(t) ? 'on' : ''}"><i></i>${inline(unstar(t))}</span>`).join('')}</div>`
    const ctl = shape => `<div class="w-ctl"><i class="w-${shape}${main || starred(a) ? ' on' : ''}"></i>${inline(unstar(a))}</div>`
    if (!known) return `<div class="w-box">${inline(line)}</div>`
    switch (kind) {
      case 'bar': return `<div class="w-bar"><span>‹</span><b>${inline(a)}</b><span>${inline(b || '⋯')}</span></div>`
      case 'header': case 'title': return `<div class="w-h">${inline(a)}</div>`
      case 'text': return a ? `<div class="w-p">${inline(a)}</div>` : '<div class="w-lines"><i></i><i></i><i></i></div>'
      case 'input': return `<div class="w-input">${inline(a)}</div>`
      case 'search': return `<div class="w-input">⌕ ${inline(a || 'Search')}</div>`
      case 'select': return `<div class="w-input w-select">${inline(a)}<span>▾</span></div>`
      case 'button': return `<div class="w-btn${main || starred(a) ? ' main' : ''}">${inline(unstar(a))}</div>`
      case 'link': return `<div class="w-link">${inline(a)}</div>`
      case 'image': return `<div class="w-img" style="height:${Math.min(400, Math.max(40, parseInt(b) || 110))}px">${inline(a)}</div>`
      case 'card': return `<div class="w-card"><i class="w-thumb"></i><div><b>${inline(a)}</b>${b ? `<div class="w-sub">${inline(b)}</div>` : ''}</div></div>`
      case 'list': return `<div class="w-list">${args.map(t => `<div><i class="w-dot"></i><span>${inline(t)}</span><span class="w-chev">›</span></div>`).join('')}</div>`
      case 'tabs': case 'chips': return tabs(`w-tabs${kind === 'chips' ? ' w-chips' : ''}`)
      case 'nav': return tabs('w-nav')
      case 'sidebar': return tabs('w-side')
      case 'toggle': return ctl('toggle')
      case 'check': return ctl('check')
      case 'radio': return ctl('radio')
      case 'divider': return '<hr class="w-hr">'
      case 'space': return '<div class="w-space"></div>'
      case 'avatar': return `<div class="w-avatar"><i></i><div><b>${inline(a)}</b>${b ? `<div class="w-sub">${inline(b)}</div>` : ''}</div></div>`
      case 'grid': return `<div class="w-grid">${args.map(t => `<div>${inline(t)}</div>`).join('')}</div>`
      case 'table': {
        const head = `<div class="w-tr w-th">${args.map(t => `<span>${inline(t)}</span>`).join('')}</div>`
        const row = `<div class="w-tr">${args.map(() => '<span><i></i></span>').join('')}</div>`
        return `<div class="w-table" style="--cols:${Math.max(1, args.length)}">${head}${row.repeat(3)}</div>`
      }
      case 'fab': return `<div class="w-fab">${inline(a || '+')}</div>`
      case 'row': return `<div class="w-row">${args.map(t => wireItem(wireLine(t), t)).join('')}</div>`
    }
  }

  function wireframe(src) {
    const screens = []
    const notes = []
    for (const line of lines(src)) {
      const item = wireLine(line)
      if (FRAMES.has(item.kind)) { screens.push({ frame: item.kind, title: item.args[0] ?? '', body: [], nav: '', side: '', fab: '' }); continue }
      if (!screens.length) screens.push({ frame: 'phone', title: '', body: [], nav: '', side: '', fab: '' })
      const s = screens.at(-1)
      const note = item.args.findIndex(t => /^note:/i.test(t))
      let pin = ''
      if (note >= 0) {
        notes.push(item.args.splice(note, 1)[0].replace(/^note:\s*/i, ''))
        pin = `<span class="w-pin">${notes.length}</span>`
      }
      let html = wireItem(item, line)
      if (pin) html = `<div class="w-el">${html}${pin}</div>`
      if (item.kind === 'nav') s.nav += html
      else if (item.kind === 'sidebar') s.side += html
      else if (item.kind === 'fab') s.fab += html
      else s.body.push(html)
    }
    const drawn = screens.map(s => {
      const body = `<div class="wf-body">${s.body.join('')}${s.fab}</div>`
      const inner = s.frame === 'browser'
        ? `<div class="wf-chrome"><i></i><i></i><i></i><span class="wf-url">${inline(s.title)}</span></div>${s.nav}<div class="wf-page">${s.side}${body}</div>`
        : `<div class="wf-status"><span>9:41</span><span>▮▮▮</span></div>${s.side}${body}${s.nav}`
      const caption = s.title && s.frame !== 'browser' ? `<figcaption>${inline(s.title)}</figcaption>` : ''
      return `<figure class="wf-screen ${s.frame}"><div class="wf ${s.frame}">${inner}</div>${caption}</figure>`
    })
    const list = notes.length ? `<ol class="w-notes">${notes.map((n, i) => `<li><span class="w-pin">${i + 1}</span>${inline(n)}</li>`).join('')}</ol>` : ''
    return `<div class="wires">${drawn.join('<div class="w-arrow">→</div>')}</div>${list}`
  }

  // Link cards for finished designs:   Title | https://claude.ai/... | note
  function design(src) {
    const cards = lines(src).map(line => {
      const [title = '', url = '', note = ''] = cells(line)
      const txt = `<span class="dc-ic">◆</span><span class="dc-txt"><b>${inline(title)}</b>${note ? `<span>${inline(note)}</span>` : ''}</span>`
      return /^https:\/\/[^\s"'<>]+$/.test(url)
        ? `<a class="design-card" href="${esc(url)}">${txt}<span class="dc-go">Open design ↗</span></a>`
        : `<div class="design-card">${txt}</div>`
    })
    return `<div class="designs">${cards.join('')}</div>`
  }

  // Overview tiles, two to a row:   Title | note | https://picture
  // A tile opens the "### Title" section of the same answer (see tileDetails), or asks the session.
  const PICTURE = /^https:\/\/[^\s"'<>]+$/
  function tiles(src) {
    const html = lines(src).map(line => {
      const [title = '', ...rest] = cells(line)
      const pic = rest.find(r => PICTURE.test(r))
      const note = rest.filter(r => r !== pic).join(' · ')
      return `<button class="tile" type="button" data-tile="${esc(tileKey(title))}">${pic ? `<img src="${esc(pic)}" alt="" loading="lazy">` : ''}`
        + `<b>${inline(title)}</b>${note ? `<span>${inline(note)}</span>` : ''}</button>`
    })
    return `<div class="tiles">${html.join('')}</div>`
  }

  /** "🏛️ **AI Governance** Bill" and "AI governance bill" are the same tile. */
  function tileKey(title) {
    return String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  }

  /** Takes each tile's "### Title" section out of the answer: { main, details: { key: markdown } }.
   *  A section runs to the next heading of level 1 to 3, or a --- line. */
  function tileDetails(markdown) {
    const src = String(markdown).replace(/\r\n/g, '\n').split('\n')
    const keys = new Set()
    let fence = null
    for (const [i, line] of src.entries()) {
      const f = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line)
      if (fence) { if (f && line.trim().replaceAll(fence[0], '') === '') fence = null; continue }
      if (!f) continue
      fence = f[1]
      if (f[2].toLowerCase() !== 'tiles') continue
      for (let j = i + 1; j < src.length && !src[j].trim().startsWith(fence); j++) if (src[j].trim()) keys.add(tileKey(cells(src[j])[0]))
    }
    const main = []
    const details = {}
    let into = null
    fence = null
    for (const line of src) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence) { if (f && line.trim().replaceAll(fence[0], '') === '') fence = null }
      else if (f) fence = f[1]
      else {
        const h = /^(#{1,3})\s+(.+)$/.exec(line)
        if (h || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          const key = h && h[1].length === 3 && tileKey(h[2])
          into = key && keys.has(key) && !(key in details) ? key : null
          if (into) { details[into] = []; continue }
        }
      }
      ;(into ? details[into] : main).push(line)
    }
    for (const k in details) details[k] = details[k].join('\n').trim()
    return { main: main.join('\n'), details }
  }

  const BLOCKS = { mermaid, stats, options, steps, wireframe, design, tiles }

  /** HTML for a fenced block we draw, or null to leave it as code. */
  function code(src, lang) {
    const fn = BLOCKS[String(lang ?? '').trim().toLowerCase()]
    return fn ? fn(src) : null
  }

  const CALLOUT = { tldr: ['tldr', 'i', 'In short'], note: ['tldr', 'i', 'Note'], tip: ['tip', '✓', 'Tip'], warning: ['warn', '!', 'Watch out'], caution: ['warn', '!', 'Watch out'], decide: ['decide', '?', 'Your call'] }

  /** A rendered blockquote starting with [!TYPE] becomes a callout box, or null. */
  function blockquote(html) {
    const m = /^\s*<p>\s*\[!(\w+)\]\s*/i.exec(html)
    const kind = m && CALLOUT[m[1].toLowerCase()]
    if (!kind) return null
    let body = '<p>' + html.slice(m[0].length)
    body = body.replace(/^<p>\s*<\/p>/, '')
    if (kind[0] === 'decide') body = body.replace(/<ul>([\s\S]*?)<\/ul>/g, (_, li) => `<div class="choices">${li.replace(/<li>([\s\S]*?)<\/li>/g, '<span class="chip">$1</span>')}</div>`)
    return `<div class="callout c-${kind[0]}"><div class="ic">${kind[1]}</div><div><b class="t">${kind[2]}</b>${body}</div></div>`
  }

  /** Hooks the blocks into a marked instance (v12 renderer API). */
  function useWith(marked) {
    inline = s => marked.parseInline(String(s))
    marked.use({
      renderer: {
        code(src, lang) { return code(src, lang) ?? false },
        blockquote(html) { return blockquote(html) ?? false },
      },
    })
  }

  globalThis.handfreeBlocks = { code, blockquote, useWith, tileKey, tileDetails }
})()
