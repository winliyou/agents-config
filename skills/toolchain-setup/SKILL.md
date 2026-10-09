---
name: toolchain-setup
description: 工具安装方式、语言工具链命令与浏览器自动化约束。触发：安装或升级工具、该用哪个包管理器、新项目初始化工具链；需要 bun / npm / pnpm / lockfile / node_modules 相关命令；Go / Rust / Android / Gradle / Godot 命令；需要浏览器自动化（agent-browser）。
---

# 工具链与安装（Toolchain）

安装工具、选包管理器、跑语言工具链命令，或需要浏览器自动化时加载。

- 工具安装优先级：项目官方提供的安装方式第一优先（如 rustup、bun、nvm、官方 install.sh 等自带安装器/更新机制的脚本），官方未提供时才用 Homebrew。不因 brew 便于统一管理而越过官方安装方式。
- 浏览器操作：一律遵循用户级 `browser-automation-safety` skill（本机约定：二进制选择、防弹窗红线、session/daemon 与标签页复用、profile 隔离、清理与故障排查），本文件不再重复。工具本身的用法查 `agent-browser skills get core`。
- JS/TS（前端、后端、脚本）：**包管理器以项目既有声明为准**，优先级 `package.json` 的 `packageManager` 字段 > 现有 lockfile > 新建项目用 bun。**新项目一律 bun 起步**（bun.lock 唯一权威，`bun install` / `bun run` / `bunx`，全局安装 `bun install -g`）；存量项目不强行迁移，是否迁移由用户逐项目明确要求。本机现状（2026-09 核实）：dsh-plugins / hotspot-frontend / ops-portal-ui = bun；travel、music_player/shader_playground = pnpm（均 `packageManager: pnpm@12.4.2`，**不要**因为"一律 bun"去改它们）；CNM、ops-portal/e2e = npm。Node 仍通过 nvm 按需使用。沙盒内 `bun install` 报 tempdir EPERM：错误文案有误导，真因是包缓存不可写，`TMPDIR` 单独重定向**无效**；权威解法（`TMPDIR` + `BUN_INSTALL_CACHE_DIR`/`--cache-dir` 全部落 workspace）见 `sandbox-adaptation` skill「bun install 报 tempdir EPERM」一节，多包安装秒级（2026-09-25 实测 294 包通过）。**禁止 symlink 主检出的 `node_modules` 到 worktree**：vite 默认把 symlink 解析到真实路径（`preserveSymlinks: false`），`@fs/` 引用越过 worktree 边界落到主检出目录，被 vite workspace 限制拦截，报 `Cannot find module '/@fs/<主树>/node_modules/...'`（hotspot-frontend 79 个测试文件曾因此全挂，而 `bun run check`/`build` 表面正常，极具误导性）。正确做法是 worktree 内独立 `bun install`（配共享缓存后代价可忽略）。
- Go：`go build` / `go test` / `go vet` / `gofmt`。沙盒内跑 Go 必须重定向缓存（源自 hotspot 实战）：每次调用带 `GOCACHE=<当前工作树>/.workwork/caches/gocache`；`HOME` 重定向会连带搬走 `GOPATH`/`GOMODCACHE`（触发全量重新下载），要么显式固定 `GOMODCACHE` 到共享路径，要么接受按工作树隔离。删 module cache 前先 `chmod -R u+w`（文件只读）或用 `go clean -modcache`，否则 `rm`/`worktree remove` 报 Permission denied。
- Rust：`cargo build` / `cargo test` / `cargo clippy` / `cargo fmt`。
- Android：新建项目骨架必须由本机 Android Studio 的 New Project Wizard 生成；所有 Gradle 命令需先按「本机环境」Android Studio 条目设置 `JAVA_HOME` 与 `ANDROID_HOME`（以 `ls` 验证该路径存在，变动时用 `mdfind` 定位）。
- Gradle 命令一律加 `--no-daemon`（源自 media_app 实战：Gradle/Kotlin Daemon 构建后 idle 数小时不退出、各占 -Xmx2g，AI 多次构建会累积多个 java 进程撑爆内存；`--no-daemon` 让构建完进程立即退出）。残留 Daemon 兜底清理见 `process-management`（`gradle --stop`）。
- Godot：用「本机环境」Godot 条目路径做 headless 导出和冒烟测试。
- Android（续）：沙盒内 Gradle 构建还要重定向写入路径，否则 kotlin daemon client 会写 `~/Library/Application Support/kotlin/` 被拦（报 Operation not permitted，构建间歇性失败）。组合拳（media_app 实测 2026-09-26）：`HOME` 整体重定向到工作树内可写目录（如 `.workwork/fakehome`，`Application Support` 随 HOME 迁移），`GRADLE_USER_HOME`/`ANDROID_USER_HOME` 指到工作树内；wrapper 重复下载 130MB 发行版被墙 stall 时直接用已缓存发行版里的 `gradle` 二进制（`$GRADLE_USER_HOME/wrapper/dists/gradle-X-bin/*/gradle-X/bin/gradle`）；依赖下载被墙时用阿里云镜像 init 脚本（`--init-script`，注意 `PREFER_SETTINGS` 模式下仓库要补在 `settingsEvaluated` 的 `dependencyResolutionManagement` 里，加在 `allprojects` 会被拒）。
- Gradle 文件监听快照过期（源自 media_app 实战 2026-09-26）：AI 进程在长生命周期的主检出上新增文件（如新测试类）后，Gradle 的文件监听快照可能不包含它们——构建 SUCCESSFUL 但新测试类**静默不执行**（test-results XML 里没有对应类，极具误导性）。核对方法：数 test-results XML 个数是否等于测试类数。规避：本地验证加 `--no-watch-fs`；或删项目 `.gradle/` 目录强制重建快照。CI 全新检出不受影响。

- pnpm run 的 `--` 会原样转发给 script(与 npm 吞掉首个 `--` 不同,2026-10-07 travel CI 实测):`pnpm run preview -- --host x` 会让 vite 收到 `-- --host x` 导致 flag 失效。要给 script 内命令传参,用 `pnpm exec <cmd> --flag` 直接调用;或在 script 里写死参数。
