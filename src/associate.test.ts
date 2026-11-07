import { describe, expect, test } from "bun:test"
import { associate } from "./associate"
import type { IssueEntity, PullEntity, RunEntity } from "./model"

const repo = { host: "github.com", owner: "sst", repo: "opencode" }
const at = (ms: number) => ms

const issue: IssueEntity = { kind: "issue", provider: "github", repo, number: 1043, title: "Scroll jank", state: "open", url: "u", updatedAt: at(100) }
const pull: PullEntity = {
  kind: "pr",
  provider: "github",
  repo,
  number: 4821,
  title: "Fix scroll",
  state: "open",
  headBranch: "fix-scroll-state",
  baseBranch: "dev",
  closes: [1043],
  headSha: "abc123",
  url: "u",
  updatedAt: at(200),
}
const run = (id: number, sha: string, updatedAt: number): RunEntity => ({
  kind: "run",
  provider: "github",
  repo,
  id,
  name: "ci",
  headBranch: "fix-scroll-state",
  headSha: sha,
  status: "succeeded",
  checks: [],
  url: "u",
  updatedAt,
})

describe("associate", () => {
  test("a pull request claims its runs and its issue", () => {
    const chains = associate([issue, pull, run(18402, "abc123", 150), run(18404, "abc123", 300)])
    expect(chains).toHaveLength(1)
    expect(chains[0]?.pr?.number).toBe(4821)
    expect(chains[0]?.issue?.number).toBe(1043)
    expect(chains[0]?.runs.map((r) => r.id)).toEqual([18404, 18402])
    expect(chains[0]?.updatedAt).toBe(300)
  })

  test("runs from other repositories do not join", () => {
    const other: RunEntity = { ...run(9, "abc123", 50), repo: { host: "github.com", owner: "acme", repo: "api" } }
    const chains = associate([pull], [other])
    expect(chains[0]?.runs).toEqual([])
    expect(chains).toHaveLength(2)
  })

  test("unclaimed branch runs stand alone", () => {
    const chains = associate([pull], [run(18410, "def456", 400)])
    const standalone = chains.find((chain) => chain.pr === undefined)
    expect(standalone?.runs[0]?.id).toBe(18410)
  })

  test("unlinked issues stand alone", () => {
    const chains = associate([issue])
    expect(chains).toHaveLength(1)
    expect(chains[0]?.issue?.number).toBe(1043)
  })

  test("chains order by last activity", () => {
    const olderPull: PullEntity = { ...pull, number: 4790, closes: [], headSha: "old", updatedAt: at(90) }
    const chains = associate([olderPull, pull])
    expect(chains[0]?.pr?.number).toBe(4821)
  })
})
