/**
 * Observes the full Muninn pipeline against live session data: transcript
 * from opencode.db → shipped scanner → shipped provider (real GitHub API) →
 * shipped associate → exact pill computation. Plus the durable cache contents
 * and recent RPC traffic from the server log. This is the loop: run, compare,
 * fix, re-run.
 *
 * Usage: bun scratch/observe.ts [session-id-prefix]
 */

import { Database } from "bun:sqlite"
import { scan, textToScan } from "../src/extract"
import { githubLexicon } from "../src/providers/github/lexicon"
import { github } from "../src/providers/github"
import { associate } from "../src/associate"
import { readRemote } from "../src/remote"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
const DAY_MS = 24 * 60 * 60 * 1000

const db = new Database("/Users/emre/.local/share/opencode/opencode.db", { readonly: true })
const prefix = process.argv[2] ?? ""

// The most recently updated non-subagent session (or the requested one).
const session = prefix
  ? (db.query("SELECT id, title, directory FROM session_v2 WHERE id LIKE ? ORDER BY time_updated DESC LIMIT 1").get(`${prefix}%`) as any)
  : (db
      .query(
        "SELECT id, title, directory FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1",
      )
      .get() as any)

if (!session) {
  console.log("no session found")
  process.exit(0)
}

console.log(`\n━━ session: ${session.title}`)
console.log(`   id: ${session.id} · dir: ${session.directory}`)

const repo = await readRemote(session.directory).catch(() => undefined)
const branch = await exec("git", ["-C", session.directory, "branch", "--show-current"], { timeout: 5000 })
  .then((r) => r.stdout.trim())
  .catch(() => "?")
const auth = async () =>
  (await exec("/bin/zsh", ["-ic", "gh auth token"], { timeout: 10_000 })).stdout.trim() || undefined

console.log(`   repo: ${repo ? `${repo.owner}/${repo.repo}` : "NONE"} · branch: ${branch}`)

// Transcript, exactly as the GUI projection provides it (text parts + tool
// results in their stored shapes).
const rows = db
  .query("SELECT data FROM session_message WHERE session_id=? AND type IN ('user','assistant')")
  .all(session.id) as { data: string }[]
const texts: string[] = []
for (const { data } of rows) {
  try {
    const parsed = JSON.parse(data)
    if (typeof parsed.metadata?.displayText === "string") texts.push(parsed.metadata.displayText)
    for (const item of parsed.content ?? []) {
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text)
      if (item.type === "reasoning" && typeof item.text === "string") texts.push(item.text)
      if (item.type === "tool" && item.state && typeof item.state === "object") {
        if (typeof item.state.output === "string") texts.push(item.state.output)
        if (Array.isArray(item.state.content))
          for (const block of item.state.content) if (block?.text) texts.push(block.text)
        if (item.state.input && typeof item.state.input === "object") {
          const command = (item.state.input as { command?: unknown }).command
          if (typeof command === "string") texts.push(command)
        }
      }
    }
  } catch {}
}
const text = texts.join("\n")
console.log(`   transcript: ${text.length} chars from ${rows.length} messages`)

// Stage 1: extraction (shipped scanner).
const refs = scan(text, repo ?? undefined, [githubLexicon])
const byKind = new Map<string, string[]>()
for (const ref of refs) {
  const key = `${ref.repo ? `${ref.repo.owner}/${ref.repo.repo}` : "no-repo"}`
  byKind.set(key, [...(byKind.get(key) ?? []), `${ref.kind ?? "unknown"}#${ref.number}`])
}
console.log(`\n━━ stage 1 · extraction: ${refs.length} refs`)
for (const [key, numbers] of byKind) console.log(`   ${key}: ${numbers.join(", ")}`)

// Stage 2: hydration (shipped provider, real API).
if (!repo) {
  console.log("\n━━ stage 2 · SKIPPED: no session repo")
  process.exit(0)
}
const hydration = await github.hydrate(
  refs.filter((ref) => ref.repo).map((ref) => ({ ...ref, repo: ref.repo! })),
  repo,
  auth,
)
console.log(`\n━━ stage 2 · hydration: ${hydration.entities.length} entities · ${hydration.unresolved.length} unresolved`)
for (const entity of hydration.entities)
  console.log(
    `   ${entity.kind} #${entity.kind === "run" ? entity.id : entity.number} [${entity.kind === "run" ? entity.status : entity.state}] ${entity.kind === "pr" ? `head ${entity.headSha.slice(0, 7)} closes ${entity.closes.join(",") || "-"}` : ""} ${"pullRequests" in entity && entity.pullRequests?.length ? `→ prs ${entity.pullRequests.join(",")}` : ""}`,
  )
for (const ref of hydration.unresolved) console.log(`   UNRESOLVED ${ref.repo.owner}/${ref.repo.repo}#${ref.number}`)

const { runs: branchRuns, prs: branchPrs } = await github.branchRuns(repo, branch, auth)
console.log(`   branch runs: ${branchRuns.map((run) => `#${run.id} [${run.headSha.slice(0, 7)}] ${run.status}`).join(", ") || "none"}`)
console.log(`   branch PRs: ${branchPrs.map((pr) => `#${pr.number} [${pr.headSha.slice(0, 7)}] ${pr.state}`).join(", ") || "none"}`)

// Stage 3: association (shipped).
const chains = associate([...hydration.entities, ...branchPrs], branchRuns)
console.log(`\n━━ stage 3 · association: ${chains.length} chains`)
for (const chain of chains) {
  const lead = chain.prs[0]
  const live =
    lead?.state === "open" ||
    lead?.state === "draft" ||
    chain.runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "failed") ||
    (chain.prs.length === 0 && chain.issues.some((issue) => issue.state === "open")) ||
    (chain.prs.length === 0 && chain.issues.length === 0 && Date.now() - chain.updatedAt < DAY_MS)
  console.log(
    `   ${live ? "LIVE " : "dead "} pr=${chain.prs.map((p) => `#${p.number} ${p.state}`).join(",") || "-"} issues=${chain.issues.map((i) => `#${i.number}`).join(",") || "-"} runs=${chain.runs.map((r) => `#${r.id} ${r.status}`).join(",") || "-"}`,
  )
}
