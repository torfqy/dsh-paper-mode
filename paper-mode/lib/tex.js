/**
 * LaTeX prose segmentation for the bilingual (EN -> ZH) typeset twin.
 *
 * The pipeline never translates a PDF. It walks the LaTeX source, finds the
 * natural-language runs, replaces every atomic inline construct (math, cites,
 * refs, labels, urls, graphics, line breaks) with a `<<n>>` placeholder, sends
 * only the prose to the model, and splices the translated prose back into the
 * original source. The Chinese document is then typeset from that source, so
 * equations, cross-references, figures and float placement stay byte-identical
 * to the English build.
 *
 * @module @local/dsh-paper-mode/lib/tex
 */

/** Environments copied verbatim: their bodies are code, not prose. */
const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'alltt',
])

/** Display-math environments copied verbatim. */
const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*',
  'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math', 'eqnarray', 'eqnarray*',
  'split', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'array', 'subequations',
])

/** Environments whose bodies are unstructured data or drawings: copy verbatim. */
const OPAQUE_ENVS = new Set([
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable', 'tikzpicture', 'picture',
  'pspicture', 'filecontents', 'filecontents*', 'thebibliography',
])

/** Commands whose single mandatory argument is a translatable title/caption. */
const TITLE_CMDS = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
  'caption', 'captionof', 'title', 'subtitle', 'subject',
])

/** Block-level commands: flush the current run, keep the command and its arguments. */
const BLOCK_CMDS = new Set([
  'item', 'maketitle', 'newpage', 'clearpage', 'cleardoublepage', 'par', 'centering',
  'raggedright', 'raggedleft', 'noindent', 'indent', 'smallskip', 'medskip', 'bigskip',
  'vfill', 'hfill', 'hrule', 'hline', 'toprule', 'midrule', 'bottomrule', 'cline',
  'documentclass', 'usepackage', 'RequirePackage', 'bibliographystyle', 'bibliography',
  'addbibresource', 'printbibliography', 'tableofcontents', 'listoffigures', 'listoftables',
  'appendix', 'frontmatter', 'mainmatter', 'backmatter', 'abstract', 'keywords',
  'setlength', 'addtolength', 'setcounter', 'renewcommand', 'newcommand', 'providecommand',
  'def', 'let', 'pagestyle', 'thispagestyle', 'pagenumbering', 'graphicspath', 'input',
  'include', 'includeonly', 'geometry', 'hypersetup', 'crefname', 'Crefname',
])

/** Commands that only wrap prose: keep the command, translate the inner text. */
const WRAPPER_CMDS = new Set([
  'textbf', 'textit', 'textsl', 'textsc', 'texttt', 'textrm', 'textsf', 'textnormal', 'textup',
  'emph', 'underline', 'uline', 'uuline', 'sout', 'mbox', 'makebox', 'text', 'hbox', 'fbox',
  'textsuperscript', 'textsubscript', 'footnote', 'footnotetext', 'enquote', 'say', 'so',
  'MakeUppercase', 'MakeLowercase', 'uppercase', 'lowercase', 'hphantom', 'phantom',
])

/** Commands whose FIRST argument is not prose (a URL, a colour, a language). */
const FIRST_ARG_OPAQUE = new Set(['href', 'hyperlink', 'textcolor', 'colorbox', 'fcolorbox', 'foreignlanguage'])

/** Inline commands that are opaque atoms: the whole call becomes one placeholder. */
const ATOMIC_CMDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar', 'parencite',
  'textcite', 'autocite', 'footcite', 'supercite', 'nocite',
  'ref', 'eqref', 'autoref', 'Autoref', 'cref', 'Cref', 'nameref', 'vref', 'pageref', 'label',
  'url', 'nolinkurl', 'includegraphics', 'includesvg', 'input', 'include',
  'hspace', 'vspace', 'color', 'textwidth', 'linewidth', 'columnwidth', 'rule', 'raisebox',
  'small', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'tiny', 'normalsize', 'footnotesize',
  'bfseries', 'itshape', 'mdseries', 'rmfamily', 'sffamily', 'ttfamily', 'scshape', 'upshape',
  'centering', 'vskip', 'hskip', 'kern', 'quad', 'qquad', 'thinspace', 'enspace',
])

/** Placeholder pattern used in prose handed to the model. */
const PLACEHOLDER = /<<(\d+)>>/g

/** Read a control sequence starting at `i` (which points at the backslash). */
function readCommand(s, i) {
  let j = i + 1
  if (j >= s.length) return { name: '', end: j, single: false }
  if (/[A-Za-z@]/.test(s[j])) {
    while (j < s.length && /[A-Za-z@]/.test(s[j])) j += 1
    return { name: s.slice(i + 1, j), end: j, single: false }
  }
  return { name: s[j], end: j + 1, single: true }
}

/** Skip a balanced `{...}` group; returns the index just past the closing brace. */
function skipGroup(s, i) {
  let depth = 0
  for (let j = i; j < s.length; j += 1) {
    const c = s[j]
    if (c === '\\') { j += 1; continue }
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return j + 1 }
  }
  return s.length
}

/** Skip a balanced `[...]` group; returns the index just past the closing bracket. */
function skipBracket(s, i) {
  let depth = 0
  for (let j = i; j < s.length; j += 1) {
    const c = s[j]
    if (c === '\\') { j += 1; continue }
    if (c === '[') depth += 1
    else if (c === ']') { depth -= 1; if (depth === 0) return j + 1 }
  }
  return s.length
}

/** Skip whitespace (including at most one newline run). */
function skipSpaces(s, i) {
  let j = i
  while (j < s.length && /\s/.test(s[j])) j += 1
  return j
}

/** Read the `{...}` group that starts at or after `i`; undefined when absent. */
function readGroup(s, i) {
  const at = skipSpaces(s, i)
  if (s[at] !== '{') return undefined
  const end = skipGroup(s, at)
  return { contentStart: at + 1, contentEnd: Math.max(at + 1, end - 1), end }
}

/** Skip a `$...$` or `$$...$$` span; returns the index just past it. */
function skipMath(s, i) {
  if (s[i + 1] === '$') {
    const close = s.indexOf('$$', i + 2)
    return close < 0 ? s.length : close + 2
  }
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue }
    if (s[j] === '$') return j + 1
    j += 1
  }
  return s.length
}

/** Find `\end{env}` matching a `\begin{env}` at `from`, honouring nesting. */
function findEnvEnd(s, from, env) {
  const open = `\\begin{${env}}`
  const close = `\\end{${env}}`
  let depth = 1
  let i = from
  while (i < s.length) {
    const nextOpen = s.indexOf(open, i)
    const nextClose = s.indexOf(close, i)
    if (nextClose < 0) return s.length
    if (nextOpen >= 0 && nextOpen < nextClose) { depth += 1; i = nextOpen + open.length; continue }
    depth -= 1
    i = nextClose + close.length
    if (depth === 0) return i
  }
  return s.length
}

/**
 * Build the tokeniser state shared by both scanners.
 * @returns {{tokens: string[], add: (raw: string) => string, restore: (s: string) => string}}
 */
function createTokens() {
  const tokens = []
  return {
    tokens,
    add(raw) {
      tokens.push(raw)
      return `<<${tokens.length - 1}>>`
    },
    restore(text) {
      return text.replace(PLACEHOLDER, (all, n) => tokens[Number(n)] ?? all)
    },
  }
}

/**
 * Protect every atomic inline construct of one raw run.
 * Wrapper commands keep their shape, so the model still sees `\textbf{...}`
 * and translates the words inside it.
 * @param raw - one contiguous source run.
 * @param tk - tokeniser state.
 * @returns the protected text.
 */
function protectInline(raw, tk) {
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]

    if (ch === '$') {
      const end = skipMath(raw, i)
      out += tk.add(raw.slice(i, end))
      i = end
      continue
    }

    if (ch === '\\') {
      const cmd = readCommand(raw, i)

      if (cmd.single) {
        if (cmd.name === '(' || cmd.name === '[') {
          const closer = cmd.name === '(' ? '\\)' : '\\]'
          const at = raw.indexOf(closer, cmd.end)
          const end = at < 0 ? raw.length : at + 2
          out += tk.add(raw.slice(i, end))
          i = end
          continue
        }
        if (cmd.name === '\\') {
          let end = cmd.end
          const at = skipSpaces(raw, end)
          if (raw[at] === '[') end = skipBracket(raw, at)
          out += tk.add(raw.slice(i, end))
          i = end
          continue
        }
        // Escaped literal (\%, \&, \_, \#, \$) survives translation unchanged.
        out += raw.slice(i, cmd.end)
        i = cmd.end
        continue
      }

      let end = cmd.end
      if (raw[end] === '*') end += 1

      if (FIRST_ARG_OPAQUE.has(cmd.name)) {
        const first = readGroup(raw, end)
        if (!first) { out += tk.add(raw.slice(i, end)); i = end; continue }
        out += tk.add(raw.slice(i, first.end))
        const second = readGroup(raw, first.end)
        if (second) {
          out += '{' + protectInline(raw.slice(second.contentStart, second.contentEnd), tk) + '}'
          end = second.end
        } else {
          end = first.end
        }
        i = end
        continue
      }

      if (WRAPPER_CMDS.has(cmd.name)) {
        const group = readGroup(raw, end)
        if (!group) { out += tk.add(raw.slice(i, end)); i = end; continue }
        out += raw.slice(i, group.contentStart)
        out += protectInline(raw.slice(group.contentStart, group.contentEnd), tk)
        out += '}'
        i = group.end
        continue
      }

      // Balanced argument tail: [opt]{arg}{arg}...
      for (;;) {
        const at = skipSpaces(raw, end)
        if (raw[at] === '[') { end = skipBracket(raw, at); continue }
        if (raw[at] === '{') { end = skipGroup(raw, at); continue }
        break
      }
      out += tk.add(raw.slice(i, end))
      i = end
      continue
    }

    out += ch
    i += 1
  }
  return out
}

/**
 * Tokenise one LaTeX file into keep-pieces and translatable pieces.
 * @param src - the whole file.
 * @returns `{ pieces, tokens }`; `pieces` reproduces `src` when concatenated.
 */
export function parseTex(src) {
  const tk = createTokens()
  const pieces = []
  let i = 0
  let buf = ''
  let open = false

  const pushKeep = (text) => { if (text) pieces.push({ type: 'keep', text }) }
  const startBuf = () => { if (!open) { buf = ''; open = true } }
  const flush = () => {
    if (!open) return
    const raw = buf
    buf = ''
    open = false
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)
    if (!match) { pushKeep(raw); return }
    const lead = match[1]
    const core = match[2]
    const trail = match[3]
    if (lead) pushKeep(lead)
    if (core) {
      const bare = core.replace(PLACEHOLDER, '')
      const prose = /[A-Za-z\u4e00-\u9fff]/.test(bare) && /\s/.test(bare)
      // Single-word runs are still worth translating (headings, captions).
      const word = bare.replace(/[\s.,;:!?'"()\-–—]/g, '').length >= 2 && /[A-Za-z\u4e00-\u9fff]/.test(bare)
      if (prose || word) {
        pieces.push({ type: 'tr', id: pieces.length, text: core, raw: tk.restore(core) })
      } else {
        pushKeep(tk.restore(core))
      }
    }
    if (trail) pushKeep(trail)
  }

  while (i < src.length) {
    const ch = src[i]

    if (ch === '%') {
      flush()
      const nl = src.indexOf('\n', i)
      const end = nl < 0 ? src.length : nl + 1
      pushKeep(src.slice(i, end))
      i = end
      continue
    }

    if (ch === '$') {
      startBuf()
      const end = skipMath(src, i)
      buf += tk.add(src.slice(i, end))
      i = end
      continue
    }

    if (ch === '\\') {
      const cmd = readCommand(src, i)

      if (cmd.single) {
        startBuf()
        if (cmd.name === '(' || cmd.name === '[') {
          const closer = cmd.name === '(' ? '\\)' : '\\]'
          const at = src.indexOf(closer, cmd.end)
          const end = at < 0 ? src.length : at + 2
          buf += tk.add(src.slice(i, end))
          i = end
          continue
        }
        buf += tk.add(src.slice(i, cmd.end))
        i = cmd.end
        continue
      }

      let after = cmd.end
      if (src[after] === '*') after += 1

      if (cmd.name === 'begin' || cmd.name === 'end') {
        const group = readGroup(src, after)
        const env = group ? src.slice(group.contentStart, group.contentEnd).trim() : ''
        const end = group ? group.end : after
        if (cmd.name === 'begin' && (VERBATIM_ENVS.has(env) || MATH_ENVS.has(env) || OPAQUE_ENVS.has(env))) {
          flush()
          const stop = findEnvEnd(src, end, env)
          pushKeep(src.slice(i, stop))
          i = stop
          continue
        }
        flush()
        pushKeep(src.slice(i, end))
        i = end
        continue
      }

      if (TITLE_CMDS.has(cmd.name)) {
        flush()
        let head = after
        const at = skipSpaces(src, head)
        if (src[at] === '[') {
          head = skipBracket(src, at)
        }
        const group = readGroup(src, head)
        pushKeep(src.slice(i, group ? group.contentStart : head))
        if (group) {
          const inner = src.slice(group.contentStart, group.contentEnd)
          const protectedText = protectInline(inner, tk)
          if (/[A-Za-z\u4e00-\u9fff]/.test(inner)) {
            pieces.push({ type: 'tr', id: pieces.length, text: protectedText, raw: inner })
          } else {
            pushKeep(inner)
          }
          pushKeep('}')
          i = group.end
        } else {
          i = head
        }
        continue
      }

      if (BLOCK_CMDS.has(cmd.name)) {
        flush()
        let end = after
        for (;;) {
          const at = skipSpaces(src, end)
          if (src[at] === '[') { end = skipBracket(src, at); continue }
          if (src[at] === '{') { end = skipGroup(src, at); continue }
          break
        }
        pushKeep(src.slice(i, end))
        i = end
        continue
      }

      if (WRAPPER_CMDS.has(cmd.name) || FIRST_ARG_OPAQUE.has(cmd.name)) {
        startBuf()
        const group = readGroup(src, after)
        if (!group) {
          buf += tk.add(src.slice(i, after))
          i = after
          continue
        }
        buf += src.slice(i, group.contentStart)
        buf += protectInline(src.slice(group.contentStart, group.contentEnd), tk)
        buf += '}'
        i = group.end
        continue
      }

      // Everything else is an opaque atom, inline or block depending on context.
      startBuf()
      let end = after
      for (;;) {
        const at = skipSpaces(src, end)
        if (src[at] === '[') { end = skipBracket(src, at); continue }
        if (src[at] === '{') { end = skipGroup(src, at); continue }
        break
      }
      buf += tk.add(src.slice(i, end))
      i = end
      continue
    }

    if (ch === '\n') {
      startBuf()
      buf += ch
      i += 1
      if (/^[ \t]*\n/.test(src.slice(i))) flush()
      continue
    }

    startBuf()
    buf += ch
    i += 1
  }

  flush()
  return { pieces, tokens: tk.tokens }
}

/**
 * Rebuild a translated file: keep-pieces verbatim, translated pieces spliced in
 * with their placeholders restored.
 * @param pieces - from `parseTex`.
 * @param translations - id -> translated (still protected) text.
 * @returns the Chinese source, or the original text for untranslated pieces.
 */
export function rebuildTex(pieces, translations) {
  return pieces.map((piece) => {
    if (piece.type !== 'tr') return piece.text
    const next = translations[piece.id]
    return typeof next === 'string' && next.trim() ? next : piece.raw
  }).join('')
}

/**
 * Replace `<<n>>` placeholders with the constructs they stand for.
 * @param text - a translated, still-protected fragment.
 * @param tokens - the token table `parseTex` returned.
 */
export function restorePlaceholders(text, tokens) {
  return text.replace(PLACEHOLDER, (all, n) => tokens[Number(n)] ?? all)
}

/**
 * Multiset signature used to reject a model answer that dropped or invented
 * LaTeX constructs or placeholders.
 * @param text - protected prose.
 */
export function signature(text) {
  const commands = new Map()
  const tokens = new Map()
  const cmds = text.match(/\\[A-Za-z@]+/g) || []
  for (const one of cmds) commands.set(one, (commands.get(one) || 0) + 1)
  const refs = text.match(PLACEHOLDER) || []
  for (const one of refs) tokens.set(one, (tokens.get(one) || 0) + 1)
  let braces = 0
  for (const ch of text) {
    if (ch === '{') braces += 1
    else if (ch === '}') braces -= 1
  }
  return { commands, tokens, braces }
}

/** Compare two signatures; returns a short reason when they disagree. */
export function signatureProblem(before, after) {
  const diff = (a, b, label) => {
    const keys = new Set([...a.keys(), ...b.keys()])
    for (const key of keys) {
      if ((a.get(key) || 0) !== (b.get(key) || 0)) {
        return `${label} changed: ${key} (${a.get(key) || 0} -> ${b.get(key) || 0})`
      }
    }
    return ''
  }
  return diff(before.tokens, after.tokens, 'placeholder')
    || diff(before.commands, after.commands, 'command')
    || (before.braces !== after.braces ? `brace balance changed (${before.braces} -> ${after.braces})` : '')
}

/** CJK font families that ship with each desktop, used by the xeCJK variant. */
const CJK_FONT_SETS = {
  win32: { main: 'SimSun', sans: 'SimHei', mono: 'FangSong' },
  darwin: { main: 'Songti SC', sans: 'Heiti SC', mono: 'STFangsong' },
  linux: { main: 'Noto Serif CJK SC', sans: 'Noto Sans CJK SC', mono: 'Noto Sans Mono CJK SC' },
}

/** Sentinels around the generated preamble, so a retry can swap it in place. */
export const CJK_BEGIN = '% >>> paper-mode: generated CJK preamble >>>'
export const CJK_END = '% <<< paper-mode: generated CJK preamble <<<'

/** Variants tried in order until one compiles. */
export const CJK_VARIANTS = [
  { id: 'xecjk' },
  { id: 'ctex' },
  { id: 'ctex-windows' },
]

/**
 * Build one CJK preamble block.
 *
 * `xecjk` uses the desktop's own Chinese fonts; the ctex variants fall back to
 * the Fandol fonts that ship with TeX Live and MiKTeX, so a machine without any
 * Chinese font still typesets.
 * @param id - one of `CJK_VARIANTS[].id`.
 */
export function cjkBlock(id) {
  if (id === 'ctex') return '\\usepackage[UTF8,heading=false,fontset=fandol]{ctex}'
  if (id === 'ctex-windows') return '\\usepackage[UTF8,heading=false,fontset=windows]{ctex}'
  const fonts = CJK_FONT_SETS[process.platform] || CJK_FONT_SETS.linux
  return [
    '\\usepackage{xeCJK}',
    `\\setCJKmainfont{${fonts.main}}`,
    `\\setCJKsansfont{${fonts.sans}}`,
    `\\setCJKmonofont{${fonts.mono}}`,
    '\\XeTeXlinebreaklocale "zh"',
    '\\XeTeXlinebreakskip=0pt plus 1pt',
    '\\makeatletter',
    '\\@ifundefined{abstractname}{}{\\renewcommand{\\abstractname}{摘要}}',
    '\\@ifundefined{refname}{}{\\renewcommand{\\refname}{参考文献}}',
    '\\@ifundefined{bibname}{}{\\renewcommand{\\bibname}{参考文献}}',
    '\\@ifundefined{figurename}{}{\\renewcommand{\\figurename}{图}}',
    '\\@ifundefined{tablename}{}{\\renewcommand{\\tablename}{表}}',
    '\\@ifundefined{contentsname}{}{\\renewcommand{\\contentsname}{目录}}',
    '\\@ifundefined{appendixname}{}{\\renewcommand{\\appendixname}{附录}}',
    '\\@ifundefined{partname}{}{\\renewcommand{\\partname}{部分}}',
    '\\@ifundefined{indexname}{}{\\renewcommand{\\indexname}{索引}}',
    '\\makeatother',
    '\\renewcommand{\\today}{\\the\\year 年\\the\\month 月\\the\\day 日}',
  ].join('\n')
}

/**
 * Replace a previously injected block with another variant.
 * @param src - source that may already carry a generated block.
 * @param block - the block to install instead.
 */
export function swapCjkPreamble(src, block) {
  const marked = /% >>> paper-mode: generated CJK preamble >>>[\s\S]*?% <<< paper-mode: generated CJK preamble <<<\n?/
  if (marked.test(src)) {
    return src.replace(marked, `${CJK_BEGIN}\n${block}\n${CJK_END}\n`)
  }
  return withCjkPreamble(src, block)
}

/**
 * Insert a CJK package block right after `\documentclass`.
 * @param src - the translated LaTeX source.
 * @param block - the preamble lines to insert.
 * @returns the source with the block injected (unchanged when already CJK-aware).
 */
export function withCjkPreamble(src, block) {
  // A class or package that already handles Chinese wins; ignore commented lines.
  if (isCjkAware(src.replace(/^%.*$/gm, ''))) return src
  const match = /\\documentclass(\s*\[[^\]]*\])?\s*\{[^}]*\}/.exec(src)
  if (!match) return src
  const at = match.index + match[0].length
  return `${src.slice(0, at)}\n${CJK_BEGIN}\n${block}\n${CJK_END}\n${src.slice(at)}`
}

/**
 * Whether a project looks like it already typesets Chinese itself.
 * @param src - a LaTeX source file.
 */
export function isCjkAware(src) {
  return /\\documentclass(\s*\[[^\]]*\])?\s*\{[^}]*\b(ctexart|ctexrep|ctexbook|ctexbeamer)\b/.test(src)
    || /\\usepackage(\[[^\]]*\])?\{[^}]*\b(ctex|xeCJK)\b/.test(src)
}
