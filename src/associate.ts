/**
 * Assembles hydrated entities into chains — the triplet cards of the history
 * panel. Pure and shared: runs GUI-side over refreshed entities on every poll.
 *
 * Chains are connected components:
 * - PRs merge when they close a shared issue (renovate stacks, peer fixes)
 * - runs bind to their PR by head SHA
 * - issues bind to the PR that closes them; unmentioned issues stand alone
 * - branch runs that match no PR stand alone (pushes, scheduled work)
 *
 * The lead PR of a chain is the session's own (checkout branch match), else the
 * most recently active.
 */

import type { Chain, Entity, IssueEntity, PullEntity, RunEntity } from "./model"
import { pullsForRun, repoKey } from "./model"

const byNewest = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt
const sameRepo = (
  a: { repo: { host: string; owner: string; repo: string } },
  b: { repo: { host: string; owner: string; repo: string } },
): boolean => a.repo.host === b.repo.host && a.repo.owner === b.repo.owner && a.repo.repo === b.repo.repo

const entityKey = (entity: Entity): string =>
  `${repoKey(entity.repo)}#${entity.kind}${entity.kind === "run" ? entity.id : entity.number}`

interface PrGroup {
  prs: PullEntity[]
  /** Union of closing-issue numbers across the group's PRs. */
  issueNumbers: Set<number>
  runs: RunEntity[]
  issues: IssueEntity[]
}

export const associate = (
  entities: readonly Entity[],
  branchRuns: readonly RunEntity[] = [],
  sessionBranch?: string,
): Chain[] => {
  const uniqueEntities = [...new Map([...entities, ...branchRuns].map((entity) => [entityKey(entity), entity])).values()]
  const pulls = uniqueEntities.filter((entity): entity is PullEntity => entity.kind === "pr")
  const issues = uniqueEntities.filter((entity): entity is IssueEntity => entity.kind === "issue")
  const allRuns = uniqueEntities.filter((entity): entity is RunEntity => entity.kind === "run")

  // 1. Merge PRs into groups by shared closing issues.
  const groups: PrGroup[] = []
  for (const pull of pulls.toSorted(byNewest)) {
    const shared = groups.find(
      (group) => sameRepo(group.prs[0]!, pull) && pull.closes.some((number) => group.issueNumbers.has(number)),
    )
    if (shared) {
      shared.prs.push(pull)
      pull.closes.forEach((number) => shared.issueNumbers.add(number))
    } else {
      groups.push({ prs: [pull], issueNumbers: new Set(pull.closes), runs: [], issues: [] })
    }
  }

  // 2. Runs attach by GitHub's explicit association, exact head SHA, or branch.
  // Review-comment runs often omit pull_requests and use an older SHA, but keep
  // the PR branch name; those historical runs belong in the PR's activity chain.
  const takenRuns = new Set<string>()
  for (const group of groups) {
    for (const pr of group.prs) {
      const owned = allRuns.filter((run) => {
        return pullsForRun(run, pulls).some((associatedPull) => associatedPull.number === pr.number && sameRepo(associatedPull, pr))
      })
      owned.forEach((run) => takenRuns.add(`${repoKey(run.repo)}#run${run.id}`))
      for (const run of owned)
        if (!group.runs.some((candidate) => candidate.id === run.id && sameRepo(candidate, run))) group.runs.push(run)
    }
    for (const issue of issues) {
      if (sameRepo(issue, group.prs[0]!) && group.issueNumbers.has(issue.number)) group.issues.push(issue)
    }
    group.runs.sort(byNewest)
  }

  // 3. Build chains: lead PR = the session's own (checkout branch match), else the
  // most recent in the group.
  const chains: Chain[] = groups.map((group) => {
    const lead = group.prs.find((pr) => sessionBranch !== undefined && pr.headBranch === sessionBranch) ?? group.prs[0]!
    const updatedAt = Math.max(
      ...group.prs.map((pr) => pr.updatedAt),
      ...group.issues.map((issue) => issue.updatedAt),
      ...group.runs.map((run) => run.updatedAt),
    )
    return {
      key: `${repoKey(lead.repo)}#pr${lead.number}`,
      prs: group.prs.toSorted((a, b) => (a === lead ? -1 : b === lead ? 1 : byNewest(a, b))),
      issues: group.issues.toSorted(byNewest),
      runs: group.runs,
      updatedAt,
    }
  })

  // 4. Unclaimed issues stand alone; session-branch runs that match no PR too.
  for (const issue of issues) {
    if (chains.some((chain) => chain.issues.some((chained) => chained.number === issue.number && sameRepo(chained, issue))))
      continue
    chains.push({ key: `${repoKey(issue.repo)}#issue${issue.number}`, prs: [], issues: [issue], runs: [], updatedAt: issue.updatedAt })
  }
  for (const run of allRuns) {
    if (takenRuns.has(`${repoKey(run.repo)}#run${run.id}`)) continue
    chains.push({ key: `${repoKey(run.repo)}#run${run.id}`, prs: [], issues: [], runs: [run], updatedAt: run.updatedAt })
  }

  return chains.toSorted(byNewest)
}
