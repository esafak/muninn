/**
 * Assembles hydrated entities into chains — the triplet cards of the history panel.
 * Pure and shared: runs GUI-side over refreshed entities on every poll.
 */

import type { Chain, Entity, RunEntity } from "./model"
import { repoKey } from "./model"

const byNewest = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt

/**
 * Groups entities into chains:
 * - a pull request owns its CI runs (matched by head SHA) and the issue it closes
 *   (from its closing keywords, hydrated server-side)
 * - a session-branch run that matches no pull request stands alone
 * - an issue with no pull request stands alone until one appears
 */
export const associate = (entities: readonly Entity[], branchRuns: readonly RunEntity[] = []): Chain[] => {
  const pulls = entities.filter((entity): entity is Extract<Entity, { kind: "pr" }> => entity.kind === "pr")
  const issues = entities.filter((entity): entity is Extract<Entity, { kind: "issue" }> => entity.kind === "issue")
  const runs = [...entities.filter((entity): entity is RunEntity => entity.kind === "run"), ...branchRuns]

  const takenRuns = new Set<string>()

  const chains: Chain[] = pulls.map((pr) => {
    const owned = runs.filter((run) => run.headSha === pr.headSha && run.repo.owner === pr.repo.owner && run.repo.repo === pr.repo.repo)
    owned.forEach((run) => takenRuns.add(`${repoKey(run.repo)}#run${run.id}`))
    const closed = issues.find((issue) => issue.repo.owner === pr.repo.owner && issue.repo.repo === pr.repo.repo && pr.closes.includes(issue.number))
    const updatedAt = Math.max(pr.updatedAt, closed?.updatedAt ?? 0, ...owned.map((run) => run.updatedAt))

    return { key: `${repoKey(pr.repo)}#pr${pr.number}`, issue: closed, pr, runs: owned.toSorted(byNewest), updatedAt }
  })

  // Issues that no pulled-in PR claims, newest first among themselves.
  for (const issue of issues) {
    const claimed = chains.some((chain) => chain.issue === issue)
    if (claimed) continue
    chains.push({ key: `${repoKey(issue.repo)}#issue${issue.number}`, issue, runs: [], updatedAt: issue.updatedAt })
  }

  // Session-branch runs that belong to no pull request: pushes and scheduled work.
  for (const run of runs) {
    if (takenRuns.has(`${repoKey(run.repo)}#run${run.id}`)) continue
    chains.push({ key: `${repoKey(run.repo)}#run${run.id}`, runs: [run], updatedAt: run.updatedAt })
  }

  return chains.toSorted(byNewest)
}
