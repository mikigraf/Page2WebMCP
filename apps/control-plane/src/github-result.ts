import type { GitHubDraftPullRequestRecord } from "../../../packages/database/src/control-plane.ts";

export function gitHubDraftPullRequestProjection(record: GitHubDraftPullRequestRecord) {
  return {
    repository: { owner: record.owner, name: record.repository },
    number: record.number,
    url: record.url,
    branch: record.branch,
    baseCommitSha: record.baseCommitSha,
    headCommitSha: record.headCommitSha,
    check: { ...record.check },
    phase: record.phase,
    draft: record.draft,
    merged: record.merged,
    createdAt: record.createdAt,
  } as const;
}
