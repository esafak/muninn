import { describe, expect, test } from "bun:test"
import {
  decisionProviderIds,
  DEFAULT_DECISION_PROVIDER_ID,
  defaultModelForProvider,
  isAuthoritativeProvider,
  knownModelsForProvider,
} from "./decision-catalog"

describe("decision catalog", () => {
  test("verified provider defaults", () => {
    expect(defaultModelForProvider("opencode")).toBe("jev-1.13")
    expect(defaultModelForProvider("openrouter")).toBe("typesafe/jev-1.14")
    expect(defaultModelForProvider("openai")).toBe("gpt-6-luna-decision")
    expect(defaultModelForProvider("google")).toBe("gemini-decision-1")
  })

  test("unknown providers have no default and no known models", () => {
    expect(defaultModelForProvider("acme")).toBeUndefined()
    expect(knownModelsForProvider("acme")).toEqual([])
    expect(isAuthoritativeProvider("acme")).toBe(false)
  })

  test("known decision models per provider", () => {
    expect(knownModelsForProvider("opencode")).toContain("jev-1.13-free")
    expect(knownModelsForProvider("opencode")).toContain("gemini-decision-1")
    expect(knownModelsForProvider("openai")).toEqual(["gpt-6-luna-decision"])
    expect(knownModelsForProvider("google")).toEqual(["gemini-decision-1"])
    expect(knownModelsForProvider("openrouter")).toEqual(
      expect.arrayContaining([
        "typesafe/jev-1.13",
        "typesafe/jev-1.14",
        "openai/gpt-6-luna-decisions",
        "google/gemini-decision-1",
        "cloudflare/clef",
        "cloudflare/clef-flash",
        "cloudflare/clef-omni",
        "cloudflare/clairic",
      ]),
    )
  })

  test("authoritative flags match the plan's verification policy", () => {
    expect(isAuthoritativeProvider("openrouter")).toBe(true)
    expect(isAuthoritativeProvider("openai")).toBe(true)
    expect(isAuthoritativeProvider("opencode")).toBe(false)
    expect(isAuthoritativeProvider("google")).toBe(false)
  })

  test("registry IDs cover every catalogued provider", () => {
    expect(decisionProviderIds().sort()).toEqual(["google", "openai", "opencode", "openrouter"])
  })

  test("default provider is catalogued and has a default model", () => {
    expect(decisionProviderIds()).toContain(DEFAULT_DECISION_PROVIDER_ID)
    const model = defaultModelForProvider(DEFAULT_DECISION_PROVIDER_ID)
    expect(typeof model).toBe("string")
    expect(model!.length).toBeGreaterThan(0)
  })
})
