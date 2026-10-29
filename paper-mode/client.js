/**
 * Browser half of Paper Mode.
 *
 * Registers one sidebar entry and its center-column page: a four-pane LaTeX
 * workbench where the source, the English typeset PDF, its Chinese twin and the
 * writing assistant are visible at the same time.
 *
 * Every action gives visible feedback: a build always reports a phase, a toast,
 * and a status line, and the build button queues instead of going dead while a
 * previous build runs.
 *
 * @module @local/dsh-paper-mode/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-paper-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    /** Sidebar row id and the `main` slot key (the shell switches panels by it). */
    const PANEL_ID = 'paper-mode'
    /** Route prefix, document-relative so a sub-path deployment still resolves. */
    const API = 'api/dsh-paper'
    /** localStorage keys. */
    const LS_ROOT = 'dsh.paper.root'
    const LS_LAYOUT = 'dsh.paper.layout'
    /** Editor metrics that the log jump needs. */
    const LINE_HEIGHT = 18.6
    /** Pause after typing that triggers autosave + rebuild. */
    const AUTOSAVE_MS = 1400

    /** Services captured from the plugin context. */
    const env = { get: () => undefined }

    /** Absolute URL for one API route. */
    function api(route) {
      const base = (document.querySelector('base') && document.querySelector('base').href) || location.href
      return new URL(API + route, base).toString()
    }

    /** Whether the active UI locale is Chinese. */
    function zhLocale() {
      try {
        const locale = env.get('locale')
        const snapshot = locale && locale.getLocale && locale.getLocale()
        const id = snapshot && (snapshot.id || snapshot.locale || snapshot.language)
        if (id) return String(id).toLowerCase().startsWith('zh')
      } catch {
        /* fall through to the browser default */
      }
      return String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase().startsWith('zh')
    }

    /** Inline bilingual label. */
    function t(zh, en) {
      return zhLocale() ? zh : en
    }

    /** Human-readable duration. */
    function seconds(ms) {
      if (!ms && ms !== 0) return ''
      return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
    }

    /** One JSON request against the Host half. */
    async function post(route, body, signal) {
      const response = await fetch(api(route), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload.ok) throw new Error(payload.error || t('请求失败', 'Request failed'))
      return payload
    }

    /** Stream one assistant answer; `onEvent` receives each SSE frame. */
    async function streamChat(body, onEvent, signal) {
      const response = await fetch(api('/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut >= 0) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            try { onEvent(JSON.parse(line.slice(5).trim())) } catch { /* ignore */ }
          }
          cut = buffer.indexOf('\n\n')
        }
      }
    }

    /* ------------------------------------------------------------ styling */

    const CSS = `
.dshpm-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.dshpm-root *, .dshpm-root *::before, .dshpm-root *::after { box-sizing:border-box; }

/* ---------- top bar ---------- */
.dshpm-bar { display:flex; align-items:center; gap:8px; padding:0 12px; height:46px; flex:0 0 auto; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dshpm-chip { display:flex; align-items:center; gap:8px; min-width:0; max-width:34vw; padding:4px 10px; border-radius:8px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshpm-chip .dshpm-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-success-primary); flex:0 0 auto; }
.dshpm-chip b { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dshpm-chip i { color:var(--dsw-alias-label-secondary); font-size:11px; font-style:normal; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshpm-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:30px; padding:0 11px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12.5px; cursor:pointer; white-space:nowrap; transition:background .12s,border-color .12s,color .12s; }
.dshpm-btn:hover { background:var(--dsw-alias-bg-layer-2); }
.dshpm-btn:active { transform:translateY(.5px); }
.dshpm-btn[data-on="1"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.dshpm-btn:disabled { opacity:.5; cursor:default; }
.dshpm-btn.dshpm-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
.dshpm-btn.dshpm-primary:hover { filter:brightness(1.06); }
.dshpm-btn.dshpm-ghost { border-color:transparent; background:transparent; color:var(--dsw-alias-label-secondary); }
.dshpm-btn.dshpm-ghost:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dshpm-spacer { flex:1 1 auto; min-width:0; }
.dshpm-group { display:flex; align-items:center; gap:2px; padding:2px; border-radius:8px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.dshpm-group .dshpm-btn { height:24px; border:0; background:transparent; padding:0 9px; font-size:12px; border-radius:6px; }
.dshpm-group .dshpm-btn[data-on="1"] { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-brand-primary); }
.dshpm-group .dshpm-btn[data-on="0"] { color:var(--dsw-alias-label-secondary); }

/* ---------- body / panes ---------- */
.dshpm-body { display:flex; flex:1 1 auto; min-height:0; }
.dshpm-pane { display:flex; flex-direction:column; min-width:0; min-height:0; position:relative; }
.dshpm-head { display:flex; align-items:center; gap:6px; padding:0 10px; height:34px; flex:0 0 auto; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dshpm-title { font-size:12px; font-weight:600; letter-spacing:.2px; }
.dshpm-mini { font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dshpm-ico { width:26px; height:24px; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:13px; line-height:1; }
.dshpm-ico:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dshpm-ico[data-on="1"] { color:var(--dsw-alias-brand-primary); }
.dshpm-split { flex:0 0 6px; cursor:col-resize; background:transparent; position:relative; }
.dshpm-split::after { content:''; position:absolute; inset:0 auto 0 2px; width:1px; background:var(--dsw-alias-border-l1); }
.dshpm-split:hover::after, .dshpm-split[data-drag="1"]::after { width:2px; background:var(--dsw-alias-brand-primary); opacity:.7; }

/* ---------- files + editor ---------- */
.dshpm-tabs { display:flex; align-items:stretch; gap:1px; overflow-x:auto; padding:0 6px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; background:var(--dsw-alias-bg-base); scrollbar-width:thin; }
.dshpm-tab { display:flex; align-items:center; gap:5px; height:30px; padding:0 10px; font-size:11.5px; color:var(--dsw-alias-label-secondary); background:transparent; border:0; border-bottom:2px solid transparent; cursor:pointer; white-space:nowrap; }
.dshpm-tab:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
.dshpm-tab[data-on="1"] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
.dshpm-tab b { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-warn-primary); }
.dshpm-edit { flex:1 1 auto; min-height:0; display:flex; background:var(--dsw-alias-bg-layer-1); }
.dshpm-gutter { flex:0 0 auto; padding:10px 8px 10px 12px; text-align:right; color:var(--dsw-alias-label-secondary); font:12px/${LINE_HEIGHT}px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; user-select:none; overflow:hidden; opacity:.55; }
.dshpm-code { flex:1 1 auto; min-width:0; border:0; outline:0; resize:none; padding:10px 12px; background:transparent; color:var(--dsw-alias-label-primary); font:12px/${LINE_HEIGHT}px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; tab-size:2; white-space:pre; overflow:auto; }
.dshpm-code::selection { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }

/* ---------- pdf pages ---------- */
.dshpm-scroll { flex:1 1 auto; min-height:0; overflow:auto; background:var(--dsw-alias-bg-layer-2); padding:14px 12px 24px; scroll-behavior:auto; }
.dshpm-pagewrap { position:relative; margin:0 auto 14px; }
.dshpm-pagebox { position:relative; width:100%; }
.dshpm-textlayer { position:absolute; inset:0; overflow:hidden; cursor:text; user-select:text; -webkit-user-select:text; }
.dshpm-line { position:absolute; margin:0; padding:0; color:transparent; white-space:pre; transform-origin:0 0; overflow:hidden; }
.dshpm-line::selection { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 34%, transparent); color:transparent; }
.dshpm-page-no-select .dshpm-textlayer { display:none; }
.dshpm-syncbox { position:absolute; z-index:3; pointer-events:none; border-radius:2px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary); animation:dshpm-sync 1.9s ease-out forwards; }
@keyframes dshpm-sync { 0% { opacity:0; } 12% { opacity:1; } 70% { opacity:1; } 100% { opacity:0; } }
.dshpm-pdfsel { display:flex; align-items:center; gap:6px; padding:4px 8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshpm-pdfsel span { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshpm-page { display:block; width:100%; height:auto; border-radius:3px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.14),0 8px 18px rgba(0,0,0,.06); }
.dshpm-pageno { position:absolute; right:6px; bottom:6px; font-size:10px; padding:1px 5px; border-radius:8px; background:rgba(0,0,0,.55); color:#fff; }
.dshpm-loading { flex:1 1 auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--dsw-alias-label-secondary); }
.dshpm-spinner { width:22px; height:22px; border-radius:50%; border:2px solid var(--dsw-alias-border-l2); border-top-color:var(--dsw-alias-brand-primary); animation:dshpm-spin .8s linear infinite; }
@keyframes dshpm-spin { to { transform:rotate(360deg); } }
.dshpm-empty { flex:1 1 auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--dsw-alias-label-secondary); text-align:center; padding:26px; }
.dshpm-empty h2 { font-size:16px; margin:0; color:var(--dsw-alias-label-primary); font-weight:600; }
.dshpm-empty p { margin:0; max-width:46ch; line-height:1.65; font-size:12.5px; }
.dshpm-steps { display:flex; flex-direction:column; gap:8px; margin:6px 0; text-align:left; }
.dshpm-step { display:flex; gap:9px; align-items:flex-start; font-size:12.5px; line-height:1.5; }
.dshpm-step em { flex:0 0 auto; width:19px; height:19px; border-radius:50%; background:var(--dsw-alias-brand-primary); color:#fff; font-style:normal; font-size:11px; display:flex; align-items:center; justify-content:center; margin-top:1px; }

/* ---------- chat ---------- */
.dshpm-chat-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-1); }
.dshpm-msgs { flex:1 1 auto; min-height:0; overflow:auto; padding:12px 12px 4px; display:flex; flex-direction:column; gap:12px; }
.dshpm-msg { display:flex; flex-direction:column; gap:5px; }
.dshpm-msg[data-role="user"] { align-items:flex-end; }
.dshpm-role { font-size:10.5px; color:var(--dsw-alias-label-secondary); display:flex; align-items:center; gap:5px; }
.dshpm-bubble { max-width:100%; padding:9px 12px; border-radius:10px; line-height:1.68; white-space:pre-wrap; word-break:break-word; font-size:12.5px; }
.dshpm-msg[data-role="user"] .dshpm-bubble { background:var(--dsw-alias-brand-primary); color:#fff; border-bottom-right-radius:3px; }
.dshpm-msg[data-role="assistant"] .dshpm-bubble { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-bottom-left-radius:3px; }
.dshpm-code-block { margin:8px 0 0; padding:9px 10px; border-radius:7px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); font:11.5px/1.55 ui-monospace,Menlo,Consolas,monospace; white-space:pre-wrap; word-break:break-word; max-height:280px; overflow:auto; }
.dshpm-actions { display:flex; gap:6px; margin-top:2px; }
.dshpm-cards { display:flex; flex-direction:column; gap:8px; padding:4px 0; }
.dshpm-card { text-align:left; padding:10px 12px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); cursor:pointer; font-size:12.5px; color:var(--dsw-alias-label-primary); }
.dshpm-card:hover { border-color:var(--dsw-alias-brand-primary); }
.dshpm-card small { display:block; color:var(--dsw-alias-label-secondary); font-size:11px; margin-top:3px; }
.dshpm-compose { flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); padding:9px 12px 11px; display:flex; flex-direction:column; gap:7px; background:var(--dsw-alias-bg-layer-1); }
.dshpm-compose textarea { resize:none; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:12.5px/1.6 inherit; padding:8px 10px; outline:0; min-height:58px; max-height:170px; }
.dshpm-compose textarea:focus { border-color:var(--dsw-alias-brand-primary); }
.dshpm-row { display:flex; align-items:center; gap:7px; }
.dshpm-hint { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.dshpm-caret::after { content:'▍'; animation:dshpm-blink 1s steps(2,start) infinite; margin-left:1px; }
@keyframes dshpm-blink { 50% { opacity:0; } }

/* ---------- status bar / drawer ---------- */
.dshpm-statusbar { display:flex; align-items:center; gap:10px; height:27px; padding:0 12px; flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshpm-statusbar button { border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; padding:0 2px; }
.dshpm-statusbar button:hover { color:var(--dsw-alias-label-primary); }
.dshpm-badge { display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1); font-size:10.5px; }
.dshpm-badge[data-tone="error"] { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dshpm-badge[data-tone="warn"] { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dshpm-badge[data-tone="busy"] { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dshpm-drawer { flex:0 0 auto; max-height:34vh; overflow:auto; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); padding:8px 12px 10px; }
.dshpm-err { display:block; width:100%; text-align:left; border:0; background:transparent; color:var(--dsw-alias-state-error-primary); font:11.5px/1.65 ui-monospace,Menlo,Consolas,monospace; cursor:pointer; padding:2px 0; }
.dshpm-err:hover { text-decoration:underline; }
.dshpm-warn { color:var(--dsw-alias-state-warn-primary); font:11.5px/1.65 ui-monospace,Menlo,Consolas,monospace; padding:2px 0; }
.dshpm-log { margin-top:6px; }
.dshpm-log pre { max-height:180px; overflow:auto; margin:6px 0 0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); font:11px/1.5 ui-monospace,Menlo,Consolas,monospace; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; }

/* ---------- toasts ---------- */
/* ---------- compile settings ---------- */
.dshpm-settings { position:relative; display:flex; }
.dshpm-pop { position:absolute; top:34px; right:0; width:308px; z-index:30; padding:8px 12px 10px; border-radius:10px; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); box-shadow:0 14px 34px rgba(0,0,0,.22); }
.dshpm-pop h4 { margin:9px 0 4px; font-size:10px; text-transform:uppercase; letter-spacing:.09em; color:var(--dsw-alias-label-secondary); font-weight:600; }
.dshpm-pop h4:first-child { margin-top:2px; }
.dshpm-rowline { display:flex; align-items:center; justify-content:space-between; gap:10px; height:29px; font-size:12px; }
.dshpm-rowline > span { color:var(--dsw-alias-label-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dshpm-rowline select { max-width:168px; height:24px; padding:0 4px; font-size:11.5px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); outline:0; }
.dshpm-rowline select:focus { border-color:var(--dsw-alias-brand-primary); }
.dshpm-switch { position:relative; flex:0 0 auto; width:34px; height:19px; padding:0; border-radius:10px; cursor:pointer; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); transition:background .15s,border-color .15s; }
.dshpm-switch::after { content:''; position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); transition:transform .15s,background .15s; }
.dshpm-switch[data-on="1"] { border-color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent); }
.dshpm-switch[data-on="1"]::after { transform:translateX(15px); background:var(--dsw-alias-brand-primary); }
.dshpm-pop .dshpm-hint { display:block; margin-top:8px; padding-top:7px; border-top:1px solid var(--dsw-alias-border-l1); line-height:1.5; }

.dshpm-toasts { position:absolute; right:14px; bottom:36px; display:flex; flex-direction:column; gap:6px; z-index:20; pointer-events:none; }
.dshpm-toast { pointer-events:auto; min-width:180px; max-width:330px; padding:8px 11px; border-radius:8px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); box-shadow:0 8px 22px rgba(0,0,0,.18); }
.dshpm-toast[data-tone="error"] { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.dshpm-toast[data-tone="ok"] { border-color:var(--dsw-alias-state-success-primary); }
`

    /* -------------------------------------------------------- sub views */

    /** Sidebar glyph the shell draws at its own size and active state. */
    function PanelIcon({ size }) {
      return h('svg', {
        className: 'dshpm-icon-glyph',
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3 2.2h6.4L13 5.8V13.8H3z' }),
        h('path', { d: 'M9.2 2.2v3.8H13' }),
        h('path', { d: 'M5.2 8.4h3M5.2 11h4.6' }),
      )
    }

    /** One draggable vertical splitter: reports drag start and the delta since it. */
    function Splitter({ onStart, onDelta }) {
      const [dragging, setDragging] = useState(false)
      const start = useRef({ x: 0 })
      useEffect(() => {
        if (!dragging) return undefined
        const move = (event) => onDelta(event.clientX - start.current.x)
        const up = () => setDragging(false)
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
      }, [dragging, onDelta])
      return h('div', {
        className: 'dshpm-split',
        'data-drag': dragging ? '1' : '0',
        onMouseDown: (event) => {
          start.current = { x: event.clientX }
          if (onStart) onStart()
          setDragging(true)
        },
        role: 'separator',
        'aria-orientation': 'vertical',
      })
    }

    /** The source editor: file tabs, gutter and text area. */
    function EditorPane({ project, file, text, dirty, savedDirty, onChange, onOpenFile, onSave, onCaret, editorRef }) {
      const gutterRef = useRef(null)
      const lines = text ? text.split('\n') : ['']
      const onScroll = (event) => {
        if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-event.target.scrollTop}px)`
      }
      /** Tell the page which source line the caret is on (for forward sync). */
      const reportCaret = (node) => {
        if (!onCaret || !node) return
        const value = node.value || ''
        const position = node.selectionStart || 0
        const before = value.slice(0, position)
        const line = before.split('\n').length
        const column = position - before.lastIndexOf('\n')
        onCaret(line, column)
      }
      const texFiles = project.files.filter((one) => /\.tex$/i.test(one.path))
      return h(React.Fragment, null,
        h('div', { className: 'dshpm-tabs' },
          texFiles.map((one) => h('button', {
            key: one.path,
            className: 'dshpm-tab',
            'data-on': one.path === file ? '1' : '0',
            title: one.path,
            onClick: () => onOpenFile(one.path),
          },
            one.path === project.main ? h('span', { title: t('主文件', 'Root document') }, '◆') : null,
            one.path,
            savedDirty[one.path] ? h('b', { title: t('未保存', 'Unsaved') }) : null)),
        ),
        h('div', { className: 'dshpm-edit' },
          h('div', { ref: gutterRef, className: 'dshpm-gutter' },
            lines.map((_, index) => h('div', { key: index }, index + 1))),
          h('textarea', {
            ref: editorRef,
            className: 'dshpm-code',
            spellCheck: false,
            value: text,
            wrap: 'off',
            onScroll,
            onChange: (event) => onChange(event.target.value),
            onSelect: (event) => reportCaret(event.target),
            onClick: (event) => reportCaret(event.target),
            onKeyUp: (event) => {
              if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                reportCaret(event.target)
              }
            },
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                onSave()
                return
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                const node = event.target
                const start = node.selectionStart
                const end = node.selectionEnd
                const next = `${text.slice(0, start)}  ${text.slice(end)}`
                onChange(next)
                window.requestAnimationFrame(() => { node.selectionStart = start + 2; node.selectionEnd = start + 2 })
              }
            },
          }),
        ),
      )
    }

    /**
     * One rendered page: the rasterised image plus an invisible, selectable text
     * layer aligned to it. The overlay is what makes a PDF page behave like a
     * document — drag to select, double-click a word, Ctrl+C to copy.
     */
    function PageView({ rev, index, zoom, total, onSelectText, onLookup, highlight }) {
      const [layout, setLayout] = useState(null)
      const [width, setWidth] = useState(0)
      const wrapRef = useRef(null)
      const layerRef = useRef(null)

      useEffect(() => {
        let alive = true
        fetch(`${api('/text')}?rev=${rev}&i=${index}`)
          .then((response) => response.json())
          .then((payload) => { if (alive && payload && payload.ok) setLayout(payload.page) })
          .catch(() => { /* no text layer for this page */ })
        return () => { alive = false }
      }, [rev, index])

      useEffect(() => {
        const node = wrapRef.current
        if (!node) return undefined
        const measure = () => setWidth(node.clientWidth || 0)
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [layout])

      // Stretch each line so its invisible glyphs cover the printed ones.
      useEffect(() => {
        const layer = layerRef.current
        if (!layer) return
        for (const span of layer.children) {
          const target = Number(span.getAttribute('data-w'))
          if (!(target > 0)) continue
          span.style.width = 'max-content'
          const natural = span.offsetWidth
          span.style.width = `${target}px`
          span.style.transform = natural > 0 ? `scaleX(${target / natural})` : 'none'
        }
      }, [layout, width, zoom])

      // Without layout (headless tests) fall back to one pixel per point so the
      // layer still exists and can be asserted.
      const scale = layout ? (width > 0 ? width / layout.width : 1) : 0
      const lines = layout && scale > 0
        ? layout.lines.map((line, at) => h('span', {
          key: at,
          className: 'dshpm-line',
          'data-w': Math.max(1, line.w * scale),
          style: {
            left: `${line.x * scale}px`,
            top: `${line.y * scale}px`,
            width: `${Math.max(1, line.w * scale)}px`,
            height: `${Math.max(1, line.h * scale)}px`,
            fontSize: `${Math.max(4, line.h * scale * 0.94)}px`,
            lineHeight: `${Math.max(4, line.h * scale)}px`,
          },
        }, line.text))
        : []

      // Click coordinates are turned into PDF points with the same scale the
      // rasterised image uses, which is what SyncTeX expects.
      const toPoints = (event) => {
        const box = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null
        const widthPt = layout ? layout.width : 612
        if (!box || !box.width) return null
        const ratio = widthPt / box.width
        return { x: (event.clientX - box.left) * ratio, y: (event.clientY - box.top) * ratio }
      }
      const markBox = highlight && Number(highlight.page) === index + 1
        ? { ...highlight, k: width > 0 && highlight.pageWidth ? width / highlight.pageWidth : 1 }
        : null

      return h('div', { className: 'dshpm-pagewrap', style: { width: `${zoom}%` }, 'data-page': index },
        h('div', { className: 'dshpm-pagebox', ref: wrapRef },
          h('img', {
            className: 'dshpm-page',
            src: `${api('/asset')}?rev=${rev}&i=${index}`,
            alt: `page ${index + 1}`,
            draggable: false,
          }),
          lines.length
            ? h('div', {
              className: 'dshpm-textlayer',
              ref: layerRef,
              onMouseUp: () => {
                const selection = window.getSelection()
                const text = selection ? String(selection).trim() : ''
                if (text && onSelectText) onSelectText(text)
              },
              onDoubleClick: (event) => {
                if (!onLookup) return
                const point = toPoints(event)
                if (point) onLookup(index + 1, point.x, point.y)
              },
              title: t('双击跳到对应源码', 'Double-click to jump to the source'),
            }, lines)
            : null,
          markBox
            ? h('div', {
              className: 'dshpm-syncbox',
              style: {
                left: `${markBox.x * markBox.k}px`,
                top: `${markBox.y * markBox.k}px`,
                width: `${Math.max(6, markBox.w * markBox.k)}px`,
                height: `${Math.max(6, markBox.h * markBox.k)}px`,
              },
            })
            : null),
        h('span', { className: 'dshpm-pageno' }, `${index + 1} / ${total}`))
    }

    /** One page column: rasterised pages of a finished build. */
    function PdfPane({ build, zoom, scrollRef, onScroll, busy, emptyTitle, emptyHint, onSelectText, onLookup, highlight }) {
      const pages = build && build.rev ? Array.from({ length: build.pageCount || 0 }, (_, index) => index) : []
      const selectable = !(build && build.selectable === false)
      return h('div', { className: 'dshpm-pane', style: { flex: '1 1 0' } },
        pages.length
          ? h('div', { className: `dshpm-scroll${selectable ? '' : ' dshpm-page-no-select'}`, ref: scrollRef, onScroll },
            pages.map((index) => h(PageView, {
              key: `${build.rev}-${index}`,
              rev: build.rev,
              index,
              zoom,
              total: pages.length,
              onSelectText,
              onLookup,
              highlight,
            })))
          : h('div', { className: 'dshpm-loading' },
            busy ? h(React.Fragment, null,
              h('div', { className: 'dshpm-spinner' }),
              h('span', { className: 'dshpm-hint' }, emptyHint))
              : h('div', { className: 'dshpm-empty' },
                h('p', null, emptyTitle),
                h('p', { className: 'dshpm-hint' }, emptyHint))),
      )
    }

    /** Split assistant text into prose and fenced code blocks. */
    function splitFences(text) {
      const parts = []
      const pattern = /```([a-zA-Z]*)\n([\s\S]*?)```/g
      let last = 0
      let match = pattern.exec(text)
      while (match) {
        if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) })
        parts.push({ kind: 'code', lang: match[1], text: match[2] })
        last = pattern.lastIndex
        match = pattern.exec(text)
      }
      if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
      return parts
    }

    /** One chat message with role label, copy, and apply-to-editor actions. */
    function Message({ role, content, onApply, onCopy, streaming }) {
      const parts = role === 'assistant' ? splitFences(content || '') : [{ kind: 'text', text: content || '' }]
      return h('div', { className: 'dshpm-msg', 'data-role': role },
        h('div', { className: 'dshpm-role' },
          role === 'user' ? t('你', 'You') : t('写作助手', 'Assistant'),
          role === 'assistant' && content
            ? h('button', { className: 'dshpm-ico', style: { width: 18, height: 18, fontSize: 11 }, title: t('复制', 'Copy'), onClick: () => onCopy(content) }, '⧉')
            : null),
        role === 'user'
          ? h('div', { className: 'dshpm-bubble' }, content)
          : parts.map((part, index) => (part.kind === 'code'
            ? h('div', { key: index },
              h('pre', { className: 'dshpm-code-block' }, part.text),
              h('div', { className: 'dshpm-actions' },
                h('button', { className: 'dshpm-btn', onClick: () => onApply(part.text, false) }, t('替换选中', 'Replace selection')),
                h('button', { className: 'dshpm-btn', onClick: () => onApply(part.text, true) }, t('追加到末尾', 'Append'))))
            : h('div', { key: index, className: `dshpm-bubble${streaming && index === parts.length - 1 ? ' dshpm-caret' : ''}` }, part.text))),
        streaming && role === 'assistant' && !content ? h('div', { className: 'dshpm-hint' }, t('思考中…', 'Thinking…')) : null,
      )
    }

    /** One labelled setting row with a native select. */
    function SettingSelect({ label, value, options, onPick, hint }) {
      return h('div', { className: 'dshpm-rowline', title: hint || '' },
        h('span', null, label),
        h('select', {
          value,
          onChange: (event) => onPick(event.target.value),
        }, options.map(([id, text]) => h('option', { key: id, value: id }, text))))
    }

    /** One labelled setting row with a switch. */
    function SettingSwitch({ label, value, onToggle, hint }) {
      return h('div', { className: 'dshpm-rowline', title: hint || '' },
        h('span', null, label),
        h('button', {
          className: 'dshpm-switch',
          'data-on': value ? '1' : '0',
          role: 'switch',
          'aria-checked': value ? 'true' : 'false',
          onClick: () => onToggle(!value),
        }))
    }

    /** The compile-settings panel, anchored under the gear. */
    function SettingsPopover({ settings, project, mainFile, onChange, onClose, anchor }) {
      const boxRef = useRef(null)
      const inside = (target) => (anchor && anchor.current ? anchor.current.contains(target) : (boxRef.current ? boxRef.current.contains(target) : false))
      useEffect(() => {
        const onDown = (event) => { if (!inside(event.target)) onClose() }
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        // Defer so the click that opened the panel does not close it.
        const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
        document.addEventListener('keydown', onKey)
        return () => {
          window.clearTimeout(timer)
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [onClose])

      const texFiles = project.files
        .filter((one) => /\.tex$/i.test(one.path))
        .map((one) => [one.path, one.path])

      return h('div', { className: 'dshpm-pop', ref: boxRef },
        h('h4', null, t('编译', 'Compile')),
        h(SettingSelect, {
          label: t('编译器', 'Compiler'),
          value: settings.compiler,
          options: [['xelatex', 'XeLaTeX'], ['pdflatex', 'pdfLaTeX'], ['lualatex', 'LuaLaTeX']],
          onPick: (value) => onChange({ compiler: value }),
          hint: t('中文排版需要 XeLaTeX 或 LuaLaTeX', 'Chinese output needs XeLaTeX or LuaLaTeX'),
        }),
        h(SettingSelect, {
          label: t('主文件', 'Root document'),
          value: mainFile,
          options: texFiles.length ? texFiles : [[mainFile, mainFile]],
          onPick: (value) => onChange({ mainFile: value }),
        }),
        h(SettingSelect, {
          label: t('页面清晰度', 'Page resolution'),
          value: String(settings.dpi),
          options: [['96', '96 dpi'], ['110', '110 dpi'], ['144', '144 dpi'], ['200', '200 dpi']],
          onPick: (value) => onChange({ dpi: Number(value) }),
          hint: t('越高越清晰，图片也越大', 'Higher is sharper and heavier'),
        }),
        h(SettingSwitch, {
          label: t('快速模式（只跑一遍）', 'Fast mode (single pass)'),
          value: settings.singlePass,
          onToggle: (value) => onChange({ singlePass: value }),
          hint: t('跳过交叉引用刷新，最快；编号可能暂时是问号', 'Skips reference refresh — fastest, but numbers may show as ??'),
        }),
        h(SettingSwitch, {
          label: t('出错即停', 'Stop on first error'),
          value: settings.haltOnError,
          onToggle: (value) => onChange({ haltOnError: value }),
          hint: t('关闭时即使有错也会输出能排出来的部分', 'Off keeps the partial PDF a broken document can still produce'),
        }),
        h(SettingSelect, {
          label: t('参考文献', 'Bibliography'),
          value: settings.bib,
          options: [['auto', t('自动 BibTeX', 'BibTeX when needed')], ['none', t('不处理', 'Leave alone')]],
          onPick: (value) => onChange({ bib: value }),
        }),
        h(SettingSwitch, {
          label: t('与排版联动', 'Sync with the PDF'),
          value: settings.follow,
          onToggle: (value) => onChange({ follow: value }),
          hint: t('移动光标时在英文页里高亮对应位置；双击 PDF 反向跳回源码', 'Highlight the caret location in the English pages; double-click a page to jump back'),
        }),
        h('h4', null, t('中文对照', 'Chinese twin')),
        h(SettingSwitch, {
          label: t('生成中文版本', 'Build the Chinese twin'),
          value: settings.zhOn,
          onToggle: (value) => onChange({ zhOn: value }),
        }),
        h(SettingSelect, {
          label: t('中文宏包', 'CJK preamble'),
          value: settings.cjk,
          options: [['xecjk', 'xeCJK'], ['ctex', 'ctex'], ['none', t('不注入', 'Do not inject')]],
          onPick: (value) => onChange({ cjk: value }),
          hint: t('文档已自带 ctex / xeCJK 时选「不注入」', 'Pick "Do not inject" when the document already loads ctex or xeCJK'),
        }),
        h('h4', null, t('自动编译', 'Auto compile')),
        h(SettingSwitch, {
          label: t('停笔后自动编译', 'Compile when typing stops'),
          value: settings.auto,
          onToggle: (value) => onChange({ auto: value }),
        }),
        h(SettingSelect, {
          label: t('延迟', 'Delay'),
          value: String(settings.autoDelay),
          options: [['800', '0.8s'], ['1400', '1.4s'], ['3000', '3s']],
          onPick: (value) => onChange({ autoDelay: Number(value) }),
        }),
        h('span', { className: 'dshpm-hint' }, t('设置保存在本机浏览器，只影响这一个项目视图。', 'Settings live in this browser and apply to this workbench.')))
    }

    /* -------------------------------------------------------- main page */

    /** The center-column page. */
    function PaperPage() {
      const [project, setProject] = useState(null)
      const [file, setFile] = useState(null)
      const [buffers, setBuffers] = useState({})
      const [saved, setSaved] = useState({})
      const [en, setEn] = useState(null)
      const [zh, setZh] = useState(null)
      const [phase, setPhase] = useState('idle')          // idle | en | zh | save
      const [notice, setNotice] = useState('')
      const [errorsOpen, setErrorsOpen] = useState(false)
      const [toasts, setToasts] = useState([])
      const [layout, setLayout] = useState(() => {
        try { return JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null') || {} } catch { return {} }
      })
      const [settingsOpen, setSettingsOpen] = useState(false)
      const settingsRef = useRef(null)
      const [pdfSelection, setPdfSelection] = useState('')
      const [highlight, setHighlight] = useState(null)
      const [pendingJump, setPendingJump] = useState(null)
      const pdfSelectionRef = useRef('')
      const [messages, setMessages] = useState([])
      const [draft, setDraft] = useState('')
      const [chatBusy, setChatBusy] = useState(false)

      const editorRef = useRef(null)
      const enRef = useRef(null)
      const zhRef = useRef(null)
      const msgsRef = useRef(null)
      const buildTimer = useRef(null)
      const chatAbort = useRef(null)
      const buildToken = useRef(0)
      const dragBase = useRef(330)
      const lastBuilt = useRef('')
      const suppressFollow = useRef(0)
      const followTimer = useRef(null)
      const highlightTimer = useRef(null)
      const pendingBuild = useRef(false)
      const busyRef = useRef(false)

      const editorWidth = layout.editor === 0 ? 0 : (layout.editor || 340)
      const chatWidth = layout.chat || 350
      const showEditor = editorWidth > 0
      const showZh = layout.zh !== false
      const showChat = layout.chatOn !== false
      const zoom = layout.zoom || 100
      const syncScroll = layout.sync !== false

      /** Compile options, persisted with the rest of the layout. */
      const settings = {
        compiler: layout.compiler || 'xelatex',
        haltOnError: layout.haltOnError === true,
        singlePass: layout.singlePass === true,
        bib: layout.bib || 'auto',
        cjk: layout.cjk || 'xecjk',
        dpi: layout.dpi || 110,
        autoDelay: layout.autoDelay || AUTOSAVE_MS,
        auto: layout.auto !== false,
        zhOn: layout.zhOn !== false,
        follow: layout.follow !== false,
      }
      /** Root document in effect: the project default unless the user picked another. */
      const mainFile = project && layout.mainFile && project.files.some((one) => one.path === layout.mainFile)
        ? layout.mainFile
        : (project ? project.main : file)
      const busy = phase === 'en' || phase === 'zh'

      /** Push a transient toast. */
      const toast = useCallback((text, tone) => {
        const id = Math.random().toString(36).slice(2)
        setToasts((current) => [...current.slice(-2), { id, text, tone }])
        window.setTimeout(() => {
          setToasts((current) => current.filter((one) => one.id !== id))
        }, tone === 'error' ? 6000 : 3200)
      }, [])

      /** Set when a setting change must trigger a compile of its own. */
      const rebuildAfter = useRef(false)

      /** Persist one layout change. */
      const patchLayout = useCallback((patch) => {
        setLayout((current) => {
          const next = { ...current, ...patch }
          try { localStorage.setItem(LS_LAYOUT, JSON.stringify(next)) } catch { /* quota */ }
          return next
        })
      }, [])

      /** Apply settings; output-affecting ones schedule a recompile. */
      const changeSettings = useCallback((patch) => {
        if (['compiler', 'cjk', 'dpi', 'singlePass', 'bib', 'haltOnError', 'mainFile'].some((key) => key in patch)) {
          rebuildAfter.current = true
        }
        patchLayout(patch)
      }, [patchLayout])

      /** Load one file into the editor. */
      const openFile = useCallback(async (rel) => {
        if (!project || !rel) return
        if (!project.files.some((one) => one.path === rel)) return
        setFile(rel)
        if (buffers[rel] !== undefined || saved[rel] !== undefined) return
        try {
          const result = await post('/file/read', { root: project.root, path: rel })
          setSaved((current) => ({ ...current, [rel]: result.text }))
        } catch (error) {
          setNotice(`${t('读取失败', 'Read failed')}：${error.message}`)
          toast(`${t('读取失败', 'Read failed')}：${error.message}`, 'error')
        }
      }, [project, buffers, saved, toast])

      /** Adopt a project description returned by the Host. */
      const adopt = useCallback(async (description) => {
        setProject(description)
        setBuffers({})
        setSaved({})
        setEn(null)
        setZh(null)
        setFile(description.main)
        setMessages([])
        setPhase('idle')
        setNotice('')
        try { localStorage.setItem(LS_ROOT, description.root) } catch { /* quota */ }
        try {
          const result = await post('/file/read', { root: description.root, path: description.main })
          setSaved({ [description.main]: result.text })
        } catch (error) {
          toast(`${t('读取主文件失败', 'Cannot read the root document')}：${error.message}`, 'error')
        }
      }, [toast])

      /** Reopen the remembered project on first paint. */
      useEffect(() => {
        let root
        try { root = localStorage.getItem(LS_ROOT) } catch { root = null }
        if (!root) return
        post('/open', { root }).then((payload) => adopt(payload.project)).catch((error) => {
          toast(t(`上次的项目打不开了：${error.message}`, `Cannot reopen the last project: ${error.message}`), 'error')
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /** Ask the shell's directory picker for a folder. */
      const pickFolder = useCallback(async () => {
        try {
          const workspace = env.get('uiWorkspace')
          if (workspace && workspace.pickDirectory) return await workspace.pickDirectory()
        } catch { /* fall through to the prompt */ }
        return window.prompt(t('输入项目文件夹的绝对路径', 'Absolute path of the project folder'))
      }, [])

      /** Open a folder as a project. */
      const openFolder = useCallback(async () => {
        const chosen = await pickFolder()
        if (!chosen) return
        setPhase('save')
        try {
          const payload = await post('/open', { root: chosen })
          await adopt(payload.project)
          toast(t(`已打开 ${payload.project.name}`, `Opened ${payload.project.name}`), 'ok')
        } catch (error) {
          toast(error.message, 'error')
          setNotice(error.message)
        } finally {
          setPhase('idle')
        }
      }, [pickFolder, adopt, toast])

      /** Create a fresh project under a chosen parent folder. */
      const createProject = useCallback(async () => {
        const parent = await pickFolder()
        if (!parent) return
        const name = window.prompt(t('新项目文件夹名', 'New project folder name'), 'my-paper')
        if (!name) return
        const title = window.prompt(t('论文标题', 'Paper title'), name) || name
        setPhase('save')
        try {
          const payload = await post('/create', { parent, name, title })
          await adopt(payload.project)
          toast(t('项目已创建', 'Project created'), 'ok')
        } catch (error) {
          toast(error.message, 'error')
          setNotice(error.message)
        } finally {
          setPhase('idle')
        }
      }, [pickFolder, adopt, toast])

      /** Current text of the open file. */
      const currentText = file ? (buffers[file] !== undefined ? buffers[file] : (saved[file] || '')) : ''
      const unsaved = Object.keys(buffers).filter((key) => buffers[key] !== saved[key])

      /** Write one buffer back to disk. */
      const save = useCallback(async (rel, text) => {
        if (!project || !rel) return false
        try {
          await post('/file/write', { root: project.root, path: rel, text })
          setSaved((current) => ({ ...current, [rel]: text }))
          return true
        } catch (error) {
          toast(`${t('保存失败', 'Save failed')}：${error.message}`, 'error')
          return false
        }
      }, [project, toast])

      /**
       * Run the bilingual build. English first so a page appears quickly; the
       * Chinese twin follows in a second request.
       * @param force - bypass the "nothing changed" shortcut (manual compile).
       */
      const build = useCallback(async (force) => {
        if (!project) {
          toast(t('请先打开一个项目', 'Open a project first'), 'error')
          return
        }
        const main = mainFile
        if (!main) {
          toast(t('找不到主文件，请检查目录里的 .tex', 'No root document — check the .tex files'), 'error')
          return
        }
        const files = { ...buffers }
        const options = {
          compiler: settings.compiler,
          haltOnError: settings.haltOnError,
          singlePass: settings.singlePass,
          bib: settings.bib,
          cjk: settings.cjk,
          dpi: settings.dpi,
        }
        const fingerprint = JSON.stringify({ main, files, options, zh: settings.zhOn })
        if (!force && lastBuilt.current === fingerprint && en && en.rev) return
        if (busyRef.current) {
          pendingBuild.current = true
          toast(t('已排队，本轮排版结束后自动开始', 'Queued — it will start when this build finishes'))
          return
        }
        busyRef.current = true
        buildToken.current += 1
        const token = buildToken.current
        lastBuilt.current = fingerprint
        const startedAt = Date.now()

        try {
          setPhase('en')
          setNotice(t('英文排版中…', 'Typesetting English…'))

          // English first; the Chinese request starts a beat later so the two
          // LaTeX runs do not fight over the same TeX installation, while its
          // translation phase (network bound) still overlaps the English build.
          const english = post('/build', { root: project.root, main, files, mode: 'en', options })
            .then((first) => {
              if (buildToken.current !== token) return first
              if (first.en) setEn(first.en)
              if (first.en && first.en.failure) {
                setErrorsOpen(true)
                toast(t('英文排版失败，点底部状态栏查看日志', 'English build failed — see the log in the status bar'), 'error')
              } else if (settings.zhOn) {
                setPhase('zh')
                setNotice(t('中文对照排版中…', 'Typesetting the Chinese twin…'))
              }
              return first
            })

          const chinese = settings.zhOn
            ? new Promise((resolve) => window.setTimeout(resolve, 550))
              .then(() => post('/build', { root: project.root, main, files, mode: 'zh', options }))
              .then((second) => {
                if (buildToken.current !== token) return second
                if (second.zh) setZh(second.zh)
                if (second.zh && second.zh.failure) {
                  setErrorsOpen(true)
                  toast(t('中文排版失败，点底部状态栏查看日志', 'Chinese build failed — see the log in the status bar'), 'error')
                }
                return second
              })
            : Promise.resolve(undefined)

          const [first, second] = await Promise.all([english, chinese])
          if (buildToken.current !== token) return
          setPhase('idle')
          setNotice('')

          const failedEn = first && first.en && first.en.failure
          const failedZh = second && second.zh && second.zh.failure
          if (failedEn || failedZh) return

          const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
          const cachedEn = first && first.en && first.en.cached
          const cachedZh = second && second.zh && second.zh.cached
          if (cachedEn && (cachedZh || !settings.zhOn)) {
            toast(t('没有变化，直接复用上次排版（0 ms）', 'Nothing changed — reused the last build (0 ms)'), 'ok')
            return
          }
          const stats = second && second.zh && second.zh.stats
          const passes = [first && first.en && first.en.passes, second && second.zh && second.zh.passes]
            .filter((one) => one)
          const passText = passes.length ? t(` · ${passes.join('/')} 遍`, ` · ${passes.join('/')} passes`) : ''
          if (stats) {
            const tokens = stats.tokens || { input: 0, output: 0, cacheHit: 0 }
            const spent = tokens.input + tokens.output
            const tokenText = spent > 0
              ? t(` · ${short(spent)} tokens（缓存命中 ${short(tokens.cacheHit)}）`, ` · ${short(spent)} tokens (${short(tokens.cacheHit)} cached)`)
              : ''
            toast(t(
              `排版完成 ${seconds(Date.now() - startedAt)}${passText} · 译 ${stats.translated} 段，复用 ${stats.cached} 段${tokenText}`,
              `Build done ${seconds(Date.now() - startedAt)}${passText} · ${stats.translated} translated, ${stats.cached} reused${tokenText}`,
            ), 'ok')
          } else {
            toast(t(`排版完成 ${seconds(Date.now() - startedAt)}${passText}`, `Build done ${seconds(Date.now() - startedAt)}${passText}`), 'ok')
          }
        } catch (error) {
          if (buildToken.current === token) {
            setPhase('idle')
            setNotice(error.message)
            toast(t(`排版失败：${error.message}`, `Build failed: ${error.message}`), 'error')
          }
        } finally {
          busyRef.current = false
          if (pendingBuild.current) {
            pendingBuild.current = false
            window.setTimeout(() => build(true), 30)
          }
        }
      }, [project, file, mainFile, buffers, en, toast, settings.compiler, settings.haltOnError, settings.singlePass, settings.bib, settings.cjk, settings.dpi, settings.zhOn])

      /** Debounced autosave + rebuild while typing. */
      useEffect(() => {
        if (!project || !file) return undefined
        if (unsaved.length === 0) return undefined
        if (buildTimer.current) window.clearTimeout(buildTimer.current)
        buildTimer.current = window.setTimeout(() => {
          save(file, currentText)
          if (settings.auto) build(false)
        }, settings.autoDelay)
        return () => { if (buildTimer.current) window.clearTimeout(buildTimer.current) }
      }, [buffers, project, file, save, build, currentText, unsaved.length, settings.auto, settings.autoDelay])

      /** Typeset once after a project is adopted, so no pane starts blank. */
      useEffect(() => {
        if (!project || !file) return undefined
        if (en && en.rev) return undefined
        const timer = window.setTimeout(() => { build(false) }, 350)
        return () => window.clearTimeout(timer)
      }, [project, file, en, build])

      /** Recompile once after a setting that changes the output. */
      useEffect(() => {
        if (!rebuildAfter.current || !project) return undefined
        rebuildAfter.current = false
        const timer = window.setTimeout(() => { build(true) }, 120)
        return () => window.clearTimeout(timer)
      }, [layout, project, build])

      /** Keep EN and ZH page columns in step. */
      const mirrorScroll = useCallback((from, to) => {
        if (!syncScroll) return
        if (from.current && to.current && to.current.scrollTop !== from.current.scrollTop) {
          to.current.scrollTop = from.current.scrollTop
        }
      }, [syncScroll])

      /** Selected source text, used as the assistant's focus. */
      const selection = useCallback(() => {
        const node = editorRef.current
        if (!node) return ''
        const start = node.selectionStart
        const end = node.selectionEnd
        return start === end ? '' : currentText.slice(start, end)
      }, [currentText])

      /**
       * Jump the editor to a file and line.
       *
       * The jump is applied by an effect once the file's text is actually in
       * the editor, so it works for a file that still has to be read.
       */
      const jumpTo = useCallback((targetFile, line) => {
        if (!targetFile || !line) return
        suppressFollow.current = Date.now() + 700
        setPendingJump({ file: targetFile, line, nonce: Date.now() })
        if (targetFile !== file) openFile(targetFile)
      }, [file, openFile])

      /** Apply a queued jump as soon as the target text is mounted. */
      useEffect(() => {
        if (!pendingJump || pendingJump.file !== file) return
        const node = editorRef.current
        if (!node || !currentText) return
        const lines = currentText.split('\n')
        let offset = 0
        for (let index = 0; index < Math.min(pendingJump.line - 1, lines.length); index += 1) offset += lines[index].length + 1
        node.focus()
        node.selectionStart = offset
        node.selectionEnd = offset + (lines[pendingJump.line - 1] || '').length
        node.scrollTop = Math.max(0, (pendingJump.line - 4) * LINE_HEIGHT)
        const gutter = node.parentElement && node.parentElement.querySelector('.dshpm-gutter')
        if (gutter) gutter.style.transform = `translateY(${-node.scrollTop}px)`
        setPendingJump(null)
      }, [pendingJump, file, currentText])

      /** Flash one SyncTeX box on the English pages. */
      const flashBox = useCallback((box) => {
        setHighlight(box)
        if (highlightTimer.current) window.clearTimeout(highlightTimer.current)
        highlightTimer.current = window.setTimeout(() => setHighlight(null), 2000)
      }, [])

      /** PDF -> source: ask SyncTeX what lives under this point. */
      const lookupFromPdf = useCallback(async (rev, page, x, y) => {
        if (!rev) return
        try {
          const payload = await post('/sync/edit', { rev, page, x, y })
          if (payload.hit) jumpTo(payload.hit.file, payload.hit.line)
        } catch (error) {
          toast(t(`定位失败：${error.message}`, `Cannot locate: ${error.message}`), 'error')
        }
      }, [jumpTo, toast])

      /** Source -> PDF: scroll to and flash the boxes of one source line. */
      const followCaret = useCallback((line, column) => {
        if (!settings.follow || !en || !en.rev) return
        if (Date.now() < suppressFollow.current) return
        if (followTimer.current) window.clearTimeout(followTimer.current)
        followTimer.current = window.setTimeout(async () => {
          try {
            const payload = await post('/sync/view', { rev: en.rev, file, line, column })
            const box = (payload.boxes || []).find((one) => one.w > 0 && one.h > 0) || (payload.boxes || [])[0]
            if (!box) return
            flashBox(box)
            const pane = enRef.current
            if (!pane) return
            const page = pane.querySelector(`[data-page="${box.page - 1}"]`)
            if (!page) return
            const yPx = (box.y / (box.pageHeight || 792)) * page.clientHeight
            pane.scrollTop = Math.max(0, page.offsetTop + yPx - pane.clientHeight / 3)
          } catch {
            /* forward sync is a hint, never an error the user must see */
          }
        }, 260)
      }, [settings.follow, en, file, flashBox])

      /** Send one assistant turn. */
      const send = useCallback(async (prompt) => {
        if (!project || chatBusy) return
        const text = String(prompt || draft).trim()
        if (!text) return
        const selected = selection()
        const history = messages.slice(-10).map((one) => ({ role: one.role, content: one.content }))
        const nextMessages = [...messages, { role: 'user', content: text }, { role: 'assistant', content: '' }]
        setMessages(nextMessages)
        setDraft('')
        setChatBusy(true)
        const controller = new AbortController()
        chatAbort.current = controller
        const index = nextMessages.length - 1
        try {
          await streamChat({
            root: project.root,
            main: mainFile,
            file,
            selection: selected,
            pdfSelection: pdfSelectionRef.current,
            source: currentText,
            messages: [...history, { role: 'user', content: text }],
          }, (event) => {
            if (event.type === 'delta') {
              setMessages((current) => current.map((one, at) => (at === index ? { ...one, content: one.content + event.text } : one)))
            } else if (event.type === 'error') {
              setMessages((current) => current.map((one, at) => (at === index
                ? { ...one, content: `${one.content}\n\n[${event.message}]` }
                : one)))
            }
          }, controller.signal)
        } catch (error) {
          if (!controller.signal.aborted) {
            setMessages((current) => current.map((one, at) => (at === index
              ? { ...one, content: `${one.content}\n\n[${error.message}]` }
              : one)))
          }
        } finally {
          setChatBusy(false)
          chatAbort.current = null
        }
      }, [project, chatBusy, draft, selection, messages, file, currentText])

      /** Apply an assistant code block to the editor buffer. */
      const applyCode = useCallback((code, append) => {
        if (!file) return
        const base = currentText
        const node = editorRef.current
        const replace = !append && node && node.selectionStart !== node.selectionEnd
        const next = replace
          ? base.slice(0, node.selectionStart) + code + base.slice(node.selectionEnd)
          : `${base.replace(/\s*$/, '')}\n\n${code}\n`
        setBuffers((current) => ({ ...current, [file]: next }))
        toast(t('已写入编辑器，即将自动编译', 'Applied to the editor — rebuilding shortly'), 'ok')
      }, [file, currentText, toast])

      /** Follow the conversation. */
      useEffect(() => {
        if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight
      }, [messages])

      /** Global shortcuts: Ctrl+Enter builds, Ctrl+S saves. */
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.ctrlKey || event.metaKey)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            build(true)
          } else if (event.key.toLowerCase() === 's') {
            event.preventDefault()
            if (file) save(file, currentText)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [build, save, file, currentText])

      const errors = [
        ...(((en && en.errors) || []).map((one) => ({ ...one, kind: 'en' }))),
        ...(((zh && zh.errors) || []).map((one) => ({ ...one, kind: 'zh' }))),
      ]
      const warnings = [...((en && en.warnings) || []), ...((zh && zh.warnings) || [])]
      const logTail = (zh && zh.logTail) || (en && en.logTail) || ''

      /* --------------------------------------------------------- render */

      if (!project) {
        return h('div', { className: 'dshpm-root' },
          h('div', { className: 'dshpm-bar' },
            h('span', { className: 'dshpm-title' }, t('论文写作模式', 'Paper Mode')),
            h('div', { className: 'dshpm-spacer' })),
          h('div', { className: 'dshpm-empty' },
            h('h2', null, t('打开一个 LaTeX 论文项目', 'Open a LaTeX paper project')),
            h('p', null, t(
              '选中包含 main.tex 的文件夹，其余交给它：左侧写源码，中间看英文排版，右侧是同一份文档的中文排版，最右可以随时问助手。',
              'Pick the folder that holds main.tex. Write on the left, read the English typeset pages in the middle, the Chinese twin on the right, and ask the assistant at any time.',
            )),
            h('div', { className: 'dshpm-steps' },
              ['选中论文文件夹（含 main.tex）', '停笔 1.4 秒自动保存并重编双栏', 'Ctrl+Enter 立即编译，Ctrl+S 保存']
                .map((line, index) => h('div', { key: line, className: 'dshpm-step' },
                  h('em', null, index + 1), h('span', null, line)))),
            h('div', { className: 'dshpm-row' },
              h('button', { className: 'dshpm-btn dshpm-primary', onClick: openFolder }, t('打开文件夹', 'Open folder')),
              h('button', { className: 'dshpm-btn', onClick: createProject }, t('新建项目', 'New project'))),
            h('p', { className: 'dshpm-hint' }, t('需要本机已安装 MiKTeX 或 TeX Live（xelatex + pdftoppm）。', 'Requires MiKTeX or TeX Live with xelatex and pdftoppm.')),
            h('div', { className: 'dshpm-toasts' },
              toasts.map((one) => h('div', { key: one.id, className: 'dshpm-toast', 'data-tone': one.tone }, one.text)))),
        )
      }

      const statusLabel = phase === 'en'
        ? t('英文排版中…', 'Typesetting English…')
        : phase === 'zh'
          ? t('中文对照排版中…', 'Typesetting Chinese…')
          : phase === 'save'
            ? t('读取中…', 'Loading…')
            : (notice || '')

      return h('div', { className: 'dshpm-root' },
        /* -------- toolbar -------- */
        h('div', { className: 'dshpm-bar' },
          h('div', { className: 'dshpm-chip', title: project.root },
            h('span', { className: 'dshpm-dot' }),
            h('b', null, project.name),
            h('i', null, project.root)),
          h('button', {
            className: 'dshpm-btn dshpm-primary',
            onClick: () => build(true),
            title: t('立即编译（Ctrl+Enter）', 'Build now (Ctrl+Enter)'),
          },
            busy ? h('span', { className: 'dshpm-spinner', style: { width: 13, height: 13, borderWidth: 2 } }) : h('span', null, '▶'),
            busy ? t('排版中', 'Building') : t('编译', 'Build')),
          h('button', {
            className: 'dshpm-btn',
            'data-on': layout.auto === false ? '0' : '1',
            onClick: () => {
              const next = layout.auto === false
              patchLayout({ auto: next })
              toast(next ? t('已开启自动编译', 'Auto build on') : t('已关闭自动编译', 'Auto build off'))
            },
            title: t('停笔后自动保存并重编', 'Autosave and rebuild when typing stops'),
          }, layout.auto === false ? t('自动：关', 'Auto: off') : t('自动：开', 'Auto: on')),
          h('button', { className: 'dshpm-btn dshpm-ghost', onClick: openFolder, title: t('打开另一个项目', 'Open another project') }, t('打开', 'Open')),
          h('button', { className: 'dshpm-btn dshpm-ghost', onClick: createProject, title: t('新建项目', 'New project') }, t('新建', 'New')),
          h('div', { className: 'dshpm-spacer' }),
          h('span', { className: 'dshpm-mini', style: { maxWidth: '28ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, statusLabel),
          h('div', { className: 'dshpm-group' },
            h('button', {
              className: 'dshpm-btn',
              'data-on': showEditor ? '1' : '0',
              onClick: () => patchLayout({ editor: showEditor ? 0 : 340 }),
            }, t('源码', 'Source')),
            h('button', {
              className: 'dshpm-btn',
              'data-on': showZh ? '1' : '0',
              onClick: () => patchLayout({ zh: !showZh }),
            }, t('中文', 'Chinese')),
            h('button', {
              className: 'dshpm-btn',
              'data-on': showChat ? '1' : '0',
              onClick: () => patchLayout({ chatOn: !showChat }),
            }, t('助手', 'Assistant')))),
          h('div', { className: 'dshpm-settings', ref: settingsRef },
            h('button', {
              className: 'dshpm-btn dshpm-ghost',
              'data-on': settingsOpen ? '1' : '0',
              title: t('编译设置', 'Compile settings'),
              onClick: () => setSettingsOpen((value) => !value),
            }, '⚙'),
            settingsOpen
              ? h(SettingsPopover, {
                settings,
                project,
                mainFile,
                onChange: changeSettings,
                onClose: () => setSettingsOpen(false),
                anchor: settingsRef,
              })
              : null),

        /* -------- body -------- */
        h('div', { className: 'dshpm-body' },
          showEditor ? h('div', { className: 'dshpm-pane', style: { flex: `0 0 ${editorWidth}px` } },
            h('div', { className: 'dshpm-head' },
              h('span', { className: 'dshpm-title' }, t('源码', 'Source')),
              h('span', { className: 'dshpm-mini' }, unsaved.length ? t(`${unsaved.length} 处未保存`, `${unsaved.length} unsaved`) : t('已保存', 'Saved')),
              h('div', { className: 'dshpm-spacer' }),
              h('button', {
                className: 'dshpm-ico',
                title: t('保存 (Ctrl+S)', 'Save (Ctrl+S)'),
                onClick: () => save(file, currentText).then((ok) => { if (ok) toast(t('已保存', 'Saved'), 'ok') }),
              }, '💾')),
            h(EditorPane, {
              project, file, text: currentText, dirty: unsaved.length > 0,
              onCaret: followCaret,
              savedDirty: Object.fromEntries(unsaved.map((key) => [key, true])),
              onChange: (next) => setBuffers((current) => ({ ...current, [file]: next })),
              onOpenFile: openFile,
              onSave: () => save(file, currentText).then((ok) => { if (ok) toast(t('已保存', 'Saved'), 'ok') }),
              editorRef,
            })) : null,
          showEditor ? h(Splitter, {
            onStart: () => { dragBase.current = editorWidth },
            onDelta: (delta) => patchLayout({ editor: Math.max(0, Math.min(760, dragBase.current + delta)) }),
          }) : null,

          h('div', { className: 'dshpm-pane', style: { flex: '1 1 0' } },
            h('div', { className: 'dshpm-head' },
              h('span', { className: 'dshpm-title' }, 'English'),
              en && en.pageCount ? h('span', { className: 'dshpm-mini' }, `${en.pageCount} ${t('页', 'pages')} · ${seconds(en.ms)}`) : null,
              h('div', { className: 'dshpm-spacer' }),
              h('button', { className: 'dshpm-ico', title: t('缩小', 'Zoom out'), onClick: () => patchLayout({ zoom: Math.max(40, zoom - 10) }) }, '−'),
              h('button', { className: 'dshpm-ico', title: t('放大', 'Zoom in'), onClick: () => patchLayout({ zoom: Math.min(240, zoom + 10) }) }, '+'),
              h('button', {
                className: 'dshpm-ico',
                title: t('在新标签页打开 PDF', 'Open the PDF in a new tab'),
                onClick: () => { if (en && en.rev) window.open(`${api('/pdf')}?rev=${en.rev}`, '_blank') },
              }, '↗')),
            h(PdfPane, {
              build: en, zoom, scrollRef: enRef,
              onScroll: () => mirrorScroll(enRef, zhRef),
              onSelectText: (text) => { pdfSelectionRef.current = text; setPdfSelection(text) },
              onLookup: (page, x, y) => lookupFromPdf(en && en.rev, page, x, y),
              highlight,
              busy: phase === 'en',
              emptyTitle: t('还没有排版结果', 'Nothing typeset yet'),
              emptyHint: t('点「编译」或直接开始打字，英文排版会出现在这里。', 'Press Build or start typing — the English pages appear here.'),
            })),

          showZh ? h('div', { className: 'dshpm-pane', style: { flex: '1 1 0' } },
            h('div', { className: 'dshpm-head' },
              h('span', { className: 'dshpm-title' }, t('中文对照', 'Chinese')),
              zh && zh.pageCount
                ? h('span', { className: 'dshpm-mini' }, `${zh.pageCount} ${t('页', 'pages')} · ${seconds(zh.ms)}${zh.stats ? t(` · 译 ${zh.stats.translated}`, ` · ${zh.stats.translated} new`) : ''}`)
                : null,
              h('div', { className: 'dshpm-spacer' }),
              h('button', {
                className: 'dshpm-ico',
                'data-on': syncScroll ? '1' : '0',
                title: t('与英文栏同步滚动', 'Scroll together with English'),
                onClick: () => patchLayout({ sync: !syncScroll }),
              }, '⇅'),
              h('button', {
                className: 'dshpm-ico',
                title: t('在新标签页打开中文 PDF', 'Open the Chinese PDF in a new tab'),
                onClick: () => { if (zh && zh.rev) window.open(`${api('/pdf')}?rev=${zh.rev}`, '_blank') },
              }, '↗')),
            h(PdfPane, {
              build: zh, zoom, scrollRef: zhRef,
              onScroll: () => mirrorScroll(zhRef, enRef),
              onSelectText: (text) => { pdfSelectionRef.current = text; setPdfSelection(text) },
              onLookup: (page, x, y) => lookupFromPdf(zh && zh.rev, page, x, y),
              busy: phase === 'zh',
              emptyTitle: t('还没有中文版本', 'No Chinese twin yet'),
              emptyHint: t('第一次编译会逐段翻译并重新排版，需要十几秒；之后只翻译改动过的段落。', 'The first build translates every paragraph and re-typesets — usually ten to twenty seconds. Later builds only redo changed paragraphs.'),
            })) : null,

          showChat ? h(Splitter, {
            onStart: () => { dragBase.current = chatWidth },
            onDelta: (delta) => patchLayout({ chat: Math.max(260, Math.min(720, dragBase.current - delta)) }),
          }) : null,

          showChat ? h('div', { className: 'dshpm-pane', style: { flex: `0 0 ${chatWidth}px` } },
            h('div', { className: 'dshpm-head' },
              h('span', { className: 'dshpm-title' }, t('写作助手', 'Assistant')),
              currentText ? h('span', { className: 'dshpm-mini' }, t('已读取当前文件', 'File in context')) : null,
              h('div', { className: 'dshpm-spacer' }),
              h('button', {
                className: 'dshpm-ico',
                title: t('清空对话', 'Clear conversation'),
                onClick: () => setMessages([]),
              }, '⌫')),
            h('div', { className: 'dshpm-chat-body' },
              h('div', { className: 'dshpm-msgs', ref: msgsRef },
                messages.length === 0
                  ? h('div', { className: 'dshpm-cards' },
                    h('p', { className: 'dshpm-hint', style: { margin: '2px 0 4px' } }, t(
                      '助手能看到当前文件和你选中的那段源码。先选一段，再点下面的按钮；或者直接提问。',
                      'The assistant sees the current file and whatever you have selected. Select some text and pick a chip, or just ask.',
                    )),
                    [
                      [t('检查这段的论证', 'Critique this argument'), t('请以严格审稿人的视角，指出下面这段论证的漏洞和可能的反驳：', 'As a strict reviewer, name the weak points and likely objections in this passage:')],
                      [t('把引言写得更紧凑', 'Tighten the introduction'), t('请把引言改得更紧凑：删掉冗余从句，合并重复信息，保持学术语气，只输出修改后的 LaTeX 代码块。', 'Tighten the introduction: cut redundant clauses, merge repetition, keep the academic tone. Output only the LaTeX block.')],
                      [t('这句英文怎么改才地道', 'Make this sentence idiomatic'), t('请把下面这句改写成地道的学术英语，说明改动理由，只输出改写后的句子。', 'Rewrite this sentence as idiomatic academic English, explain the change, output only the sentence.')],
                    ].map(([label, prompt]) => h('button', {
                      key: label,
                      className: 'dshpm-card',
                      onClick: () => {
                        const selected = selection() || pdfSelectionRef.current
                        send(`${prompt}${selected ? `\n\n${selected}` : ''}`)
                      },
                    }, label, h('small', null, selection() ? t('作用于选中内容', 'Uses your selection') : t('未选中内容，先按 Esc 选中一段', 'Select some text first')))))
                  : messages.map((one, index) => h(Message, {
                    key: index,
                    role: one.role,
                    content: one.content,
                    streaming: chatBusy && index === messages.length - 1,
                    onApply: applyCode,
                    onCopy: (value) => {
                      if (navigator.clipboard) navigator.clipboard.writeText(value).then(() => toast(t('已复制', 'Copied'), 'ok')).catch(() => {})
                    },
                  }))),
              h('div', { className: 'dshpm-compose' },
                pdfSelection
                  ? h('div', { className: 'dshpm-pdfsel' },
                    h('span', { title: pdfSelection }, t(`已选中排版里的 ${pdfSelection.length} 个字，会一起发给助手`, `${pdfSelection.length} characters selected in the PDF — sent with your message`)),
                    h('button', {
                      className: 'dshpm-ico',
                      style: { width: 18, height: 18 },
                      title: t('清除选中', 'Clear selection'),
                      onClick: () => { pdfSelectionRef.current = ''; setPdfSelection('') },
                    }, '✕'))
                  : null,
                h('textarea', {
                  value: draft,
                  placeholder: t('描述你想改的地方，或直接提问…（Enter 发送，Shift+Enter 换行）', 'Describe the change, or just ask… (Enter to send, Shift+Enter for a newline)'),
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      send()
                    }
                  },
                }),
                h('div', { className: 'dshpm-row' },
                  h('span', { className: 'dshpm-hint' }, chatBusy
                    ? t('生成中…', 'Generating…')
                    : t('Ctrl+Enter 编译 · 双击 PDF 跳源码', 'Ctrl+Enter builds · double-click a page to jump')),
                  h('div', { className: 'dshpm-spacer' }),
                  chatBusy
                    ? h('button', { className: 'dshpm-btn', onClick: () => { if (chatAbort.current) chatAbort.current.abort() } }, t('停止', 'Stop'))
                    : h('button', {
                      className: 'dshpm-btn dshpm-primary',
                      disabled: !draft.trim(),
                      onClick: () => send(),
                    }, t('发送', 'Send')))))) : null,
        ),

        /* -------- status bar -------- */
        h('div', { className: 'dshpm-statusbar' },
          busy
            ? h('span', { className: 'dshpm-badge', 'data-tone': 'busy' }, h('span', { className: 'dshpm-spinner', style: { width: 10, height: 10, borderWidth: 1.5 } }), statusLabel || t('排版中', 'Building'))
            : h('span', { className: 'dshpm-mini' }, statusLabel || t('就绪', 'Ready')),
          h('div', { className: 'dshpm-spacer' }),
          en && en.rev ? h('button', { onClick: () => setErrorsOpen(true) }, `EN ${en.pageCount}p · ${seconds(en.ms)}`) : null,
          zh && zh.rev
            ? h('button', { onClick: () => setErrorsOpen(true) }, `中文 ${zh.pageCount}p · ${seconds(zh.ms)}`)
            : null,
          errors.length
            ? h('button', { className: 'dshpm-badge', 'data-tone': 'error', onClick: () => setErrorsOpen((v) => !v) }, `${errors.length} ${t('个错误', 'errors')}`)
            : null,
          warnings.length
            ? h('button', { className: 'dshpm-badge', 'data-tone': 'warn', onClick: () => setErrorsOpen((v) => !v) }, `${warnings.length} ${t('条警告', 'warnings')}`)
            : null,
          h('button', { onClick: () => setErrorsOpen((v) => !v) }, errorsOpen ? t('收起日志', 'Hide log') : t('日志', 'Log'))),

        errorsOpen
          ? h('div', { className: 'dshpm-drawer' },
            errors.length
              ? errors.map((one, index) => h('button', {
                key: `e${index}`,
                className: 'dshpm-err',
                title: t('点击跳到该行', 'Click to jump to the line'),
                onClick: () => jumpTo(one.file, one.line),
              }, `${one.kind === 'zh' ? '[中文] ' : ''}${one.file ? `${one.file}:${one.line} ` : ''}${one.message}`))
              : h('div', { className: 'dshpm-hint' }, t('没有错误。', 'No errors.')),
            warnings.slice(0, 8).map((one, index) => h('div', { key: `w${index}`, className: 'dshpm-warn' }, one)),
            logTail
              ? h('details', { className: 'dshpm-log' },
                h('summary', { className: 'dshpm-hint', style: { cursor: 'pointer' } }, t('原始日志末尾', 'Tail of the raw log')),
                h('pre', null, logTail))
              : null)
          : null,

        /* -------- toasts -------- */
        h('div', { className: 'dshpm-toasts' },
          toasts.map((one) => h('div', { key: one.id, className: 'dshpm-toast', 'data-tone': one.tone }, one.text))),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        env.get = (name) => {
          try { return ctx.get(name) } catch { return undefined }
        }

        const style = document.createElement('style')
        style.setAttribute('data-dsh-paper-mode', '')
        style.textContent = CSS
        document.head.appendChild(style)
        if (ctx.effect) ctx.effect(() => () => style.remove())

        const slots = ctx.slots
        if (!slots) return

        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t('论文写作', 'Paper'),
        }, PanelIcon))

        slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PaperPage))
      },
    }
  },
})
