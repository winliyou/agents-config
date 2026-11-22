// 解决确认（auto-merge sweep）：巡检每轮末尾检查已产出 PR 的任务是否已解决，
// 已解决（CI 全绿且可合并）的自动 rebase 合并并收尾；只处理本自动化创建的 PR。
import { gitTry } from "./git.ts";
import { ghText } from "./gh.ts";
import { log } from "./log.ts";
import { hasMarker, truncate } from "./policy.ts";
import { tempFile } from "./dispatch.ts";
import type { Config, ItemState, State } from "./types.ts";

export interface CheckRecord {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

export type CheckVerdict = "ok" | "pending" | "failed";

export function classifyCheck(check: CheckRecord): CheckVerdict {
  if (check.__typename === "StatusContext") {
    const state = String(check.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "ok";
    if (state === "PENDING" || state === "EXPECTED") return "pending";
    return "failed";
  }
  const status = String(check.status ?? "").toUpperCase();
  const conclusion = String(check.conclusion ?? "").toUpperCase();
  if (status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") return "ok";
  if (!conclusion) return "pending";
  return "failed";
}

export interface ChecksSummary {
  ok: number;
  pending: number;
  failed: number;
}

export function summarizeChecks(rollup: CheckRecord[]): ChecksSummary {
  const summary: ChecksSummary = { ok: 0, pending: 0, failed: 0 };
  for (const check of rollup) summary[classifyCheck(check)] += 1;
  return summary;
}

export interface PrSnapshot {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  isDraft: boolean;
  headRefName: string;
  body: string | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: string | null;
  statusCheckRollup: CheckRecord[];
}

export type ResolutionVerdict = "merge" | "wait" | "blocked" | "done" | "closed" | "human";

export interface Resolution {
  verdict: ResolutionVerdict;
  reason: string;
}

const MERGEABLE_STATE_OK = new Set(["CLEAN", "BEHIND", "HAS_HOOKS"]);

export function isAutomationPr(pr: PrSnapshot, marker: string): boolean {
  return hasMarker(pr.body, marker) && pr.headRefName.startsWith("auto/");
}

export function evaluatePr(pr: PrSnapshot, cfg: Config): Resolution {
  if (pr.state === "MERGED" || pr.mergedAt) return { verdict: "done", reason: "PR 已合并" };
  if (pr.state === "CLOSED") return { verdict: "closed", reason: "PR 已关闭且未合并" };
  if (!isAutomationPr(pr, cfg.publish.marker)) return { verdict: "human", reason: "非自动巡检创建的 PR，不自动合并" };
  if (pr.isDraft) return { verdict: "wait", reason: "PR 处于 draft 状态" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return { verdict: "blocked", reason: "与目标分支存在冲突" };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { verdict: "blocked", reason: "review 请求修改（changes requested）" };
  }
  const checks = summarizeChecks(pr.statusCheckRollup ?? []);
  if (checks.pending > 0) return { verdict: "wait", reason: "CI 仍在运行（未完成 " + checks.pending + " 项）" };
  if (checks.failed > 0) return { verdict: "blocked", reason: "CI 未全绿（失败 " + checks.failed + " 项）" };
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
    return { verdict: "wait", reason: "GitHub 尚未计算可合并状态" };
  }
  if (pr.mergeStateStatus === "BLOCKED") return { verdict: "blocked", reason: "被分支保护规则阻塞" };
  if (pr.mergeStateStatus === "UNSTABLE") return { verdict: "blocked", reason: "必需检查未通过" };
  if (!MERGEABLE_STATE_OK.has(pr.mergeStateStatus)) {
    return { verdict: "wait", reason: "可合并状态 " + pr.mergeStateStatus + " 待确认" };
  }
  if (pr.mergeable !== "MERGEABLE") return { verdict: "wait", reason: "可合并状态 " + pr.mergeable + " 待确认" };
  return { verdict: "merge", reason: "CI 全绿（" + checks.ok + " 项检查）且可合并" };
}

async function viewPr(repo: string, number: number): Promise<PrSnapshot> {
  const out = await ghText([
    "pr", "view", String(number), "--repo", repo,
    "--json", "number,url,state,mergedAt,isDraft,headRefName,body,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup",
  ], { timeoutMs: 60_000 });
  return JSON.parse(out) as PrSnapshot;
}

export interface SweepCounters {
  checked: number;
  merged: number;
  closed: number;
  blocked: number;
  waiting: number;
}

async function deleteRemoteBranch(repoPath: string, branch: string, cfg: Config): Promise<void> {
  if (!branch.startsWith("auto/")) return;
  const pushed = await gitTry(repoPath, ["push", "origin", "--delete", branch], { timeoutMs: 120_000 });
  if (!pushed.ok) {
    log(cfg, "删除远端分支 " + branch + " 失败：" + pushed.output.slice(0, 300));
    return;
  }
  await gitTry(repoPath, ["branch", "-D", branch]);
}

async function closeResolvedIssue(slug: string, issueNumber: number, prNumber: number, cfg: Config): Promise<void> {
  try {
    const state = await ghText(["issue", "view", String(issueNumber), "--repo", slug, "--json", "state", "--jq", ".state"]);
    if (state.trim().toUpperCase() !== "OPEN") return;
    const body = [
      "自动巡检任务完成：PR #" + prNumber + " 已合并（CI 全绿后自动合并）。",
      "",
      "<!-- dsh-issue-agent -->",
      "",
    ].join("\n");
    const file = tempFile(cfg, "merged-" + issueNumber + ".md", body);
    await ghText(["issue", "comment", String(issueNumber), "--repo", slug, "--body-file", file]);
    await ghText(["issue", "close", String(issueNumber), "--repo", slug]);
    log(cfg, slug + "#" + issueNumber + " 已随 PR #" + prNumber + " 合并完成并关闭");
  } catch (error) {
    log(cfg, slug + "#" + issueNumber + " 收尾失败：" + (error as Error).message);
  }
}

async function finishMerged(
  slug: string,
  key: string,
  item: ItemState,
  cfg: Config,
  now: string,
): Promise<void> {
  item.lastStatus = "merged";
  item.lastHandledAt = now;
  item.mergeRounds = 0;
  item.mergeNotePosted = false;
  if (key.startsWith("issue:") && cfg.merge.closeLinkedIssue) {
    const issueNumber = Number(key.slice("issue:".length));
    if (Number.isFinite(issueNumber) && item.prNumber) {
      await closeResolvedIssue(slug, issueNumber, item.prNumber, cfg);
    }
  }
}

async function noteBlocked(
  slug: string,
  key: string,
  item: ItemState,
  reason: string,
  cfg: Config,
  now: string,
): Promise<void> {
  item.mergeRounds = (item.mergeRounds ?? 0) + 1;
  item.lastHandledAt = now;
  log(cfg, slug + "#" + (item.prNumber ?? "?") + " 暂不能自动合并（第 " + item.mergeRounds + " 轮）：" + reason);
  if (item.mergeNotePosted || item.mergeRounds < cfg.merge.maxUnresolvedRounds) return;
  const number = key.startsWith("issue:") ? Number(key.slice("issue:".length)) : item.prNumber;
  if (!Number.isFinite(number) || !item.prNumber) return;
  const body = [
    "自动巡检无法完成收尾（DSH 自动巡检）。",
    "",
    "PR #" + item.prNumber + " 连续 " + item.mergeRounds + " 轮未满足自动合并条件：",
    truncate(reason, 500),
    "",
    "需要人工介入确认。",
    "",
    "<!-- dsh-issue-agent -->",
    "",
  ].join("\n");
  const file = tempFile(cfg, "merge-blocked-" + number + ".md", body);
  try {
    await ghText(["issue", "comment", String(number), "--repo", slug, "--body-file", file]);
    item.mergeNotePosted = true;
    log(cfg, slug + "#" + number + " 已留言需要人工介入");
  } catch (error) {
    log(cfg, slug + "#" + number + " 留言失败：" + (error as Error).message);
  }
}

export async function sweepAutoMerge(
  state: State,
  cfg: Config,
  repos: Map<string, { slug: string; path: string }>,
): Promise<SweepCounters> {
  const counters: SweepCounters = { checked: 0, merged: 0, closed: 0, blocked: 0, waiting: 0 };
  if (!cfg.merge.enabled) return counters;
  const now = new Date().toISOString();
  for (const [slug, repo] of Object.entries(state.repos)) {
    const repoRef = repos.get(slug);
    if (!repoRef) continue;
    for (const [key, item] of Object.entries(repo.items)) {
      if (!item.prNumber) continue;
      if (item.lastStatus === "merged" || item.lastStatus === "closed") continue;
      counters.checked += 1;
      try {
        const pr = await viewPr(slug, item.prNumber);
        const resolution = evaluatePr(pr, cfg);
        if (resolution.verdict === "human") {
          counters.waiting += 1;
          continue;
        }
        if (resolution.verdict === "wait") {
          counters.waiting += 1;
          log(cfg, slug + "#" + item.prNumber + " 等待解决：" + resolution.reason);
          continue;
        }
        if (resolution.verdict === "closed") {
          item.lastStatus = "closed";
          item.lastHandledAt = now;
          counters.closed += 1;
          log(cfg, slug + "#" + item.prNumber + " 已关闭且未合并，任务标记终止");
          continue;
        }
        if (resolution.verdict === "done") {
          counters.merged += 1;
          await finishMerged(slug, key, item, cfg, now);
          continue;
        }
        if (resolution.verdict === "blocked") {
          await noteBlocked(slug, key, item, resolution.reason, cfg, now);
          counters.blocked += 1;
          continue;
        }
        try {
          await ghText(["pr", "merge", String(pr.number), "--repo", slug, "--rebase"], { timeoutMs: 180_000 });
          await deleteRemoteBranch(repoRef.path, pr.headRefName, cfg);
          counters.merged += 1;
          log(cfg, slug + "#" + pr.number + " 已自动合并（" + resolution.reason + "）");
          await finishMerged(slug, key, item, cfg, now);
        } catch (error) {
          await noteBlocked(slug, key, item, "自动合并失败：" + (error as Error).message, cfg, now);
          counters.blocked += 1;
        }
      } catch (error) {
        counters.blocked += 1;
        await noteBlocked(slug, key, item, "查询 PR 状态失败：" + (error as Error).message, cfg, now);
      }
    }
  }
  return counters;
}
