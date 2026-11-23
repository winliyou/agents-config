import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.ts";

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS: Config = {
  roots: ["~/work"],
  extraRepos: [],
  excludeRepos: [],
  trustedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
  trustedLogins: [],
  ignoredLogins: ["dependabot[bot]", "github-actions[bot]", "renovate[bot]", "codecov[bot]"],
  directives: {
    patterns: [
      "(?:请|麻烦|帮忙|劳驾|拜托|能不能|可以)?\\s*(?:把|将)?\\s*(?:这个|该|此|上面|以下)?\\s*(?:issue|pr|问题|bug|需求|改动)?\\s*(?:再)?\\s*(?:解决|修复|处理|跟进|实现|改一下|改下|看一下|看下|瞅一下|重开|重新打开|合并)(?:一下|下|掉|吧)?",
      "(?:^|[\\s。，,；;])(?:please\\s+)?(?:fix|resolve|address|implement|handle|reopen|merge|take\\s+a\\s+look\\s+at|follow\\s+up\\s+on)\\b",
    ],
    negations: ["不用", "无需", "不需要", "不要", "不必", "暂不", "暂缓", "算了", "不用管", "已经解决", "已经处理", "已经修复", "已完成", "no need", "don't", "do not", "not necessary"],
  },
  scan: {
    overlapSeconds: 21600,
    maxEventsPerRun: 1,
    maxQueue: 30,
    maxIssuesPerRepo: 200,
    maxLookbackDays: 14,
  },
  schedule: {
    windows: [],
    intervalMinutes: 10,
  },
  agent: {
    timeoutMinutes: 45,
    maxAttempts: 3,
    retryDelayMinutes: 20,
    permissionMode: "workspace-write",
    approvalPolicy: "never",
    dshPath: "~/.bun/bin/dsh",
  },
  publish: {
    reopenClosed: true,
    draftPR: false,
    marker: "<!-- dsh-issue-agent -->",
    skipExisting: true,
    maxCommentChars: 8000,
  },
  merge: {
    enabled: false,
    maxUnresolvedRounds: 6,
    closeLinkedIssue: true,
  },
  stateDir: "~/.agents/.state/github-issue-automation",
  logDir: "~/.agents/.state/github-issue-automation/runs",
};

export function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch as T;
  if (typeof base !== "object" || typeof patch !== "object") return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge((out as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

export function configPath(): string {
  return process.env.GITHUB_ISSUE_AUTOMATION_CONFIG ?? join(SKILL_ROOT, "config.json");
}

export function loadConfig(): Config {
  const path = configPath();
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const cfg = deepMerge(DEFAULTS, raw);
  cfg.roots = cfg.roots.map(expandPath);
  cfg.extraRepos = cfg.extraRepos.map((repo) => ({ ...repo, path: expandPath(repo.path) }));
  cfg.stateDir = expandPath(cfg.stateDir);
  cfg.logDir = expandPath(cfg.logDir);
  cfg.agent.dshPath = expandPath(cfg.agent.dshPath);
  if (!cfg.directives.patterns.length) cfg.directives.patterns = DEFAULTS.directives.patterns;
  return cfg;
}

export function ensureDirs(cfg: Config): void {
  mkdirSync(cfg.stateDir, { recursive: true });
  mkdirSync(cfg.logDir, { recursive: true });
}
