/**
 * DecisionModel: one-shot Noul-per-ref classifier, server-side only.
 * Keys resolve server-side (plugin options, then env). GUI settings hold
 * provider+model only and are never bundled with secrets.
 *
 * Flow (two-stage narrowing): Heuristic → hydrate → model. The model sees
 * `bucket + command` plus hydrated `title/state`, and returns per-ref
 * verdicts. One request for all questions (parallel + isolated); failure,
 * timeout, invalid JSON, or missing key falls back to keep-all (Heuristic).
 */

import { DECISION_TIMEOUT_MS, KEEP_THRESHOLD } from "./constants"
import { refKey } from "../model"
import { candidateCacheKey, createCandidateCache } from "./cache"
import type { CandidateCache } from "./cache"
import { capsKey, chunkSizeForBudget, effectiveMaxTokens, isCapsFresh } from "./model-caps"
import type { ModelCaps } from "./model-caps"
import { jevCodec } from "./codecs/jev"
import { openaiCodec } from "./codecs/openai"
import { defaultModelFor } from "./model-id"
import type { CandidateJudge, DecisionBackend, DecisionCodec, JudgeInput, Verdict } from "./types"
/** Backend specifics live under src/providers/*; orchestration stays here. */
import { OPENROUTER_DECISIONS_ENDPOINT, resolveOpenRouterCaps, resolveOpenRouterKey } from "../providers/openrouter"
import { ZEN_DECISIONS_ENDPOINT, resolveZenKey } from "../providers/zen"
import { OPENAI_DECISIONS_ENDPOINT, resolveOpenAIKey } from "../providers/openai"

export type DecisionProvider = DecisionBackend

export interface DecisionModelOptions {
  provider: DecisionProvider
  model?: string
  timeoutMs?: number
  zenApiKey?: string
  openrouterApiKey?: string
  openaiApiKey?: string
  fetchFn?: typeof fetch
  cache?: CandidateCache
  /**
   * Query-time caps cache, owned by the server setup closure so it survives
   * across judge calls. Nothing resolves at startup; the first query that
   * needs caps fetches live and every later query hits this map (7-day TTL).
   */
  capsCache?: Map<string, { caps: ModelCaps; at: number }>
}

/** Per-backend wiring; orchestration reads these tables, never branches. */
const decisionKeys: Record<DecisionBackend, (opts: DecisionModelOptions) => string | undefined> = {
  zen: resolveZenKey,
  openrouter: resolveOpenRouterKey,
  openai: resolveOpenAIKey,
}

const decisionEndpoints: Record<DecisionBackend, string> = {
  zen: ZEN_DECISIONS_ENDPOINT,
  openrouter: OPENROUTER_DECISIONS_ENDPOINT,
  openai: OPENAI_DECISIONS_ENDPOINT,
}

const decisionCodecs: Record<DecisionBackend, DecisionCodec> = {
  zen: jevCodec,
  openrouter: jevCodec,
  openai: openaiCodec,
}

const resolveDecisionKey = (opts: DecisionModelOptions): string | undefined => decisionKeys[opts.provider](opts)

const decisionEndpoint = (opts: DecisionModelOptions): string => decisionEndpoints[opts.provider]

const decisionModelId = (opts: DecisionModelOptions): string => opts.model || defaultModelFor(opts.provider)

/** Pure splitter so chunking stays testable without network or mocks. Size is
 * always explicit — never a hardcoded default; the caller derives it from
 * queried caps or the halve-on-overflow queue below. */
export const chunkIndexes = (length: number, size: number): number[][] => {
  if (!Number.isFinite(size) || size <= 0) return [Array.from({ length }, (_, i) => i)]
  const out: number[][] = []
  for (let start = 0; start < length; start += size) {
    const chunk: number[] = []
    for (let i = start; i < Math.min(start + size, length); i++) chunk.push(i)
    out.push(chunk)
  }
  return out
}

/** Only OpenRouter exposes a live catalog; the other backends chunk by
 * halve-on-overflow alone. */
const noCaps = async (): Promise<ModelCaps | undefined> => undefined

const openRouterCaps = async (
  opts: DecisionModelOptions,
  modelId: string,
  fetchFn: typeof fetch,
  budgetMs: number,
): Promise<ModelCaps | undefined> => {
  const store = opts.capsCache
  const k = capsKey(opts.provider, modelId)
  const hit = store?.get(k)
  if (hit && isCapsFresh(hit.at)) return hit.caps
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, budgetMs))
  try {
    const caps = await resolveOpenRouterCaps(modelId, fetchFn, Date.now(), controller.signal)
    if (caps && store) store.set(k, { caps, at: Date.now() })
    return caps
  } catch {
    return hit?.caps
  } finally {
    clearTimeout(timer)
  }
}

const capsResolvers: Record<
  DecisionBackend,
  (opts: DecisionModelOptions, modelId: string, fetchFn: typeof fetch, budgetMs: number) => Promise<ModelCaps | undefined>
> = {
  zen: noCaps,
  openrouter: openRouterCaps,
  openai: noCaps,
}

/** Query-time caps: live catalog on first need, cached 7-day in the
 * caller-owned map. Nothing at startup, nothing hardcoded — misses
 * proceed as one slice and split on 413. The catalog fetch aborts against the
 * caller's remaining overall budget so a stalled catalog fails open instead
 * of blocking refresh. */
export const queryCaps = async (
  opts: DecisionModelOptions,
  modelId: string,
  fetchFn: typeof fetch,
  budgetMs = 8_000,
): Promise<ModelCaps | undefined> => capsResolvers[opts.provider](opts, modelId, fetchFn, budgetMs)

/** Initial slices from queried caps; unknown caps proceed as one slice. */
export const initialSlices = (
  pendingIndexes: readonly number[],
  inputs: readonly JudgeInput[],
  caps: ModelCaps | undefined,
): number[][] => {
  if (!caps || pendingIndexes.length <= 1) return [pendingIndexes as number[]]
  const perQuestion = pendingIndexes.map((i) => (inputs[i]!.snippet.length || 0) + 1000)
  const avg = Math.max(1, Math.ceil(perQuestion.reduce((a, b) => a + b, 0) / perQuestion.length))
  const stateChars = 500 + pendingIndexes.length * 200
  const size = chunkSizeForBudget(pendingIndexes.length, avg, stateChars, effectiveMaxTokens(caps))
  return chunkIndexes(pendingIndexes.length, Math.max(1, size)).map((chunk) => chunk.map((pos) => pendingIndexes[pos]!))
}

export const createDecisionModel = (opts: DecisionModelOptions): CandidateJudge & { cache: CandidateCache } => {
  const cache = opts.cache ?? createCandidateCache()
  // The codec validates transport shape only. The keep/drop gate lives here,
  // once, in the candidate policy layer — never in transport code.
  const codec = decisionCodecs[opts.provider]
  const modelId = decisionModelId(opts)
  return {
    id: `decision-${opts.provider}`,
    cache,
    judge: async (inputs: readonly JudgeInput[]): Promise<readonly Verdict[]> => {
      if (inputs.length === 0) return []
      const key = resolveDecisionKey(opts)
      // No skip-when-tiny: even 1–2 candidates can both be drops (both-mention
      // prose with zero work). The call is ~1k tokens; keep-all would keep noise.
      if (!key) return inputs.map((input) => ({ key: refKey(input.ref), keep: true, reason: "no key: heuristic fallback" }))
      const fetchFn = opts.fetchFn ?? fetch
      const timeoutMs = opts.timeoutMs ?? DECISION_TIMEOUT_MS
      // One overall budget covers everything below — catalog included — so the
      // total judge is bounded no matter where time goes.
      const deadline = Date.now() + Math.min(180_000, Math.max(30_000, timeoutMs * 2))
      // Query-time canonicalization: a floating ID (Luna without a date,
      // `~jev-latest`) resolves live to its current dated build, and the build
      // — not the alias — keys the verdict cache and the request body. A silent
      // model move therefore misses the old cache instead of reusing thresholds
      // and verdicts tuned for the previous build. Direct zen/openai have no
      // catalog and rely on halve-on-overflow below.
      const caps = await queryCaps(opts, modelId, fetchFn, Math.max(1, deadline - Date.now()))
      const effectiveId = caps?.build ?? modelId
      // The cache scope is the full judge identity: provider + endpoint +
      // canonical build. Titles/states ride inside the key (see cache.ts), so
      // verdicts never leak across evidence, backends, or model moves.
      const scope = `${opts.provider}:${decisionEndpoint(opts)}:${effectiveId}`
      const cacheKeys = inputs.map((input) => candidateCacheKey(input, scope))
      const cachedHits = cacheKeys.map((k) => cache.get(k))
      const pendingIndexes: number[] = []
      cachedHits.forEach((hit, i) => {
        if (!hit) pendingIndexes.push(i)
      })
      if (pendingIndexes.length === 0) {
        return inputs.map((input, i) => {
          const hit = cachedHits[i]!
          return { key: refKey(input.ref), keep: hit.keep, reason: hit.reason, confidence: hit.confidence }
        })
      }
      const queue: number[][] = initialSlices(pendingIndexes, inputs, caps)
      // Sequential one-shots (rate-limit safe). The request body carries the
      // canonical build, never a floating alias. Each slice builds its own
      // payload/questionKeys. Only 413 (overflow) splits slices down to 1: a
      // 422 is a contract mismatch, and fanning it out would multiply invalid
      // requests. Other failures fall back keep-all for that slice.
      // Slices past the single overall deadline fall back keep-all without
      // another network call.
      const byKey = new Map<string, Verdict>()
      const requestModel = effectiveId
      while (queue.length > 0) {
        // Hard deadline: clamp this slice's timeout to the remaining budget
        // so a slice started just before the deadline can't run the full
        // per-request timeout past it.
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const slice = queue.shift()!
        const sliceInputs = slice.map((i) => inputs[i]!)
        const build = codec.build(sliceInputs)
        const body = { model: requestModel, ...(build.payload as object) }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining))
        try {
          const response = await fetchFn(decisionEndpoint(opts), {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          // Consume the body on every path before branching: an unconsumed
          // body keeps the socket allocated, which matters here because
          // overflow slices immediately re-issue on the same host.
          let text: string
          try {
            text = await response.text()
          } catch {
            continue
          }
          if (!response.ok && response.status === 413 && slice.length > 1) {
            const half = Math.ceil(slice.length / 2)
            queue.unshift(slice.slice(half), slice.slice(0, half))
            continue
          }
          if (!response.ok) continue
          let payload: unknown
          try {
            payload = JSON.parse(text)
          } catch {
            continue
          }
          let answers: readonly { key: string; probability: number }[]
          try {
            answers = codec.parse(payload, build.questionKeys)
          } catch {
            continue
          }
          for (const a of answers) {
            const verdict: Verdict = {
              key: a.key,
              keep: a.probability >= KEEP_THRESHOLD,
              reason: `${codec.id} ${a.probability}`,
              confidence: a.probability,
            }
            byKey.set(a.key, verdict)
            const inputIndex = slice[build.questionKeys.indexOf(a.key)]!
            cache.set(cacheKeys[inputIndex]!, { keep: verdict.keep, reason: verdict.reason, confidence: verdict.confidence })
          }
        } catch {
          continue
        } finally {
          clearTimeout(timer)
        }
      }
      return inputs.map((input, i) => {
        const hit = cachedHits[i]
        if (hit) return { key: refKey(input.ref), keep: hit.keep, reason: hit.reason, confidence: hit.confidence }
        if (!pendingIndexes.includes(i)) return { key: refKey(input.ref), keep: true, reason: "no answer: heuristic fallback" }
        const v = byKey.get(refKey(input.ref))
        // Unanswered questions were never cached: keep-all without persisting a drop.
        return v ?? { key: refKey(input.ref), keep: true, reason: "no answer: heuristic fallback" }
      })
    },
  }
}

export { refKey as decisionRefKey }
