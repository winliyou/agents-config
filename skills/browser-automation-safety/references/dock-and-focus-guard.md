# Dock 劫持与抢焦点：判据与守卫机制

> 本文是 browser-automation-safety 的 reference：macOS 上两类最严重打扰（点 Dock 无反应、抢焦点）的根因、chrome-guard 设计与验证方法。日常只需照 SKILL.md 的红线执行；排查或改守卫时读本文。

## 一、用户日常 Chrome 的 Dock 身份劫持


**症状**：点 Dock 上的 Chrome 图标没反应；右键「新建窗口」也无效；`open -a "Google Chrome"` 返回 -600（procNotFound）或 exit 0 但什么都没发生。用户表现为「Chrome 用不了了」。

**根因（不是 agent-browser 的 bug，是 macOS LaunchServices 语义）**：agent-browser / 自研脚本用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` 这个**真实二进制**起 headless（刻意如此：UA/指纹/登录态与日常 Chrome 一致，反爬站点不拒绝——**不要为此改用 Chrome for Testing（很多站点会检测并拒绝登录）**）。但 LaunchServices 按 **CFBundleIdentifier** 判定「这个 app 是否在运行」，**与 profile / user-data-dir 完全无关**。于是任何用同一 Chrome.app 起的 headless 实例都会被登记成 `com.google.Chrome` 的一个实例：

- 用户 Chrome 开着时：GUI 实例 `type="Foreground"`，headless `type="BackgroundOnly"` —— Dock 点击激活 GUI，**完全正常**；
- 用户 Chrome 没开、只有 headless：headless 成为唯一的 `com.google.Chrome` 实例（且可能是 Foreground），点 Dock 只会去「激活」这个没有窗口的进程 —— **表现为点了没反应**。（判据：用户 profile 下无 Singleton* 文件 = GUI 未运行）。

**判据（沙盒内可用的取证命令，不要用 ps——沙盒常禁）**：
```bash
lsappinfo list | grep -A6 '"Google Chrome"' | grep -E 'pid =|type='
# type="Foreground"  = 真实 GUI 实例（Dock 能被正常响应）
# type="BackgroundOnly" = headless 自动化实例（无窗口）
ls -a "$HOME/Library/Application Support/Google/Chrome/" | grep -i singleton
# 无 Singleton* = 用户 GUI Chrome 当前没运行 → 此刻起 headless 就会劫持 Dock
```

**修法：`~/.agents/bin/chrome-guard`**。启动任何 headless 实例**之前**先跑它：

```bash
~/.agents/bin/chrome-guard          # 幂等；GUI 已存在 <50ms 返回；不存在则 open -g 后台拉起并等注册
~/.agents/bin/chrome-guard --check  # 只检测：0=有 GUI，1=没有
```

- 用 `open -g`（**-g 是关键**：不把 Chrome 切到前台，不打断用户当前操作）拉起 GUI 实例，等 LaunchServices 注册出 `Foreground` 条目（最多 15s）后才放行 headless。
- 代价（已确认接受）：若用户 Chrome 本来关着，自动化会顺手把它后台启动起来。
- **agent-browser 包装器已内置该调用**（`cleanOrphanDaemons()` 之后），走 agent-browser 的自动化无需手动加。
- **自研脚本（直接 spawn Chrome 二进制）必须自己加**：在 `nohup "$CHROME" --headless=new ...` 之前插一行 `~/.agents/bin/chrome-guard`。

**方案对比（避免重复踩坑）**：

| 方案 | Dock 冲突 | 指纹/登录 | 焦点 | 结论 |
|---|---|---|---|---|
| **headless + 独立 profile + chrome-guard** | 守卫解决 | 与日常 Chrome 完全一致 | 零抢占 | ✅ **现行方案** |
| Chrome for Testing | 彻底无 | ✗ 反爬站点识别拒绝登录 | 零 | ❌ 不采用 |
| 复制 Chrome.app 改 bundle id + ad-hoc 重签 | 彻底无 | 一致（同二进制） | 零 | 备选；代价：Chrome 更新需重建、Keychain 弹窗、cdhash 变化使「始终允许」失效 |
| headed + 独立 profile | 有（同 bundle） | 一致 | ✗ 启动瞬间抢焦点，移屏外/最小化都无效 | ❌ |
| attach 日常 Chrome `--cdp 9222` | 无（不起新进程） | 用户真实登录态 | 切标签会前置窗口 | 仅限用户主动提出操作日常 Chrome 时；会弹「请求远程控制」 |

**红线段落**：

1. **禁止**为了规避 Dock 冲突改用 Chrome for Testing / 其他浏览器二进制——会改变 UA 与指纹，导致用户登录态被反爬站点拒绝。
2. **禁止**在未经 chrome-guard 检查的情况下直接用 `/Applications/Google Chrome.app` 起 headless。这是本机唯一会「让用户 Chrome 用不了」的操作。
3. **禁止**用 headed 模式换取「看起来更真实」——一启动就抢焦点，是比 Dock 冲突更严重的打扰。
4. 排查此类问题**不要先怀疑 agent-browser 的渲染/连接层**（`CDP response channel closed` 等是另一类问题），先跑一遍上面的 `lsappinfo` 判据。


### 关键判据：headless 也会被登记为 Foreground

**headless 实例也会被登记为 `type="Foreground"`**，不是恒定 BackgroundOnly。判据：

```
pid = 91046 type="Foreground" flavor=2 ...   ← headless 实例，却被登记为 Foreground
pid = 10439 type="Foreground" flavor=3 ...   ← 守卫拉起的正常 GUI
```

判定「是不是真 GUI」要看 **`flavor=3`**（正常 app），headless 是 **`flavor=2`**。所以：
- 光看 `type="Foreground"` 会被 headless 骗过；
- **Dock 劫持的精确条件 = 唯一的 `com.google.Chrome` Foreground 实例是 flavor=2 的 headless**。

**chrome-guard 的判定因此要收紧**：不能只认 `type="Foreground"`，必须认 `flavor=3`；只判 `type="Foreground"` 会被 headless 骗过而误判「GUI 已存在」（见下节修订）。

**端到端验证**：

| 阶段 | 操作 | 结果 |
|---|---|---|
| 0 | 杀光所有 Chrome（GUI+headless） | 主进程 0、Foreground 0、前台=DeepSeek Harness |
| 1 | **不做任何手动 open**，只跑 `agent-browser tab` | wrapper debug 显示冷启动 owner |
| 2 | 检查 LaunchServices | 出现 `pid 10439 type=Foreground flavor=3` = 真 GUI |
| 3 | 检查前台 | **仍是 DeepSeek Harness —— 守卫拉起 Chrome 没有抢焦点** |
| 4 | `open -a "Google Chrome"`（等价点 Dock） | exit=0，Foreground 数=1，正常 |

**`open -g` 在冷启动路径不抢焦点；对已运行的 app 会激活窗口（见下节）。**

`open -g` 的语义是「**启动时**不把应用带到前台」（`man open`: *Do not bring the application to the foreground*）。
但它只管**冷启动**：对**已经在运行的 app**，`open` 仍会去激活它的窗口 —— 在 Chrome 已运行时执行
`open -g -a "Google Chrome"`，约 2.1s 后前台从「DeepSeek Harness」变成「Google Chrome」。该结论
只覆盖「Chrome 原本没开、由守卫冷启动」这一条路径，**不能**推广成「open -g 永远不抢焦点」。


## 二、第二类抢焦点源头：chrome-guard 判定正则失效


**症状**：用浏览器自动化时「频繁切换我的焦点，影响日常使用电脑」。

**根因链（三段）**：

1. **判定正则永远不命中**。`chrome-guard` 的 `has_gui_instance()` 用
   `awk '/^[0-9]+\\) "Google Chrome"/'` 匹配 LaunchServices 条目，但 `lsappinfo list` 的**行首带前导空格**
   （形如 ` 9) "Google Chrome" ASN:…`）→ `^` 锚点永不成立 → `inblock` 恒 0 → `found` 恒空
   → **永远返回「无 GUI 实例」**（`--check` 恒为 exit 1）。
   复现命令（空输出 = 该正则从未命中）：
   ```bash
   lsappinfo list | awk '/^[0-9]+\\) "Google Chrome"/{print "命中"}'; echo "（空 = 正则从未命中）"
   ```
2. **判定失败 → 每次自动化调用都真的执行 `open`**。wrapper 每次调用都跑 `chrome-guard`（`agent-browser` 第 148-151 行），
   判定失败即走「未检测到用户 Chrome GUI 实例 → 后台拉起 `open -g -a "Google Chrome"`」分支。
   用 shim 拦截 `open` 计数验证：现行实现 **0 次/调用**（错误正则 1 次/调用）。
3. **`open` 对已在运行的 Chrome = 激活窗口 = 抢焦点**。sample 采样：执行后约 **2.1s**，前台由
   「DeepSeek Harness」变为「Google Chrome」。每触发一次自动化就被切一次，且每次还要多等
   **~17–19 秒**（`sleep 2` + 30×`0.5s` 等不到注册的超时循环）。

**现行实现**：

1. 判定正则允许前导空白：`/^[[:space:]]*[0-9]+\\) "Google Chrome"/`（块结束行同理）；
2. **加安全阀**：profile 被**存活进程**持有时，即使判定不到 Foreground（注册延迟/口径差异）也**不执行 open**，直接放行。

   **安全阀必须校验锁里的 pid 是否存活**：只判断「\`SingletonLock\` 文件是否存在」，
   会在 **stale lock**（Chrome 崩溃/被杀后锁残留、pid 早已不存在）时也拒绝 `open` —— 把
   「频繁抢焦点」换成了「点 Dock 打不开 Chrome」，属于**更严重的回归**。正确实现：
   ```bash
   has_profile_lock() {
     local lock="$PROFILE_DIR/SingletonLock" pid
     [ -L "$lock" ] || [ -f "$lock" ] || return 1
     pid="$(readlink "$lock" 2>/dev/null | sed 's/.*-//')"   # 锁内容形如 "hostname-<pid>"
     case "$pid" in ''|*[!0-9]*) return 1 ;; esac
     kill -0 "$pid" 2>/dev/null                              # pid 存活才算「进程持有」
   }
   ```

**现状**：`--check` exit=0（`GUI 实例在运行，Dock 安全`）；热路径 **32–104ms**；
`--check` **300/300 次正确**（最大 104ms，平均 40ms）；完整调用 50 连跑 `open` 调用数 **0/50**（桩正例自测 A=1 确认有效）；
真实 `agent-browser tab list` **20 连跑前台零变化**，0 失败。

**边界矩阵（隔离测试，假 `open` + 假 profile，四组合全 PASS）**：

| 场景 | GUI 检测 | profile 锁 | 期望 | 结果 |
|---|---|---|---|---|
| 1 正常 | 成功 | — | 不 open（exit 0） | ✅ open=0 |
| 2 注册延迟 | 失败 | 有锁 + pid 活 | 不 open（防抢焦点） | ✅ open=0 |
| 3 Chrome 崩溃残留锁 | 失败 | 有锁 + pid 死 | **必须 open**（否则 Dock 保护失效） | ✅ open=1 |
| 4 Chrome 真没开 | 失败 | 无锁 | **必须 open** | ✅ open=1 |

**语言选型结论（维持 bash）**：

结论：**问题不在 bash，在「解析人类可读文本」这个做法**。
把各语言的可行判据都实现并压测后，结论是 **维持 bash**：

| 方案 | 耗时 | 判据 | 交叉编译 | cgo | 结论 |
|---|---|---|---|---|---|
| **bash（现行）** | 32–50ms | `lsappinfo` flavor=3 + 锁安全阀 | — | 否 | ✅ **保留** |
| Swift + AppKit | 11ms | `activationPolicy` | ❌ minos 15.0 | 否 | ❌ 需编译/分发，收益仅 40ms |
| Go + cgo | 17–24ms | `activationPolicy` | ❌ | **是** | ❌ 「跨平台」优势消失 |
| Go 纯版（锁+pid） | 5–8ms | 锁+pid | ✅ | 否 | ❌ 判据退化，分不清 GUI/headless |
| Go 纯版 + 命令行 | 5ms | sysctl 读 `--headless` | ✅ | 否 | ⚠️ 技术上可行，但本机用不到跨平台 |

关键事实（均已验证，无需重复验证）：
- `activationPolicy` 能**精确**区分 GUI(`regular`)/headless(`prohibited`)，是本需求的语义级判据；但它属于 AppKit →
  必须 cgo → **cgo 让交叉编译失效**（报 `runtime/cgo: gcc_amd64.S unknown token`）。「跨平台」和「精确判据」在 Go 里互斥。
- 纯 Go 的 `sysctl KERN_PROCARGS2` 可读进程命令行并检查 `--headless`，实测与 `activationPolicy` **逐实例 100% 一致**，
  且无需 cgo、可三平台静态编译（实测 darwin/arm64、darwin/amd64、linux/amd64 全成功，minos 13.0）。
  但这是「Chrome 行为事实」而非「API 契约」，稳定性弱于系统 API。
- `lsappinfo -xml` 在本机**是坏的**（只输出 174 字节空行），不要指望它做结构化输出。
- **决定性理由**：这个 guard 只跑在本机 macOS 上（`lsappinfo`/Chrome profile 路径/`open -a` 全是 macOS 专有），
  「跨平台编译」是需求里不存在的能力；而 32–50ms 与 5–11ms 的差异用户完全无感。
  为不存在的收益引入编译与分发成本、并把判据从「系统 API 契约」降级为「行为观察」，不划算。

**安全前提**：浏览器自动化的 profile **一定不会用日常 Chrome 的 profile**。
因此「锁判据可能分不清 GUI/headless 复用同一 profile」这一理论风险在本机不成立，bash 版的双判据足够。

**验证方法（以后审计这类问题照做）**：

| 手段 | 用途 |
|---|---|
| `lsappinfo front` + `lsappinfo info -only name <ASN>` | 前台应用**唯一可信**判据（不要用 osascript，会卡辅助功能弹窗） |
| 给 `open` 放 `PATH` shim 并记录调用 | **证明「谁真的执行了 open」**，比看日志可靠。**两个必踩的坑**：① shim 里的日志路径若用变量（`$WS/...`）而变量未导出 → shim 静默失效、`open` 落到真实的 `/usr/bin/open`（结果「测试通过但实际动了用户 Chrome」）；② shim 内日志路径**硬编码**、外部却用另一个变量读取 → 读错文件，得到「0 次调用」的假结论。**所以每次用桩前先跑正例自测（确认该命中时确实命中，A=1），并统一日志路径** |
| `stat -f '%Sm %z'` 看 Chrome `Default/Sessions/Session_*` | 判断是否真的新开了窗口/标签 |
| 后台跑目标命令 + 每 0.3s 采样前台 | 能抓到 2s 级别的瞬时抢占（只看首尾会漏） |

**可迁移规则**：

- **`open -g` 只保证冷启动不进前台，不保证「不激活已运行的应用」**——对已运行的 app 调用 `open` 就是激活它。
  任何「确保某 GUI app 在跑」的守卫逻辑，都必须先**可靠判定它是否已在运行**，否则守卫本身变成打扰源。
- **awk 块匹配 `lsappinfo list` 必须容忍行首空白**；这类「解析别人输出」的正则失效是**静默的**（不报错、只是永远走失败分支），
  必须用「已知有 GUI 时 `--check` 是否返回 0」这类**带正例的自测**才能发现。
- 凡是「每次调用都跑」的守卫脚本，必须验 **热路径耗时**（错误正则下约 18.6s/次）与**副作用**（open、窗口、焦点）。
- 「`open -g` 不抢焦点」的结论**只覆盖冷启动路径**，
  不能当通用结论沿用 —— **结论必须写清适用前提**。
- **修「过度打扰」类问题时，必须同时验证「该做的动作没被一起干掉」**：
  只加「有锁就不 open」而不校验 pid 存活，会让 stale lock 场景下的 Dock 保护失效。
  **正确性 = 不该动的不动 + 该动的照动**，只验前者等于没验。
- **测试装置本身要先自测**：shim 会因变量未导出而静默失效，导致「open=0」的假通过。
  凡是用 shim/桩做对照实验，先跑一次「确定该命中」的正例，确认桩真的被调用，再拿它下结论。
- **「换语言」很少是脚本 bug 的解**：文本解析脆弱（正则锚点）与逻辑错误（安全阀没校验 pid）是两个独立问题——
  前者靠**换判据**（换结构化数据源）解决，后者任何语言都会犯。Swift/Go 各两种实现的评估结论仍是维持 bash：
  **先问「瓶颈是语言还是判据/逻辑」**，再谈迁移。收益量级：换语言最多省 40ms，
  而修复每次调用省 18.6 秒、且不再抢焦点 —— 后者才是该投入的地方。


## 三、无 GUI 却未拉起 headed：PID 回绕复用与 open 缺 -n


**症状**：没有拉起 headed 浏览器就开始使用 headless 浏览器。

**根因链（三处缺陷叠加）**：

1. **安全阀误判：PID 回绕复用使得 `has_profile_lock` 恒为真**。
   - `has_profile_lock` 若仅用 `kill -0 "$pid"` 校验锁文件中的 PID 是否存活，就会误判。
   - macOS 的 PID 会回绕复用：Chrome 崩溃残留的 `SingletonLock -> yinghuoren.local-530`，其 PID 530 可能被系统常驻守护进程 `suggestd` 复用。
   - `kill -0 530` 恒返回 0（`suggestd` 存活）→ `chrome-guard` 误以为用户 Chrome 正在运行/启动中 → 触发安全阀分支：`profile 已锁定但检测不到 Foreground 条目，判定为注册延迟/口径差异；为避免抢焦点，不执行 open` 并直接 `exit 0`！
   - 导致 `chrome-guard` 永久跳过了对真实 GUI Chrome 的拉起。
2. **`open` 缺少 `-n`：当 headless 已经占领 bundle ID 时，普通 `open` 无法唤起新 GUI 实例**。
   - LaunchServices 按 `com.google.Chrome` 路由 `open` 命令；若 headless 已经在跑，`open -g -a "Google Chrome"` 只是向现有的无窗口 headless 进程发送 Open 事件（该进程忽略事件），根本不会 spawn 出真正的 GUI 进程，等满 15 秒超时失败。
   - 必须加 `-n`（`--new`）显式强制 LaunchServices 新建一个应用实例。
3. **残留锁文件阻碍 Chrome 启动**：
   - 若 `SingletonLock` 残留且指向存活的非 Chrome 进程，Chrome 启动时其自身 `ProcessSingleton` 连接套接字失败后可能报 `Failed to create .../SingletonLock: File exists` 中断启动。必须在启动前将陈旧的残留锁清理掉。

**现行实现（`~/.agents/bin/chrome-guard`）**：
1. **收紧 `has_profile_lock` 判据**：
   - 必须同时满足：① `kill -0 "$pid"` 存活；② 检查进程名/命令行（`ps -p "$pid" -o comm=` 或 `lsof`）确实包含 `Google Chrome`；③ 对应的 `SingletonSocket` 存在且为有效 UNIX Domain Socket（`[ -S ... ]`）。
2. **启动前清理陈旧残留锁**：
   - 若 `SingletonLock` 存在但 `has_profile_lock` 为假（无存活 Chrome 进程持有），在 `open` 前主动清理 `$PROFILE_DIR/Singleton*`。
3. **`open` 增加 `-n`**：
   - `open -n -g -a "Google Chrome"`，即使 headless 已经在跑，也能强制新建 GUI Chrome 实例并注册 `flavor=3 Foreground`，恢复 Dock 正常响应。

