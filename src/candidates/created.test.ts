import { describe, expect, test } from "bun:test"
import { prCreateBranchLinks, prCreateRefs, validateCreateLinks } from "./created"
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

describe("prCreateBranchLinks", () => {
  const url47 = "https://github.com/esafak/muninn/pull/47\n"
  const pushNoise = "remote: \nTo github.com:esafak/muninn.git\n * [new branch] fix/x -> fix/x\n"
  const compound =
    "git push -u origin fix/x 2>&1 | tail -4 && gh pr create --base main --head fix/x --title t --body-file /tmp/x.md 2>&1 | tail -3"

  test("canonical push && create with tail filters links the branch", () => {
    expect(prCreateBranchLinks(bucketsWith(compound, [pushNoise, url47]), [githubLexicon])).toEqual([
      { repo: { host: "github.com", owner: "esafak", repo: "muninn" }, number: 47, headBranch: "fix/x" },
    ])
  })

  test("simple creates link too; quoted --head values honored", () => {
    expect(prCreateBranchLinks(bucketsWith("gh pr create --head a", [url47]), [githubLexicon])).toHaveLength(1)
    expect(
      prCreateBranchLinks(bucketsWith('gh pr create --head "fix/x" --base main', [url47]), [githubLexicon])[0]?.headBranch,
    ).toBe("fix/x")
  })

  test("table: bounded-shape violations never link", () => {
    const sameBranchView = "gh pr create --head fix/x >/dev/null; gh pr view 99 --json url --jq .url"
    const cases: Array<[string, string, string[]]> = [
      ["help flag", "gh pr create --head a --help", ["usage\n"]],
      ["dry run", "gh pr create --head a --dry-run", [url47]],
      ["mid-command create", "echo hi; gh pr create --head a", [url47]],
      ["later view smuggling a same-branch URL", sameBranchView, ["https://github.com/esafak/muninn/pull/99\n"]],
      ["later tail via &&", "gh pr create --head fix/x && tail -1 /tmp/other-pr-url", [url47]],
      ["later tail via ; with file operand", "gh pr create --head fix/x >/dev/null; tail -1 /tmp/other-pr-url", [url47]],
      ["non-tail pipe in push prefix", "git push x | grep u && gh pr create --head fix/x", [url47]],
      ["bare tail prefix without push", "tail -1 /tmp/x && gh pr create --head fix/x", [url47]],
      ["cd-only prefix without push", "cd /tmp && gh pr create --head fix/x", [url47]],
      ["env-prefixed create", "GH_TOKEN=x gh pr create --head fix/x", [url47]],
      ["backgrounded create", "sleep 1 & gh pr create --head fix/x", [url47]],
      ["multiple creates", "gh pr create --head a && gh pr create --head b", [url47]],
      ["quoted fake", 'echo "gh pr create --head a"', [url47]],
      ["no create at all", "gh pr view 47 --json url", [url47]],
      ["failure fallback", "gh pr create --head a || echo fail", [url47]],
      ["head-only suffix", "gh pr create --head a 2>&1 | head -3", [url47]],
      ["quoted tail file operand", "gh pr create --head fix/x >/dev/null | tail \"/tmp/other-pr-url\"", [url47]],
      ["quoted tail count plus file operand", "gh pr create --head fix/x >/dev/null | tail -3 \"/tmp/other-pr-url\"", [url47]],
      ["already-exists prose", "gh pr create --head a", ["exists: https://github.com/esafak/muninn/pull/47\n"]],
      ["json output", "gh pr create --head a", ['{"url": "https://github.com/esafak/muninn/pull/47"}\n']],
      ["two URLs", compound, [url47, "https://github.com/esafak/muninn/pull/48\n"]],
      ["same-text push noise", compound, [`${pushNoise}${url47}`]],
      ["missing --head", "gh pr create --base main", [url47]],
      ["unquoted substitution", "gh pr create --head $(echo a)", [url47]],
    ]
    for (const [name, command, texts] of cases)
      expect(prCreateBranchLinks(bucketsWith(command, texts), [githubLexicon]), name).toEqual([])
  })

  test("cd beside a push prefix still links", () => {
    expect(
      prCreateBranchLinks(bucketsWith("cd /tmp && git push -u origin fix/x && gh pr create --head fix/x", [url47]), [githubLexicon]),
    ).toEqual([
      { repo: { host: "github.com", owner: "esafak", repo: "muninn" }, number: 47, headBranch: "fix/x" },
    ])
  })
})

describe("validateCreateLinks", () => {
  const repo = { host: "github.com", owner: "esafak", repo: "muninn" }
  const pull = (over: Partial<import("../model").PullEntity> = {}): import("../model").PullEntity => ({
    kind: "pr",
    provider: "github",
    repo,
    number: 47,
    title: "t",
    state: "open",
    headBranch: "fix/x",
    baseBranch: "main",
    closes: [],
    headSha: "abc",
    url: "https://github.com/esafak/muninn/pull/47",
    updatedAt: 0,
    ...over,
  })
  const link = { repo, number: 47, headBranch: "fix/x" }

  test("seeds only on same repo+number+headBranch while open", () => {
    expect(validateCreateLinks([link], [pull()])).toEqual(["github.com/esafak/muninn#pr47"])
    expect(validateCreateLinks([link], [pull({ headBranch: "other" })])).toEqual([])
    expect(validateCreateLinks([link], [pull({ state: "closed" })])).toEqual([])
    expect(validateCreateLinks([link], [pull({ state: "merged" })])).toEqual(["github.com/esafak/muninn#pr47"])
    expect(
      validateCreateLinks([link], [pull({ repo: { host: "github.com", owner: "other", repo: "repo" } })]),
    ).toEqual([])
    expect(validateCreateLinks([link], [pull({ number: 48 })])).toEqual([])
    expect(validateCreateLinks([], [pull()])).toEqual([])
  })
})
