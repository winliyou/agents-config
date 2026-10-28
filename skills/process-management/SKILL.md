---
name: process-management
description: 长驻进程与工具的启停规范：启动前先检查复用、用完必关、会话结束复查，禁止为同一目的重复启动。触发：启动或重启 dev server / watch / MCP 服务 / 守护进程；关闭、kill、pkill、终止进程；排查端口被占用 / 端口冲突 / address already in use / EADDRINUSE / 进程没退出 / 僵尸进程 / 残留进程；判断某进程是否为本会话所起、能否安全 kill；会话收尾或结束前清理后台进程与临时服务。
---

# 进程与工具管理（Process Management）

启动或清理长驻进程时加载。

- 启动工具/服务前先检查是否已有实例在运行（`ps`、`pgrep`、`lsof -i :端口`），已有则复用，禁止为同一目的重复启动新实例（如重复的 MCP server、dev server、watch 进程）。
- 长驻型进程用完后必须关闭：dev server、watch 进程、MCP 服务、Java/Gradle 守护进程（`gradle --stop`）、临时工具等，使用完毕立即终止，不遗留后台进程；会话结束前复查本会话启动的进程与临时服务，来源不明的残留进程先向用户确认，不擅自 kill。
- `docker compose` 管理的**主工作树**开发环境（含容器内 air hot-reload 等 watch 进程）不属于会话启动的临时进程，按项目自身的 compose 约定管理，不要求会话结束清理。worktree 内创建的 compose 环境不适用此豁免：它属于 worktree 的资源，合并回主分支后必须随 worktree 清理一并销毁（见 `git-workflow` skill 的合并流程）。

## 踩坑：子 shell 里后台化的负载进程会泄漏成孤儿空转

- 现象：`( for i in 1 2 3; do (死循环) & done ) 2>/dev/null ` 这种「子 shell 内后台化负载」的写法，回到主 shell 再 `LOADPIDS=$(jobs -p)` 取到的是空列表（那些后台进程不是主 shell 的 job），`kill $LOADPIDS` 落空；主脚本正常退出后，负载子 shell 被过继给 launchd，每个 ~80% CPU 永久空转。活动监视器里表现为多个同名 bash、父进程 launchd(1)、无 TTY，argv 仍是整段复合脚本（fork 不改 argv，别被命令行骗了）。
- 判定：`ps -o pid,ppid,pgid,pcpu,time,command -p <PID>` 出现 PPID=1、TTY=?、PGID 指向已退出的进程、CPU 持续高，即为孤儿 fork 子 shell；用 `pgrep -fl '脚本特征串'` 找出同批全部 PID。
- 溯源（AI 会话泄漏的进程）：在 `~/.dsh/sessions/<工作区目录>/<会话id>/session.v4.jsonl.zstd` 上 `zstd -dc | grep '特征串'`，按事件时间戳反查提交会话（`session_search` 超时时的兜底手段）。
- 正确做法：负载进程必须在**主 shell 层**直接后台化并逐个记 PID（`for i in 1 2 3; do loop & pids+=("$!"); done`，收尾 `kill "${pids[@]}"`）；或对整组用进程组信号（`kill -- -$PGID`）。带负载的后台脚本收尾必须 `pgrep` 复查无残留才算结束。
- 验证方式：2026-10-26 本机实测：泄漏的 3 个 bash 空转约 1 小时（每进程累计 ~50 分钟 CPU），ps 确认 PPID=1、pcpu≈80%；修复后以 `pgrep -fl 特征串` 无输出为清理完成标准。
