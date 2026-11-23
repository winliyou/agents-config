import { describe, expect, test } from "bun:test";
import { calendarEntries, describeSchedule, invalidWindows, scheduleGate, withinSchedule } from "../src/schedule.ts";

/** 构造本地时间，避免用例受时区影响。 */
function at(hour: number, minute: number): Date {
  return new Date(2026, 10, 23, hour, minute, 0, 0);
}

const WINDOWS = ["12:00-14:00", "18:00-09:00"];

describe("withinSchedule", () => {
  test("窗口列表为空时恒为允许", () => {
    expect(withinSchedule(at(3, 0), [])).toBe(true);
    expect(withinSchedule(at(15, 0), [])).toBe(true);
  });

  test("日间窗口含起点、不含终点", () => {
    expect(withinSchedule(at(12, 0), WINDOWS)).toBe(true);
    expect(withinSchedule(at(13, 59), WINDOWS)).toBe(true);
    expect(withinSchedule(at(11, 59), WINDOWS)).toBe(false);
    expect(withinSchedule(at(14, 0), WINDOWS)).toBe(false);
  });

  test("跨午夜窗口 18:00-09:00", () => {
    expect(withinSchedule(at(18, 0), WINDOWS)).toBe(true);
    expect(withinSchedule(at(23, 59), WINDOWS)).toBe(true);
    expect(withinSchedule(at(0, 0), WINDOWS)).toBe(true);
    expect(withinSchedule(at(8, 59), WINDOWS)).toBe(true);
    expect(withinSchedule(at(9, 0), WINDOWS)).toBe(false);
  });

  test("窗口之间的空档不触发", () => {
    expect(withinSchedule(at(9, 30), WINDOWS)).toBe(false);
    expect(withinSchedule(at(15, 0), WINDOWS)).toBe(false);
    expect(withinSchedule(at(17, 59), WINDOWS)).toBe(false);
  });

  test("起止相同的窗口表示全天", () => {
    expect(withinSchedule(at(3, 0), ["00:00-00:00"])).toBe(true);
  });
});

describe("invalidWindows", () => {
  test("识别越界与格式错误", () => {
    expect(invalidWindows(["12:00-14:00"])).toEqual([]);
    expect(invalidWindows(["25:00-09:00"])).toEqual(["25:00-09:00"]);
    expect(invalidWindows(["12:60-13:00"])).toEqual(["12:60-13:00"]);
    expect(invalidWindows(["abc"])).toEqual(["abc"]);
    expect(invalidWindows(["12:00"])).toEqual(["12:00"]);
  });
});

describe("calendarEntries", () => {
  test("条目全部落在允许时段内", () => {
    const entries = calendarEntries(WINDOWS, 15);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const minute = entry.Hour * 60 + entry.Minute;
      const inWindow = (minute >= 12 * 60 && minute < 14 * 60) || minute >= 18 * 60 || minute < 9 * 60;
      expect(inWindow).toBe(true);
    }
  });

  test("跨午夜时不含结束时刻 09:00 与 14:00", () => {
    const entries = calendarEntries(WINDOWS, 15);
    expect(entries.some((e) => e.Hour === 9 && e.Minute === 0)).toBe(false);
    expect(entries.some((e) => e.Hour === 14 && e.Minute === 0)).toBe(false);
  });

  test("按间隔切分且去重排序", () => {
    const entries = calendarEntries(["12:00-14:00"], 30);
    expect(entries).toEqual([
      { Hour: 12, Minute: 0 },
      { Hour: 12, Minute: 30 },
      { Hour: 13, Minute: 0 },
      { Hour: 13, Minute: 30 },
    ]);
  });

  test("无窗口时返回空数组", () => {
    expect(calendarEntries([], 10)).toEqual([]);
  });
});

describe("scheduleGate", () => {
  const cfg = { schedule: { windows: WINDOWS, intervalMinutes: 15 } } as never;

  test("窗口内放行并给出原因", () => {
    const gate = scheduleGate(at(13, 0), cfg);
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toContain("在允许时段内");
  });

  test("窗口外拒绝并给出原因", () => {
    const gate = scheduleGate(at(10, 0), cfg);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("不在允许时段内");
  });

  test("配置写错时放行，避免自动化彻底停摆", () => {
    const broken = { schedule: { windows: ["25:00-09:00"], intervalMinutes: 15 } } as never;
    const gate = scheduleGate(at(10, 0), broken);
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toContain("时间窗配置非法");
  });
});

describe("describeSchedule", () => {
  test("空列表回退为不限时段", () => {
    expect(describeSchedule([])).toBe("不限时段");
    expect(describeSchedule(WINDOWS)).toBe("12:00-14:00, 18:00-09:00");
  });
});