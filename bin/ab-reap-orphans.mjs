// ab-reap-orphans.mjs —— 孤儿 agent-browser daemon + headless Chrome 收割器(用户级公共层)
//
// 背景(2026-10-27 实测):显式 --session 独立实例(自带 headless Chrome + 临时 profile)的
// 宿主脚本被 SIGINT/SIGTERM/SIGKILL 打断、或 close 失败被 "|| true" 吞掉时,daemon 与它
// 拉起的 Chrome 都不会自退(attach 型 daemon 豁免空闲回收),一夜可累积多组孤儿
// (实测 8 组 ≈112% CPU + 5.2GB 内存,整机 load >15)。wrapper 的 purgeDeadSessionState
// 只清「进程已死」的残留状态文件,管不到「进程活着但宿主已消失」的实例 —— 本脚本补这一层。
//
// 判据(全部实测):
//   · 保护名单:shared(owner)、dsh-*/manual-*(房客 attach 模式,不自带 Chrome)、
//     AB_REAP_PROTECT_SESSIONS 额外名单 —— 一律不碰;
//   · 候选 = sock 存在且 daemon 存活,且其 Chrome 子进程用临时 profile
//     (user-data-dir 含 agent-browser-chrome-;持 profiles/main 的一律跳过,绝不误杀);
//   · 活跃判定:sock 持有者除 daemon 外还有别人 = 有客户端在用 → 清标记跳过;
//     活任务两次采样之间必有命令连接,不会误杀;
//   · 两段式:首次发现写标记(AB_HOME/.orphan-mark/<会话>),标记年龄 ≥ min-age
//     (默认 600s)且仍无客户端才收割 —— 宿主无论怎么死(含 SIGKILL)都能兜住。
//
// 动作:TERM→等 2s→KILL daemon;Chrome 子进程按「pid + user-data-dir 双重核对」
// (防 pid 回绕复用误杀;daemon 死后子进程过继 launchd,pgrep -P 将失效,故必须先记录)
// TERM→KILL;最后删状态文件与临时 profile 目录。
//
// 用法:
//   node ab-reap-orphans.mjs --dry-run        # 只评估不动手
//   node ab-reap-orphans.mjs --min-age 0      # 手动立即收割当前孤儿
// 环境:AB_ORPHAN_MIN_AGE(秒)、AB_REAP_PROTECT_SESSIONS(逗号分隔)、AB_ORPHAN_DEBUG=1、
//       AB_TMP_TTL_DAYS(默认 7;tmp/ 内过期截图/HAR 等产物的清理时限)。
// 附带职责:~/.agent-browser/tmp/ 是工具默认输出目录,截图/HAR 等产物按 TTL 自动清理,
// 防公共状态目录被当 scratch 无限膨胀(2026-10-27 实测 88MB/126 图)。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.HOME || os.homedir();
const AB_HOME = path.join(HOME, ".agent-browser");
const MARK_DIR = path.join(AB_HOME, ".orphan-mark");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("-v") || process.env.AB_ORPHAN_DEBUG === "1";
let minAge = Number(process.env.AB_ORPHAN_MIN_AGE || 600);
const mi = argv.indexOf("--min-age");
if (mi >= 0 && argv[mi + 1] != null) minAge = Number(argv[mi + 1]) || 0;
const dbg = (...a) => { if (verbose) console.log("[dbg]", ...a); };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const sh = (cmd, a) => { try { return spawnSync(cmd, a, { encoding: "utf8" }); } catch { return null; } };
const out = (cmd, a) => { const r = sh(cmd, a); return r && r.status === 0 ? String(r.stdout || "") : ""; };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const cmdline = (pid) => out("ps", ["-o", "command=", "-p", String(pid)]).trim();
const rmMarker = (name) => { try { fs.unlinkSync(path.join(MARK_DIR, name)); } catch {} };

const PROTECT = new Set(["shared"]);
for (const p of String(process.env.AB_REAP_PROTECT_SESSIONS || "").split(",")) {
  const t = p.trim(); if (t) PROTECT.add(t);
}
const protectedName = (n) => PROTECT.has(n) || /^(dsh-|manual-|shared-)/.test(n);

const killTree = (name, dpid, chromes) => {
  try { process.kill(Number(dpid), "SIGTERM"); } catch {}
  for (let i = 0; i < 5 && alive(dpid); i++) sleep(400);
  if (alive(dpid)) { try { process.kill(Number(dpid), "SIGKILL"); } catch {} }
  for (const c of chromes) {
    if (!alive(c.pid)) continue;
    if (!cmdline(c.pid).includes(c.udd)) continue; // pid 回绕复用防误杀
    try { process.kill(Number(c.pid), "SIGTERM"); } catch {}
    for (let i = 0; i < 5 && alive(c.pid); i++) sleep(300);
    if (alive(c.pid)) { try { process.kill(Number(c.pid), "SIGKILL"); } catch {} }
    if (/agent-browser-chrome-/.test(path.basename(c.udd))) {
      sleep(300);
      try { fs.rmSync(c.udd, { recursive: true, force: true }); } catch {}
    }
  }
  for (const ext of ["pid", "target", "config", "sock", "stream", "version", "engine"]) {
    try { fs.unlinkSync(path.join(AB_HOME, name + "." + ext)); } catch {}
  }
  rmMarker(name);
};

if (!fs.existsSync(AB_HOME)) process.exit(0);
fs.mkdirSync(MARK_DIR, { recursive: true });
const now = Date.now();
const killed = [], markedList = [], dryList = [];

for (const f of fs.readdirSync(AB_HOME)) {
  if (!f.endsWith(".sock")) continue;
  const name = f.slice(0, -5);
  if (protectedName(name)) { dbg("保护名单,跳过:", name); continue; }
  const sockPath = path.join(AB_HOME, f);
  let dpid = "";
  try { dpid = (fs.readFileSync(path.join(AB_HOME, name + ".pid"), "utf8") || "").trim(); } catch {}
  if (dpid && (!/^\d+$/.test(dpid) || !alive(dpid) || !/agent-browser/.test(cmdline(dpid)))) dpid = "";
  const holders = out("lsof", ["-t", sockPath]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (!dpid) dpid = holders.find((p) => /agent-browser/.test(cmdline(p))) || "";
  if (!dpid) { rmMarker(name); dbg("sock 无主(陈旧),清标记:", name); continue; }
  const clients = holders.filter((p) => p !== String(dpid));
  if (clients.length > 0) { rmMarker(name); dbg("有客户端在用,跳过:", name, clients.join(",")); continue; }
  // Chrome 子进程与 profile 检查(daemon 的直接子进程里只有浏览器主进程带 --user-data-dir)
  const kids = out("pgrep", ["-P", String(dpid)]).split("\n").map((s) => s.trim()).filter(Boolean);
  const chromes = [];
  let mainProfile = false;
  for (const k of kids) {
    const m = /--user-data-dir=(\S+)/.exec(cmdline(k));
    if (!m) continue;
    if (/(^|\/)profiles\/main($|\/)/.test(m[1])) { mainProfile = true; break; }
    if (m[1].includes("agent-browser-chrome-")) chromes.push({ pid: k, udd: m[1] });
  }
  if (mainProfile) { dbg("持 main profile 的 Chrome,绝不碰:", name); continue; }
  const label = chromes.length > 0 ? name + " (+" + chromes.length + " chrome)" : name + " (无chrome)";
  // 两段式收割
  const markPath = path.join(MARK_DIR, name);
  let first = 0;
  try { first = Number(fs.readFileSync(markPath, "utf8")) || 0; } catch {}
  if (first && now - first < minAge * 1000) {
    dbg("标记未满龄:", label, Math.ceil((minAge * 1000 - (now - first)) / 1000) + "s 后可收割");
    continue;
  }
  if (!first && minAge > 0 && !dryRun) {
    fs.writeFileSync(markPath, String(now));
    markedList.push(label);
    continue;
  }
  if (dryRun) { dryList.push(label); continue; }
  killTree(name, dpid, chromes);
  killed.push(label);
}

// ---- ~/.agent-browser/tmp 产物 TTL 清理(公共目录防膨胀) ----
const tmpTtlDays = Number(process.env.AB_TMP_TTL_DAYS || 7);
const tmpDir = path.join(AB_HOME, "tmp");
let tmpCleaned = 0;
try {
  const cutoff = Date.now() - tmpTtlDays * 86400000;
  const sweep = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) sweep(p);
      else {
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            if (!dryRun) fs.unlinkSync(p);
            tmpCleaned++;
          }
        } catch {}
      }
    }
  };
  if (fs.existsSync(tmpDir)) sweep(tmpDir);
  if (!dryRun && tmpCleaned > 0) {
    // 清掉被清空的子目录(保留 tmp 根)
    const prune = (d, isRoot) => {
      let empty = true;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (prune(p, false)) { try { fs.rmdirSync(p); } catch { empty = false; } }
          else empty = false;
        } else empty = false;
      }
      return empty && !isRoot ? true : empty;
    };
    try { prune(tmpDir, true); } catch {}
  }
} catch {}
if (tmpCleaned > 0) {
  console.log((dryRun ? "[dry-run] 将清理" : "已清理") + " tmp 产物 " + tmpCleaned + " 个(TTL " + tmpTtlDays + " 天)");
}

// 陈旧标记:会话已消失的一并清掉
try {
  for (const m of fs.readdirSync(MARK_DIR)) {
    if (!fs.existsSync(path.join(AB_HOME, m + ".sock"))) { try { fs.unlinkSync(path.join(MARK_DIR, m)); } catch {} }
  }
} catch {}

if (killed.length) console.log("已收割孤儿会话: " + killed.join(", "));
if (markedList.length) console.log("首次发现已标记(满 " + minAge + "s 且仍无客户端则收割): " + markedList.join(", "));
if (dryList.length) console.log("[dry-run] 将收割: " + dryList.join(", "));
if (!killed.length && !markedList.length && !dryList.length) console.log("无孤儿。");

