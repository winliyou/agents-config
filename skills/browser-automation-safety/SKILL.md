---
name: browser-automation-safety
description: 浏览器自动化安全约定与防弹窗红线（本机）：优先用 agent-browser；会话级 session 固化（一个会话固定一个 session，已由 wrapper 强制）；浏览器二进制选择、daemon/标签页复用、禁止反复新建连接、禁止抢焦点与强切标签、禁止连用户日常 Chrome。触发：用浏览器自动化前；Chrome「正在请求远程控制」弹窗、弹窗轰炸、反复弹窗、抢焦点、窗口乱跳、标签被切走、进程堆积；打开网页/截图/抓取数据/测试 web 应用/登录站点；Electron 自动化（VS Code、Slack、Discord、Figma、Notion）；Slack 消息；探索性测试、QA、找 bug；需要登录态持久或独立 profile；agent-browser 跑成 Chrome for Testing；怀疑 session 重复新建、daemon 被反复重启。
---

# 浏览器自动化安全（Browser Automation Safety）

**任何浏览器自动化动手前先读本节。** 这是本机约定，与 `agent-browser` 工具自带的 skill（工具用法）互补：那个讲怎么用，这个讲怎么**不打扰用户**。

**工具选择**：一律优先用 `agent-browser` 而非内置网页工具或其他浏览器自动化方案（它是本机已配置、已验证的那套）。工具用法先 `agent-browser skills get core`。

**关键点：本节约定与本机 `~/.agent-browser/config.json` 共同生效——不要绕过配置文件去手写 env。**

## 复用铁律：一个会话固定用一个 session（已由 wrapper 强制）

**绝大多数任务只需要一条命令，不要新建 session、不要新建浏览器、不要连用户日常 Chrome。** 本机已把正确行为固化进两处配置，**默认路径就是安全路径**：直接 `agent-browser <命令>`，自动使用日常 Chrome Stable + headless + 独立临时 profile，与用户日常 Chrome 100% 物理隔离，**不弹窗、不抢焦点、不切页**。

### 会话级 session 固化（2026-09-25 起，无需再手动指定）

`~/.local/bin/agent-browser` 是一个包装器（PATH 设计上优先于 `~/.bun/bin/agent-browser`，**但实测 PATH 顺序不保证跨会话/跨调用一致**——2026-09-28 实测同会话前半段解析到包装器、后半段变成 `~/.bun/bin` 裸二进制，绕过全部包装后沙盒内两级失败：socket 不可写 + Chrome 内层沙盒冲突（表象 `CDP response channel closed`）。**每次调用前 `command -v agent-browser` 核对，或直接用全路径 `~/.local/bin/agent-browser`**），**自动按 DSH 会话注入固定 session 名**：

- 有 `DSH_SESSION_ID`（每个会话唯一且稳定）时，若调用方**未**显式指定 session，则注入 `dsh-<会话 id 后 8 位>`；
- **显式指定优先**：`--session <名>` 或 `AGENT_BROWSER_SESSION=<名>` 一律尊重、不被覆盖（CNM 管线的 `cnm-gen` 等既有用法不受影响）；
- 不在 DSH 会话内（无 `DSH_SESSION_ID`）时保持上游默认行为。

**意义：同一个会话内所有 `agent-browser` 调用自动落到同一个 session → 同一个 daemon → 同一个浏览器实例**，不会再因为漏写 `--session` 而落到全局共享的 `default` 会话、或每次换名新建实例。这是结构性保证，不依赖「每次记得写 --session」的纪律。

**仍然不要随手新建 session 名**：每个新 session 名 = 一个新 daemon + 一个新浏览器实例。同一任务流内始终复用当前会话已固定的那个；**任务中途不要重建 daemon**（等待用 `--default-timeout` / `wait` / `eval` 轮询，绝不靠 kill 重启）。任务结束后可手动 `close`，或不管——daemon 空闲 1 小时自动回收。

**只有这两种情况才需要显式指定 `--session`**：

1. 任务本身要求**登录态持久**——此时应配 `--profile ~/.agent-browser/profiles/<用途>`（官方语义：*login state survives*），而不是靠新 session 名；
2. 确需与该 session 的既有 daemon 共享状态（如用户已在别处建立该 session）。

### 沙盒自适应（受限沙盒内照常可用，无需申请更宽松权限）

> **授权说明**：关闭 Chrome 内层沙盒（`--no-sandbox`）属降低子进程隔离等级。本机用户已就 agent-browser/Chrome 场景**明确授权自动化**（「我更需要自动化体验」+ 要求按环境自动判断），故下文的自动注入是**已授权行为**；该授权**仅限本场景**，其他工具须另行取得同意（判定规则见 `sandbox-adaptation` skill「降低子进程沙盒的判定规则」）。

DSH 的 `workspace-write` 沙盒只允许写会话工作区，会让 agent-browser **两级失败**（2026-09-25 实测）：

1. socket 目录 `~/.agent-browser` 不可写 → daemon 起不来
   （`Socket directory '/Users/liyou/.agent-browser' is not writable`）；
2. Chrome 启动失败（`Failed to initialize sandbox` / `GPU process isn't usable`）
   ——根因是 **Chrome 内层沙盒与 DSH 外层沙盒嵌套冲突**，不是显存/GPU 问题。
   对照实验：**只加 `--no-sandbox` 即成功**；只加 `--disable-gpu` 仍失败
   → `--no-sandbox` 必需，`--disable-gpu` 非必需。

**解法是「目录重定向 + 按环境决定是否关 Chrome 沙盒」——本场景已足够，通常无需提权**（但提权始终是正当选项，见文末）：

| 变量/参数 | 作用 | 落点 |
|---|---|---|
| `AGENT_BROWSER_SOCKET_DIR` | daemon socket 与状态文件 | 可写目录下 `sock/` |
| `--profile` | Chrome profile（否则写 `~/Library/Application Support` 被拒） | 可写目录下 `chrome-profile/` |
| `AGENT_BROWSER_ARGS=--no-sandbox` | 关掉 Chrome 内层沙盒，解决嵌套冲突 | **仅在已有外层沙盒时注入**（见下） |

**这些已由 `~/.local/bin/agent-browser` 包装器自动完成**：它先判断「默认 socket 目录是否可写」，受限时按 `TMPDIR → ./.workwork → /tmp` 顺序挑落点并注入配置；**正常环境完全不干预**。实测在 `workspace-write` 下**零提权**跑通 open / snapshot / 元素引用 / 填写 / 点击 / 等待 / 截图 / JS 提取，且同一 session 连续多次调用 **daemon pid 恒定**（不反复新建浏览器 → 不反复弹窗）。

**若重定向仍不够用 → 直接请求更宽松权限（正当路径，不必纠结）**：对**单条命令**申请 `danger-full-access` 即可，harness 会把请求作为审批呈现给用户。典型场景：
- 必须保留 Chrome 原生沙盒而非 `--no-sandbox`；
- 必须访问**工作区外**的既有 profile（复用已登录态，如 `~/.agent-browser/cnm-gemini`、CNM 的 `cnm-gemini` Chrome profile）；
- 工具路径硬编码、无任何可重定向的配置面。

不要因为"提权要审批"就卡死或放弃功能——**先问再放宽是被鼓励的，「自己悄悄绕开」才是禁止的**。

### Chrome 沙盒按环境自适应（不搞一刀切）

**判定原则：外层已有沙盒 → 关 Chrome 内层沙盒；外层没有沙盒 → 保留 Chrome 原生沙盒。**

理由是沙盒的价值在于「至少有一层」且不该无谓削减：外层已隔离时，Chrome 内层沙盒只会导致浏览器起不来（macOS Seatbelt 不支持嵌套），此时关掉是必要的、且隔离仍由外层提供；而外层没有沙盒时（如用户手动在终端执行），保留 Chrome 原生沙盒才是正确的安全姿态。

**探测手段**（由包装器自动执行，测「当前能否再创建一层 Seatbelt 沙盒」）：

```bash
/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true
# 失败 / sandbox_apply: Operation not permitted  → 已在沙盒内 → 注入 --no-sandbox
# 成功 (exit 0)                                  → 无外层沙盒 → 保留 Chrome 沙盒，不注入任何参数
```

实测对照（同一条 `agent-browser open` 命令，两种环境）：

| 运行环境 | Chrome 启动参数 | 结果 |
|---|---|---|
| DSH 受限沙盒内（`workspace-write`） | 含 `--no-sandbox` | ✅ 正常启动 |
| 无外层沙盒（提权执行） | **仅 `--headless=new`，无 `--no-sandbox`** | ✅ 原生沙盒保留 |

**手动覆盖**：`AGENT_BROWSER_CHROME_SANDBOX=native` 可强制保留 Chrome 原生沙盒（即使因此启动失败）；默认 `auto` 即上述自动判断。调用方显式传 `--args` 时包装器不插手。

### 目录重定向对 Chrome 无效的边界（避免走弯路）

实测确认**重定向 HOME 无效**：macOS Chrome 用 `NSHomeDirectory()` 定位配置目录，**不读 `HOME` 环境变量**（`HOME=/tmp/x` 后仍去写 `/Users/liyou/Library/...`）。同理 `--crash-dumps-dir` / `--disable-gpu-sandbox` / `--no-zygote` 都不能替代 `--no-sandbox`。

**且这些都与目录无关**——报错原文是 `sandbox initialization failed: Operation not permitted`，是 `sandbox_init()` 被外层策略拒绝，不是路径不可写。**所以不要试图靠重定向目录来避免 `--no-sandbox`，要按上面的环境判定来处理。**

### 连日常 Chrome 的唯一后果就是弹窗（务必避免）

`--cdp 9222` / `--auto-connect` 是**弹窗的唯一来源**：Chrome 对每一条**新的** DevTools WS 握手都弹「正在请求远程控制」。因此**只要反复建连接，就会反复弹窗**。若某任务确实需要日常 Chrome 的登录态，正确做法是改用独立 profile 并**首次登录一次**（登录态长期保留在该 profile 目录），而不是每次 attach。

**永远不要**：`pkill` 杀掉 daemon 再重连（每次重连 = 再次弹窗）；把 kill 写进重试循环；为了"用日常 Chrome 登录态"而在循环里新建连接。

## 二进制已全局固化（2026-09-24 起，无需每条命令手写）

`~/.agent-browser/config.json` 已写入用户级默认值，**无需再在命令行传 env**：

```json
{
  "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
}
```

配置优先级：`~/.agent-browser/config.json` < `./agent-browser.json`（项目级）< 环境变量 < CLI flags。

- **为什么只固化这一项就够**：唯一必须纠正的是**二进制**。agent-browser 缺省引擎是自带的 Chrome for Testing，而 `AGENT_BROWSER_EXECUTABLE_PATH` 过去要求**每条命令**手写——agent 没有跨会话记忆，漏一次就静默换成 for Testing，用户无法察觉。其余默认值（headless、临时 profile、空闲回收）本来就是想要的行为，不重复声明，避免与工具默认值脱钩。
- **daemon 启动参数在首启时固化**：某 session 一旦首次以错误二进制启动，后续带 env 复用也不生效。核对当前 session 实际用的二进制：`agent-browser session info`，或 `ps aux | grep agent-browser-chrome` 看二进制路径（`Google Chrome.app` = Stable；`~/.agent-browser/browsers/chrome-<版本>` = for Testing）。
- **发现 session 已在 for Testing 上跑**（历史遗留）：`agent-browser --session <名> close` 结束它，下次调用即按新配置重建——**中途补 env 无效**，必须重建 session。
- 项目若确有特殊需求（如钉死某版本浏览器），用项目级 `./agent-browser.json` **覆盖单键**，不要改动用户级配置。

## 严禁事项（红线）

1. **禁止抢焦点 / 置顶窗口**：不得调用任何 OS 级窗口激活（如 AppleScript `activate`）或置顶行为，不得打断用户的键鼠输入。
2. **禁止强切用户当前活动标签页**：用户可能正在前台浏览或观看视频，严禁调用 `set active tab` 或粗暴切走其活动页面。
3. **禁止 `--auto-connect` / `--cdp 9222` 连用户日常 Chrome**（除用户明确要求）：外部 CDP attach 会让 Chrome 弹「有应用正在请求远程控制」，且**每次重连都会再弹一次**。
4. **禁止杀 daemon 后重连，禁止一切重建 CDP 连接的形式**（`pkill` daemon、重开 WS 握手、重新 attach、重启浏览器），尤其禁止写进重试循环——Chrome 对**每一条**新的 DevTools 握手都会再弹一次「正在请求远程控制」，重建 N 次 = 弹窗 N 次轰炸，自动化也随之全废（用户必须逐次人工确认）。
5. **禁止 `close --all`**：会关掉本机其他 agent 的 session。只关自己用的那个。
6. **禁止每次执行都 `open` 新标签**：制造孤儿标签（见下「标签页复用」）。

## 唯一例外：确需操作用户日常 Chrome（有登录态）

```bash
agent-browser --auto-connect <命令>          # 等价：AGENT_BROWSER_CDP=9222 agent-browser <命令>
```

仅当用户明确要求操作其**已登录的日常 Chrome** 时才用。

- **前提**：先确认端口在监听（`lsof -iTCP:9222 -sTCP:LISTEN`）。不在时报告用户，**不要自行重启用户的 Chrome**。
- **防弹窗**：连接建立后 daemon 必须长驻复用；等待放宽 `--default-timeout` 或用 `wait`/`eval` 轮询，**绝不销毁 daemon 重建**。
- `/json/version`、`/json/list` 返回 404 属正常（新版 Chrome 对默认 profile 的安全限制），WebSocket 端点可用即连接有效。

## 通用硬性规则

- **标签页复用**：任务前先 `tab list` 查已有标签；同 session 内 `open` 会复用当前标签（实测不堆积），需要多标签时显式 `tab new`；存在匹配标签时用 `tab <id>` 切换复用。
- **后台交互**：在后台/headless 标签页触发点击时，用完整 Pointer/Mouse 事件序列与真实元素坐标（`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`），配合 `input`/`change` 派发；**严禁靠前置激活窗口来促成事件触发**。
- **profile 隔离**：独立 profile 一律放 `~/.agent-browser/profiles/<用途>`；**禁止读写用户 Chrome 的默认 user-data 目录**。
- **daemon 僵死**：仅在确认 daemon 彻底无响应且非网络等待时，才允许**单次** `pkill -f agent-browser-darwin-arm64`；严禁写进任何重试循环。
- **首启竞态**：首次 `open` 后立即取标题可能为空（Chrome 首启慢），重试一次即可。
- **Chrome 异常退出后 SingletonLock 残留**：上一轮 Chrome 崩溃/被杀后，profile 目录残留 `SingletonLock` 等锁文件，后续启动报 `Failed to create .../SingletonLock: File exists` → `ProcessSingleton ... Aborting`。
  辨别特征极具误导性：`open` 可能仍打印「✓ 页面标题 + URL」造成成功假象，但紧接的 snapshot/eval 全报 `CDP response channel closed`——**先删该 profile 下的 `Singleton*`（或整个 profile 目录）再重开**，清锁后再排查别的。两会话独立实测确认（本机 + hotspot 会话，2026-09-25）。
- **代理**：本机已设 `no_proxy=localhost,127.0.0.1,::1`，直连本机 CDP 端口无需 `--noproxy`（历史提示已过时）。

### 专用实例直连 CDP（自研管线，如 gemini-gen）

自研 CDP 管线不走 agent-browser，但沿用同一套隔离原则：

- **先查清监听者是谁再连**：`lsof -iTCP:9222 -sTCP:LISTEN` 只说明有 Chrome 在监听，不说明可以连；再 `lsof -p <pid>` 看打开文件——落在 `~/Library/Application Support/Google/Chrome/Default/` 就是用户日常 Chrome，**直接换独立实例，不要连**（2026-09-25 实测：gemini-gen 旧管线直连 9222 导致每次重连都向用户弹「请求远程控制」，已迁移到独立实例）。AI 会话沙盒常禁 `ps`（报 `/bin/ps: Operation not permitted`），用 lsof 取证。
- **独立实例三要素**：独立 user-data-dir + 独立端口（如 9223）+ 常驻 daemon 单连接复用（断线退避自愈，严禁 kill/重连循环——同弹窗红线 4）。
- **Chrome 111+ 握手细节**：browser WS 只认 `/json/version` 返回的带 UUID `webSocketDebuggerUrl`（`/devtools/browser` 短路径 404）；WS 请求带 `Origin` 头会 403；日常 Chrome（默认 profile）对 `/json/version` HTTP 端点返回 404 属正常，独立 profile 返回完整 JSON。

## 脚本化使用时（冒烟测试 / CI）

写脚本驱动浏览器时，**session 名必须稳定**，否则每次运行都新建浏览器：

```js
// ✗ 错误：process.pid 每次不同 → 每次新 session、新浏览器实例
const SESSION = `smoke-${process.pid}`;
// ✓ 正确：按项目/用途固定名字，反复运行复用同一实例
const SESSION = 'travel-smoke';
```

任务结束按名字关自己那个：`agent-browser --session <名> close`（**不要** `close --all`）。

## CLI 细节坑（本机实测）

- **session 名过长会直接失败**：socket 路径上限约 103 字节。`--scope worktree --prefix <长前缀>`
  拼出的 `<前缀>-<hash>` 一旦过长即报
  `Session name '...' is too long. Socket path would be 105 bytes (max 103)`，
  且后续命令全部不执行。用短前缀（`--prefix chk1`），或设 `AGENT_BROWSER_SOCKET_DIR` 指向更短路径。
- **`find` 的参数位**：语法为 `find <locator> <value> [action] --name <名字>`。
  写成 `find role button "缩小" click` 会把值位写错、**静默 no-op**（不报错、什么都没点，
  实测空转好几轮才发现）；正确写法是 `find role button click --name "缩小"`。
- **不要把"抽 ref"和"点 ref"挤在同一条复合命令里**：多步之间会重新快照，
  `$(... | grep -oE '@e[0-9]+')` 常拿到空串 → 点击无效且无报错。取 ref 与点 ref 分两步执行；
  或用上面的 `find` 语义定位，从根上免掉 ref 失效问题。
- **残留 SingletonLock 导致 Chrome 起不来（2026-10-01 实测，fft_cover 迁入）**：表象
  `Chrome exited early (exit code: 21) without writing DevToolsActivePort` + stderr
  `Failed to create .../chrome-profile/SingletonLock: File exists`——根因是上次会话的
  Chrome 临时 profile 残留了 SingletonLock（symlink），与 `--no-sandbox` 无关，
  不要被同行的 Crashpad `settings.dat: Operation not permitted` 噪音带偏。解法：
  按报错原文里的 profile 路径 `rm -f <profile>/SingletonLock` 后重试（删除前先 `ls`
  确认目录确属 agent-browser 临时 profile）；无需重建 daemon/session。
- **长会话劣化：同一 session 反复导航/重载后 eval 陆续返回 null（2026-10-13 实测，
  fft_cover e2e 冒烟）**：表现为最初可用的 eval 在若干次 reload 后开始返回空/null，
  清 SW/缓存、重开标签只能临时恢复。解法：**跑批类任务用全新 session，跑完即关**
  （`--session <新名>` + close），不要复用跨多轮的老会话；结合上面「session 名必须
  稳定」的规则，这个新名应是项目固定的冒烟专用名，每次运行前先 close 旧实例。

## 用户日常 Chrome 上的 AI 网页自动化（Gemini 等，2026-10-14 实测 fft_cover）

**前提：仅限用户明确要求操作其日常 Chrome（用其登录态）时使用，即上方红线 3 的唯一例外场景；AI 不得自行选择此模式。** 下文直连 CDP 与 `--auto-connect` 是同一前提的两种入口。

**auto-connect 模式下命令默认跟随用户的「当前活动标签」**——用 `--auto-connect
--pin-tab` 钉住自己的标签（`tab new <url>` 时带 `--pin-tab` 即建即钉），之后所有
命令（含截图）只打该标签，用户看哪都不影响。

**唯一可行方案：直连 CDP 用 `Input.dispatchDragEvent` 做真实文件拖拽**
（2026-10-14 实测：4/4 图片全部附加成功、缩略图完整渲染、Gemini 正常受理）。

**CDP 会话全程复用（2026-10-14 用户重申，弹窗铁律）：整个任务只允许发生一次 browser 级 WS 握手、一次 target attach——下述流程第 1-2 步建立连接后，取坐标、拖拽、输入、发送、轮询响应（第 3-7 步）全部复用这条连接与这个 attach session，直到任务结束。禁止每步操作重开 WS 或重 attach。意外断线只允许单次退避重连；连续失败说明 Chrome 端状态已变，停下来报告用户，严禁循环重连（每条新握手都弹一次窗）。**

### 流程（Node 22+ 内置 WebSocket，无需依赖）

1. **拿 WS 端点**：读用户 Chrome profile 的 `DevToolsActivePort` 文件
   （`~/Library/Application Support/Google/Chrome/DevToolsActivePort`，两行：
   端口 + `/devtools/browser/<uuid>`）。HTTP `/json/*` 对默认 profile 404，
   不影响 WS 直连。**文件 mtime 偏旧 ≠ 端点失效**：Chrome 不重启则端口与 UUID
   不变（2026-10-14 实测：mtime 6 天前的文件仍直连成功）；失效的判据是
   端口无监听（`lsof -iTCP:<port> -sTCP:LISTEN`）或 WS 连接失败，此时停下来
   请用户以调试模式重启 Chrome，禁止自行重启用户 Chrome 或反复试探。
2. **找页并 attach**：`Target.getTargets` 按 URL 找页 targetId →
   `Target.attachToTarget {targetId, flatten:true}`。
3. **取投放点**：`Runtime.evaluate` 读 composer 的
   `getBoundingClientRect` 中心坐标。
4. **拖拽**：`Input.dispatchDragEvent` 依次 `dragEnter`/`dragOver`/`drop`，
   `DragData = {items:[], files:[本地绝对路径...], dragOperationsMask:1}`——
   **files 传本地绝对路径**，Chromium 按真实系统拖拽处理（isTrusted=true）。
5. **输入提示词**：真实 click 聚焦 contenteditable →
   `keyboard inserttext "$(cat prompt.md)"`（CDP Input.insertText，多行中文可靠）。
6. **发送**：eval 找 aria-label 含 `发送` 的 button 并 click。
7. **捕获响应**：eval 轮询响应容器 innerText 长度，连续 2 次稳定即完成
   （高思考等级 1-3 分钟）。

### 注意

- attach + evaluate 偶发渲染器崩溃（`Target crashed`）——捕获后 `Page.reload`
  等重生、重 attach 即恢复；崩溃会丢 composer 附件状态，需重新拖拽。
  **此处「重 attach」属异常恢复例外（原 session 已随渲染器崩溃死亡），每个任务至多一次；连续崩溃即停并报告，不得反复重生重连。**
- 附件验证用 `Page.captureScreenshot` 目视确认芯片缩略图（DOM 属性计数不可靠）。
- 模型/思考等级选择（点 Pro 按钮 → 菜单）：菜单项用
  `[role=menu] [role=menuitem]` 精确层级选择（「3.1 Pro」→ 重开菜单 → 「高点」）。
- 页面 Angular 重渲染会复位模型选择与附件状态——每步之间 eval 读 DOM 确认。
