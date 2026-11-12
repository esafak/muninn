import { describe, expect, test } from "bun:test"
import { auditTitle } from "./audit-title"
import type { PullEntity, RepoRef } from "../model"

const repo = (owner: string, repo: string): RepoRef => ({ host: "github.com", owner, repo })
const pull = (overrides: Partial<PullEntity> & { number: number }): PullEntity => ({
  kind: "pr",
  provider: "github",
  repo: repo("octo", "repo"),
  title: "Change",
  state: "open",
  headBranch: "feature",
  baseBranch: "main",
  closes: [],
  headSha: "abc",
  url: "https://github.com/octo/repo/pull/1",
  updatedAt: 1,
  ...overrides,
}) as PullEntity
const clock = "\\(\\d{1,2}:\\d{2}\\)"

describe("auditTitle", () => {
  test("attributes evidence to the matching repo and number only", () => {
    const otherNumber = [{ at: 1, repo: repo("octo", "repo"), number: 2, kind: "merged" as const, via: "manual" as const }]
    const otherRepo = [{ at: 1, repo: repo("octo", "other"), number: 1, kind: "merged" as const, via: "manual" as const }]
    expect(auditTitle([], pull({ number: 1 }))).toBeUndefined()
    expect(auditTitle(otherNumber, pull({ number: 1 }))).toBeUndefined()
    expect(auditTitle(otherRepo, pull({ number: 1 }))).toBeUndefined()
  })

  test("merged PRs report method, time, and cleanup evidence", () => {
    const base = { at: 1_794_192_637_000, repo: repo("octo", "repo"), number: 1, kind: "merged" as const, via: "manual" as const }
    expect(auditTitle([base], pull({ number: 1 }))).toMatch(new RegExp(`^squash merged by Muninn ${clock}$`))
    expect(
      auditTitle(
        [{ ...base, method: "rebase" as const, via: "when-ready" as const }, { ...base, kind: "branch-deleted" as const }],
        pull({ number: 1 }),
      ),
    ).toMatch(new RegExp(`^rebase merged by Muninn ${clock} · when ready · branch deleted$`))
    expect(
      auditTitle([base, { ...base, kind: "branch-delete-failed" as const }], pull({ number: 1, state: "merged" })),
    ).toMatch(new RegExp(`^squash merged by Muninn ${clock} · branch deletion failed$`))
  })

  test("failures stay visible with their detail, even once closed", () => {
    const failed = {
      at: 1_794_192_637_000,
      repo: repo("octo", "repo"),
      number: 1,
      kind: "merge-failed" as const,
      via: "manual" as const,
      detail: "head changed",
    }
    expect(auditTitle([failed], pull({ number: 1, state: "closed" }))).toMatch(
      new RegExp(`^merge failed ${clock} — head changed$`),
    )
    expect(auditTitle([failed], pull({ number: 2, state: "closed" }))).toBeUndefined()
  })

  test("merged on the forge without ledger evidence says so, open without evidence says nothing", () => {
    expect(auditTitle([], pull({ number: 1, state: "merged" }))).toBe("merged on the forge — not by Muninn")
    expect(auditTitle([], pull({ number: 1, state: "closed" }))).toBeUndefined()
  })
})
