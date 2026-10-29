/**
 * Segmented English -> Chinese translation of LaTeX prose through the Host LLM
 * service. One JSON round trip per chunk, validated against the placeholder and
 * command signature of the source, retried once, then degraded to the source
 * text so a bad model answer can never corrupt the Chinese build.
 *
 * @module @local/dsh-paper-mode/lib/translate
 */
import { createHash } from 'node:crypto'
import { parseTex, rebuildTex, restorePlaceholders, signature, signatureProblem } from './tex.js'

/** Characters of protected prose sent to the model in one request. */
const CHUNK_CHARS = 1200
/** Segments sent to the model in one request. */
const CHUNK_ITEMS = 6

const SYSTEM = [
  '你是一位资深的学术论文译者与 LaTeX 排版专家。你的任务是把英文 LaTeX 论文的正文翻译成简体中文，供双语对照阅读。',
  '',
  '必须严格遵守：',
  '1. 只翻译自然语言。所有 LaTeX 命令（如 \\textbf、\\cite）、花括号结构、% 注释一律保持原样。',
  '2. 形如 <<3>> 的占位符代表公式、引用、图表编号等不可翻译内容。占位符必须原样保留在同一条译文里，不得增删、不得改写、不得展开成文字。',
  '3. 学术语体：准确、简洁、客观，使用规范的学术书面汉语，避免口语化。',
  '4. 专业术语：首次出现时写成「中文（English）」，其后只用中文；若无公认中译则保留英文原词。',
  '5. 数字、单位、变量名、人名、机构名保持原样；中英文之间保留一个空格。',
  '6. 不增删内容，不加译者注，不加任何解释。',
  '7. 输出严格的 JSON，不要代码围栏，不要任何额外文字。格式：{"t":{"1":"译文","2":"译文"}}',
].join('\n')

/**
 * Hash a segment for the persistent translation cache.
 * @param model - the model id the translation came from.
 * @param text - protected prose.
 */
/** Bump when SYSTEM or the output contract changes: old entries stop matching. */
export const CACHE_VERSION = 'v3'

/**
 * Hash a segment for the persistent translation cache.
 * @param model - the model id the translation came from.
 * @param text - protected prose.
 */
export function cacheKey(model, text) {
  return createHash('sha256').update(`${CACHE_VERSION}\u0000${model}\u0000${text}`).digest('hex').slice(0, 32)
}

/** Parse a model answer that should be JSON, tolerating code fences and prose. */
function parseJsonLoose(text) {
  const trimmed = String(text || '').trim()
  const unfenced = trimmed.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const attempts = [unfenced]
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(unfenced.slice(first, last + 1))
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* try the next shape */
    }
  }
  return undefined
}

/** Pull the id -> translation map out of whichever envelope the model used. */
function translationMap(parsed) {
  if (!parsed || typeof parsed !== 'object') return {}
  const table = parsed.t || parsed.translations || parsed.result || parsed
  if (!table || typeof table !== 'object' || Array.isArray(table)) return {}
  const out = {}
  for (const [key, value] of Object.entries(table)) {
    const id = Number(String(key).replace(/^s/i, ''))
    if (Number.isFinite(id) && typeof value === 'string') out[id] = value
  }
  return out
}

/**
 * Collect the model's plain-text answer for one prompt.
 * @param llm - the Host `llm` service.
 * @param options - provider/model/system/user plus cancellation.
 */
async function callModel(llm, { provider, model, system, user, signal, reasoningEffort }) {
  const parts = []
  let usage = null
  const request = {
    provider,
    model,
    system,
    temperature: 0.1,
    maxTokens: Math.min(16000, Math.max(2000, Math.ceil(user.length * 2))),
    signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  }
  // Translation is mechanical: the cheapest supported effort keeps latency low.
  if (reasoningEffort) request.reasoningEffort = reasoningEffort
  const stream = llm.stream(request)
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind
      if (kind === 'error') throw new Error((chunk.reason.failure && chunk.reason.failure.message) || '模型调用失败')
      if (kind === 'aborted') throw new Error('翻译已取消')
    }
  }
  return { text: parts.join(''), usage }
}

/** Split the pending segments into request-sized chunks. */
function chunk(items) {
  const chunks = []
  let current = []
  let size = 0
  for (const item of items) {
    if (current.length && (size + item.text.length > CHUNK_CHARS || current.length >= CHUNK_ITEMS)) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += item.text.length
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * Translate one LaTeX document.
 * @param options.source - the whole file.
 * @param options.llm - Host `llm` service.
 * @param options.provider - provider route.
 * @param options.model - model id.
 * @param options.cache - `{ get(key), set(key, value) }` persistent cache.
 * @param options.signal - cancellation.
 * @param options.onEvent - progress callback `(event) => void`.
 * @returns `{ source, translations, stats }` where `translations` maps piece id to final LaTeX.
 */
export async function translateDocument({
  source, llm, provider, model, cache, signal, onEvent, concurrency = 3, reasoningEffort,
}) {
  const { pieces, tokens } = parseTex(source)
  const items = pieces.filter((piece) => piece.type === 'tr')
  const translations = {}
  const stats = { segments: items.length, cached: 0, translated: 0, failed: 0, chars: 0 }
  stats.tokens = { input: 0, output: 0, cacheHit: 0, calls: 0 }

  /** Aggregate what the provider reported for this document. */
  const recordUsage = (usage) => {
    if (!usage) return
    stats.tokens.calls += 1
    stats.tokens.input += Number(usage.inputTokens) || 0
    stats.tokens.output += Number(usage.outputTokens) || 0
    stats.tokens.cacheHit += Number(usage.cacheReadTokens) || 0
  }

  const pending = []
  for (const piece of items) {
    const key = cacheKey(model, piece.text)
    const hit = cache ? cache.get(key) : undefined
    if (typeof hit === 'string' && hit.trim()) {
      translations[piece.id] = restorePlaceholders(hit, tokens)
      stats.cached += 1
    } else {
      pending.push({ id: piece.id, text: piece.text, key })
      stats.chars += piece.text.length
    }
  }

  if (pending.length && onEvent) onEvent({ phase: 'translate', done: 0, total: pending.length })

  const chunks = chunk(pending)
  let done = 0
  let cursor = 0

  /**
   * Translate one batch and return the answers that pass validation, plus a
   * short diagnosis for the ones that did not.
   */
  const runChunk = async (batch, strict) => {
    const payload = {}
    batch.forEach((item, at) => { payload[String(at + 1)] = item.text })
    const user = strict
      ? `上一次回答不是合法 JSON，或占位符数量与原文不一致。请只输出 JSON，逐条保留全部 <<n>> 占位符，不要代码围栏。\n\n${JSON.stringify(payload, null, 1)}`
      : JSON.stringify(payload, null, 1)
    const answer = await callModel(llm, { provider, model, system: SYSTEM, user, signal, reasoningEffort })
    recordUsage(answer.usage)
    const parsed = translationMap(parseJsonLoose(answer.text))
    const accepted = []
    let reason = ''
    if (!Object.keys(parsed).length) reason = `回答不是可解析的 JSON（前 160 字：${String(answer.text).slice(0, 160)}）`
    for (let at = 0; at < batch.length; at += 1) {
      const item = batch[at]
      const candidate = parsed[at + 1]
      if (typeof candidate !== 'string' || !candidate.trim()) {
        if (!reason) reason = `缺少第 ${at + 1} 条的译文`
        continue
      }
      const problem = signatureProblem(signature(item.text), signature(candidate))
      if (problem) {
        if (!reason) reason = `第 ${at + 1} 条${problem}`
        continue
      }
      accepted.push({ item, text: candidate.trim() })
    }
    return { accepted, reason }
  }

  const problems = []

  /** Keep one accepted answer: cache it and record the final LaTeX. */
  const keep = (one) => {
    if (cache) cache.set(one.item.key, one.text)
    translations[one.item.id] = restorePlaceholders(one.text, tokens)
    stats.translated += 1
  }

  /** Translate one batch with the retry ladder; records what it settled. */
  const processChunk = async (batch) => {
    if (signal && signal.aborted) throw new Error('翻译已取消')
    let accepted = []
    let reason = ''
    try {
      const first = await runChunk(batch, false)
      accepted = first.accepted
      reason = first.reason
      if (accepted.length < batch.length) {
        const missing = batch.filter((item) => !accepted.some((one) => one.item.id === item.id))
        const retry = await runChunk(missing, true)
        accepted = accepted.concat(retry.accepted)
        reason = retry.reason || reason
      }
    } catch (error) {
      if (signal && signal.aborted) throw error
      reason = String((error && error.message) || error)
    }

    const seen = new Set(accepted.map((one) => one.item.id))
    for (const one of accepted) keep(one)

    // Last resort: one request per remaining segment, which keeps a single bad
    // paragraph from costing the whole chunk.
    const missing = batch.filter((item) => !seen.has(item.id))
    if (missing.length && missing.length < batch.length) {
      for (const item of missing) {
        if (signal && signal.aborted) throw new Error('翻译已取消')
        try {
          const solo = await runChunk([item], true)
          const hit = solo.accepted.find((one) => one.item.id === item.id)
          if (hit) { keep(hit); seen.add(item.id) }
          else if (solo.reason) reason = solo.reason
        } catch (error) {
          if (signal && signal.aborted) throw error
          reason = String((error && error.message) || error)
        }
      }
    }

    for (const item of missing) {
      if (seen.has(item.id)) continue
      stats.failed += 1
      if (problems.length < 3) problems.push({ chars: item.text.length, reason })
    }
    done += batch.length
    if (onEvent) onEvent({ phase: 'translate', done, total: pending.length })
  }

  // Batches are independent, so a small pool overlaps model latency instead of
  // paying it once per chunk in series.
  const workers = Math.max(1, Math.min(Math.max(1, concurrency), chunks.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      if (signal && signal.aborted) throw new Error('翻译已取消')
      const at = cursor
      cursor += 1
      if (at >= chunks.length) return
      await processChunk(chunks[at])
    }
  }))

  if (problems.length) stats.problems = problems
  return { source, pieces, tokens, translations, stats, rebuild: () => rebuildTex(pieces, translations) }
}

/**
 * Cheap one-shot translation used by the chat pane's "translate this paragraph"
 * action; keeps placeholders intact by reusing the document pipeline.
 * @param text - raw LaTeX fragment.
 * @param options - same model options as `translateDocument`.
 */
export async function translateFragment(text, { llm, provider, model, signal }) {
  const result = await translateDocument({
    source: text, llm, provider, model, cache: undefined, signal, onEvent: undefined,
  })
  return result.rebuild()
}
