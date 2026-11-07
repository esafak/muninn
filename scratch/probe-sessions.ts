import { Database } from "bun:sqlite"
import { scan } from "../src/extract"
import { githubLexicon } from "../src/providers/github/lexicon"
import { readRemote } from "../src/remote"

const db = new Database("/Users/emre/.local/share/opencode/opencode.db", { readonly: true })
const sessions = [
  "ses_e49518d83ffehWTY887w0igZip", // GitHub Actions run 42387589605 failure
  "ses_e52ac3182ffdztZGmdyCsOzYQf", // Missing psycopg in GitHub Actions job
  "ses_e65ebdaffffdxM48gGcLOozGZj", // Renovate CLI weekly updates
  "ses_e499aad8cffewF1o9G3jxBnWS0", // Renovate two PRs per run
  "ses_f24ff3299ffeXwqgEPqwuDd0qw", // Community channel visibility by default
]

for (const sid of sessions) {
  const row = db.query("SELECT title, directory FROM session_v2 WHERE id=?").get(sid) as { title: string; directory: string }
  const repo = await readRemote(row.directory).catch(() => undefined)
  const rows = db
    .query("SELECT data FROM session_message WHERE session_id=? AND type IN ('user','assistant')")
    .all(sid) as { data: string }[]
  const texts: string[] = []
  for (const { data } of rows) {
    try {
      const parsed = JSON.parse(data)
      if (typeof parsed.metadata?.displayText === "string") texts.push(parsed.metadata.displayText)
      for (const item of parsed.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") texts.push(item.text)
        if (item.type === "tool" && typeof item.state?.output === "string") texts.push(item.state.output)
      }
    } catch {}
  }
  const text = texts.join("\n")
  const refs = scan(text, repo, [githubLexicon])
  console.log(`\n== ${row.title}`)
  console.log(`   repo: ${repo ? `${repo.owner}/${repo.repo}` : "NONE"} · text: ${text.length} chars`)
  const grouped = new Map<string, number[]>()
  for (const ref of refs) {
    const key = ref.repo ? `${ref.repo.owner}/${ref.repo.repo}` : "?"
    grouped.set(key, [...(grouped.get(key) ?? []), ref.number])
  }
  for (const [key, numbers] of grouped) console.log(`   ${key}: ${numbers.join(", ")}`)
  console.log(`   refs total: ${refs.length}`)
}
