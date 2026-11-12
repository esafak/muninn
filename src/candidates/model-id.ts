/**
 * Model-ID checks: pure and GUI-safe (no network, no Node).
 *
 * Syntax only: whether a string is shaped like a decision-model ID.
 * Existence is checked server-side (`resolveModel` RPC) against OpenCode's
 * registry. An unknown-but-well-formed ID stays usable — judging fails
 * open to heuristic keep-all, so validation warns, never blocks.
 */

import { defaultModelForProvider } from "../providers/decision-catalog"
import type { DecisionBackend } from "./types"

export const MODEL_ID_MAX_LENGTH = 128

const BASE_PATTERN = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9])$/
const VARIANT_PATTERN = /^[A-Za-z0-9._-]+$/

/** Whether the raw field value is shaped like a model ID (trimmed first). */
export const validateModelSyntax = (model: string): { ok: true } | { ok: false; reason: string } => {
  const trimmed = model.trim()
  if (!trimmed) return { ok: false, reason: "empty: leave blank to use the provider default" }
  if (trimmed.length > MODEL_ID_MAX_LENGTH)
    return { ok: false, reason: `too long: ${trimmed.length} characters (max ${MODEL_ID_MAX_LENGTH})` }
  if (/\s/.test(trimmed)) return { ok: false, reason: "must not contain spaces" }
  if (trimmed.includes("://")) return { ok: false, reason: "looks like a URL: enter the model ID, not an endpoint" }
  const colon = trimmed.indexOf(":")
  const head = colon === -1 ? trimmed : trimmed.slice(0, colon)
  const tail = colon === -1 ? "" : trimmed.slice(colon + 1)
  if (colon !== -1 && (trimmed.indexOf(":", colon + 1) !== -1 || !VARIANT_PATTERN.test(tail)))
    return { ok: false, reason: "at most one :variant suffix (e.g. model:free)" }
  if (head.includes("//")) return { ok: false, reason: "must not contain //" }
  if (!BASE_PATTERN.test(head))
    return { ok: false, reason: "use letters, numbers, dot, dash, underscore, slash (e.g. jev-1.13, typesafe/jev-1.13)" }
  return { ok: true }
}

/** Blank-field default for a provider ID. `undefined` = no verified default:
 * callers must require an explicit model instead of inventing one. */
export { defaultModelForProvider } from "../providers/decision-catalog"

/**
 * @deprecated Use `defaultModelForProvider(providerID)` from the
 * provider-layer catalog. Kept so the legacy `zen|openrouter|openai`
 * backend enum keeps resolving during migration.
 */
export const defaultModelFor = (provider: DecisionBackend): string =>
  defaultModelForProvider(provider) ?? "jev-1.13"

/** IDs from an OpenAI-compatible `/models` list payload (`{data:[{id}]}`). */
export const parseOpenAICompatibleModelList = (payload: unknown): string[] => {
  if (typeof payload !== "object" || payload === null) return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== "string" || !id.trim()) continue
    ids.push(id.trim())
  }
  return ids
}
