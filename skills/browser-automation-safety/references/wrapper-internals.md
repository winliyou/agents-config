# wrapper 与 session 内部机制（取证）

> 本文是 browser-automation-safety 的 reference：wrapper（~/.agents/bin/agent-browser）的复用细节、自愈、CLI 坑与历史故障根因；排查「跑成 Chrome for Testing、session 漂移、tab_gone、exit 127、CDP response channel closed」时读。

## 一、复用机制细节与早期误判

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

## 二、CLI 细节坑

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

## 三、受限沙盒下的提权执行（run_code / tools.bash 细节）


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


## 四、自研 CDP 管线废止与唯一例外


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

## 五、wrapper exit 127：解释器 PATH 问题


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

## 六、复用架构与 close 硬闸细节

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

## 七、静默运行注入与二进制固化细节

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
