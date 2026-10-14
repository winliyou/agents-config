---
name: browser-automation-safety
description: 浏览器自动化安全约定与防弹窗红线（本机）：优先用 agent-browser；全机共用一个浏览器 owner + 每个会话独立房客（2026-10-15 起跨会话可连接且会话间互不影响，已由 wrapper 强制）；有头静默与去自动化痕迹（headed + 窗口屏幕外 + 清 webdriver，不弹前台即不打扰）；浏览器二进制选择、daemon/标签页复用、禁止反复新建连接、禁止抢焦点与强切标签、禁止连用户日常 Chrome。触发：用浏览器自动化前；Chrome「正在请求远程控制」弹窗、弹窗轰炸、反复弹窗、抢焦点、窗口乱跳、标签被切走、进程堆积；打开网页/截图/抓取数据/测试 web 应用/登录站点；Electron 自动化（VS Code、Slack、Discord、Figma、Notion）；Slack 消息；探索性测试、QA、找 bug；需要登录态持久或独立 profile；agent-browser 跑成 Chrome for Testing；怀疑 session 重复新建、daemon 被反复重启。
---

# 浏览器自动化安全（Browser Automation Safety）

**任何浏览器自动化动手前先读本节。** 这是本机约定，与 `agent-browser` 工具自带的 skill（工具用法）互补：那个讲怎么用，这个讲怎么**不打扰用户**。

**工具选择**：一律优先用 `agent-browser` 而非内置网页工具或其他浏览器自动化方案（它是本机已配置、已验证的那套）。工具用法先 `agent-browser skills get core`。

**关键点：本节约定与本机 `~/.agent-browser/config.json` 共同生效——不要绕过配置文件去手写 env。**

## 复用铁律：一个浏览器 owner + 每会话独立房客（2026-10-15 起，已由 wrapper 强制）

**目标同时满足两条**：① 跨会话、跨进程功能连接（登录态全机共享、不反复弹窗、不重复起浏览器）；② 不同会话之间互不影响（谁也顶不掉谁的页面）。

**架构**：`shared` session 降级为**纯浏览器 owner**——只负责持有 Chrome（`profiles/main`、常驻、禁用空闲回收），**永不承载用户命令**。每个 DSH 会话（含冷启动者）一律以 **pinned 房客**身份运行：独立 session 名 + `--cdp <owner 端口>` + `--pin-tab`，且 wrapper **每次调用都重复注入**这两个参数。

**默认路径即正确路径**：直接 `agent-browser <命令>`，wrapper（`~/.agents/bin/agent-browser`，`~/.local/bin` 与 `~/.bun/bin` 两个 symlink 同指）自动完成全部装配，**显式指定一律优先**：

| 角色 | session | profile | 说明 |
|---|---|---|---|
| owner（浏览器） | `shared` | `~/.agent-browser/profiles/main` | 只持有 Chrome；登录态全机持久、跨项目共享（登录一次到处可用） |
| 房客（每次调用） | `dsh-<DSH_SESSION_ID 的 sha256 前 8 位>` | 不注入 | 靠 `--cdp` attach 到 owner，`--pin-tab` 钉住自己的 tab |
| 显式独立实例 | 调用方指定 | `profiles/<名>` | 跑批/隔离用；不受房客逻辑影响 |

socket 与状态落点：`~/.agent-browser/*.sock`；默认目录不可写时 wrapper **直接报错退出**（不重定向 TMPDIR/.workwork），提示提权执行。

**2026-10-15 实测验收**：owner + 3 房客 × 5 轮交错 open/eval **5/5 通过**（每会话恒定看到自己的页面）；3 会话真并发 3/3；12 轮 soak 12/12；跨进程 `localStorage` 互不串；owner Chrome 全程存活（daemon pid 不变）；owner 崩溃 + 脏状态自愈后隔离仍成立；5 次房客 open+close 无标签泄漏。

### 使用约定

- **正常用法就是什么都不加**：`agent-browser <命令>` 即自动成为本会话的房客，天然隔离。**不要**为了"隔离"而手写 `tab new` 或改 session。
- **不要传 `--cdp`**：wrapper 已注入。漏传/自传都会破坏绑定（`--cdp` **不是 sticky**——实测漏传一次该 session 就掉回 owner 并顶掉别人页面）。
- **跑批 / 长会话劣化**：用独立实例 `AGENT_BROWSER_GLOBAL_SESSION=<项目固定名> agent-browser <命令>`（自带 `profiles/<名>`），用完 `agent-browser --session <名> close` 即还。
- **显式 `--session` / `--profile` 一律尊重**（如 fft_cover 的 `--profile auto`），既有项目用法不受影响。
- **任务中途不要重建 owner daemon**（等待用 `--default-timeout` / `wait` / `eval` 轮询，绝不靠 kill 重启；owner 重建会使所有房客绑定失效，wrapper 会清掉它们，但当前任务该重开就重开）。
- 需要退回旧的 shared 单例行为：`AGENT_BROWSER_GUEST_MODE=0`。

### close 硬闸与标签归属（2026-10-15 修订）

**四个冲突源**（全部出自本机取证与上游 README）：

1. 任意会话执行 `close` 且落在 owner = 关掉全机浏览器，所有并发会话一起断；
2. `close --all` 连其他命名 session（跑批独立实例）一起关；
3. 同 session 内 `open` 走 legacy 行为——**导航走该 session 的当前 tab**（上游 README #1530 一节明示）；
4. daemon 空闲 1h 自动回收（上游默认行为）= 窗口无差别消失，与误操作无关。

**wrapper 现行机制**：

- **close 硬闸**：仅拦**显式 `--session shared`** 与 `close --all`（一律），exit 1 并提示正确做法；**房客 `close` 放行**（属合法自清理）。逃生门 `AGENT_BROWSER_ALLOW_CLOSE_SHARED=1`，仅确认无其他会话正在使用时用。
- **空闲回收禁用**：默认注入 `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`（env 名以 README Options 表为准，`_MS` 结尾，勿凭记忆写成 `IDLE_TIMEOUT`）；调用方显式传 `--idle-timeout` 或同名 env 时不覆盖。仅 owner 禁用；房客 daemon 1h 自退、下次按 targetId 重挂。
- **标签与状态不泄漏**（2026-10-15 修复）：close 前先摘掉该会话的 pinned tab，close 成功后再清残留状态文件（`.target`/`.config`）。**判别房客的依据**是该 session 的 daemon 是否 ESTABLISHED 连着 owner 端口——独立实例（自带 Chrome）不摘标签，它的标签随自己的 Chrome 消失。显式 `--session <房客名> close` 同样受此清理（修复前会泄漏标签并留下 `.target`）。

**`tab_gone` 现由 wrapper 自动自愈**（2026-10-15 修复）：自己钉的 tab 被关掉后，上游报
`tab_gone: bound tab is gone (…, last url …)`——**exit 1，只写 stderr，且不会更新 `.target`**（修复前该会话就此永久卡死，后续每条命令都失败）。
wrapper 检测到即按 `.target` 里的 lastUrl 自动重绑并重试一次（恰好一次，不循环），stderr 提示"已自动重绑到 …"；lastUrl 非 http(s)（`data:`/`blob:`）时回退 `about:blank`。仍绝不静默操作别人的 tab。

**wrapper 不管道化 stdout**（大输出直通，实测 200KB eval 不截断）；仅在需要识别 `tab_gone` 时收集 stderr。

**关键机制（2026-10-15 实测，三次推翻后的最终结论）**：

- `--pin-tab` 自上游 **0.34.0**（PR #1589）起提供，按 CDP targetId 持久化 session→tab 绑定并跨 daemon 重启恢复；**本机 0.38.2 已含**（上游 issue #1530 即该机制所修，标题为「会话共享一个 Chrome 时互相劫持 tab」，与「宿主 Chrome 进程被杀」**不是**同一机制——此前 SKILL 里"同源"的说法是误读，已更正）。
- **但 `--cdp` 参数不是 sticky**：实测漏传一次，该 session 立即掉回 owner 的活动 tab（读到别人的页面）。故 wrapper **每次调用都重复注入** `--cdp` + `--pin-tab`。
- **owner session 自身不受 `--pin-tab` 保护**：它的活动 tab 仍跟随全局活动 tab——房客一 `open` 新 tab，owner 再 `eval` 就读到房客的页面（`shared.target` 文件没变，eval 结果已漂移）。**这正是本架构把 owner 定为"不承载用户命令"的原因**。
- 会话名必须对完整 `DSH_SESSION_ID` 取哈希：早期用"末 8 字符"，实测两个不同会话可碰撞到同一 session（`postheal-…aaaa` 与 `soakaaaa-…aaaa` → 都是 `dsh-0000aaaa`），绑定互相覆盖并报 `tab_gone`。
- owner 重新拉起/自愈时，旧房客 daemon 与绑定全部作废，wrapper 会清掉它们（否则下次命令 `tab_gone`）。

**早期误判记录（供追溯，勿再采信）**：曾把「房客 session 启动/执行会杀死宿主 Chrome」归因为 **agent-browser 0.38.2 的 `--cdp` attach 缺陷**。2026-10-15 定位真因：**wrapper 自己的 bug**——房客门禁默认关闭 + 第 1) 段无条件把 session 设回 `shared`，使带 `--cdp` 的命令以 `session=shared` 发出，owner 会话于是去连自己的端口并重启自己。上游 0.38.2→0.39.1 无任何相关修复条目（经 release notes 与 10-commit diff 核对），**升级 0.39.1 对本问题无帮助**。

**「0.0.3.32 垃圾 tab」根因与修复（2026-10-15 凌晨实测，用户屏幕上出现过）**：见到 `http://0.0.3.32/` 这类 0.0.x.x 的 tab，先按「**数字被 Chrome 当整数 IP 解析**」排查（0.0.3.32 = 整数 800，反查：`python3 -c "import ipaddress; print(ipaddress.ip_address(800))"`），不要先怀疑会话恢复。本次真因：wrapper 的 `AGENT_BROWSER_ARGS` 用逗号分隔多个参数，而 `--window-position=-32000,-32000` / `--window-size=1280,800` 的**值本身含逗号**——agent-browser 对 ARGS 按逗号硬拆（README Options 表宣称「comma or newline separated」，0.38.2 换行实测**不生效**），拆出的孤立项（如 `800`）被 Chrome 当位置参数 = 启动 URL → 整数 IP。**每次启动 Chrome 必现一个**，与恢复无关。修复：ARGS 只留无逗号参数，窗口方案改 `--silent-launch`（Chrome 正常有头进程但无窗口，零打扰，UA 正常、webdriver=false、CDP 自动化全部正常，实测通过）——比「屏幕外窗口」更干净。**教训：ARGS 机制传不了含逗号的值；含逗号的 Chrome 参数在此工具上不可用。**

**宿主状态异常时全自动自愈（2026-10-15 凌晨，端到端实测 PASS）**：sock 存在但端口不可发现 = 宿主已坏，wrapper 自愈而非报错——结束异常/已死 daemon 并清状态 → 结束孤儿 Chrome（**严格按 `user-data-dir=…/profiles/main` 匹配，绝不碰日常 Chrome**）并清 Singleton 锁 → 清掉全部失效房客 daemon 与绑定 → 本次调用转宿主重启。跑批（`GLOBAL_SESSION`/显式 `--session`）自动改用同名独立 profile（`profiles/<名>`），不再与宿主共享 main 而撞 SingletonLock。

**已踩坑（同晚实测）**：

- **`--cdp` 漏带 = 波及宿主**：房客命令不带 `--cdp` 时，daemon 状态为 `browserLaunched:false`，会尝试用 main profile spawn 第二个 Chrome → SingletonLock 冲突 → **宿主的 DevToolsActivePort 文件被搞没**（宿主 Chrome 本体存活，已知端口仍可用）。端口兜底发现：`lsof -iTCP -sTCP:LISTEN -nP` 找 Google，再 `ps -o command= -p <pid>` 核对 `user-data-dir=…/profiles/main`。
- **持久 profile 重启会恢复旧 tab**：宿主 Chrome 重启时自动恢复上次会话的 tab 群（实测恢复出一批已死会话的 `http://0.0.3.32/` 残留）。清理 tab **严禁盲关「非当前 tab」**——先甄别归属（活跃会话 vs 恢复残留），只关确属自己或已死会话的。
- **房客 daemon 清理**：普通 `agent-browser close` 会关掉自己的 tab 并退掉自己的 daemon（wrapper 现行行为）；`--session <名> close` 只断连不退 daemon，彻底退出需 `kill <daemon_pid>`（`lsof -p <pid>` 看它打开的 `<名>.sock` 辨认归属）。
- **pin 只保护已有绑定、不重新分配（2026-10-15 实测）**：房客 daemon 一旦绑了别人的 tab（如混用期的旧绑定），pin 反而把它锁死在那个 tab 上。修复：kill 房客 daemon + 删 `~/.agent-browser/<名>.*`，下次命令全新 daemon + pin → 按 README 语义开 fresh tab（受控实验已验证）。
- **宿主也必须 pin（2026-10-15 实测）**：无 pin 的 session 活动表跟随 Chrome 全局活动 tab——房客一开新 tab 宿主就被挪走，两边绑定撞成同一 targetId。wrapper 已给宿主注入 `--pin-tab`；对在跑的旧 daemon 补发一条带 `--pin-tab` 的命令即 sticky 生效。
- **grep 模式以 `-` 开头必须用 `-e` 传**（wrapper 端口发现实测踩坑）：`grep -oE '->...'` 报 `invalid option -- >`，写 `grep -oE -e '->...'`。

### 提权执行（受限沙盒会话中）

- 一切 `agent-browser` 调用（含纯查询的 `session info`——也要连 socket）在 `workspace-write` 沙盒内会因 `~/.agent-browser` 不可写被 wrapper **硬失败拦截**（exit 1，stderr 有明确提示）。此时对该命令申请 `danger-full-access` 即可，不要绕行。
- **嵌套调用陷阱（2026-10-14 实测）**：DSH `run_code` 的 program 上声明 `sandbox_permissions` **不会传导给内层 `tools.bash`**——嵌套工具保留各自策略，必须给每个 `tools.bash` 单独传 `sandbox_permissions` + `justification`。表象：提权 program 里的 bash 调 `ps` 仍报 `Operation not permitted`、wrapper probe 仍失败、socket 落点不对。
- 提权后 `ps -ef` 可用（可核 Chrome 参数与 `--user-data-dir` 落点）；沙盒内 `ps` 静默无输出或被禁，进程取证一律用 `lsof`（`lsof -iTCP -sTCP:LISTEN`、`lsof <socket路径>`、`lsof -c 'Google Chrome'`）。

### 有头静默与去自动化痕迹（2026-10-14 晚用户确认并验收）

**「不影响日常使用」的准确定义：不弹到前台、不抢焦点，不是不能有窗口。** 据此 wrapper 默认（第 3 节，显式 env/flag 一律优先）：

| 注入 | 值 | 效果 |
|---|---|---|
| `AGENT_BROWSER_HEADED` | `1` | 有头模式，UA 恢复正常 Chrome（消 `HeadlessChrome`） |
| `AGENT_BROWSER_ARGS` | `--disable-blink-features=AutomationControlled` | 清 `navigator.webdriver`（**必需**：2026-10-14 实测 headed 且无任何 automation flag 时 webdriver 仍为 true——CDP 调试端口启动本身即置位，不压不行） |
| 同上 | `--silent-launch` | 无窗口静默启动：Chrome 正常有头进程但**不创建窗口**，零打扰（2026-10-15 起；已取代早期「屏幕外窗口」方案——ARGS 按逗号硬拆，含逗号的值传不了，见下「0.0.3.32 垃圾 tab」） |

2026-10-14 实测验收：`navigator.webdriver === false`；UA 为正常 `Chrome/155`；Chrome 参数无 `--headless`、无 `--no-sandbox`；`lsappinfo front` 显示前台非 Chrome；屏幕外窗口 CDP 截图正常。上一版「无痕与无窗口不可兼得」的结论就此作废。

**已知取舍**：`AutomationControlled` 会触发 Chrome 顶部「不受支持的命令行标记」警告条——它只存在于屏幕外窗口上（用户主动捞回窗口才可见），网页 JS 无法检测，bot.sannysoft.com 全绿 + creepjs `0% headless / 0% stealth` 实测通过（2026-10-14 用户看到该警告条后确认保留此方案）。**不要改用 init-script 注入覆盖 webdriver**：JS 原型链篡改可被 creepjs 类 lie 检测抓到，检测面更差。

- **验证前台占用禁止用 `osascript` + System Events**：会卡辅助功能授权弹窗（本身就是打扰，且拖死执行超时）。用 `lsappinfo front` + `lsappinfo info -only name <ASN>`，纯 CLI 无权限问题。
- 改动启动配置（headed/args/profile）后必须重建 owner 才生效：先确认没有其他会话正用着，再 `AGENT_BROWSER_ALLOW_CLOSE_SHARED=1 agent-browser close`（普通 `close` 会被硬闸拦住）。重建 owner 会使所有房客绑定失效，wrapper 会自动清掉它们。

### 沙盒自适应（**历史机制，2026-10-14 晚已从 wrapper 移除**；现行唯一路径 = 提权原生启动，见「复用铁律·提权执行」）

> 本节保留作背景与原理记录：为什么沙盒内 Chrome 起不来、为什么 `--no-sandbox` 曾是必需。**现行 wrapper 已不再重定向目录、不再注入 `--no-sandbox`**——默认目录不可写时直接报错退出提示提权。
>
> **授权说明**：关闭 Chrome 内层沙盒（`--no-sandbox`）属降低子进程隔离等级。本机用户已就 agent-browser/Chrome 场景**明确授权自动化**（「我更需要自动化体验」+ 要求按环境自动判断），故下文的自动注入曾是**已授权行为**；该授权**仅限本场景**，其他工具须另行取得同意（判定规则见 `sandbox-adaptation` skill「降低子进程沙盒的判定规则」）。

**用户偏好（2026-10-14 明确纠正，优先级最高）：启动浏览器尽量不改动任何启动参数——凡会 spawn 浏览器的 agent-browser 调用，一律申请 `danger-full-access` 提权执行：提权后 wrapper 探测到无外层沙盒 → 不注入 `--no-sandbox`、不做目录重定向，socket/profile 落默认位置，Chrome 原生沙盒完整。注意：daemon 的 socket 位置由首启环境固化，故同一 session 的全部后续命令都需同环境（提权）执行。下文「目录重定向 + --no-sandbox 自动注入」仅当提权审批确实不可用时作为 fallback。**

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

**（已废弃，2026-10-14 晚）** 下述重定向行为曾是旧 wrapper 的自动逻辑，现已移除：保留此段仅为解释旧会话在 `TMPDIR/agent-browser-sandbox/` 留下的目录痕迹。**注意该机制的副作用**：所有受限会话被重定向到**同一个** `$TMPDIR/agent-browser-sandbox/chrome-profile`——形式上跨会话「共享」，实为副产品：不持久、且多 session 并发起 Chrome 会争同一 user-data-dir 触发 SingletonLock 冲突（文末 fft_cover 的 SingletonLock 坑很可能根源在此）。现行方案（统一 `profiles/main` + 提权原生启动）正是为消除该副作用。

**若重定向仍不够用 → 直接请求更宽松权限（正当路径，不必纠结）**：对**单条命令**申请 `danger-full-access` 即可，harness 会把请求作为审批呈现给用户。典型场景：
- 必须保留 Chrome 原生沙盒而非 `--no-sandbox`；
- 必须访问**工作区外**的既有 profile（复用已登录态，如 `~/.agent-browser/cnm-gemini`、CNM 的 `cnm-gemini` Chrome profile）；
- 工具路径硬编码、无任何可重定向的配置面。

不要因为"提权要审批"就卡死或放弃功能——**先问再放宽是被鼓励的，「自己悄悄绕开」才是禁止的**。

### Chrome 沙盒按环境自适应（不搞一刀切）

**判定原则：外层已有沙盒 → 关 Chrome 内层沙盒；外层没有沙盒 → 保留 Chrome 原生沙盒。**

**（2026-10-14 起：本 auto 策略保留为安全网，但用户已明确偏好提权原生启动、不改动任何启动参数，见「沙盒自适应」节用户偏好。）**

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
5. **禁止 `close --all`；禁止关闭 owner**：`close --all` 会关掉本机所有 session；显式 `--session shared close` 会关掉全机共享的浏览器 owner。**2026-10-15 起普通 `agent-browser close` 只关你自己会话的 tab 与 daemon（合法自清理），无需也不应加 session 参数**。wrapper 已硬拦上述两者，逃生门 `AGENT_BROWSER_ALLOW_CLOSE_SHARED=1`（见「close 硬闸」）。
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
- **agent-browser daemon 整条路线不可用时的兜底：Node 直连 CDP 一发命中（2026-10-14 实测，dsh-plugins 适配验证）**。当日 daemon 路线三连败：①提权审批无人应答时 client 调用**挂到执行超时而非快速失败**（连挂 3 次，每次烧满 2-3 分钟）；②绕过提权用 `AGENT_BROWSER_HOME`+`AGENT_BROWSER_SOCKET_DIR` 重定向起独立实例（`--no-sandbox` 注入），Chrome **起来又干净退出**（无崩溃报告、`DevToolsActivePort` 已写出、进程消失）；③即便短暂存活，页面也会被导航去第三方站点（同机其他自动化会话的恢复竞态/干扰，fresh profile 也躲不开）。此时别恋战：**自带 Chrome（`--headless=new --remote-debugging-port=0 --no-sandbox --user-data-dir=<mkdtemp 临时目录>`）+ Node 内置 WebSocket** 按 browser WS UUID 直连，`Target.createTarget` → `Target.attachToTarget{flatten:true}` → enable `Page/Runtime/Log`，`Runtime.evaluate` 取 title/innerText、`Runtime.consoleAPICalled`/`Log.entryAdded`/`Runtime.exceptionThrown` 收集报错，结束时 `Browser.close`——单次调用内全流程确定性完成，无 daemon、无跨会话干扰。脚本落盘用完整文件写入，**别在外层模板里嵌 `${label}` 之类插值**（写盘时就被外层吃掉，运行时空匹配还不报错）；表达式拼参用 `JSON.stringify(label)`。

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

- **查前台应用禁用 `osascript` System Events**（2026-10-14 实测）：会触发辅助功能授权并无限卡住（拖到执行超时），授权弹窗本身就是对用户的打扰。用 `lsappinfo front` / `lsappinfo info -only name <ASN>` 替代。

- **session 名过长会直接失败**：socket 路径上限约 103 字节。`--scope worktree --prefix <长前缀>`
  拼出的 `<前缀>-<hash>` 一旦过长即报
  `Session name '...' is too long. Socket path would be 105 bytes (max 103)`，
  且后续命令全部不执行。用短前缀（`--prefix chk1`），或设 `AGENT_BROWSER_SOCKET_DIR` 指向更短路径。
- **lsof 的 COMMAND 列截断为前几个字符**（2026-10-14 实测）：`lsof -iTCP -sTCP:LISTEN | grep -i chrome`
  会**漏检** Google Chrome——COMMAND 列显示的是 `Google`。按端口查（`lsof -iTCP:<port> -sTCP:LISTEN`）
  或 `grep -iE 'google|chrom'`。
- **提权调用无人审批时是挂起不是快速失败**（2026-10-14 实测）：approval policy=ask 且
  用户没点审批时，`danger-full-access` 的调用会**一路挂到执行超时**（连挂 3 次、每次烧满
  2-3 分钟）， stderr 无任何提示。判据：提权调用全部超时而同环境非提权调用正常 → 停止
  反复申请提权，改走免提权替代路径（如上节 Node 直连 CDP）或把等待审批明确告知用户。
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
**对用户日常 Chrome 发起 CDP 握手 = 弹窗风险,失败一次即停（2026-10-14 晚用户严厉纠错）**：
某会话把「WS 连接重试脚本（单次 6 连发）」当探测手段跨多轮反复执行，累计数十次握手，
用户不在场无法点弹窗，回来面对弹窗轰炸。红线细则：
① 连接失败**一次即停**——本轮禁止一切 CDP 尝试，写进交接说明等用户在场处理；
② 重试上限 = 每会话 1 次，且需环境已变化的证据（如 DevToolsActivePort uuid 变更）；
③ 探测 Chrome 状态优先走无副作用通道（读 DevToolsActivePort 文件、lsof），
不发起连接本身；④ 「等恢复再试」永远是伪命题——坑位不释放不会自愈，
唯一出路是用户重启 Chrome 后、在场时执行一次。
**会话级连接预算要机制化（2026-10-14 晚补充验收标准）**：「最多一次连接请求」
不能靠口头纪律，要状态文件硬闸：连接失败写持久标记（如 cdp-state.json result:fail），
后续调用直接拒绝；结果可复用时（文件已存在）优先复用不重发；全流程合并为单命令，
整个进程只握手一次。验证方式：写 fail 标记后调用应被拒绝、无连接产生。
**Chrome 自动化统一单一 profile（2026-10-14 晚用户验收；2026-10-15 起 `profiles/main` 为浏览器 owner 专属，用户命令跑在房客里——见「复用铁律」，fft_cover 的 auto profile 作为显式指定继续有效）**：全部自动化
（截图/e2e/登录态操作）固定用 **一个** profile + 固定 session 名（本项目实例：
/tmp/fft-agent-profile + session auto），每条调用显式带 --session 与 --profile，
缺一个就会落到 wrapper 注入的默认临时 profile（假性数据「丢失」）。位置选 /tmp
而非 home：home 下 Chrome 运行时写入被 DSH 沙盒拒（exit 21，privileged 单命令
只覆盖那一次执行）；/tmp 已实测可写且全机可达，代价是机器重启后 profile 清空
（需重新登录一次）。另：agent-browser eval 结果输出走 stderr，2>/dev/null 会
误判为无输出。清理旧 profile 先 du 盘点并确认无活进程占用（ProcessSingleton）。
