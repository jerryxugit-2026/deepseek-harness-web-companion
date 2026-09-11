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
    },
  }
}
