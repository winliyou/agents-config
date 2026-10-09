---
name: docker-workflow
description: Docker 优先原则：服务运行、集成/E2E 测试、构建与镜像管理的执行规范。触发：项目有 Dockerfile / docker-compose；需要启动服务、跑集成或端到端测试；需要 docker build / compose up / 镜像清理；在 worktree 内启动 compose。
---

# Docker 准则（Docker Workflow）

项目存在 Docker 配置、或需要容器内验证时加载。

- Docker 优先：存在 Docker 配置（Dockerfile / docker-compose / 可复用容器）的项目，服务运行、集成测试、端到端测试、对外联调均以容器为准，避免宿主机与部署行为不一致；宿主机命令只用于编辑、静态检查、构建前辅助诊断，不能替代最终验证。
- 先查现状：使用前检查本地已有镜像、容器和端口占用（`docker images`、`docker ps`、`docker compose ps`），优先复用，不凭记忆假设服务状态。
- 开发期免重复 build：优先用源码挂载、缓存卷、watch 进程、本地编译产物挂载加速，进程仍运行在容器内；修改依赖、系统包、环境变量、Dockerfile 或启动命令后，必须重建相关镜像/容器。
- 发布前必构建验证：发布/交付/部署任务必须执行 `docker build` / `docker compose build`，并基于新构建镜像完成验证；不得只用宿主机或挂载开发容器的结果宣称发布可用。
- 镜像清理：构建或拉取新镜像后按需 `docker image prune` 清理旧版本；不要把 `volume prune` 当作常规步骤。
- 一致性记录：因硬件、GUI、Android 模拟器等原因只能在宿主机执行的验证，必须说明原因，并尽量补充 Docker 内可执行的构建、接口或服务级验证。

## worktree 隔离（源自 hotspot 实战）

- 项目名即隔离：compose 项目名默认取当前目录名——主工作树与 worktree 天然隔离（容器/网络/volume），此时不要显式 `-p` 成主项目名，否则接管主实例；cwd 必须是对应工作树根目录。
- 目录名同名冲突：worktree 目录名与主工作树同名时（如 `.worktrees/<id>/hotspot`），项目名冲突、直接 `up` 会接管主实例。此时必须显式 `-p <独立名>` 并重映射全部宿主端口：用不入库的 override 文件以 `!override` 替换 `ports`（放 `.workwork/` 这类已忽略目录）；清理时带同样的 `-p` 与 override，禁止用默认 `down -v`（会删除主实例数据卷）。模板（把 `<svc>` 与端口换成项目实际值）：
  ```yaml
  services:
    <svc-db>:
      ports: !override
        - "127.0.0.1:<新宿主端口>:<容器端口>"
    <svc-api>:
      ports: !override
        - "127.0.0.1:<新宿主端口>:<容器端口>"
  ```
  启动：`docker compose -p <独立名> -f docker-compose.yml -f <override文件> up -d`；清理：`docker compose -p <独立名> -f docker-compose.yml -f <override文件> down`（不带 `-v`）。
- 合并后生效：worktree 合并回主分支后，若主环境容器在运行，重启受影响的主容器并确认 healthy；删除 worktree 前先 `down` 清理其 compose 资源。

## DOCKER_CONFIG 重定向（沙盒内用 docker 时）

沙盒下 `~/.docker/` 不可写时，用 `DOCKER_CONFIG=<可写目录>` 重定向。**必须整体复制，缺一不可**（2026-09-25 实测）：
- `contexts/`、`cli-plugins/`、`config.json` 及其余 `*.json` 要一起过去；
- 只复制 `buildx/`：不报错但**静默丢失当前 context**（回落到 `default`，可能连到错误的 daemon）；
- 复制了 `config.json`（内含 `"currentContext": "orbstack"`）却没复制 `contexts/`：直接失败 `context "orbstack": context not found`。
- **注意**：失败时退出码仍是 0，必须看输出文本判成功，不要只看退出码。
