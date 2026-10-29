/**
 * Headless mount test for the Paper Mode browser half.
 *
 * Loads the real client.js into jsdom with a mocked Host API, mounts the page,
 * and asserts the interactions a user actually performs: the page auto-opens a
 * remembered project, builds, renders both page columns, and — the regression
 * this test exists for — the 编译 button issues a real request even when the
 * document did not change.
 */
import { JSDOM } from 'jsdom'
import fs from 'node:fs'
import path from 'node:path'

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})

const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.localStorage = window.localStorage
globalThis.location = window.location
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.requestAnimationFrame = (fn) => window.setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => window.clearTimeout(id)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')

/* ------------------------------------------------------------- host mock */

const calls = []
const PROJECT = {
  root: 'D:\\papers\\demo',
  name: 'demo',
  main: 'main.tex',
  files: [
    { path: 'main.tex', size: 100, mtime: 1 },
    { path: 'refs.bib', size: 50, mtime: 1 },
  ],
  toolchain: { xelatex: true, pdftoppm: true },
}
const SOURCE = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n'
let buildCounter = 0

function respond(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

globalThis.fetch = async (url, init) => {
  const route = new URL(url).pathname.replace('/api/dsh-paper', '')
  const body = init && init.body ? JSON.parse(init.body) : {}
  calls.push({ route, body })
  if (route === '/open') return respond({ ok: true, project: PROJECT })
  if (route === '/file/read') return respond({ ok: true, text: SOURCE })
  if (route === '/file/write') return respond({ ok: true, savedAt: Date.now() })
  if (route === '/sync/view') {
    return respond({ ok: true, boxes: [{ page: 1, x: 72, y: 100, w: 200, h: 12, pageWidth: 612, pageHeight: 792 }] })
  }
  if (route === '/sync/edit') return respond({ ok: true, hit: { file: 'main.tex', line: 3, column: -1 } })
  if (route === '/text') {
    return respond({
      ok: true,
      page: {
        width: 612,
        height: 792,
        lines: [
          { x: 72, y: 100, w: 300, h: 12, text: 'Speculative decoding for long context' },
          { x: 72, y: 120, w: 280, h: 12, text: 'second line of the rendered page' },
        ],
      },
    })
  }
  if (route === '/build') {
    buildCounter += 1
    const revision = `rev${buildCounter}`
    const page = {
      rev: revision,
      pages: 2,
      pageCount: 2,
      bytes: 1024,
      ms: 42,
      errors: [],
      warnings: [],
      logTail: '',
      stats: body.mode === 'zh' ? { files: 1, segments: 3, translated: 3, cached: 0, failed: 0, chars: 10 } : undefined,
    }
    return respond({ ok: true, main: 'main.tex', ...(body.mode === 'en' ? { en: page } : {}), ...(body.mode === 'zh' ? { zh: page } : {}) })
  }
  throw new Error(`unexpected route ${route}`)
}

/* ---------------------------------------------------------- load plugin */

window.localStorage.setItem('dsh.paper.root', PROJECT.root)
window.localStorage.removeItem('dsh.paper.layout')

let definition
window.__ModuleLoader__ = { load: (def) => { definition = def } }

const clientPath = path.resolve(import.meta.dirname, '../client.js')
const source = fs.readFileSync(clientPath, 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', source)(window, window.document)

if (!definition) throw new Error('client.js did not register a module definition')
if (definition.id !== '@local/dsh-paper-mode') throw new Error(`unexpected id ${definition.id}`)

const plugin = definition.factory((name) => (name === 'react' ? React : undefined))
let Page = null
const ctx = {
  get: () => undefined,
  effect: (fn) => fn(),
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      if (options.name === 'main') Page = component
      return () => {}
    },
  },
}
plugin.apply(ctx)
if (!Page) throw new Error('PaperPage was not registered into the main slot')

/* --------------------------------------------------------------- render */

const container = window.document.getElementById('root')
const root = createRoot(container)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = () => container.textContent || ''
const buttons = () => [...container.querySelectorAll('button')]
const click = async (label) => {
  const pattern = label instanceof RegExp ? label : new RegExp(label)
  const target = buttons().find((node) => pattern.test(node.textContent || ''))
  if (!target) throw new Error(`button not found: ${label} (have: ${buttons().map((b) => b.textContent).join(' | ')})`)
  await act(async () => { target.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
}

let failures = 0
const check = (label, condition, extra) => {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

console.log('mounting…')
console.log('  root key =', window.localStorage.getItem('dsh.paper.root'))
await act(async () => { root.render(React.createElement(Page)) })
check('page rendered', container.children.length > 0)

// let the remembered project open, the root document load, and the auto build run
await act(async () => { await sleep(1200) })

console.log('  text after mount:', JSON.stringify(text().slice(0, 240)))
check('project chip shows the folder name', text().includes('demo'))
check('editor got the document', container.querySelector('textarea') !== null)
check('English pane rendered pages', [...container.querySelectorAll('img')].some((img) => img.src.includes('rev')))
check('both builds ran automatically', calls.some((c) => c.route === '/build' && c.body.mode === 'en')
  && calls.some((c) => c.route === '/build' && c.body.mode === 'zh'))

const buildsBeforeManual = calls.filter((c) => c.route === '/build').length
await click(/编译|Build/)
await act(async () => { await sleep(400) })
const buildsAfterManual = calls.filter((c) => c.route === '/build').length
check('manual 编译 issues a fresh build even when nothing changed', buildsAfterManual > buildsBeforeManual,
  `before ${buildsBeforeManual}, after ${buildsAfterManual}`)

// typing should autosave and rebuild
const area = container.querySelector('textarea')
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(area, `${SOURCE}% edit\n`)
  area.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const buildsBeforeTyping = calls.filter((c) => c.route === '/build').length
await act(async () => { await sleep(1900) })
check('typing triggers an autosave write', calls.some((c) => c.route === '/file/write'))
check('typing triggers a rebuild', calls.filter((c) => c.route === '/build').length > buildsBeforeTyping)

// the assistant pane collapses and comes back without breaking the layout
await click(/^助手$|^Assistant$/)
check('assistant pane collapses', !text().includes('写作助手') && !text().includes('File in context'))
await click(/^助手$|^Assistant$/)
check('assistant pane returns', text().includes('写作助手') || text().includes('File in context'))

// the rendered page carries a selectable text layer
check('pages request their text layout', calls.some((c) => c.route === '/text'))
check('text layer lines render', container.querySelectorAll('.dshpm-line').length > 0)

// selecting inside the layer hands the text to the assistant composer
const layer = container.querySelector('.dshpm-textlayer')
const originalSelection = window.getSelection
window.getSelection = () => ({ toString: () => 'Speculative decoding for long context' })
await act(async () => {
  layer.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
})
window.getSelection = originalSelection
check('PDF selection reaches the composer', text().includes('已选中排版里的') || text().includes('characters selected in the PDF'))

// source -> PDF: moving the caret asks SyncTeX where that line sits
const codeArea = container.querySelector('textarea')
await act(async () => {
  codeArea.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'selectionStart').set
  setter.call(codeArea, 25)
  codeArea.dispatchEvent(new window.Event('select', { bubbles: true }))
})
await act(async () => { await sleep(400) })
const forward = calls.filter((c) => c.route === '/sync/view')
check('caret move requests a forward sync', forward.length > 0)
check('forward sync asks for the caret line', forward.some((c) => c.body.line === 2 && c.body.file === 'main.tex'))

// PDF -> source: double-clicking a page jumps the editor to that line
window.Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 600, height: 776, right: 600, bottom: 776, x: 0, y: 0 }
}
const pageLayer = container.querySelector('.dshpm-textlayer')
await act(async () => {
  pageLayer.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 300, clientY: 200 }))
})
await act(async () => { await sleep(300) })
const inverse = calls.filter((c) => c.route === '/sync/edit')
check('double-click requests an inverse sync', inverse.length > 0)
check('inverse sync sends page and point coordinates',
  inverse.some((c) => c.body.page === 1 && c.body.x > 0 && c.body.y > 0))
check('inverse sync moves the editor to the source line',
  String(codeArea.value.slice(codeArea.selectionStart, codeArea.selectionEnd)).trim() === 'Hello.')
check('forward sync flashes a highlight box', container.querySelector('.dshpm-syncbox') !== null)

// compile settings: the gear opens the panel and a change recompiles
await click(/^⚙$/)
check('settings panel opens', text().includes('Compiler') || text().includes('编译器'))
const buildsBeforeSetting = calls.filter((c) => c.route === '/build').length
const selects = [...container.querySelectorAll('.dshpm-pop select')]
check('settings panel has selects', selects.length >= 4)
if (selects.length) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(selects[0], 'pdflatex')
    selects[0].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await sleep(500) })
}
check('changing the compiler triggers a rebuild',
  calls.filter((c) => c.route === '/build').length > buildsBeforeSetting)
check('build requests carry compile options',
  calls.some((c) => c.route === '/build' && c.body.options && typeof c.body.options.dpi === 'number'))
check('the compiler choice reaches the host',
  calls.some((c) => c.route === '/build' && c.body.options && c.body.options.compiler === 'pdflatex'))
await act(async () => {
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
})

await click(/^⚙$/)
await act(async () => { await sleep(60) })
check('gear reopens the panel', container.querySelector('.dshpm-pop') !== null)
await click(/^⚙$/)
await act(async () => { await sleep(60) })
check('gear toggles the panel closed', container.querySelector('.dshpm-pop') === null)

// the log drawer opens from the status bar
await click(/日志|Log/)
check('log drawer opens', text().includes('没有错误') || text().includes('No errors'))

root.unmount()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
