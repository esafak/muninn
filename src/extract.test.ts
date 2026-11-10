import { describe, expect, test } from "bun:test"
import { deliberateRefs, messageBuckets, messagesText, scan, textToScan, LISTING_THRESHOLD, RUN_LISTING_LIMIT, WIRE_REF_CAP, scanDetailed, wireRefs } from "./extract"
import type { TieredRef } from "./extract"
import { githubLexicon } from "./providers/github/lexicon"
import type { RepoRef } from "./model"

const opencode: RepoRef = { host: "github.com", owner: "sst", repo: "opencode" }
const scanGh = (text: string, repo?: RepoRef) => scan(text, repo, [githubLexicon])

describe("scanDetailed", () => {
  test("origin tags reflect the syntax that produced each reference", () => {
    const refs = scanDetailed(
      [
        "pasted https://github.com/sst/opencode/pull/4821,",
        "cross-repo esafak/muninn#5,",
        "see PR 1043 or run 906, plus bare #77",
      ].join("\n"),
      opencode,
      [githubLexicon],
    )
    const originOf = (number: number) => refs.find((ref) => ref.number === number)?.origin
    expect(originOf(4821)).toBe("url")
    expect(originOf(5)).toBe("shorthand")
    expect(originOf(1043)).toBe("kindword")
    expect(originOf(906)).toBe("kindword")
    expect(originOf(77)).toBe("bare")
  })

  test("a kind word marks an explicitly referenced number as singled out — its origin wins", () => {
    const refs = scanDetailed("https://github.com/sst/opencode/actions/runs/906 — run 906 is the one", opencode, [githubLexicon])
    expect(refs).toEqual([{ number: 906, kind: "run", repo: opencode, origin: "kindword" }])
  })
})

describe("scan", () => {
  test("kind words resolve against the session repository", () => {
    expect(scanGh("The e2e suite is red on PR 4821, see issue 1043", opencode)).toEqual([
      { kind: "pr", number: 4821, repo: opencode },
      { kind: "issue", number: 1043, repo: opencode },
    ])
  })

  test("bare hashes keep an unknown kind", () => {
    const refs = scanGh("TUI still loses scroll position — #1043", opencode)
    expect(refs).toStrictEqual([{ number: 1043, repo: opencode }])
    // Shape-exact: no `kind` own property when the syntax didn't say.
    expect(Object.keys(refs[0]!).sort()).toEqual(["number", "repo"])
  })

  test("ordinal feedback numbers are not treated as issue or PR references", () => {
    expect(scanGh("Also feedback #2 about the toast; see the actual report #1043", opencode)).toEqual([
      { number: 1043, repo: opencode },
    ])
  })

  test("ordinal hashes match same-line spacing without suppressing other references", () => {
    const longSpaces = " ".repeat(40)
    expect(scanGh(`feedback${longSpaces}#2; actual report #2`, opencode)).toEqual([{ number: 2, repo: opencode }])
    expect(scanGh(`notfeedback${longSpaces}#2`, opencode)).toEqual([{ number: 2, repo: opencode }])
    expect(scanGh("feedback\n#2", opencode)).toEqual([{ number: 2, repo: opencode }])
  })

  test("a kind word cannot pair with a line-numbered tool-output line", () => {
    expect(scanGh("…via-pr\n6: something else", opencode)).toEqual([])
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

  test(`a mixed listing (${RUN_LISTING_LIMIT} distinct run refs) suppresses the url runs and keeps the kind-worded ones`, () => {
    const fourUrls = Array.from({ length: 4 }, (_, i) => `https://github.com/sst/opencode/actions/runs/${800 + i}`).join("\n")
    const refs = scan(`${fourUrls}\nbut run 901 and run 902 are the interesting ones`, opencode, [githubLexicon])
    expect(refs.map((ref) => ref.number).sort((a, b) => a - b)).toEqual([901, 902])
  })

  test("a kind word over an already-referenced run neither duplicates it nor counts toward a listing", () => {
    const fourUrls = Array.from({ length: 4 }, (_, i) => `https://github.com/sst/opencode/actions/runs/${800 + i}`).join("\n")
    const refs = scan(`${fourUrls}\nrun 801 and run 802 are the interesting ones`, opencode, [githubLexicon])
    expect(refs.map((ref) => ref.number).sort((a, b) => a - b)).toEqual([800, 801, 802, 803])
  })

  test("a five-run url block is a focused look, not a listing", () => {
    const five = Array.from({ length: 5 }, (_, i) => `https://github.com/sst/opencode/actions/runs/${700 + i}`).join("\n")
    expect(scan(five, opencode, [githubLexicon])).toHaveLength(5)
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

  test("kind words and their numbers must share a line", () => {
    // Real case: a read of renovate.json5 numbered `…via-pr` as line 5, `6:` as
    // line 6, and `run` + inline command as line 310 above `311:` — the newline
    // in `\s+` fabricated PR 6 and run 311 out of line numbers.
    expect(scanGh('# https://docs.renovatebot.com/getting-started/#reconfigure-via-pr\n6:   "$schema"', opencode)).toEqual([])
    expect(scanGh("run \n311:       // in ci/ to refresh", opencode)).toEqual([])
    expect(scanGh("run\n\t311: indented", opencode)).toEqual([])
    // stripCode replaces an inline span with a space: the number stays across the newline.
    expect(scanGh("run `mise exec uv lock` \n311: refresh", opencode)).toEqual([])
    // Same-line references are unaffected, even with numbered lines below.
    expect(scanGh("see PR 4821\n6: something else", opencode)).toEqual([{ kind: "pr", number: 4821, repo: opencode }])
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

describe("messageBuckets", () => {
  const userMessage = (text: string) => ({ type: "user", id: "m1", text, time: { created: 0 } })
  const assistantMessage = (content: unknown[]) => ({ type: "assistant", id: "m2", content, time: { created: 0 } })
  const toolPart = (input: unknown, output: string) => ({
    type: "tool",
    id: "t1",
    name: "bash",
    state: { status: "completed", input, content: [{ type: "text", text: output }] },
  })

  test("user text lands in user, assistant text in prose", () => {
    const buckets = messageBuckets([userMessage("look at PR 4821"), assistantMessage([{ type: "text", text: "PR 4821 is green" }])])
    expect(buckets.user).toEqual(["look at PR 4821"])
    expect(buckets.prose).toEqual(["PR 4821 is green"])
    expect(buckets.commands).toEqual([])
    expect(buckets.outputs).toEqual([])
  })

  test("tool commands and outputs land separately, per tool call", () => {
    const message = assistantMessage([toolPart({ command: "gh pr view 3670" }, "opened yesterday"), toolPart({ command: "gh run list" }, "run 1\nrun 2")])
    const buckets = messageBuckets([message])
    expect(buckets.commands).toEqual(["gh pr view 3670", "gh run list"])
    expect(buckets.outputs).toEqual([["opened yesterday"], ["run 1\nrun 2"]])
  })

  test("incomplete tool states contribute nothing", () => {
    const message = assistantMessage([{ type: "tool", id: "t", name: "bash", state: { status: "running", input: {} } }])
    expect(messageBuckets([message]).outputs).toEqual([])
  })
})

describe("deliberateRefs", () => {
  const userMessage = (text: string) => ({ type: "user", id: "m1", text, time: { created: 0 } })
  const assistantMessage = (content: unknown[]) => ({ type: "assistant", id: "m2", content, time: { created: 0 } })
  const toolPart = (input: unknown, output: string) => ({
    type: "tool",
    id: "t1",
    name: "bash",
    state: { status: "completed", input, content: [{ type: "text", text: output }] },
  })

  test("a focused tool output (1-2 refs of a kind) is deliberate", () => {
    const buckets = messageBuckets([assistantMessage([toolPart({ command: "gh pr view 3670" }, "PR 3670 is open")])])
    expect(deliberateRefs(buckets, opencode, [githubLexicon]).map((ref) => ref.number)).toContain(3670)
  })

  test(`a listing (${LISTING_THRESHOLD}+ same-kind refs in one output) drops that kind`, () => {
    const output = "PR 100 x\nPR 200 y\nPR 300 z"
    const buckets = messageBuckets([assistantMessage([toolPart({ command: "gh pr list" }, output)])])
    expect(deliberateRefs(buckets, opencode, [githubLexicon])).toEqual([])
  })

  test("listing suppression is per kind: 3 issues don't drop 2 prs in the same output", () => {
    const output = "issue 10\nissue 11\nissue 12\nPR 20 a\nPR 21 b"
    const buckets = messageBuckets([assistantMessage([toolPart({ command: "gh api things" }, output)])])
    const numbers = deliberateRefs(buckets, opencode, [githubLexicon]).map((ref) => ref.number).sort((a, b) => a - b)
    expect(numbers).toEqual([20, 21])
  })

  test("the same ref keeps its highest tier: user beats output", () => {
    const buckets = messageBuckets([
      userMessage("merge PR 4821"),
      assistantMessage([toolPart({ command: "gh pr view 4821" }, "PR 4821 ready")]),
    ])
    const refs = deliberateRefs(buckets, opencode, [githubLexicon])
    expect(refs.filter((ref) => ref.number === 4821)).toHaveLength(1)
    expect(refs.find((ref) => ref.number === 4821)?.tier).toBe("user")
  })

  test("bare-hash listings are suppressed as a group too", () => {
    const output = "#1 a\n#2 b\n#3 c"
    const buckets = messageBuckets([assistantMessage([toolPart({ command: "grep -r fix" }, output)])])
    expect(deliberateRefs(buckets, opencode, [githubLexicon])).toEqual([])
  })

  test(`the run-listing rule (${RUN_LISTING_LIMIT}+ run refs in one block) applies at every tier`, () => {
    const listing = Array.from({ length: 6 }, (_, i) => `https://github.com/sst/opencode/actions/runs/${900 + i}`).join("\n")
    // The plain listing drops from user, command and prose alike — tested per
    // tier so one tier's dedupe can't mask another's miss.
    for (const buckets of [
      { user: [listing], commands: [], prose: [], outputs: [] },
      { user: [], commands: [listing], prose: [], outputs: [] },
      { user: [], commands: [], prose: [listing], outputs: [] },
    ])
      expect(deliberateRefs(buckets, opencode, [githubLexicon])).toEqual([])
    // A kind-worded run is singled out: it survives the listing at every tier.
    const singled = `${listing}\nbut run 906 is the one that failed`
    const tiers = [
      { user: [singled], commands: [], prose: [], outputs: [] },
      { user: [], commands: [singled], prose: [], outputs: [] },
      { user: [], commands: [], prose: [singled], outputs: [] },
    ]
    for (const buckets of tiers)
      expect(deliberateRefs(buckets, opencode, [githubLexicon]).map((ref) => ref.number)).toEqual([906])
    const outputBuckets = messageBuckets([assistantMessage([toolPart({ command: "gh run list" }, singled)])])
    expect(deliberateRefs(outputBuckets, opencode, [githubLexicon]).map((ref) => ref.number)).toEqual([906])
  })

  test("candidates keep the exact TieredRef shape — no origin leak", () => {
    const buckets = { user: ["pasted https://github.com/sst/opencode/pull/4821"], commands: [], prose: [], outputs: [] }
    expect(deliberateRefs(buckets, opencode, [githubLexicon])).toStrictEqual([
      { number: 4821, kind: "pr", repo: opencode, tier: "user" },
    ])
    const bare = { user: ["see #77"], commands: [], prose: [], outputs: [] }
    const refs = deliberateRefs(bare, opencode, [githubLexicon])
    expect(refs).toStrictEqual([{ number: 77, repo: opencode, tier: "user" }])
    expect(Object.keys(refs[0]!).sort()).toEqual(["number", "repo", "tier"])
    // A merged (deduplicated) bare ref keeps its `kind` slot — the exact shape
    // the old merge branch produced.
    const dedup = { user: ["see #77 and #77"], commands: [], prose: [], outputs: [] }
    const merged = deliberateRefs(dedup, opencode, [githubLexicon])
    expect(merged).toHaveLength(1)
    expect(Object.keys(merged[0]!).sort()).toEqual(["kind", "number", "repo", "tier"])
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

describe("wireRefs", () => {
  const tiered = (number: number, tier: TieredRef["tier"] = "prose", kind?: TieredRef["kind"]): TieredRef =>
    ({ number, tier, ...(kind ? { kind } : {}), repo: opencode })

  test("passes valid refs through under the cap", () => {
    const refs = [tiered(1, "user"), tiered(2, "output", "pr")]
    expect(wireRefs(refs)).toEqual({ refs, dropped: 0, capped: false })
  })

  test("drops refs the wire contract rejects — a prose '#0' must not reject the whole call", () => {
    const refs = [tiered(12, "user", "pr"), tiered(0), tiered(-3), tiered(Number.MAX_SAFE_INTEGER + 1)]
    const wire = wireRefs(refs)
    expect(wire.refs.map((ref) => ref.number)).toEqual([12])
    expect(wire.dropped).toBe(3)
    expect(wire.capped).toBe(false)
  })

  test("caps at the RPC limit keeping the most deliberate tiers first", () => {
    const refs = [
      ...Array.from({ length: 40 }, (_, index) => tiered(index + 1, "output", "pr")),
      ...Array.from({ length: 40 }, (_, index) => tiered(index + 100, "user")),
    ]
    const wire = wireRefs(refs)
    expect(wire.capped).toBe(true)
    expect(wire.refs).toHaveLength(WIRE_REF_CAP)
    expect(wire.refs.slice(0, 40).every((ref) => ref.tier === "user")).toBe(true)
    expect(wire.refs.slice(40).every((ref) => ref.tier === "output")).toBe(true)
    expect(wire.dropped).toBe(0)
  })

  test("stable within a tier: first-seen order survives truncation", () => {
    const refs = Array.from({ length: WIRE_REF_CAP + 1 }, (_, index) => tiered(index + 1, "command", "run"))
    expect(wireRefs(refs).refs.map((ref) => ref.number)).toEqual(refs.slice(0, WIRE_REF_CAP).map((ref) => ref.number))
  })

  test("honors a smaller cap", () => {
    const wire = wireRefs([tiered(1, "user"), tiered(2, "prose"), tiered(3, "output")], 2)
    expect(wire.refs.map((ref) => ref.number)).toEqual([1, 2])
    expect(wire.capped).toBe(true)
  })
})
