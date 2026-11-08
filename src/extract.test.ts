import { describe, expect, test } from "bun:test"
import { messagesText, scan, textToScan } from "./extract"
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

  test("run urls with job and attempt suffixes", () => {
    expect(
      scanGh("https://github.com/archipelagoAI/fresnel/actions/runs/41995497581/job/127499929276", undefined),
    ).toEqual([{ kind: "run", number: 41995497581, repo: { host: "github.com", owner: "archipelagoAI", repo: "fresnel" } }])
    expect(scanGh("https://github.com/sst/opencode/actions/runs/18402/attempts/1", opencode)).toEqual([
      { kind: "run", number: 18402, repo: opencode },
    ])
  })

  test("run urls naming the pr in the query", () => {
    const configs = { host: "github.com", owner: "archipelagoAI", repo: "configs" }
    expect(
      scanGh(
        "check https://github.com/archipelagoAI/configs/actions/runs/42387589605/job/128448162705?pr=2627",
        undefined,
      ),
    ).toEqual([
      { kind: "run", number: 42387589605, repo: configs },
      { kind: "pr", number: 2627, repo: configs },
    ])
  })

  test("tool outputs are scanned", () => {
    const text = textToScan([
      { type: "text", text: "no refs here" },
      { type: "tool", state: { output: "Created https://github.com/sst/opencode/pull/4821" } },
    ])
    expect(scan(text, opencode, [githubLexicon])).toEqual([{ kind: "pr", number: 4821, repo: opencode }])
  })

  test("tool state content blocks and invoked commands are scanned", () => {
    const fresnel: RepoRef = { host: "github.com", owner: "archipelagoAI", repo: "fresnel" }
    const text = textToScan([
      {
        type: "tool",
        state: {
          content: [{ type: "text", text: "merged PR 3684" }],
          input: { command: "gh pr view 3684" },
        },
      },
    ])
    const refs = scan(text, fresnel, [githubLexicon])
    expect(refs).toEqual([{ kind: "pr", number: 3684, repo: fresnel }])
  })

  test("run enumerations are treated as listings, not intent", () => {
    const listing = Array.from({ length: 8 }, (_, i) => `https://github.com/sst/opencode/actions/runs/${900 + i}`).join("\n")
    expect(scan(listing, opencode, [githubLexicon])).toEqual([])
    // A singled-out run in the same transcript still counts.
    expect(scan(`${listing}\nbut run ${906} is the one that failed`, opencode, [githubLexicon])).toEqual([
      { kind: "run", number: 906, repo: opencode },
    ])
  })

  test("pull urls with deep-link suffixes", () => {
    expect(scanGh("diff at https://github.com/sst/opencode/pull/4821/files", opencode)).toEqual([
      { kind: "pr", number: 4821, repo: opencode },
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

  test("markdown-linked PR reference (reported miss)", () => {
    const text =
      "Merged [PR #2494](https://github.com/archipelagoAI/configs/pull/2494) as `e8a6a2f9`. Checks passed, and I removed the worktree and local branch."
    const configs: RepoRef = { host: "github.com", owner: "archipelagoAI", repo: "configs" }

    // Session repo is configs: one reference, kind from the URL.
    expect(scanGh(text, configs)).toEqual([{ kind: "pr", number: 2494, repo: configs }])

    // Session repo is something else: the explicit URL wins; no phantom for the session repo.
    expect(scanGh(text, { host: "github.com", owner: "archipelagoAI", repo: "fresnel" })).toEqual([
      { kind: "pr", number: 2494, repo: configs },
    ])
  })

  test("same number in different repositories stay distinct when both are explicit", () => {
    const refs = scanGh("https://github.com/sst/opencode/issues/4821 and acme/api#4821", opencode)
    expect(refs).toHaveLength(2)
  })

  test("no lexicons: provider urls don't resolve, generic patterns still do", () => {
    expect(scan("https://github.com/sst/opencode/issues/7", opencode, [])).toEqual([])
    expect(scan("run 42 went green", opencode, [])).toEqual([{ kind: "run", number: 42, repo: opencode }])
  })
})

describe("messagesText", () => {
  // Fixtures mirror the SDK's SessionMessageInfo shapes: user messages carry
  // `text`; assistant messages carry a `content[]`; tool parts carry `state`.
  const user = (text: string) => ({ type: "user", id: "msg_1", text, time: { created: 0 } })
  const assistant = (content: unknown[]) => ({ type: "assistant", id: "msg_2", content, time: { created: 0 } })
  const toolState = {
    completed: (input: unknown, content: unknown[]) => ({ status: "completed", input, content }),
    running: { status: "running", input: {} },
    error: { status: "error", error: { message: "boom" } },
  }

  test("user message text is scanned directly", () => {
    expect(messagesText([user("ship PR 4821 please")])).toBe("ship PR 4821 please")
  })

  test("assistant text and reasoning parts are scanned", () => {
    const message = assistant([
      { type: "text", text: "opening a pull request" },
      { type: "reasoning", text: "refs 1043" },
    ])
    expect(messagesText([message])).toBe("opening a pull request\nrefs 1043")
  })

  test("completed tool parts contribute command and text output", () => {
    const message = assistant([
      {
        type: "tool",
        id: "tool_1",
        name: "bash",
        state: toolState.completed(
          { command: "gh run view 906" },
          [{ type: "text", text: "https://github.com/sst/opencode/actions/runs/906" }],
        ),
      },
    ])
    expect(messagesText([message])).toBe("gh run view 906\nhttps://github.com/sst/opencode/actions/runs/906")
  })

  test("running, erroring and in-flight tool parts contribute nothing", () => {
    const message = assistant([
      { type: "tool", id: "t1", name: "bash", state: toolState.running },
      { type: "tool", id: "t2", name: "bash", state: toolState.error },
      { type: "tool", id: "t3", name: "bash", state: undefined },
    ])
    expect(messagesText([message])).toBe("")
  })

  test("non-text tool output blocks and malformed entries are skipped", () => {
    const message = assistant([
      { type: "tool", id: "t1", name: "bash", state: toolState.completed({}, [{ type: "image", url: "x" }, null, "junk"]) },
    ])
    expect(messagesText([message])).toBe("")
    expect(messagesText([null, undefined, 42, {}, { type: "idle" }])).toBe("")
  })

  test("whole pipeline: a real-shaped transcript yields scannable text", () => {
    const transcript = [
      user("merge PR 4821 once green"),
      assistant([
        { type: "text", text: "PR 4821 is green; issue #1043 tracks the rollout" },
        {
          type: "tool",
          id: "t1",
          name: "bash",
          state: toolState.completed({ command: "gh pr view 4821" }, [{ type: "text", text: "https://github.com/sst/opencode/pull/4821" }]),
        },
      ]),
      { type: "idle" },
    ]
    // pr 4821 appears three ways (kind word, repeat, url) and dedupes to one;
    // the bare #1043 lands as an issue.
    expect(scan(messagesText(transcript), opencode, [githubLexicon]).map((ref) => ref.kind)).toEqual([
      "pr",
      "issue",
    ])
  })
})
