---
name: local-environment
description: 本机环境事实：macOS 路径、已装工具、凭据归档位置（含敏感文件读取规范）。触发：需要 Android Studio JBR / JAVA_HOME / ANDROID_HOME、Godot / DevEco Studio / DevEco 模拟器路径；需要 Cloudflare token 或源站证书、凭据或密钥放在哪、能否读取敏感文件；确认本机装了什么工具、某命令为何 command not found、工具装在哪个路径；需要确认本机是否为 macOS / 用哪个 shell。
---

# 本机环境（Local Environment）

需要本机具体路径或凭据位置时加载。凭据相关红线见全局 `~/AGENTS.md`「敏感凭据」一节，始终生效。

> **可移植性说明（2026-10-09）**：本文件记录的是**某台主机的实测事实**。迁到新主机后，所有路径、已装工具、版本必须重新核实改写，不得直接沿用；其他 skill 为跨主机通用规程。

- OS：macOS（Darwin），Shell 为 zsh。
- Cloudflare 管理 token 与各域名源站证书统一归档在 `~/work/dogod/cf_token_and_cert/`（2026-10-04 核实：`~/work/personal_files/` 不存在，旧文曾误写该路径）：`cf_account_token`（CF API token，管理 yinghuoren.com / chaoset.com 两个 zone 的 DNS 及签发 Origin CA 证书，已设 IP 白名单仅服务器可调）、各域名同名子目录（cert.pem / cert.key 源站证书与私钥；ops.yinghuoren.com/ 存 ops-portal 管理员客户端 p12）、`cloudflare-origin-pull-ca.pem`（Authenticated Origin Pulls CA）；结构与换证书注意事项详见目录内 README.md。这些是敏感凭据：需要时从该目录按需读取使用，禁止将其内容写入代码、文档、commit 或日志。
- Android Studio：已安装，自带 JBR；Android SDK 位于 `~/Library/Android/sdk`；gradlew/Gradle 命令需设 `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` 与 `ANDROID_HOME="$HOME/Library/Android/sdk"`。
- Godot：`/Applications/Godot_mono.app/Contents/MacOS/Godot`（mono 版，含 C# 支持）。
- DevEco Studio：已安装。
- Go、Rust、Docker（OrbStack）已安装。
- Node：通过 nvm 管理，已安装直接使用。
- Bun：已安装（`~/.bun/bin/bun`，官方安装脚本），前端默认包管理器。

- gh CLI：`/opt/homebrew/bin/gh`（Homebrew 安装，2026-10-04 实测为 2.102.0，版本号会变、用时以 `gh --version` 为准），已登录 `winliyou`（git 协议 ssh）。
  沙盒内使用注意：`gh run view` 的日志缓存写 `~/.cache/gh` 会 EPERM，先
  `export XDG_CACHE_HOME=<workspace>/.workwork/cache`（2026-09-25 实测）。
- 沙盒内 `go install` 第三方 CLI（如 wails）：`GOPATH`/`GOBIN`/`GOCACHE`/`GOMODCACHE` 都要
  重定向进 workspace——`GOPATH` 不重定向时 GOSUMDB 校验缓存写 `~/go/pkg/sumdb` 会 EPERM
  （2026-09-25 实测：`GOBIN=$PWD/.workwork/bin GOPATH=$PWD/.workwork/gopath go install ...` 成功）。
- **工具存在性检查禁止写在 `&&` 链尾**（2026-09-25 被纠正）：
  `git describe --tags && which gh || echo NO_GH` 这类写法，链上任一环失败都会短路到
  `||` 兜底，把「没执行」伪装成「不存在」——本次 `which gh` 根本没跑就输出了 NO_GH，
  而 gh 实际存在于 /opt/homebrew/bin。存在性检查必须**独立成句**单独执行。
