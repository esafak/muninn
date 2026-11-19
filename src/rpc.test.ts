import { describe, expect, test } from "bun:test"
import { Entity } from "./rpc"

const pull = {
  kind: "pr" as const,
  provider: "github",
  repo: { host: "github.com", owner: "octo", repo: "repo" },
  number: 7,
  title: "Change",
  state: "open" as const,
  headBranch: "feature",
  baseBranch: "main",
  closes: [],
  headSha: "abc123",
  url: "https://github.com/octo/repo/pull/7",
  updatedAt: 1,
}

describe("PullEntity RPC schema", () => {
  test("accepts and preserves the provider review URL", () => {
    const reviewUrl = "https://github.com/octo/repo/pull/7/files"
    const parsed = Entity.parse({ ...pull, reviewUrl })
    expect(parsed.kind === "pr" && parsed.reviewUrl).toBe(reviewUrl)
  })

  test("accepts hydrated pulls from older servers without the field", () => {
    const parsed = Entity.parse(pull)
    expect(parsed.kind === "pr" && parsed.reviewUrl).toBeUndefined()
  })
})
