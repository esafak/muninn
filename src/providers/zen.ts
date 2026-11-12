/**
 * Zen decision backend: TypeSafe Jev served through the OpenCode Console
 * (`POST /api/v1/systemone`, same `noul`-map contract as OpenRouter).
 * Shares the Jev codec in `src/candidates/codecs/jev.ts`.
 */

export const ZEN_DECISIONS_ENDPOINT = "https://opencode.ai/zen/v1/systemone"

export const resolveZenKey = (opts: { zenApiKey?: string; apiKey?: string }): string | undefined => {
  const key = opts.zenApiKey ?? opts.apiKey ?? process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_CONSOLE_API_KEY
  return typeof key === "string" && key.trim() ? key.trim() : undefined
}
