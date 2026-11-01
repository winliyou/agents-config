---
name: remote-heavy-offload
description: 把高负载/消耗性能的任务从 macOS 丢到远程 Linux 主机执行（远程 dsh web GUI、headless 批处理、项目同步/回传），避免本机因构建、测试、agent 会话、浏览器自动化等重活卡死。触发：本机跑重任务卡顿；想把构建/测试/agent 放到远程；远程跑 dsh headless；项目同步到远端跑完再取回；ssh 隧道打开远程 dsh GUI；远程重负载任务管理/清理。
---

# 远程重负载卸载（Remote Heavy Offload）

把**重活**放到远程 Linux（192.168.2.3，Arch on WSL2）执行，macOS 只留浏览器/终端/隧道。

主机事实（IP、端口、systemd unit、路径、凭据位置）见 `local-environment` skill 的「远程开发主机」一节；本文只写可复用流程。
环境本身怎么迁移/部署见 `remote-agent-env` skill。

## 判断：什么放远端、什么留本机

| 负载 | 建议 |
|---|---|
| AI agent 会话（工具执行、长时间任务、subagent/Team） | **远端 dsh web / headless**；本机只开浏览器或 ssh |
| 构建/测试/打包（JS/Go/Rust/Java/Android/Gradle/Godot 导出） | **远端**：`offload.sh run` 或远端 agent 会话 |
| 大批量文件扫描/grep/编译、Docker 构建 | **远端**（本地 docker 也吃内存） |
| 无头浏览器自动化/爬取（Chromium headless） | **远端**（chromium 已装；Playwright 在项目里装） |
| 文本编辑/看 diff/轻量命令 | 本机即可；或用 VS Code Remote-SSH 直连远端编辑 |
| GUI 应用、Android/DevEco 模拟器、需要显示器的工具 | **不能放远端**：WSL2 无 X11/Wayland，且没有 `/dev/kvm`（模拟器无硬件加速，实际不可用）。这类任务留在 Mac 或 Windows 侧跑。 |

> 本机卡顿的主要来源通常不是 LLM（推理本来就在云端），而是本地 dsh 进程、子 agent、工具执行（构建/扫描）、浏览器自动化、模拟器/容器。把**工具执行与 agent 会话**整体搬到远端最省事。

## 让本地 lead 把远端当子代理（MCP，推荐）

本机 dsh 通过 MCP 把远端当作**远程子代理**直接调用，工具名形如 `mcp__remote__remote_start_task`：

```
本地 dsh 会话（lead） ──MCP(stdio)──> 本机 MCP server ──ssh──> 远端 dsh headless 会话（持久，可续接）
                                      └── 任务目录在远端 ~/.dsh-offload/jobs/<job>/
```

### 资源池 v1（当前：单执行器）

资源池遵循**显式允许清单、默认拒绝**：可访问 ≠ 可调度。清单文件 `~/.dsh/fleet-hosts.json`（MCP server 每次调用都会校验，未授权主机直接报错、不会尝试 ssh）。

| 角色 | 主机 | 说明 |
|---|---|---|
| lead | Mac M1（本机） | 规划/审阅/GUI 验证/凭据/发布，不跑重负载 |
| executor | `exec-arch`（WSL Arch，192.168.2.3） | 唯一执行器；8C/8GB，Linux 构建测试/Docker/Android CLI/Godot/无头浏览器 |

明确排除（已写入清单 `excluded`，不要在未确认时加入）：
- `workwork-server`（生产 VPS：4 套服务/15 容器，禁止跑构建）；
- `Ubuntu-YaXin` / `ArchLinux-WuLongTou`（非本人账号 lsyb，且不可达）；
- `windows-host`（暂不使用 Windows 侧与 GPU，只用其 WSL 发行版）。

**并发保护**：每个执行器默认最多 1 个重任务（`limits.maxHeavyJobs`）。第二个 `remote_start_task` 会被拒绝并提示已有任务；确需并行才传 `force:true`。`remote_task_followup` 同样检查其他运行中任务。

**job 名规范化**：start 返回 `job-xxx`；`status/followup/cancel/diff` 传 `xxx` 会自动补 `job-` 前缀。

未来加主机（按需、需明确授权）：在 `fleet-hosts.json` 的 `hosts` 增加一条（含 ssh/role/limits/authorized=true），再给本地 profile 加一行 MCP 配置即可，无需改 MCP 代码。

### 启用（无需安装，全部在 skill 内）

MCP server 以**单文件 bundle** 形式放在 skill 目录，profile 的 `command` 直接指向该目录的 `run.sh`：
`/Users/liyou/.agents/skills/remote-heavy-offload/scripts/mcp-server/run.sh`

把 `scripts/mcp-server/profile-row.yml` 的内容追加到目标 profile 的 `cordis.patch.yml` 末尾
（`~/.dsh/profiles/desktop/cordis.patch.yml` 与/或 `~/.dsh/profiles/web/cordis.patch.yml`），
重启 dsh 应用（或等 profile HMR 热加载），**新开会话**即可在工具列表看到 `mcp__remote__*`。

- 依赖已打包进 `server.bundle.mjs`（约 0.75MB）：**不需要 node_modules、不需要安装步骤**；
- 修改 `server.mjs` 后运行 `bash ~/.agents/skills/remote-heavy-offload/scripts/mcp-server/build.sh` 重新打包
  （需要 bun；首次构建会自动 npm install 打包依赖，`node_modules/` 已在 `.gitignore`）；
- **资源池允许清单在 `~/.dsh/fleet-hosts.json`**（机器本地配置，不进仓库；默认拒绝未授权主机）。

### 工具

| 工具 | 用途 |
|---|---|
| `remote_status` | 远端健康（负载/内存/磁盘/服务/工作区） |
| `remote_start_task({task, project?, name?, force?})` | **异步**启动远程子代理任务，立即返回 job；默认受并发上限保护 |
| `remote_task_status({job})` | running/done/failed + `answer`/`lastText`/`errorTail` |
| `remote_task_followup({job, task, wait_sec?})` | **同一会话继续追问**（上下文保留；可阻塞等待） |
| `remote_task_cancel({job})` | 取消当前轮（保留会话与任务目录） |
| `remote_run({command, project?, timeout_sec?})` | 同步执行 shell（构建/测试/查看） |
| `remote_diff({job, include_patch?})` | **取回远端子代理产生的改动**（baseline 起算的 git diff patch + 文件列表） |
| `remote_sync` / `remote_pull` | 本地目录 ⇄ 远端工作区（走 offload sync/pull） |
| `remote_jobs` | 列出远端所有任务与状态 |

### 典型协作模式（本地 lead 视角）

```
# 1) 派活（异步，立即返回 job，本地不阻塞）
remote_start_task({task: "跑 dsh-plugins 全量测试，定位失败并给出修复建议", project: "dsh-plugins", name: "test-run"})
# 2) 轮询
remote_task_status({job: "test-run"})            # running / done / failed
# 3) 一次没解决就继续追问（同一会话）
remote_task_followup({job: "test-run", task: "按你的分析修复并重跑，把 commit hash 给我", wait_sec: 900})
# 4) 必要时取消 / 取回产物
remote_task_cancel({job: "test-run"})
remote_pull({remote_name: "dsh-plugins", local_path: "~/work/dsh-plugins"})
```

- 并行任务用不同 `name` 各开 job；同一 job 内是顺序续接，不会并发。
- 任务状态/日志/会话 id 都在远端 `~/.dsh-offload/jobs/<job>/`（`run-N.log` 为 JSON 事件流）。
- MCP server 每次调用内部 `ssh -n`，不依赖本机常驻隧道；断网时工具返回错误而不是挂死。

## 协调本地与远端子代理（环境不一致怎么办）

本地 macOS 与远端 Linux 的**工具链、原生依赖、能力边界**都不同，原则是：

> **同一份工作树同一时间只有一个写入者；环境差异靠「能力矩阵路由 + patch 交接」解决，不靠两边各改一半再对撞。**

### 能力矩阵（按任务路由）

| 任务 | 本地 macOS | 远端 Linux |
|---|---|---|
| GUI / 浏览器自动化 / Android/DevEco 模拟器 / macOS 专属构建（Xcode、签名） | ✅ 只有本地能做 | ❌ 无 GUI、无 KVM |
| Linux 构建/测试、Docker、批处理、无头浏览器、大 CPU/内存任务 | 能跑但吃资源、会卡 | ✅ 推荐 |
| 私有仓库拉取/发布/推送（github 凭据） | ✅ 本机有凭据 | ❌ 无凭据 |
| 最终合并、提交历史、发布决策 | ✅ lead 在本地做 | ❌ 不建议 |
| 工作树事实源 | **本地仓库**（用户手动改的那份） | 远端副本（任务期间临时） |

### 交接协议（patch 回传，默认，零冲突）

1. **派活**：lead 调 `remote_start_task({task, project, name})`。MCP server 在任务启动时记录该项目的 git 基线
   （`git stash create` 快照，无改动则用 HEAD），存到远端 job 目录 `base`。
2. **远端干活**：远端子代理只改远端 `<workspace>/<project>` 里的副本；**任务期间本地不要手改同一项目**（改别的项目/文件不受影响）。
   一次没做完用 `remote_task_followup` 继续（同一会话、同一工作树）。
3. **取回改动**：`remote_diff({job})` 返回相对基线的 `git diff` 补丁 + `git status` 文件列表 + 统计。
4. **本地审核合入**：本地 lead 读 patch / 跑本地检查 → `git apply` 或手工合入本地仓库 → 本地提交。
   **不要让远端直接覆盖本地工作树**（`remote_pull --clean` 只用于明确要镜像整个目录的场景）。
5. **需要本地验证的环节**（模拟器、GUI、浏览器、签名）由本地 lead 或本地子代理在合入后执行；远端只负责构建/测试。
6. **并行**：不同 job 用不同 `project`（或不同目录副本），绝不让两个 job 同时写同一工作树；同一项目要并行时先 `remote_sync` 出两个副本再分别跑。

```
# lead 视角：一次完整的「远端改 → 本地审 → 本地验证」
remote_start_task({task: "修复 xxx 的 3 个失败用例，改完在远端 bun test 通过", project: "dsh-plugins", name: "fix-tests"})
remote_task_followup({job: "fix-tests", task: "还差一个用例，继续修", wait_sec: 600})
remote_diff({job: "fix-tests"})             # 拿 patch + 文件列表
# 本地：git apply 该 patch → 本地跑一次快速检查/需要 GUI 的验证 → git commit
```

### 环境差异的处理约定

- **依赖**：以仓库 lockfile 为准，远端用 `--frozen-lockfile` 按锁文件装；**不要跨平台复制 node_modules**（原生模块/optionalDependencies 不同）。
- **工具链**：远端已装 JDK21/Android SDK/Godot mono/.NET/Rust/常用 CLI；macOS 专属工具只在本地。差异写进 `local-environment` 远程节。
- **行为差异**：换行符、大小写敏感、路径分隔符、locale（远端 `LANG=en_US.UTF-8`）、时区（Asia/Shanghai）——在远端跑测试时若出现平台相关失败，先在本地复跑确认是否环境导致，再判断代码问题。
- **凭据**：远端无 git 凭据；发布/推送一律回本地做。远端任务产物用 patch 或 `remote_pull` 取回，不依赖远端 push。

### 与本地子代理（Agent Teams）的分工

- 本地 team 子代理：审阅本地文件、跑本地 GUI/模拟器验证、需要 macOS 权限或凭据的操作。
- 远端子代理（MCP job）：构建/测试/批量/长任务，产出 patch 与测试结论。
- lead：派活 → 轮询/追问 → `remote_diff` 合入 → 本地最终验证 → 提交；本地与远端**不要同时写同一文件**。
- 本地子代理是否继承 MCP 工具取决于宿主工具集：若它们看不到 `mcp__remote__*`，由 lead 代为调用，或让它们用 `~/.local/bin/offload` CLI。

### 验证

```bash
pgrep -f 'mcp-server/server.bundle.mjs' | wc -l     # >0 说明 MCP server 已被 dsh 拉起
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' --profile web --dump-config | grep -A6 mcp-remote-subagent
# 新开会话后：工具列表出现 mcp__remote__remote_status 等
```

## 三种用法（按场景选）

### A. 远程 dsh web GUI（交互式重活，推荐）

本机只跑浏览器 + ssh 隧道：

```bash
ssh -N dsh-arch                        # 已配 LocalForward 18765 -> 远端 8765；约 5s 起
offload.sh url                         # 打印带 token 的 URL（已改写成本地 18765；含凭据，勿外传）
# 浏览器打开该 URL；换取 cookie 后（30 天有效，跨重启）可直接书签 http://127.0.0.1:18765/
```

- 首次打开是「选择工作区」：选 `/home/liyou/workspace` 或其下项目目录；之后的 agent 会话、构建、文件操作全在远端。
- 本机不要同时再开一个重的本地 dsh 会话做同一件事，否则本机照样卡。

### B. headless 批处理（后台长任务，无需浏览器）

```bash
offload.sh headless '把 workspace 下 xxx 项目跑一遍测试并把失败用例整理出来'
```

- 等价于远端 `cd /home/liyou/workspace && dsh headless "<task>"`；结果打印到本机终端。
- 要后台跑更久：`offload.sh run -- 'tmux new -d -s job "cd xxx && bun test > /tmp/job.log 2>&1"'`，之后 `ssh liyou@192.168.2.3 'tmux attach -t job'`。

### C. 混合：本机编辑 + 远端执行

- 编辑器用 **VS Code Remote-SSH**（本机 VS Code 装 Remote-SSH 扩展，连 `dsh-arch`），代码显示/编辑在本机、文件与终端在远端；或
- 本机改完用 `offload.sh sync <本地目录>` 推到远端，`offload.sh run` 跑构建/测试，需要产物再 `offload.sh pull` 取回。

### D. 多轮对话 / 会话续接（一次解决不了问题时）

远程 dsh 的会话是持久化的，支持在**同一个会话里连续多轮**（上下文、工具结果、已完成改动都保留）：

```bash
# 终端交互式多轮（推荐用于排查/迭代；默认续接同名会话，/new 开新会话，/exit 退出）
offload.sh chat --dir dsh-plugins

# 脚本/非交互续接：每次 ask 都在同一会话里继续（默认会话名 default）
offload.sh ask --dir dsh-plugins -- '先跑一遍测试，把失败项列出来'
offload.sh ask --dir dsh-plugins -- '按你列的失败项修复，然后重新跑测试'
offload.sh ask --dir dsh-plugins -- '把刚才的修复提交，并给我 commit hash'
offload.sh ask --dir dsh-plugins --new -- '换个话题：从零分析这个仓库'   # --new 丢掉旧上下文

# 查看本机保存的会话（名称/目录/session id）
offload.sh sessions
```

- 机制：`offload.sh ask/chat` 首次调用用 `dsh headless --json` 捕获事件流里的 `sessionId`，之后用
  `dsh headless --session-id <id>` 续接；会话保存在**远端** `~/.dsh/sessions/`，本机重启/断隧道都不影响，
  本机只在 `~/.cache/dsh-offload/sessions/*.json` 里记 session id。
- `offload.sh headless '<任务>'` 是**一次性新会话**（每次 fresh），不适合需要连续追问的任务；要连续就用 `ask/chat`。
- 会话按 `--dir + --name` 区分（默认 name=`default`）；不同项目互不串上下文。
- 更复杂的多轮/可视化迭代优先用 **远程 dsh web GUI**（原生多轮对话，工具轨迹、审批、文件都在远端）；
  `chat` 适合 ssh 终端里的轻量迭代。

## 项目工作流（同步 → 跑 → 回传）

远端无 git 凭据（gh 未登录、无私钥），所以推荐：

```bash
# 1) 本地项目推到远端（默认排除 node_modules/build 等重目录，包含 .git）
offload.sh sync <本地项目目录>
# 2) 让远端 agent 或命令在远端工作区干活
offload.sh run --dir myproj -- 'bun install && bun run build && bun test'
offload.sh headless '在 /home/liyou/workspace/myproj 跑全部测试，修复可复现的失败并提交'
# 3) 取回远端产物/提交（.git 一起同步回来，本机再 push）
offload.sh pull myproj <本地项目目录>
```

- `sync/pull` 默认走 tar 管道（macOS 自带 openrsync 与远端 rsync 3.5.1 不兼容，不要用 rsync）。
- 远端 agent 在 `myproj` 里 commit 后，`pull` 会把 `.git` 一起带回来，本机 `git push` 即可（远端不配凭据也能闭环）。
- 公开仓库更省事：直接在远端 `offload.sh run -- 'git clone <url> myproj'`。

## 脚本参考（`~/.agents/skills/remote-heavy-offload/scripts/offload.sh`，本机 `~/.local/bin/offload` 软链）

```
offload.sh status                     # 远端负载/内存/磁盘/服务/端口
offload.sh tunnel [--stop]            # 起/停 ssh -N dsh-arch 隧道（pid 文件，重复调用复用）
offload.sh url [--mask]               # 打印最新 token URL（改写到本地端口；--mask 只显示长度）
offload.sh web                        # ensure tunnel + 打开浏览器（不重复打印 token）
offload.sh sync <本地目录> [远端子目录] [--clean] [--exclude PATTERN]...
offload.sh pull <远端子目录> <本地目录> [--clean]
offload.sh run [--dir 子目录] -- <命令...>
offload.sh headless '<任务描述>'      # 一次性新会话
offload.sh ask [--name N] [--dir 子目录] [--new] -- '<消息>'   # 同会话续接一条
offload.sh chat [--name N] [--dir 子目录] [--new]     # 终端多轮对话（/new、/exit）
offload.sh sessions                     # 列出本机保存的远端会话
```

可用环境变量覆盖：`OFFLOAD_HOST`（默认 `dsh-arch`）、`OFFLOAD_LOCAL_PORT`（18765）、
`OFFLOAD_REMOTE_WORKSPACE`（`/home/liyou/workspace`）、`OFFLOAD_DSH`（`/home/liyou/.local/bin/dsh`）。

## 资源与安全边界

- 远端只有 8 核 / 8GB（`.wslconfig` 固定），**别把本机所有活一次性怼上去**；重任务串行或先看 `offload.sh status`。
- 超长任务放 `tmux`/后台 job；SSH 断了任务不会停（agent 会话由远端服务管，window/tunnel 断了重连即可）。
- 隧道只在需要时开，用完 `offload.sh tunnel --stop`（或直接 Ctrl-C）；不要在后台长期留多个 `ssh -N`。
- token/cookie 按凭据处理：URL 含一次性 token，不写文档/聊天；cookie 固定 authority 有效，可书签。
- 远端服务 `dsh-web` 的启停见 `local-environment`（systemd user unit）；重启后 token 会变，但旧 cookie 仍有效。

## 清理

```bash
offload.sh tunnel --stop                      # 关隧道
ssh liyou@192.168.2.3 'tmux kill-server 2>/dev/null; pgrep -af "dsh headless" | head'   # 关遗留任务/进程
ssh liyou@192.168.2.3 'docker ps'             # 远端容器按需清理
```

## 已知限制

- 远端无 GUI/X11：需要显示器的程序不能跑；Android/DevEco 模拟器在 WSL2 无 KVM，**不要指望在远端跑模拟器**。
- 远端 `gh` 未登录、无 git 私钥：依赖同步往返 `.git`（见上）或由用户提供凭据。
- Office 文档能力由 dsh 内置 wasm LibreOffice 提供，不依赖系统 LibreOffice（不装）。

