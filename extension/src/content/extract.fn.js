/**
 * Page extraction, injected into the page's MAIN world by the service worker.
 *
 * Must be SELF-CONTAINED: `chrome.scripting.executeScript({ func })` serialises
 * this function, so it cannot reference any module-scope binding. It returns
 * plain data — title, url, metadata and a cleaned-up Markdown body — never DOM.
 */
export function extractPage(options = {}) {
  const maxChars = typeof options.maxChars === 'number' ? options.maxChars : 120000
  const NOISE = 'script,style,noscript,svg,canvas,nav,footer,header,aside,form,iframe,[aria-hidden="true"],[role="navigation"],[role="banner"],[role="contentinfo"],.ad,.ads,.advert,.cookie,.newsletter'
  const absolute = (href) => { try { return new URL(href, location.href).href } catch { return href } }

  /**
   * Only keep link/image URLs an agent can actually use: `javascript:`,
   * `vbscript:`, `file:` and bare `data:` payloads are dropped (a page must not
   * be able to smuggle an executable URL into the workspace file), while
   * `data:image/*` stays for inline images.
   */
  const safeUrl = (raw, kind) => {
    const value = String(raw ?? '').trim()
    if (value === '') return ''
    const lower = value.toLowerCase()
    if (lower.startsWith('data:')) return kind === 'image' && lower.startsWith('data:image/') ? value : ''
    if (/^(https?:|mailto:|tel:)/u.test(lower)) return absolute(value)
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('file:') || lower.startsWith('blob:')) return ''
    return absolute(value)
  }

  /** Invisible/zero-width characters are a prompt-injection vector; strip them. */
  const clean = (value) => String(value)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu, '')
    .replace(/\u00A0/gu, ' ')

  /** Root element holding the main content, if the site marks one. */
  const pickRoot = () => {
    for (const selector of ['article', 'main', '[role="main"]', '#content', '.post', '.article']) {
      const el = document.querySelector(selector)
      if (el !== null && (el.innerText ?? '').trim().length > 200) return el
    }
    return document.body
  }

  const root = pickRoot()
  const clone = root.cloneNode(true)
  for (const node of clone.querySelectorAll(NOISE)) node.remove()

  /**
   * UI-noise heuristics (agreed 2026-09-11 after real-site findings).
   *
   * Real pages leak interface chrome that lives inside the main content region
   * (category chips, tab strips, "Read more", trailing stats blocks), so the tag
   * list above cannot catch it. Three conservative, individually switchable
   * rules — all measured against the ClawHub page and the fixture:
   *
   *   A. chip rows: 3+ sibling leaf elements whose text is short and unpunctuated
   *      (category tags, breadcrumbs, "SKILL.md / Files / Versions" tabs). The
   *      length bound is 12 characters on purpose: at 24 it also swallowed the
   *      short-labelled items of a real link list (measured 2026-09-11 with the
   *      fixture's `[Go]` / `doc/2` items). Longer labels are content links; the
   *      tab-strip case is still covered by rule B's explicit allowlist;
   *   B. action labels: an exact-match allowlist of UI verbs;
   *   C. trailing meta blocks: download counts, "Last updated …", version/license
   *      lines near the end of the document.
   *   D. placeholder anchors (v3.29): a list item whose whole link text is 1–2
   *      characters AND whose href is a bare in-page anchor (`#` / same-page `#x`).
   *      Found in a real capture (apexnc.org): two `- [A](…#)` lines sitting above
   *      the real content. Deliberately narrow — it does NOT touch short real
   *      labels ("Home") or any link that navigates somewhere.
   */
  const text = (el) => String(el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const sentences = (value) => /[。．.!?；;：:]|\s\S{40,}/u.test(value)

  /** Chips are labels; anything longer is treated as content (see the note above). */
  const CHIP_LABEL_MAX = 12
  const stripChipRows = () => {
    for (const parent of [...clone.querySelectorAll('*')]) {
      const kids = [...parent.children]
      if (kids.length < 3) continue
      const leafish = kids.filter((kid) => {
        const value = text(kid)
        return value !== '' && value.length <= CHIP_LABEL_MAX && !sentences(value) && kid.children.length <= 1
      })
      // a row where *most* children are short unpunctuated labels is a chip/tab strip
      if (leafish.length >= 3 && leafish.length >= kids.length - 1) {
        for (const kid of leafish) kid.remove()
      }
    }
  }

  const ACTION_LABELS = /^(read more|show more|show less|see more|view all|more|report|share|copy|copy link|copy code|download|stats & details|stats and details|files|versions|skill card|overview|details)$/iu
  const stripActionLabels = () => {
    for (const el of [...clone.querySelectorAll('button, a, span, div')]) {
      if (el.children.length > 0) continue
      if (ACTION_LABELS.test(text(el))) el.remove()
    }
  }

  const META_BLOCK = /(downloads?\b|last updated|current version|license\b|updated \d+\w+ ago)/iu
  const stripTrailingMeta = () => {
    const all = [...clone.querySelectorAll('p, div, section, ul, span')]
    const tail = all.slice(Math.floor(all.length * 0.7))
    for (const el of tail) {
      const value = text(el)
      if (value === '' || value.length > 400) continue
      if (!META_BLOCK.test(value)) continue
      // only drop when the block is mostly numbers/labels, not prose
      const digitRatio = (value.match(/[\d.]+/gu) ?? []).join('').length / Math.max(1, value.length)
      if (digitRatio > 0.15 || /^[^。.!?]{0,80}$/u.test(value)) el.remove()
    }
  }

  const stripPlaceholderAnchors = () => {
    for (const item of [...clone.querySelectorAll('li, p, div, span')]) {
      if (item.children.length > 1) continue
      const links = [...item.querySelectorAll('a')]
      if (links.length !== 1) continue
      const link = links[0]
      const label = text(link)
      if (label.length === 0 || label.length > 2) continue
      const href = String(link.getAttribute('href') ?? '').trim()
      // `#`, `#fragment`, or the same document with a fragment: a no-op navigation
      const isBareAnchor = /^#/u.test(href) || (href !== '' && href.startsWith('#') === false && /#$/u.test(href) && href.split('#')[0].startsWith(location.href.split('#')[0]))
      if (!isBareAnchor) continue
      // keep the item when it carries real text beyond the placeholder link
      if (text(item).replace(label, '').trim() !== '') continue
      item.remove()
    }
  }

  const applied = []
  if (options.stripPlaceholderAnchors !== false) { stripPlaceholderAnchors(); applied.push('placeholder-anchors') }
  if (options.stripChipRows !== false) { stripChipRows(); applied.push('chip-rows') }
  if (options.stripActionLabels !== false) { stripActionLabels(); applied.push('action-labels') }
  if (options.stripTrailingMeta !== false) { stripTrailingMeta(); applied.push('trailing-meta') }

  /** Convert one subtree to Markdown (single pass, explicit node walk). */
  const toMarkdown = (el) => {
    const out = []
    const walk = (node, listDepth) => {
      if (node.nodeType === 3) {
        const text = String(node.textContent).replace(/\s+/g, ' ')
        if (text.trim() !== '') out.push(text)
        return
      }
      if (node.nodeType !== 1) return
      const tag = node.tagName.toLowerCase()
      if (tag === 'br') { out.push('\n'); return }
      const inner = () => { for (const child of node.childNodes) walk(child, listDepth) }
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          out.push(`\n\n${'#'.repeat(Number(tag[1]))} `); inner(); out.push('\n\n'); break
        case 'p': out.push('\n\n'); inner(); out.push('\n\n'); break
        case 'li': out.push(`\n${'  '.repeat(listDepth)}- `); inner(); break
        case 'ul': case 'ol':
          out.push('\n')
          for (const child of node.children) walk(child, listDepth + 1)
          out.push('\n'); break
        case 'pre': {
          const code = node.querySelector('code')
          const lang = code?.className?.match(/language-([\w-]+)/u)?.[1] ?? ''
          out.push(`\n\n\`\`\`${lang}\n${String(node.innerText).trimEnd()}\n\`\`\`\n\n`); break
        }
        case 'code': out.push(`\`${String(node.innerText)}\``); break
        case 'blockquote': out.push('\n\n> '); inner(); out.push('\n\n'); break
        case 'a': {
          const href = safeUrl(node.getAttribute('href'), 'link')
          const text = clean(String(node.innerText ?? '').trim())
          out.push(text === '' || href === '' ? text : `[${text}](${href})`); break
        }
        case 'img': {
          const src = safeUrl(node.getAttribute('src'), 'image')
          out.push(src === '' ? '' : `![${clean(node.getAttribute('alt') ?? '')}](${src})`); break
        }
        case 'strong': case 'b': out.push('**'); inner(); out.push('**'); break
        case 'em': case 'i': out.push('*'); inner(); out.push('*'); break
        case 'table': {
          out.push('\n\n')
          ;[...node.querySelectorAll('tr')].forEach((row, index) => {
            const cells = [...row.children].map((cell) => String(cell.innerText ?? '').replace(/\s+/g, ' ').trim())
            out.push(`| ${cells.join(' | ')} |\n`)
            if (index === 0) out.push(`| ${cells.map(() => '---').join(' | ')} |\n`)
          })
          out.push('\n'); break
        }
        default: inner()
      }
    }
    for (const child of el.childNodes) walk(child, 0)
    return out.join('').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/gu, '\n').trim()
  }

  const markdown = toMarkdown(clone)
  const selection = clean(String(window.getSelection() ?? '')).trim()
  const metaOf = (name, attr = 'name') => document.querySelector(`meta[${attr}="${name}"]`)?.getAttribute('content') ?? null

  return {
    page: {
      title: document.title || location.hostname,
      url: location.href,
      domain: location.hostname,
      capturedAt: Date.now(),
      hasVideo: document.querySelector('video') !== null,
    },
    content: {
      markdown: (() => {
        const cleaned = clean(markdown)
        return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
      })(),
      truncated: markdown.length > maxChars,
      ...(selection === '' ? {} : { selection: { text: selection.slice(0, 20000) } }),
    },
    meta: {
      description: metaOf('description'),
      ogTitle: metaOf('og:title', 'property'),
      lang: document.documentElement.lang || null,
      headings: [...clone.querySelectorAll('h1,h2,h3')].slice(0, 20).map((h) => String(h.innerText).trim()).filter((t) => t !== ''),
      chars: markdown.length,
      cleaner: applied.length,
    },
  }
}
