/**
 * Capability budgeting helpers (pure, testable). Live resolution lives with
 * each decision backend under `src/providers/*` (OpenRouter owns the catalog
 * query); chunking fits the estimated request into ~80% of the cached
 * window, and unknown caps proceed as one slice with halve-on-overflow.
 * No network in tests: only these pure helpers are tested.
 */

export const CAPS_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ModelCaps {
  contextLength: number
  maxPromptTokens?: number
  build?: string
  resolvedAt: number
  source: "live"
}

export const capsKey = (provider: string, modelId: string): string => `caps/${provider}/${modelId}`

export const isCapsFresh = (resolvedAt: number, now = Date.now(), ttlMs = CAPS_TTL_MS): boolean =>
  Number.isFinite(resolvedAt) && now - resolvedAt < ttlMs

export const effectiveMaxTokens = (caps: ModelCaps): number =>
  Math.min(caps.contextLength, caps.maxPromptTokens ?? caps.contextLength)

/** How many questions fit in ~80% of the window given per-question chars. At least 1. */
export const chunkSizeForBudget = (
  questionCount: number,
  charsPerQuestion: number,
  stateChars: number,
  maxInputTokens: number,
): number => {
  if (questionCount <= 0) return 1
  const budgetChars = Math.floor(maxInputTokens * 0.8 * 4)
  const perQuestion = Math.max(1, charsPerQuestion)
  const size = Math.floor((budgetChars - stateChars) / perQuestion)
  if (!Number.isFinite(size) || size <= 0) return 1
  return Math.min(questionCount, size)
}
