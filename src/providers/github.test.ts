import { describe, expect, test } from "bun:test"
import { mergeResponse } from "./github"
import { PullEntity } from "../rpc"

describe("mergeResponse", () => {
  test("only reports a confirmed merge", () => {
    expect(mergeResponse({ merged: true })).toEqual({ merged: true })
    expect(mergeResponse({ merged: false, message: "Pull Request is not mergeable" })).toEqual({
      merged: false,
      message: "Pull Request is not mergeable",
    })
    expect(mergeResponse({})).toEqual({ merged: false, message: "GitHub did not confirm that the pull request merged" })
    expect(mergeResponse(undefined)).toEqual({ merged: false, message: "GitHub returned an invalid merge response" })
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
    expect(PullEntity.parse({ ...entity, mergedAt: 1_794_192_637_000 }).mergedAt).toBe(1_794_192_637_000)
    expect(PullEntity.parse(entity).mergedAt).toBeUndefined()
  })
})
