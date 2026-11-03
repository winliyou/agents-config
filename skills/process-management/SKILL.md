---
name: process-management
description: 长驻进程与工具的启停规范：启动前先检查复用、用完必关、会话结束复查，禁止为同一目的重复启动。触发：启动或重启 dev server / watch / MCP 服务 / 守护进程；关闭、kill、pkill、终止进程；排查端口被占用 / 端口冲突 / address already in use / EADDRINUSE / 进程没退出 / 僵尸进程 / 残留进程；判断某进程是否为本会话所起、能否安全 kill；会话收尾或结束前清理后台进程与临时服务。
---

# 进程与工具管理（Process Management）

启动或清理长驻进程时加载。

- 启动工具/服务前先检查是否已有实例在运行（`ps`、`pgrep`、`lsof -i :端口`），已有则复用，禁止为同一目的重复启动新实例（如重复的 MCP server、dev server、watch 进程）。
- 长驻型进程用完后必须关闭：dev server、watch 进程、MCP 服务、Java/Gradle 守护进程（`gradle --stop`）、临时工具等，使用完毕立即终止，不遗留后台进程；会话结束前复查本会话启动的进程与临时服务，来源不明的残留进程先向用户确认，不擅自 kill。
- `docker compose` 管理的**主工作树**开发环境（含容器内 air hot-reload 等 watch 进程）不属于会话启动的临时进程，按项目自身的 compose 约定管理，不要求会话结束清理。worktree 内创建的 compose 环境不适用此豁免：它属于 worktree 的资源，合并回主分支后必须随 worktree 清理一并销毁（见 `git-workflow` skill 的合并流程）。

## 子 shell 里后台化的负载进程会泄漏成孤儿空转

- 现象：`( for i in 1 2 3; do (死循环) & done ) 2>/dev/null ` 这种「子 shell 内后台化负载」的写法，回到主 shell 再 `LOADPIDS=$(jobs -p)` 取到的是空列表（那些后台进程不是主 shell 的 job），`kill $LOADPIDS` 落空；主脚本正常退出后，负载子 shell 被过继给 launchd，每个 ~80% CPU 永久空转。活动监视器里表现为多个同名 bash、父进程 launchd(1)、无 TTY，argv 仍是整段复合脚本（fork 不改 argv，别被命令行骗了）。
- 判定：`ps -o pid,ppid,pgid,pcpu,time,command -p <PID>` 出现 PPID=1、TTY=?、PGID 指向已退出的进程、CPU 持续高，即为孤儿 fork 子 shell；用 `pgrep -fl '脚本特征串'` 找出同批全部 PID。
- 溯源（AI 会话泄漏的进程）：在 `~/.dsh/sessions/<工作区目录>/<会话id>/session.v4.jsonl.zstd` 上 `zstd -dc | grep '特征串'`，按事件时间戳反查提交会话（`session_search` 超时时的兜底手段）。
- 正确做法：负载进程必须在**主 shell 层**直接后台化并逐个记 PID（`for i in 1 2 3; do loop & pids+=("$!"); done`，收尾 `kill "${pids[@]}"`）；或对整组用进程组信号（先取 PGID：`PGID=$(ps -o pgid= -p <脚本PID> | tr -d ' ')`，再 `kill -- -$PGID`；`$PGID` 不是 shell 内置变量，不会自动存在）。带负载的后台脚本收尾必须 `pgrep` 复查无残留才算结束。
- 验证方式：`ps` 确认 PPID=1、pcpu≈80%（典型泄漏 3 个 bash 空转约 1 小时、每进程累计 ~50 分钟 CPU）；以 `pgrep -fl 特征串` 无输出为清理完成标准。

## Java 构建守护进程（Gradle / Kotlin daemon）残留溯源

- **默认做法（红线）**：AI/脚本构建一律 `--no-daemon`；本机 `~/.gradle/gradle.properties` 已设 `org.gradle.daemon=false` 兜底——不带 flag 的裸 `./gradlew` 也只会 fork 一个 single-use daemon，构建结束即停（实测：真实项目 `./gradlew help` 后 `pgrep -fl 'GradleDaemon|KotlinCompileDaemon'` 为空）。确需常驻 daemon 时命令行 `--daemon` 显式覆盖。
- **Kotlin 编译守护进程不受 `--no-daemon` 控制**：构建后仍会空闲常驻（`--daemon-autoshutdownIdleSeconds=7200`）。任务/会话收尾前确认没有构建在跑（无 GradleDaemon 活动、daemon 无 ESTABLISHED 客户端）后 `pkill -f KotlinCompileDaemon`，以 `pgrep -fl 'GradleDaemon|KotlinCompileDaemon'` 无输出为收尾标准。
- 现象：几个 java 进程 CPU 0%、无 TTY、PPID=1（Gradle daemon 主动脱离父进程，ps 里看不到启动者）；`daemon-<pid>.out.log` 的 mtime 一直在跳，但内容只是每 10s 一次的 `Starting periodic daemon health check`，不代表有构建在跑。
- 角色判定：`ps -Ao pid,ppid,etime,command | grep -E 'GradleDaemon|KotlinCompileDaemon'`。`org.gradle.launcher.daemon.bootstrap.GradleDaemon` 是 Gradle 守护进程；`org.jetbrains.kotlin.daemon.KotlinCompileDaemon` 是 Kotlin 编译守护进程，通常是 Gradle daemon 的子进程（PPID 指向它）。
- 溯源构建来源（客户端进程已退出也能查）：
  1. `~/.gradle/daemon/<gradle版本>/daemon-<pid>.out.log`：首行 daemon context 里的 `idleTimeout=` 决定自退时间；`grep -o 'currentDir=[^,}]*'` 得到构建目录；`Received command: Build{...}` 的时间戳是最后一次客户端接入；`Marking the daemon as idle` 是空闲起点。
  2. Kotlin daemon 日志路径用 `lsof -p <pid> | grep kotlin-daemon` 定位（默认在 `$TMPDIR/kotlin-daemon.<启动时间戳>.log`），尾部 `Done with result ...` / `cleaning after session` 即最后一次编译时间。
  3. 客户端进程与工作目录都已消失时，到 AI 编码工具的会话记录里按「构建目录 / 项目路径」反查命令（dsh、ZCode 等的记录位置见 `local-environment` skill），用「命令里的路径 + 请求时间戳」与 daemon 日志的 currentDir / 时间对齐确认。
- 为什么有的留下、有的自灭：`./gradlew ... --no-daemon` 起的是 single-use daemon，构建完即退；**漏写 `--no-daemon` 的那条**会留下持久 daemon（`idleTimeout` 默认 3h），它拉起的 Kotlin daemon 空闲 2h（`--daemon-autoshutdownIdleSeconds=7200`）后才退。所以同一批构建里往往只剩个别守护进程。
- java 命令行里出现 IDE 自带 JBR 的路径**不能说明是 IDE 启动的**——shell 或 agent 里 `export JAVA_HOME=<JBR>` 也会如此，必须以 daemon 日志与客户端会话记录为准。
- 清理前提：`lsof -a -p <pid> -d cwd` 指向 daemon/cache 目录、`lsof -nP -iTCP -a -p <pid>` 只有 LISTEN 无 ESTABLISHED，且确认无构建在跑；之后 `kill <GradleDaemon PID> <Kotlin daemon PID...>`，或 `./gradlew --stop`（只停对应 Gradle 版本的 daemon，Kotlin daemon 需单独 kill）。验证：`ps -Ao pid,command | grep -E 'GradleDaemon|KotlinCompileDaemon'` 无输出。
