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
//     (默认 600s)且仍无客户端才收割 —— 宿主无论怎么死(含 SIGKILL)都能兜住;
//   · 盲区扫描(2026-10-28):daemon 活着但其 sock 已从磁盘消失(wrapper purge 依 .pid
//     判死跨代误删,实测 cnm-e2e 一个名字泄漏 3 套 daemon+Chrome)——状态文件没了,
//     目录扫描看不见;sock 已 unlink,任何客户端也无法再连 = 100% 孤儿。按 <名>.<pid>
//     粒度标记(MARK_DIR/blind/),保护名单与 profiles/main 红线同主路径。
//
// 动作:TERM→等 2s→KILL daemon;Chrome 子进程按「pid + user-data-dir 双重核对」
// (防 pid 回绕复用误杀;daemon 死后子进程过继 launchd,pgrep -P 将失效,故必须先记录)
// TERM→KILL;最后删状态文件与临时 profile 目录。
//
// 用法:
//   node ab-reap-orphans.mjs --dry-run        # 只评估不动手
//   node ab-reap-orphans.mjs --min-age 0      # 手动立即收割当前孤儿
// 环境:AB_ORPHAN_MIN_AGE(秒)、AB_ORPHAN_FRESH_SECS(默认 600;daemon 启动未满龄一律跳过,
//       防 --min-age 0 误杀活跃任务刚拉的会话)、AB_REAP_PROTECT_SESSIONS(逗号分隔)、
//       AB_ORPHAN_DEBUG=1、AB_TMP_TTL_DAYS(默认 7;tmp/ 内过期截图/HAR 等产物的清理时限)。
// 附带职责:~/.agent-browser/tmp/ 是工具默认输出目录,截图/HAR 等产物按 TTL 自动清理,
// 防公共状态目录被当 scratch 无限膨胀(2026-10-27 实测 88MB/126 图)。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.HOME || os.homedir();
const AB_HOME = path.join(HOME, ".agent-browser");
const MARK_DIR = path.join(AB_HOME, ".orphan-mark");
const BLIND_DIR = path.join(MARK_DIR, "blind");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("-v") || process.env.AB_ORPHAN_DEBUG === "1";
let minAge = Number(process.env.AB_ORPHAN_MIN_AGE || 600);
const mi = argv.indexOf("--min-age");
if (mi >= 0 && argv[mi + 1] != null) minAge = Number(argv[mi + 1]) || 0;
// 新鲜度护栏(2026-10-28 事故教训):--min-age 0 会绕过两段式把无标记候选立即收割,
// 实测误杀了活跃任务 6 分钟前刚拉的会话(r14-after*)。daemon 启动未满 freshSecs 的
// 候选一律跳过 —— 刚引导的会话大概率是活任务在两条命令之间的空档。
let freshSecs = Number(process.env.AB_ORPHAN_FRESH_SECS || 600);
const fi = argv.indexOf("--fresh-secs");
if (fi >= 0 && argv[fi + 1] != null) freshSecs = Number(argv[fi + 1]) || 0;
const dbg = (...a) => { if (verbose) console.log("[dbg]", ...a); };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const sh = (cmd, a) => { try { return spawnSync(cmd, a, { encoding: "utf8" }); } catch { return null; } };
const out = (cmd, a) => { const r = sh(cmd, a); return r && r.status === 0 ? String(r.stdout || "") : ""; };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const cmdline = (pid) => out("ps", ["-o", "command=", "-p", String(pid)]).trim();
// daemon 存活秒数(etime 解析失败返回 Infinity = 按不新鲜处理,宁可漏杀不可误杀)
const ageSecs = (pid) => {
  const et = out("ps", ["-o", "etime=", "-p", String(pid)]).trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(et);
  if (!m) return Infinity;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
};
const tooFresh = (pid) => freshSecs > 0 && ageSecs(pid) < freshSecs;
const rmMarker = (name) => { try { fs.unlinkSync(path.join(MARK_DIR, name)); } catch {} };

// daemon 直接子进程里的浏览器主进程判定(pid + user-data-dir):带临时 profile 的记入 chromes,
// 带 profiles/main 的置 mainProfile(绝不碰的红线)。主路径与盲区扫描共用。
const chromeKidsOf = (dpid) => {
  const chromes = [];
  let mainProfile = false;
  for (const k of out("pgrep", ["-P", String(dpid)]).split("\n").map((s) => s.trim()).filter(Boolean)) {
    const m = /--user-data-dir=(\S+)/.exec(cmdline(k));
    if (!m) continue;
    if (/(^|\/)profiles\/main($|\/)/.test(m[1])) { mainProfile = true; break; }
    if (m[1].includes("agent-browser-chrome-")) chromes.push({ pid: k, udd: m[1] });
  }
  return { chromes, mainProfile };
};

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
fs.mkdirSync(BLIND_DIR, { recursive: true });
const now = Date.now();
const killed = [], markedList = [], dryList = [], dryMarkList = [];
const blindReaped = [], blindMarked = [], blindDry = [];

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
  const { chromes, mainProfile } = chromeKidsOf(dpid);
  if (mainProfile) { dbg("持 main profile 的 Chrome,绝不碰:", name); continue; }
  if (tooFresh(dpid)) { dbg("daemon 未满新鲜度(" + ageSecs(dpid) + "s < " + freshSecs + "s),跳过:", name); continue; }
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
  if (dryRun) {
    // dry-run 忠实模拟两段式:无标记候选真实运行只会「标记」,满龄后才可能进「收割」名单
    if (!first && minAge > 0) dryMarkList.push(label);
    else dryList.push(label);
    continue;
  }
  killTree(name, dpid, chromes);
  killed.push(label);
}

// ---- 盲区扫描(2026-10-28):daemon 活着但其 sock 已从磁盘消失 ----
// 形态:同名会话跨代重建时,状态文件与 sock 被清(如 wrapper purge 依 .pid 判死的跨代误删),
// 上面的目录扫描看不见;sock 已 unlink,任何客户端也无法再连 = 100% 孤儿。
// 判据:进程 cmdline 含 agent-browser + 其 lsof 打开的 AB_HOME 下 *.sock 路径 fs.existsSync 为假。
// 按 <名>.<pid> 粒度两段式标记(MARK_DIR/blind/),同名多代互不干扰;保护名单与
// profiles/main 红线同主路径。收割复检:daemon 仍活且仍持有同一失联 sock 才动手。
try {
  const daemonPids = out("pgrep", ["-f", "agent-browser"]).split("\n").map((s) => s.trim()).filter(Boolean);
  for (const pid of daemonPids) {
    if (!/agent-browser/.test(cmdline(pid))) continue; // pid 回绕复用防误杀
    const socks = [...new Set(out("lsof", ["-p", pid]).match(new RegExp(AB_HOME.replace(/[/\\]/g, "\\$&") + "/[^ \\t\\n]*\\.sock", "g")) || [])];
    for (const sp of socks) {
      if (fs.existsSync(sp)) continue; // 磁盘上还在 = 可达,归主循环管
      const name = path.basename(sp).slice(0, -5);
      if (protectedName(name)) { dbg("盲区:保护名单,跳过:", name, pid); continue; }
      const { chromes, mainProfile } = chromeKidsOf(pid);
      if (mainProfile) { dbg("盲区:持 main profile,绝不碰:", name, pid); continue; }
      if (tooFresh(pid)) { dbg("盲区:daemon 未满新鲜度(" + ageSecs(pid) + "s),跳过:", name, pid); continue; }
      const label = name + "#" + pid + (chromes.length ? " (+" + chromes.length + " chrome)" : " (无chrome)");
      const markPath = path.join(BLIND_DIR, name + "." + pid);
      let first = 0;
      try { first = Number(fs.readFileSync(markPath, "utf8")) || 0; } catch {}
      if (first && now - first < minAge * 1000) { dbg("盲区:标记未满龄:", label); continue; }
      if (!first && minAge > 0 && !dryRun) {
        fs.writeFileSync(markPath, String(now));
        blindMarked.push(label);
        continue;
      }
      if (dryRun) {
        if (!first && minAge > 0) blindMarked.push(label);
        else blindDry.push(label);
        continue;
      }
      if (!alive(pid) || !out("lsof", ["-p", pid]).includes(sp)) { try { fs.unlinkSync(markPath); } catch {} continue; }
      killTree(name, pid, chromes);
      try { fs.unlinkSync(markPath); } catch {}
      blindReaped.push(label);
    }
  }
} catch (e) { dbg("盲区扫描异常(跳过):", String(e)); }

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
// 盲区标记:daemon 已死或不再持失联 sock 的一并清掉
try {
  for (const m of fs.readdirSync(BLIND_DIR)) {
    const pid = Number(m.split(".").pop());
    const ok = Number.isInteger(pid) && alive(pid) && /agent-browser/.test(cmdline(pid));
    if (!ok) { try { fs.unlinkSync(path.join(BLIND_DIR, m)); } catch {} }
  }
} catch {}

if (killed.length) console.log("已收割孤儿会话: " + killed.join(", "));
if (blindReaped.length) console.log("已收割盲区失联实例(sock 已被删,不可达): " + blindReaped.join(", "));
if (markedList.length) console.log("首次发现已标记(满 " + minAge + "s 且仍无客户端则收割): " + markedList.join(", "));
if (blindMarked.length) console.log("盲区首次发现已标记(满 " + minAge + "s 且仍失联则收割): " + blindMarked.join(", "));
if (dryList.length) console.log("[dry-run] 将收割: " + dryList.join(", "));
if (dryMarkList.length) console.log("[dry-run] 将标记(满 " + minAge + "s 且仍无客户端则收割): " + dryMarkList.join(", "));
if (blindDry.length) console.log("[dry-run] 盲区将收割: " + blindDry.join(", "));
if (!killed.length && !markedList.length && !dryList.length && !blindReaped.length && !blindMarked.length && !dryMarkList.length && !blindDry.length) console.log("无孤儿。");

