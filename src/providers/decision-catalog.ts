/**
 * Provider-layer decision catalog: which providers serve decision models,
 * their defaults, known IDs, and whether their list is decision-complete.
 * Pure and GUI-safe: this file must never import network or Node modules.
 * Shared candidate code reads through the lookup functions below — no
 * backend tables anywhere else (per AGENTS.md provider-agnosticism).
 *
 * Evidence (docs, not runtime): OpenCode providers docs (`openai` ChatGPT
 * sub + key, `openrouter` key account), Console models table
 * (`opencode/jev-1.13`, `opencode/jev-1.13-free`,
 * `opencode/gpt-6-luna-decision`, `opencode/gemini-decision-1` served on
 * `.../inference/systemone/v1/systemone`), OpenRouter decisions catalog
 * (`output_modalities=decisions`; verified live 2026-11-12, 39 models — incl.
 * `typesafe/jev-1.14`, `openai/gpt-6-luna-decisions`, `google/gemini-decision-1`,
 * `cloudflare/clef{,-flash,-omni}`, `cloudflare/clairic`, plus perplexity/liquid/
 * upstage/microsoft/nace/morph/baseten/respan/togethercomputer families, some with
 * `~`-prefixed floating aliases; any of the 39 validates `live` when discovery
 * succeeds, no catalog change needed to use them), Google Decisions API docs
 * (`gemini-decision-1`;
 * Cloud support "coming soon" — Vertex unsupported), Cloudflare Workers AI
 * docs (`clef`/`clef-flash`, max 64 questions). Live integration/provider IDs
 * still need runtime verification (plan Phase 0); unobserved rows stay out.
 */

export interface DecisionProviderEntry {
  /** Model used when the field is blank. Absent = no default: callers must
   * ask for an explicit model instead of inventing one. */
  readonly defaultModel?: string
  /** IDs treated as known when a live list is unreachable or incomplete. */
  readonly knownModels: readonly string[]
  /** True only when the provider's list is proven decision-complete: a
   * reachable miss means the ID is wrong (invalid), not merely unseen. */
  readonly authoritativeList: boolean
}

const catalog: Record<string, DecisionProviderEntry> = {
  opencode: {
    defaultModel: "jev-1.13",
    knownModels: ["jev-1.13", "jev-1.13-free", "gpt-6-luna-decision", "gemini-decision-1"],
    authoritativeList: false,
  },
  openrouter: {
    defaultModel: "typesafe/jev-1.14",
    knownModels: [
      "typesafe/jev-1.13",
      "typesafe/jev-1.14",
      "openai/gpt-6-luna-decisions",
      "google/gemini-decision-1",
      "cloudflare/clef",
      "cloudflare/clef-flash",
      "cloudflare/clef-omni",
      "cloudflare/clairic",
    ],
    authoritativeList: true,
  },
  openai: {
    defaultModel: "gpt-6-luna-decision",
    knownModels: ["gpt-6-luna-decision"],
    authoritativeList: true,
  },
  google: {
    defaultModel: "gemini-decision-1",
    knownModels: ["gemini-decision-1"],
    authoritativeList: false,
  },
}

/** Provider IDs with a decision entry, for settings pickers. */
export const decisionProviderIds = (): string[] => Object.keys(catalog)

/** Blank-field default. `undefined` = no default: require an explicit model. */
export const defaultModelForProvider = (providerID: string): string | undefined =>
  catalog[providerID]?.defaultModel

export const knownModelsForProvider = (providerID: string): readonly string[] =>
  catalog[providerID]?.knownModels ?? []

export const isAuthoritativeProvider = (providerID: string): boolean =>
  catalog[providerID]?.authoritativeList ?? false

/** Display label for resolve messages. Unknown IDs render raw. */
export const decisionProviderLabel = (providerID: string): string => {
  switch (providerID) {
    case "opencode":
      return "Console"
    case "openrouter":
      return "OpenRouter"
    case "openai":
      return "OpenAI"
    case "google":
      return "Google"
    default:
      return providerID
  }
}
