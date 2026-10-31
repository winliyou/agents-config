---
name: sandbox-adaptation
description: DSH 沙盒下工具报「路径不可写」(EPERM) 时的处置：目录写权限需求一律加到 sandbox-extra-roots 插件配置（不重定向、不写工具特例）；另含嵌套沙盒、提权申请与诊断方法。触发：Operation not permitted / EPERM / not writable / Permission denied；命令在沙盒里失败但看起来像网络或协议错误；需要让某个 CLI 写 home 下目录；sandbox-exec / bubblewrap / 容器内运行工具报错。
---

# 沙盒模式适配（Sandbox Adaptation）

DSH 沙盒问题第一入口。**本机唯一首选解法：凡是「某个 home 目录不可写」的需求，直接把该目录加进 `@chaoset/sandbox-extra-roots` 配置即可——不要重定向缓存、不要为单个工具开特例、也不要在文档/skill 里为它专门写一段解法。**

## 一、目录写权限需求 → 加插件配置（唯一首选路径）

插件给 `workspace-write` 沙盒追加可写目录；官方白名单（workspace、/tmp 等）始终保留，只追加不替换。**热生效**（2026-10-27 实测改配置后约 3–5 秒新目录可写），无需重启。

**配置位置**（本机两个 profile 各一份，按需各自维护）：

- 桌面 App（当前 GUI 对话实际使用）：`~/.dsh/profiles/desktop/cordis.patch.yml`
- `dsh web`：`~/.dsh/profiles/web/cordis.patch.yml`
- 字段：`sandbox-extra-roots` 条目的 `config.extraWritableRoots`（绝对路径数组，支持 `~`；相对路径/空值被拒；`/`、盘根、主目录本身及其父目录等危险根被拒；系统目录被过滤；重复自动去重）。
- 官方入口：DSH 设置页 →「插件配置 → 沙盒额外允许目录」（写同一份配置；npm/pip/cargo/go 等常用缓存有一键预设）。
- 查当前进程用哪个 profile：`lsof -p <dsh 主进程 pid> | grep profiles`（cwd 即 profile 目录）。

**处置流程**：

1. 从报错里拿真实路径（在 workspace 外 + `operation not permitted`）。
2. 把该路径（或覆盖它的父目录，如整个 `~/Library/Caches`）加进**两个 profile** 的 `extraWritableRoots`；当前已放行清单直接读这两份文件，**配置即唯一事实源**。
3. 立即验证：`mkdir -p <dir> && touch <dir>/.probe` 成功，再重跑原本失败的真实操作（只跑 `--version` 不算验证）。
4. 不写特例、不重定向。以后需要哪个目录就加哪个。

**注意**：

- 只加确实需要「写」的缓存/状态目录；含明文凭据的目录谨慎列入，例如 `~/.docker/config.json`、`~/.npmrc`、`~/.cargo/credentials.toml`、`~/.aws`（按工具实际凭据文件判断，别整目录放行），`~/.gradle` 若将来放凭据需重新评估。读权限本就不受限，插件只管写。
- 不要用 `HOME`/`TMPDIR` 整体重定向当长期方案（会连带搬走其他工具的缓存与凭据路径）；仅当工具路径硬编码且无任何配置面时才用，且只对单条命令生效。
- 构建/测试等长命令不要用 `| tail` 收退出码（管道吞掉真实退出码，失败会被误判为成功）：`cmd > log 2>&1; echo "[exit=$?]"; tail log`，或 `cmd | tail; echo "[exit=${PIPESTATUS[0]}]"`。
- `~/.agent-browser` 是有意**不**放行的特例（不是单纯目录权限问题：放行会让 agent-browser 在沙盒内误启动、Chrome 因嵌套沙盒起不来），见 `browser-automation-safety` skill。

## 二、不是「目录权限」的沙盒问题

1. **嵌套沙盒冲突**（Chrome/Chromium、容器运行时自己的沙盒）：报错 `Failed to initialize sandbox` / `sandbox initialization failed: Operation not permitted` / GPU 进程崩溃，或表层只报 `CDP response channel closed`。目录重定向无效；现行正解是提权执行并保留原生沙盒（判定口径见本 skill 第四节；`browser-automation-safety` 只讲浏览器侧红线）。
2. **daemon/子进程在沙盒内起不来**（如 OrbStack `orbctl start` panic 在 `~/.orbstack/log` rename）：让 GUI/LaunchServices 拉起 daemon，不继承当前 shell 的限制：
   ```bash
   open -a OrbStack; sleep 5; docker info >/dev/null 2>&1 && echo docker-ok
   ```
   推广：Docker Desktop、DevEco Studio 等 GUI 应用同理。
3. **网络/协议/路径长度类报错**与沙盒无关：localhost 网络在沙盒内不受限，按 `network-access` 等 skill 排查。
4. 沙盒内 `/bin/ps` 常被拒（`/bin/ps: Operation not permitted`）：用 `pgrep -fl`、`lsof -p <pid>`、`lsof -nP -iTCP:<port> -sTCP:LISTEN`、`memory_pressure -Q` 替代。

## 三、诊断要点（别被表象带偏）

- 三分类：①路径权限失败（第一节）；②工具自身故障（参数/版本/网络/真 bug）；③嵌套沙盒子进程。
- 先读工具自己的日志/落盘输出，不要只看终端最后一行：很多 CLI 把「目录不可写」报成网络/协议错误（历史实例：bun 报 `tempdir EPERM` 实为包缓存、Chrome 表层报 `CDP response channel closed`、npm 报「root-owned files」）。
- **退出码会说谎**：`go vet` 曾打完 EPERM 仍 exit 0；构建失败被管道吞掉。判据看输出文本里是否出现 `operation not permitted`。
- 崩溃取证：`~/Library/Logs/DiagnosticReports/*.ips`（首行 header JSON + 正文 JSON）。

## 四、降低子进程沙盒的判定规则（本机已获用户授权，仅限 agent-browser/Chrome）

`--no-sandbox` 会降低子进程隔离等级。本机用户已对 **agent-browser / Chrome** 明确授权（原话：「我更需要自动化体验」，要求「运行环境已有沙盒就关掉 Chrome 沙盒，没有就别关」），**授权不外溢到其他工具**。**现行默认不需要关闭它**：浏览器调用走提权执行并保留原生沙盒（见 `browser-automation-safety` skill）；下表是「确需在受限沙盒内起子进程」时的判定口径与授权范围。

| 运行环境 | 处置 |
|---|---|
| 外层已有沙盒（DSH `workspace-write`） | 关闭子进程内层沙盒（Chrome `--no-sandbox`）——内层 Seatbelt 在外层内无法 apply |
| 外层无沙盒（用户终端手跑 / 提权执行） | 保留原生沙盒，不注入任何参数 |
| 不确定 | 视为「无外层沙盒」，保留原生沙盒（保守优先） |

探测「当前能否再创建一层 Seatbelt 沙盒」：

```bash
/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true
# 失败 / sandbox_apply: Operation not permitted → 已在沙盒内 ⇒ 外层有沙盒 ⇒ 可关内层
# 成功 (exit 0)                                → 无外层沙盒 ⇒ 保留原生沙盒
```

该自动注入逻辑现已从 wrapper 移除（现行路径：对单条命令提权执行、保留原生沙盒，见 `browser-automation-safety`）。**其他工具不适用此判定逻辑**，要关内层沙盒仍须先取得用户对该工具的明确同意。

## 五、边界（禁止事项）

- **不得自行放宽**：未经用户同意不得关闭/放宽外层沙盒、`chmod`/`chown`、用等价命令蒙混。**加 `extraWritableRoots` 是用户已授权的常规路径**（2026-10-27 用户明确：目录读写需求直接走插件配置，不必逐个描述），不算自行放宽。
- **关闭子进程内层沙盒**须用户对「该工具」明确同意（已授权范围见第四节）。
- **不得跳过功能验证**：失败就说明原因，不得用降级工具链、禁用检查等方式制造通过假象。
- 连插件配置都覆盖不到时（路径硬编码且无配置面、嵌套沙盒不可关）：向用户请求对**单条命令**的 `danger-full-access` 提权，并说明为何前面几条不适用。审批是设计好的用户决策点，不是障碍。
- `git worktree remove` 报 `Permission denied` 且残留 Go 模组缓存时：Go 模块缓存文件是 0444 只读，`chmod -R u+w <worktree>` 后再删（旧 worktree 的 `.workwork/` 缓存可能残留此类文件）。
- **反模式**：用 `GOCACHE`/`GOMODCACHE`/`npm_config_cache`/`HVIGOR_USER_HOME`/`DOCKER_CONFIG`/`ANDROID_USER_HOME`/`HOME` 重定向到 `.workwork/` 规避 home 不可写——已全部废弃，不要再写这类 export，也不要记进文档/skill；目录不可写按第一节加配置即可。
