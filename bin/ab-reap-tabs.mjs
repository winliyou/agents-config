#!/usr/bin/env node
// 孤儿 tab 兜底清理 —— 由 agent-browser wrapper 每至多 1h 派发一次(节流在 wrapper 侧),也可手动跑。
//
// 背景(2026-10-16 实测):房客 daemon 走 --cdp attach,属上游"user-attached browsers",豁免空闲回收,
// 永不自退;而"无 DSH_SESSION_ID 的调用"每次都会生成新访客(wrapper 的 manual-<ppid> 兜底),
// 每个新访客开一个新标签,又没人 close → 一夜累积 37 个标签(16 个 about:blank)。
//
// 只关两类"无内容即可回收"的标签,把误伤面压到零:
//   1) about:blank
//   2) https://gemini.google.com/app(新对话页,无对话内容)
// 有标题/带对话路径的 Gemini 页面绝不碰;owner(shared)的占位标签不碰。
// 保护"调用者自己":wrapper 派发时经 AB_REAP_PROTECT_SESSIONS 传入生效会话名
//   (手动直跑时读 AGENT_BROWSER_SESSION;都没有则无自我保护 —— 别在会话中途手动裸跑)。
// 即使误关了活会话的标签也无损失:其下次调用会按 tab_gone 自动重绑(wrapper 内建自愈,已实测)。
//
// 用法: node ab-reap-tabs.mjs [--dry-run]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DRY = process.argv.includes("--dry-run");
const AB = process.env.AGENT_BROWSER_HOME ?? join(homedir(), ".agent-browser");
const DEADLINE = Date.now() + 10_000; // 整体硬超时:清理绝不能拖垮任何调用方

// 二进制解析:PATH 里有 agent-browser 就用;否则回退 wrapper 绝对路径(2026-10-27 补:
// DSH 派发环境 PATH 可能缺 ~/.local/bin,裸命令名会 ENOENT → 静默 no-op,清理永远不生效)。
const AB_BIN_CANDS = [process.env.AB_BIN ?? "", join(homedir(), ".local/bin/agent-browser")].filter(Boolean);
const get = (cmd) => {
  for (const bin of AB_BIN_CANDS) {
    try {
      const r = spawnSync(bin, cmd, { encoding: "utf8", timeout: 8000 });
      if (!r.error) return (r.stdout ?? "").trim();
    } catch {}
  }
  return "";
};
const url = get(["get", "cdp-url"]);
if (!url.startsWith("ws")) process.exit(0); // 拿不到 CDP(浏览器没起等)→ 静默放弃

// 保护名单:owner(shared) + 调用者会话(wrapper 经 env 传入,可多个) + AGENT_BROWSER_SESSION
const protect = new Set();
const readTarget = (sess) => { try { return JSON.parse(readFileSync(join(AB, sess + ".target"), "utf8")).targetId; } catch { return null; } };
const protSess = [
  "shared",
  ...(process.env.AB_REAP_PROTECT_SESSIONS ?? "").split(/[,:]/),
  process.env.AGENT_BROWSER_SESSION ?? "",
].filter(Boolean);
for (const sess of protSess) { const tid = readTarget(sess); if (tid) protect.add(tid); }

const ws = new WebSocket(url);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pend.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const opened = new Promise((res) => { ws.addEventListener("open", res); ws.addEventListener("error", res); });
await Promise.race([opened, new Promise((r) => setTimeout(r, 5000))]);

try {
  const g = await send("Target.getTargets");
  const pages = (g.targetInfos ?? []).filter((t) => t.type === "page");
  const cands = pages.filter((t) => {
    const u = t.url || "";
    return !protect.has(t.targetId) && (u === "about:blank" || u === "https://gemini.google.com/app");
  });
  let ok = 0;
  for (const t of cands) {
    if (DRY) { console.log("[ab-reap-tabs][dry-run] 将回收 " + t.targetId.slice(0, 8) + " " + u0(t.url)); continue; }
    try { await send("Target.closeTarget", { targetId: t.targetId }); ok++; } catch {}
  }
  if (ok > 0 || DRY) console.log("[ab-reap-tabs] " + (DRY ? "dry-run" : "回收") + "孤儿标签 " + (DRY ? cands.length : ok) + " 个(仅 about:blank / 无内容新对话页)");
} catch {}
try { ws.close(); } catch {}
function u0(u) { return (u || "").slice(0, 60); }
setTimeout(() => process.exit(0), Math.max(0, DEADLINE - Date.now())).unref?.();
process.exit(0);
