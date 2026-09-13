/**
 * Page extraction, injected into the page's MAIN world by the service worker.
 *
 * Must be SELF-CONTAINED: `chrome.scripting.executeScript({ func })` serialises
 * this function, so it cannot reference any module-scope binding. It returns
 * plain data — title, url, metadata and a cleaned-up Markdown body — never DOM.
 */
export function extractPage(options = {}) {
  const maxChars = typeof options.maxChars === 'number' ? options.maxChars : 120000
  /*
   * ★ `form` **不在**这个列表里（2026-09-13 修）。
   *
   * 原来这里是 `...,form,iframe,...` —— 把整类 `<form>` 当噪音删掉。后果：**正文本身就是表单的页面
   * 抓出来是空的**。实测两次：`github.com/new`（建仓库）与 `github.com/settings/ssh/new`（加 SSH key），
   * 落盘文件里只有 front-matter，正文 0 行。
   *
   * 为什么当初会写进去：搜索框 / 订阅框这类"表单"确实该清。但那应该按**大小/形态**判，
   * 不该按标签名整类删 —— 见下面的 `stripSmallForms()`：只清"文字很少"的表单，
   * 保留真正的表单页（设置页、建仓页、结算页…）。
   */
  const NOISE = 'script,style,noscript,svg,canvas,nav,footer,header,aside,iframe,[aria-hidden="true"],[role="navigation"],[role="banner"],[role="contentinfo"],.ad,.ads,.advert,.cookie,.newsletter'
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
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu, '')
    // 行/段分隔符**不是**零宽字符：它们是换行，删掉会把两段粘成一段（审核 2026-09-12）。
    .replace(/[\u2028\u2029]/gu, '\n')
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

  /**
   * Chips are labels; anything longer is treated as content (see the note above).
   *
   * 注意：这个阈值**不是**"短链接保护机制"。审核 2026-09-12 指出注释曾暗示把阈值从 24 降到 12
   * 是为了保住 `[Go]` / `doc/2` 这类真实短链接 —— 但那些只有 4–5 个字符，本来就在任何阈值之下；
   * 真正保住它们的是 `stripPlaceholderAnchors` 里那条"会跳转到别处就不算占位锚点"的判据。
   */
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

  const ACTION_LABELS = /^(read more|load more|show more|show less|see more|view all|more|report|share|copy|copy link|copy code|download|stats & details|stats and details|files|versions|skill card|overview|details)$/iu
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
      // 判据：**上方 META_BLOCK 已命中**（含 downloads / last updated / license 这类词），且这一段
      // "像标签而不像句子"——短、无句末标点。这里原来还有一条数字判据 `digitRatio > 0.15`，但它被
      // 同一个 `||` **完全架空**（右边那支几乎恒真），注释却声称"只在以数字为主时才删"，代码与注释
      // 相反；数字判据已删（从未起作用），阈值从 80 收到 40（80 字符能装下一整句英文说明）。
      // 审核 2026-09-12 指出，我在此逐字核实。
      if (/^[^。.!?]{0,40}$/u.test(value)) el.remove()
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
      // `#`、`#fragment`，或"本页 + fragment"（即一次没有实际跳转的导航）。
      //
      // 旧实现拿字符串 `startsWith` 比：`location.href` 带 query 时比不中（**漏判**占位锚点），
      // 而当 `location.href` 恰好就是链接目标时又会把**有效**的同页锚删掉（**误删**）。改成比较
      // 去掉 fragment/query 之后的文档地址，两端一致才算"本页"。（审核 2026-09-12）
      const baseOf = (url) => String(url).split('#')[0].split('?')[0]
      const isBareAnchor = /^#/u.test(href) || (href !== '' && /#$/u.test(href) && baseOf(href) === baseOf(location.href))
      if (!isBareAnchor) continue
      // keep the item when it carries real text beyond the placeholder link
      if (text(item).replace(label, '').trim() !== '') continue
      item.remove()
    }
  }

  /**
   * E. **小表单**（2026-09-13 新增，替代"整类删掉 `<form>`"）。
   *
   * 搜索框 / 订阅框 / 登录小挂件都是表单，该清；但**正文本身就是表单的页面**（建仓页、设置页、
   * 结算页）整类删掉就什么都不剩 —— `github.com/new` 与 `/settings/ssh/new` 实测抓成空文件。
   *
   * 判据故意**只看可见文字量**：搜索框的文字通常只有 "Search" 一两个词
   * （占位符不算 textContent），订阅框是 "Email / Subscribe"；而真正的表单页满屏标签与说明。
   * 阈值 120 给足了余量，且**不看 title/placeholder**（那些不是页面正文）。
   */
  const SMALL_FORM_MAX = 120
  const stripSmallForms = () => {
    for (const form of [...clone.querySelectorAll('form')]) {
      if (text(form).length <= SMALL_FORM_MAX) form.remove()
    }
  }

  const applied = []
  if (options.stripPlaceholderAnchors !== false) { stripPlaceholderAnchors(); applied.push('placeholder-anchors') }
  if (options.stripChipRows !== false) { stripChipRows(); applied.push('chip-rows') }
  if (options.stripActionLabels !== false) { stripActionLabels(); applied.push('action-labels') }
  if (options.stripTrailingMeta !== false) { stripTrailingMeta(); applied.push('trailing-meta') }
  if (options.stripSmallForms !== false) { stripSmallForms(); applied.push('small-forms') }

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
        case 'blockquote': {
          // A lone `>` followed by a blank line is NOT a quote: renderers show an
          // empty quote and the text as a normal paragraph (measured 2026-09-11 on
          // the news fixture). Emit real quote syntax: prefix every line, and keep
          // the blank separator lines prefixed too, so multi-paragraph quotes stay
          // one quote block.
          const before = out.length
          inner()
          const quoted = out.splice(before).join('')
            .split('\n')
            .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
            .join('\n')
            // collapse the quote's own leading/trailing blank lines
            .replace(/^(?:>\n)+/u, '')
            .replace(/(?:\n>)+$/u, '')
          out.push(`\n\n${quoted === '' ? '>' : quoted}\n\n`)
          break
        }
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
