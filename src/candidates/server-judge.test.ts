import { describe, expect, test } from "bun:test"
import { refKey } from "../model"
import type { JudgeInput } from "./types"
import {
  buildServerJudgeRequest,
  buildVerdict,
  mapServerJudgeAnswers,
  matchRegistryModel,
  resolveModelStatus,
  toRegistryModels,
  transportName,
} from "./server-judge"

const input = (overrides: Partial<JudgeInput> = {}): JudgeInput => ({
  ref: { number: 123, kind: "pr", tier: "user", repo: { host: "github.com", owner: "acme", repo: "app" } },
  snippet: "fixes #123 in the checkout flow",
  ...overrides,
})

describe("transportName", () => {
  test("uses bounded q{i} names, never refKeys", () => {
    expect(transportName(0)).toBe("q0")
    expect(transportName(63)).toBe("q63")
    for (let i = 0; i < 64; i++) expect(transportName(i)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })
})

describe("buildServerJudgeRequest", () => {
  test("emits one json state block plus one predicate per input with mapped names", () => {
    const inputs = [
      input(),
      input({ ref: { number: 7, tier: "prose" }, snippet: "mentions 7 in passing" }),
    ]
    const built = buildServerJudgeRequest(inputs)
    expect(built.input).toHaveLength(1)
    expect(built.input[0]!.type).toBe("json")
    expect(built.questions).toHaveLength(2)
    expect(built.questions.map((q) => q.name)).toEqual(["q0", "q1"])
    for (const q of built.questions) expect(q.type).toBe("predicate")
    expect(built.names).toEqual(inputs.map((i) => refKey(i.ref)))
    // Instructions carry the evidence, never the transport name.
    expect(built.questions[0]!.instructions).toContain("fixes #123")
    expect(built.questions[1]!.instructions).toContain("mentions 7")
  })

  test("state block carries the full candidate evidence with truncated snippets", () => {
    const long = "x".repeat(2000)
    const built = buildServerJudgeRequest([
      input({ snippet: long, command: "gh pr view 1", title: "Big fix", state: "open" }),
    ])
    const state = built.input[0]!.value as {
      task: string
      candidates: { key: string; kind: string; number: number; tier: string; command: string | null; snippet: string; title: string | null; state: string | null }[]
    }
    expect(state.task).toContain("pill and sidebar")
    expect(state.candidates).toHaveLength(1)
    expect(state.candidates[0]!.snippet).toHaveLength(800)
    expect(state.candidates[0]!.command).toBe("gh pr view 1")
    expect(state.candidates[0]!.title).toBe("Big fix")
    expect(state.candidates[0]!.state).toBe("open")
    expect(built.questions[0]!.instructions).toContain("Big fix")
  })

  test("repo-less refs still build (transport name stays bounded)", () => {
    const bare = input({ ref: { number: 9, tier: "output" } })
    const built = buildServerJudgeRequest([bare])
    expect(built.questions[0]!.name).toBe("q0")
    expect(built.names).toEqual([refKey(bare.ref)])
  })
})

describe("mapServerJudgeAnswers", () => {
  test("round-trips q0 to the first input's refKey", () => {
    const inputs = [input(), input({ ref: { number: 7, tier: "prose" } })]
    const { names } = buildServerJudgeRequest(inputs)
    expect(mapServerJudgeAnswers([{ type: "predicate", name: "q0", probability: 0.8 }], names)).toEqual([
      { key: refKey(inputs[0]!.ref), probability: 0.8 },
    ])
  })

  test("drops errors, unknown names, refKeys-as-names, and out-of-range probabilities", () => {
    const { names } = buildServerJudgeRequest([input()])
    const key = refKey(input().ref)
    expect(
      mapServerJudgeAnswers(
        [
          { type: "error", name: "q0", reason: "nope" },
          { type: "predicate", name: "q99", probability: 0.9 },
          { type: "predicate", name: key, probability: 0.9 },
          { type: "predicate", name: "nope", probability: 0.9 },
          { type: "predicate", name: "q0", probability: 7 },
          { type: "predicate", name: "q0", probability: -0.1 },
        ],
        names,
      ),
    ).toEqual([])
  })

  test("omits missing indices: only q1 answered", () => {
    const first = input()
    const second = input({ ref: { number: 7, kind: "issue" as const, tier: "prose" as const } })
    const { names } = buildServerJudgeRequest([first, second])
    expect(names[0]).not.toBe(names[1])
    expect(mapServerJudgeAnswers([{ type: "predicate", name: "q1", probability: 0.4 }], names)).toEqual([
      { key: names[1]!, probability: 0.4 },
    ])
  })

  test("keeps boundary probabilities 0 and 1", () => {
    const first = input()
    const second = input({ ref: { number: 7, kind: "issue" as const, tier: "prose" as const } })
    const { names } = buildServerJudgeRequest([first, second])
    expect(
      mapServerJudgeAnswers(
        [
          { type: "predicate", name: "q1", probability: 0 },
          { type: "predicate", name: "q0", probability: 1 },
        ],
        names,
      ),
    ).toEqual([
      { key: names[1]!, probability: 0 },
      { key: names[0]!, probability: 1 },
    ])
  })
})

describe("buildVerdict", () => {
  test("gates at the threshold and reports probability as confidence", () => {
    expect(buildVerdict("k", 0.7, 0.7)).toEqual({ key: "k", keep: true, reason: "predicate 0.7", confidence: 0.7 })
    expect(buildVerdict("k", 0.69, 0.7)).toEqual({ key: "k", keep: false, reason: "predicate 0.69", confidence: 0.69 })
    // A low yes-probability stays a drop even though native confidence in the
    // winning (no) answer would be high: confidence is P(yes), not certainty.
    expect(buildVerdict("k", 0.02, 0.7).confidence).toBe(0.02)
  })
})

describe("matchRegistryModel", () => {
  const entry = (overrides = {}) => ({
    id: "canon",
    modelID: "upstream-build",
    providerID: "openrouter",
    ...overrides,
  })

  test("prefers the catalog id, falls back to the provider-sent modelID", () => {
    expect(matchRegistryModel([entry()], "openrouter", "canon")?.id).toBe("canon")
    expect(matchRegistryModel([entry()], "openrouter", "upstream-build")?.id).toBe("canon")
    expect(matchRegistryModel([entry()], "openrouter", "other")).toBeUndefined()
    expect(matchRegistryModel([entry()], "openai", "canon")).toBeUndefined()
  })

  test("toRegistryModels keeps usable context windows only", () => {
    const [good, bad] = toRegistryModels([
      { id: "a", modelID: "a", providerID: "p", type: "decision", limit: { context: 100 } },
      { id: "b", modelID: "b", providerID: "p", limit: { context: 0 } },
    ])
    expect(good).toEqual({ id: "a", modelID: "a", providerID: "p", type: "decision", contextLength: 100 })
    expect(bad).toEqual({ id: "b", modelID: "b", providerID: "p" })
  })
})

describe("resolveModelStatus", () => {
  const base = {
    requested: "gemini-decision-1",
    listed: false,
    providerAvailable: true,
    modelsListed: true,
    knownModels: ["gemini-decision-1"],
    authoritativeList: false,
  }

  test("blank resolves to the verified default, or unverified without one", () => {
    expect(resolveModelStatus({ ...base, requested: "", defaultModel: "jev-1.13" })).toEqual({
      status: "default",
      canonical: "jev-1.13",
    })
    expect(resolveModelStatus({ ...base, requested: "" })).toEqual({ status: "unverified" })
  })

  test("listed decision-capable is live; listed other-type is invalid; unknown capability is unverified", () => {
    expect(resolveModelStatus({ ...base, listed: true, decisionCapable: true })).toEqual({
      status: "live",
      canonical: "gemini-decision-1",
    })
    expect(resolveModelStatus({ ...base, listed: true, decisionCapable: false })).toEqual({ status: "invalid" })
    expect(resolveModelStatus({ ...base, listed: true })).toEqual({
      status: "unverified",
      canonical: "gemini-decision-1",
    })
  })

  test("unlisted known is known; unlisted unknown is invalid only on authoritative lists", () => {
    expect(resolveModelStatus(base)).toEqual({ status: "known", canonical: "gemini-decision-1" })
    expect(resolveModelStatus({ ...base, requested: "nope", authoritativeList: true })).toEqual({ status: "invalid" })
    expect(resolveModelStatus({ ...base, requested: "nope" })).toEqual({
      status: "unverified",
      canonical: "nope",
    })
  })

  test("failed model discovery never reports invalid", () => {
    expect(resolveModelStatus({ ...base, requested: "nope", modelsListed: false, authoritativeList: true })).toEqual({
      status: "unverified",
      canonical: "nope",
    })
    expect(resolveModelStatus({ ...base, modelsListed: false })).toEqual({
      status: "known",
      canonical: "gemini-decision-1",
    })
  })

  test("known models survive a total discovery outage", () => {
    expect(
      resolveModelStatus({ ...base, providerAvailable: false, modelsListed: false, authoritativeList: true }),
    ).toEqual({ status: "known", canonical: "gemini-decision-1" })
    expect(
      resolveModelStatus({
        ...base,
        requested: "nope",
        providerAvailable: false,
        modelsListed: false,
        authoritativeList: true,
      }),
    ).toEqual({ status: "unverified", canonical: "nope" })
  })

  test("unavailable provider never blocks", () => {
    expect(resolveModelStatus({ ...base, providerAvailable: false, requested: "custom" })).toEqual({
      status: "unverified",
      canonical: "custom",
    })
  })
})
