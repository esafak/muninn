import { describe, expect, test } from "bun:test"
import { prCreateRefs } from "./created"
import { githubLexicon } from "../providers/github/lexicon"
import type { Buckets } from "../extract"

const bucketsWith = (command: string, texts: string[]): Buckets => ({
  user: [],
  commands: [],
  prose: [],
  outputs: [{ command, texts }],
})

describe("prCreateRefs", () => {
  test("seeds the single bare PR URL from a successful create", () => {
    const buckets = bucketsWith("gh pr create --head docs/x --base main", [
      "https://github.com/esafak/muninn/pull/47\n",
    ])
    expect(prCreateRefs(buckets, [githubLexicon])).toEqual([
      { kind: "pr", number: 47, repo: { host: "github.com", owner: "esafak", repo: "muninn" } },
    ])
  })

  test("table: rejections never seed", () => {
    const cases: Array<[string, string, string[]]> = [
      ["help flag", "gh pr create --head a --help", ["usage: pr create\n"]],
      ["short help flag", "gh pr create -h", ["usage: pr create\n"]],
      ["dry run", "gh pr create --head a --dry-run", ["https://github.com/esafak/muninn/pull/47\n"]],
      ["non-create command", "gh pr view 47 --json url", ["https://github.com/esafak/muninn/pull/47\n"]],
      ["mid-command create", "echo hi; gh pr create --head a", ["https://github.com/esafak/muninn/pull/47\n"]],
      [
        "redirect plus newline view",
        "gh pr create --head feature >/dev/null\ngh pr view 5 --json url --jq .url",
        ["https://github.com/esafak/muninn/pull/5\n"],
      ],
      [
        "already-exists prose",
        "gh pr create --head a",
        ["GraphQL: A pull request already exists for docs/x: https://github.com/esafak/muninn/pull/47\n"],
      ],
      ["json output", "gh pr create --head a", ['{"url": "https://github.com/esafak/muninn/pull/47"}\n']],
      [
        "two URLs",
        "gh pr create --head a",
        ["https://github.com/esafak/muninn/pull/47\n", "https://github.com/esafak/muninn/pull/48\n"],
      ],
      ["run URL", "gh pr create --head a", ["https://github.com/esafak/muninn/actions/runs/1\n"]],
      ["compare URL", "gh pr create --web", ["https://github.com/esafak/muninn/compare/main...docs/x\n"]],
    ]
    for (const [name, command, texts] of cases)
      expect(prCreateRefs(bucketsWith(command, texts), [githubLexicon]), name).toEqual([])
  })

  test("table: quoted bodies still seed; head flag is not help", () => {
    const cases: Array<[string, string]> = [
      ["semicolons in body", 'gh pr create --head a --body "fix A; fix B"'],
      ["pipe in body", 'gh pr create --head a --body "a | b"'],
      ["multiline body", "gh pr create --head a --body \"line one\nline two\""],
      ["backticks in body", "gh pr create --head docs/x --body \"uses `gh` here\""],
      ["single-quoted body", "gh pr create --head a --body 'fix A; fix B'"],
    ]
    for (const [name, command] of cases)
      expect(prCreateRefs(bucketsWith(command, ["https://github.com/esafak/muninn/pull/48\n"]), [githubLexicon]), name).toEqual([
        { kind: "pr", number: 48, repo: { host: "github.com", owner: "esafak", repo: "muninn" } },
      ])
  })

  test("dedupes repeat URLs", () => {
    const buckets: Buckets = {
      user: [],
      commands: [],
      prose: [],
      outputs: [
        { command: "gh pr create --head a", texts: ["https://github.com/esafak/muninn/pull/47\n"] },
        { command: "gh pr create --head a", texts: ["https://github.com/esafak/muninn/pull/47\n"] },
      ],
    }
    expect(prCreateRefs(buckets, [githubLexicon])).toHaveLength(1)
  })
})
