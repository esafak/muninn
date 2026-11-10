import { describe, expect, test } from "bun:test"
import { mergeResponse, toPullEntity } from "./github"
import { PullEntity } from "../rpc"

describe("mergeResponse", () => {
  test("a confirmed merge succeeds, with or without a message", () => {
    expect(mergeResponse({ merged: true })).toEqual({ merged: true })
    expect(mergeResponse({ merged: true, message: "squashed" })).toEqual({ merged: true })
  })

  test("an unconfirmed 200 fails with the provider's message", () => {
    expect(mergeResponse({ merged: false, message: "Already merged" })).toEqual({
      merged: false,
      message: "Already merged",
    })
    expect(mergeResponse({ merged: false })).toEqual({
      merged: false,
      message: "GitHub did not confirm that the pull request merged",
    })
  })

  test("an object body without confirmation fails with the unconfirmed message", () => {
    expect(mergeResponse({})).toEqual({
      merged: false,
      message: "GitHub did not confirm that the pull request merged",
    })
    expect(mergeResponse({ merged: "yes" })).toEqual({
      merged: false,
      message: "GitHub did not confirm that the pull request merged",
    })
  })

  test("non-object bodies fail with the invalid-response message", () => {
    const invalid = { merged: false, message: "GitHub returned an invalid merge response" }
    expect(mergeResponse(null)).toEqual(invalid)
    expect(mergeResponse(undefined)).toEqual(invalid)
    expect(mergeResponse("merged")).toEqual(invalid)
    expect(mergeResponse(42)).toEqual(invalid)
  })
})

describe("PullEntity RPC schema", () => {
  test("accepts merge timestamps while remaining compatible with cached entities", () => {
    const entity = {
      kind: "pr",
      provider: "github",
      repo: { host: "github.com", owner: "octo", repo: "repo" },
      number: 1,
      title: "Merged change",
      state: "merged",
      headBranch: "feature",
      baseBranch: "main",
      closes: [],
      headSha: "abc",
      url: "https://github.com/octo/repo/pull/1",
      updatedAt: 1,
    }
    const timestamp = 1_794_192_637_000
    expect(PullEntity.parse({ ...entity, mergedAt: timestamp }).mergedAt).toBe(timestamp)
    expect(PullEntity.parse(entity).mergedAt).toBeUndefined()
  })
})

describe("toPullEntity", () => {
  const repo = { host: "github.com", owner: "octo", repo: "repo" }
  const basePull = {
    node_id: "n1",
    number: 7,
    title: "T",
    state: "open",
    draft: false,
    merged_at: null,
    body: null,
    html_url: "https://github.com/octo/repo/pull/7",
    head: { sha: "abc", ref: "feature" },
    base: { ref: "main" },
    mergeable: null,
    mergeable_state: "unknown",
    auto_merge: null,
    updated_at: "2026-11-10T00:00:00Z",
  } as const

  test("an open pull carries no mergedAt key at all — undefined fails strict JSON", () => {
    const entity = toPullEntity(repo, { ...basePull })
    expect("mergedAt" in entity).toBe(false)
  })

  test("a merged pull carries the merge timestamp", () => {
    const entity = toPullEntity(repo, { ...basePull, merged_at: "2026-11-10T00:33:47Z", state: "closed" })
    expect(entity.mergedAt).toBe(Date.parse("2026-11-10T00:33:47Z"))
    expect(entity.state).toBe("merged")
  })
})
