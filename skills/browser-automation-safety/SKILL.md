---
name: browser-automation-safety
description: 浏览器自动化安全约定与防弹窗红线（本机）：优先用 agent-browser；全机共用一个浏览器 owner + 每个会话独立房客（2026-10-15 起跨会话可连接且会话间互不影响，已由 wrapper 强制）；静默运行与去自动化痕迹（默认 headless 绝不抢焦点 + 清 webdriver + 官方 UA 覆盖消 HeadlessChrome）；浏览器二进制选择、daemon/标签页复用、禁止反复新建连接、禁止抢焦点与强切标签、禁止连用户日常 Chrome。触发：用浏览器自动化前；Chrome「正在请求远程控制」弹窗、弹窗轰炸、反复弹窗、抢焦点、窗口乱跳、标签被切走、进程堆积；打开网页/截图/抓取数据/测试 web 应用/登录站点；Electron 自动化（VS Code、Slack、Discord、Figma、Notion）；Slack 消息；探索性测试、QA、找 bug；需要登录态持久或独立 profile；agent-browser 跑成 Chrome for Testing；怀疑 session 重复新建、daemon 被反复重启；**Gemini 网页版自动化**（上传图片/文件失败、点「上传和工具」没反应、input[type=file] 找不到、图片传上去但 Gemini 说没图、读不到 Gemini 回答、标签在后台导致菜单不渲染）。
---

# 浏览器自动化安全（Browser Automation Safety）

**任何浏览器自动化动手前先读本节。** 这是本机约定，与 `agent-browser` 工具自带的 skill（工具用法）互补：那个讲怎么用，这个讲怎么**不打扰用户**。

**工具选择（2026-10-21 用户明确要求 · 硬红线）**：**浏览器自动化与自动化测试必须走 `agent-browser`**，禁止自研脚本/Playwright/CDP 脚本直接 spawn Chrome 二进制。三条理由：
① 只有 wrapper 路径内置 `~/.agents/bin/chrome-guard`——它防止 headless 实例独占 `com.google.Chrome` 的 LaunchServices 身份、导致用户点 Dock 图标/右键新建窗口全部无反应（详见文末「用户日常 Chrome 的 Dock 身份劫持」）；
② 2026-10-20 取证：当天所有劫持用户 Chrome 的 headless 实例**全部来自项目自研脚本**（某前端项目 / 某项目 等），agent-browser 一次都没被用过；
③ wrapper 的解释器 bug 已于 2026-10-21 修复（见文末「wrapper exit 127 修复」），冷启动 1.9s、热路径约 250ms，**不存在"太慢所以绕开"的理由**。
工具用法先 `agent-browser skills get core`。

**存量例外登记（2026-10-27 全库审计）**：两个仓库内 E2E 测试套件仍在用 Playwright（自带 Chromium、headless、未接日常 Chrome）——按本红线属**历史遗留待迁移**，迁移由各项目会话自行安排；**新项目/新套件一律直接用 agent-browser，不得新增 playwright/puppeteer 依赖**。迁移前风险可控的依据：自带 Chromium 与日常 Chrome 的 bundle 身份无关，不触发弹窗与 Dock 劫持；但**不得改用 `channel: "chrome"` 接系统 Chrome**（那会落入本红线管辖）。

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
- **显式 `--session` / `--profile` 一律尊重**（如 某前端项目 的 `--profile auto`），既有项目用法不受影响。
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
- **空闲回收禁用**：默认注入 `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`（env 名以 README Options 表为准，`_MS` 结尾，勿凭记忆写成 `IDLE_TIMEOUT`）；调用方显式传 `--idle-timeout` 或同名 env 时不覆盖。仅 owner 禁用。
  **2026-10-16 重大更正**：房客 daemon 也**不会 1h 自退**——房客走 `--cdp` attach，属上游"user-attached browsers"，**豁免空闲回收**（实测 `manual-*` daemon 存活 3h+ 仍健在）。旧文"房客 daemon 1h 自退、下次按 targetId 重挂"与实现不符，勿再采信。后果：房客的标签只能靠显式 `close`（wrapper 会先摘标签）或下方孤儿 tab 兜底清理回收，别等 daemon 自退。
- **标签与状态不泄漏**（2026-10-15 修复）：close 前先摘掉该会话的 pinned tab，close 成功后再清残留状态文件（`.target`/`.config`）。**判别房客的依据**是该 session 的 daemon 是否 ESTABLISHED 连着 owner 端口——独立实例（自带 Chrome）不摘标签，它的标签随自己的 Chrome 消失。显式 `--session <房客名> close` 同样受此清理（修复前会泄漏标签并留下 `.target`）。
- **孤儿状态文件兜底清理**：房客 daemon 若自行退出（空闲回收、被 kill），不会带走 `.target`/`.config`——实测曾累积 28 组。wrapper 每次调用会清掉"无活跃 socket **且**进程不存活"的会话状态文件；两个条件同时满足才删，active 会话与 owner 不受影响。
- **孤儿 tab 兜底清理（2026-10-16 新增，`~/.agents/bin/ab-reap-tabs.mjs`）**：状态文件清了，**标签却没人关**——这是 2026-10-16 实测"一夜累积 37 个标签（16 个 about:blank）"的根因链：① 无 `DSH_SESSION_ID` 的调用经 wrapper `manual-<ppid%1e6>` 兜底**每次调用都是新会话**（即下方 session 漂移坑；它不只丢 tab 绑定，还会持续新开标签；**2026-10-16 晚已修**：兜底名改为 `manual-<sha256("cwd:"+cwd)[:8]>`，同目录复用同一房客——实测 某前端项目 同目录三条命令只 1 个会话 1 个 daemon。代价——**用户已确认接受（2026-10-16：不需要同一会话内多自动化并发）**：同目录并发时共用一个标签，真出现再显式拆 `--session`）；② 房客 daemon 永不自退（见上条更正）；③ 会话结束无人 `close`；④ 旧兜底只删状态文件不删标签。wrapper 现于**房客模式下每至多 1h**（`~/.agent-browser/.last-tab-reap` 节流）派发一次独立清理进程：**只关 `about:blank` 与无对话内容的 `gemini.google.com/app` 新对话页**，有内容的对话页绝不碰；owner 与调用者会话（经 `AB_REAP_PROTECT_SESSIONS` 传递）受保护。即使误关活会话的标签也无损失——下次调用按 `tab_gone` 自动重绑。**残余风险**：其他并发会话若在新对话页里打了草稿还没发送，草稿会随标签一起没（低概率，已知取舍）。手动跑：`node ~/.agents/bin/ab-reap-tabs.mjs [--dry-run]`——**别在会话中途裸跑**（不带保护 env 时不保护调用者自己，实测关掉过自己的标签）。

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

**「0.0.3.32 垃圾 tab」根因与修复（2026-10-15 凌晨实测，用户屏幕上出现过）**：见到 `http://0.0.3.32/` 这类 0.0.x.x 的 tab，先按「**数字被 Chrome 当整数 IP 解析**」排查（0.0.3.32 = 整数 800，反查：`python3 -c "import ipaddress; print(ipaddress.ip_address(800))"`），不要先怀疑会话恢复。本次真因：wrapper 的 `AGENT_BROWSER_ARGS` 用逗号分隔多个参数，而 `--window-position=-32000,-32000` / `--window-size=1280,800` 的**值本身含逗号**——agent-browser 对 ARGS 按逗号硬拆（README Options 表宣称「comma or newline separated」，0.38.2 换行实测**不生效**），拆出的孤立项（如 `800`）被 Chrome 当位置参数 = 启动 URL → 整数 IP。**每次启动 Chrome 必现一个**，与恢复无关。修复：ARGS 只留无逗号参数。**注意**：当时「改用 `--silent-launch` 实现无窗口」的结论已被推翻（该参数不存在、被静默忽略，见「静默运行」节），正确解法是默认 headless。**教训：ARGS 机制传不了含逗号的值；含逗号的 Chrome 参数在此工具上不可用。**

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
- **tools.bash 单独传 sandbox_permissions 也可能不生效（2026-10-15 补充实测）**：即便给内层 `tools.bash` 传了 `danger-full-access`，其子进程仍跑在受限沙盒里（wrapper probe 仍报不可写）——该参数语义是「对刚被拒的命令做一次性重试」，无在先拒绝记录时不触发提权。**可靠路径：顶层 program 拿到提权后，在 program 内用 `node:child_process` 直 spawn wrapper**，子进程继承 program 的宽松沙盒。
- **run_code 直 spawn 的环境三坑（2026-10-15 实测）**：DSH run_code 进程的 env 不能直接用，spawn 时必须显式补全，否则三个独立失败：
  ① `HOME` 为 **undefined** → wrapper `REAL = HOME + "/.bun/install/global/..."` 拼出 `/.bun/...` ENOENT；
  ② `PATH` 残缺（缺 `/usr/bin:/bin:/usr/sbin:/sbin`）→ wrapper 依赖的 `lsof`/`pgrep`/`pkill`、bun/node 解释器、ohpm 脚本依赖的 `sed`/`dirname`/`uname` 全部 ENOENT（表象：莫名 exit 126/127 与 "command not found"，极易误判为工具坏了）；
  ③ 无 `DSH_SESSION_ID` → wrapper 房客名退化为 `manual-<ppid%1e6>`，而 run_code 每次调用的 pid 不同 → **每条命令都是新房客**，看不到自己上一条钉的 tab（表象：open 成功后下一条 get url 变 about:blank、snapshot ref 全部 Unknown ref——像"tab 丢失"，实为 session 漂移）。修法：env 显式传**固定** `DSH_SESSION_ID`。
  **2026-10-16 已修**：兜底名改为 `manual-<sha256("cwd:"+cwd)[:8]>`（对调用方工作目录稳定），同目录的调用复用同一房客、同一标签，不再每命令漂移；跨项目目录依旧隔离。
  **取舍已由用户确认（2026-10-16）**：不需要"同一会话内多自动化并发"——同目录调用共用一个会话/一个标签、**顺序复用**即为预期行为，不要当 bug 修，也不要为此加并发拆分。排查共用（仅在怀疑时）：`lsof ~/.agent-browser/<会话名>.sock`，调用方进程数 >1（除 daemon 自己）才说明存在共用——2026-10-16 检查 7 个存活会话均为 1，无共用。真出现并发共用时，再给相关调用显式拆 `--session`。
  验证可用的 spawn env：`{ ...process.env, HOME: "$HOME", DSH_SESSION_ID: "<项目固定名>", PATH: "/Applications/DevEco-Studio.app/Contents/tools/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }`。

### 静默运行：默认 headless，绝不抢用户焦点（2026-10-15 重写）

**「不影响日常使用」的硬标准：不抢前台焦点。** 用户 2026-10-15 直接报告「操作浏览器时把我的焦点抢走，我干什么都会被切到自动化窗口」——根因是当时默认 headed。

**实测结论（前台用 `lsappinfo front` 判定 ASN，独立实例受控对照）**：

| 模式 | 抢焦点? | 说明 |
|---|---|---|
| **headless（现行默认）** | **否** | 前台 ASN 全程不变；tab new / open / eval / screenshot 全流程零打扰 |
| headed | **是** | **一启动就抢走焦点**；窗口移屏外（`--window-position=-32000,-32000`）、`--start-minimized`、启动后 CDP `Browser.setWindowBounds` 搬走窗口，**全都不能避免**——焦点在启动瞬间已丢 |

**`--silent-launch` 是无效参数（2026-10-15 更正）**：grep agent-browser 二进制 0 命中，它**不是** Chrome 也不是 agent-browser 的参数，被静默忽略——窗口照常创建并抢焦点。此前「有头 + silent-launch = 无窗口零打扰」的验收结论**不成立，已作废**；那是屏幕外窗口/未目视确认造成的误判。

**wrapper 现行默认**（显式 env/flag 一律优先）：

| 注入 | 值 | 作用 |
|---|---|---|
| ~~`AGENT_BROWSER_HEADED`~~ | **不再注入** | 默认走 headless —— 唯一不抢焦点的模式 |
| `AGENT_BROWSER_ARGS` | `--disable-blink-features=AutomationControlled` | 清 `navigator.webdriver`（headless 下同样有效，实测 `true`→`false`） |
| `AGENT_BROWSER_USER_AGENT` | 正常 Chrome UA | 消 `HeadlessChrome` 指纹（**必须用官方这个键**；塞进 `AGENT_BROWSER_ARGS` 无效） |

2026-10-15 实测：主进程 `--headless=new`；`navigator.userAgent` 为正常 `Chrome/155`；`navigator.webdriver === false`；`platform=MacIntel`、`plugins=5`、`languages=[zh-CN,zh]`；screenshot 正常；连续多轮 `tab new`/`open`/`eval`/`screenshot` 后 `lsappinfo front` 始终是 Firefox（用户在用的应用），**零切换**。

**已知取舍**：headless 下真实浏览器可能识别无头特征（creepjs 类检测）；有 GUI 需求的站点（WebRTC 设备、部分 WebGPU 截图）在 headless 受限。**需要真窗口时**由调用方显式 `AGENT_BROWSER_HEADED=1`——但那会抢焦点，须先确认用户可被打扰。**不要**用 init-script 篡改 `navigator.webdriver`（可被 creepjs 类 lie 检测抓到）。

- **验证前台占用禁止用 `osascript` + System Events**：会卡辅助功能授权弹窗（本身就是打扰，且拖死执行超时）。用 `lsappinfo front` + `lsappinfo info -only name <ASN>`，纯 CLI 无权限问题。
- **2026-10-22 重要补充：抢焦点还有第二个源头 —— `chrome-guard` 误判后对已运行的 Chrome 执行 `open`。** headless 本身不抢焦点（上面已验证），但 wrapper 每次调用前跑的 Dock 守卫若判定失效，就会 `open -g -a "Google Chrome"`；`open` 对**已运行**的 app 等于激活窗口，实测 2.1s 后把前台从用户正在用的应用切到 Chrome。判定正则已于 2026-10-22 修复，详见「抢焦点事故：chrome-guard 判定正则失效」节。排查「频繁抢焦点」时**先查这条**（`~/.agents/bin/chrome-guard --check` 应为 exit 0），不要只看 headed/headless。
- **daemon 启动参数在首启时固化**：改了 headed/args/profile 后**必须重建 owner 才生效**——否则旧 daemon 会一直用旧配置跑（本次抢焦点问题在重建前一直存在）。重建前确认没有其他会话正用着，用 `AGENT_BROWSER_ALLOW_CLOSE_SHARED=1 agent-browser close`（普通 `close` 会被硬闸拦）；重建会使所有房客绑定失效，wrapper 会自动清掉它们。**重建会关掉当前所有标签**，动手前先看 `tab list` 并告知用户。

### 沙盒自适应（**历史机制，2026-10-14 晚已从 wrapper 移除**；现行唯一路径 = 提权原生启动，见「复用铁律·提权执行」）

> 本节保留作背景与原理记录：为什么沙盒内 Chrome 起不来、为什么 `--no-sandbox` 曾是必需。**现行 wrapper 已不再重定向目录、不再注入 `--no-sandbox`**——默认目录不可写时直接报错退出提示提权。
>
> **授权说明**：关闭 Chrome 内层沙盒（`--no-sandbox`）属降低子进程隔离等级。本机用户已就 agent-browser/Chrome 场景**明确授权自动化**（「我更需要自动化体验」+ 要求按环境自动判断），故下文的自动注入曾是**已授权行为**；该授权**仅限本场景**，其他工具须另行取得同意（判定规则见 `sandbox-adaptation` skill「降低子进程沙盒的判定规则」）。

**用户偏好（2026-10-14 明确纠正，优先级最高）：启动浏览器尽量不改动任何启动参数——凡会 spawn 浏览器的 agent-browser 调用，一律申请 `danger-full-access` 提权执行：提权后 wrapper 探测到无外层沙盒 → 不注入 `--no-sandbox`、不做目录重定向，socket/profile 落默认位置，Chrome 原生沙盒完整。注意：daemon 的 socket 位置由首启环境固化，故同一 session 的全部后续命令都需同环境（提权）执行。下文「目录重定向 + --no-sandbox 自动注入」仅当提权审批确实不可用时作为 fallback。**

DSH 的 `workspace-write` 沙盒只允许写会话工作区，会让 agent-browser **两级失败**（2026-09-25 实测）：

1. socket 目录 `~/.agent-browser` 不可写 → daemon 起不来
   （`Socket directory '$HOME/.agent-browser' is not writable`）；
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

**（已废弃，2026-10-14 晚）** 下述重定向行为曾是旧 wrapper 的自动逻辑，现已移除：保留此段仅为解释旧会话在 `TMPDIR/agent-browser-sandbox/` 留下的目录痕迹。**注意该机制的副作用**：所有受限会话被重定向到**同一个** `$TMPDIR/agent-browser-sandbox/chrome-profile`——形式上跨会话「共享」，实为副产品：不持久、且多 session 并发起 Chrome 会争同一 user-data-dir 触发 SingletonLock 冲突（文末 某前端项目 的 SingletonLock 坑很可能根源在此）。现行方案（统一 `profiles/main` + 提权原生启动）正是为消除该副作用。

**若重定向仍不够用 → 直接请求更宽松权限（正当路径，不必纠结）**：对**单条命令**申请 `danger-full-access` 即可，harness 会把请求作为审批呈现给用户。典型场景：
- 必须保留 Chrome 原生沙盒而非 `--no-sandbox`；
- 必须访问**工作区外**的既有 profile（复用已登录态，如 `~/.agent-browser/<项目>-<用途>` 这类按项目命名的 Chrome profile）；
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

实测确认**重定向 HOME 无效**：macOS Chrome 用 `NSHomeDirectory()` 定位配置目录，**不读 `HOME` 环境变量**（`HOME=/tmp/x` 后仍去写 `$HOME/Library/...`）。同理 `--crash-dumps-dir` / `--disable-gpu-sandbox` / `--no-zygote` 都不能替代 `--no-sandbox`。

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

1. **禁止抢焦点 / 置顶窗口**：不得调用任何 OS 级窗口激活（如 AppleScript `activate`、`open -a` 对已运行应用）或置顶行为，不得打断用户的键鼠输入。**注意 `open -g` 不等于安全**：它只让冷启动不进前台，对已运行的 app 仍会激活窗口（2026-10-22 实测）。
   **默认 headless 就是为守住这条**：headed 会在启动瞬间抢走焦点（窗口移屏外/最小化都无效）。**禁止把默认改回 headed**；确需真窗口要先确认用户可被打扰。
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
  辨别特征极具误导性：`open` 可能仍打印「✓ 页面标题 + URL」造成成功假象，但紧接的 snapshot/eval 全报 `CDP response channel closed`——**先删该 profile 下的 `Singleton*`（或整个 profile 目录）再重开**，清锁后再排查别的。两会话独立实测确认（本机双会话，2026-09-25）。
- **代理**：本机已设 `no_proxy=localhost,127.0.0.1,::1`，直连本机 CDP 端口无需 `--noproxy`（历史提示已过时）。

### 自研 CDP 管线：已全部废止（2026-10-21）

**2026-10-21 用户明确要求后，已实测验证并删除全部自研管线**：不再允许自行 spawn Chrome、不管理 CDP 端口/daemon/profile。

**验证依据（逐像素对比，非估算）**：

| 场景 | 旧自研管线做法 | agent-browser 替代做法 | 结果 |
|---|---|---|---|
| HTML mockup → PNG（桌面 1440×900） | spawn headless + CDP `Page.captureScreenshot` | `open <file://>` + `set viewport 1440 900` + `screenshot` | **逐像素一致（0 处差异）** |
| HTML mockup → PNG（移动 411×891，需 `mobile:true`） | CDP `Emulation.setDeviceMetricsOverride` | CLI 无等价参数（`set viewport` 会覆盖 `set device`）→ 用 agent-browser 的 `get cdp-url` + 一条 CDP 命令 | **逐像素一致（0 处差异）** |

**移动端正确做法**（唯一需要补 CDP 的场景）：

```bash
agent-browser open "file:///path/to/page.html"
CDP=$(agent-browser get cdp-url | tail -1)
# 通过该端点：Target.getTargets → 按 URL 选 page → attachToTarget(flatten) →
#   Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor:1, mobile: width<700}
#   → Page.captureScreenshot（不要用 agent-browser screenshot，它会重置 emulation）
```

**注意**：浏览器生命周期、owner、标签、登录态仍全部由 agent-browser 管理；这条 CDP 只是补一条 CLI 缺失的模拟参数，**不属于自研管线**（不 spawn、不管端口、不管 daemon、不进 profile）。

**已删除清单**（备份在 `~/.dsh/backups/selfmade-pipelines-20261021-002707/`）：`某前端项目/.workwork/cpu-r12/*.mjs`（5 个 CPU 探针）、`ui-audit/auto-chrome.sh`（常驻 headless 启动器）、`ui-r12/shot-html.mjs`（HTML→PNG）、`某项目/.workwork/gemini-gen/<项目>-gemini-profile-chrome.plist`（LaunchAgent）；同时停掉 9421/9333/9441/9223 常驻端口、清理 `~/.agent-browser/profiles/{auto,fixg1,isoProbe,myBatch,probe-g1,probe-g2}`。

## 脚本化使用时（冒烟测试 / CI）

写脚本驱动浏览器时，**session 名必须稳定**，否则每次运行都新建浏览器：

```js
// ✗ 错误：process.pid 每次不同 → 每次新 session、新浏览器实例
const SESSION = `smoke-${process.pid}`;
// ✓ 正确：按项目/用途固定名字，反复运行复用同一实例
const SESSION = 'myapp-smoke';
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
- **残留 SingletonLock 导致 Chrome 起不来（2026-10-01 实测，某前端项目 迁入）**：表象
  `Chrome exited early (exit code: 21) without writing DevToolsActivePort` + stderr
  `Failed to create .../chrome-profile/SingletonLock: File exists`——根因是上次会话的
  Chrome 临时 profile 残留了 SingletonLock（symlink），与 `--no-sandbox` 无关，
  不要被同行的 Crashpad `settings.dat: Operation not permitted` 噪音带偏。解法：
  按报错原文里的 profile 路径 `rm -f <profile>/SingletonLock` 后重试（删除前先 `ls`
  确认目录确属 agent-browser 临时 profile）；无需重建 daemon/session。
- **长会话劣化：同一 session 反复导航/重载后 eval 陆续返回 null（2026-10-13 实测，
  某前端项目 e2e 冒烟）**：表现为最初可用的 eval 在若干次 reload 后开始返回空/null，
  清 SW/缓存、重开标签只能临时恢复。解法：**跑批类任务用全新 session，跑完即关**
  （`--session <新名>` + close），不要复用跨多轮的老会话；结合上面「session 名必须
  稳定」的规则，这个新名应是项目固定的冒烟专用名，每次运行前先 close 旧实例。

## 用户日常 Chrome 上的 AI 网页自动化（Gemini 等，2026-10-14 实测 某前端项目）

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
**Chrome 自动化统一单一 profile（2026-10-14 晚用户验收；2026-10-15 起 `profiles/main` 为浏览器 owner 专属，用户命令跑在房客里——见「复用铁律」，某前端项目 的 auto profile 作为显式指定继续有效）**：全部自动化
（截图/e2e/登录态操作）固定用 **一个** profile + 固定 session 名（本项目实例：
/tmp/<项目>-agent-profile + session auto），每条调用显式带 --session 与 --profile，
缺一个就会落到 wrapper 注入的默认临时 profile（假性数据「丢失」）。位置选 /tmp
而非 home：home 下 Chrome 运行时写入被 DSH 沙盒拒（exit 21，privileged 单命令
只覆盖那一次执行）；/tmp 已实测可写且全机可达，代价是机器重启后 profile 清空
（需重新登录一次）。另：agent-browser eval 结果输出走 stderr，2>/dev/null 会
误判为无输出。清理旧 profile 先 du 盘点并确认无活进程占用（ProcessSingleton）。
## Gemini 网页常规自动化（默认 headless owner，2026-10-15 实测）

与上一节的差别：**不需要直连用户日常 Chrome** —— 走 wrapper 默认房客（owner = `profiles/main` headless，登录态已持久），全程零弹窗、零抢焦点。本节所有结论均在本机实测复现。

**开箱可用脚本**：`.workwork/gemini-upload/gemini-image-ask.sh`（示例副本，可自行复制到别处；同目录 `README.md` 有完整排障笔记）。用法
`./gemini-image-ask.sh -f <图片绝对路径> -p "<提示词>" [-o 输出目录] [-n 在当前对话继续]`。
它已内置本节全部坑的规避与重试：可见性置前、CSS 选择器点击、菜单内注入、`naturalWidth` 校验、`textContent` + 停止按钮 + 长度稳定的三重完成判据。2026-10-15 实测端到端多轮成功（含"用户给的终端截图"识别为 Homebrew 阿里云镜像配置这类真实判据；单轮约 28-35 秒）。

**独立验证结论（2026-10-15，另一 agent 在独立 `AGENT_BROWSER_GLOBAL_SESSION` 实例上复测）**：端到端 **7/7 成功**（跨两个脚本版本各 3 次 + 1 次"先把标签强制切后台再启动"的自愈测试）。反例也全部如实失败：不点菜单直接 `upload` → `Element not found`；用错 `accept` 选择器 → 同上；传相对路径 → 命令报 `✓ Done` 但 `att=0, has-error=1`（**证实"不能信 upload 的 ✓ Done"**）。该 agent 还用 CDP `Target.activateTarget` 做了受控对照，**实测 rAF 节流：前台 91-93 次/1.2s → 后台恒 1 次/1.2s（约 90 倍）**，后台 5/5 轮 `inputs` 恒为 0（即便 `aria-expanded=true`）——本节坑 0 的机制得到独立确证。

**对坑 0 的一处措辞修正**（验证者实测）：后台标签时 `[role=menu]` **并非**完全不生成，实测菜单元素能出现，只是**里面不含 `input[type=file]`**。"input 恒为 0"是硬事实，"菜单 DOM 完全不生成"说得太满。

### 模型 + 思考等级切换（选择器一览）

| 目标 | 选择器 / 判定 |
|---|---|
| 当前模型按钮 | `.picker-primary-text`（取 `[0]`）→ `closest('button')`，取值看其 `aria-label`「打开模式选择器，当前模式为"X"」 |
| 模式菜单 | 点上面这个 button → `.cdk-overlay-pane [role=menu]` |
| 模型项 | `gem-menu-item` / `[role=menuitem]`，文本形如 `4 Argon` + 换行 + `复杂任务`；**用行首精确匹配**，别用 `includes`——菜单里同时有 Pro / Flash-Lite |
| 思考等级 | 菜单里文本为「思考等级」的 `gem-menu-item` → 点开是**二级** `.cdk-overlay-pane`（取 `panes[panes.length-1]`） |
| 三档 | 「低点 + 快速高效」「中等 + 深度适中」「**高点 + 超级详尽**」（"高思考" = 高点）；选中态是 `class` 含 `selected`，**不是** `aria-checked`（实测恒为 null，别用它判断） |

**验证方式（必做）**：切完后读 `aria-label`，必须变成「当前模式为"Argon 高点"」。

### 图片上传：四个致命坑（2026-10-15 二次实测，脚本 `.workwork/gemini-upload/gemini-image-ask.sh`）

**0. 目标标签必须在【前台】——这是最难定位的一个（2026-10-15 实测定位）**

Chrome 对**后台标签**节流 `requestAnimationFrame`。Gemini 的 Angular CDK 菜单在后台标签里**不渲染菜单内容**：点击「上传和工具」后按钮的 `aria-expanded` **已经变成 `"true"`**（所以看 expanded 会误判成"菜单已开"），但菜单 DOM 不生成、`input[type=file]` 数量**恒为 0**，`upload` 一直报 `Element not found`。


- 实测数据：`document.visibilityState === 'hidden'` 时连点 5 轮，仅约 3 轮 `aria-expanded=true`，且 `inputs` 恒为 0；
- `agent-browser tab <该标签的 tabId>` 把它切到前台（`visibilityState === 'visible'`）后，**同一次点击立刻拿到 `inputs=3`**。
- **判据**：动手前先读 `document.visibilityState`；是 `hidden` 就先切到该标签。切完**必须复查**，共享 Chrome 里别的会话可能在同一瞬间又把标签切走，必要时重试一次。
- **怎么定位"我自己的那个标签"——两个弯路都别走**（2026-10-15 实测）：
  | 方法 | 结果 |
  |---|---|
  | 按 URL 找 | ✗ 页面上常有多个 `https://gemini.google.com/app`（重开对话不改 URL），会选错 |
  | `document.title` 打标记再按 title 找 | ✗ Gemini 是 SPA，立刻把 title 改回会话名；且 `tab list` 的 title 有缓存，刚设的标记常读不到 |
  | **`agent-browser tab`（无参）输出里带 `→` 的那行** | ✓ **正解**：`agent-browser tab 2>/dev/null \| grep -- "→" \| grep -oE "t[0-9]+" \| head -1` 拿到本会话 pinned 的 `t<N>`，再 `agent-browser tab <t<N>>` 激活 |
  | 兜底：本会话 `.target` 文件里的 `targetId` | ✓ `~/.agent-browser/${session}.target` 的 `targetId` 也可直接喂给 `tab` |

1. **`input[type=file]` 只在「上传和工具」菜单打开时才存在于 DOM**。菜单关闭时 `querySelectorAll('input[type=file]')` 返回 `[]`，`upload` 直接报 `Element not found`。
   正确顺序：点 `[aria-label="上传和工具"]`（即 composer 左侧的 `+`）→ sleep 2~3s → **立即** `upload 'input[type=file][accept="image/*"]' <path>`（菜单里有 2~3 个 file input，必须带 `accept="image/*"` 区分）。
   > 曾经"成功"过一次纯属巧合：那次恰好是同一段菜单会话未关闭。

2. **必须传绝对路径**。传相对路径时 `upload` **返回 `✓ Done` 但 Chromium 静默拒绝**——附件立刻带 `has-error`，且**网络面板里根本没有上传请求**（不是网络问题！）。本次对照实验：同一个小 PNG，相对路径 8 次全失败、绝对路径一次成功。

3. **不要用 `find role ... --name` 点这个按钮——它会静默失败**。`agent-browser find role button click --name "上传和工具"` 实测 **exit 0、无任何输出、菜单也不展开**，看起来像"点过了"。用 CSS 选择器 `agent-browser click 'button[aria-label="上传和工具"]'` 才稳定命中（2026-10-15 实测，两种写法各跑多轮对照）。

**不要试图用合成的 DragEvent/DataTransfer 伪造拖放**（2026-10-15 实测不可行）：`xap-uploader-dropzone` 在菜单关闭时**根本不在 DOM 里**（实测数量 = 0），`drop` 事件无处可投，dispatch 后附件数仍为 0。真实文件拖拽只有走 `Input.dispatchDragEvent` + `files:[绝对路径]`（见上一节）才成立。

**成功判据（别信 chips 数量）**：

| 状态 | 信号 |
|---|---|
| 失败 | `uploader-file-preview-container` 带 `has-error`；内部是 `gem-attachment-loading-error`；无 `gem-media-attachment` |
| 成功 | `has-error` 消失；出现 `gem-media-attachment`；`gem-media-attachment img` 有 `src`（blob: 缩略图）且 **`naturalWidth > 0`** |

**截图必须传绝对路径（2026-10-15 实测）**：`agent-browser screenshot "$OUTDIR/answer.png"` 传相对路径会**静默失败**——截图相对 daemon 的工作目录解析，不在你的 cwd。实测 `-o ./.out` 只落了 `answer.json`、没有 png。先 `ABS_OUT="$(cd "$OUTDIR" && pwd)"` 再传绝对路径，并检查文件确实存在（别被 `|| true` 吞掉错误）。

**推荐的机器可判定口径（2026-10-15 实测，脚本已内置）**：
```bash
# 附件计数（判"是否注入成功"）
agent-browser eval 'document.querySelectorAll("gem-media-attachment").length'
# 最强判据：确实是有效图片预览，且尺寸与源图一致
agent-browser eval 'var i=document.querySelector("gem-media-attachment img"); i&&i.naturalWidth>0?("ok:"+i.naturalWidth+"x"+i.naturalHeight):"bad"'
```
后者会返回 `ok:1172x876` 这样的结果，可直接与源图尺寸比对——比数 chips 数量可靠得多。

上传成功的网络链路（用于排障对照）：`OPTIONS/POST push.clients6.google.com/upload/` → `POST .../ProcessFile`，均 200。**若这两条一个都没有，就是本地阶段被拒（路径问题），不是网络问题。**

### 提交与读取回答

- **发送必须用真实点击** `agent-browser click '[aria-label="发送"]'`。`eval "button.click()"` 会返回 sent 但消息**发不出去**（输入框文本原样残留）；`press Enter` 同样无效。发送成功的判据：`.ql-editor` 变空、`[aria-label*=停止]` 出现、附件 chip 消失。
- **真实点击超时时，CDP 直发 `Input.dispatchKeyEvent` 回车是可靠兜底（2026-10-15 某媒体项目 UI 审查实测）**：与上条不矛盾——`press Enter`（经 agent-browser 键入）无效，但经 browser 端 WS 直发 `{type:keyDown/keyUp, key:Enter, code:Enter, windowsVirtualKeyCode:13}` 是 trusted 输入，编辑器有焦点时 Gemini composer 收到即发送。`Input.dispatchMouseEvent` 找不到元素/超时时用它接管。
- **大文本 `Input.insertText` 超时 ≠ 插入失败（同日实测，28.6K 中文字符 + 代码块）**：CDP 调用 30s 超时抛错，但重连后读 `.ql-editor` 的 `textContent.length` 与头尾内容，确认**文本已全部插入**（渲染进程忙于处理大文本，响应没赶回来）。**先查状态再决定是否重试**——盲目重发会让输入内容翻倍。
- **渲染器迟缓是连锁的（同日实测）**：insertText 超时后紧接着 `Input.dispatchMouseEvent` 也超时（同一渲染进程忙）。此时轻量 `Runtime.evaluate`（20s 超时）始终可用，判障/读状态/兜底发送全走它；`dispatchMouseEvent` 只留给必须真实指针的场景（开菜单、选模型）。后台 gradle 构建抢 CPU 会显著加剧迟缓，审查流水线别与其并发。
- **大 prompt 整份插入会被重复执行（2026-10-16 某媒体项目 UI 审查实测，接上条的反面）**：46KB 单次 `agent-browser keyboard inserttext` 后，`.ql-editor` 里出现 **4 份完全相同**文本（textContent 长度 161,772 ≈ 4×41K 字符）——即这次调用被重试，而**每次都已写入成功**，与上条"超时≠失败"是同一机制的另一面。规避：**先精简再发**（同一份内容改发"增量 diff"版 5.8KB，单份通过、秒级完成）；必须发大文本时**分段插入**，每段后 eval 统计目标串出现次数与总长度，发现多份就重载页面（`open` 同一 URL 会清空 composer 但保留线程）重来。
- 回答容器：`model-response`（或 `[class*=model-response]`）。轮询其长度，`[aria-label*=停止]` 消失即完成（Argon 高点实测 <1 分钟）。
- **完成判据不能只看"长度 > N"（2026-10-15 实测踩坑）**：写死 `length > 20` 会让**短回答**白等满全部轮次——实测 Gemini 答"主色调为深绿色和亮绿色。"（13 字符）、"深绿色"（3 字符）、"有"（1 字符）都是正常完整回答。正确判据是三条件并列：① 长度 > 0；② 页面上没有"停止"按钮（`[aria-label*=停止],[aria-label*=Stop]` 计数为 0 = 生成已结束）；③ 长度连续 2 次不变。修正后同场景耗时由 4 分钟降到 28 秒。
- **必须读 `textContent`，不要读 `innerText`（2026-10-15 实测更正）**：无头浏览器里后台标签的 `innerText` **返回空**——实测 `model-response` 的 `innerText.length` 只有 8（就是 "Gemini 说" 这几个字），而 `textContent.length` 有 513。用 innerText 轮询会**永远判不出回答已生成**，误以为"Gemini 没回答"。此前的"轮询 innerText.length"结论只在前台标签成立。
- **取正文要剥离"非正文"节点，别只删 `img`**（2026-10-15 二次定位）：污染源其实是回答末尾的**引用来源卡片** `<sources-carousel-inline><source-inline-chip><span class="source-title">PNG</span><span class="source-count">+ 2</span>`，拼进正文后是 `…位于画面的中上方。   PNG+ 2`——**看着像图片 alt，实际是来源标签**（第一次排查被它带偏过）。稳妥的 `cloneNode(true)` 后剔除列表：
  `img,svg,source,picture,sources-carousel-inline,sources-list,source-footnote,source-inline-chip,response-actions,message-actions,gem-icon-button,mat-icon,thinking-overlay`
- `eval` 返回**对象**时 agent-browser 自己就会输出 JSON（`agent-browser eval '({a:1})'` → `{\n "a": 1\n}`）。**不要再套一层 `JSON.stringify`**，否则落盘文件里是"字符串里再套一层 JSON"，`json.load` 后得到 `str` 而非 `dict`。要拿裸值就直接返回对象；用 `JSON.stringify` 时记住需要二次解析。

### 重渲染会复位状态（务必每步复查）

**刷新或 Angular 重渲染后，思考等级被重置为「低点」、模型可能变回 Pro** —— 本次刷新页面后 `aria-label` 从 Argon 高点 退回 Argon。**上传完图片、发送前，必须重新读 `aria-label` 确认模型与思考等级**，否则白跑。

### 与上一节的取舍

| | 本机默认 owner（headless，本节） | 用户日常 Chrome 直连 CDP（上一节） |
|---|---|---|
| 弹窗风险 | 无 | 有，失败一次即停 |
| 登录态 | `profiles/main` 已持久 | 用户正在用的登录态 |
| 干扰用户 | 零（headless） | 会抢焦点/切标签 |
| 结论 | **默认选这个**；仅当 owner profile 无登录态且用户明确要求时，才走上一节 |

### 多图批量审查流水线补充（2026-10-16 UI 审查实测，8 批 43 图全通过）

- **headless owner 的 tab 必须先设视口**：CDP `Emulation.setDeviceMetricsOverride {width:1440,height:900}` 之后，composer 的「上传和工具」「模式选择器」按钮才会渲染；未设视口时三者全部查不到（modeBtn/uploadBtn/sendBtn 全为 none，脚本报 NO_UPLOAD_BTN）。Gemini 默认窗口下布局塌缩，编辑器虽在但按钮区缺失。
- **`/app` 打开常停在边栏视图**：`.ql-editor` 存在但 composer 不完整。自愈逻辑：探测 modeBtn/uploadBtn 任一缺失 → 真实点击「发起新对话」（aria-label/文本精确匹配）→ 等 8s 再探测。
- **附件缩略图就绪 ≠ 服务端处理完成**：`gem-media-attachment img.naturalWidth>0` 后立刻发送，偶发实际发出的是纯文本（回答「我是一个文本 AI，这超出了我的能力范围。」约 21 字符）。发送前额外 sleep 6s，并校验 `gem-media-attachment` 数量 === 图片数。
- **回答长度 <50 字符 = 附件未带上的强信号**，直接整轮重试（新对话）而不是继续等。
- **模型守卫实测**：Argon 配额耗尽时，菜单切回 Argon 多次尝试均失败（自动回退 Flash-Lite）——接受 Flash-Lite 可正常完成多图 UI 审查（本日 8 批全部产出有效审查，单批 1-6 图、回答 2-5.5K 字符）。
- 连续开多个新对话 tab 无弹窗问题（owner 独立 headless），但偶发菜单 file input 不渲染（rAF 节流）——直接整轮重试即可。




## 用户日常 Chrome 的 Dock 身份劫持（2026-10-20 实测定位，必读）

**症状**：点 Dock 上的 Chrome 图标没反应；右键「新建窗口」也无效；`open -a "Google Chrome"` 返回 -600（procNotFound）或 exit 0 但什么都没发生。用户表现为「Chrome 用不了了」。

**根因（不是 agent-browser 的 bug，是 macOS LaunchServices 语义）**：agent-browser / 自研脚本用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` 这个**真实二进制**起 headless（刻意如此：UA/指纹/登录态与日常 Chrome 一致，反爬站点不拒绝——**不要为此改用 Chrome for Testing，用户明确拒绝，很多站点会检测并拒绝登录**）。但 LaunchServices 按 **CFBundleIdentifier** 判定「这个 app 是否在运行」，**与 profile / user-data-dir 完全无关**。于是任何用同一 Chrome.app 起的 headless 实例都会被登记成 `com.google.Chrome` 的一个实例：

- 用户 Chrome 开着时：GUI 实例 `type="Foreground"`，headless `type="BackgroundOnly"` —— Dock 点击激活 GUI，**完全正常**（2026-10-20 实测）；
- 用户 Chrome 没开、只有 headless：headless 成为唯一的 `com.google.Chrome` 实例（且可能是 Foreground），点 Dock 只会去「激活」这个没有窗口的进程 —— **表现为点了没反应**。这才是用户报障时的真实状态（取证：用户 profile 下无 Singleton* 文件 = GUI 未运行）。

**判据（沙盒内可用的取证命令，不要用 ps——沙盒常禁）**：
```bash
lsappinfo list | grep -A6 '"Google Chrome"' | grep -E 'pid =|type='
# type="Foreground"  = 真实 GUI 实例（Dock 能被正常响应）
# type="BackgroundOnly" = headless 自动化实例（无窗口）
ls -a "$HOME/Library/Application Support/Google/Chrome/" | grep -i singleton
# 无 Singleton* = 用户 GUI Chrome 当前没运行 → 此刻起 headless 就会劫持 Dock
```

**修法：`~/.agents/bin/chrome-guard`（2026-10-20 落地）**。启动任何 headless 实例**之前**先跑它：

```bash
~/.agents/bin/chrome-guard          # 幂等；GUI 已存在 <50ms 返回；不存在则 open -g 后台拉起并等注册
~/.agents/bin/chrome-guard --check  # 只检测：0=有 GUI，1=没有
```

- 用 `open -g`（**-g 是关键**：不把 Chrome 切到前台，不打断用户当前操作）拉起 GUI 实例，等 LaunchServices 注册出 `Foreground` 条目（最多 15s）后才放行 headless。
- 代价（用户 2026-10-20 已确认接受）：若用户 Chrome 本来关着，自动化会顺手把它后台启动起来。
- **agent-browser 包装器已内置该调用**（`cleanOrphanDaemons()` 之后），走 agent-browser 的自动化无需手动加。
- **自研脚本（直接 spawn Chrome 二进制）必须自己加**：在 `nohup "$CHROME" --headless=new ...` 之前插一行 `~/.agents/bin/chrome-guard`。

**方案对比（2026-10-20 讨论定案，避免重复踩坑）**：

| 方案 | Dock 冲突 | 指纹/登录 | 焦点 | 结论 |
|---|---|---|---|---|
| **headless + 独立 profile + chrome-guard** | 守卫解决 | 与日常 Chrome 完全一致 | 零抢占 | ✅ **现行方案** |
| Chrome for Testing | 彻底无 | ✗ 反爬站点识别拒绝登录 | 零 | ❌ 用户明确拒绝 |
| 复制 Chrome.app 改 bundle id + ad-hoc 重签 | 彻底无 | 一致（同二进制） | 零 | 备选；代价：Chrome 更新需重建、Keychain 弹窗、cdhash 变化使「始终允许」失效 |
| headed + 独立 profile | 有（同 bundle） | 一致 | ✗ 启动瞬间抢焦点，移屏外/最小化都无效 | ❌ |
| attach 日常 Chrome `--cdp 9222` | 无（不起新进程） | 用户真实登录态 | 切标签会前置窗口 | 仅用户明确要求时；会弹「请求远程控制」 |

**红线段落**：

1. **禁止**为了规避 Dock 冲突改用 Chrome for Testing / 其他浏览器二进制——会改变 UA 与指纹，导致用户登录态被反爬站点拒绝（用户 2026-10-20 明确要求）。
2. **禁止**在未经 chrome-guard 检查的情况下直接用 `/Applications/Google Chrome.app` 起 headless。这是本机唯一会「让用户 Chrome 用不了」的操作。
3. **禁止**用 headed 模式换取「看起来更真实」——一启动就抢焦点，是比 Dock 冲突更严重的打扰。
4. 排查此类问题**不要先怀疑 agent-browser 的渲染/连接层**（`CDP response channel closed` 等是另一类问题），先跑一遍上面的 `lsappinfo` 判据。


### 补充实测（2026-10-20 23:33，干净环境端到端验证）

**关键修正：headless 实例也会被登记为 `type="Foreground"`**，不是恒定 BackgroundOnly。实测取证：

```
pid = 91046 type="Foreground" flavor=2 ...   ← headless 实例，却被登记为 Foreground
pid = 10439 type="Foreground" flavor=3 ...   ← 守卫拉起的正常 GUI
```

判定「是不是真 GUI」要看 **`flavor=3`**（正常 app），headless 是 **`flavor=2`**。所以：
- 光看 `type="Foreground"` 会被 headless 骗过；
- **Dock 劫持的精确条件 = 唯一的 `com.google.Chrome` Foreground 实例是 flavor=2 的 headless**。

**chrome-guard 的判定因此要收紧**：不能只认 `type="Foreground"`，必须认 `flavor=3`。当前脚本（23:11 版）只判 Foreground，存在被 headless 骗过而误判「GUI 已存在」的风险 —— 见下节修订。

**端到端验证记录（PASS）**：

| 阶段 | 操作 | 结果 |
|---|---|---|
| 0 | 杀光所有 Chrome（GUI+headless） | 主进程 0、Foreground 0、前台=DeepSeek Harness |
| 1 | **不做任何手动 open**，只跑 `agent-browser tab` | wrapper debug 显示冷启动 owner |
| 2 | 检查 LaunchServices | 出现 `pid 10439 type=Foreground flavor=3` = 真 GUI |
| 3 | 检查前台 | **仍是 DeepSeek Harness —— 守卫拉起 Chrome 没有抢焦点** |
| 4 | `open -a "Google Chrome"`（等价点 Dock） | exit=0，Foreground 数=1，正常 |

**~~结论：`open -g` 确实不抢焦点~~ —— 2026-10-22 已推翻，见下节。**

`open -g` 的语义是「**启动时**不把应用带到前台」（`man open`: *Do not bring the application to the foreground*）。
但它只管**冷启动**：对**已经在运行的 app**，`open` 仍会去激活它的窗口 —— 实测在 Chrome 已运行时执行
`open -g -a "Google Chrome"`，约 2.1s 后前台从「DeepSeek Harness」变成「Google Chrome」。上表的 PASS 记录
只覆盖了「Chrome 原本没开、由守卫冷启动」这一条路径，**不能**推广成「open -g 永远不抢焦点」。


## 抢焦点事故：chrome-guard 判定正则失效（2026-10-22 定位并修复）

**用户报障**：用浏览器自动化时「频繁切换我的焦点，影响日常使用电脑」。

**根因链（三段，全部实测复现）**：

1. **判定正则永远不命中**。`chrome-guard` 的 `has_gui_instance()` 用
   `awk '/^[0-9]+\\) "Google Chrome"/'` 匹配 LaunchServices 条目，但 `lsappinfo list` 的**行首带前导空格**
   （实测形如 ` 9) "Google Chrome" ASN:…`）→ `^` 锚点永不成立 → `inblock` 恒 0 → `found` 恒空
   → **永远返回「无 GUI 实例」**（`--check` 恒为 exit 1）。
   复现命令（旧版输出 exit=1、修正后 exit=0）：
   ```bash
   lsappinfo list | awk '/^[0-9]+\\) "Google Chrome"/{print "命中"}'; echo "（空 = 正则从未命中）"
   ```
2. **于是每次自动化调用都真的执行 `open`**。wrapper 每次调用都跑 `chrome-guard`（`agent-browser` 第 148-151 行），
   判定恒失败 → 走到「未检测到用户 Chrome GUI 实例 → 后台拉起 `open -g -a "Google Chrome"`」分支。
   用 shim 拦截 `open` 计数验证：旧版 **1 次/调用**，修复版 **0 次**。
3. **`open` 对已在运行的 Chrome = 激活窗口 = 抢焦点**。sample 采样实测：执行后约 **2.1s**，前台由
   「DeepSeek Harness」变为「Google Chrome」。用户每触发一次自动化就被切一次，且每次还要多等
   **~17–19 秒**（`sleep 2` + 30×`0.5s` 等不到注册的超时循环）。

**修复（2026-10-22 已落地，旧版备份 `~/.agents/bin/chrome-guard.bak-20261022`）**：

1. 判定正则允许前导空白：`/^[[:space:]]*[0-9]+\\) "Google Chrome"/`（块结束行同理）；
2. **加安全阀**：profile 被**存活进程**持有时，即使判定不到 Foreground（注册延迟/口径差异）也**不执行 open**，直接放行。

   **安全阀第一版写错过（同日发现并修正，务必按最终版实现）**：初版只判断「\`SingletonLock\` 文件是否存在」，
   结果在 **stale lock**（Chrome 崩溃/被杀后锁残留、pid 早已不存在）时也拒绝 `open` —— 这是把
   「频繁抢焦点」换成了「点 Dock 打不开 Chrome」，属于**更严重的回归**。正确实现必须校验锁里的 pid 是否存活：
   ```bash
   has_profile_lock() {
     local lock="$PROFILE_DIR/SingletonLock" pid
     [ -L "$lock" ] || [ -f "$lock" ] || return 1
     pid="$(readlink "$lock" 2>/dev/null | sed 's/.*-//')"   # 锁内容形如 "hostname-<pid>"
     case "$pid" in ''|*[!0-9]*) return 1 ;; esac
     kill -0 "$pid" 2>/dev/null                              # pid 存活才算「进程持有」
   }
   ```

**修复后实测**：`--check` exit=0（`GUI 实例在运行，Dock 安全`）；热路径 **32–104ms**（原 ~18.6s）；
`--check` **300/300 次正确**（最大 104ms，平均 40ms）；完整调用 50 连跑 `open` 调用数 **0/50**（桩正例自测 A=1 确认有效）；
真实 `agent-browser tab list` **20 连跑前台零变化**，0 失败。

**边界矩阵（隔离测试，假 `open` + 假 profile，四组合全 PASS）**：

| 场景 | GUI 检测 | profile 锁 | 期望 | 实测 |
|---|---|---|---|---|
| 1 正常 | 成功 | — | 不 open（exit 0） | ✅ open=0 |
| 2 注册延迟 | 失败 | 有锁 + pid 活 | 不 open（防抢焦点） | ✅ open=0 |
| 3 Chrome 崩溃残留锁 | 失败 | 有锁 + pid 死 | **必须 open**（否则 Dock 保护失效） | ✅ open=1 |
| 4 Chrome 真没开 | 失败 | 无锁 | **必须 open** | ✅ open=1 |

**语言选型结论（2026-10-22 用户评估过 Swift / Go，最终维持 bash）**：

用户问过「bash 脚本乱七八糟问题多，有没有更好的语言」。实测结论：**问题不在 bash，在「解析人类可读文本」这个做法**。
把各语言的可行判据都实现并压测后，结论是 **维持 bash**：

| 方案 | 耗时 | 判据 | 交叉编译 | cgo | 结论 |
|---|---|---|---|---|---|
| **bash（现行）** | 32–50ms | `lsappinfo` flavor=3 + 锁安全阀 | — | 否 | ✅ **保留** |
| Swift + AppKit | 11ms | `activationPolicy` | ❌ minos 15.0 | 否 | ❌ 需编译/分发，收益仅 40ms |
| Go + cgo | 17–24ms | `activationPolicy` | ❌ | **是** | ❌ 「跨平台」优势消失 |
| Go 纯版（锁+pid） | 5–8ms | 锁+pid | ✅ | 否 | ❌ 判据退化，分不清 GUI/headless |
| Go 纯版 + 命令行 | 5ms | sysctl 读 `--headless` | ✅ | 否 | ⚠️ 技术上可行，但本机用不到跨平台 |

关键事实（都实测过，别再重复验证）：
- `activationPolicy` 能**精确**区分 GUI(`regular`)/headless(`prohibited`)，是本需求的语义级判据；但它属于 AppKit →
  必须 cgo → **cgo 让交叉编译失效**（报 `runtime/cgo: gcc_amd64.S unknown token`）。「跨平台」和「精确判据」在 Go 里互斥。
- 纯 Go 的 `sysctl KERN_PROCARGS2` 可读进程命令行并检查 `--headless`，实测与 `activationPolicy` **逐实例 100% 一致**，
  且无需 cgo、可三平台静态编译（实测 darwin/arm64、darwin/amd64、linux/amd64 全成功，minos 13.0）。
  但这是「Chrome 行为事实」而非「API 契约」，稳定性弱于系统 API。
- `lsappinfo -xml` 在本机**是坏的**（只输出 174 字节空行），不要指望它做结构化输出。
- **决定性理由**：这个 guard 只跑在本机 macOS 上（`lsappinfo`/Chrome profile 路径/`open -a` 全是 macOS 专有），
  「跨平台编译」是需求里不存在的能力；而 32–50ms 与 5–11ms 的差异用户完全无感（修复前是 18,600ms）。
  为不存在的收益引入编译与分发成本、并把判据从「系统 API 契约」降级为「行为观察」，不划算。

**安全前提（用户 2026-10-22 明确确认）**：浏览器自动化的 profile **一定不会用日常 Chrome 的 profile**。
因此「锁判据可能分不清 GUI/headless 复用同一 profile」这一理论风险在本机不成立，bash 版的双判据足够。

**验证方法（以后审计这类问题照做）**：

| 手段 | 用途 |
|---|---|
| `lsappinfo front` + `lsappinfo info -only name <ASN>` | 前台应用**唯一可信**判据（不要用 osascript，会卡辅助功能弹窗） |
| 给 `open` 放 `PATH` shim 并记录调用 | **证明「谁真的执行了 open」**，比看日志可靠。**两个必踩的坑（本次都踩了）**：① shim 里的日志路径若用变量（`$WS/...`）而变量未导出 → shim 静默失效、`open` 落到真实的 `/usr/bin/open`（结果「测试通过但实际动了用户 Chrome」）；② shim 内日志路径**硬编码**、外部却用另一个变量读取 → 读错文件，得到「0 次调用」的假结论。**所以每次用桩前先跑正例自测（确认该命中时确实命中，A=1），并统一日志路径** |
| `stat -f '%Sm %z'` 看 Chrome `Default/Sessions/Session_*` | 判断是否真的新开了窗口/标签 |
| 后台跑目标命令 + 每 0.3s 采样前台 | 能抓到 2s 级别的瞬时抢占（只看首尾会漏） |

**教训（可迁移）**：

- **`open -g` 只保证冷启动不进前台，不保证「不激活已运行的应用」**——对已运行的 app 调用 `open` 就是激活它。
  任何「确保某 GUI app 在跑」的守卫逻辑，都必须先**可靠判定它是否已在运行**，否则守卫本身变成打扰源。
- **awk 块匹配 `lsappinfo list` 必须容忍行首空白**；这类「解析别人输出」的正则失效是**静默的**（不报错、只是永远走失败分支），
  必须用「已知有 GUI 时 `--check` 是否返回 0」这类**带正例的自测**才能发现。
- 凡是「每次调用都跑」的守卫脚本，写完后必须验 **热路径耗时**（本次修复省掉约 18.6 秒/次）与**副作用**（open、窗口、焦点）。
- 该 bug 自 2026-10-20 守卫上线即存在；2026-10-20 当晚那次「`open -g` 不抢焦点」的 PASS 结论**只覆盖冷启动路径**，
  被误当成通用结论沿用 —— **结论必须写清适用前提**。
- **修「过度打扰」类 bug 时，必须同时验证「该做的动作没被一起干掉」**。本次安全阀初版矫枉过正：
  只加「有锁就不 open」而不校验 pid 存活，直接让 stale lock 场景下的 Dock 保护失效。
  **正确性 = 不该动的不动 + 该动的照动**，只验前者等于没验。
- **测试装置本身要先自测**：本次 shim 因变量未导出而静默失效，导致「open=0」的假通过。
  凡是用 shim/桩做对照实验，先跑一次「确定该命中」的正例，确认桩真的被调用，再拿它下结论。
- **「换语言」很少是脚本 bug 的解**：本次两个 bug —— 文本解析脆弱（正则锚点）+ 逻辑错误（安全阀没校验 pid）——
  前者靠**换判据**（换结构化数据源）解决，后者任何语言都会犯。评估了 Swift/Go 各两种实现后结论仍是维持 bash：
  **先问「瓶颈是语言还是判据/逻辑」**，再谈迁移。同时要算清收益量级：这里换语言的收益是 40ms，
  而真正的修复收益是每次调用省 18.6 秒、且不再抢焦点 —— 后者才是该投入的地方。


## 无 GUI 却未拉起 headed：PID 回绕复用与 open 缺 -n 导致 headless 独占 Dock（2026-10-24 根因修复）

**用户报障**：浏览器自动化又出现了没有打开 headed 浏览器就开始使用 headless 浏览器的情况。

**根因链（三处缺陷叠加，全部实测复现）**：

1. **2026-10-22 的安全阀误判：PID 回绕复用使得 `has_profile_lock` 恒为真**。
   - 2026-10-22 引入的 `has_profile_lock` 仅用 `kill -0 "$pid"` 校验锁文件中的 PID 是否存活。
   - 但 macOS 的 PID 会回绕复用：三天前（10-21）Chrome 崩溃残留的 `SingletonLock -> yinghuoren.local-530`，其 PID 530 被 macOS 系统常驻守护进程 `suggestd` 复用。
   - `kill -0 530` 恒返回 0（`suggestd` 存活）→ `chrome-guard` 误以为用户 Chrome 正在运行/启动中 → 触发安全阀分支：`profile 已锁定但检测不到 Foreground 条目，判定为注册延迟/口径差异；为避免抢焦点，不执行 open` 并直接 `exit 0`！
   - 导致 `chrome-guard` 永久跳过了对真实 GUI Chrome 的拉起。
2. **`open` 缺少 `-n`：当 headless 已经占领 bundle ID 时，普通 `open` 无法唤起新 GUI 实例**。
   - LaunchServices 按 `com.google.Chrome` 路由 `open` 命令；若 headless 已经在跑，`open -g -a "Google Chrome"` 只是向现有的无窗口 headless 进程发送 Open 事件（该进程忽略事件），根本不会 spawn 出真正的 GUI 进程，等满 15 秒超时失败。
   - 必须加 `-n`（`--new`）显式强制 LaunchServices 新建一个应用实例。
3. **残留锁文件阻碍 Chrome 启动**：
   - 若 `SingletonLock` 残留且指向存活的非 Chrome 进程，Chrome 启动时其自身 `ProcessSingleton` 连接套接字失败后可能报 `Failed to create .../SingletonLock: File exists` 中断启动。必须在启动前将陈旧的残留锁清理掉。

**修复方案（`~/.agents/bin/chrome-guard` 2026-10-24 落地）**：
1. **收紧 `has_profile_lock` 判据**：
   - 必须同时满足：① `kill -0 "$pid"` 存活；② 检查进程名/命令行（`ps -p "$pid" -o comm=` 或 `lsof`）确实包含 `Google Chrome`；③ 对应的 `SingletonSocket` 存在且为有效 UNIX Domain Socket（`[ -S ... ]`）。
2. **启动前清理陈旧残留锁**：
   - 若 `SingletonLock` 存在但 `has_profile_lock` 为假（无存活 Chrome 进程持有），在 `open` 前主动清理 `$PROFILE_DIR/Singleton*`。
3. **`open` 增加 `-n`**：
   - `open -n -g -a "Google Chrome"`，即使 headless 已经在跑，也能强制新建 GUI Chrome 实例并注册 `flavor=3 Foreground`，恢复 Dock 正常响应。


## wrapper exit 127 修复（2026-10-21，根因级）

**症状**：`agent-browser <任意命令>` 返回 **exit 127**，stderr 只有 `env: node: No such file or directory`；
冷启动时每条命令固定耗时 **20,000ms**（`waitForPort` 超时）后才回退。表现为"wrapper 能用但极慢"，
实际是**完全不可用**——所有真实调用都失败，只是失败被 `Bun.spawnSync` 的 pipe 吞掉、输出重定向时看不出来。

**根因**：wrapper 用 `Bun.spawnSync([REAL, ...])` 直接执行 `agent-browser.js`，而该文件 shebang 是
`#!/usr/bin/env node` —— 即**靠 PATH 去查 node**。

本机 node 由 **nvm** 管理（`~/.nvm/versions/node/vX/bin/node`），**装得好好的、用户终端里也正常可用**（zsh 加载
`.zprofile`/`.zshrc` 后 PATH 含该目录）。真正的坑是：**DSH 会话 spawn 的子进程 PATH 不一定包含 nvm 目录**
（取决于会话/沙盒/启动方式）。同一台机器实测对照：

| 执行环境 | `command -v node` | 直接执行 `agent-browser.js --version` |
|---|---|---|
| PATH 含 `/Users/liyou/.nvm/versions/node/vX/bin` | 找到 | `agent-browser 0.38.2` ✅ |
| PATH 不含 nvm（如手写的 `/Users/liyou/.bun/bin:/opt/homebrew/bin:/usr/local/bin:...`） | 找不到 | `env: node: No such file or directory` ❌ |

失败连锁：所有 `[REAL, ...]` 调用 exit 127 → `bootstrapOwner()` 静默失败 → owner 永远起不来 →
`waitForPort()` 每条命令等满 20 秒。

**排查口径**：不要在用户终端里验证（那里当然有 node），要在**实际跑 wrapper 的那个子进程环境**里验证：
`env -i PATH="<该环境的 PATH>" /path/to/agent-browser.js --version`。

**修复**（`~/.agents/bin/agent-browser` 第 63 行 + 5 处调用点）：
```ts
const JS_RUNNER = process.execPath;   // 本文件由 bun 执行 → 即 bun 绝对路径
// 所有 [REAL, ...] → [JS_RUNNER, REAL, ...]
```

**修复后实测**：冷启动 **1,855ms**（原 20,300ms，快 11 倍）；热路径 231–304ms；
`open` / `get title` / `eval` / `screenshot` 全部 exit=0（截图 71KB 真实生成）；用户 Chrome 未受影响。

**排查提示**：以后看到 wrapper "慢"或"没反应"，**第一步先看 exit code**（`agent-browser get title; echo $?`）。
exit 127 = 解释器问题；exit 0 但无输出 = 另一回事。不要只看耗时。

**教训**：`Bun.spawnSync` / `execFile` 直接执行带 `#!/usr/bin/env node` shebang 的脚本时，
必须确认 `node` 在**子进程 PATH** 里；本机 node 在 nvm 下，任何不经过交互式 shell 的 spawn 都拿不到它。
稳妥做法是显式用 `process.execPath`（或 `bun`/`node` 绝对路径）作为 runner。

## 用完必清：会话与标签回收纪律（2026-10-27 用户明确要求）

**用户原话（2026-10-27）**：「你打开了太多的 chrome 标签，不用的一定要记得清理掉，这个要沉淀到 skill 中」。

**当日实测泄漏**：一轮 a11y 矩阵审计跑批（多个 worker × 多次重跑）结束后，`agent-browser session list` 残留 **8 个 `<项目前缀>-audit-*` 会话**，`ps aux | grep 'Chrome for Testing'` 达 **81 个进程**，且每个会话各带多个标签。清理后进程归零。

**硬规则**：

1. **每个任务/脚本结束时必须回收自己的会话**：房客直接 `agent-browser close`；独立实例（`AGENT_BROWSER_GLOBAL_SESSION=<名>` / `--session <名>`）用 `agent-browser --session <名> close`。
2. **跑批脚本必须在 trap EXIT 中关闭自身 session**（某项目 的 `scripts/browser-a11y.sh` / `browser-touch.sh` 已实现；新脚本照此模式），否则一次矩阵 6 组合 × 多次重跑会累积成几十个 Chrome。
3. **人工任务收尾三连检查**（写进每轮工作流程）：
   ```bash
   agent-browser session list                  # 只应剩当前任务会话
   ps aux | grep -c 'Chrome for Testing'       # 期望 0（无任务）或仅活跃任务数
   agent-browser tab list                       # 当前会话只留 1 个标签
   ```
4. **禁止 `close --all`**（wrapper 硬拦）；也**不得关别人的会话**，先确认该会话无 active socket/无任务（`lsof ~/.agent-browser/<名>.sock`）。
5. **同一会话顺序复用单个 tab**：`open` 的语义就是导航当前 tab；不要用 `tab new` 累积标签，除非明确需要多标签对照。

**2026-10-27 实际清理命令（可直接复用）**：

```bash
for s in $(agent-browser session list | grep -o '<项目前缀>-audit-[A-Za-z0-9-]*'); do
  agent-browser --session "$s" close
done
agent-browser session list                      # 确认只剩当前 dsh-* 房客
ps aux | grep -c 'Chrome for Testing'            # 0
```

**归属判断口径**：`dsh-*` / `shared` 是 wrapper 管辖的房客与 owner，不要动；`<项目前缀>-audit-*`、`lead-*`、`manual-*` 这类临时会话按任务归属自行清理。

## 孤儿 daemon+Chrome 收割器——公共层兜底（2026-10-27 落地，端到端实测）

**为什么需要**：显式 `--session` 独立实例（自带 headless Chrome + 临时 profile）的宿主脚本被 SIGINT/SIGTERM/SIGKILL 打断、或 `close` 失败被 `|| true` 吞掉时，daemon 与它拉起的 Chrome 都不会自退（attach 型 daemon 豁免空闲回收）。实测一夜累积多组孤儿（峰值 8 组 ≈112% CPU + 5.2GB 内存，整机 load >15）。wrapper 的 `purgeDeadSessionState` 只清「进程已死」的残留状态文件，管不到「进程活着但宿主已消失」的实例——`~/.agents/bin/ab-reap-orphans.mjs` 补这一层，wrapper 每次调用自动节流派发（1h 至多一次，stamp `~/.agent-browser/.last-orphan-reap`）。

**判据与保障（全部实测）**：
- **永不触碰**：`shared`（owner）、`dsh-*` / `manual-*`（房客，attach 模式不自带 Chrome）、`AB_REAP_PROTECT_SESSIONS` 额外名单（wrapper 注入调用方当前会话）、以及任何持 `profiles/main` Chrome 的会话。
- **候选**：sock 存在 + daemon 存活（pid 需核「进程命令行含 agent-browser + 是本会话 sock 持有者」双重身份，防 pid 回绕复用误杀）+ 其 Chrome 子进程用临时 profile（`agent-browser-chrome-*`）。
- **两段式**：首次发现写标记 `~/.agent-browser/.orphan-mark/<会话>`；标记满最小龄（默认 600s，`--min-age` 可覆盖）且 sock 仍无 daemon 之外的客户端才收割——活任务两次采样之间必有命令连接，不会误杀；宿主无论怎么死（含 SIGKILL）都能兜住。
- **动作顺序**：先记 Chrome 子进程 pid + user-data-dir（daemon 死后子进程过继 launchd，`pgrep -P` 将失效）→ TERM→2s→KILL daemon → Chrome 按「pid + user-data-dir 双重核对」TERM→KILL → 删状态文件与临时 profile 目录。

**手动命令**：

```bash
node ~/.agents/bin/ab-reap-orphans.mjs --dry-run    # 只评估不动手
node ~/.agents/bin/ab-reap-orphans.mjs --min-age 0  # 立即收割当前确认孤儿（先核实无活任务再用）
```

**端到端验证（2026-10-27 20:56）**：dry-run 正确列出 7 个孤儿（4 组带 chrome + 3 组 chrome-less 残留 daemon），保护名单零误报；`--min-age 0` 实跑全部收割，Chrome 主进程 5→1（仅剩 owner），4 个临时 profile 目录删除，shared / dsh-* / manual-* 全部完好；wrapper 冒烟（tab list）exit=0 且派发 stamp 正常刷新。

**可迁移教训**：
- 脚本侧 `trap '... close ... || true' EXIT` 是单点：close 失败静默、SIGKILL 时 trap 不执行。生命周期清理必须有公共层兜底，不能依赖每个调用方都写对。
- 判活不能只看 `kill -0`：pid 会回绕复用（chrome-guard 2026-10-24 同类教训），必须核对进程命令行 + 会话 sock 持有者。
- 「daemon 存活」≠「宿主还在」：daemon daemonize 后父进程是 launchd，无法从进程树推断归属，只能靠 sock 客户端活跃度 + 时间窗近似。

## 清理义务——不用的及时清理（2026-10-27 定案，红线级）

**公共层兜底（reaper）不是豁免理由**，每个调用方仍负有清理义务：

1. **独立实例用完即关**：`agent-browser --session <名> close`（只关自己的；`close --all` 仍是红线）。
   宿主被 SIGKILL 时 trap 不会执行——那由 reaper 兜底，但正常路径必须自己 close。
2. **任务收尾复查两件事**：`agent-browser session list`（有没有不该存在的会话）、
   `ps aux | grep -c 'remote-debugging-port=0'`（headless Chrome 主进程数是否超出预期）。
   发现异常残留：先核实无活任务，再 `node ~/.agents/bin/ab-reap-orphans.mjs --min-age 0` 立即收割。
3. **产物不落公共目录**：截图/HAR/下载等属项目中间产物，落项目 `.workwork/`；
   确因工具默认路径落到 `~/.agent-browser/tmp/` 的，reaper 按 7 天 TTL（`AB_TMP_TTL_DAYS`）自动清理，
   需要保留的当场挪走——`--dry-run` 可预览将清理的文件数。
4. **持久 profile 不用了要删**：`~/.agent-browser/profiles/<用途>/` 与项目自建 profile。
   项目废弃或改方案时连同状态文件一并清；删前 tar 备份到 `~/.dsh/backups/`（2026-10-27 已按此处置一个 16MB 零引用遗留 profile）。
5. **会话命名按任务独立**（`--session <名>-$$` 或项目固定名），禁止复用他人/他项目的名字；
   跨项目固定名冲突会让两个任务共用同一浏览器实例（标签互抢）。

**收益基线（2026-10-27 实测）**：一夜累积 8 组孤儿 ≈112% CPU + 5.2GB 内存；清理后整机 load 15.8→2.4，
内存空闲 31%→68%。泄漏不值得，清理不麻烦。

补充（2026-10-27 同日）：reaper 只扫描 `~/.agent-browser/` 下的会话；显式设置 `AGENT_BROWSER_SOCKET_DIR` 把 socket 重定向到别处（如仓库/worktree 内）的会话**不在收割范围**，且该重定向机制本身已废弃（现行路径：目录写权限走 sandbox-extra-roots 放行 + 默认 socket 目录）。发现仍用旧重定向的脚本时按废弃处理。
