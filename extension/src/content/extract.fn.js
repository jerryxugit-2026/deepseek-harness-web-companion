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
   *      (category tags, breadcrumbs, "SKILL.md / Files / Versions" tabs);
   *   B. action labels: an exact-match allowlist of UI verbs;
   *   C. trailing meta blocks: download counts, "Last updated …", version/license
   *      lines near the end of the document.
   */
  const text = (el) => String(el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const sentences = (value) => /[。．.!?；;：:]|\s\S{40,}/u.test(value)

  const stripChipRows = () => {
    for (const parent of [...clone.querySelectorAll('*')]) {
      const kids = [...parent.children]
      if (kids.length < 3) continue
      const leafish = kids.filter((kid) => {
        const value = text(kid)
        return value !== '' && value.length <= 24 && !sentences(value) && kid.children.length <= 1
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

  const applied = []
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
          const href = absolute(node.getAttribute('href') ?? '')
          const text = String(node.innerText ?? '').trim()
          out.push(text === '' ? '' : `[${text}](${href})`); break
        }
        case 'img': {
          const src = node.getAttribute('src')
          out.push(src === null ? '' : `![${node.getAttribute('alt') ?? ''}](${absolute(src)})`); break
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
  const selection = String(window.getSelection() ?? '').trim()
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
      markdown: markdown.length > maxChars ? markdown.slice(0, maxChars) : markdown,
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
