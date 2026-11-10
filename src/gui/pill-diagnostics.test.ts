import { describe, expect, test } from "bun:test"
import { pillPullDiagnostics } from "./pill-diagnostics"
import type { PullEntity } from "../model"

const pull = (overrides: Partial<PullEntity> = {}): PullEntity => ({
  kind: "pr",
  provider: "github",
  repo: { host: "github.com", owner: "acme", repo: "app" },
  number: 42,
  title: "Fix it",
  state: "open",
  headBranch: "fix-it",
  baseBranch: "main",
  closes: [],
  headSha: "1234567890abcdef",
  url: "https://github.com/acme/app/pull/42",
  updatedAt: 0,
  ...overrides,
})

describe("pillPullDiagnostics", () => {
  test("reports normalized merge state and whether checks match the head", () => {
    expect(pillPullDiagnostics(pull({
      mergeState: "ready",
      statusChecks: { state: "available", headSha: "1234567890abcdef", contexts: [] },
    }))).toBe("pr#42 state=open merge=ready head=1234567 checks=available@1234567")
    expect(pillPullDiagnostics(pull({
      state: "draft",
      statusChecks: { state: "unavailable", headSha: "oldsha987654321", contexts: [] },
    }))).toBe("pr#42 state=draft merge=unknown head=1234567 checks=unavailable@oldsha9")
  })

  test("marks omitted merge state and status checks explicitly", () => {
    expect(pillPullDiagnostics(pull())).toBe("pr#42 state=open merge=unknown head=1234567 checks=missing")
    expect(pillPullDiagnostics(undefined)).toBeUndefined()
  })
})
