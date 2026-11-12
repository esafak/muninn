/**
 * OpenRouter decision backend: one Decisions API for every decision model in
 * the live catalog (`POST /api/v1/systemone`, TypeSafe-SDK compatible).
 * Any catalog ID works with the shared Jev `noul`-map codec — including
 * `openai/gpt-6-luna-decisions`, which speaks the divergent predicate
 * contract only on OpenAI's own endpoint (see `../openai/decisions`).
 */

import type { ModelCaps } from "../candidates/model-caps"

export const OPENROUTER_DECISIONS_ENDPOINT = "https://openrouter.ai/api/v1/systemone"

const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions"

interface CatalogModel {
  id: string
  canonical_slug?: string
  alias_target?: { slug?: string }
  context_length?: number
}

export const resolveOpenRouterKey = (opts: { openrouterApiKey?: string }): string | undefined => {
  const key = opts.openrouterApiKey ?? process.env.OPENROUTER_API_KEY
  return typeof key === "string" && key.trim() ? key.trim() : undefined
}

/**
 * Live resolve + canonicalize: a floating ID or alias follows to its current
 * dated build, and callers send and cache on the build — never the alias.
 * No hardcoded fallback: undefined when unreachable.
 */
export const resolveOpenRouterCaps = async (
  modelId: string,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<ModelCaps | undefined> => {
  const wanted = modelId.trim()
  if (!wanted) return undefined
  const response = await fetchFn(OPENROUTER_CATALOG_URL, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) })
  if (!response.ok) return undefined
  const payload = (await response.json()) as { data?: CatalogModel[] }
  const entries = Array.isArray(payload.data) ? payload.data : []
  const bare = wanted.includes("/") ? wanted.split("/").pop()! : wanted
  const match =
    entries.find((e) => e.id === wanted) ??
    entries.find((e) => e.canonical_slug === wanted) ??
    entries.find((e) => e.id === `typesafe/${bare}`) ??
    entries.find((e) => e.id.endsWith(`/${bare}`))
  if (!match) return undefined
  // Aliases carry no window of their own: follow to the pinned target entry.
  const targetSlug = match.alias_target?.slug
  const target = targetSlug ? entries.find((e) => e.id === targetSlug || e.canonical_slug === targetSlug) : undefined
  const resolved = target ?? match
  if (!resolved.context_length || resolved.context_length <= 0) return undefined
  return {
    contextLength: resolved.context_length,
    build: resolved.canonical_slug ?? targetSlug ?? resolved.id,
    resolvedAt: now,
    source: "live",
  }
}
