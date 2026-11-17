/**
 * GitHub's lexicon: which URLs and shorthand resolve to references. Pure — the GUI
 * bundles this; the network side of the provider lives in `../github`.
 */

import type { Lexicon } from "../lexicon"

const OWNER = String.raw`[\w.-]+`
const REPO = String.raw`[\w.-]+`

export const githubLexicon: Lexicon = {
  provider: "github",
  host: "github.com",
  // Patterns end at the captured id: GitHub's deep-link suffixes (/job/<id>,
  // /files, /attempts/1, #issuecomment-…) are irrelevant to extraction, and a
  // greedy \d+ already captures the full number.
  urls: [
    {
      kind: "issue",
      re: new RegExp(String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/issues/(\d+)`, "gi"),
    },
    {
      kind: "pr",
      re: new RegExp(String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/pull/(\d+)`, "gi"),
    },
    {
      kind: "run",
      // Deep links: suffixes (job ids, attempts, queries) don't matter — the
      // captured run id is what hydration needs.
      re: new RegExp(String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/actions/runs/(\d+)`, "gi"),
    },
    {
      kind: "pr",
      // Run links that name the PR in the query (?pr=2627) reference it explicitly.
      // For fork PRs (whose runs report an empty pull_requests array) this is the
      // only PR signal in the link itself; hydration resolves it via the API.
      re: new RegExp(
        String.raw`https://(?:www\.)?github\.com/(${OWNER})/(${REPO})/actions/runs/\d+(?:/[^\s?#]*)?\?[^#\s]*?pr=(\d+)`,
        "gi",
      ),
    },
  ],
  shorthand: { re: new RegExp(String.raw`(?<![\w@/])(${OWNER})/(${REPO})#(\d+)\b`, "g") },
  // Successful `gh pr create` prints the new PR's URL. Anchored so compound
  // commands (`view …; pr create`) and echoes never count as creation.
  creationCommand: /^\s*(gh\s+)?pr\s+create\b/i,
  // Executable addressing patterns for command-bucket text. Invocation only —
  // the engine extracts the number and `--repo`/`-R`. Supported placements are
  // encoded in `extract.ts` tests; `gh pr list` (no number) never matches.
  commands: [
    { kind: "pr", invocation: /^\s*gh\s+pr\s+(?:view|checks|comment|checkout|merge|edit|status)\b/i },
    { kind: "issue", invocation: /^\s*gh\s+issue\s+view\b/i },
    { kind: "run", invocation: /^\s*gh\s+run\s+view\b/i },
  ],
}
