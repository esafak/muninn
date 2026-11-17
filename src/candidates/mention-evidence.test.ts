import { describe, expect, test } from "bun:test"
import { mentionEvidence } from "./mention-evidence"
import type { TieredRef } from "../extract"
import type { Entity, PullEntity, RepoRef } from "../model"

const repo: RepoRef = { host: "github.com", owner: "sst", repo: "opencode" }
const foreign: RepoRef = { host: "github.com", owner: "other", repo: "repo" }

const pull = (over: Partial<PullEntity> = {}): PullEntity => ({
  kind: "pr",
  provider: "github",
  repo,
  number: 47,
  title: "t",
  state: "open",
  headBranch: "b",
  baseBranch: "main",
  closes: [],
  headSha: "abc",
  url: "https://github.com/sst/opencode/pull/47",
  updatedAt: 0,
  ...over,
})

const entities = (...prs: PullEntity[]): Record<string, Entity> =>
  Object.fromEntries(
    prs.map((pr) => [`${pr.repo.host}/${pr.repo.owner}/${pr.repo.repo}#pr${pr.number}`, pr]),
  )

const ref = (over: Partial<TieredRef> = {}): TieredRef => ({
  kind: "pr",
  repo,
  tier: "prose",
  number: 47,
  ...over,
})

describe("mentionEvidence", () => {
  test("typed PR refs recruit their hydrated PR at user/command/prose tiers", () => {
    const ents = entities(pull())
    for (const tier of ["user", "command", "prose"] as const)
      expect(mentionEvidence([ref({ tier })], ents, undefined)).toEqual(
        new Set(["github.com/sst/opencode#pr47"]),
      )
  })

  test("output-tier refs never recruit", () => {
    expect(mentionEvidence([ref({ tier: "output" })], entities(pull()), undefined)).toEqual(new Set())
  })

  test("verdict matrix: explicit false excludes, everything else keeps", () => {
    const ents = entities(pull())
    const base = "github.com/sst/opencode"
    expect(mentionEvidence([ref({})], ents, new Map([[`${base}#pr47`, false]]))).toEqual(new Set())
    for (const judged of [undefined, new Map(), new Map([[`${base}#pr47`, true]])] as const)
      expect(mentionEvidence([ref({})], ents, judged)).toEqual(new Set([`${base}#pr47`]))
  })

  test("unhydrated numbers recruit nothing", () => {
    expect(mentionEvidence([ref({})], {}, undefined)).toEqual(new Set())
    expect(mentionEvidence([ref({ kind: undefined })], {}, undefined)).toEqual(new Set())
  })

  test("bare refs fan out: issue-kept/PR-dropped recruits nothing", () => {
    const ents = entities(pull())
    const base = "github.com/sst/opencode"
    const bare = { number: 47, repo, tier: "prose" as const }
    expect(mentionEvidence([bare], ents, undefined)).toEqual(new Set([`${base}#pr47`]))
    expect(
      mentionEvidence([bare], ents, new Map([[`${base}#pr47`, false]])),
    ).toEqual(new Set())
    expect(
      mentionEvidence([bare], ents, new Map([[`${base}#issue47`, false]])),
    ).toEqual(new Set([`${base}#pr47`]))
  })

  test("issue and run kinds never recruit PRs", () => {
    const ents = entities(pull())
    expect(mentionEvidence([{ number: 47, kind: "issue", repo, tier: "prose" }], ents, undefined)).toEqual(
      new Set(),
    )
    expect(mentionEvidence([{ number: 47, kind: "run", repo, tier: "prose" }], ents, undefined)).toEqual(
      new Set(),
    )
  })

  test("kind-less refs without a repo never recruit", () => {
    expect(mentionEvidence([{ number: 47, tier: "prose" }], entities(pull()), undefined)).toEqual(new Set())
  })
})
