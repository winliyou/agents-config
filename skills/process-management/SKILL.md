---
name: process-management
description: 长驻进程与工具的启停规范：启动前先检查复用、用完必关、会话结束复查，禁止为同一目的重复启动。触发：启动或重启 dev server / watch / MCP 服务 / 守护进程；关闭、kill、pkill、终止进程；排查端口被占用 / 端口冲突 / address already in use / EADDRINUSE / 进程没退出 / 僵尸进程 / 残留进程；判断某进程是否为本会话所起、能否安全 kill；会话收尾或结束前清理后台进程与临时服务。
---

# 进程与工具管理（Process Management）

启动或清理长驻进程时加载。

- 启动工具/服务前先检查是否已有实例在运行（`ps`、`pgrep`、`lsof -i :端口`），已有则复用，禁止为同一目的重复启动新实例（如重复的 MCP server、dev server、watch 进程）。
- 长驻型进程用完后必须关闭：dev server、watch 进程、MCP 服务、Java/Gradle 守护进程（`gradle --stop`）、临时工具等，使用完毕立即终止，不遗留后台进程；会话结束前复查本会话启动的进程与临时服务，来源不明的残留进程先向用户确认，不擅自 kill。
- `docker compose` 管理的**主工作树**开发环境（含容器内 air hot-reload 等 watch 进程）不属于会话启动的临时进程，按项目自身的 compose 约定管理，不要求会话结束清理。worktree 内创建的 compose 环境不适用此豁免：它属于 worktree 的资源，合并回主分支后必须随 worktree 清理一并销毁（见「合并流程」）。
