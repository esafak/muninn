import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { definition } from "./definition"

describe("cache schema", () => {
  const decodeCache = Schema.decodeUnknownSync(definition.stores!.cache.schema)
  const basePull = {
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

  test("preserves merge timestamps and accepts cached entities without them", () => {
    const timestamp = 1_794_192_637_000
    const withMergeTime = decodeCache({ entries: { pull: { ...basePull, mergedAt: timestamp } }, at: {} })
    expect(withMergeTime.entries.pull?.kind === "pr" && withMergeTime.entries.pull.mergedAt).toBe(timestamp)

    const oldCache = decodeCache({ entries: { pull: basePull }, at: {} })
    expect(oldCache.entries.pull?.kind === "pr" && oldCache.entries.pull.mergedAt).toBeUndefined()
    const statusChecks = { headSha: "abc", state: "available", contexts: [{ name: "gate", status: "running" }] } as const
    const withChecks = decodeCache({ entries: { pull: { ...basePull, statusChecks } }, at: {} })
    expect(withChecks.entries.pull?.kind === "pr" && withChecks.entries.pull.statusChecks).toEqual(statusChecks)
  })

  test("accepts cached run snapshots with and without workflow-series metadata", () => {
    const baseRun = {
      kind: "run",
      provider: "github",
      repo: { host: "github.com", owner: "octo", repo: "repo" },
      id: 1,
      name: "CI",
      headBranch: "feature",
      headSha: "abc",
      status: "succeeded",
      checks: [],
      pullRequests: [1],
      url: "https://github.com/octo/repo/actions/runs/1",
      updatedAt: 1,
    }
    const oldCache = decodeCache({ entries: { run: baseRun }, at: {} })
    const nextCache = decodeCache({ entries: { run: { ...baseRun, series: { key: "workflow-1", sequence: 1 } } }, at: {} })
    expect(oldCache.entries.run?.kind === "run" && oldCache.entries.run.series).toBeUndefined()
    expect(nextCache.entries.run?.kind === "run" && nextCache.entries.run.series).toEqual({ key: "workflow-1", sequence: 1 })
  })
})

describe("settings schema", () => {
  test("accepts existing persisted preferences without the new optional field", () => {
    const decode = Schema.decodeUnknownSync(definition.stores!.settings.schema)
    const priorSettings = {
      retentionDays: 30,
      debugMode: true,
      mergeMethod: "squash",
      deleteBranch: true,
    } as const
    expect(decode(priorSettings)).toEqual(priorSettings)
  })

  test("new provider key defaults to unset; legacy key is discarded, not migrated", () => {
    const decode = Schema.decodeUnknownSync(definition.stores!.settings.schema)
    const base = { retentionDays: 30, debugMode: true, mergeMethod: "squash", deleteBranch: true } as const
    expect(decode(base).candidateProviderID).toBeUndefined()
    const legacy = decode({ ...base, candidateProvider: "zen", candidateModel: "x" })
    expect((legacy as unknown as Record<string, unknown>).candidateProvider).toBeUndefined()
    expect(legacy.candidateProviderID).toBeUndefined()
    expect(legacy.candidateModel).toBe("x")
  })

  test("fresh installs start at the opencode provider default", () => {
    expect(definition.stores!.settings.initial.candidateProviderID).toBe("opencode")
  })
})

describe("i18n catalog", () => {
  const en = definition.i18n!.en

  // The host interpolates only `{{name}}` (resolveTemplate); a single-brace
  // placeholder renders raw — `({message})` showed verbatim in the panel.
  test("templates interpolate with {{name}} placeholders, never single braces", () => {
    for (const [key, template] of Object.entries(en)) {
      const single = template.match(/(?<!\{)\{(\w+)\}(?!\})/g)
      expect(single, `${key} has a single-brace placeholder`).toBeNull()
    }
  })

  test("plural messages exist as .one/.other and interpolate {{count}}", () => {
    expect(en["auth.unresolved.one"]).toContain("{{count}}")
    expect(en["auth.unresolved.other"]).toContain("{{count}}")
  })

  test("every settings row and section has a title and description", () => {
    expect(en["settings.section.decisionModels"]).toBe("Decision models")
    for (const id of ["mergeMethod", "deleteBranch", "fastForwardBase"] as const) {
      expect(en[`settings.${id}`]!.length).toBeGreaterThan(0)
      expect(en[`settings.${id}.description`]!.length).toBeGreaterThan(0)
    }
  })
})
