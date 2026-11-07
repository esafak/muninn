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
}
