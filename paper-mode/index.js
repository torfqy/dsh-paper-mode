/**
 * Host half of Paper Mode.
 *
 * Serves the workbench over the Host webserver: project discovery, source
 * read/write, the bilingual LaTeX build (English PDF plus a Chinese PDF
 * typeset from the translated source), page rasterisation for the parallel
 * reader, and the writing-assistant chat stream.
 *
 * Everything the browser asks for arrives as JSON on `/api/dsh-paper/*`; the
 * page is served document-relative, so the client half drops the leading slash.
 *
 * @module @local/dsh-paper-mode
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CJK_VARIANTS, cjkBlock, isCjkAware, swapCjkPreamble, withCjkPreamble } from './lib/tex.js'
import { translateDocument } from './lib/translate.js'

/** Route prefix claimed on the Host webserver. */
const API_PREFIX = '/api/dsh-paper'
/** Per-project scratch directory (build trees, page images, translation cache). */
const WORK_DIR = '.dsh-paper'
/** Directories never walked, copied, or listed. */
const IGNORED_DIRS = new Set(['.git', '.dsh-paper', 'node_modules', '.github', '.vscode', '.idea', '__pycache__', '.pnpm-store'])
/** How many rendered builds stay addressable from the page. */
const MAX_REVISIONS = 48
/** Page rasterisation DPI. */
const PAGE_DPI = 110

/** Where translation memory and other reusable state live. */
function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'paper-mode')
}

/** One scratch root per project, outside the repository so builds never pollute it. */
function workRoot(root) {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), 'dsh-paper', key)
}

/** Rendered builds: revision id -> page files and PDF path. */
const revisions = new Map()
/** Last successful build per (root, mode), keyed by its input signature. */
const buildResults = new Map()
/** Serialises builds per project root. */
const buildChains = new Map()

/** An error with a user-facing message and a stable code. */
class PaperError extends Error {
  constructor(message, code = 'paper-error') {
    super(message)
    this.code = code
  }
}

/* ------------------------------------------------------------------ tools */

const toolPaths = new Map()

/**
 * Resolve an executable from PATH, preferring real binaries over shell shims so
 * a Windows `.cmd` wrapper never reaches `spawn` without a shell.
 * @param name - executable name without extension.
 */
function tool(name) {
  const hit = toolPaths.get(name)
  if (hit) return hit
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) {
        toolPaths.set(name, candidate)
        return candidate
      }
    }
  }
  toolPaths.set(name, name)
  return name
}

/**
 * Run one process and collect its output.
 * @param command - absolute executable path.
 * @param args - argument vector (no shell involved).
 * @param options - working directory, environment additions, timeout.
 */
function run(command, args, { cwd, env, timeoutMs = 240000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, MIKTEX_AUTOINSTALL: '1', ...env },
      })
    } catch (error) {
      resolve({ code: -1, stdout, stderr: String(error), timedOut })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)
    child.stdout.on('data', (data) => {
      stdout += data
      if (stdout.length > 600000) stdout = stdout.slice(-300000)
    })
    child.stderr.on('data', (data) => {
      stderr += data
      if (stderr.length > 200000) stderr = stderr.slice(-100000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/* --------------------------------------------------------------- projects */

/** Reject any path that escapes the project root. */
function inside(root, relative) {
  const target = path.resolve(root, String(relative || ''))
  const base = path.resolve(root)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new PaperError('路径越过了项目目录', 'path-escape')
  }
  return target
}

/** Recursively list a project, skipping scratch and dependency directories. */
async function walk(root, relative = '', depth = 0, out = []) {
  if (depth > 6 || out.length > 900) return out
  let entries
  try {
    entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
    if (IGNORED_DIRS.has(entry.name)) continue
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await walk(root, rel, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stat = await fs.stat(path.join(root, rel))
      out.push({ path: rel, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      /* vanished while walking */
    }
  }
  return out
}

/** True when a file reads like a LaTeX root document. */
async function isRootDocument(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return /\\documentclass/.test(text) && /\\begin\s*\{document\}/.test(text)
  } catch {
    return false
  }
}

/**
 * Choose the project's root document.
 * @param root - project directory.
 * @param files - walked file list.
 * @param preferred - the file the page last edited.
 */
async function pickMain(root, files, preferred) {
  if (preferred) {
    const candidate = files.find((one) => one.path === preferred)
    if (candidate) return candidate.path
  }
  const tex = files.filter((one) => one.path.toLowerCase().endsWith('.tex'))
  for (const name of ['main.tex', 'paper.tex', 'ms.tex', 'article.tex', 'thesis.tex']) {
    const hit = tex.find((one) => one.path.toLowerCase() === name)
    if (hit) return hit.path
  }
  for (const one of tex) {
    if (await isRootDocument(path.join(root, one.path))) return one.path
  }
  return tex[0] ? tex[0].path : undefined
}

/** Resolve and validate a project root without walking it. */
async function resolveRoot(rootPath) {
  const requested = path.resolve(String(rootPath || ''))
  let root
  try {
    root = await fs.realpath(requested)
  } catch {
    throw new PaperError(`找不到目录：${requested}`, 'missing-directory')
  }
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new PaperError('该路径不是目录', 'not-a-directory')
  return root
}

/** Describe one project for the page. */
async function describeProject(rootPath, preferred) {
  const root = await resolveRoot(rootPath)
  const files = await walk(root)
  const main = await pickMain(root, files, preferred)
  if (!main) throw new PaperError('这个目录里没有 .tex 文件', 'no-tex')
  return {
    root,
    name: path.basename(root),
    main,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    toolchain: {
      xelatex: existsSync(tool('xelatex')),
      pdftoppm: existsSync(tool('pdftoppm')),
    },
  }
}

/**
 * Mirror a project into its scratch build tree, copying only files whose size or
 * mtime changed.
 *
 * Keeping the tree warm is what makes a build cheap: `.aux`, `.bbl` and `.toc`
 * survive between builds, so a stable document needs one LaTeX pass instead of
 * two or three.
 * @param root - the project directory.
 * @param target - the build tree.
 * @returns counts for diagnostics.
 */
async function syncProject(root, target, { skip } = {}) {
  const manifestFile = path.join(target, '.dsh-paper-manifest.json')
  let previous = {}
  try { previous = JSON.parse(await fs.readFile(manifestFile, 'utf8')) || {} } catch { previous = {} }
  const files = await walk(root)
  const next = {}
  let copied = 0
  for (const file of files) {
    const stamp = `${file.size}:${Math.round(file.mtime)}`
    next[file.path] = stamp
    if (skip && skip(file.path)) continue
    if (previous[file.path] === stamp) continue
    const to = path.join(target, file.path)
    await fs.mkdir(path.dirname(to), { recursive: true })
    const ok = await fs.copyFile(path.join(root, file.path), to).then(() => true).catch(() => false)
    if (ok) copied += 1
  }
  for (const rel of Object.keys(previous)) {
    if (next[rel]) continue
    await fs.rm(path.join(target, rel), { force: true }).catch(() => {})
  }
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(manifestFile, JSON.stringify(next), 'utf8').catch(() => {})
  return { total: files.length, copied, manifest: next }
}

/** Every `.tex` file of a build tree, as posix-style relative paths. */
async function collectTex(dir) {
  const found = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    let entries
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) stack.push(next)
      else if (/\.tex$/i.test(entry.name)) found.push(next)
    }
  }
  return found.sort((a, b) => (a === 'main.tex' ? -1 : b === 'main.tex' ? 1 : a.localeCompare(b)))
}

/* ----------------------------------------------------------------- build */

/** Parse `-file-line-error` output into a short, deduplicated error list. */
function parseLog(text) {
  const errors = []
  const seen = new Set()
  const push = (one) => {
    const key = `${one.file || ''}:${one.line || ''}:${one.message}`
    if (seen.has(key)) return
    seen.add(key)
    errors.push(one)
  }
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    const fileLine = /^(.+?):(\d+):\s*(.+)$/.exec(line)
    if (fileLine) {
      if (/^(LaTeX|Package|Class|Overfull|Underfull)/i.test(line)) continue
      push({ file: path.basename(fileLine[1]), line: Number(fileLine[2]), message: fileLine[3] })
      continue
    }
    if (line.startsWith('! ')) push({ message: line.slice(2) })
    if (errors.length >= 14) break
  }
  return errors
}

/** Messages worth surfacing even when the build succeeded. */
function parseWarnings(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if ((/^LaTeX Warning:/.test(line) || /Overfull|Underfull/.test(line)) && !out.includes(line)) out.push(line)
    if (out.length >= 10) break
  }
  return out
}

/** Read the console log xelatex leaves behind. */
async function readLog(dir, main) {
  try {
    return await fs.readFile(path.join(dir, `${path.basename(main, '.tex')}.log`), 'utf8')
  } catch {
    return ''
  }
}

/** Compiler binaries a project may be typeset with. */
const COMPILERS = new Set(['xelatex', 'pdflatex', 'lualatex'])

/**
 * Typeset one build tree.
 *
 * The first pass always runs. A further pass happens only when it is needed:
 * a bibliography was regenerated, or the log still reports unresolved
 * cross-references. On a warm tree with a stable document that is one pass.
 *
 * @param dir - the tree to typeset in.
 * @param main - root document, relative to `dir`.
 * @param options - compiler, haltOnError, singlePass, bib.
 */
async function typeset(dir, main, options = {}) {
  const compiler = COMPILERS.has(options.compiler) ? options.compiler : 'xelatex'
  const binary = tool(compiler)
  const stem = path.basename(main, '.tex')
  const pdf = path.join(dir, `${stem}.pdf`)
  const args = ['-interaction=nonstopmode', '-file-line-error', options.synctex === false ? '-synctex=0' : '-synctex=1']
  if (options.haltOnError) args.push('-halt-on-error')
  args.push(main)
  const startedAt = Date.now()
  const logs = []

  // A stale PDF from a previous build must never be reported as this build's output.
  await fs.rm(pdf, { force: true }).catch(() => {})

  const passesLog = []
  const runOnce = async () => {
    const result = await run(binary, args, { cwd: dir })
    logs.push(result.stdout, result.stderr)
    passesLog.push(result.code)
    return result
  }

  await runOnce()

  let bibtexRan = false
  if (options.bib !== 'none') {
    try {
      const aux = await fs.readFile(path.join(dir, `${stem}.aux`), 'utf8')
      if (/\\bibdata\{/.test(aux)) {
        // BibTeX is only needed when the citation set or the .bib files moved.
        const stampFile = path.join(dir, '.dsh-paper-bib')
        const bbl = path.join(dir, `${stem}.bbl`)
        const citations = (aux.match(/\\citation\{[^}]*\}/g) || []).join('|')
        const bibNames = (await fs.readdir(dir).catch(() => [])).filter((name) => name.toLowerCase().endsWith('.bib'))
        const bibParts = []
        for (const name of bibNames) {
          const info = await fs.stat(path.join(dir, name)).catch(() => undefined)
          bibParts.push(`${name}:${info ? `${info.size}:${Math.round(info.mtimeMs)}` : 'missing'}`)
        }
        const stamp = createHash('sha1').update(`${citations}\u0000${bibParts.join(',')}`).digest('hex')
        const previous = await fs.readFile(stampFile, 'utf8').catch(() => '')
        if (!existsSync(bbl) || previous !== stamp) {
          const bib = await run(tool('bibtex'), [stem], {
            cwd: dir,
            env: { BIBINPUTS: `${dir}${path.delimiter}${process.env.BIBINPUTS || ''}` },
            timeoutMs: 60000,
          })
          logs.push(bib.stdout, bib.stderr)
          bibtexRan = true
          await fs.writeFile(stampFile, stamp, 'utf8').catch(() => {})
        }
      }
    } catch {
      /* no aux: let the log speak */
    }
  }

  /** Whether the last pass left work for another one. */
  const wantsAnotherPass = async () => {
    if (options.singlePass) return false
    const log = await readLog(dir, main)
    return /Rerun to get|undefined references|There were undefined|Label\(s\) may have changed|Citation .* undefined|Reference .* undefined/i.test(log)
  }

  if (bibtexRan || await wantsAnotherPass()) {
    await runOnce()
    if (await wantsAnotherPass()) await runOnce()
  }

  const exists = existsSync(pdf)
  const log = await readLog(dir, main)
  const text = log || logs.join('\n')
  return {
    ok: exists,
    pdf: exists ? pdf : undefined,
    ms: Date.now() - startedAt,
    passes: passesLog.length,
    bibtexRan,
    compiler,
    errors: parseLog(text),
    warnings: parseWarnings(text),
    logTail: String(text).slice(-4000),
  }
}

/** Revision fingerprint, page count and byte size of a finished PDF. */
async function inspectPdf(pdf) {
  const bytes = await fs.readFile(pdf)
  const rev = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
  const info = await run(tool('pdfinfo'), [pdf], { timeoutMs: 30000 })
  const pages = Number((/Pages:\s+(\d+)/.exec(info.stdout) || [])[1] || 0)
  return { rev, pages, bytes: bytes.length }
}

/** Page image names of an asset directory, in page order. */
async function listPages(dir) {
  return (await fs.readdir(dir).catch(() => []))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
}

/** Rasterise every page of a PDF into the revision's asset directory. */
async function rasterize(pdf, targetDir, pages, dpi = PAGE_DPI) {
  await fs.mkdir(targetDir, { recursive: true })
  const limit = Math.min(Math.max(pages, 1), 80)
  await run(tool('pdftoppm'), [
    '-png', '-r', String(dpi), '-f', '1', '-l', String(limit), pdf, path.join(targetDir, 'page'),
  ], { timeoutMs: 120000 })
  return listPages(targetDir)
}

/** Register a finished build so the page can fetch its assets by revision. */
function remember(entry) {
  revisions.set(entry.rev, entry)
  while (revisions.size > MAX_REVISIONS) {
    const oldest = revisions.keys().next().value
    const evicted = revisions.get(oldest)
    revisions.delete(oldest)
    textLayouts.delete(oldest)
    if (evicted && evicted.pageDir) fs.rm(evicted.pageDir, { recursive: true, force: true }).catch(() => {})
  }
  return entry
}

/** Translation cache backed by one JSON file inside the project scratch dir. */
class Cache {
  constructor(file) {
    this.file = file
    this.data = {}
    this.dirty = false
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch {
      this.data = {}
    }
    return this
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    if (this.data[key] === value) return
    this.data[key] = value
    this.dirty = true
  }

  get size() {
    return Object.keys(this.data).length
  }

  entries() {
    return Object.entries(this.data)
  }

  /**
   * Persist, merging whatever another build wrote in the meantime so two
   * concurrent projects cannot drop each other's translations.
   */
  async save() {
    if (!this.dirty) return
    this.dirty = false
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      let merged = {}
      try {
        const onDisk = JSON.parse(await fs.readFile(this.file, 'utf8'))
        if (onDisk && typeof onDisk === 'object') merged = onDisk
      } catch {
        /* first write */
      }
      Object.assign(merged, this.data)
      // Bound the file: drop the oldest third when it grows past the cap.
      const keys = Object.keys(merged)
      if (keys.length > MAX_CACHE_ENTRIES) {
        const trimmed = {}
        for (const key of keys.slice(keys.length - Math.floor(MAX_CACHE_ENTRIES * 0.66))) trimmed[key] = merged[key]
        merged = trimmed
      }
      await fs.writeFile(this.file, JSON.stringify(merged), 'utf8')
    } catch {
      /* the cache is an optimisation, never a failure */
    }
  }
}

/** Cap on remembered translations (roughly 30k paragraphs). */
const MAX_CACHE_ENTRIES = 30000

/**
 * Load the shared translation memory.
 *
 * It lives under the Harness home rather than the project or the temp tree, so
 * it survives reboots and is shared by every paper: the same paragraph in a
 * second paper is free. A project's old local cache is migrated on first use.
 * @param workDir - the project's scratch root.
 */
async function loadCache(workDir) {
  const shared = await new Cache(path.join(stateDir(), 'translation-cache.json')).load()
  if (shared.size > 0) return shared
  const legacy = await new Cache(path.join(workDir, 'translation-cache.json')).load()
  if (legacy.size > 0) {
    for (const [key, value] of legacy.entries()) shared.set(key, value)
    await shared.save()
  }
  return shared
}

/**
 * Translate every `.tex` file of a build tree in place and add a CJK preamble
 * to the root document.
 * @returns the per-file output plus aggregate statistics.
 */
async function translateTree(dir, {
  sourceDir, overrides, llm, provider, model, cache, main, signal, onEvent,
  cjk = 'xecjk', reasoningEffort, concurrency,
}) {
  // Always read the project (or the page's unsaved buffer) and always write the
  // build tree: a translated file must never become the next build's input.
  const files = await collectTex(sourceDir)
  const stats = {
    files: 0, segments: 0, cached: 0, translated: 0, failed: 0, chars: 0, cjkAware: false,
    tokens: { input: 0, output: 0, cacheHit: 0, calls: 0 },
  }
  const outputs = new Map()

  for (const name of files) {
    const file = path.join(dir, name)
    let source
    try {
      source = overrides && typeof overrides[name] === 'string'
        ? overrides[name]
        : await fs.readFile(path.join(sourceDir, name), 'utf8')
    } catch {
      continue
    }
    let translated
    try {
      translated = await translateDocument({
        source, llm, provider, model, cache, signal, onEvent, reasoningEffort, concurrency,
      })
    } catch (error) {
      if (signal && signal.aborted) throw error
      if (onEvent) onEvent({ phase: 'translate-error', message: String((error && error.message) || error) })
      continue
    }
    let output = translated.rebuild()
    stats.files += 1
    stats.segments += translated.stats.segments
    stats.cached += translated.stats.cached
    stats.translated += translated.stats.translated
    stats.failed += translated.stats.failed
    stats.chars += translated.stats.chars
    const used = translated.stats.tokens
    if (used) {
      for (const key of ['input', 'output', 'cacheHit', 'calls']) stats.tokens[key] += used[key] || 0
    }

    if (name === main) {
      if (isCjkAware(output)) {
        stats.cjkAware = true
      } else if (cjk !== 'none') {
        const before = output.split('\n').length
        output = withCjkPreamble(output, cjkBlock(cjk))
        // Lines the injected preamble adds; SyncTeX line numbers are shifted by it.
        stats.preambleLines = output.split('\n').length - before
      }
    }
    outputs.set(name, { translated: output, original: source })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, output, 'utf8')
  }

  // Drop translated files whose source disappeared, so a removed chapter cannot
  // linger in the PDF.
  const keep = new Set(files)
  for (const name of await collectTex(dir)) {
    if (!keep.has(name)) await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
  }
  return { stats, outputs }
}

/**
 * Typeset the Chinese tree, retrying with the next CJK preamble variant when a
 * document class fights the injected package.
 */
async function typesetChinese(dir, main, outputs, options = {}) {
  // CJK output needs an XeTeX engine unless the author's own preamble handles it.
  const compile = { ...options, compiler: options.cjk === 'none' ? options.compiler : 'xelatex' }
  const first = CJK_VARIANTS.find((one) => one.id === options.cjk) || CJK_VARIANTS[0]
  const record = outputs.get(main)
  // How many lines the generated preamble pushed the source down by.
  const offsetOf = (text) => (record ? text.split('\n').length - record.original.split('\n').length : 0)
  let attempt = await typeset(dir, main, compile)
  if (attempt.ok || options.cjk === 'none') {
    return { ...attempt, variant: first.id, preambleLines: record ? offsetOf(record.translated) : 0 }
  }

  if (!record) return attempt

  for (const variant of CJK_VARIANTS) {
    if (variant.id === first.id) continue
    const swapped = swapCjkPreamble(record.translated, cjkBlock(variant.id))
    await fs.writeFile(path.join(dir, main), swapped, 'utf8')
    attempt = await typeset(dir, main, compile)
    if (attempt.ok) return { ...attempt, variant: variant.id, preambleLines: offsetOf(swapped) }
  }
  // Restore the chosen variant so the failure log matches what was tried.
  await fs.writeFile(path.join(dir, main), record.translated, 'utf8')
  return { ...attempt, variant: first.id }
}

/** Resolve the Host default model, honouring `PAPER_MODE_MODEL=provider/model`. */
function resolveModel(ctx) {
  const override = String(process.env.PAPER_MODE_MODEL || '').trim()
  if (override.includes('/')) {
    const at = override.indexOf('/')
    return { provider: override.slice(0, at), model: override.slice(at + 1) }
  }
  try {
    const service = ctx.get('agentDefaultModel')
    const selection = service && service.currentSelection()
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* fall through to the shipped default */
  }
  return { provider: 'deepseek', model: 'deepseek-chat' }
}

/** Cheapest reasoning effort a model declares, memoised per route. */
const effortCache = new Map()

/**
 * Resolve the lowest reasoning effort a model supports.
 *
 * Translation is a mechanical task and the account default may be the highest
 * effort, which multiplies latency for no quality gain; this is the single
 * biggest lever on first-build time.
 * @param ctx - plugin context.
 * @param provider - provider route.
 * @param model - model id.
 */
async function translationEffort(ctx, provider, model) {
  const key = `${provider}/${model}`
  if (effortCache.has(key)) return effortCache.get(key)
  let effort
  try {
    const llm = ctx.get('llm')
    if (llm && llm.resolveModelInfo) {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = (info && info.reasoning && info.reasoning.efforts) || []
      const cheap = efforts.find((one) => /^(none|off|minimal)$/i.test(String(one.id)))
        || efforts.find((one) => /low/i.test(String(one.id)))
      effort = cheap ? cheap.id : undefined
    }
  } catch {
    effort = undefined
  }
  effortCache.set(key, effort)
  return effort
}

/**
 * Top-level build for one face of the project.
 * @param options - root, main, dirty buffers, mode, plugin context, compile options.
 */
async function buildProject({ root, main, overrides, mode, ctx, compile }) {
  const workDir = workRoot(root)
  const options = compile || {}
  const dpi = options.dpi || PAGE_DPI
  const cache = await loadCache(workDir)
  const out = {}

  /** Write the page's unsaved buffers over the build tree. */
  const applyOverrides = async (dir) => {
    for (const [rel, content] of Object.entries(overrides || {})) {
      const target = inside(dir, rel)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, String(content ?? ''), 'utf8')
    }
  }

  /**
   * Publish one finished PDF. Identical bytes reuse the pages already on disk,
   * so recompiling an unchanged document costs no rasterisation at all.
   */
  const publish = async (kind, result, meta) => {
    const { rev, pages, bytes } = await inspectPdf(result.pdf)
    const assetKey = `${rev}@${dpi}`
    const known = revisions.get(assetKey)
    if (known) return { ...known, ...meta }
    const pageDir = path.join(workDir, 'pages', assetKey)
    let pageFiles = existsSync(pageDir) ? await listPages(pageDir) : []
    if (!pageFiles.length) pageFiles = await rasterize(result.pdf, pageDir, pages, dpi)
    return remember({
      rev: assetKey, kind, pages, pageFiles, pageDir, pdf: result.pdf, bytes, workDir,
      buildDir: path.dirname(result.pdf), root, main, ...meta,
    })
  }

  if (mode === 'en' || mode === 'both') {
    const dir = path.join(workDir, 'en')
    const synced = await syncProject(root, dir)
    await applyOverrides(dir)
    const signature = buildSignature({ mode: 'en', main, options, manifest: synced.manifest, overrides })
    const remembered = buildResults.get(`${root}\u0000en`)
    if (remembered && remembered.signature === signature && isPublished(remembered.result)) {
      out.en = { ...remembered.result, cached: true, ms: 0 }
    } else {
      const result = await typeset(dir, main, options)
      if (!result.ok) {
        out.en = {
          pages: 0, pageFiles: [], bytes: 0, ms: result.ms, passes: result.passes,
          errors: result.errors, warnings: result.warnings, logTail: result.logTail, main,
          failure: '英文排版失败',
        }
      } else {
        out.en = await publish('en', result, {
          ms: result.ms, passes: result.passes, bibtexRan: result.bibtexRan, compiler: result.compiler,
          errors: result.errors, warnings: result.warnings, logTail: result.logTail, main,
        })
        buildResults.set(`${root}\u0000en`, { signature, result: out.en })
      }
    }
  }

  if (mode === 'zh' || mode === 'both') {
    const llm = ctx.get('llm')
    if (!llm) {
      out.zh = { pages: 0, pageFiles: [], failure: 'Host 未挂载 llm 服务，无法翻译' }
    } else {
      const dir = path.join(workDir, 'zh')
      // `.tex` is produced by the translator, never mirrored: font assets and
      // bibliographies are mirrored, sources are read straight from the project.
      const synced = await syncProject(root, dir, { skip: (rel) => /\.tex$/i.test(rel) })
      await applyOverrides(dir)
      const signature = buildSignature({ mode: 'zh', main, options, manifest: synced.manifest, overrides })
      const remembered = buildResults.get(`${root}\u0000zh`)
      if (remembered && remembered.signature === signature && isPublished(remembered.result)) {
        out.zh = { ...remembered.result, cached: true, ms: 0 }
        return out
      }
      const model = resolveModel(ctx)
      const startedAt = Date.now()
      const effort = await translationEffort(ctx, model.provider, model.model)
      const { stats, outputs } = await translateTree(dir, {
        sourceDir: root,
        overrides,
        llm,
        provider: model.provider,
        model: model.model,
        cache,
        main,
        cjk: options.cjk || 'xecjk',
        reasoningEffort: effort,
        concurrency: options.concurrency,
      })
      await cache.save()
      const result = await typesetChinese(dir, main, outputs, options)
      if (!result.ok) {
        out.zh = {
          pages: 0, pageFiles: [], errors: result.errors, warnings: result.warnings,
          logTail: result.logTail, stats, ms: Date.now() - startedAt, failure: '中文排版失败',
        }
      } else {
        out.zh = await publish('zh', result, {
          ms: Date.now() - startedAt, passes: result.passes, stats, variant: result.variant,
          errors: result.errors, warnings: result.warnings, logTail: result.logTail, main,
          provider: model.provider, model: model.model, effort,
          preambleLines: result.preambleLines || stats.preambleLines || 0,
        })
        buildResults.set(`${root}\u0000zh`, { signature, result: out.zh })
      }
    }
  }

  return out
}

/** Whether a remembered build can still be served (its assets are alive). */
function isPublished(result) {
  if (!result || !result.rev) return false
  const entry = revisions.get(result.rev)
  return Boolean(entry && entry.pageFiles && entry.pageFiles.length && entry.pdf && existsSync(entry.pdf))
}

/**
 * Fingerprint everything a build's output depends on: the options, the root
 * document, every source file's size and mtime, and the page's unsaved buffers.
 * @returns a stable hex digest.
 */
function buildSignature({ mode, main, options, manifest, overrides }) {
  const digest = createHash('sha1')
  digest.update(JSON.stringify({ v: 1, mode, main, options }))
  for (const key of Object.keys(manifest || {}).sort()) digest.update(`${key}\u0000${manifest[key]}\n`)
  for (const key of Object.keys(overrides || {}).sort()) digest.update(`${key}\u0000${overrides[key]}\n`)
  return digest.digest('hex')
}

/* ------------------------------------------------------------ pdf text */

/** Unescape the few entities pdftotext emits. */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (all, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/**
 * Parse `pdftotext -bbox-layout` output into one box list per page.
 * Lines carry their own rectangle so the page can paint a selectable overlay
 * that lines up with the rasterised glyphs.
 * @param xml - the tool's XHTML output.
 */
function parseTextLayout(xml) {
  const pages = []
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g
  let pageMatch = pageRe.exec(xml)
  while (pageMatch) {
    const width = Number(pageMatch[1])
    const height = Number(pageMatch[2])
    const lines = []
    const lineRe = /<line xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/line>/g
    let lineMatch = lineRe.exec(pageMatch[3])
    while (lineMatch) {
      const words = []
      const wordRe = /<word[^>]*>([\s\S]*?)<\/word>/g
      let wordMatch = wordRe.exec(lineMatch[5])
      while (wordMatch) {
        const text = unescapeXml(wordMatch[1]).trim()
        if (text) words.push(text)
        wordMatch = wordRe.exec(lineMatch[5])
      }
      if (words.length) {
        lines.push({
          x: Number(lineMatch[1]),
          y: Number(lineMatch[2]),
          w: Number(lineMatch[3]) - Number(lineMatch[1]),
          h: Number(lineMatch[4]) - Number(lineMatch[2]),
          text: words.join(' '),
        })
      }
      lineMatch = lineRe.exec(pageMatch[3])
    }
    pages.push({ width, height, lines })
    pageMatch = pageRe.exec(xml)
  }
  return pages
}

/** Per-revision text layouts, extracted on first use. */
const textLayouts = new Map()

/** Extract (and memoise) the text layout of a published revision. */
function layoutFor(entry) {
  if (!entry || !entry.pdf) return Promise.resolve([])
  const known = textLayouts.get(entry.rev)
  if (known) return known
  const pending = run(tool('pdftotext'), ['-bbox-layout', entry.pdf, '-'], { timeoutMs: 60000 })
    .then((result) => (result.code === 0 ? parseTextLayout(result.stdout) : []))
    .catch(() => [])
  textLayouts.set(entry.rev, pending)
  return pending
}

/* ------------------------------------------------------------- synctex */

/** Parse `synctex edit` output: the source file and line under a PDF point. */
function parseSyncEdit(text) {
  const input = /(?:^|\n)\s*Input:(.+)/.exec(text)
  const line = /(?:^|\n)\s*Line:(\d+)/.exec(text)
  if (!input || !line) return null
  const column = /(?:^|\n)\s*Column:(-?\d+)/.exec(text)
  return { input: input[1].trim(), line: Number(line[1]), column: Number(column ? column[1] : -1) }
}

/** Parse `synctex view` output into the boxes a source line occupies. */
function parseSyncView(text) {
  const boxes = []
  const blockRe = /SyncTeX result begin([\s\S]*?)SyncTeX result end/g
  let match = blockRe.exec(text)
  while (match) {
    const body = match[1]
    const page = /(?:^|\n)\s*Page:(\d+)/.exec(body)
    const x = /(?:^|\n)\s*x:([-\d.]+)/.exec(body)
    const y = /(?:^|\n)\s*y:([-\d.]+)/.exec(body)
    const w = /(?:^|\n)\s*W:([-\d.]+)/.exec(body)
    const h = /(?:^|\n)\s*H:([-\d.]+)/.exec(body)
    if (page && x && y) {
      boxes.push({
        page: Number(page[1]), x: Number(x[1]), y: Number(y[1]),
        w: Number(w ? w[1] : 0), h: Number(h ? h[1] : 0),
      })
    }
    match = blockRe.exec(text)
  }
  return boxes
}

/**
 * Map generated content back to the command that produced it.
 * A click in the bibliography resolves to `main.bbl`, which has no source line;
 * the useful destination is the `\bibliography{...}` line in the root document.
 */
async function anchorLine(root, main, relative) {
  const rules = [
    [/\.bbl$/i, /\\bibliography\{|\\addbibresource|\\printbibliography/],
    [/\.toc$/i, /\\tableofcontents/],
    [/\.lof$/i, /\\listoffigures/],
    [/\.lot$/i, /\\listoftables/],
  ]
  const rule = rules.find(([pattern]) => pattern.test(relative))
  if (!rule || !root || !main) return undefined
  try {
    const lines = (await fs.readFile(path.join(root, main), 'utf8')).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (rule[1].test(lines[index])) return index + 1
    }
  } catch {
    /* no anchor */
  }
  return undefined
}

/** Whether a revision still has the SyncTeX sidecar next to its PDF. */
function hasSync(entry) {
  if (!entry || !entry.pdf || !entry.buildDir) return false
  const stem = entry.pdf.replace(/\.pdf$/i, '')
  return existsSync(`${stem}.synctex.gz`) || existsSync(`${stem}.synctex`)
}

/* ------------------------------------------------------------- transport */

/** Read and parse a bounded JSON body. */
async function readJson(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new PaperError('请求内容过大', 'body-too-large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PaperError('请求不是合法 JSON', 'bad-json')
  }
}

/** Write one JSON answer. */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
  })
  res.end(payload)
}

/** Write one binary answer. */
async function sendFile(res, file, contentType) {
  const bytes = await fs.readFile(file)
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'private, max-age=3600',
    'content-length': bytes.length,
  })
  res.end(bytes)
}

/** The public shape of one build for the page. */
function publicBuild(build) {
  if (!build) return undefined
  return {
    rev: build.rev,
    pages: build.pages,
    pageCount: build.pageFiles ? build.pageFiles.length : 0,
    bytes: build.bytes,
    ms: build.ms,
    errors: build.errors || [],
    warnings: build.warnings || [],
    logTail: build.logTail || '',
    failure: build.failure,
    stats: build.stats,
    variant: build.variant,
    passes: build.passes,
    compiler: build.compiler,
    effort: build.effort,
    cached: build.cached === true,
    preambleLines: build.preambleLines || 0,
  }
}

/**
 * Serialise builds for one project *and* one face. The English and Chinese
 * builds use separate trees, so letting them overlap is what makes the Chinese
 * pane arrive sooner instead of strictly after the English one.
 */
function queueBuild(root, mode, task) {
  const key = `${root}\u0000${mode}`
  const previous = buildChains.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  buildChains.set(key, next.catch(() => {}))
  return next
}

/** Accept only the compile options the Host actually implements. */
function normalizeCompileOptions(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    compiler: COMPILERS.has(value.compiler) ? value.compiler : 'xelatex',
    haltOnError: value.haltOnError === true,
    singlePass: value.singlePass === true,
    bib: value.bib === 'none' ? 'none' : 'auto',
    cjk: ['xecjk', 'ctex', 'none'].includes(value.cjk) ? value.cjk : 'xecjk',
    dpi: Math.max(72, Math.min(240, Number(value.dpi) || PAGE_DPI)),
    synctex: value.synctex !== false,
  }
}

const SYSTEM_PROMPT = [
  '你正在 DeepSeek Harness 的「论文写作模式」中，协助用户撰写一篇 LaTeX 论文。',
  '用户界面是四栏并列：左侧 LaTeX 源码，中间英文排版，右侧中文对照排版，最右是与你对话的窗口。',
  '',
  '工作准则：',
  '- 用简体中文回答，语气专业、直接，不说客套话。',
  '- 需要给出 LaTeX 时，用 ```latex 代码块包裹，并保证可直接编译。',
  '- 修改建议要具体到可以照抄：指出改哪一句、为什么、改成什么。',
  '- 不臆造数据、实验结果或参考文献；需要引用时只标注「此处需要引用」，不要编造 bibtex 条目。',
  '- 拿不准就说不确定，不要猜。',
].join('\n')

/** Build the per-request context block for the assistant. */
function chatContext(payload) {
  const lines = []
  if (payload.root) lines.push(`项目目录：${payload.root}`)
  if (payload.main) lines.push(`主文件：${payload.main}`)
  if (payload.file) lines.push(`当前编辑文件：${payload.file}`)
  if (payload.selection && String(payload.selection).trim()) {
    lines.push('', '【用户在源码里选中的片段】', '```latex', String(payload.selection).slice(0, 6000), '```')
  }
  if (payload.pdfSelection && String(payload.pdfSelection).trim()) {
    lines.push('', '【用户从排版结果里选中的内容】', '```text', String(payload.pdfSelection).slice(0, 4000), '```')
  }
  const source = typeof payload.source === 'string' ? payload.source : ''
  // A pointed-at passage is what the user is asking about; the rest of the file
  // is background, so a smaller dump keeps the request cheap.
  const focused = Boolean(
    (payload.selection && String(payload.selection).trim())
    || (payload.pdfSelection && String(payload.pdfSelection).trim()),
  )
  const limit = focused ? 7000 : 26000
  if (source) {
    lines.push('', `【当前文件全文${source.length > limit ? '（已截断）' : ''}】`, '```latex', source.slice(0, limit), '```')
  }
  return lines.join('\n')
}

/** Stream one assistant answer over SSE. */
async function streamChat(ctx, req, res, payload) {
  const llm = ctx.get('llm')
  if (!llm) {
    sendJson(res, 200, { ok: false, error: 'Host 未挂载 llm 服务' })
    return
  }
  const model = resolveModel(ctx)
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch { /* client gone */ }
  }

  const history = Array.isArray(payload.messages) ? payload.messages : []
  const messages = history
    .filter((one) => one && (one.role === 'user' || one.role === 'assistant') && typeof one.content === 'string' && one.content.trim())
    .slice(-12)
    .map((one) => ({ role: one.role, content: [{ type: 'text', text: one.content }] }))

  try {
    send({ type: 'start', provider: model.provider, model: model.model })
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system: SYSTEM_PROMPT,
      temperature: 0.4,
      maxTokens: 4000,
      signal: controller.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: chatContext(payload) }] }, ...messages],
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') send({ type: 'delta', text: chunk.text })
      else if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error') {
          send({ type: 'error', message: (chunk.reason.failure && chunk.reason.failure.message) || '模型调用失败' })
        }
      }
    }
    send({ type: 'done' })
  } catch (error) {
    send({ type: 'error', message: String((error && error.message) || error) })
  } finally {
    try { res.end() } catch { /* already closed */ }
  }
}

/** The Host webserver is a hard dependency: without it there is no page to serve. */
export const inject = ['webServer']

/**
 * Mount the Paper Mode routes.
 * @param ctx - the plugin context (`webServer`, plus optional `llm` and `agentDefaultModel`).
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://paper.local')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      try {
        // Same-origin only: a page on another site must not drive this API
        // through the browser even though the route bypasses the API gateway.
        const origin = req.headers.origin
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden origin')
          return
        }

        if (route === '/asset' && req.method === 'GET') {
          const entry = revisions.get(url.searchParams.get('rev') || '')
          const index = Number(url.searchParams.get('i') || '0')
          if (!entry || !entry.pageFiles[index]) { res.writeHead(404); res.end('no such page'); return }
          await sendFile(res, path.join(entry.pageDir, entry.pageFiles[index]), 'image/png')
          return
        }

        if (route === '/pdf' && req.method === 'GET') {
          const entry = revisions.get(url.searchParams.get('rev') || '')
          if (!entry || !entry.pdf) { res.writeHead(404); res.end('no such pdf'); return }
          await sendFile(res, entry.pdf, 'application/pdf')
          return
        }

        if (route === '/text' && req.method === 'GET') {
          const entry = revisions.get(url.searchParams.get('rev') || '')
          if (!entry) { res.writeHead(404); res.end('no such revision'); return }
          const pages = await layoutFor(entry)
          const page = pages[Number(url.searchParams.get('i') || '0')]
          if (!page) { res.writeHead(404); res.end('no such page'); return }
          sendJson(res, 200, { ok: true, page })
          return
        }

        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只支持 POST' }); return }

        if (route === '/chat') {
          await streamChat(ctx, req, res, await readJson(req))
          return
        }

        const payload = await readJson(req)

        if (route === '/open') {
          sendJson(res, 200, { ok: true, project: await describeProject(payload.root, payload.preferredFile) })
          return
        }

        if (route === '/create') {
          const parent = await resolveRoot(payload.parent)
          const name = String(payload.name || '').trim().replace(/[\\/:*?"<>|]/g, '')
          const title = String(payload.title || '').trim() || '未命名论文'
          if (!name) throw new PaperError('请给出项目名称', 'bad-name')
          const target = path.join(parent, name)
          await fs.mkdir(target, { recursive: true })
          const template = [
            '\\documentclass[11pt]{article}',
            '\\usepackage[margin=1in]{geometry}',
            '\\usepackage{amsmath,amssymb}',
            '\\usepackage{graphicx}',
            '\\usepackage{hyperref}',
            `\\title{${title}}`,
            '\\author{Your Name}',
            '\\date{\\today}',
            '',
            '\\begin{document}',
            '\\maketitle',
            '',
            '\\begin{abstract}',
            'Write the abstract here: the problem, the approach, the main result, and why it matters.',
            '\\end{abstract}',
            '',
            '\\section{Introduction}',
            'Open with the problem and why it is hard. Cite prior work such as \\cite{example2024}.',
            '',
            '\\section{Method}',
            'Describe the approach and keep the notation consistent with the equations.',
            '',
            '\\section{Results}',
            'Report what you observed. Do not invent numbers.',
            '',
            '\\section{Conclusion}',
            'Summarise the contribution and name the limitations.',
            '',
            '\\bibliographystyle{plain}',
            '\\bibliography{refs}',
            '',
            '\\end{document}',
            '',
          ].join('\n')
          await fs.writeFile(path.join(target, 'main.tex'), template, 'utf8')
          await fs.writeFile(
            path.join(target, 'refs.bib'),
            '@article{example2024,\n  title   = {A Placeholder Reference},\n  author  = {Doe, Jane},\n  journal = {Journal of Examples},\n  year    = {2024}\n}\n',
            'utf8',
          )
          sendJson(res, 200, { ok: true, project: await describeProject(target, 'main.tex') })
          return
        }

        if (route === '/sync/edit') {
          const entry = revisions.get(String(payload.rev || ''))
          if (!hasSync(entry)) throw new PaperError('这个版本没有 SyncTeX 数据，请重新编译', 'no-synctex')
          const page = Math.max(1, Math.round(Number(payload.page) || 1))
          const x = Math.max(0, Number(payload.x) || 0)
          const y = Math.max(0, Number(payload.y) || 0)
          const result = await run(tool('synctex'), [
            'edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${path.basename(entry.pdf)}`,
          ], { cwd: entry.buildDir, timeoutMs: 20000 })
          const hit = parseSyncEdit(result.stdout)
          const relative = hit ? path.relative(entry.buildDir, hit.input).replace(/\\/g, '/') : ''
          if (!hit || !relative || relative.startsWith('..')) {
            sendJson(res, 200, { ok: true, hit: null })
            return
          }
          // A translated tree carries the injected CJK preamble above the source.
          const offset = entry.kind === 'zh' ? (entry.preambleLines || 0) : 0
          if (!/\.tex$/i.test(relative)) {
            const anchor = await anchorLine(entry.root, entry.main, relative)
            sendJson(res, 200, {
              ok: true,
              hit: anchor ? { file: entry.main, line: anchor, column: -1, from: relative } : null,
            })
            return
          }
          sendJson(res, 200, {
            ok: true,
            hit: { file: relative, line: Math.max(1, hit.line - offset), column: hit.column },
          })
          return
        }

        if (route === '/sync/view') {
          const entry = revisions.get(String(payload.rev || ''))
          if (!hasSync(entry)) { sendJson(res, 200, { ok: true, boxes: [] }); return }
          const offset = entry.kind === 'zh' ? (entry.preambleLines || 0) : 0
          const line = Math.max(1, Math.round(Number(payload.line) || 1)) + offset
          const column = Math.max(1, Math.round(Number(payload.column) || 1))
          const relative = String(payload.file || entry.main || '').replace(/\\/g, '/')
          const source = path.join(entry.buildDir, relative)
          if (!relative || !existsSync(source)) { sendJson(res, 200, { ok: true, boxes: [] }); return }
          const result = await run(tool('synctex'), [
            'view', '-i', `${line}:${column}:${source.replace(/\\/g, '/')}`,
            '-o', path.basename(entry.pdf),
          ], { cwd: entry.buildDir, timeoutMs: 20000 })
          const pages = await layoutFor(entry)
          const boxes = parseSyncView(result.stdout)
            .map((box) => {
              const page = pages[box.page - 1]
              return { ...box, pageWidth: page ? page.width : 612, pageHeight: page ? page.height : 792 }
            })
            .slice(0, 12)
          sendJson(res, 200, { ok: true, boxes })
          return
        }

        if (!payload.root) throw new PaperError('缺少项目目录', 'no-root')

        if (route === '/file/read') {
          const root = await resolveRoot(payload.root)
          const text = await fs.readFile(inside(root, payload.path), 'utf8')
          sendJson(res, 200, { ok: true, text })
          return
        }

        if (route === '/file/write') {
          const root = await resolveRoot(payload.root)
          await fs.writeFile(inside(root, payload.path), String(payload.text ?? ''), 'utf8')
          sendJson(res, 200, { ok: true, savedAt: Date.now() })
          return
        }

        if (route === '/build') {
          const root = await resolveRoot(payload.root)
          const files = await walk(root)
          const preferred = typeof payload.main === 'string' && payload.main ? payload.main : payload.preferredFile
          const main = await pickMain(root, files, preferred)
          if (!main) throw new PaperError('这个目录里没有可编译的 .tex 主文件', 'no-main')
          const mode = payload.mode === 'en' || payload.mode === 'zh' ? payload.mode : 'both'
          const compile = normalizeCompileOptions(payload.options)
          const build = await queueBuild(root, mode, () => buildProject({
            root,
            main,
            mode,
            ctx,
            compile,
            overrides: payload.files && typeof payload.files === 'object' ? payload.files : {},
          }))
          sendJson(res, 200, {
            ok: true,
            main,
            options: compile,
            en: publicBuild(build.en),
            zh: publicBuild(build.zh),
          })
          return
        }

        sendJson(res, 404, { ok: false, error: `未知接口：${route}` })
      } catch (error) {
        const message = String((error && error.message) || error)
        if (!res.headersSent) sendJson(res, 200, { ok: false, error: message, code: error && error.code })
        else { try { res.end() } catch { /* closed */ } }
      }
    },
  }))

  ctx.effect(() => () => {
    revisions.clear()
    buildChains.clear()
  })
}
