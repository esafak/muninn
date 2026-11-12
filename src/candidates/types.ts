/**
 * Narrow seams for candidate processing.
 *
 * Heuristics stay the cheap sieve and the model judges as an extra tool.
 * The model is a relevance signal, never a ranker: deterministic code in
 * `window.tsx` combines the signal with heuristic provenance and explicit
 * user intent (pin) in one selection policy.
 *
 * - Extraction is a pure function (`heuristicExtract`, GUI-safe, no
 *   network). The result type below is the seam; no source interface until
 *   a second source exists.
 * - `CandidateJudge` owns relevance verdicts over enriched inputs. It
 *   returns a keep/drop signal per answered question; unanswered questions
 *   are omitted so callers fall back to keep-all without caching a drop.
 * - `DecisionCodec` is the wire adapter for a direct System One `noul`-map
 *   response (kept as a reference pin; the server path in `server-judge.ts`
 *   maps the normalized predicate array instead). It validates transport
 *   shape and returns raw probabilities; the keep/drop gate lives once in
 *   the candidate policy layer, never in transport code.
 *
 * Decision models are addressed as Model.Ref provider IDs (openai, openrouter,
 * opencode, google) and judged through OpenCode generate.decisions - the
 * plugin holds no keys. Forge SourceProviders (src/providers/*,
 * host-dispatched hydration) are a separate seam. DECISION_BACKENDS below is
 * the deprecated legacy enum, kept for compat only.
 */

import type { TieredRef } from "../extract"

/** Decision backends the judge can route to. Pinned model IDs live in settings. */
export const DECISION_BACKENDS = ["zen", "openrouter", "openai"] as const

export type DecisionBackend = (typeof DECISION_BACKENDS)[number]

export const isDecisionBackend = (value: string): value is DecisionBackend =>
  (DECISION_BACKENDS as readonly string[]).includes(value)

export interface CandidateSnippet {
  /** The exact bucket string that yielded the ref. */
  text: string
  /** Invoking command for tool outputs (`gh pr view 3670` vs `gh pr list`). */
  command?: string
}

export interface JudgeInput {
  ref: TieredRef
  snippet: string
  command?: string
  /** Post-hydration enrichment: titles/states make listing-vs-work decidable. */
  title?: string
  state?: string
}

export interface Verdict {
  /** `refKey(ref)` — stable across sessions and providers. */
  key: string
  keep: boolean
  reason?: string
  /** Raw Noul probability (0–1) when the judge is a decision model. */
  confidence?: number
}

export interface CandidateJudge {
  readonly id: string
  judge(inputs: readonly JudgeInput[]): Promise<readonly Verdict[]> | readonly Verdict[]
}

export interface SchemaBuild {
  payload: unknown
  /** Question IDs (Jev map keys) or names (OpenAI array) in request order. */
  questionKeys: string[]
}

/** One validated model answer. Missing questions are omitted, never defaulted. */
export interface ScoredAnswer {
  key: string
  /** Calibrated P(yes), always within [0, 1]. */
  probability: number
}

export interface DecisionCodec {
  readonly id: "jev" | "openai"
  build(inputs: readonly JudgeInput[]): SchemaBuild
  /** Returns only answered questions; throws on invalid shape or range. */
  parse(response: unknown, questionKeys: readonly string[]): readonly ScoredAnswer[]
}
