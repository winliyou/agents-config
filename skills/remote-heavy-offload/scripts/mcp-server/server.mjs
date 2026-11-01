#!/usr/bin/env node
// remote-subagent MCP server：把 192.168.2.3 上的 dsh 当成"远程子代理"暴露给本地 dsh。
// 传输：stdio；每个工具内部通过 ssh -n 调用远端 dsh headless / shell。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const SSH_HOST = process.env.REMOTE_SSH_HOST || "dsh-arch";
const REMOTE_WS = process.env.REMOTE_WORKSPACE || "/home/liyou/workspace";
const REMOTE_DSH = process.env.REMOTE_DSH || "/home/liyou/.local/bin/dsh";
const JOB_ROOT = process.env.REMOTE_JOB_ROOT || "/home/liyou/.dsh-offload/jobs";
const OFFLOAD = process.env.OFFLOAD_CLI || ((process.env.HOME || "/Users/liyou") + "/.local/bin/offload");
const NL = String.fromCharCode(10);
const SQ = String.fromCharCode(39);
const BSL = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const FLEET_ALLOWLIST = process.env.FLEET_ALLOWLIST || ((process.env.HOME || "/Users/liyou") + "/.dsh/fleet-hosts.json");

let allowCache = null;
function loadFleet() {
  try { return JSON.parse(readFileSync(FLEET_ALLOWLIST, "utf8")); } catch (e) { return null; }
}
function hostEntry() {
  const al = loadFleet();
  if (!al || !al.hosts) return null;
  for (const k of Object.keys(al.hosts)) {
    const h = al.hosts[k];
    if (h && h.ssh === SSH_HOST) return h;
  }
  return null;
}
function hostLimits() {
  const h = hostEntry();
  const l = (h && h.limits) || {};
  return { maxHeavyJobs: typeof l.maxHeavyJobs === "number" ? l.maxHeavyJobs : 1, maxJobs: typeof l.maxJobs === "number" ? l.maxJobs : 3 };
}
function ensureAllowed() {
  if (allowCache !== null) { if (allowCache !== true) throw new Error(String(allowCache)); return; }
  const al = loadFleet();
  if (al === null) { allowCache = true; return; }
  const h = hostEntry();
  if (h && h.authorized === true) { allowCache = true; return; }
  allowCache = "主机 " + SSH_HOST + " 不在资源池允许清单（" + FLEET_ALLOWLIST + "）中，或未授权；默认拒绝调度";
  throw new Error(String(allowCache));
}
async function activeJobs() {
  const script = [
    "ROOT=" + shq(JOB_ROOT),
    "for d in " + DQ + "$ROOT" + DQ + "/job-*; do",
    "  [ -d " + DQ + "$d" + DQ + " ] || continue",
    "  T=$(cat " + DQ + "$d/turn" + DQ + " 2>/dev/null || echo 1)",
    "  P=$(cat " + DQ + "$d/pid-$T" + DQ + " 2>/dev/null || true)",
    "  if [ -n " + DQ + "$P" + DQ + " ] && kill -0 " + DQ + "$P" + DQ + " 2>/dev/null; then basename " + DQ + "$d" + DQ + "; fi",
    "done",
    ""
  ].join(NL);
  const r = await sshScript(script, 60000);
  return String(r.stdout || "").split(NL).map((x) => x.trim()).filter((x) => x !== "");
}

function shq(v) {
  const s = String(v);
  let out = SQ;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === SQ) out = out + SQ + BSL + SQ + SQ;
    else out = out + c;
  }
  return out + SQ;
}
function b64(s) { return Buffer.from(String(s), "utf8").toString("base64"); }
function cap(s, n) {
  const t = String(s === undefined || s === null ? "" : s);
  return t.length <= n ? t : t.slice(0, n) + NL + "...[truncated " + (t.length - n) + " chars]";
}
function ok(text) { return { content: [{ type: "text", text: String(text) }] }; }
function fail(text) { return { content: [{ type: "text", text: "ERROR: " + String(text) }], isError: true }; }

async function runLocal(cmd, args, timeoutMs) {
  ensureAllowed();
  try {
    const r = await execFileAsync(cmd, args, { timeout: timeoutMs || 120000, maxBuffer: 128 * 1024 * 1024, env: process.env });
    return { code: 0, stdout: r.stdout || "", stderr: r.stderr || "" };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout || "", stderr: e.stderr || String(e.message || e), timedOut: !!e.killed };
  }
}
async function sshRaw(script, timeoutMs) {
  return runLocal("ssh", ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", SSH_HOST, script], timeoutMs || 180000);
}
async function sshScript(script, timeoutMs) {
  return sshRaw("printf %s " + shq(b64(script)) + " | base64 -d | bash -s", timeoutMs);
}

const projectOk = (p) => {
  if (p === undefined || p === null || p === "") return true;
  const s = String(p);
  if (s.indexOf("..") >= 0) return false;
  const allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/";
  for (let i = 0; i < s.length; i++) if (allowed.indexOf(s.charAt(i)) < 0) return false;
  return true;
};
function wrkdir(project) {
  if (project === undefined || project === null || project === "" || project === ".") return REMOTE_WS;
  if (!projectOk(project)) throw new Error("非法 project 路径: " + String(project));
  return REMOTE_WS + "/" + String(project);
}
function canonJob(v) {
  const t = String(v === undefined || v === null ? "" : v).trim();
  if (t === "") return t;
  return t.startsWith("job-") ? t : "job-" + t;
}
function jobName(name) {
  if (name === undefined || name === null || name === "") {
    const r = Math.random().toString(16).slice(2, 6);
    return "job-" + Date.now() + "-" + r;
  }
  const s = String(name);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) throw new Error("非法 job 名称（仅字母数字 . _ -，<=64）");
  return s.startsWith("job-") ? s : "job-" + s;
}

let helperReady = false;
async function ensureRemote() {
  if (helperReady) return;
  const helper = readFileSync(join(HERE, "run-turn.sh"), "utf8");
  const script = [
    "set -euo pipefail",
    "mkdir -p " + shq(JOB_ROOT),
    "printf %s " + shq(b64(helper)) + " | base64 -d > " + shq(JOB_ROOT + "/run-turn.sh"),
    "chmod +x " + shq(JOB_ROOT + "/run-turn.sh"),
    "echo READY"
  ].join(NL);
  const r = await sshScript(script, 60000);
  if (r.code !== 0 || r.stdout.indexOf("READY") < 0) throw new Error("远端初始化失败: " + cap(r.stderr || r.stdout, 2500));
  helperReady = true;
}

function parseEvents(logText) {
  const out = { sessionId: null, finalText: null, lastText: null, errorLines: [], textSegments: [] };
  const lines = String(logText || "").split(NL);
  for (const line of lines) {
    const t = line.trim();
    if (t.charAt(0) !== "{") continue;
    let ev;
    try { ev = JSON.parse(t); } catch (e) { continue; }
    if (ev.type === "session" && ev.sessionId) out.sessionId = ev.sessionId;
    if (ev.type === "text" && typeof ev.text === "string") { out.lastText = ev.text; out.textSegments.push(ev.text); }
    if (ev.type === "final" && typeof ev.text === "string") out.finalText = ev.text;
  }
  return out;
}
function nonJsonTail(logText) {
  const lines = String(logText || "").split(NL);
  const keep = [];
  for (const l of lines) { const t = l.trim(); if (t !== "" && t.charAt(0) !== "{") keep.push(t); }
  return cap(keep.slice(-15).join(NL), 2000);
}

async function readStatus(job) {
  const jobDir = JOB_ROOT + "/" + job;
  const script = [
    "JOB=" + shq(jobDir),
    "if [ ! -d " + DQ + "$JOB" + DQ + " ]; then echo " + shq("META:missing=1") + "; exit 0; fi",
    "T=$(cat " + DQ + "$JOB/turn" + DQ + " 2>/dev/null || echo 1)",
    "echo " + shq("META:turn=") + DQ + "$T" + DQ,
    "echo " + shq("META:exit=") + DQ + "$(cat " + DQ + "$JOB/exit-$T" + DQ + " 2>/dev/null || true)" + DQ,
    "P=$(cat " + DQ + "$JOB/pid-$T" + DQ + " 2>/dev/null || true)",
    "if [ -n " + DQ + "$P" + DQ + " ] && kill -0 " + DQ + "$P" + DQ + " 2>/dev/null; then echo " + shq("META:alive=1") + "; else echo " + shq("META:alive=0") + "; fi",
    "echo " + shq("META:session=") + DQ + "$(cat " + DQ + "$JOB/session" + DQ + " 2>/dev/null || true)" + DQ,
    "echo " + shq("META:logsize=") + DQ + "$(wc -c < " + DQ + "$JOB/run-$T.log" + DQ + " 2>/dev/null || echo 0)" + DQ,
    "echo -n " + shq("LOG_B64:") + "; tail -c 262144 " + DQ + "$JOB/run-$T.log" + DQ + " 2>/dev/null | base64 | tr -d " + shq(NL),
    ""
  ].join(NL);
  const r = await sshScript(script, 60000);
  if (r.code !== 0) throw new Error("读取任务状态失败: " + cap(r.stderr || r.stdout, 2000));
  const meta = {};
  let logB64 = "";
  for (const line of r.stdout.split(NL)) {
    if (line.indexOf("META:") === 0) {
      const kv = line.slice(5);
      const eq = kv.indexOf("=");
      if (eq > 0) meta[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (line.indexOf("LOG_B64:") === 0) {
      logB64 = line.slice(8);
    }
  }
  if (String(meta.missing) === "1") return { job: job, state: "missing", note: "任务不存在" };
  const logText = logB64 ? Buffer.from(logB64, "base64").toString("utf8") : "";
  const ev = parseEvents(logText);
  const exitRaw = meta.exit === undefined ? "" : meta.exit;
  let exitCode = null;
  if (exitRaw !== "") exitCode = parseInt(exitRaw, 10);
  let state = "running";
  if (exitCode !== null) state = exitCode === 0 && ev.finalText !== null ? "done" : "failed";
  const status = {
    job: job,
    turn: parseInt(meta.turn || "1", 10),
    state: state,
    exitCode: exitCode,
    alive: meta.alive === "1",
    sessionId: ev.sessionId || meta.session || null,
    logBytes: parseInt(meta.logsize || "0", 10),
    answer: ev.finalText,
    lastText: ev.lastText,
    errorTail: state === "failed" ? nonJsonTail(logText) : null
  };
  if (status.sessionId && !meta.session) {
    const save = ["JOB=" + shq(jobDir), "printf %s " + shq(b64(status.sessionId)) + " | base64 -d > " + DQ + "$JOB/session" + DQ].join(NL);
    await sshScript(save, 30000);
  }
  return status;
}

const tools = [];
const server = new McpServer({ name: "remote-subagent", version: "0.1.0" });

server.registerTool("remote_status", {
  title: "远端主机状态",
  description: "查看远程 Linux 执行端（192.168.2.3）的健康状态：主机、负载、内存、磁盘、dsh-web 服务、监听端口与工作区。",
  inputSchema: {}
}, async () => {
  const script = [
    "echo " + shq("HOST=") + DQ + "$(hostname)" + DQ,
    "echo " + shq("UNAME=") + DQ + "$(uname -sr)" + DQ,
    "echo " + shq("NPROC=") + DQ + "$(nproc)" + DQ,
    "echo " + shq("UPTIME=") + DQ + "$(uptime)" + DQ,
    "echo " + shq("MEM=") + DQ + "$(free -h | head -1)" + DQ,
    "echo " + shq("DISK=") + DQ + "$(df -h / | tail -1)" + DQ,
    "echo " + shq("SERVICE=") + DQ + "$(systemctl --user is-active dsh-web 2>/dev/null || true)" + DQ,
    "echo " + shq("LISTEN=") + DQ + "$(ss -tln 2>/dev/null | grep -c 8765)" + DQ,
    "echo " + shq("WORKSPACE=") + DQ + "$(find " + shq(REMOTE_WS) + " -maxdepth 1 -mindepth 1 -printf '%f,' 2>/dev/null)" + DQ,
    "echo " + shq("VM=") + DQ + "$(systemd-detect-virt 2>/dev/null || true)" + DQ,
    ""
  ].join(NL);
  const r = await sshScript(script, 60000);
  if (r.code !== 0) return fail("远端状态读取失败: " + cap(r.stderr || r.stdout, 2000));
  return ok(r.stdout);
});

server.registerTool("remote_start_task", {
  title: "启动远程子代理任务（异步）",
  description: "在远程 Linux 上异步启动一个 dsh headless 会话执行任务，立即返回 job 名；用 remote_task_status 轮询结果，用 remote_task_followup 在同一会话里继续追问，用 remote_task_cancel 取消。重负载（构建/测试/长分析）用这个，不要占用本地机器。",
  inputSchema: {
    task: z.string().describe("交给远程子代理的任务描述"),
    project: z.string().optional().describe("远端工作区下的项目子目录，如 dsh-plugins；省略则在 /home/liyou/workspace 根目录执行"),
    name: z.string().optional().describe("可选 job 名（字母数字._-，<=64）；省略自动生成"),
    force: z.boolean().optional().describe("并发保护：默认每台最多 1 个重任务；确认要并行时传 true")
  }
}, async (args) => {
  try {
    await ensureRemote();
    const limits = hostLimits();
    const active = await activeJobs();
    if (!args.force && active.length >= limits.maxHeavyJobs) {
      return fail("并发保护：已有 " + active.length + " 个运行中任务（" + active.join(", ") + "）；本池默认每台最多 " + limits.maxHeavyJobs + " 个重任务。等它完成/取消，或传 force:true 明确并行。");
    }
    const job = jobName(args.name);
    const ws = wrkdir(args.project);
    const jobDir = JOB_ROOT + "/" + job;
    const script = [
      "set -euo pipefail",
      "JOB=" + shq(jobDir),
      "mkdir -p " + DQ + "$JOB" + DQ,
      "printf %s " + shq(b64(ws)) + " | base64 -d > " + DQ + "$JOB/workdir" + DQ,
      "BASELINE=$(cd " + shq(ws) + " && { git stash create 2>/dev/null || true; })",
      "if [ -z " + DQ + "$BASELINE" + DQ + " ]; then BASELINE=$(cd " + shq(ws) + " && { git rev-parse HEAD 2>/dev/null || true; }); fi",
      "printf %s " + DQ + "$BASELINE" + DQ + " > " + DQ + "$JOB/base" + DQ,
      "printf %s " + shq(b64(args.task)) + " | base64 -d > " + DQ + "$JOB/task-1.txt" + DQ,
      "rm -f " + DQ + "$JOB/session" + DQ,
      "bash " + shq(JOB_ROOT + "/run-turn.sh") + " " + DQ + "$JOB" + DQ + " " + shq(ws) + " " + shq(REMOTE_DSH) + " - 1 >/dev/null",
      "sleep 0.3",
      "echo STARTED",
      ""
    ].join(NL);
    const r = await sshScript(script, 60000);
    if (r.code !== 0 || r.stdout.indexOf("STARTED") < 0) return fail("启动失败: " + cap(r.stderr || r.stdout, 3000));
    return ok(JSON.stringify({ job: job, project: args.project || ".", workdir: ws, state: "running", next: "remote_task_status({job: \"" + job + "\"})" }, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_task_status", {
  title: "查询远程子代理任务状态",
  description: "查询远程任务状态：state=running/done/failed/missing；done 时 answer 是最终回答；running 时 lastText 是最近输出；failed 时 errorTail 是错误尾部。",
  inputSchema: { job: z.string().describe("remote_start_task 返回的 job 名") }
}, async (args) => {
  try {
    const st = await readStatus(canonJob(args.job));
    return ok(JSON.stringify(st, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_task_followup", {
  title: "在同一远程会话继续追问",
  description: "任务完成后，在同一个远程 dsh 会话里继续一轮（上下文保留）。可选 wait_sec 阻塞等待结果；不提供则立即返回 running。任务仍在运行时会被拒绝，先轮询或用 cancel。",
  inputSchema: {
    job: z.string().describe("job 名"),
    task: z.string().describe("追加给远程子代理的消息"),
    wait_sec: z.number().optional().describe("等待完成的秒数（0/省略=不等待，立即返回）"),
    force: z.boolean().optional().describe("并发保护：确认要顶掉其他任务并行时传 true")
  }
}, async (args) => {
  try {
    await ensureRemote();
    const job = canonJob(args.job);
    const st = await readStatus(job);
    if (st.state === "missing") return fail("任务不存在: " + job);
    if (st.state === "running") return fail("任务仍在运行，先 remote_task_status 轮询，或 remote_task_cancel");
    if (!st.sessionId) return fail("未找到会话 id，无法续接（可重新 start）");
    const limits = hostLimits();
    const others = (await activeJobs()).filter((x) => x !== job);
    if (!args.force && others.length >= limits.maxHeavyJobs) {
      return fail("并发保护：已有其他运行中任务（" + others.join(", ") + "）；等待/取消，或传 force:true。");
    }
    const nextTurn = (st.turn || 1) + 1;
    const jobDir = JOB_ROOT + "/" + job;
    const wsResult = await sshScript(["JOB=" + shq(jobDir), "cat " + DQ + "$JOB/workdir" + DQ + " 2>/dev/null || true", ""].join(NL), 30000);
    const ws = String(wsResult.stdout || "").trim() || REMOTE_WS;
    const script = [
      "set -euo pipefail",
      "JOB=" + shq(jobDir),
      "printf %s " + shq(b64(args.task)) + " | base64 -d > " + DQ + "$JOB/task-" + nextTurn + ".txt" + DQ,
      "bash " + shq(JOB_ROOT + "/run-turn.sh") + " " + DQ + "$JOB" + DQ + " " + shq(ws) + " " + shq(REMOTE_DSH) + " " + shq(st.sessionId) + " " + nextTurn + " >/dev/null",
      "sleep 0.3",
      "echo STARTED",
      ""
    ].join(NL);
    const r = await sshScript(script, 60000);
    if (r.code !== 0 || r.stdout.indexOf("STARTED") < 0) return fail("续接失败: " + cap(r.stderr || r.stdout, 3000));
    const waitSec = Number(args.wait_sec || 0);
    if (!(waitSec > 0)) return ok(JSON.stringify({ job: job, turn: nextTurn, state: "running" }, null, 2));
    const deadline = Date.now() + waitSec * 1000;
    let last = { job: job, turn: nextTurn, state: "running" };
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      last = await readStatus(job);
      if (last.state !== "running") break;
    }
    return ok(JSON.stringify(last, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_task_cancel", {
  title: "取消远程子代理任务",
  description: "终止远程任务当前轮的进程组（kill -TERM），任务目录与会话保留。",
  inputSchema: { job: z.string().describe("job 名") }
}, async (args) => {
  try {
    const jobDir = JOB_ROOT + "/" + canonJob(args.job);
    const script = [
      "JOB=" + shq(jobDir),
      "T=$(cat " + DQ + "$JOB/turn" + DQ + " 2>/dev/null || echo 1)",
      "P=$(cat " + DQ + "$JOB/pid-$T" + DQ + " 2>/dev/null || true)",
      "if [ -n " + DQ + "$P" + DQ + " ] && kill -0 " + DQ + "$P" + DQ + " 2>/dev/null; then kill -TERM " + DQ + "-$P" + DQ + " 2>/dev/null || kill -TERM " + DQ + "$P" + DQ + "; echo CANCELLED; else echo NOT_RUNNING; fi",
      ""
    ].join(NL);
    const r = await sshScript(script, 30000);
    return ok(String(r.stdout || "").trim() || "unknown");
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_run", {
  title: "在远端执行 shell 命令（同步）",
  description: "在远程 Linux 上同步执行一条 shell 命令（默认在工作区根目录），返回 exitCode/stdout/stderr。适合构建、测试、查看状态；长任务用 remote_start_task。",
  inputSchema: {
    command: z.string().describe("要在远端执行的 shell 命令"),
    project: z.string().optional().describe("工作区子目录，如 dsh-plugins"),
    timeout_sec: z.number().optional().describe("超时秒数，默认 300")
  }
}, async (args) => {
  try {
    const ws = wrkdir(args.project);
    const timeout = Math.max(1, Math.min(3600, Number(args.timeout_sec || 300)));
    const script = [
      "cd " + shq(ws) + " || { echo " + shq("BAD_WORKDIR") + " >&2; exit 2; }",
      "exec timeout " + timeout + " bash -c " + shq(args.command),
      ""
    ].join(NL);
    const r = await sshScript(script, (timeout + 30) * 1000);
    return ok(JSON.stringify({ exitCode: r.code, timedOut: !!r.timedOut, stdout: cap(r.stdout, 20000), stderr: cap(r.stderr, 8000) }, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_sync", {
  title: "同步本地目录到远端工作区",
  description: "把本地目录推到远端 /home/liyou/workspace（走 offload sync 的 tar 管道，自动排除 node_modules/.workwork/.worktrees/build 等）。返回远端路径与体积。",
  inputSchema: {
    local_path: z.string().describe("本地目录绝对路径或 ~ 路径"),
    remote_name: z.string().optional().describe("远端子目录名，默认取本地目录名"),
    clean: z.boolean().optional().describe("先删除远端目标目录（危险，默认 false）")
  }
}, async (args) => {
  try {
    const argv = ["sync", String(args.local_path)];
    if (args.remote_name) argv.push(String(args.remote_name));
    if (args.clean) argv.push("--clean");
    const r = await runLocal(OFFLOAD, argv, 600000);
    return ok(JSON.stringify({ exitCode: r.code, stdout: cap(r.stdout, 8000), stderr: cap(r.stderr, 4000) }, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_pull", {
  title: "从远端工作区取回目录",
  description: "把远端 /home/liyou/workspace/<remote_name> 拉回本地目录（含 .git，可把远端 agent 的提交带回来）。",
  inputSchema: {
    remote_name: z.string().describe("远端工作区下的子目录名"),
    local_path: z.string().describe("本地目标目录"),
    clean: z.boolean().optional().describe("先清空本地目标目录（危险，默认 false）")
  }
}, async (args) => {
  try {
    const argv = ["pull", String(args.remote_name), String(args.local_path)];
    if (args.clean) argv.push("--clean");
    const r = await runLocal(OFFLOAD, argv, 600000);
    return ok(JSON.stringify({ exitCode: r.code, stdout: cap(r.stdout, 8000), stderr: cap(r.stderr, 4000) }, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_diff", {
  title: "取回远程子代理产生的改动（patch）",
  description: "对比任务启动时的基线，返回远端子代理在项目里产生的改动：git diff 补丁（base64 解码后可 git apply）+ 改动文件列表。用于本地 lead 审核/合并，避免直接覆盖本地工作树。",
  inputSchema: {
    job: z.string().describe("job 名"),
    include_patch: z.boolean().optional().describe("是否返回完整补丁（默认 true，最多 400KB）")
  }
}, async (args) => {
  try {
    const jobDir = JOB_ROOT + "/" + canonJob(args.job);
    const script = [
      "JOB=" + shq(jobDir),
      "[ -d " + DQ + "$JOB" + DQ + " ] || { echo " + shq("META:missing=1") + "; exit 0; }",
      "WS=$(cat " + DQ + "$JOB/workdir" + DQ + " 2>/dev/null || true)",
      "BASE=$(cat " + DQ + "$JOB/base" + DQ + " 2>/dev/null || true)",
      "echo " + shq("META:workdir=") + DQ + "$WS" + DQ,
      "echo " + shq("META:base=") + DQ + "$BASE" + DQ,
      "echo -n " + shq("STATUS_B64:") + "; { cd " + DQ + "$WS" + DQ + " && git status --porcelain 2>/dev/null || true; } | head -c 20000 | base64 | tr -d " + shq(NL) + "; echo",
      "if [ -n " + DQ + "$BASE" + DQ + " ] && [ " + DQ + "$BASE" + DQ + " != " + shq("none") + " ]; then echo -n " + shq("STAT_B64:") + "; { cd " + DQ + "$WS" + DQ + " && git diff --stat " + DQ + "$BASE" + DQ + " 2>/dev/null | tail -1 || true; } | base64 | tr -d " + shq(NL) + "; echo; fi",
      "if [ -n " + DQ + "$BASE" + DQ + " ] && [ " + DQ + "$BASE" + DQ + " != " + shq("none") + " ]; then echo -n " + shq("PATCH_B64:") + "; { cd " + DQ + "$WS" + DQ + " && git diff " + DQ + "$BASE" + DQ + " 2>/dev/null || true; } | head -c 409600 | base64 | tr -d " + shq(NL) + "; echo; fi",
      ""
    ].join(NL);
    const r = await sshScript(script, 60000);
    if (r.code !== 0) return fail("读取改动失败: " + cap(r.stderr || r.stdout, 2000));
    const meta = {};
    let statusB64 = ""; let statB64 = ""; let patchB64 = "";
    for (const line of r.stdout.split(NL)) {
      if (line.indexOf("META:") === 0) {
        const kv = line.slice(5); const eq = kv.indexOf("=");
        if (eq > 0) meta[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else if (line.indexOf("STATUS_B64:") === 0) statusB64 = line.slice(11);
      else if (line.indexOf("STAT_B64:") === 0) statB64 = line.slice(9);
      else if (line.indexOf("PATCH_B64:") === 0) patchB64 = line.slice(10);
    }
    if (String(meta.missing) === "1") return fail("任务不存在");
    const dec = (x) => { try { return x ? Buffer.from(x, "base64").toString("utf8") : ""; } catch (e) { return ""; } };
    const patch = args.include_patch === false ? null : dec(patchB64);
    return ok(JSON.stringify({
      job: canonJob(args.job),
      workdir: meta.workdir || null,
      base: meta.base || null,
      status: dec(statusB64),
      stat: dec(statB64),
      patchBytes: patchB64 ? Math.floor(patchB64.length * 3 / 4) : 0,
      patch: patch,
      note: "patch 为 git diff 文本；本地审核后可用 git apply 应用（先 git status 确认工作树）"
    }, null, 2));
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

server.registerTool("remote_jobs", {
  title: "列出远程子代理任务",
  description: "列出远端所有任务目录及其状态（turn/exit/alive）。",
  inputSchema: {}
}, async () => {
  try {
    const script = [
      "set -uo pipefail",
      "ROOT=" + shq(JOB_ROOT),
      "if [ ! -d " + DQ + "$ROOT" + DQ + " ]; then echo NO_JOBS; exit 0; fi",
      "for d in " + DQ + "$ROOT" + DQ + "/job-*; do",
      "  [ -d " + DQ + "$d" + DQ + " ] || continue",
      "  T=$(cat " + DQ + "$d/turn" + DQ + " 2>/dev/null || echo 1)",
      "  E=$(cat " + DQ + "$d/exit-$T" + DQ + " 2>/dev/null || echo -)",
      "  P=$(cat " + DQ + "$d/pid-$T" + DQ + " 2>/dev/null || true)",
      "  A=0; if [ -n " + DQ + "$P" + DQ + " ] && kill -0 " + DQ + "$P" + DQ + " 2>/dev/null; then A=1; fi",
      "  echo " + DQ + "$(basename " + DQ + "$d" + DQ + ")|turn=$T|exit=$E|alive=$A" + DQ,
      "done",
      ""
    ].join(NL);
    const r = await sshScript(script, 60000);
    if (r.code !== 0) return fail("列出任务失败: " + cap(r.stderr || r.stdout, 2000));
    return ok(String(r.stdout || "").trim() || "NO_JOBS");
  } catch (e) { return fail(String(e && e.message ? e.message : e)); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
