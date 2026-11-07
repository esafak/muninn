import { describe, expect, test } from "bun:test"
import { scan } from "./extract"
import { githubLexicon } from "./providers/github/lexicon"
import type { RepoRef } from "./model"

const opencode: RepoRef = { host: "github.com", owner: "sst", repo: "opencode" }
const scanGh = (text: string, repo?: RepoRef) => scan(text, repo, [githubLexicon])

describe("scan", () => {
  test("kind words resolve against the session repository", () => {
    expect(scanGh("The e2e suite is red on PR 4821, see issue 1043", opencode)).toEqual([
      { kind: "pr", number: 4821, repo: opencode },
      { kind: "issue", number: 1043, repo: opencode },
    ])
  })

  test("bare hashes keep an unknown kind", () => {
    expect(scanGh("TUI still loses scroll position — #1043", opencode)).toEqual([{ number: 1043, repo: opencode }])
  })

  test("run references", () => {
    expect(scanGh("run 18402 failed; check run 18404 is queued", opencode)).toEqual([
      { kind: "run", number: 18402, repo: opencode },
      { kind: "run", number: 18404, repo: opencode },
    ])
  })

  test("urls carry their own repository and kind", () => {
    const refs = scanGh(
      "opened https://github.com/sst/opencode/pull/4821 and tracked https://github.com/acme/other/issues/7",
      opencode,
    )
    expect(refs).toContainEqual({ kind: "pr", number: 4821, repo: opencode })
    expect(refs).toContainEqual({ kind: "issue", number: 7, repo: { host: "github.com", owner: "acme", repo: "other" } })
  })

  test("action run urls", () => {
    expect(scanGh("https://github.com/sst/opencode/actions/runs/18402 failed", opencode)).toEqual([
      { kind: "run", number: 18402, repo: opencode },
    ])
  })

  test("cross-repo shorthand", () => {
    expect(scanGh("mirror of acme/api#42", opencode)).toEqual([
      { number: 42, repo: { host: "github.com", owner: "acme", repo: "api" } },
    ])
  })

  test("kind learned from any occurrence sticks", () => {
    expect(scanGh("#4821 and PR 4821 again", opencode)).toEqual([{ kind: "pr", number: 4821, repo: opencode }])
  })

  test("code fences and inline code are ignored", () => {
    expect(scanGh("see `#123` and\n```md\n#456\n```", opencode)).toEqual([])
  })

  test("no session repository: only self-contained references", () => {
    expect(scanGh("PR 4821 and https://github.com/sst/opencode/issues/1043", undefined)).toEqual([
      { kind: "issue", number: 1043, repo: opencode },
    ])
  })

  test("markdown headings are not references", () => {
    expect(scanGh("### 1. Steps\n## 42", opencode)).toEqual([])
  })

  test("same number in different repositories stay distinct", () => {
    const refs = scanGh("#4821 and acme/api#4821", opencode)
    expect(refs).toHaveLength(2)
  })

  test("no lexicons: provider urls don't resolve, generic patterns still do", () => {
    expect(scan("https://github.com/sst/opencode/issues/7", opencode, [])).toEqual([])
    expect(scan("run 42 went green", opencode, [])).toEqual([{ kind: "run", number: 42, repo: opencode }])
  })
})
