import { describe, expect, test } from "bun:test"
import { deliberateRefs, messageBuckets } from "../extract"
import { githubLexicon } from "../providers/github/lexicon"
import type { RepoRef } from "../model"
import { heuristicExtract } from "./heuristic"
import { CACHE_MAX_ENTRIES, candidateCacheKey, createCandidateCache } from "./cache"
import { jevCodec } from "./codecs/jev"
import { openaiCodec } from "./codecs/openai"

const repo: RepoRef = { host: "github.com", owner: "sst", repo: "opencode" }

const assistant = (content: unknown[]) => ({ type: "assistant", id: "m2", content, time: { created: 0 } })
const toolPart = (input: unknown, output: string) => ({
  type: "tool",
  id: "t1",
  name: "bash",
  state: { status: "completed", input, content: [{ type: "text", text: output }] },
})

describe("heuristic strict matches deliberateRefs", () => {
  test("focused output kept, listing dropped", () => {
    const buckets = messageBuckets([assistant([toolPart({ command: "gh pr view 3670" }, "PR 3670 is open")])])
    const strict = heuristicExtract(buckets, repo, [githubLexicon], "strict")
    const expected = deliberateRefs(buckets, repo, [githubLexicon])
    expect(strict.refs).toEqual(expected)
    expect(strict.snippets.size).toBe(1)
  })

  test("snippet keeps the output's own command, not a neighbor's", () => {
    const buckets = messageBuckets([
      assistant([toolPart({ command: "gh pr list" }, "PR 100 x"), toolPart({ command: "gh pr view 3670" }, "PR 3670 is open")]),
    ])
    const strict = heuristicExtract(buckets, repo, [githubLexicon], "strict")
    expect(strict.snippets.get("github.com/sst/opencode#pr3670")).toEqual({
      text: "PR 3670 is open",
      command: "gh pr view 3670",
    })
  })

  test("permissive keeps 3-kind listing for the model", () => {
    const buckets = messageBuckets([assistant([toolPart({ command: "gh pr list" }, "PR 100 x\nPR 200 y\nPR 300 z")])])
    const strict = heuristicExtract(buckets, repo, [githubLexicon], "strict")
    const permissive = heuristicExtract(buckets, repo, [githubLexicon], "permissive")
    expect(strict.refs).toEqual([])
    expect(permissive.refs.map((r) => r.number).sort((a, b) => a - b)).toEqual([100, 200, 300])
  })

  test("both drop huge run listings", () => {
    const listing = Array.from({ length: 8 }, (_, i) => `https://github.com/sst/opencode/actions/runs/${900 + i}`).join("\n")
    const buckets = { user: [listing], commands: [], prose: [], outputs: [] }
    expect(heuristicExtract(buckets, repo, [githubLexicon], "strict").refs).toEqual([])
    expect(heuristicExtract(buckets, repo, [githubLexicon], "permissive").refs).toEqual([])
  })
})

describe("candidate cache key", () => {
  test("tier promotion misses, identical hits", () => {
    const base = { ref: { number: 4821, kind: "pr" as const, repo, tier: "output" as const }, snippet: "PR 4821", command: "gh pr list" }
    const scope = "openrouter:https://openrouter.ai/api/v1/systemone:typesafe/jev-1.13-20260917"
    const same = candidateCacheKey(base, scope)
    const promoted = candidateCacheKey({ ...base, ref: { ...base.ref, tier: "user" as const } }, scope)
    expect(candidateCacheKey(base, scope)).toBe(same)
    expect(promoted).not.toBe(same)
  })

  test("hydrated titles and states are evidence: changing them misses", () => {
    const base = { ref: { number: 4821, kind: "pr" as const, repo, tier: "output" as const }, snippet: "PR 4821" }
    const scope = "openrouter:https://openrouter.ai/api/v1/systemone:typesafe/jev-1.13-20260917"
    const open = candidateCacheKey({ ...base, title: "Fix scroll", state: "open" }, scope)
    const closed = candidateCacheKey({ ...base, title: "Fix scroll", state: "closed" }, scope)
    expect(open).not.toBe(closed)
    expect(candidateCacheKey(base, scope)).not.toBe(open)
  })

  test("judge identity scopes the key: same evidence, different backend, miss", () => {
    const base = { ref: { number: 4821, kind: "pr" as const, repo, tier: "output" as const }, snippet: "PR 4821" }
    expect(candidateCacheKey(base, "openrouter:e1:build-1")).not.toBe(candidateCacheKey(base, "openai:e2:build-1"))
    expect(candidateCacheKey(base, "openrouter:e1:build-1")).not.toBe(candidateCacheKey(base, "openrouter:e1:build-2"))
  })

  test("bounded: oldest entries evict past the cap", () => {
    const cache = createCandidateCache(2)
    cache.set("a", { keep: true })
    cache.set("b", { keep: true })
    cache.set("c", { keep: true })
    expect(cache.size()).toBe(2)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("c")).toEqual({ keep: true })
    expect(CACHE_MAX_ENTRIES).toBeGreaterThan(100)
  })
})

describe("decision codecs", () => {
  const input = { ref: { number: 4821, kind: "pr" as const, repo, tier: "user" as const }, snippet: "merge PR 4821", command: "gh pr view 4821" }

  test("jev build/parse round-trips raw probabilities", () => {
    const built = jevCodec.build([input])
    expect(built.questionKeys).toHaveLength(1)
    const key = built.questionKeys[0]!
    const answers = jevCodec.parse({ answers: { [key]: { type: "noul", noul: 0.9 } } }, [key])
    expect(answers).toEqual([{ key, probability: 0.9 }])
  })

  test("jev omits unanswered questions instead of defaulting them", () => {
    const built = jevCodec.build([input])
    const key = built.questionKeys[0]!
    expect(jevCodec.parse({ answers: {} }, [key])).toEqual([])
    expect(() => jevCodec.parse({ nope: true }, [key])).toThrow()
  })

  test("jev rejects out-of-range probabilities", () => {
    const built = jevCodec.build([input])
    const key = built.questionKeys[0]!
    expect(() => jevCodec.parse({ answers: { [key]: { type: "noul", noul: 1.5 } } }, [key])).toThrow()
    expect(() => jevCodec.parse({ answers: { [key]: { type: "noul", noul: -0.1 } } }, [key])).toThrow()
  })

  test("openai build/parse round-trips and omits missing names", () => {
    const built = openaiCodec.build([input])
    const payload = built.payload as { questions: { name: string }[] }
    const key = built.questionKeys[0]!
    expect(payload.questions[0]!.name).toBe(key)
    expect(openaiCodec.parse({ answers: [{ type: "predicate", name: key, probability: 0.9 }] }, [key])).toEqual([
      { key, probability: 0.9 },
    ])
    expect(openaiCodec.parse({ answers: [] }, [key])).toEqual([])
    expect(() => openaiCodec.parse({ answers: [{ type: "predicate", name: key, probability: 7 }] }, [key])).toThrow()
  })
})

describe("judge chunking", () => {
  test("explicit sizes split without network; budget derives from queried caps", async () => {
    const mod = await import("./decision-model")
    const caps = await import("./model-caps")
    const chunks = mod.chunkIndexes(25, 10)
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5])
    expect(mod.chunkIndexes(0, 10)).toEqual([])
    // Luna-class window fits everything: single slice, no hardcode involved.
    expect(mod.initialSlices([0, 1, 2], [{ snippet: "a" }, { snippet: "b" }, { snippet: "c" }] as never, {
      contextLength: 1050000, resolvedAt: Date.now(), source: "live",
    })).toHaveLength(1)
    expect(caps.isCapsFresh(Date.now())).toBe(true)
    expect(caps.isCapsFresh(Date.now() - 8 * 24 * 60 * 60 * 1000)).toBe(false)
    expect(caps.chunkSizeForBudget(3, 1000, 1100, 262144)).toBe(3)
  })
})

describe("canonical builds", () => {
  test("verdict cache separates floating ID from canonical build", async () => {
    const cache = await import("./cache")
    const ref = { ref: { number: 4821, kind: "pr" as const, repo: { host: "github.com", owner: "sst", repo: "opencode" }, tier: "user" as const }, snippet: "merge PR 4821", command: "gh pr view 4821" }
    const aliasKey = cache.candidateCacheKey(ref, "openrouter:https://openrouter.ai/api/v1/systemone:openai/gpt-6-luna-decisions")
    const buildKey = cache.candidateCacheKey(ref, "openrouter:https://openrouter.ai/api/v1/systemone:openai/gpt-6-luna-decisions-20261006")
    expect(aliasKey).not.toBe(buildKey)
  })
})

describe("typed bare-ref filtering", () => {
  test("issue-keeps plus PR-drops keeps only the issue", async () => {
    const { bareSurvives, bareKindKept } = await import("./filtering")
    const base = "github.com/sst/opencode"
    const judged = new Map([
      [`${base}#issue42`, true],
      [`${base}#pr42`, false],
    ])
    expect(bareSurvives(judged, base, 42, ["issue", "pr"])).toBe(true)
    expect(bareKindKept(judged, base, 42, "issue")).toBe(true)
    expect(bareKindKept(judged, base, 42, "pr")).toBe(false)
    expect(bareKindKept(judged, base, 42, "run")).toBe(true)
    const allDropped = new Map([
      [`${base}#issue42`, false],
      [`${base}#pr42`, false],
      [`${base}#run42`, false],
    ])
    expect(bareSurvives(allDropped, base, 42, ["issue", "pr", "run"])).toBe(false)
    expect(bareSurvives(new Map(), base, 42, ["issue", "pr"])).toBe(true)
    expect(bareSurvives(undefined, base, 42, ["issue"])).toBe(true)
    expect(bareSurvives(allDropped, base, 42, [])).toBe(true)
  })

  test("sliced-off kind fails open: issue drops, PR unanswered, bare stays", async () => {
    const { bareSurvives, bareKindKept } = await import("./filtering")
    const base = "github.com/sst/opencode"
    // Expansion + 64-cap included the issue but cut the same bare ref's PR.
    const judged = new Map([[`${base}#issue42`, false]])
    expect(bareSurvives(judged, base, 42, ["issue", "pr"])).toBe(true)
    expect(bareKindKept(judged, base, 42, "pr")).toBe(true)
    expect(bareKindKept(judged, base, 42, "issue")).toBe(false)
  })
})
