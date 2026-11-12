/**
 * Server-side judge adapter: pure builders/mappers between Muninn's
 * JudgeInputs and OpenCode's normalized `experimental.generate.decisions`
 * boundary (`{ model: { providerID, id }, input: blocks[], questions: [] }`
 * in, `{ answers: [{ type: "predicate", name, probability } | { type:
 * "error", ... }] }` out — see @opencode/client 2.2.6 generated types).
 * No fetch, no env, no endpoints: the server resolves the user's connected
 * account (ChatGPT/Codex OAuth, OpenRouter key, Console/Go, Gemini API).
 *
 * Transport names are `q{i}` (`q0..q63`), never `refKey`: refKeys contain
 * `/`, `.`, `#` (`github.com/owner/repo#pr123`, `@#123`) rejected by native
 * question-key limits, and the System One protocol passes `question.name`
 * straight into the native map. `names[i]` is the explicit map back.
 */

import { refKey } from "../model"
import { trackInstruction } from "./constants"
import type { JudgeInput } from "./types"

export interface ServerJudgeQuestion {
  readonly type: "predicate"
  readonly name: string
  readonly instructions: string
}

/** JSON-safe state block (a `type` alias, so it stays assignable to JsonValue). */
export type ServerJudgeCandidate = {
  key: string
  kind: string
  number: number
  tier: string
  command: string | null
  snippet: string
  title: string | null
  state: string | null
}

export type ServerJudgeState = {
  task: string
  candidates: ServerJudgeCandidate[]
}

export interface ServerJudgeRequest {
  readonly input: readonly [{ readonly type: "json"; readonly value: ServerJudgeState }]
  readonly questions: readonly ServerJudgeQuestion[]
  /** `names[i]` is the refKey for `questions[i]` (`q{i}`). */
  readonly names: readonly string[]
}

/** Transport name for the i-th input. Matches `[A-Za-z0-9_-]{1,64}`. */
export const transportName = (index: number): string => `q${index}`

/** One shared `json` state block + one `predicate` question per input. */
export const buildServerJudgeRequest = (inputs: readonly JudgeInput[]): ServerJudgeRequest => {
  const state = {
    task: "Decide which session references merit tracking in pill and sidebar. Mentioned or encountered is not enough.",
    candidates: inputs.map((input) => ({
      key: refKey(input.ref),
      kind: input.ref.kind ?? "unknown",
      number: input.ref.number,
      tier: input.ref.tier,
      command: input.command ?? null,
      snippet: input.snippet.slice(0, 800),
      title: input.title ?? null,
      state: input.state ?? null,
    })),
  }
  return {
    input: [{ type: "json", value: state }],
    questions: inputs.map((input, i) => ({
      type: "predicate" as const,
      name: transportName(i),
      instructions: trackInstruction({
        number: input.ref.number,
        kind: input.ref.kind,
        tier: input.ref.tier,
        snippet: input.snippet,
        command: input.command,
        title: input.title,
        state: input.state,
      }),
    })),
    names: inputs.map((input) => refKey(input.ref)),
  }
}

/** Raw shape accepted from the server boundary (structural, SDK-free). */
export type RawDecisionAnswer =
  | { readonly type: "predicate"; readonly name: string; readonly probability: number }
  | { readonly type: "error"; readonly name: string; readonly reason?: string; readonly message?: string }
  | { readonly type: string; readonly name?: unknown; readonly probability?: unknown }

export interface ServerJudgeAnswer {
  readonly key: string
  readonly probability: number
}

/** Keep answered predicates that map back to an input; drop errors,
 * malformed/out-of-bounds names, and out-of-range probabilities. Missing
 * indices are omitted: callers fail open keep-all and never cache a drop. */
export const mapServerJudgeAnswers = (
  answers: readonly RawDecisionAnswer[],
  names: readonly string[],
): ServerJudgeAnswer[] => {
  const out: ServerJudgeAnswer[] = []
  for (const answer of answers) {
    if (!answer || typeof answer !== "object") continue
    if (answer.type !== "predicate") continue
    if (typeof answer.name !== "string") continue
    const match = /^q(\d+)$/.exec(answer.name)
    if (!match) continue
    const index = Number(match[1])
    if (!Number.isInteger(index) || index < 0 || index >= names.length) continue
    const probability = (answer as { probability?: unknown }).probability
    if (typeof probability !== "number" || !(probability >= 0) || !(probability <= 1)) continue
    out.push({ key: names[index]!, probability })
  }
  return out
}

export type ResolveStatus = "default" | "live" | "known" | "unverified" | "invalid"

export interface ResolveModelEvidence {
  /** Trimmed model input ("" when blank). */
  readonly requested: string
  /** Blank-field default, when the provider has a verified one. */
  readonly defaultModel?: string
  /** Whether the registry lists the requested model. */
  readonly listed: boolean
  /** Decision capability: true = explicitly decision-capable, false =
   * explicitly another type, undefined = unknown/missing evidence. */
  readonly decisionCapable?: boolean
  /** Whether the provider is available in this location/project. */
  readonly providerAvailable: boolean
  /** Whether the model list was read successfully. Unknown models stay
   * unverified when discovery failed — absence proves nothing. */
  readonly modelsListed: boolean
  readonly knownModels: readonly string[]
  readonly authoritativeList: boolean
}

/** Pure status policy. "live" means *available in OpenCode*, never
 * endpoint-verified; unknown capability never blocks (unverified). */
export const resolveModelStatus = (
  evidence: ResolveModelEvidence,
): { status: ResolveStatus; canonical?: string } => {
  if (!evidence.requested) {
    if (evidence.defaultModel) return { status: "default", canonical: evidence.defaultModel }
    return { status: "unverified" }
  }
  if (evidence.listed && evidence.decisionCapable === true)
    return { status: "live", canonical: evidence.requested }
  if (evidence.listed && evidence.decisionCapable === false) return { status: "invalid" }
  if (evidence.listed) return { status: "unverified", canonical: evidence.requested }
  // Catalogued models stay known through discovery outages: a failed read
  // (or a disconnected provider) never demotes a known ID.
  if (evidence.knownModels.includes(evidence.requested))
    return { status: "known", canonical: evidence.requested }
  if (!evidence.providerAvailable) return { status: "unverified", canonical: evidence.requested }
  // Discovery failed: the miss proves nothing, even on authoritative lists.
  if (!evidence.modelsListed) return { status: "unverified", canonical: evidence.requested }
  if (evidence.authoritativeList) return { status: "invalid" }
  return { status: "unverified", canonical: evidence.requested }
}

/** Minimal registry shape for canonical identity. `id` is the selectable
 * catalog ID; `modelID` is the ID sent to the provider. They differ for
 * aliases and deployments. */
export interface RegistryModel {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  /** Model type when the registry reports one ("decision", "chat", ...). */
  readonly type?: string
  readonly contextLength?: number
}

/** Prefer the catalog `id`, fall back to the provider-sent `modelID`. */
export const matchRegistryModel = (
  models: readonly RegistryModel[],
  providerID: string,
  requested: string,
): RegistryModel | undefined =>
  models.find((m) => m.providerID === providerID && m.id === requested) ??
  models.find((m) => m.providerID === providerID && m.modelID === requested)

/** Minimal structural projection of the registry's model entries. */
export const toRegistryModels = (
  entries: readonly {
    readonly id: string
    readonly modelID: string
    readonly providerID: string
    readonly type?: string
    readonly limit: { readonly context: number }
  }[],
): RegistryModel[] =>
  entries.map((m) => ({
    id: m.id,
    modelID: m.modelID,
    providerID: m.providerID,
    ...(m.type !== undefined ? { type: m.type } : {}),
    ...(m.limit.context > 0 ? { contextLength: m.limit.context } : {}),
  }))

export interface ServerJudgeVerdict {
  readonly key: string
  readonly keep: boolean
  readonly reason: string
  readonly confidence: number
}

/** Keep/drop gate: keep at or above threshold; confidence IS the yes
 * probability (preserves the RPC semantics — native confidence in the
 * winning answer differs for negative decisions). */
export const buildVerdict = (key: string, probability: number, threshold: number): ServerJudgeVerdict => ({
  key,
  keep: probability >= threshold,
  reason: `predicate ${probability}`,
  confidence: probability,
})
