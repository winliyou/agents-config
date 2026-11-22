import { loadConfig } from "./config.ts";
import { ghApiJson, ghApiObject, ghRateRemaining } from "./gh.ts";
import { log } from "./log.ts";
import { hasMarker, isDirective, isTrusted } from "./policy.ts";
import { discoverRepos, refreshRepoMeta } from "./repos.ts";
import { acquireLock, loadState, pruneRepoState, releaseLock, repoState, saveState } from "./state.ts";
import { commentFinalFailure, handleEvent } from "./dispatch.ts";
import { sweepAutoMerge } from "./merge.ts";
import type { Config, Event, ItemState, RepoMeta, RepoState, State } from "./types.ts";

const orgMembersCache = new Map<string, Set<string>>();

async function isOrgMember(owner: string, login: string, cfg: Config): Promise<boolean> {
  if (!login || cfg.ignoredLogins.includes(login)) return false;
  let members = orgMembersCache.get(owner);
  if (!members) {
    try {
      const list = await ghApiJson<{ login?: string }>("orgs/" + owner + "/members?per_page=100", [], true);
      members = new Set(list.map((member) => String(member.login ?? "")).filter(Boolean));
    } catch {
      members = new Set<string>();
    }
    orgMembersCache.set(owner, members);
  }
  return members.has(login);
}

interface Options {
  dryRun: boolean;
  status: boolean;
  repoFilter?: string;
  resetBaseline: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, status: false, resetBaseline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--reset-baseline") options.resetBaseline = true;
    else if (arg === "--repo") { i += 1; options.repoFilter = argv[i]; }
    else if (arg === "--once" || arg === "--verbose") { /* accepted, default behavior */ }
    else if (arg.startsWith("--repo=")) options.repoFilter = arg.slice("--repo=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: bun src/scan.ts [--dry-run] [--status] [--repo <owner/name>] [--reset-baseline]");
      process.exit(0);
    } else {
      console.error("未知参数: " + arg);
      process.exit(2);
    }
  }
  return options;
}

function sinceFor(repo: RepoState, cfg: Config): string {
  const now = Date.now();
  const baseline = Date.parse(repo.baselineAt);
  const last = repo.lastScanAt ? Date.parse(repo.lastScanAt) : baseline;
  const lookback = Math.max(baseline, now - cfg.scan.maxLookbackDays * 86_400_000);
  const from = Math.max(last - cfg.scan.overlapSeconds * 1000, lookback - cfg.scan.overlapSeconds * 1000);
  return new Date(Math.min(from, now)).toISOString();
}

function eventId(kind: string, id: number | string): string {
  return kind + ":" + String(id);
}

function buildItemState(kind: "issue" | "pr", item: Record<string, unknown>): ItemState {
  return {
    kind,
    title: String(item["title"] ?? ""),
    state: String(item["state"] ?? "open") === "closed" ? "closed" : "open",
    seenComments: 0,
    seenReviews: 0,
    seenReviewComments: 0,
    lastStatus: "baseline",
    attempts: 0,
  };
}

function makeEvent(args: {
  repo: { slug: string; path: string };
  kind: Event["kind"];
  id: string;
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
}): Event {
  return {
    id: args.id,
    kind: args.kind,
    repo: args.repo.slug,
    repoPath: args.repo.path,
    number: args.number,
    title: args.title,
    isPullRequest: args.isPullRequest,
    itemUrl: args.itemUrl,
    itemState: args.itemState,
    author: args.author,
    association: args.association,
    instruction: args.instruction,
    instructionUrl: args.instructionUrl,
    createdAt: args.createdAt,
    prHeadRef: args.prHeadRef,
    prBaseRef: args.prBaseRef,
    prCrossRepository: args.prCrossRepository,
  };
}

async function collectRepo(
  repo: { slug: string; path: string },
  repoStateValue: RepoState,
  meta: RepoMeta,
  cfg: Config,
): Promise<Event[]> {
  const since = sinceFor(repoStateValue, cfg);
  const lastScanMs = repoStateValue.lastScanAt ? Date.parse(repoStateValue.lastScanAt) : Date.parse(repoStateValue.baselineAt);
  const freshAfter = new Date(lastScanMs - 60 * 60 * 1000).toISOString();
  const recentUrl = "repos/" + repo.slug + "/issues?state=all&sort=updated&direction=desc&since=" + encodeURIComponent(since) + "&per_page=100";
  const recent = await ghApiJson<Record<string, unknown>>(recentUrl, [], true);
  const openUrl = "repos/" + repo.slug + "/issues?state=open&sort=updated&direction=desc&per_page=100";
  const open = await ghApiJson<Record<string, unknown>>(openUrl);
  const merged = new Map<number, Record<string, unknown>>();
  for (const item of recent) merged.set(Number(item["number"]), item);
  for (const item of open) merged.set(Number(item["number"]), item);
  const items = [...merged.values()].slice(0, cfg.scan.maxIssuesPerRepo);
  const events: Event[] = [];

  for (const item of items) {
    const number = Number(item["number"]);
    const isPr = Boolean(item["pull_request"]);
    const itemKey = (isPr ? "pr:" : "issue:") + number;
    const isOurs = hasMarker(item["body"] as string | undefined, cfg.publish.marker);
    let itemState = repoStateValue.items[itemKey];
    const isNew = !itemState;
    if (!itemState) {
      itemState = buildItemState(isPr ? "pr" : "issue", item);
      repoStateValue.items[itemKey] = itemState;
    }
    itemState.title = String(item["title"] ?? itemState.title);
    itemState.state = String(item["state"] ?? "open") === "closed" ? "closed" : "open";
    const title = itemState.title;
    const itemUrl = String(item["html_url"] ?? "");
    const itemAuthor = String((item["user"] as { login?: string } | undefined)?.login ?? "");
    const association = String(item["author_association"] ?? "NONE");

    const itemFresh = isNew || String(item["updated_at"] ?? "") >= freshAfter;
    let headRef: string | undefined;
    let baseRef: string | undefined;
    let cross = false;
    if (isPr && isNew) {
      try {
        const prInfo = await ghApiObject<Record<string, unknown>>("repos/" + repo.slug + "/pulls/" + number);
        const head = (prInfo["head"] ?? {}) as Record<string, unknown>;
        const headRepo = (head["repo"] ?? {}) as Record<string, unknown>;
        const base = (prInfo["base"] ?? {}) as Record<string, unknown>;
        const baseRepo = (base["repo"] ?? {}) as Record<string, unknown>;
        headRef = head["ref"] ? String(head["ref"]) : undefined;
        baseRef = base["ref"] ? String(base["ref"]) : undefined;
        const headFull = headRepo["full_name"] ? String(headRepo["full_name"]) : "";
        const baseFull = baseRepo["full_name"] ? String(baseRepo["full_name"]) : "";
        cross = headFull !== "" && baseFull !== "" ? headFull !== baseFull : false;
      } catch {}
    }

    const candidates: Event[] = [];
    const createdAt = String(item["created_at"] ?? "");
    if (isNew && !isOurs && itemState.state === "open" && createdAt >= repoStateValue.baselineAt) {
      if (isTrusted(itemAuthor, association, (item["user"] as { type?: string } | undefined)?.type, cfg)) {
        candidates.push(makeEvent({
          repo,
          kind: isPr ? "new_pr" : "new_issue",
          id: eventId(isPr ? "new-pr" : "new-issue", number),
          number,
          title,
          isPullRequest: isPr,
          itemUrl,
          itemState: itemState.state,
          author: itemAuthor,
          association,
          instruction: String(item["body"] ?? ""),
          instructionUrl: itemUrl,
          createdAt,
          prHeadRef: headRef,
          prBaseRef: baseRef,
          prCrossRepository: cross,
        }));
      }
    }

    let comments: Record<string, unknown>[] = [];
    if (itemFresh) {
      try {
        comments = await ghApiJson<Record<string, unknown>>(
          "repos/" + repo.slug + "/issues/" + number + "/comments?per_page=100&since=" + encodeURIComponent(since),
        );
      } catch (error) {
        log(cfg, repo.slug + "#" + number + " 评论拉取失败：" + (error as Error).message);
      }
    }
    for (const comment of comments) {
      const commentId = Number(comment["id"]);
      if (commentId <= itemState.seenComments) continue;
      itemState.seenComments = commentId;
      const commentCreated = String(comment["created_at"] ?? "");
      if (commentCreated < repoStateValue.baselineAt) continue;
      if (hasMarker(comment["body"] as string | undefined, cfg.publish.marker)) continue;
      const user = (comment["user"] ?? {}) as Record<string, unknown>;
      const login = String(user["login"] ?? "");
      const assoc = String(comment["author_association"] ?? "NONE");
      if (!isTrusted(login, assoc, user["type"] ? String(user["type"]) : undefined, cfg)) continue;
      if (!isDirective(comment["body"] as string | undefined, cfg)) continue;
      candidates.push(makeEvent({
        repo,
        kind: "issue_comment",
        id: eventId("comment", commentId),
        number,
        title,
        isPullRequest: isPr,
        itemUrl,
        itemState: itemState.state,
        author: login,
        association: assoc,
        instruction: String(comment["body"] ?? ""),
        instructionUrl: String(comment["html_url"] ?? itemUrl),
        createdAt: commentCreated,
        prHeadRef: headRef,
        prBaseRef: baseRef,
        prCrossRepository: cross,
      }));
    }

    if (isPr && itemFresh) {
      let reviews: Record<string, unknown>[] = [];
      try {
        reviews = await ghApiJson<Record<string, unknown>>("repos/" + repo.slug + "/pulls/" + number + "/reviews?per_page=100");
      } catch (error) {
        log(cfg, repo.slug + "#" + number + " review 拉取失败：" + (error as Error).message);
      }
      for (const review of reviews) {
        const reviewId = Number(review["id"]);
        if (reviewId <= itemState.seenReviews) continue;
        itemState.seenReviews = reviewId;
        const submitted = String(review["submitted_at"] ?? "");
        if (submitted < repoStateValue.baselineAt) continue;
        if (hasMarker(review["body"] as string | undefined, cfg.publish.marker)) continue;
        const user = (review["user"] ?? {}) as Record<string, unknown>;
        const login = String(user["login"] ?? "");
        const assoc = String(review["author_association"] ?? "NONE");
        const userType = user["type"] ? String(user["type"]) : undefined;
        const trusted = isTrusted(login, assoc, userType, cfg) || (await isOrgMember(repo.slug.split("/")[0], login, cfg));
        if (!trusted) continue;
        const reviewState = String(review["state"] ?? "");
        const actionable = reviewState === "CHANGES_REQUESTED" || isDirective(review["body"] as string | undefined, cfg);
        if (!actionable) continue;
        candidates.push(makeEvent({
          repo,
          kind: "pr_review",
          id: eventId("review", reviewId),
          number,
          title,
          isPullRequest: true,
          itemUrl,
          itemState: itemState.state,
          author: login,
          association: assoc,
          instruction: String(review["body"] ?? "") || "请求修改（changes requested）",
          instructionUrl: String(review["html_url"] ?? itemUrl),
          createdAt: submitted,
          prHeadRef: headRef,
          prBaseRef: baseRef,
          prCrossRepository: cross,
        }));
      }

      let reviewComments: Record<string, unknown>[] = [];
      if (itemFresh) {
        try {
          reviewComments = await ghApiJson<Record<string, unknown>>(
            "repos/" + repo.slug + "/pulls/" + number + "/comments?per_page=100&since=" + encodeURIComponent(since),
          );
        } catch (error) {
          log(cfg, repo.slug + "#" + number + " 行内评论拉取失败：" + (error as Error).message);
        }
      }
      for (const comment of reviewComments) {
        const commentId = Number(comment["id"]);
        if (commentId <= itemState.seenReviewComments) continue;
        itemState.seenReviewComments = commentId;
        const created = String(comment["created_at"] ?? "");
        if (created < repoStateValue.baselineAt) continue;
        if (hasMarker(comment["body"] as string | undefined, cfg.publish.marker)) continue;
        const user = (comment["user"] ?? {}) as Record<string, unknown>;
        const login = String(user["login"] ?? "");
        const assoc = String(comment["author_association"] ?? "NONE");
        if (!isTrusted(login, assoc, user["type"] ? String(user["type"]) : undefined, cfg)) continue;
        if (!isDirective(comment["body"] as string | undefined, cfg)) continue;
        const location = comment["path"] ? "（" + String(comment["path"]) + ":" + String(comment["line"] ?? "?") + "）" : "";
        candidates.push(makeEvent({
          repo,
          kind: "pr_review_comment",
          id: eventId("review-comment", commentId),
          number,
          title,
          isPullRequest: true,
          itemUrl,
          itemState: itemState.state,
          author: login,
          association: assoc,
          instruction: location + "\n" + String(comment["body"] ?? ""),
          instructionUrl: String(comment["html_url"] ?? itemUrl),
          createdAt: created,
          prHeadRef: headRef,
          prBaseRef: baseRef,
          prCrossRepository: cross,
        }));
      }
    }

    if (candidates.length) {
      candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      events.push(candidates[candidates.length - 1]);
    }
  }
  return events;
}

function enqueue(repo: RepoState, events: Event[], cfg: Config, now: string): void {
  for (const event of events) {
    if (repo.handled.includes(event.id)) continue;
    if (repo.queue.some((entry) => entry.event.id === event.id)) continue;
    repo.queue.push({ event, attempts: 0, enqueuedAt: now });
  }
  pruneRepoState(repo, 500, cfg.scan.maxQueue);
}

function findNext(state: State): { slug: string; repo: RepoState; entry: RepoState["queue"][number] } | null {
  const now = Date.now();
  const candidates: { slug: string; repo: RepoState; entry: RepoState["queue"][number] }[] = [];
  for (const [slug, repo] of Object.entries(state.repos)) {
    for (const entry of repo.queue) {
      const ready = !entry.nextTryAt || Date.parse(entry.nextTryAt) <= now;
      if (ready) candidates.push({ slug, repo, entry });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.entry.enqueuedAt.localeCompare(b.entry.enqueuedAt));
  return candidates[0];
}

async function processQueue(state: State, cfg: Config, repos: Map<string, { slug: string; path: string }>): Promise<number> {
  let processed = 0;
  const started = Date.now();
  while (processed < cfg.scan.maxEventsPerRun) {
    if (Date.now() - started > 50 * 60 * 1000) break;
    const next = findNext(state);
    if (!next) break;
    const { slug, repo, entry } = next;
    const repoRef = repos.get(slug);
    if (!repoRef || !repo.meta) {
      repo.queue = repo.queue.filter((item) => item.event.id !== entry.event.id);
      continue;
    }
    const itemKey = (entry.event.isPullRequest ? "pr:" : "issue:") + entry.event.number;
    const item = repo.items[itemKey];
    const outcome = await handleEvent(entry.event, cfg, repo.meta, item);
    const index = repo.queue.findIndex((item2) => item2.event.id === entry.event.id);
    if (outcome.status === "failed") {
      entry.attempts += 1;
      entry.lastError = outcome.detail;
      if (entry.attempts >= cfg.agent.maxAttempts) {
        if (index >= 0) repo.queue.splice(index, 1);
        if (item) {
          item.lastStatus = "gave-up";
          item.lastHandledAt = new Date().toISOString();
          item.attempts = entry.attempts;
        }
        await commentFinalFailure(entry.event, cfg, outcome.detail);
      } else {
        entry.nextTryAt = new Date(Date.now() + cfg.agent.retryDelayMinutes * 60_000).toISOString();
      }
      log(cfg, "处理失败 " + entry.event.id + "：" + outcome.detail + "（第 " + entry.attempts + " 次）");
    } else {
      if (index >= 0) repo.queue.splice(index, 1);
      if (!repo.handled.includes(entry.event.id)) repo.handled.push(entry.event.id);
      if (item) {
        item.lastStatus = outcome.status;
        item.lastHandledAt = new Date().toISOString();
        item.lastEventId = entry.event.id;
        item.attempts = entry.attempts + 1;
        if (outcome.prUrl) item.prUrl = outcome.prUrl;
        const prNumber = outcome.prUrl?.match(/\/pull\/(\d+)/)?.[1];
        if (prNumber) item.prNumber = Number(prNumber);
      }
      log(cfg, "处理完成 " + entry.event.id + "：" + outcome.status + " " + outcome.detail);
    }
    saveState(cfg, state);
    processed += 1;
  }
  return processed;
}

function printStatus(state: State, cfg: Config): void {
  console.log("state: " + cfg.stateDir);
  console.log("installedAt: " + state.installedAt);
  console.log("lastRunAt: " + (state.lastRunAt ?? "-"));
  for (const [slug, repo] of Object.entries(state.repos)) {
    const queued = repo.queue.length;
    const items = Object.keys(repo.items).length;
    console.log(slug + "  baseline=" + repo.baselineAt + "  lastScan=" + (repo.lastScanAt ?? "-") + "  items=" + items + "  queue=" + queued);
    for (const entry of repo.queue) {
      console.log("  queue: " + entry.event.id + " attempts=" + entry.attempts + " next=" + (entry.nextTryAt ?? "-") + " lastError=" + (entry.lastError ?? "-"));
    }
    for (const [key, item] of Object.entries(repo.items)) {
      if (!item.prNumber) continue;
      if (item.lastStatus === "merged" || item.lastStatus === "closed") continue;
      console.log("  pending-pr: " + key + " pr#" + item.prNumber + " status=" + item.lastStatus
        + " mergeRounds=" + (item.mergeRounds ?? 0) + " prUrl=" + (item.prUrl ?? "-"));
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const loaded = loadState(cfg);
  const state = options.dryRun ? (JSON.parse(JSON.stringify(loaded)) as State) : loaded;
  if (options.status) {
    printStatus(state, cfg);
    return;
  }
  if (options.resetBaseline) {
    const now = new Date().toISOString();
    for (const repo of Object.values(state.repos)) {
      repo.baselineAt = now;
      repo.lastScanAt = now;
      repo.queue = [];
      for (const item of Object.values(repo.items)) {
        item.lastStatus = "baseline";
        item.seenComments = 0;
        item.seenReviews = 0;
        item.seenReviewComments = 0;
      }
    }
    saveState(cfg, state);
    console.log("baseline 已重置为 " + now + "，队列已清空");
    return;
  }

  const locked = !options.dryRun && acquireLock(cfg);
  if (!options.dryRun && !locked) {
    console.log("上一次巡检尚未结束，跳过本轮");
    return;
  }

  try {
    const remaining = await ghRateRemaining();
    if (remaining >= 0 && remaining < 50) {
      log(cfg, "GitHub API 剩余配额过低（" + remaining + "），本轮跳过");
      return;
    }
    const allRepos = await discoverRepos(cfg);
    const filtered = options.repoFilter ? allRepos.filter((repo) => repo.slug === options.repoFilter) : allRepos;
    const repos = new Map(allRepos.map((repo) => [repo.slug, { slug: repo.slug, path: repo.path }]));
    const scanStart = new Date().toISOString();
    const dryEvents: unknown[] = [];

    for (const repo of filtered) {
      const repoStateValue = repoState(state, repo.slug, cfg.publish.skipExisting ? new Date() : new Date(0));
      try {
        const meta = await refreshRepoMeta(repo, repoStateValue.meta);
        repoStateValue.meta = meta;
        if (!meta.hasIssuesEnabled) {
          repoStateValue.lastScanAt = scanStart;
          continue;
        }
        const events = await collectRepo(repo, repoStateValue, meta, cfg);
        if (options.dryRun) {
          for (const event of events) dryEvents.push(event);
        } else {
          enqueue(repoStateValue, events, cfg, scanStart);
          repoStateValue.lastScanAt = scanStart;
          log(cfg, repo.slug + " 扫描完成，新增 " + events.length + " 个事件，队列 " + repoStateValue.queue.length);
        }
        if (!options.dryRun) saveState(cfg, state);
      } catch (error) {
        log(cfg, repo.slug + " 扫描失败：" + (error as Error).message);
      }
    }

    if (options.dryRun) {
      console.log(JSON.stringify(dryEvents, null, 2));
      return;
    }

    const processed = await processQueue(state, cfg, repos);
    const sweep = await sweepAutoMerge(state, cfg, repos);
    if (sweep.checked) {
      log(cfg, "解决确认：检查 " + sweep.checked + " 个 PR，自动合并 " + sweep.merged
        + "，等待 " + sweep.waiting + "，阻塞 " + sweep.blocked + "，终止 " + sweep.closed);
    }
    state.lastRunAt = new Date().toISOString();
    state.lastRunStatus = "ok";
    saveState(cfg, state);
    log(cfg, "本轮结束，处理 " + processed + " 个事件");
  } finally {
    if (!options.dryRun) releaseLock(cfg);
  }
}

main().catch((error) => {
  console.error("巡检失败：" + (error as Error).stack || String(error));
  process.exitCode = 1;
});
