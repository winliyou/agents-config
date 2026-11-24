---
name: cua-desktop-control
description: 用 cua 操作 macOS 原生应用/窗口/系统弹窗的规程：发现应用与窗口、读 AX 树、按元素或截图像素点击、键盘与粘贴输入、点击后复核、失败处置。触发：需要点击网页以外的东西（桌面 App、模拟器窗口、系统文件选择器/权限弹窗、通知横幅）；agent-browser 点不到或 DOM 没有对应节点；设备调试工具（hdc/adb）点不进系统图库、相机、授权弹窗等宿主侧 UI；需要 AX 树定位或桌面应用截图走查；怀疑坐标缩放/前台激活导致点击无效。
---

# CUA 桌面点击操作（macOS 原生 UI）

需要操作网页之外的窗口、或用语义（AX）而不是坐标去点击时加载。CUA 跑在宿主机桌面层，不依赖网页 DOM，也不要求目标是浏览器。

## 何时用 CUA（点击手段分工）

| 场景 | 首选 |
|---|---|
| 网页内点击/填表/上传/登录 | `agent-browser`（DOM 稳定、可断言、不抢桌面焦点） |
| macOS 原生 App、桌面窗口、系统弹窗、文件选择器、权限弹窗 | **cua** |
| 手机/平板模拟器**窗口本身**（含其系统图库、相机、授权弹窗等宿主侧 UI） | **cua**（这些 UI 在宿主机窗口里，设备内工具点不到） |
| 模拟器/真机**内部页面** | 设备自带 UI 自动化（hdc uitest / adb uiautomator） |
| 终端交互 | terminal 工具，不用像素点击 |

判断口诀：**有语义层（DOM / AX / 元素 id）就用语义层，拿不到才退回截图像素坐标**；跨到宿主机窗口的系统 UI 一律用 CUA。

## 初始化与能力门禁

`@deepseek-ai/dsh-cua` 的模块路径见 `local-environment` skill「已装工具与路径」的 dsh-cua 条目；在持久 PTC 环境里只初始化一次：

```ts
var { connectCua } = await import("<DSH 安装根>/node_modules/@deepseek-ai/dsh-cua/lib/bridge.js");
var cua = connectCua(() => tools.cua);
const caps = await cua.getCapabilities();
```

开始任何 UI 动作前检查 `caps`：

- `permissions.accessibility` 与 `permissions.screenRecording` 必须为 `true`（macOS 需授予辅助功能 + 屏幕录制；应用内点击全灭的排障见 `local-environment`「鼠标点击无响应」）；
- `sessionLocked` 必须为 `false`；为 `true` 表示桌面锁屏，**立即停止 UI 动作并让用户解锁**，不盲点；
- `coordinateSpace` 为 `screenshot-pixels`：坐标以工具返回的截图为准，不是 macOS points；
- `keyboard` 为作用域列表（macOS 为 app 级）；`browser:false` 表示它不是网页自动化工具。

## 标准点击流程

1. **发现应用**：`listApps()`（运行中）或 `findApps("关键词")`（含未启动）；同名多实例用返回的 `pid` 选择。
2. **选应用**：`getApp(selector)`（会请求用户授权；被拒绝就停止，不绕过）→ `app.getWindows()` 取窗口，用 `windowId` 建 window 对象。**所有观察与点击都对具体窗口**，不猜活动窗口；多屏/多窗口用标题与 `bounds` 确认（`bounds` 是全局 macOS points，仅用于选窗口，不用于点击）。
3. **观察**：优先 `window.getAccessibilityTree()` / `app.getAccessibilityTree({ includeMenus: true, details: true })`，按角色/无障碍文本定位目标元素。
4. **点击**：语义点击用 `win.click(elementId)`（窗口内鼠标点击）或 `app.invoke(elementId)`（元素默认动作，适合后台控件）；需要坐标时先 `win.getScreenshot()`，坐标用**这张截图的像素**（左上原点），或 `relative:true` 传 0–999 千分比。
5. **复核**：每次动作后重新读 AX 树（文本/选中态变化）或重截图。`dispatched:true` 只表示事件已派发，不表示应用接受了它。
6. **前台**：后台窗口可能忽略点击；需要时 `app.activate()` 后**重新观察**再点；`FOREGROUND_REQUIRED` 就是这个信号。
7. **收尾**：不关闭用户正在用的 App；用过 `toggleMouse` / `sendKeyEvent` 的按住态要显式 up/release（工具结果会提示残留输入）。

## 系统弹窗与文件选择器

- 系统面板通常是**独立窗口**：在 `app.getWindows()` 里按标题/尺寸找到它，操作该窗口的元素，不要把面板按钮当主窗口元素。
- 有 AX 语义按钮就 `win.click(id)` / `app.invoke(id)`；AX 树拿不到时退回「该窗口最新截图」坐标点击，并确保窗口在前台。
- 完成选择后回读主窗口：AX/截图应显示回填结果或面板已关闭，再继续业务操作。
- 隐私/系统设置等确认弹窗只点用户明确要求的项；**密码、一次性验证码禁止代输**，让用户自己输入。

## 键盘与文本输入

- 单键：`pressKey("Tab", ["shift"])`、`pressKey("Enter")`；修饰键名 `command/control/option/shift/fn`；**不要把组合键写成一个字符串**。
- 文本：`typeText` 走键盘事件；中文/长文本优先 `paste`（剪贴板通道，失败会明确报 `PASTE_NOT_CONSUMED`，先观察再决定是否重试）。
- 输入前点一下输入框并确认 AX 焦点，避免输入法把直接键入吞掉。
- `useSystemInput: true` 只在必须走真实系统键盘队列（全屏/游戏/特殊控件）时用；首次会请求审批，按住态要与 release 成对。

## 失败模式与处置

| 现象/报错 | 处置 |
|---|---|
| `SESSION_LOCKED` / `sessionLocked:true` | 停止 UI 操作，请用户解锁桌面 |
| `FOREGROUND_REQUIRED` | 说明原因 → `app.activate()` → 重新截图/AX → 再点 |
| `STALE_SNAPSHOT` / `WINDOW_CHANGED` / `SCREENSHOT_REQUIRED` | 重新观察（新 AX 树或新截图）后再点；禁止用旧 id/旧坐标重放 |
| `HOVER_UNAVAILABLE` | 该元素不支持 AX hover；改点击/键盘/系统输入，不要反复试 hover |
| `click` 返回 dispatched 但界面无变化 | 依次核对：窗口是否前台/被遮挡、坐标是否按截图像素、点击目标是否只是容器；重截图确认后再试 |
| AX 树为空或只有外壳 | 提高 `maxDepth`/`maxElements`、开 `includeMenus`；仍为空则该应用自绘 UI，退回截图坐标 + 键盘导航 |

## 验收清单

- [ ] `getCapabilities()` 权限两项为 true 且 `sessionLocked:false`；
- [ ] 关键动作后都有新观察（AX 变化或截图），不是只看 `dispatched`；
- [ ] 坐标点击来自**该窗口最新截图**，没有跨窗口/跨缩放混用；
- [ ] 系统弹窗路径已确认（选择结果回到主窗口）；
- [ ] 未代输密码/验证码，未关闭用户 App，无残留 held 输入；
- [ ] 截图证据保存在临时目录，不提交进仓库。