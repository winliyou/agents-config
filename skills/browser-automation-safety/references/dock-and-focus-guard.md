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

**chrome-guard 的判定因此要收紧**：不能只认 `type="Foreground"`，必须认 `flavor=3`；只判 `type="Foreground"` 会被 headless 骗过而误判「GUI 已存在」。

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


## 二、第二类抢焦点源头：chrome-guard 判定失效


**症状**：用浏览器自动化时频繁抢焦点、窗口乱跳。

**规则：下面两条必须同时成立，chrome-guard 才不是打扰源；任一不成立都会让守卫自己触发抢焦点**：

1. **解析 `lsappinfo list` 必须容忍行首空白**。条目行形如 ` 9) "Google Chrome" ASN:…`；用 `awk '/^[0-9]+\\) "Google Chrome"/'` 这类 `^` 锚点永不命中 → `--check` 恒 exit 1 → 守卫误判「无 GUI 实例」→ **每次自动化调用**都执行 `open -g -a "Google Chrome"`；`open` 对已在运行的应用 = 激活窗口 = 抢焦点。正确正则：`/^[[:space:]]*[0-9]+\\) "Google Chrome"/`（块结束行同理）。
   复现命令（空 = 正则未命中）：
   ```bash
   lsappinfo list | awk '/^[0-9]+\\) "Google Chrome"/{print "命中"}'; echo "（空 = 正则从未命中）"
   ```

2. **安全阀必须校验锁里的 pid 是否存活**。profile 被存活进程持有时，即使判定不到 Foreground（注册延迟/口径差异）也不执行 open；只判断「`SingletonLock` 文件是否存在」会在 **stale lock**（Chrome 崩溃/被杀后锁残留、pid 早已不存在）时也拒绝 open——把「频繁抢焦点」换成「点 Dock 打不开 Chrome」，属更严重回归。正确实现：

   ```bash
   has_profile_lock() {
     local lock="$PROFILE_DIR/SingletonLock" pid
     [ -L "$lock" ] || [ -f "$lock" ] || return 1
     pid="$(readlink "$lock" 2>/dev/null | sed 's/.*-//')"   # 锁内容形如 "hostname-<pid>"
     case "$pid" in ''|*[!0-9]*) return 1 ;; esac
     kill -0 "$pid" 2>/dev/null                              # pid 存活才算「进程持有」
   }
   ```

**验证（每次改守卫都跑）**：

- `~/.agents/bin/chrome-guard --check` 应 exit 0；
- 用 `open` 的 PATH shim 记录调用次数：正常路径应为 **0 次/调用**。shim 必须先跑「确定该命中」的正例自测（A=1），确认桩真的被执行，否则会得到「0 次」的假通过；
- `agent-browser tab list` 连续执行期间 `lsappinfo front` 保持不变（抓 2s 级瞬时抢占，不能只看首尾）；
- 隔离测试（假 `open` + 假 profile）覆盖四场景：正常（GUI 检测成功 → 不 open）、注册延迟（有锁 + pid 活 → 不 open）、stale lock（有锁 + pid 死 → **必须 open**）、真没开（无锁 → **必须 open**）。


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
- 凡是「每次调用都跑」的守卫脚本，必须验**热路径耗时**与**副作用**（open、窗口、焦点）；解析失败会让每次调用都触发 `open` 与超时等待。
- 「`open -g` 不抢焦点」的结论**只覆盖冷启动路径**，
  不能当通用结论沿用 —— **结论必须写清适用前提**。
- **修「过度打扰」类问题时，必须同时验证「该做的动作没被一起干掉」**：
  只加「有锁就不 open」而不校验 pid 存活，会让 stale lock 场景下的 Dock 保护失效。
  **正确性 = 不该动的不动 + 该动的照动**，只验前者等于没验。
- **测试装置本身要先自测**：shim 会因变量未导出而静默失效，导致「open=0」的假通过。
  凡是用 shim/桩做对照实验，先跑一次「确定该命中」的正例，确认桩真的被调用，再拿它下结论。
- **「换语言」很少是脚本 bug 的解**：文本解析脆弱（正则锚点）与逻辑错误（安全阀没校验 pid）是两个独立问题——前者靠**换判据**（换结构化数据源）解决，后者任何语言都会犯。**先问「瓶颈是语言还是判据/逻辑」**，再谈迁移；换语言收益是毫秒级，而修复守卫失效省下的是每次调用的秒级等待与抢焦点，后者才值得投入。


## 三、无 GUI 却未拉起 headed：三条必须同时满足的规则


**症状**：需要 GUI Chrome（或用户点 Dock）时，只有 headless 实例，没有真 GUI 窗口。

**规则（三条同时满足才生效，任一缺失都会让 chrome-guard 失效）**：

1. **`has_profile_lock` 必须同时校验 PID 存活与进程身份**：只做 `kill -0 "$pid"` 会误判——macOS 的 PID 会回绕复用，崩溃残留的 `SingletonLock -> yinghuoren.local-530` 中的 PID 530 可能被 `suggestd` 等常驻进程复用，`kill -0` 恒为真 → 守卫误以为 GUI 正在启动 → 安全阀直接 `exit 0`，永久跳过拉起。必须同时满足：① `kill -0 "$pid"` 存活；② 进程名/命令行（`ps -p "$pid" -o comm=` 或 `lsof`）确实包含 `Google Chrome`；③ 对应的 `SingletonSocket` 存在且为有效 UNIX Domain Socket（`[ -S ... ]`）。
2. **`open` 必须带 `-n`（`--new`）**：headless 已占用 `com.google.Chrome` 时，普通 `open -g -a "Google Chrome"` 只是向现有无窗口 headless 进程发 Open 事件（该进程忽略），不会 spawn 真 GUI，等满 15 秒超时；`open -n -g -a "Google Chrome"` 才会强制 LaunchServices 新建 GUI 实例并注册 `flavor=3 Foreground`。
3. **启动前清理陈旧残留锁**：若 `SingletonLock` 存在但 `has_profile_lock` 为假（无存活 Chrome 进程持有），先 `rm -f` 该 profile 下 `Singleton*`；否则残留锁指向存活的非 Chrome 进程时，Chrome 自身的 `ProcessSingleton` 连接套接字失败，可能报 `Failed to create .../SingletonLock: File exists` 中断启动。

**验证**：`~/.agents/bin/chrome-guard --check` exit=0；`open -a "Google Chrome"`（等价点 Dock）exit=0 且 `lsappinfo list` 出现 `type="Foreground" flavor=3`；`agent-browser tab list` 期间 `lsappinfo front` 不变。

