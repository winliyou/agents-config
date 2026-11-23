import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { calendarEntries, invalidWindows } from "../src/schedule.ts";

const LABEL = "com.chaoset.github-issue-agent";
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uid = process.getuid?.() ?? 501;
const domain = "gui/" + uid;
const plistPath = join(homedir(), "Library", "LaunchAgents", LABEL + ".plist");
const args = new Set(process.argv.slice(2));

function which(command: string): string {
  try {
    return execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function runAllowFailure(command: string, argv: string[]): void {
  try {
    execFileSync(command, argv, { stdio: "inherit" });
  } catch {
    // 服务未安装或未运行时 bootout 会失败，属于预期。
  }
}

/**
 * 调度段：配置了允许时段时用 StartCalendarInterval（launchd 只在时段内唤醒），
 * 否则退回 StartInterval 固定间隔。
 *
 * 注意 StartInterval 与 StartCalendarInterval 被 launchd 独立评估，
 * 同时存在等于两套调度叠加，所以这里二选一。
 */
function scheduleBlock(windows: string[], intervalMinutes: number): string[] {
  if (!windows.length) {
    return ["  <key>StartInterval</key>", "  <integer>" + Math.max(60, intervalMinutes * 60) + "</integer>"];
  }
  const entries = calendarEntries(windows, intervalMinutes);
  const lines = ["  <key>StartCalendarInterval</key>", "  <array>"];
  for (const entry of entries) {
    lines.push("    <dict>");
    lines.push("      <key>Hour</key>");
    lines.push("      <integer>" + entry.Hour + "</integer>");
    lines.push("      <key>Minute</key>");
    lines.push("      <integer>" + entry.Minute + "</integer>");
    lines.push("    </dict>");
  }
  lines.push("  </array>");
  return lines;
}

function plist(bunPath: string, nodePath: string, scanPath: string, cfgPath: string): string {
  const pathValue = [dirname(nodePath), dirname(bunPath), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>" + LABEL + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>" + xmlEscape(bunPath) + "</string>",
    "    <string>" + xmlEscape(scanPath) + "</string>",
    "    <string>--once</string>",
    "  </array>",
    "  <key>WorkingDirectory</key>",
    "  <string>" + xmlEscape(SKILL_ROOT) + "</string>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    "    <string>" + xmlEscape(pathValue) + "</string>",
    "    <key>HOME</key>",
    "    <string>" + xmlEscape(homedir()) + "</string>",
    "    <key>GITHUB_ISSUE_AUTOMATION_CONFIG</key>",
    "    <string>" + xmlEscape(cfgPath) + "</string>",
    "  </dict>",
    ...scheduleBlock(loadConfig().schedule.windows, loadConfig().schedule.intervalMinutes),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>60</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>LowPriorityIO</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    "  <string>" + xmlEscape(join(loadConfig().stateDir, "launchd.out.log")) + "</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>" + xmlEscape(join(loadConfig().stateDir, "launchd.err.log")) + "</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function install(): void {
  const cfg = loadConfig();
  const bad = invalidWindows(cfg.schedule.windows);
  if (bad.length) {
    console.error("时间窗写法非法：" + bad.join(", ") + "（应为 \"HH:MM-HH:MM\"）");
    process.exit(1);
  }
  if (cfg.schedule.windows.length && calendarEntries(cfg.schedule.windows, cfg.schedule.intervalMinutes).length === 0) {
    console.error("时间窗 " + cfg.schedule.windows.join(", ") + " 与间隔 " + cfg.schedule.intervalMinutes + " 分钟组合后没有任何触发点，请调小间隔。");
    process.exit(1);
  }
  mkdirSync(cfg.stateDir, { recursive: true });
  const bunPath = process.execPath;
  const nodePath = which("node") || join(homedir(), ".nvm", "versions", "node", "bin", "node");
  if (!existsSync(nodePath)) {
    console.error("未找到 node：dsh 的 shebang 需要 node 在 PATH 中。请安装 node 或调整脚本。");
    process.exit(1);
  }
  const scanPath = join(SKILL_ROOT, "src", "scan.ts");
  const cfgPath = join(SKILL_ROOT, "config.json");
  const content = plist(bunPath, nodePath, scanPath, cfgPath);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, content);
  execFileSync("plutil", ["-lint", plistPath], { stdio: "inherit" });
  runAllowFailure("launchctl", ["bootout", domain + "/" + LABEL]);
  execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
  chmodSync(plistPath, 0o644);
  console.log("已安装 " + LABEL + " → " + plistPath);
  console.log("日志：" + join(cfg.stateDir, "launchd.out.log"));
  if (args.has("--kickstart")) {
    execFileSync("launchctl", ["kickstart", "-k", domain + "/" + LABEL], { stdio: "inherit" });
    console.log("已触发一次巡检");
  }
}

function uninstall(): void {
  runAllowFailure("launchctl", ["bootout", domain + "/" + LABEL]);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log("已卸载 " + LABEL);
}

if (args.has("--uninstall")) uninstall();
else install();
