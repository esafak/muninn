/**
 * Zen decision backend: TypeSafe Jev served through the OpenCode Console
 * (`POST /api/v1/systemone`, same `noul`-map contract as OpenRouter).
 * Shares the Jev codec in `src/candidates/codecs/jev.ts`.
 */

import { parseOpenAICompatibleModelList } from "../candidates/model-id"
import type { CheckDecisionModel } from "./types"

export const ZEN_DECISIONS_ENDPOINT = "https://opencode.ai/zen/v1/systemone"

export const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models"

export const resolveZenKey = (opts: { zenApiKey?: string }): string | undefined => {
  const key = opts.zenApiKey ?? process.env.OPENCODE_ZEN_API_KEY
  return typeof key === "string" && key.trim() ? key.trim() : undefined
}

/** Live check against the Zen models endpoint. Resolves its own key from
 * opts; missing key, unreachable endpoint, and unusable payloads report
 * `unreachable` — callers fall back to the known set. */
export const checkZenModel: CheckDecisionModel = async (opts, modelId, fetchFn = fetch, signal) => {
  const wanted = modelId.trim()
  if (!wanted) return { outcome: "not-found" }
  const key = resolveZenKey(opts)
  if (!key) return { outcome: "unreachable" }
  try {
    const response = await fetchFn(ZEN_MODELS_URL, {
      headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) return { outcome: "unreachable" }
    const ids = parseOpenAICompatibleModelList(await response.json())
    if (ids.length === 0) return { outcome: "unreachable" }
    return ids.includes(wanted) ? { outcome: "found", canonical: wanted } : { outcome: "not-found" }
  } catch {
    return { outcome: "unreachable" }
  }
}
