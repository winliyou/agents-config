# headless 会话的可见性、帧驱动与 E2E 脚本细节

> 本文是 browser-automation-safety 的 reference：用 agent-browser 写 E2E / 冒烟 / 跑批脚本时的可见性与帧驱动问题、eval 表达式限制、脚本 session 命名。排查「帧驱动断言全超时」「ref 失效」「长会话 eval 返回 null」时读。

## 一、headless 会话的 rAF/可见性


**现象**：headless 会话默认 `document.visibilityState === "hidden"` 且 **requestAnimationFrame 完全不触发**
（1 秒 0 帧）——依赖逐帧更新的应用（游戏渲染循环、每帧 UI 同步、进度条/倒计时）会全部停摆，
"E2E 全过"的假象只覆盖事件驱动断言，帧驱动断言（击杀计数、面板随 state 显隐、动画推进）全部超时。

**做法**：会话冷启动时经 `AGENT_BROWSER_ARGS` 注入三件套（无逗号值,可安全并列）：
```
--disable-background-timer-throttling,--disable-renderer-backgrounding,--disable-backgrounding-occluded-windows
```
效果：`visibilityState === "visible"` + rAF 61 帧/秒(与应用 60 上限一致)。

**⚠️ 自设 `AGENT_BROWSER_ARGS` 会挤掉 wrapper 的反检测注入**：
wrapper 的逻辑是 `if (!process.env.AGENT_BROWSER_ARGS) 注入 --disable-blink-features=AutomationControlled`。
你自己设了这个变量，wrapper 就**不再补**那一条 → `navigator.webdriver` 变回 `true`。
所以注入上面三件套时**必须把 `--disable-blink-features=AutomationControlled` 一起带上**：
```
AGENT_BROWSER_ARGS=--disable-background-timer-throttling,--disable-renderer-backgrounding,--disable-backgrounding-occluded-windows,--disable-blink-features=AutomationControlled
```
（`AGENT_BROWSER_USER_AGENT` 是另一条独立判断，不受影响，UA 仍会被 wrapper 注入成正常 Chrome。）

注意:
- flag 只在 Chrome 冷启动时生效,已运行的会话需 close 后重开才生效;
- 三个 flag 的值均无逗号,可经 ARGS 逗号拆分安全传递;若需 `--disable-features=A,B` 这类含逗号值,
  只能单独传一个 flag(ARGS 会按逗号硬拆)。

**另一坑**：上游 CLI 的 `eval` 只支持**单表达式**——多语句(`a; b`)在其内部包裹下是解析期语法错误,
CLI 静默返回空。E2E harness 需按「分号结尾=语句(函数体包裹,值丢弃)/否则=表达式(括号包裹,值保留)」
路由包裹;E2E 断言中短生命周期 DOM(自动消失的横幅/通知条,生存期约 1s)应在动作后**立即同步读取**,
轮询会错过消失窗口。

## 二、脚本化使用（冒烟测试 / CI）


写脚本驱动浏览器时，**session 名必须稳定**，否则每次运行都新建浏览器：

```js
// ✗ 错误：process.pid 每次不同 → 每次新 session、新浏览器实例
const SESSION = `smoke-${process.pid}`;
// ✓ 正确：按项目/用途固定名字，反复运行复用同一实例
const SESSION = 'myapp-smoke';
```

任务结束按名字关自己那个：`agent-browser --session <名> close`（**不要** `close --all`）。
