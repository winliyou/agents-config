#!/usr/bin/env node
// ab-reap-idle.mjs —— 空闲租约回收器：任务结束后回收遗留的 agent-browser 会话
//
// 为什么需要：
//   · DSH 会话结束时没有钩子调用 agent-browser close；
//   · 房客（--cdp attach）属上游 user-attached browser，默认永不空闲关闭；
//   · 独立实例的 idle timeout 被 wrapper 显式设为 0（owner 必须常驻）。
//   因此除 agent 主动 close 外，还需要一个不依赖会话结束、也不依赖后续浏览器调用的兜底。
//
// 机制：
//   wrapper 每次非 close 调用刷新 <session>.last-used；本脚本按阈值回收长期无命令的会话
//   （正常任务收尾由 agent 主动 close，本脚本只兜底）。
//
// 判据（全部满足才回收）：
//   · sock 存在 + .pid 指向的 daemon 存活（cmdline 含 agent-browser）；
//   · 该 sock 上没有 CLI 客户端（除 daemon 自己外无持有者）；
//   · last-used 距今 >= AB_IDLE_CLOSE_MS（默认 15 分钟）；无 last-used 的会话一律跳过
//     （未经 wrapper 记录的会话无法证明任务已结束，留人工处理）；
//   · 会话存在 >= AB_IDLE_MIN_AGE_MS（默认 2 分钟，防误杀刚启动的会话）；
//   · 名字不是 shared；二次复核客户端与 last-used 无变化后才动作。
//
// 行为：调用 wrapper 执行 close —— 房客先摘自己的 pinned tab 再退 daemon；
//       独立实例连自带 Chrome 与临时 profile 一起回收。
//
// 用法：
//   node ab-reap-idle.mjs --dry-run                  # 只评估
//   node ab-reap-idle.mjs                            # 实际回收
//   AB_IDLE_CLOSE_MS=1800000 node ab-reap-idle.mjs   # 30 分钟阈值
// 环境变量：AB_IDLE_CLOSE_MS（默认 900000）、AB_IDLE_MIN_AGE_MS（默认 120000）、AB_IDLE_DEBUG=1
// 定时：launchd com.chaoset.ab-idle-reaper 每 5 分钟
// 状态：运行时写 ~/.agent-browser/.last-idle-reap；动作/错误写 stdout

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.HOME || os.homedir();
const AB = path.join(HOME, ".agent-browser");
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const VERBOSE = argv.includes("-v") || process.env.AB_IDLE_DEBUG === "1";
const CLOSE_MS = Number(process.env.AB_IDLE_CLOSE_MS || 900000);
const MIN_AGE_MS = Number(process.env.AB_IDLE_MIN_AGE_MS || 120000);

const log = (...args) => console.log(new Date().toISOString(), ...args);
const dbg = (...args) => { if (VERBOSE) log("[dbg]", ...args); };
const sh = (cmd, args, env) => {
  try { return spawnSync(cmd, args, { encoding: "utf8", env }); } catch { return null; }
};
const out = (cmd, args) => { const r = sh(cmd, args); return r && r.status === 0 ? String(r.stdout || "") : ""; };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const cmdline = (pid) => out("ps", ["-o", "command=", "-p", String(pid)]).trim();
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const readPid = (name) => { try { return (fs.readFileSync(path.join(AB, name + ".pid"), "utf8") || "").trim(); } catch { return ""; } };
const holdersOf = (sock) => out("lsof", ["-t", sock]).split("\n").map((s) => s.trim()).filter(Boolean);

const wrapperBin = [
  process.env.AB_BIN,
  path.join(HOME, ".local/bin/agent-browser"),
  path.join(HOME, ".bun/bin/agent-browser"),
].filter(Boolean).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "agent-browser";

// 子进程环境：保留 HOME/PATH；清掉会话相关变量，避免影响显式 --session 语义
const childEnv = {
  ...process.env,
  HOME,
  PATH: [path.join(HOME, ".bun/bin"), path.join(HOME, ".local/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
};
delete childEnv.DSH_SESSION_ID;
delete childEnv.AGENT_BROWSER_SESSION;
delete childEnv.AGENT_BROWSER_GLOBAL_SESSION;

if (!fs.existsSync(AB)) process.exit(0);
const now = Date.now();
const reaped = [];
const dryList = [];
const errors = [];

for (const f of fs.readdirSync(AB)) {
  if (!f.endsWith(".sock")) continue;
  const name = f.slice(0, -5);
  if (name === "shared") { dbg("跳过 owner: shared"); continue; }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) { dbg("跳过非法会话名:", name); continue; }
  const sockPath = path.join(AB, f);

  let pid = readPid(name);
  if (pid && (!/^\d+$/.test(pid) || !alive(pid) || !/agent-browser/.test(cmdline(pid)))) pid = "";
  if (!pid) { dbg("无存活 daemon,交给 purge 处理:", name); continue; }
  if (holdersOf(sockPath).some((p) => p !== pid)) { dbg("有客户端在用,跳过:", name); continue; }

  const lastUsedPath = path.join(AB, name + ".last-used");
  if (!fs.existsSync(lastUsedPath)) { dbg("无 last-used,不自动回收:", name); continue; }

  const lastUsed = mtime(lastUsedPath);
  const idleAge = now - lastUsed;
  const sockAge = now - mtime(sockPath);
  if (sockAge < MIN_AGE_MS) { dbg("会话太新,跳过:", name); continue; }
  if (idleAge < CLOSE_MS) { dbg("空闲未达阈值,跳过:", name); continue; }

  const label = name + " (idle " + Math.round(idleAge / 60000) + "m)";
  if (DRY) { dryList.push(label); continue; }

  // 二次复核：客户端与 last-used 都未变化才动作，避免误杀刚开始的命令
  if (holdersOf(sockPath).some((p) => p !== pid)) { dbg("二次复核出现客户端,放弃:", name); continue; }
  if (mtime(lastUsedPath) > lastUsed) { dbg("last-used 刚刷新,放弃:", name); continue; }

  const r = sh(wrapperBin, ["--session", name, "close"], childEnv);
  if (!fs.existsSync(sockPath)) reaped.push(label);
  else errors.push(name + ": close 后 sock 仍在 (exit=" + (r ? r.status : "spawn-fail") + ")");
}

// 清理无主的 .last-used（会话已关闭但时间戳文件残留）
for (const f of fs.readdirSync(AB)) {
  if (!f.endsWith(".last-used")) continue;
  const name = f.slice(0, -".last-used".length);
  const sockGone = !fs.existsSync(path.join(AB, name + ".sock"));
  const pid = readPid(name);
  if (sockGone && !(pid && alive(pid))) {
    try { if (!DRY) fs.unlinkSync(path.join(AB, f)); } catch {}
  }
}

if (!DRY) {
  try { fs.writeFileSync(path.join(AB, ".last-idle-reap"), String(Date.now())); } catch {}
  for (const e of errors) log("[error]", e);
  for (const r of reaped) log("[reap]", "close", r);
}
if (DRY) console.log(dryList.length ? "[dry-run] 将回收: " + dryList.join(", ") : "[dry-run] 无空闲会话可回收");
