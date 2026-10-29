# Changelog

## 0.1.0

First public release.

- Four-pane workbench: source, English typeset pages, Chinese typeset twin, assistant.
- Source-level bilingual translation with placeholder validation, retry ladder and a shared
  translation memory under the Harness home.
- Bidirectional SyncTeX navigation: double-click a page to jump to the source, move the caret
  to scroll and highlight the corresponding box.
- Selectable PDF text layer built from `pdftotext -bbox-layout`.
- Compile settings panel: compiler, root document, page resolution, single-pass mode,
  stop-on-error, bibliography strategy, CJK package, auto-compile delay, sync toggle.
- Three cache layers: build signature (0 ms no-op rebuilds), translation memory, page images.
- Platform-aware CJK preamble (Windows / macOS / Linux fonts) with Fandol fallback.
- Tests: dependency-free segmenter tests plus a jsdom mount test for the browser half.
