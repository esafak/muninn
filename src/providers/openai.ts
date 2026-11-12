/**
 * OpenAI decision backend: the divergent Decisions contract
 * (`POST /api/v1/decisions`, `predicate` array — not the System One map).
 * Owns the OpenAI codec in `src/candidates/codecs/openai.ts`. For Luna
 * through OpenRouter, use `src/providers/openrouter.ts` instead: there Luna
 * speaks the shared `noul`-map contract like every other catalog model.
 */

import { parseOpenAICompatibleModelList } from "../candidates/model-id"
import type { CheckDecisionModel } from "./types"

export const OPENAI_DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions"

export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models"

export const resolveOpenAIKey = (opts: { openaiApiKey?: string }): string | undefined => {
  const key = opts.openaiApiKey ?? process.env.OPENAI_API_KEY
  return typeof key === "string" && key.trim() ? key.trim() : undefined
}

/** Live check against OpenAI's models endpoint (requires a key). Total:
 * missing key, unreachable endpoint, and unusable payloads report
 * `unreachable` — callers fall back to the known set. Presence confirms
 * the ID is real, not that it speaks the decisions contract. */
export const checkOpenAIModel: CheckDecisionModel = async (key, modelId, fetchFn = fetch, signal) => {
  const wanted = modelId.trim()
  if (!wanted) return { outcome: "not-found" }
  if (typeof key !== "string" || !key.trim()) return { outcome: "unreachable" }
  try {
    const response = await fetchFn(OPENAI_MODELS_URL, {
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
