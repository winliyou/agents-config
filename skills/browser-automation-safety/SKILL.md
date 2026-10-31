---
name: browser-automation-safety
description: 浏览器自动化安全约定与防弹窗红线（本机）：一律用 agent-browser；全机一个浏览器 owner + 每会话独立房客（wrapper 强制）；默认 headless 静默运行、绝不抢焦点；禁止连日常 Chrome、禁止杀 daemon 重连、禁止 close --all、禁止抢焦点/强切标签；含 Dock 守卫、清理与沙盒提权。触发：用浏览器自动化/自动化测试前；Chrome「正在请求远程控制」弹窗、弹窗轰炸、抢焦点、窗口乱跳、标签被切走、点 Dock 无反应、进程与标签堆积；打开网页/截图/抓取/登录站点/测试 web 应用；Electron 自动化（VS Code、Slack、Discord、Figma、Notion）；Slack 消息；探索性测试、QA、找 bug；需要登录态持久或独立 profile；agent-browser 跑成 Chrome for Testing；session 重复新建、daemon 被反复重启；Gemini 网页版自动化（上传失败、点「上传和工具」没反应、找不到 input[type=file]、传上说没图、读不到回答、后台标签菜单不渲染）。
---

# 浏览器自动化安全（Browser Automation Safety）

**任何浏览器自动化动手前先读本节。** 本 skill 与 `agent-browser` 工具自带 skill 互补：那个讲怎么用（`agent-browser skills get core`），这个讲怎么**不打扰用户**。

## 工具选择：一律 agent-browser（硬红线）

- **浏览器自动化与自动化测试必须走 `agent-browser`**，禁止自研脚本 / Playwright / 直接 spawn Chrome 或自写 CDP 脚本。三条理由：① 只有 wrapper 路径内置 `~/.agents/bin/chrome-guard`，防止 headless 实例独占 `com.google.Chrome` 的 LaunchServices 身份、导致用户点 Dock 没反应；② 历史取证中劫持用户 Chrome 的 headless 实例**全部来自项目自研脚本**；③ wrapper 启动开销已足够低（冷启动 1.9s、热路径约 250ms），"太慢所以绕开"不成立。
- **存量例外**：两仓库 E2E 仍用 Playwright（自带 Chromium、headless、未接日常 Chrome）属历史遗留——其一（游戏项目）**迁移进行中**（2026-10-31 复核：主分支仍有 `playwright.config.ts` + 20 个 `*.spec.ts`；迁移改动在**未合并**的 worktree 分支上，尚未进主干），另一（运维门户）待迁移。判断「迁完了没」一律看主分支：`ls playwright.config.ts tests/e2e/*.spec.ts`，不要凭印象。**新项目/新套件一律直接用 agent-browser，不得新增 playwright/puppeteer 依赖**；迁移前风险可控（自带 Chromium 与日常 Chrome 的 bundle 身份无关），但**不得改用 `channel: "chrome"` 接系统 Chrome**。
- 本节约定与本机 `~/.agent-browser/config.json` 共同生效——**不要绕过配置文件去手写 env**。
- **自研 CDP 管线已全部废止**（不 spawn Chrome、不管 CDP 端口/daemon/profile）；唯一允许的 CDP 补充场景（移动端视口模拟）与废止清单见 `references/wrapper-internals.md`。

## 复用架构：一个浏览器 owner + 每会话独立房客

**目标同时满足**：① 跨会话、跨进程功能连接（登录态全机共享、不反复弹窗、不重复起浏览器）；② 会话之间互不影响（谁也顶不掉谁的页面）。**wrapper 已强制实现**，显式指定一律优先。

**架构**：`shared` session 是**纯浏览器 owner**——只持有 Chrome（`profiles/main`、常驻、禁用空闲回收），**永不承载用户命令**。每个 DSH 会话（含冷启动者）以 **pinned 房客**运行：独立 session 名 + `--cdp <owner 端口>` + `--pin-tab`，wrapper **每次调用都重复注入**这两个参数。

| 角色 | session | profile | 说明 |
|---|---|---|---|
| owner（浏览器） | `shared` | `~/.agent-browser/profiles/main` | 只持有 Chrome；登录态全机持久、跨项目共享 |
| 房客（每次调用） | `dsh-<DSH_SESSION_ID 的 sha256 前 8 位>` | 不注入 | 靠 `--cdp` attach 到 owner，`--pin-tab` 钉住自己的 tab |
| 显式独立实例 | 调用方指定 | `profiles/<名>` | 跑批/隔离用；不受房客逻辑影响 |

**默认路径即正确路径**：直接 `agent-browser <命令>`，wrapper（`~/.agents/bin/agent-browser`，`~/.local/bin` 与 `~/.bun/bin` 两个 symlink 同指）自动完成全部装配。socket 与状态落点 `~/.agent-browser/*.sock`；默认目录不可写时 wrapper **直接报错退出**（不重定向），提示提权执行。

**使用约定**：

- **正常用法就是什么都不加**：不要为"隔离"手写 `tab new` 或改 session；**不要传 `--cdp`**（wrapper 已注入；漏传/自传都会破坏绑定——`--cdp` **不是 sticky**，漏传一次该 session 就掉回 owner 并顶掉别人页面）。
- **跑批 / 长会话劣化**：用独立实例 `AGENT_BROWSER_GLOBAL_SESSION=<项目固定名> agent-browser <命令>`（自带 `profiles/<名>`），用完 `agent-browser --session <名> close` 即还。
- **显式 `--session` / `--profile` 一律尊重**，既有项目用法不受影响。
- **任务中途不要重建 owner daemon**（等待用 `wait <ms>` / `eval` 轮询，必要时 `AGENT_BROWSER_DEFAULT_TIMEOUT=<ms>` 放宽操作超时；绝不靠 kill 重启——owner 重建会使所有房客绑定失效）。
- 需要退回旧的 shared 单例行为：`AGENT_BROWSER_GUEST_MODE=0`。

**close 硬闸**：wrapper 只拦**显式 `--session shared`** 与 `close --all`（一律），exit 1 并提示正确做法；**房客 `close` 放行**（合法自清理）。逃生门 `AGENT_BROWSER_ALLOW_CLOSE_SHARED=1`，仅在确认无其他会话使用时用。四个冲突源（`close` 落在 owner＝关掉全机浏览器、`close --all` 连带关跑批实例、同 session 内 `open` 走当前 tab、daemon 空闲 1h 回收）与注入细节见 `references/wrapper-internals.md`。

**标签与状态不泄漏 / `tab_gone` 自愈**：close 前先摘该会话 pinned tab，成功后清残留状态文件（`.target`/`.config`）；判别房客看其 daemon 是否 ESTABLISHED 连着 owner 端口（独立实例不摘标签）。自己钉的 tab 被关后上游报 `tab_gone`（exit 1、只写 stderr、不更新 `.target`），wrapper 检测到即按 lastUrl 自动重绑并重试恰好一次，lastUrl 非 http(s) 时回退 `about:blank`；仍绝不静默操作别人的 tab。**房客 daemon 不会 1h 自退**（走 `--cdp` attach 属上游 user-attached browsers，豁免空闲回收，实测存活 3h+），其标签只能靠显式 `close` 或孤儿 tab 兜底清理回收——旧文"房客 daemon 1h 自退、下次按 targetId 重挂"与实现不符，勿再采信。

## 静默运行：默认 headless，绝不抢焦点

**「不影响日常使用」的硬标准：不抢前台焦点。** 用户曾直接报障「操作浏览器时把我的焦点抢走，我干什么都会被切到自动化窗口」——根因是当时默认 headed。

| 模式 | 抢焦点? | 说明 |
|---|---|---|
| **headless（现行默认）** | **否** | 前台 ASN 全程不变；tab new / open / eval / screenshot 全流程零打扰 |
| headed | **是** | **一启动就抢走焦点**；窗口移屏外、`--start-minimized`、CDP `Browser.setWindowBounds` 搬窗口**全都不能避免** |

**反模式：`--silent-launch` 是无效参数**（grep agent-browser 二进制 0 命中，被静默忽略）；"有头 + silent-launch = 无窗口零打扰"的旧验收结论不成立。

**wrapper 现行默认注入**（显式 env/flag 一律优先）：

| 注入 | 值 | 作用 |
|---|---|---|
| `AGENT_BROWSER_ARGS` | `--disable-blink-features=AutomationControlled` | 清 `navigator.webdriver`（headless 下同样有效，实测 true→false） |
| `AGENT_BROWSER_USER_AGENT` | 正常 Chrome UA | 消 `HeadlessChrome` 指纹（**必须用官方这个键**；塞进 `AGENT_BROWSER_ARGS` 无效） |

实测：主进程 `--headless=new`、`navigator.webdriver === false`、UA 为正常 Chrome、screenshot 正常、连续多轮操作后 `lsappinfo front` 始终是用户正在用的应用。**已知取舍**：headless 下真实浏览器可能识别无头特征（creepjs 类）；有 GUI 需求（WebRTC 设备、部分 WebGPU 截图）时由调用方显式 `AGENT_BROWSER_HEADED=1`——但那会抢焦点，须先确认用户可被打扰。**不要**用 init-script 篡改 `navigator.webdriver`（会被 lie 检测抓到）。

- **验证前台占用禁止用 `osascript` + System Events**（会卡辅助功能授权弹窗、拖到执行超时）；用 `lsappinfo front` + `lsappinfo info -only name <ASN>`。
- **抢焦点还有第二个源头：`chrome-guard` 误判后对已运行的 Chrome 执行 `open`**。headless 本身不抢焦点，但 wrapper 每次调用前跑的 Dock 守卫若判定失效，就会 `open -g -a "Google Chrome"`——对**已运行**的 app 即激活窗口（实测 2.1s 后前台被切走）。排查「频繁抢焦点」**先查这条**：`~/.agents/bin/chrome-guard --check` 应为 exit 0。根因、修复与验证矩阵见 `references/dock-and-focus-guard.md`。
- **daemon 启动参数在首启时固化**：改 headed/args/profile 后**必须重建 owner 才生效**；重建前确认无其他会话在用，`AGENT_BROWSER_ALLOW_CLOSE_SHARED=1 agent-browser close`（普通 close 会被硬闸拦），并先看 `tab list`、告知用户（重建会关掉当前所有标签）。

## 严禁事项（红线）

1. **禁止抢焦点 / 置顶窗口**：不得调用任何 OS 级窗口激活（AppleScript `activate`、对已运行应用 `open -a`）。**`open -g` 不等于安全**：它只保证冷启动不进前台，对已运行 app 仍会激活窗口（实测）；同理守卫拉起 GUI 必须带 `-n`，否则会被已在跑的 headless 吞掉事件（见 `references/dock-and-focus-guard.md`）。不得打断用户的键鼠输入，**禁止把默认改回 headed**；确需真窗口须先确认用户可被打扰。
2. **禁止强切用户当前活动标签页**：严禁用 `tab <t<N>>` 切走用户正在浏览/看视频的页面（`agent-browser tab <id>` 就是切换/激活标签）。
3. **禁止 `--auto-connect` / `--cdp 9222` 连用户日常 Chrome**（除用户明确要求）：外部 CDP attach 会让 Chrome 弹「有应用正在请求远程控制」，**每次重连都会再弹一次**。
4. **禁止杀 daemon 后重连，禁止一切重建 CDP 连接的形式**（pkill daemon、重开 WS 握手、重新 attach、重启浏览器），尤其禁止写进重试循环——每条新 DevTools 握手都会再弹一次窗，N 次重建 = N 次弹窗轰炸，自动化全废。
5. **禁止 `close --all`；禁止关闭 owner**。普通 `agent-browser close` 只关自己会话的 tab 与 daemon，是合法自清理，无需也不应加 session 参数。
6. **禁止每次执行都 `open` 新标签**（制造孤儿标签，见「通用硬性规则·标签页复用」）。

## 唯一例外：确需操作用户日常 Chrome（有登录态）

```bash
agent-browser --auto-connect <命令>          # 等价：AGENT_BROWSER_CDP=9222 agent-browser <命令>
```

**仅当用户明确要求**操作其**已登录的日常 Chrome** 时才用，AI 不得自行选择此模式。

- **前提**：先确认端口在监听（`lsof -iTCP:9222 -sTCP:LISTEN`）；不在时报告用户，**不要自行重启用户的 Chrome**。
- **防弹窗**：连接建立后 daemon 必须长驻复用；等待用 `AGENT_BROWSER_DEFAULT_TIMEOUT=<ms>` 放宽操作超时、或用 `wait`/`eval` 轮询，**绝不销毁 daemon 重建**；对日常 Chrome 的 CDP 握手失败一次即停（细则见 `references/gemini-web-automation.md`）。
- `/json/version`、`/json/list` 返回 404 属正常（新版 Chrome 对默认 profile 的安全限制），WebSocket 端点可用即连接有效。
- **只是需要登录态时不要 attach 日常 Chrome**：改用独立 profile 并首次登录一次（登录态长期保留在该 profile 目录），避免反复握手弹窗。

## 通用硬性规则

- **标签页复用**：任务前先 `tab list` 查已有标签；同 session 内 `open` 会复用当前标签（实测不堆积），需要多标签时显式 `tab new`，存在匹配标签时用 `tab <id>` 切换复用。
- **后台交互**：后台/headless 标签页触发点击要用完整 Pointer/Mouse 事件序列与真实元素坐标（`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`），配合 `input`/`change` 派发；**严禁靠前置激活窗口来促成事件触发**。
- **profile 隔离**：独立 profile 一律放 `~/.agent-browser/profiles/<用途>`；**禁止读写用户 Chrome 的默认 user-data 目录**。
- **daemon 僵死**：仅确认 daemon 彻底无响应且非网络等待时，才允许**单次** `pkill -f agent-browser-darwin-arm64`；严禁写进任何重试循环。
- **首启竞态**：首次 `open` 后立即取标题可能为空（Chrome 首启慢），重试一次即可。
- **残留 `SingletonLock`**（上一轮崩溃/被杀后报 `Failed to create .../SingletonLock: File exists`）：有两种极具误导性的表象——紧接的 snapshot/eval 全报 `CDP response channel closed`，或 `open` 仍打印标题+URL 造成成功假象。先删该 profile 下 `Singleton*`（或整个 profile）再重开。
- **CLI 三条最高频坑**：`find` 的值位顺序是 `find <locator> <value> [action] --name <名>`（写成 `find role button "缩小" click` 会静默 no-op）；**取 ref 与点 ref 必须分两步**（复合命令里 `$(... | grep -oE '@e[0-9]+')` 常拿到空串）；session 名过长直接失败（socket 路径上限约 103 字节，用短前缀或 `AGENT_BROWSER_SOCKET_DIR`）。更多 CLI 与提权坑见 `references/wrapper-internals.md`。
- **wrapper 不管道化 stdout**（大输出直通，实测 200KB eval 不截断）；仅在识别 `tab_gone` 时收集 stderr。
- **代理**：本机已设 `no_proxy=localhost,127.0.0.1,::1`，直连本机 CDP 端口无需 `--noproxy`。

## 二进制与配置已全局固化

`~/.agent-browser/config.json` 已写入用户级默认 `executablePath`（指向 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），**无需每条命令手写 env**。配置优先级：`config.json` < 项目级 `./agent-browser.json` < 环境变量 < CLI flags。

- 唯一必须纠正的是**二进制**：缺省引擎是自带 Chrome for Testing，而 `AGENT_BROWSER_EXECUTABLE_PATH` 过去要求每条命令手写，漏一次就静默换成 for Testing。其余默认值（headless、临时 profile、空闲回收）本来就是想要的行为，不重复声明。
- daemon 启动参数在首启时固化：某 session 一旦首次以错误二进制启动，后续带 env 复用也不生效，必须 `agent-browser --session <名> close` 后重建。核对实际二进制：`agent-browser session info` 或 `ps aux | grep agent-browser-chrome`。
- 项目确需钉死某版本浏览器时，用项目级 `./agent-browser.json` **覆盖单键**，不要改用户级配置。

## 清理义务（红线级）

**公共层兜底不是豁免理由**，每个调用方都负有清理义务：

1. **每个任务/脚本结束时回收自己的会话**：房客直接 `agent-browser close`；独立实例用 `agent-browser --session <名> close`。跑批脚本必须在 `trap EXIT` 中关闭自身 session。
2. **任务收尾三连检查**：
   ```bash
   agent-browser session list                    # 只应剩当前任务会话
   ps aux | grep -c 'Chrome for Testing'         # 期望 0（无任务）或仅活跃任务数
   agent-browser tab list                        # 当前会话只留 1 个标签
   ```
3. **多轮迭代循环（goal/ralph/逐轮验证）必须每轮结束回收本轮实例**：把 close 攒到任务最后一轮 = 轮间空档全是泄漏窗口（实测某轮 4 个实例因收尾推迟挂了 6 小时，叠加负载把 8 核 16GB 整机压到 load 38、鼠标卡顿）。清理/删除类动作的前置守卫**核验到活进程/活引用时必须中止执行（exit 非零）**，不能打印警告后继续——实测照样 rm，误删了刚启动实例的临时 profile。
4. **产物不落公共目录**：截图/HAR/下载落项目工作区；落到 `~/.agent-browser/tmp/` 的由 reaper 按 7 天 TTL（`AB_TMP_TTL_DAYS`）清理，需保留的当场挪走。
5. **持久 profile 不用了要删**：`~/.agent-browser/profiles/<用途>/`，删除前 tar 备份到 `~/.dsh/backups/`。
6. **会话命名按任务独立**（`--session <名>-$$` 或项目固定名），禁止复用他人/他项目名字（跨项目固定名冲突会让两个任务共用同一实例、标签互抢）。

**孤儿 tab 兜底**：wrapper 在房客模式下**每至多 1h** 派发一次 `~/.agents/bin/ab-reap-tabs.mjs`，只关 `about:blank` 与无对话内容的 Gemini 新对话页（有内容的对话页绝不碰）。手动跑加 `--dry-run`，**别在会话中途裸跑**（不带保护 env 时不保护调用者自己）。

**公共层兜底**：wrapper 每次调用节流派发 `~/.agents/bin/ab-reap-orphans.mjs`（1h 至多一次），收割「sock 在 + daemon 活 + Chrome 用临时 profile」的孤儿，两段式标记 + 最小龄 600s。**手动收割前必须核实无活任务**，`--min-age 0` 不带保护名单曾误杀活跃会话。判据、边界与 2026-10-28 reaper 盲区修复见 `references/orphan-reaper.md`。

**收益基线**：一夜累积 8 组孤儿 ≈112% CPU + 5.2GB 内存；清理后整机 load 15.8→2.4、内存空闲 31%→68%。泄漏不值得，清理不麻烦。

## 受限沙盒下执行（提权）

- 一切 `agent-browser` 调用（含纯查询的 `session info`，也要连 socket）在 `workspace-write` 沙盒内会因 `~/.agent-browser` 不可写被 wrapper **硬失败拦截**（exit 1）。此时对**该条命令**申请 `danger-full-access` 提权执行即可，**不要绕行**（不改启动参数、不重定向目录、不把 `~/.agent-browser` 加进 `extraWritableRoots`——放行会让它在沙盒内误启动、Chrome 因嵌套沙盒起不来）。
- **用户偏好（优先级最高）**：为绕沙盒**不要改动任何启动参数**（业务确有需要的 ARGS，如帧驱动三件套，见 `references/headless-e2e.md`）——凡会 spawn 浏览器的调用一律申请提权；提权后 wrapper 探测到无外层沙盒即保留 Chrome 原生沙盒。daemon socket 位置由首启环境固化，故同一 session 的后续命令都要同环境（提权）执行。
- **反模式（已废弃）**：用目录重定向（`AGENT_BROWSER_SOCKET_DIR` / `--profile` / `HOME`）+ 自动注入 `--no-sandbox` 来绕沙盒——该自动机制已从 wrapper 移除，现行行为就是报错退出提示提权。技术背景仍成立：外层已有沙盒时 Chrome 内层沙盒无法 apply（只加 `--no-sandbox` 即可启动，`--disable-gpu` 非必需），所以正确路径是提权后保留原生沙盒；另注意重定向 `HOME` 对 macOS Chrome 无效（用 `NSHomeDirectory()` 定位配置目录，不读 `HOME`）。目录写权限需求按 `sandbox-adaptation` 走插件配置 `extraWritableRoots`。
- **嵌套陷阱**：`run_code` program 上声明的 `sandbox_permissions` **不会传导给内层 `tools.bash`**；单独给内层传也可能不生效（该参数语义是「对刚被拒的命令做一次性重试」）。可靠路径：顶层 program 拿到提权后，在 program 内用 `node:child_process` 直 spawn wrapper——spawn 时必须显式补全 `HOME`、`PATH`、固定 `DSH_SESSION_ID` 三个 env（缺任一导致 ENOENT / exit 126-127 / session 漂移）。完整对照与验证用 env 见 `references/wrapper-internals.md`。

## 排查速查（症状 → 先查什么）

| 症状 | 先查 |
|---|---|
| Chrome 反复弹「正在请求远程控制」 | 是否有重建连接的代码/循环；立即停手（红线 3、4） |
| 频繁抢焦点、窗口乱跳 | `~/.agents/bin/chrome-guard --check` 是否 exit 0；是否被改成 headed |
| 点 Dock 无反应 / 右键新建窗口无效 | `lsappinfo list` 里 `com.google.Chrome` 是否只剩 `flavor=2`（headless）；跑 `chrome-guard` |
| `agent-browser` 返回 exit 127、每条命令约 20s | `env: node` 解释器问题（wrapper 已改 `process.execPath`，见 `references/wrapper-internals.md`） |
| `CDP response channel closed` | 先排除 profile 残留 `SingletonLock`；再查嵌套沙盒 |
| 标签丢失 / snapshot 全 Unknown ref | session 漂移（无 `DSH_SESSION_ID`，或显式 session 未复用） |
| 进程/标签堆积 | `session list` + `ps`；按「清理义务」自清；`ab-reap-orphans.mjs --dry-run` |
| 后台标签里菜单不渲染、`input[type=file]` 恒为 0 | 该标签必须在**前台**；帧驱动（rAF）问题见 `references/headless-e2e.md` |

## 细节索引（references）

| 文件 | 内容 |
|---|---|
| `references/gemini-web-automation.md` | Gemini 网页自动化：日常 Chrome CDP 拖拽上传与单次握手纪律、模型/思考等级切换、图片上传四坑、提交与读取回答、重渲染复位、多图批量流水线 |
| `references/dock-and-focus-guard.md` | Dock 身份劫持、chrome-guard 设计/判定正则事故、PID 回绕与 `open -n` 修复、验证方法与可迁移教训 |
| `references/wrapper-internals.md` | 复用机制细节与早期误判、close 硬闸/静默注入/二进制固化细节、CLI 细节坑、受限沙盒提权、自研 CDP 管线废止、wrapper exit 127 根因 |
| `references/orphan-reaper.md` | 会话/标签回收完整命令、孤儿 reaper 实现与边界、reaper 盲区修复、清理收益基线 |
| `references/headless-e2e.md` | headless 的 rAF/可见性修复、`eval` 单表达式限制、E2E 脚本 session 命名 |
