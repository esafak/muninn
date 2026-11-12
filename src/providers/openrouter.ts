/**
 * OpenRouter decision backend: one Decisions API for every decision model in
 * the live catalog (`POST /api/v1/systemone`, TypeSafe-SDK compatible).
 * Any catalog ID works with the shared Jev `noul`-map codec — including
 * `openai/gpt-6-luna-decisions`, which speaks the divergent predicate
 * contract only on OpenAI's own endpoint (see `../openai/decisions`).
 */

import type { CheckDecisionModel } from "./types"

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

/** Catalog check: found (with caps when the entry reports a usable window),
 * not-found (reachable catalog without the ID), or unreachable (network,
 * non-OK, or malformed payload — never evidence of absence). The catalog
 * is public, so the key is ignored. */
export const checkOpenRouterModel: CheckDecisionModel = async (_opts, modelId, fetchFn = fetch, signal) => {
  const wanted = modelId.trim()
  if (!wanted) return { outcome: "not-found" }
  try {
    const response = await fetchFn(OPENROUTER_CATALOG_URL, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) })
    if (!response.ok) return { outcome: "unreachable" }
    const payload = (await response.json()) as { data?: CatalogModel[] }
    if (!Array.isArray(payload.data)) return { outcome: "unreachable" }
    const found = matchCatalogEntry(payload.data, wanted)
    if (!found) return { outcome: "not-found" }
    return {
      outcome: "found",
      canonical: found.build,
      ...(found.entry.context_length && found.entry.context_length > 0
        ? { contextLength: found.entry.context_length }
        : {}),
    }
  } catch {
    return { outcome: "unreachable" }
  }
}

const matchCatalogEntry = (entries: CatalogModel[], wanted: string): { entry: CatalogModel; build: string } | undefined => {
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
  return { entry: resolved, build: resolved.canonical_slug ?? targetSlug ?? resolved.id }
}
