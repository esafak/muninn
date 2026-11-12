/**
 * OpenAI decision backend: the divergent Decisions contract
 * (`POST /api/v1/decisions`, `predicate` array — not the System One map).
 * Owns the OpenAI codec in `src/candidates/codecs/openai.ts`. For Luna
 * through OpenRouter, use `src/providers/openrouter.ts` instead: there Luna
 * speaks the shared `noul`-map contract like every other catalog model.
 */

export const OPENAI_DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions"

export const resolveOpenAIKey = (opts: { openaiApiKey?: string }): string | undefined => {
  const key = opts.openaiApiKey ?? process.env.OPENAI_API_KEY
  return typeof key === "string" && key.trim() ? key.trim() : undefined
}
