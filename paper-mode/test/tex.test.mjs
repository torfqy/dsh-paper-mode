/**
 * Unit tests for the LaTeX segmenter — no dependencies, runs with `node --test`.
 *
 * The property that matters most: a document parsed with no translations must
 * rebuild byte for byte, because that is what a failed translation falls back to.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CJK_BEGIN, CJK_END, cjkBlock, isCjkAware, parseTex, rebuildTex, restorePlaceholders,
  signature, signatureProblem, swapCjkPreamble, withCjkPreamble,
} from '../lib/tex.js'

const SOURCE = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath}
\title{A Study of Fast Widgets}
\author{Jane Doe}
\begin{document}
\maketitle
\begin{abstract}
We present a fast widget. It is 3$\times$ faster than prior work~\cite{smith2020}.
\end{abstract}
\section{Introduction}
As shown in Fig.~\ref{fig:a}, the widget \textbf{scales} well. Let $x \in \mathbb{R}^n$ be the input.
% a private note
\subsection*{Motivation}
We study this because it matters.

\begin{equation}
E = mc^2
\end{equation}
\begin{itemize}
  \item First point about \emph{latency}.
  \item Second point.
\end{itemize}
\begin{tabular}{ll}
a & b \\
c & d
\end{tabular}
\end{document}
`

test('no translations rebuilds the source byte for byte', () => {
  const { pieces } = parseTex(SOURCE)
  assert.equal(rebuildTex(pieces, {}), SOURCE)
})

test('prose is extracted, math and citations are protected', () => {
  const { pieces, tokens } = parseTex(SOURCE)
  const prose = pieces.filter((piece) => piece.type === 'tr')
  assert.ok(prose.length >= 8, `expected several prose pieces, got ${prose.length}`)

  const protectedText = prose.map((piece) => piece.text).join('\n')
  assert.match(protectedText, /<<\d+>>/, 'inline constructs become placeholders')
  assert.doesNotMatch(protectedText, /\$x \\in/, 'math never reaches the model')

  const raw = tokens.join('\n')
  assert.match(raw, /\$\\times\$/)
  assert.match(raw, /\\cite\{smith2020\}/)
  assert.match(raw, /\$x \\in \\mathbb\{R\}\^n\$/)
})

test('opaque environments are copied verbatim', () => {
  const { pieces } = parseTex(SOURCE)
  const all = pieces.map((piece) => piece.text).join('\n')
  assert.match(all, /E = mc\^2/)
  assert.match(all, /a & b/)
  assert.match(all, /% a private note/)
})

test('a translated piece replaces only its own words', () => {
  const { pieces } = parseTex(SOURCE)
  const target = pieces.find((piece) => piece.type === 'tr' && /Introduction/.test(piece.text))
  assert.ok(target, 'the section title is a translatable piece')
  const rebuilt = rebuildTex(pieces, { [target.id]: '引言' })
  assert.match(rebuilt, /\\section\{引言\}/)
  assert.match(rebuilt, /We present a fast widget/)
})

test('placeholders restore to their original LaTeX', () => {
  const { pieces, tokens } = parseTex(SOURCE)
  const piece = pieces.find((row) => row.type === 'tr' && row.text.includes('<<'))
  const restored = restorePlaceholders(piece.text, tokens)
  assert.doesNotMatch(restored, /<<\d+>>/)
  assert.match(restored, /\\cite|\\ref|\$/)
})

test('signature mismatch is reported with the construct that changed', () => {
  const before = signature('A sentence with <<1>> and \\cite{x}.')
  const good = signature('一句话 <<1>> 与 \\cite{x}。')
  const dropped = signature('一句话 与 \\cite{x}。')
  assert.equal(signatureProblem(before, good), '')
  assert.match(signatureProblem(before, dropped), /placeholder/)
})

test('the CJK preamble is injected once, marked, and swappable', () => {
  const once = withCjkPreamble(SOURCE, cjkBlock('xecjk'))
  assert.ok(once.includes(CJK_BEGIN) && once.includes(CJK_END))
  assert.equal(withCjkPreamble(once, cjkBlock('ctex')), once, 'never injected twice')

  const swapped = swapCjkPreamble(once, cjkBlock('ctex'))
  assert.match(swapped, /ctex/)
  assert.doesNotMatch(swapped, /xeCJK/)
  assert.equal(swapped.split(CJK_BEGIN).length - 1, 1, 'exactly one marked block')
})

test('documents that already load a CJK package are left alone', () => {
  const ctex = '\\documentclass{ctexart}\n\\begin{document}\n中文\n\\end{document}\n'
  assert.equal(isCjkAware(ctex), true)
  assert.equal(withCjkPreamble(ctex, cjkBlock('xecjk')), ctex)
  assert.equal(isCjkAware(SOURCE), false)
})
