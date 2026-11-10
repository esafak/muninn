---
name: session-debug
description: Inspect an OpenCode v2 session's storage and messages (opencode.db SQLite) and trace why Muninn's pill/footer shows a given issue, PR, or run. Triggers on "why is X in this session", debug-footer questions, ref-provenance questions, and session-data forensics.
---

# Session Debug

Debug "why does Muninn show X" from the outside in: find the session, dump its
messages, replay the extraction pipeline, verify hydration. V2 storage only.

## 1. Storage: one SQLite DB, not JSON files

Everything lives in `~/.local/share/opencode/opencode.db` (WAL mode). The old
`storage/` tree holds pre-v2 rows — ignore it. Inspect read-only; never write.

```sh
sqlite3 -readonly ~/.local/share/opencode/opencode.db "<query>"
```

Table map:

| Table            | Contents                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `session_v2`     | Current sessions: `id` (`ses_…`), `directory`, `title`, `project_id`, timestamps                          |
| `session_message`| One row per message: `id` (`msg_…`), `session_id`, `type` (`user`/`assistant`/`system`/`idle`), `seq`, `data` JSON |
| `blob`/`blob_ref`| Content-addressed blobs (images, attachments) referenced from message data                                |

Gotcha: `session`, `message`, `part`, and `session_part` exist but hold legacy
or empty data for v2 sessions. The **whole message — including the assistant
`content[]` parts — is inlined in `session_message.data`**. Don't hunt for a
parts table.

## 2. Recipes

The debug footer carries the full session ID (`gate ✓ <sessionID>`); `LIKE '<prefix>%'` works when you only have part of it:

```sh
sqlite3 -readonly ~/.local/share/opencode/opencode.db \
  "SELECT id, directory, title FROM session_v2 WHERE id LIKE 'ses_e41ec%'"
```

Dump the conversation in order (this is exactly what the GUI scans via
`session.message.list`):

```sh
out=$(mktemp) && sqlite3 -readonly ~/.local/share/opencode/opencode.db \
  "SELECT data FROM session_message WHERE session_id='<id>' ORDER BY seq" > "$out"
```

Transcripts can contain secrets (tokens, auth headers in tool output):
`mktemp` creates the file 0600 — keep it that way, redact before sharing, and
`rm "$out"` when done.

Message shapes (what each `data` JSON contains):

- `user`: `text` (what Muninn's user bucket scans) + `metadata.displayText`
- `assistant`: `content[]` of parts — `{type: "text" | "reasoning", text}` and
  `{type: "tool", tool?, state}` where `state` has `status`, `input`
  (`command`, `path`, …), and `content[]` of `{type: "text", text}` blocks
- `system` / `idle`: no scannable text

Only `state.status === "completed"` tool parts count — `messageBuckets` skips
the rest.

## 3. Replay the pipeline (src/extract.ts)

Port these functions to any language (Python is fine) and run them over the
dump to attribute each ref to its bucket, message, and exact match:

1. `stripCode` — remove fenced blocks and inline spans first.
2. `scan` — lexicon URLs/shorthand (src/providers/github/lexicon.ts), kind
   words, bare hashes; session repo is the session directory's git remote.
3. `messageBuckets` — user / commands (`state.input.command`) / prose
   (text+reasoning) / outputs (`state.content[]` text blocks, grouped per tool
   call).
4. `deliberateRefs` — tier rank user < command < prose < output (a ref keeps
   its best tier); **each text block of a tool output is judged on its own**:
   a block naming ≥ `LISTING_THRESHOLD` (3) refs of one kind is a listing and
   that kind drops from that block. Three blocks with one PR each keep all
   three.

Validate the simulation by asserting the debug footer's census matches
(`refs N (user a cmd b prose c out d)`). Then check hydration upstream:

```sh
gh pr view <n> --repo <owner>/<repo> --json state,title,updatedAt,headRefName
gh issue view <n> --repo <owner>/<repo> --json state,title
```

A ref "in the session" without an entity in the store is **not** automatically
a hydration failure. It can be:

- *pending* — the debounced message-change hydration hasn't run yet; re-check
- *skipped* — never sent to a provider: an unsupported ref host falls back to
  the session's own provider, so a ref drops silently only when neither
  resolves (no repo for the ref, no forge remote for the session) — these
  never count as unresolved
- *unresolved* — the provider was asked and returned nothing: wrong number,
  deleted run, private repo without a credential

## 4. Reading the debug footer

Built by `debugLine` in src/gui/window.tsx:

```
mn gui <sha+time> · srv <sha> · gate ✓ <sessionID> · chains N · eligible N
· pill: <#n title> · pick: <danger|newest|runs-only|none>[ of M] · lead <branch match|newest|—>
· refs N (user a cmd b prose c out d) → hits H/E ents[ · err <step>]
· SENT[/TOTAL] refs → H hydrated (kinds) · U unresolved (#nums)[ · K invalid dropped]
```

- `gate ✓` — the mounted session matches the pill's session (else pills are off)
- `pick` — `pillPick` rule that won: `danger` / `newest` / `runs-only` /
  `none`; `of M` counts PR chains for PR picks, run-bearing chains for
  `runs-only`;
  `lead` says whether the chain's lead PR matched the session's checkout branch
  (`branch match`) or is just the most recent (`—` for run-only picks, which
  print `run #id`; `pick: none` omits the lead part entirely)
- `refs` census — extracted candidates by provenance tier; `out` = tool outputs
- `hits/E` — how many refs hit the durable entity store of E cached entities
- `hydrated` / `unresolved` — outcome of the last **refresh-cycle** hydration
  (session mount or 30s poll). The debounced hydration on message changes
  updates `unresolved` but not the stats line, so stats can lag the newest
  messages. Unresolved = the provider was asked and returned nothing (wrong
  number, deleted run, private repo without a credential); refs skipped before
  hydration never appear here. `SENT/TOTAL` appears when `wireRefs` capped the
  payload (64, user-tier kept first) and `K invalid dropped` counts refs whose
  numbers fail the wire contract (a prose `#0`) — before `wireRefs` existed,
  one such ref rejected the whole hydrate RPC and wedged the panel error on
- `err <step>` — the last refresh failure's step (`repo` / `hydrate` /
  `branch-runs`); the panel shows the full `step: message` line. The server
  swallows provider errors into `unresolved`, so an error here is almost
  always transport (server restart) or an RPC contract rejection — check the
  browser console for `[muninn] <step> failed`

## 5. Known false-positive families (fixed on this branch — shapes still useful)

- Line-numbered tool output used to fabricate refs: a kind word at end of line
  plus the next line's number (`…via-pr\n6:`) scanned as `PR 6`; inline-code
  spans stripped by `stripCode` did the same for `run` (see the scan test "kind
  words and their numbers must share a line"). The shapes still explain phantom
  entities in older durable-cache entries and old debug footers.
- Coincidental collisions hydrate: a fabricated number can resolve to a real,
  unrelated entity (hydrated ≠ deliberate).
- The pill pick now runs over live chains only, and `pillPick` never returns a
  chain lacking both PRs and runs — a dead (merged) chain can't win, and an
  issue-only chain renders no pill at all.
