import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { acceptsEvent, hasMarker, isDirective, isTrusted, slugify, stripCodeFences } from "../src/policy.ts";

const cfg = loadConfig();

describe("isTrusted", () => {
  test("接受仓库/组织成员", () => {
    expect(isTrusted("sailiu007", "MEMBER", "User", cfg)).toBe(true);
    expect(isTrusted("winliyou", "OWNER", "User", cfg)).toBe(true);
    expect(isTrusted("outsider", "COLLABORATOR", "User", cfg)).toBe(true);
  });
  test("拒绝普通贡献者与 bot", () => {
    expect(isTrusted("dependabot[bot]", "CONTRIBUTOR", "Bot", cfg)).toBe(false);
    expect(isTrusted("random", "CONTRIBUTOR", "User", cfg)).toBe(false);
    expect(isTrusted("random", "NONE", "User", cfg)).toBe(false);
  });
  test("支持额外白名单", () => {
    const custom = { ...cfg, trustedLogins: ["someone"] };
    expect(isTrusted("someone", "NONE", "User", custom)).toBe(true);
  });
});

describe("isDirective", () => {
  test("识别中文指令", () => {
    expect(isDirective("解决这个 issue", cfg)).toBe(true);
    expect(isDirective("请修复一下这个 bug", cfg)).toBe(true);
    expect(isDirective("麻烦处理一下这个 PR", cfg)).toBe(true);
    expect(isDirective("能重新打开继续跟进吗", cfg)).toBe(true);
  });
  test("识别英文指令", () => {
    expect(isDirective("please fix this", cfg)).toBe(true);
    expect(isDirective("can you take a look at this", cfg)).toBe(true);
    expect(isDirective("merge it once CI is green", cfg)).toBe(true);
  });
  test("忽略否定、已完成与代码块", () => {
    expect(isDirective("这个问题已经解决了", cfg)).toBe(false);
    expect(isDirective("这个不用修复", cfg)).toBe(false);
    expect(isDirective("暂不处理", cfg)).toBe(false);
    expect(isDirective("no need to fix this", cfg)).toBe(false);
    expect(isDirective("\u0060\u0060\u0060bash\nfix this\n\u0060\u0060\u0060", cfg)).toBe(false);
  });
  test("普通讨论不触发", () => {
    expect(isDirective("收到，我看看", cfg)).toBe(false);
    expect(isDirective("thanks!", cfg)).toBe(false);
  });
});

describe("helpers", () => {
  test("marker 检测", () => {
    expect(hasMarker("hello <!-- dsh-issue-agent -->", cfg.publish.marker)).toBe(true);
    expect(hasMarker("hello", cfg.publish.marker)).toBe(false);
  });
  test("代码块剥离", () => {
    expect(stripCodeFences("a \u0060code\u0060 b")).toBe("a   b");
  });
  test("slug 清理", () => {
    expect(slugify("fix the login bug!")).toBe("fix-the-login-bug");
    expect(slugify("修复登录问题")).toBe("task");
  });
});

describe("acceptsEvent", () => {
  function withIssueOnly(issueOnly: boolean) {
    return { ...cfg, scan: { ...cfg.scan, issueOnly } } as typeof cfg;
  }

  test("issueOnly 开启时只收 issue 事件", () => {
    const c = withIssueOnly(true);
    expect(acceptsEvent(false, c)).toBe(true);
    expect(acceptsEvent(true, c)).toBe(false);
  });

  test("issueOnly 关闭时 PR 事件照常收", () => {
    const c = withIssueOnly(false);
    expect(acceptsEvent(false, c)).toBe(true);
    expect(acceptsEvent(true, c)).toBe(true);
  });

  test("默认配置为只管 issue", () => {
    expect(loadConfig().scan.issueOnly).toBe(true);
  });
});