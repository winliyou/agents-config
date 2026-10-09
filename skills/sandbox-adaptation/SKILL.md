---
name: sandbox-adaptation
description: 沙盒模式下工具报"路径不可写"时，把缓存/状态/套接字/临时目录重定向到 workspace 的通用方法。触发：Operation not permitted / EPERM / not writable / Permission denied / operation not permitted；命令在沙盒里失败但看起来像网络或协议错误；需要给某个 CLI 配置缓存目录或状态目录；sandbox-exec / bubblewrap / 容器内运行工具报错。
---

# 沙盒模式适配（Sandbox Adaptation）

本 skill 是遇到沙盒相关失败时的第一入口。核心：多数工具不是不能在沙盒里跑，只是把缓存/状态/套接字/临时目录默认放在 home 下；把目录重定向到 workspace 即可恢复完整功能。

### 核心原则

沙盒模式下（macOS sandbox-exec、Linux bubblewrap、容器等）通常只有 workspace（及白名单、临时目录）可写，home 下大量路径不可写。**多数工具并非"不能在沙盒里跑"，只是默认把缓存/状态/套接字/临时目录放在 home 下**。遇到这类失败，默认动作是**把该工具的这些目录重定向到 workspace**，让它在沙盒内完整可用——而不是放弃功能、关闭沙盒、放宽权限或用等价命令绕开。

判断标准：**如果失败信息指向"某个路径不可写"，那是配置问题，不是能力缺失**。目标是恢复功能，同时保持沙盒隔离有效。

### 第一步：先诊断，别急着改

- 区分三类失败，处理方式完全不同：
  1. **路径权限失败**（本节能解）：`Operation not permitted` / `EPERM` / `not writable` / `Permission denied` / `open ... : operation not permitted`，且路径在 workspace 之外。
  2. **工具自身故障**：参数错误、版本不兼容、网络失败、真实 bug——与沙盒无关，按正常排障处理。
  3. **子进程自带沙盒与当前沙盒嵌套冲突**：工具自己还要再起一层沙盒（常见于浏览器、容器运行时），报错形如 `Failed to initialize sandbox`。这属于第 2 类的特殊情形，处理方式见下文「实战案例：嵌套沙盒（Chrome）」。
- 拿到真实错误文本再动手：优先读工具自己的日志文件（很多 CLI 会把细节写进状态目录下），而不是只看终端那一行。失败时常有"看起来像网络/协议错误、实则是目录不可写"的误导性表象（如 `connection reset`、`CDP response channel closed`），**不要被表象带去排查网络或协议**。

### 第二步：找到工具的「配置面」

按优先级尝试，**能用官方配置机制就不要改环境或改 home**：

1. **专属配置文件 / 配置路径覆盖**——最稳。找 `--config <path>`、`<TOOL>_CONFIG`、`<TOOL>_HOME` 之类开关，把配置文件本身放进 workspace。
2. **专用环境变量**——指定单个目录的变量最精确（见下方类别）。注意有的工具要求环境变量在**每次调用**都一致，否则会因"配置变更"重启自身后台进程而断连；这类工具优先用配置文件。
3. **通用目录变量**——`TMPDIR`、`XDG_RUNTIME_DIR`、`XDG_CACHE_HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 等，很多工具遵循它们。
4. **`HOME` 整体重定向**——兜底手段。当工具把路径硬编码成 `~/.xxx` 且无任何专用开关时，把 `HOME` 指向 workspace 下目录可一次性解决全部 home 写入。代价是会同时改变该命令下所有工具对 home 的认知，**只对需要的那条命令生效，不要写入 shell 全局配置**。

找配置面不要靠猜：读工具的 `--help`、官方文档，或直接在其安装产物里搜变量名与配置键（`strings <binary> | grep -i -E "HOME|CACHE|STATE|SOCKET|CONFIG"`、翻 `node_modules/*/package.json`、`README`）。**以本机实测为准，不凭记忆假设字段名。**

### 第三步：常见需要重定向的目录类别

按类别逐一检查，通常只需处理报错点出的那一类：

| 类别 | 典型变量 | 建议落点 |
|------|----------|----------|
| 编译/包管理器缓存 | `GOCACHE`/`GOMODCACHE`、`CARGO_HOME`/`CARGO_TARGET_DIR`、`npm_config_cache`、`BUN_INSTALL_CACHE_DIR`（bun 实测有效，搭配 --cache-dir，见实战案例）、`GRADLE_USER_HOME`、`PIP_CACHE_DIR` | `.workwork/caches/<工具名>/`（持久、按工作树隔离） |
| 临时文件 | `TMPDIR` | `/tmp` 或 `.workwork/tmp/`（一次性） |
| 运行状态 / 套接字 / 进程间通信 | `XDG_RUNTIME_DIR`、工具自身的 `*_SOCKET_DIR`/`*_STATE_DIR` | workspace 下短路径目录（套接字路径有长度上限，目录名别太长） |
| 配置 / 数据 / 日志 | `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME` | workspace 下对应子目录 |
| 工具自有状态（无专用开关） | `HOME` 整体覆盖 | workspace 下专用目录 |
| Git 访问 ~/.gitconfig 被拦截 | `GIT_CONFIG_GLOBAL=/dev/null`（临时）或指向 workspace 配置（搭配 `-c user.name/email`） | 消除沙盒对主目录 `.gitconfig` 读取触发的 EPERM |
| 子进程自带沙盒（嵌套冲突） | 由工具参数关闭内层沙盒（如 Chrome `--no-sandbox`、部分工具的 `--no-sandbox`/`--disable-sandbox`） | **属降低隔离等级，须用户明确同意**；见下方「嵌套沙盒冲突」与「降低子进程沙盒的判定规则」 |

### 嵌套沙盒冲突：先怀疑它，再考虑提权

**症状极具误导性**：外层沙盒（sandbox-exec/bubblewrap）内的工具若自己还要再起一层沙盒，
可能报与沙盒毫不相干的错——实测 Chrome 报的是
`Failed to initialize sandbox`、`GPU process isn't usable`、
crashpad 写 `~/Library/... Operation not permitted`，
`agent-browser` 只在表层报 `CDP response channel closed`（**完全不提沙盒**）。

**诊断**：直接手动运行底层二进制（绕过包装器），看它自己的原始报错；
再用「单变量对照」确定哪个参数是必需的（例：只加 `--no-sandbox` 成功、
只加 `--disable-gpu` 失败 ⇒ 前者必需）。

**处置优先级（按序尝试，但第 3 条不是"不得已的例外"）**：
1. **目录重定向**（无论如何都先做，无损、可长期固化）；
2. **关闭子进程内层沙盒**——仅在「外层确有沙盒」且**该工具已获用户同意**时（判定规则与已授权范围见下节）；
3. **向 harness 请求更宽松的沙盒权限**（对单条命令申请 `danger-full-access` 等）——当 1–2 都**达不成目标**时，这是**正当且干脆的常规路径**，不要卡死也不要回避；请求会作为审批呈现给用户，由用户拍板。

> **不要因为"提权要审批"就长期不使用它**：审批本身是设计好的用户决策点，不是障碍。
> 判据是**功能是否真的跑不通**：
> - 能靠重定向/关内层沙盒解决 → 优先那样做（一次配置、长期无感）；
> - 确实解决不了 → **直接请求授权**，并说明为何前两条不适用。
> 实测：agent-browser 在 `workspace-write` 下用
> `AGENT_BROWSER_SOCKET_DIR` + `--profile` + `AGENT_BROWSER_ARGS=--no-sandbox`
> 即可零提权完整工作（已获用户授权；详见 `browser-automation-safety` skill）
> ——这是"能重定向就别提权"的正面例子，不是"禁止提权"的理由。

### 第四步：验证必须落到真实功能

- 映射前先 `mkdir -p` 目标目录；映射后用工具自带命令确认生效（如 `go env GOCACHE`）。
- **只跑 `--version`/`doctor` 不算验证**：必须重新执行原本失败的那个真实操作用例，并确认产物确实落在 workspace 内（缓存文件、截图、报告、生成物等）。
- 验证不通过就停止并说明，不要层层加码试参数——先回到「诊断」重新定位。

### 第五步：固化，避免每次重新摸索

- 只要某个工具需要固定的一组重定向，就把它写成**项目内可复用的包装脚本**（或项目级配置文件），让后续 `bun run`/`make` 之类的入口默认带上；用一次手拼环境变量充当验证可以，但不要把"每次手拼"当成长期方案。
- 工具启动后台守护进程时优先用配置文件而非环境变量（环境变量只对单条命令生效，第二条命令缺失变量会触发"配置不一致"重启与断连）。
- 这些中间产物写进 `.workwork/`（按工作树隔离），不入库。

### 实战案例：嵌套沙盒（Chrome，2026-09-25 实测）

**特征**（EPERM 与沙盒初始化失败并存）：
- 启动日志同时出现 `open ~/Library/...: Operation not permitted`（如 Crashpad 的 settings.dat）与 `sandbox initialization failed: Operation not permitted` / `Failed to initialize sandbox`，随后进程秒退；
- 误导性表象：DevToolsActivePort 不写、调试端口短暂监听后消失、DiagnosticReports 里 GPU helper SIGABRT——极易误判为 GPU 冲突或路径问题，实为嵌套沙盒连坐。**目录重定向救不了它**：Chrome helper 的内层 seatbelt 在外层沙盒内无法 apply，`--crash-dumps-dir` 等重定向只能消噪音。

**取证方法**：
- spawn 时把子进程 stderr 落到 workspace 文件（如 `--enable-logging=stderr` + stdio 重定向），一次运行即得决定性错误，不要盲猜 GPU/网络/路径；
- 沙盒常禁 `ps`（`/bin/ps: Operation not permitted`）：用 `lsof -iTCP:<port> -sTCP:LISTEN` 查监听者，`lsof -p <pid> -d txt/cwd` 推断二进制与工作目录，`lsof -p <pid> | grep 目录特征` 判断 profile 归属；
- 崩溃细读 `~/Library/Logs/DiagnosticReports/*.ips`（首行 header JSON + 正文 JSON，含 parentProc/exception/termination）；
- 沙盒内 localhost 网络（HTTP/WS/fetch）不受限：连通性用 curl/fetch 实测。本次「WS 连不上」实为 Chrome 111+ 只认带 UUID 的 browser WS 路径（短路径 404），并非沙盒网络限制。

**为何不可解（停止尝试的时机）**：
- `launchctl bootstrap gui/<uid>` 从沙盒内提交也失败（I/O error 5）——launchd 代理路径被断；
- `--no-sandbox` 属降低子进程隔离等级，须用户明确同意，默认不选（判定规则见下节）。

**正确出路**（按优先级）：
1. 请用户在自己的终端跑一键脚本，在沙盒外拉起实例（如 gemini-gen 的 chrome-start.sh：清残留 Singleton 锁 → open -gna 后台拉起不抢焦点 → 等端口就绪）；daemon 侧只做端口探测与清晰报错指引，不做启动重试。
2. 经用户同意后，仅对**启动命令**申请单次完全访问权限（等同用户手跑），日常运行回到受限模式。

### 实战案例：bun install 报 tempdir EPERM（2026-09-25 实测）

**误导性表象**：`bun install` 报 `error: bun is unable to write files to tempdir: EPERM`，看似临时目录问题；但把 `TMPDIR` 重定向到 workspace 后**依旧报同样错误**（用 `bun -e` 写 `os.tmpdir()` 探测明明可写）。

**真因**：写不进去的是 **`~/.bun/install/cache`**（包缓存，home 下），错误文案却说成 tempdir——bun 的错误归因有误导。

**解法**（零提权，缓存也落 workspace）：

```bash
mkdir -p .workwork/tmp .workwork/bun-cache
TMPDIR=$PWD/.workwork/tmp BUN_INSTALL_CACHE_DIR=$PWD/.workwork/bun-cache \
  bun install --cache-dir $PWD/.workwork/bun-cache
```

实测通过（294 包安装成功）；`BUN_INSTALL_CACHE_DIR` 环境变量与 `--cache-dir` 旗标任一即可，两者都给最稳。注意旧表格里的 `BUN_INSTALL_CACHE` 拼写未经实测，勿照抄。

### 实战案例：Android Gradle debug keystore（2026-09-29 实测，media_center）

**表象**：沙盒内 `./gradlew :app:assembleDebug` 在 `validateSigningDebug` 报
`Unable to create debug keystore in /Users/liyou/.android because it is not writable`。

**只重定向 HOME 不够**：`HOME=$ws/.workwork/fakehome`（内含既有 `.android/debug.keystore`）后重跑**仍报原路径**——AGP 解析 `.android` 目录不走 HOME，走 `ANDROID_USER_HOME`。

**解法**（零提权，环境变量一次给齐）：

    export HOME=$ws/.workwork/fakehome \
      ANDROID_USER_HOME=$ws/.workwork/fakehome/.android \
      ANDROID_SDK_HOME=$ws/.workwork/fakehome \
      GRADLE_USER_HOME=$ws/.workwork/gradle-home \
      ANDROID_HOME=~/Library/Android/sdk
    JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:assembleDebug :app:testDebugUnitTest --no-daemon

实测注入 `ANDROID_USER_HOME` 后 `validateSigningDebug` 立即通过（`ANDROID_SDK_HOME` 为 legacy 一并设置无害）。**坑**：同一句 `export HOME=... ANDROID_HOME="$HOME/..."` 里 `$HOME` 已是 fakehome，SDK 路径要用绝对路径另写。

**同会话实测补记**：
- Go：`GOMODCACHE`/`GOCACHE` 重定向 `.workwork/` 即可；**目录名多会话保持一致**——`gomodcache` 与 `go-mod-cache` 并存会白占一倍磁盘（417M×2，2026-09-29 发现）；
- 系统 python3（CLT）跑 `py_compile` 写 `~/Library/Caches/com.apple.python` → `PYTHONPYCACHEPREFIX=$ws/.workwork/pycache`；
- uv：`UV_CACHE_DIR=$ws/.workwork/uv-cache`，venv 本体放 `.workwork/<名>-venv`（勿建进仓库目录，会污染 git status）。

**GOCACHE 必须用绝对路径（2026-10-02 实测）**：`export GOCACHE=$PWD/../../../.workwork/gocache`
这类**相对路径**在 `cd services/<svc>` 之后会被解析成 workspace 内的深层路径，
Go 报 `failed to initialize build cache at ...: mkdir ...: operation not permitted`——
**看着像"缓存不可写"，实为相对路径把缓存指到了未获授权的目录**。改用绝对路径即通。
判据：报错路径里出现 `../../../` 或与你 cd 的目录拼出来的怪路径，就是它。

### `git worktree remove` 失败：Go 模块缓存是只读的（2026-10-02 实测）

**表象**：worktree 已合并、分支已删、`git worktree list` 也已注销，但
`git worktree remove` 报 `failed to delete ...: Permission denied`，
残留目录可达数百 MB（本次 478M）。

**根因**：不是 git 的权限问题，而是该 worktree 内 `.workwork/gomodcache/` 下的
**Go 官方模块缓存文件是 0444 只读**（Go 故意设为只读防篡改），`rm` 删不掉。

**解法**（零提权，产物已合并时安全）：
```bash
chmod -R u+w <worktree路径>   # 先解除只读
rm -rf <worktree路径>
```
注意顺序：git 已注销 worktree 时目录只是"孤儿文件"，直接 `rm -rf` 即可；
若仍注册在 `git worktree list` 里，才需要 `git worktree remove`。
清理后复查 `git worktree list` + `git branch` + `docker ps` 三处无残留。

### 实战案例：npm cache EPERM 且报错误导为「root-owned files」（2026-09-28 实测）

**表象**：沙盒内任何 npm 命令（含脚本内部 spawn 的 `npm view`/`npm pack`）报
`EPERM ... path /Users/<you>/.npm/_cacache/tmp/...`，且固定附带一段
「Your cache folder contains root-owned files... please run: sudo chown -R ...」——
**照做就中了误导**：沙盒场景的根因是 `~/.npm` 整体不可写，与文件属主无关。

**解法**（零提权）：

```bash
mkdir -p .workwork/npm-cache
export npm_config_cache=$PWD/.workwork/npm-cache
```

实测：dsh-plugins 仓库的 `bun run dsh-status`（内部 spawn `npm view` 查 registry）
与 `npm pack` 全部恢复可用；npm 的日志目录（默认 `~/.npm/_logs`）也随缓存变量
一并落到重定向目录，不再刷 EPERM。**注意环境变量要真正传进子进程**：
`env${其他}cmd` 这种把变量名和 `env` 写连的笔误会把赋值变成普通命令而静默失效，
用 `export` 最稳。

### 实战案例：`docker compose build` 报 buildx activity EPERM（2026-10-03 实测）

**表象**：沙盒内构建生产镜像时输出

```
failed to update builder last activity time: open /Users/<you>/.docker/buildx/activity/.tmp-default3364062676: operation not permitted
```

镜像名后面只停在 `Building`，**没有任何镜像产出**。

**最坑的一点是它"返回成功"**：命令若写成
`docker compose ... build ... | tail -25`，读到的是 `tail` 的退出码，构建失败被管道吞掉
（实测 exit 0 + 零产物，极易误判成"本地镜像已验证"，进而带着假结论去打发布 tag）。
凡是把构建/测试输出接 `| tail`/`| head`，都必须显式取真实退出码：

```bash
cmd > log 2>&1; echo "[exit=$?]"; tail -n 20 log   # 落盘后取真实退出码
# 或 bash 下：cmd | tail -25; echo "[exit=${PIPESTATUS[0]}]"
```

**根因**：buildx 把构建器活动状态写在 `$DOCKER_CONFIG/buildx/`（默认 `~/.docker/buildx/`），
home 下不可写——与构建本身无关。

**解法**（零提权，把 docker CLI 配置目录整体重定向到 workspace）：

```bash
export DOCKER_CONFIG=$PWD/.workwork/docker-config
docker compose --profile prod build backend frontend-build
```

**注意事项**：
- `DOCKER_CONFIG` 同时承载 registry 凭据（`config.json`）。重定向到空目录后**拉取私有镜像会失权**；
  基础镜像已在本地缓存时无影响（先 `docker images` 确认，别误判成网络问题）。
- 验证必须落到**产物**：`docker images` 里确实出现目标 tag，且
  `docker inspect <img> --format '{{index .Config.Labels "org.opencontainers.image.version"}}'`
  等于候选版本，才算构建成功。

### 降低子进程沙盒的判定规则（本机已获用户授权，2026-09-25）

**背景**：`--no-sandbox` 这类参数会降低子进程的隔离等级，原始规则是「须用户明确同意，默认不选」。本机用户已就 **agent-browser / Chrome** 这一场景明确授权自动化（原话：「我更需要自动化体验」，并要求「运行环境已有沙盒就关掉 Chrome 沙盒，没有就别关」）。**该授权仅限下述范围，不外溢到其他工具。**

**判定规则（三选一，按环境自动决定）**：

| 运行环境 | 处置 | 理由 |
|---|---|---|
| **外层已有沙盒**（如 DSH `workspace-write`） | 关闭子进程内层沙盒（Chrome `--no-sandbox`） | 内层沙盒在 macOS Seatbelt 下**根本无法初始化**，关了浏览器才能起；隔离仍由外层提供，总防护层数不减少 |
| **外层无沙盒**（用户手动在终端跑、或提权执行） | **保留子进程原生沙盒，不注入任何参数** | 此时没有外层兜底，保留原生沙盒才是正确安全姿态 |
| 不确定 | 视为「无外层沙盒」，保留原生沙盒 | 保守优先，避免无谓削减隔离 |

**探测手段**——测「当前能否再创建一层 Seatbelt 沙盒」，而不是猜：

```bash
/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true
# 失败 / sandbox_apply: Operation not permitted  → 已在沙盒内 ⇒ 外层有沙盒 ⇒ 可关内层
# 成功 (exit 0)                                 → 无外层沙盒   ⇒ 保留原生沙盒
```

**已固化**：`~/.local/bin/agent-browser` 包装器自动执行上述探测与注入，用户无需每次干预；`AGENT_BROWSER_CHROME_SANDBOX=native` 可强制保留原生沙盒。**其他工具不适用此自动逻辑**——若要关闭某工具的内层沙盒，仍须先取得用户对该工具的明确同意。

**新增场景的处置**：遇到别的新工具出现同类嵌套冲突时，**先取得用户同意**再关其内层沙盒，并把结论与授权范围补记到本节。

### 边界（禁止事项）

- **不得"自行"绕过**——未经用户授权，不得关掉/放宽外层沙盒、给 home 加写权限、`chmod`/`chown` 等。**注意区分两件事**：
  - ❌ **自己绕开**（悄悄放宽、改权限、用等价命令蒙混）——禁止；
  - ✅ **向 harness 请求授权**（申请更宽松权限、或问用户要白名单/脚本）——**鼓励，且是常规路径**。
  本节的目的是让工具适配沙盒，而不是让 sandbox 悄悄失效——"先问再放宽"完全符合本节。
- **不得跳过功能验证**：失败了就说失败并给出原因，不要用"降级工具链、改配置绕过检查、禁用 lint/测试"之类手段制造通过假象。
- 子进程自带沙盒（如浏览器引擎的沙盒）与当前沙盒嵌套冲突时，**降低子进程沙盒属于降低隔离等级**，需要明确权衡并说明理由与影响面（仅影响该子进程、是否在本地调试环境等）；能用其他方式（重定向目录、调整启动参数）解决时优先用其他方式，**但用户已授权或用户另行同意时不必顾虑**。
- 工具确实没有任何可重定向的配置面（路径硬编码且不可配）时，**向用户说明并请求授权**（把该路径加入白名单、对单条命令放行更宽松权限、或请用户在沙盒外执行），而不是自行绕过、也不是就此放弃。
