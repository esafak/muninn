import { Database } from "bun:sqlite"
import { messagesText, scan } from "../src/extract"
import { githubLexicon } from "../src/providers/github/lexicon"
import { associate } from "../src/associate"

const db = new Database("/Users/emre/.local/share/opencode/opencode.db", { readonly: true })
const id = "ses_e4cdaeedaffeCGUiz8hrlx0Mbk"

// Exactly what the GUI's message.list projection hands us.
const rows = db.query("SELECT data FROM session_message WHERE session_id = ? ORDER BY id", [id]).all() as { data: string }[]
const messages = rows.map((row) => JSON.parse(row.data))
console.log(`projected messages: ${messages.length}`)

const repo = { host: "github.com", owner: "archipelagoAI", repo: "fresnel" }
const text = messagesText(messages)
console.log(`text chars: ${text.length}`)

const refs = scan(text, repo, [githubLexicon])
const kinds: Record<string, number> = {}
for (const ref of refs) kinds[ref.kind ?? "bare"] = (kinds[ref.kind ?? "bare"] ?? 0) + 1
console.log(`refs: ${refs.length}`, JSON.stringify(kinds))
console.log(refs.map((r) => `${r.repo ? "r" : "@"}#${r.kind ?? ""}${r.number}`).join(" "))

// The durable cache seed, exactly what cached() feeds the entities store.
const drafts = new Database("/Users/emre/Library/Application Support/ai.opencode.desktop/drafts.sqlite", { readonly: true })
const cache = JSON.parse(drafts.query("SELECT value FROM state WHERE key='plugin.muninn.cache'").get()!.value) as { entries: Record<string, any> }
const entities = cache.entries
console.log(`seeded entities: ${Object.keys(entities).length}`)

const relevant = refs.flatMap((ref) => {
  if (ref.kind) {
    const key = `${ref.repo ? `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}` : "@"}#${ref.kind}${ref.number}`
    return entities[key] ? [entities[key]] : []
  }
  if (!ref.repo) return []
  const base = `${ref.repo.host}/${ref.repo.owner}/${ref.repo.repo}`
  return (["issue", "pr", "run"] as const).map((kind) => entities[`${base}#${kind}${ref.number}`]).filter(Boolean)
})
const prCount = relevant.filter((e: any) => e.kind === "pr").length
console.log(`relevant: ${relevant.length} (pr ${prCount})`)

const chains = associate(relevant, [])
const withPrs = chains.filter((chain) => chain.prs.length > 0)
console.log(`chains: ${chains.length} (with prs: ${withPrs.length})`)
for (const chain of withPrs.slice(0, 4)) console.log(`  pr #${chain.prs[0].number} [${chain.prs[0].state}] runs ${chain.runs.length}`)
