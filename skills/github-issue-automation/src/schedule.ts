/**
 * 运行时间窗：只允许在配置的时段内触发巡检。
 *
 * 语义：`schedule.windows` 是若干 "HH:MM-HH:MM" 区间，本地时区；
 * 结束时间小于等于开始时间表示跨午夜（如 "18:00-09:00"）。
 * 空数组表示不限制（保持旧行为）。
 *
 * 判定放在 scan.ts 取锁之前：窗口外直接 return，不消耗 GitHub API 配额。
 */
import type { Config } from "./types.ts";

const MINUTES_PER_DAY = 24 * 60;

/** "HH:MM" → 当天分钟数；格式非法返回 undefined。 */
function parseClock(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

interface Window {
  start: number;
  end: number;
}

/** 解析 "HH:MM-HH:MM"；格式非法返回 undefined。 */
function parseWindow(spec: string): Window | undefined {
  const parts = spec.split("-");
  if (parts.length !== 2) return undefined;
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

/** 某分钟是否落在单个窗口内（支持跨午夜）。 */
function inWindow(minute: number, window: Window): boolean {
  const { start, end } = window;
  if (start === end) return true; // 整天
  if (start < end) return minute >= start && minute < end;
  // 跨午夜：如 18:00-09:00
  return minute >= start || minute < end;
}

/** 当前本地时间是否在任一窗口内。窗口列表为空时恒为 true。 */
export function withinSchedule(now: Date, windows: string[]): boolean {
  if (!windows.length) return true;
  const minute = now.getHours() * 60 + now.getMinutes();
  for (const spec of windows) {
    const window = parseWindow(spec);
    if (window && inWindow(minute, window)) return true;
  }
  return false;
}

/** 校验配置里的窗口写法；返回非法项（供安装脚本/启动时报警）。 */
export function invalidWindows(windows: string[]): string[] {
  return windows.filter((spec) => parseWindow(spec) === undefined);
}

/** 人类可读的窗口描述，用于日志。 */
export function describeSchedule(windows: string[]): string {
  return windows.length ? windows.join(", ") : "不限时段";
}

/** 当前时刻是否允许巡检；附带日志所需的原因。 */
export function scheduleGate(now: Date, cfg: Config): { allowed: boolean; reason: string } {
  const windows = cfg.schedule.windows;
  const bad = invalidWindows(windows);
  if (bad.length) {
    // 配置写错时放行，避免因为笔误让自动化彻底停摆；非法项会在日志里可见。
    return { allowed: true, reason: "时间窗配置非法（" + bad.join(", ") + "），已按不限时段处理" };
  }
  if (withinSchedule(now, windows)) {
    return { allowed: true, reason: "在允许时段内（" + describeSchedule(windows) + "）" };
  }
  return { allowed: false, reason: "不在允许时段内（当前 " + now.toTimeString().slice(0, 5) + "，允许 " + describeSchedule(windows) + "）" };
}
/** 允许时段内的一个触发点（分钟粒度）。 */
export interface CalendarEntry {
  Hour: number;
  Minute: number;
}

/**
 * 把允许时段切成 launchd 的 StartCalendarInterval 条目。
 *
 * 这样 launchd 本身只在允许时段内唤醒进程，窗口外不会启动、不会取锁、
 * 也不会消耗 GitHub API 配额（扫描侧的时间窗是第二道防线）。
 */
export function calendarEntries(windows: string[], intervalMinutes: number): CalendarEntry[] {
  const step = Math.max(1, Math.floor(intervalMinutes));
  const entries: CalendarEntry[] = [];
  const seen = new Set<string>();
  for (const spec of windows) {
    const window = parseWindow(spec);
    if (!window) continue;
    const { start, end } = window;
    const limit = end > start ? end : end + MINUTES_PER_DAY;
    for (let minute = start; minute < limit; minute += step) {
      const normalized = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      const key = Math.floor(normalized / 60) + ":" + (normalized % 60);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ Hour: Math.floor(normalized / 60), Minute: normalized % 60 });
    }
  }
  // launchd 按触发时间升序更易读，也便于与日志对照。
  entries.sort((a, b) => a.Hour * 60 + a.Minute - (b.Hour * 60 + b.Minute));
  return entries;
}
