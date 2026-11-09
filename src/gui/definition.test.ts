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
})
