export interface RepoRef {
  slug: string;
  owner: string;
  name: string;
  path: string;
}

export interface RepoMeta {
  hasIssuesEnabled: boolean;
  defaultBranch: string;
  isPrivate: boolean;
  refreshedAt: string;
}

export type ItemKind = "issue" | "pr";

export interface ItemState {
  kind: ItemKind;
  title: string;
  state: "open" | "closed";
  seenComments: number;
  seenReviews: number;
  seenReviewComments: number;
  lastStatus: "baseline" | "handled" | "no-change" | "failed" | "gave-up" | "skipped" | "merged" | "closed";
  lastHandledAt?: string;
  lastEventId?: string;
  prNumber?: number;
  prUrl?: string;
  attempts: number;
  mergeRounds?: number;
  mergeNotePosted?: boolean;
}

export type EventKind = "new_issue" | "new_pr" | "issue_comment" | "pr_review" | "pr_review_comment";

export interface Event {
  id: string;
  kind: EventKind;
  repo: string;
  repoPath: string;
  number: number;
  title: string;
  isPullRequest: boolean;
  itemUrl: string;
  itemState: "open" | "closed";
  author: string;
  association: string;
  instruction: string;
  instructionUrl: string;
  createdAt: string;
  prHeadRef?: string;
  prBaseRef?: string;
  prCrossRepository?: boolean;
}

export interface QueuedEvent {
  event: Event;
  attempts: number;
  enqueuedAt: string;
  nextTryAt?: string;
  lastError?: string;
}

export interface RepoState {
  baselineAt: string;
  lastScanAt: string | null;
  meta: RepoMeta | null;
  items: Record<string, ItemState>;
  queue: QueuedEvent[];
  handled: string[];
}

export interface State {
  version: 1;
  installedAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  repos: Record<string, RepoState>;
}

export interface RunOutcome {
  ok: boolean;
  status: "handled" | "no-change" | "failed" | "gave-up" | "skipped";
  detail: string;
  prUrl?: string;
  sessionId?: string;
}

export interface DirectivesConfig {
  patterns: string[];
  negations: string[];
}

export interface Config {
  roots: string[];
  extraRepos: { slug: string; path: string }[];
  excludeRepos: string[];
  trustedAssociations: string[];
  trustedLogins: string[];
  ignoredLogins: string[];
  directives: DirectivesConfig;
  scan: {
    overlapSeconds: number;
    maxEventsPerRun: number;
    maxQueue: number;
    maxIssuesPerRepo: number;
    maxLookbackDays: number;
  };
  agent: {
    timeoutMinutes: number;
    maxAttempts: number;
    retryDelayMinutes: number;
    permissionMode: string;
    approvalPolicy: "never" | "ask";
    dshPath: string;
  };
  publish: {
    reopenClosed: boolean;
    draftPR: boolean;
    marker: string;
    skipExisting: boolean;
    maxCommentChars: number;
  };
  merge: {
    enabled: boolean;
    maxUnresolvedRounds: number;
    closeLinkedIssue: boolean;
  };
  stateDir: string;
  logDir: string;
}
