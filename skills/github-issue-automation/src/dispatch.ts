import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { git, gitCommonDir, gitDirty, gitTry } from "./git.ts";
import { gh, ghApiJson, ghApiObject, ghText } from "./gh.ts";
import { log } from "./log.ts";
import { normalizeBody, truncate } from "./policy.ts";
import { buildPrompt, type PromptInput, type ThreadComment } from "./prompt.ts";
import type { Config, Event, ItemState, RepoMeta, RunOutcome } from "./types.ts";

interface ExistingPr {
  number: number;
  url: string;
  state: string;
  headRefName: string;
}

interface WorktreePlan {
  worktree: string;
  branch: string;
  baseRef: string;
  targetRef: string;
  existingPrNumber?: number;
  existingPrUrl?: string;
  createNewPr: boolean;
}

interface AgentRun {
  ok: boolean;
  code: number | null;
  text: string;
  sessionId?: string;
  reason?: string;
  error?: string;
  logPath: string;
}

class SkipEvent extends Error {}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function tempFile(cfg: Config, name: string, body: string): string {
  const dir = join(cfg.stateDir, "tmp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, stamp() + "-" + name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

async function getExistingPr(ev: Event, item: ItemState | undefined): Promise<ExistingPr | null> {
  if (!item?.prNumber) return null;
  try {
    const out = await ghText([
      "pr", "view", String(item.prNumber), "--repo", ev.repo,
      "--json", "number,url,state,headRefName",
    ]);
    return JSON.parse(out) as ExistingPr;
  } catch {
    return null;
  }
}

async function prepareWorktree(ev: Event, meta: RepoMeta, cfg: Config, item: ItemState | undefined): Promise<WorktreePlan> {
  if (ev.isPullRequest && ev.prCrossRepository) throw new SkipEvent("该 PR 来自 fork，无法自动推送修改");
  const repoPath = ev.repoPath;
  const ts = stamp();
  const autoDir = join(repoPath, ".agents", "worktrees", "auto");

  if (ev.isPullRequest && ev.prHeadRef) {
    try {
      await git(repoPath, ["fetch", "origin", ev.prHeadRef]);
      const branch = "auto/pr-" + ev.number + "-" + ts;
      const worktree = join(autoDir, "pr-" + ev.number + "-" + ts);
      mkdirSync(autoDir, { recursive: true });
      await git(repoPath, ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/" + ev.prHeadRef]);
      return { worktree, branch, baseRef: "origin/" + ev.prHeadRef, targetRef: ev.prHeadRef, existingPrNumber: ev.number, existingPrUrl: ev.itemUrl, createNewPr: false };
    } catch (error) {
      log(cfg, "PR #" + ev.number + " 的 head 分支不可用，改为从默认分支新建 PR：" + (error as Error).message);
    }
  }

  const existing = ev.isPullRequest ? null : await getExistingPr(ev, item);
  if (existing && existing.state === "OPEN" && existing.headRefName.startsWith("auto/")) {
    await git(repoPath, ["fetch", "origin", existing.headRefName]);
    const branch = "auto/issue-" + ev.number + "-" + ts;
    const worktree = join(autoDir, "issue-" + ev.number + "-" + ts);
    mkdirSync(autoDir, { recursive: true });
    await git(repoPath, ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/" + existing.headRefName]);
    return { worktree, branch, baseRef: "origin/" + existing.headRefName, targetRef: existing.headRefName, existingPrNumber: existing.number, existingPrUrl: existing.url, createNewPr: false };
  }

  await git(repoPath, ["fetch", "origin", meta.defaultBranch]);
  const prefix = ev.isPullRequest ? "pr" : "issue";
  const branch = "auto/" + prefix + "-" + ev.number + "-" + ts;
  const worktree = join(autoDir, prefix + "-" + ev.number + "-" + ts);
  mkdirSync(autoDir, { recursive: true });
  await git(repoPath, ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/" + meta.defaultBranch]);
  return { worktree, branch, baseRef: "origin/" + meta.defaultBranch, targetRef: branch, createNewPr: true };
}

function openFd(path: string): number {
  return openSync(path, "w");
}

async function runAgent(worktree: string, prompt: string, cfg: Config, eventId: string): Promise<AgentRun> {
  const safeId = eventId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
  mkdirSync(cfg.logDir, { recursive: true });
  const base = join(cfg.logDir, stamp() + "-" + safeId);
  const stdoutPath = base + ".jsonl";
  const stderrPath = base + ".err";
  const promptPath = base + ".prompt.md";
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  const gitDir = await gitCommonDir(worktree);
  const args = [
    "--profile", "headless",
    "--permission-mode", cfg.agent.permissionMode,
    "--add-dir", gitDir,
    "--approval-policy", cfg.agent.approvalPolicy,
    "--json", "-",
  ];
  const outFd = openFd(stdoutPath);
  const errFd = openFd(stderrPath);
  const child = spawn(cfg.agent.dshPath, args, {
    cwd: worktree,
    env: process.env,
    detached: true,
    stdio: ["pipe", outFd, errFd],
  });
  child.stdin?.end(prompt);
  const timeoutMs = cfg.agent.timeoutMinutes * 60_000;
  let timedOut = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, "SIGTERM"); } catch {}
    hardKill = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 15_000);
  }, timeoutMs);
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (value) => resolve(value));
    child.on("error", () => resolve(null));
  });
  clearTimeout(timer);
  if (hardKill) clearTimeout(hardKill);
  closeSync(outFd);
  closeSync(errFd);

  let text = "";
  let sessionId: string | undefined;
  let reasonKind: string | undefined;
  let parseError: string | undefined;
  try {
    const lines = readFileSync(stdoutPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event["type"] === "session" && typeof event["sessionId"] === "string") sessionId = event["sessionId"];
      if (event["type"] === "final") {
        text = typeof event["text"] === "string" ? event["text"] : "";
        const reason = event["reason"] as { kind?: string } | null;
        reasonKind = reason?.kind;
      }
    }
  } catch (error) {
    parseError = (error as Error).message;
  }
  const stderrTail = (() => {
    try { return readFileSync(stderrPath, "utf8").slice(-2000).trim(); } catch { return ""; }
  })();
  if (timedOut) {
    return { ok: false, code, text, sessionId, reason: reasonKind, error: "执行超时（" + cfg.agent.timeoutMinutes + " 分钟）已终止", logPath: base };
  }
  if (code !== 0) {
    return { ok: false, code, text, sessionId, reason: reasonKind, error: "dsh 退出码 " + String(code) + "：" + (stderrTail || parseError || "无 stderr"), logPath: base };
  }
  if (reasonKind !== "completed") {
    return { ok: false, code, text, sessionId, reason: reasonKind, error: "dsh 未正常完成（reason=" + String(reasonKind) + "）：" + (stderrTail || "无 stderr"), logPath: base };
  }
  return { ok: true, code, text, sessionId, reason: reasonKind, logPath: base };
}

function suggestPrTitle(text: string, fallback: string): string {
  const match = text.match(/建议\s*PR\s*标题\s*[:：]\s*(.+)/i);
  const title = match?.[1]?.trim().replace(/^[`"“]|[`"”]$/g, "");
  if (title && title.length <= 120) return title;
  return fallback;
}

function fallbackPrTitle(ev: Event): string {
  const prefix = ev.isPullRequest ? "处理" : "修复";
  return (prefix + ": #" + ev.number + " " + ev.title).slice(0, 120);
}

function buildPrBody(ev: Event, run: AgentRun, plan: WorktreePlan, headSha: string): string {
  return [
    "## 背景",
    "关联 #" + ev.number + "：" + ev.title,
    "",
    "触发人：@" + ev.author + "（" + ev.association + "）",
    "触发位置：" + ev.instructionUrl,
    "",
    "## 改动",
    truncate(run.text || "（模型未输出摘要）", 6000),
    "",
    "## 验证",
    "由自动巡检 agent 在 worktree 内执行；完整命令输出见其摘要",
    "",
    "提交：" + headSha,
    "",
    "> 本 PR 由 DSH 自动巡检创建，不会自动合并，等待人工审核。",
    "",
    "<!-- dsh-issue-agent -->",
    "",
  ].join("\n");
}

function buildComment(ev: Event, run: AgentRun, plan: WorktreePlan, prUrl: string | undefined): string {
  const summary = truncate(run.text || "（无输出）", 5000);
  if (prUrl) {
    return [
      "已自动处理（DSH 自动巡检）。",
      "",
      "**摘要**",
      summary,
      "",
      "**PR**：" + prUrl,
      "",
      "<!-- dsh-issue-agent -->",
      "",
    ].join("\n");
  }
  return [
    "已按最新指令更新（DSH 自动巡检）。",
    "",
    "**摘要**",
    summary,
    "",
    "**分支**：" + plan.targetRef,
    "",
    "<!-- dsh-issue-agent -->",
    "",
  ].join("\n");
}

function buildNoChangeComment(ev: Event, run: AgentRun): string {
  return [
    "已检查（DSH 自动巡检），本次未产生代码改动。",
    "",
    truncate(run.text || "（模型未说明原因）", 6000),
    "",
    "<!-- dsh-issue-agent -->",
    "",
  ].join("\n");
}

async function reopenIfClosed(ev: Event, cfg: Config): Promise<void> {
  if (ev.itemState !== "closed" || !cfg.publish.reopenClosed) return;
  const command = ev.isPullRequest ? "pr" : "issue";
  const result = await gh([command, "reopen", String(ev.number), "--repo", ev.repo]);
  if (result.code !== 0) log(cfg, "reopen #" + ev.number + " 失败：" + result.stderr.trim().slice(0, 300));
}

async function fetchThread(ev: Event) {
  const issue = await ghApiObject<Record<string, unknown>>("repos/" + ev.repo + "/issues/" + ev.number);
  const comments = await ghApiJson<ThreadComment>("repos/" + ev.repo + "/issues/" + ev.number + "/comments?per_page=100");
  let reviews: ThreadComment[] = [];
  let reviewComments: ThreadComment[] = [];
  if (ev.isPullRequest) {
    reviews = await ghApiJson<ThreadComment>("repos/" + ev.repo + "/pulls/" + ev.number + "/reviews?per_page=100");
    reviewComments = await ghApiJson<ThreadComment>("repos/" + ev.repo + "/pulls/" + ev.number + "/comments?per_page=100");
  }
  return { issue, comments, reviews, reviewComments };
}

export async function handleEvent(ev: Event, cfg: Config, meta: RepoMeta, item: ItemState | undefined): Promise<RunOutcome> {
  log(cfg, "开始处理 " + ev.id + "（" + ev.repo + "#" + ev.number + "，" + ev.kind + "）");
  let plan: WorktreePlan | null = null;
  try {
    if (ev.isPullRequest && !ev.prHeadRef) {
      const pr = await ghApiObject<Record<string, unknown>>("repos/" + ev.repo + "/pulls/" + ev.number);
      const head = (pr["head"] ?? {}) as Record<string, unknown>;
      const headRepo = (head["repo"] ?? {}) as Record<string, unknown>;
      const base = (pr["base"] ?? {}) as Record<string, unknown>;
      const baseRepo = (base["repo"] ?? {}) as Record<string, unknown>;
      ev.prHeadRef = head["ref"] ? String(head["ref"]) : undefined;
      ev.prBaseRef = base["ref"] ? String(base["ref"]) : undefined;
      const headFull = headRepo["full_name"] ? String(headRepo["full_name"]) : "";
      const baseFull = baseRepo["full_name"] ? String(baseRepo["full_name"]) : "";
      ev.prCrossRepository = headFull !== "" && baseFull !== "" ? headFull !== baseFull : false;
    }
    if (ev.isPullRequest && !ev.prHeadRef) throw new SkipEvent("无法解析 PR 的 head 分支");
    await reopenIfClosed(ev, cfg);
    plan = await prepareWorktree(ev, meta, cfg, item);
    const thread = await fetchThread(ev);
    const diffStat = await gitTry(plan.worktree, ["diff", "--stat", plan.baseRef]);
    const input: PromptInput = {
      ev,
      meta,
      issue: thread.issue,
      comments: thread.comments,
      reviews: thread.reviews,
      reviewComments: thread.reviewComments,
      diffStat: diffStat.output,
      baseRef: plan.baseRef,
      worktree: plan.worktree,
    };
    const prompt = buildPrompt(input, cfg);
    const run = await runAgent(plan.worktree, prompt, cfg, ev.id);

    const metaPath = run.logPath + ".meta.json";
    writeFileSync(metaPath, JSON.stringify({ event: ev, plan, sessionId: run.sessionId, ok: run.ok, error: run.error }, null, 2), { mode: 0o600 });

    if (!run.ok) {
      return { ok: false, status: "failed", detail: run.error ?? "agent 执行失败", sessionId: run.sessionId };
    }

    let dirty = await gitDirty(plan.worktree);
    if (dirty.trim()) {
      await git(plan.worktree, ["add", "-A"]);
      await git(plan.worktree, ["commit", "-m", ("修复: 处理 #" + ev.number + " " + ev.title).slice(0, 100)]);
      dirty = await gitDirty(plan.worktree);
    }
    const count = Number(await git(plan.worktree, ["rev-list", "--count", plan.baseRef + "..HEAD"]));
    const headSha = await git(plan.worktree, ["rev-parse", "--short", "HEAD"]);

    if (!count || count < 1) {
      const body = buildNoChangeComment(ev, run);
      const file = tempFile(cfg, "comment-" + ev.number + ".md", body);
      await ghText(["issue", "comment", String(ev.number), "--repo", ev.repo, "--body-file", file]);
      return { ok: true, status: "no-change", detail: "未产生代码改动，已回复说明", sessionId: run.sessionId };
    }

    await git(plan.worktree, ["push", "origin", "HEAD:refs/heads/" + plan.targetRef], { timeoutMs: 300_000 });

    if (plan.createNewPr) {
      const title = suggestPrTitle(run.text, fallbackPrTitle(ev));
      const prBody = buildPrBody(ev, run, plan, headSha);
      const file = tempFile(cfg, "pr-" + ev.number + ".md", prBody);
      const args = ["pr", "create", "--repo", ev.repo, "--base", meta.defaultBranch, "--head", plan.targetRef, "--title", title, "--body-file", file];
      if (cfg.publish.draftPR) args.push("--draft");
      let url = "";
      try {
        url = await ghText(args, { timeoutMs: 180_000 });
      } catch (error) {
        const listed = await ghText(["pr", "list", "--repo", ev.repo, "--head", plan.targetRef, "--state", "open", "--json", "url", "--jq", ".[0].url"]).catch(() => "");
        if (!listed) throw error;
        url = listed.trim();
      }
      const comment = buildComment(ev, run, plan, url);
      const commentFile = tempFile(cfg, "link-" + ev.number + ".md", comment);
      await ghText(["issue", "comment", String(ev.number), "--repo", ev.repo, "--body-file", commentFile]);
      return { ok: true, status: "handled", detail: "已创建 PR " + url, prUrl: url, sessionId: run.sessionId };
    }

    const comment = buildComment(ev, run, plan, plan.existingPrUrl);
    const commentFile = tempFile(cfg, "comment-" + ev.number + ".md", comment);
    await ghText(["issue", "comment", String(ev.number), "--repo", ev.repo, "--body-file", commentFile]);
    return { ok: true, status: "handled", detail: "已更新 " + plan.targetRef, prUrl: plan.existingPrUrl, sessionId: run.sessionId };
  } catch (error) {
    if (error instanceof SkipEvent) {
      const body = error.message + "\n\n已跳过本次自动处理，需要人工介入。\n\n<!-- dsh-issue-agent -->\n";
      const file = tempFile(cfg, "skip-" + ev.number + ".md", body);
      await ghText(["issue", "comment", String(ev.number), "--repo", ev.repo, "--body-file", file]).catch(() => "");
      return { ok: true, status: "skipped", detail: error.message };
    }
    return { ok: false, status: "failed", detail: (error as Error).message };
  } finally {
    if (plan) {
      await gitTry(ev.repoPath, ["worktree", "remove", "--force", plan.worktree]).catch(() => {});
      await gitTry(ev.repoPath, ["branch", "-D", plan.branch]).catch(() => {});
    }
  }
}

export async function commentFinalFailure(ev: Event, cfg: Config, detail: string): Promise<void> {
  try {
    const body = [
      "自动处理失败（DSH 自动巡检），已停止重试，需要人工介入。",
      "",
      "~~~text",
      truncate(detail, 2000),
      "~~~",
      "",
      "<!-- dsh-issue-agent -->",
      "",
    ].join("\n");
    const file = tempFile(cfg, "failed-" + ev.number + ".md", body);
    await ghText(["issue", "comment", String(ev.number), "--repo", ev.repo, "--body-file", file]);
  } catch {}
}
