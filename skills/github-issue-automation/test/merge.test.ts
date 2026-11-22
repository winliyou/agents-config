import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { classifyCheck, evaluatePr, isAutomationPr, summarizeChecks, type PrSnapshot } from "../src/merge.ts";

const cfg = loadConfig();

function pr(patch: Partial<PrSnapshot>): PrSnapshot {
  return {
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
    headRefName: "auto/issue-1-20260101",
    body: "body\n\n<!-- dsh-issue-agent -->",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [],
    ...patch,
  };
}

describe("classifyCheck", () => {
  test("CheckRun：成功/中性/跳过算通过", () => {
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" })).toBe("ok");
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" })).toBe("ok");
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" })).toBe("ok");
  });
  test("CheckRun：失败结论算失败", () => {
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" })).toBe("failed");
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" })).toBe("failed");
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "CANCELLED" })).toBe("failed");
  });
  test("CheckRun：未完成算运行中", () => {
    expect(classifyCheck({ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null })).toBe("pending");
    expect(classifyCheck({ __typename: "CheckRun", status: "QUEUED", conclusion: null })).toBe("pending");
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: null })).toBe("pending");
  });
  test("StatusContext：commit 状态按 state 判定", () => {
    expect(classifyCheck({ __typename: "StatusContext", state: "SUCCESS" })).toBe("ok");
    expect(classifyCheck({ __typename: "StatusContext", state: "PENDING" })).toBe("pending");
    expect(classifyCheck({ __typename: "StatusContext", state: "FAILURE" })).toBe("failed");
  });
});

describe("summarizeChecks", () => {
  test("汇总三类计数", () => {
    const summary = summarizeChecks([
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", state: "PENDING" },
    ]);
    expect(summary).toEqual({ ok: 1, pending: 1, failed: 1 });
  });
});

describe("isAutomationPr", () => {
  test("marker + auto/ 分支才算自动化 PR", () => {
    expect(isAutomationPr(pr({}), cfg.publish.marker)).toBe(true);
    expect(isAutomationPr(pr({ headRefName: "feature/x" }), cfg.publish.marker)).toBe(false);
    expect(isAutomationPr(pr({ body: "普通 PR 正文" }), cfg.publish.marker)).toBe(false);
  });
});

describe("evaluatePr", () => {
  test("已合并/已关闭", () => {
    expect(evaluatePr(pr({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }), cfg).verdict).toBe("done");
    expect(evaluatePr(pr({ state: "OPEN", mergedAt: "2026-01-01T00:00:00Z" }), cfg).verdict).toBe("done");
    expect(evaluatePr(pr({ state: "CLOSED" }), cfg).verdict).toBe("closed");
  });
  test("draft PR → wait", () => {
    expect(evaluatePr(pr({ isDraft: true }), cfg).verdict).toBe("wait");
  });
  test("人类 PR 永不自动合并", () => {
    const resolution = evaluatePr(pr({ headRefName: "feature/x", body: "无 marker" }), cfg);
    expect(resolution.verdict).toBe("human");
  });
  test("CI 全绿可合并 → merge", () => {
    const resolution = evaluatePr(pr({
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }), cfg);
    expect(resolution.verdict).toBe("merge");
  });
  test("无 CI 且状态干净 → merge", () => {
    expect(evaluatePr(pr({}), cfg).verdict).toBe("merge");
    expect(evaluatePr(pr({ mergeStateStatus: "BEHIND" }), cfg).verdict).toBe("merge");
  });
  test("CI 运行中 → wait", () => {
    const resolution = evaluatePr(pr({
      statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
    }), cfg);
    expect(resolution.verdict).toBe("wait");
  });
  test("CI 失败 → blocked", () => {
    const resolution = evaluatePr(pr({
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
    }), cfg);
    expect(resolution.verdict).toBe("blocked");
  });
  test("冲突 / review 请求修改 / 分支保护 → blocked", () => {
    expect(evaluatePr(pr({ mergeable: "CONFLICTING" }), cfg).verdict).toBe("blocked");
    expect(evaluatePr(pr({ mergeStateStatus: "DIRTY" }), cfg).verdict).toBe("blocked");
    expect(evaluatePr(pr({ reviewDecision: "CHANGES_REQUESTED" }), cfg).verdict).toBe("blocked");
    expect(evaluatePr(pr({ mergeStateStatus: "BLOCKED" }), cfg).verdict).toBe("blocked");
    expect(evaluatePr(pr({ mergeStateStatus: "UNSTABLE" }), cfg).verdict).toBe("blocked");
  });
  test("状态未知 → wait", () => {
    expect(evaluatePr(pr({ mergeable: "UNKNOWN" }), cfg).verdict).toBe("wait");
    expect(evaluatePr(pr({ mergeStateStatus: "UNKNOWN" }), cfg).verdict).toBe("wait");
  });
});
