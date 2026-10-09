---
name: network-access
description: 下载依赖、访问被墙站点、配置镜像源与代理的规则。触发：安装依赖 / 拉取代码 / 访问 github、google、npm、crates.io 等可能被墙的资源；需要选镜像源；配置 HTTP/SOCKS 代理；网络超时或失败。
---

# 网络访问与代理（Network Access）

涉及网络下载与镜像/代理选择时加载。优先级：国内镜像源 → 本地 xray 代理 → 停止并说明。

访问可能被墙的网站（网页、文档、API、CDN 等）时直接走本地 xray 代理；开发类依赖下载/代码拉取的优先级：国内镜像源 → 本地 xray 代理 → 停止并说明。以下镜像与代理均于 2026-09 实测可用，若失效先重新探活再换方案。

- 优先镜像源：有国内镜像的工具直接在项目/工具配置中固定镜像，不走代理：
  - npm/pnpm：项目 `.npmrc` 写 `registry=https://registry.npmmirror.com`（本机 `~/.npmrc` 已全局配好该 registry，项目无需重复）；bun：项目 `bunfig.toml` 写 `[install]` 节 + `registry = "https://registry.npmmirror.com"`（2026-09-21 实测生效，bun.lock 的 resolved URL 走镜像；本机仅 ops-portal/ui 有 bunfig.toml，其余靠全局 ~/.npmrc）。
  - Go：**本机尚未配置**（`go env GOPROXY` 当前是官方 `https://proxy.golang.org,direct`）。需要时按需设 `GOPROXY=https://goproxy.cn,direct`，不要以为已生效。
  - Rust：**本机未配置 crates.io 镜像**（`~/.cargo/config.toml` 不存在）；但 `~/.zshrc` 已把 `RUSTUP_DIST_SERVER` / `RUSTUP_UPDATE_ROOT` 指向清华 TUNA，装 toolchain 走镜像。
  - pip：`-i https://pypi.tuna.tsinghua.edu.cn/simple`
  - Maven/Gradle：`https://maven.aliyun.com/repository/public`
- 无镜像源的资源用本地 xray 代理：HTTP `http://127.0.0.1:10809`，SOCKS5 `socks5://127.0.0.1:10808`（注意：10809 只接受 HTTP 协议，SOCKS5 在 10808）。
  - **现状提示**：`~/.zshrc:106-107` 已 `export http_proxy/https_proxy=http://127.0.0.1:10809`（全局生效），且已设 `no_proxy=localhost,127.0.0.1,::1`——即本机当前**就是**全局代理策略。下述"只对单条命令临时生效"是更保守的替代做法，不是当前现状；不要因为"禁止全局代理"的旧措辞去改动用户已配置好的 shell。
  - 单条命令临时指定：命令前缀 `http_proxy=http://127.0.0.1:10809 https_proxy=http://127.0.0.1:10809 <命令>`，curl/wget 用 `-x`。
  - git 按域名局部配置代理（仓库内 `--local`）：`git config http.https://github.com/.proxy http://127.0.0.1:10809`；不设全局 `http.proxy`。
- 使用前先探活：`curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:10809 https://www.google.com/generate_204` 返回 204 才可用（另：本机 `no_proxy` 含 127.0.0.1，访问本机端口无需 `--noproxy`）；镜像源与代理都失败时停止并说明，不反复重试。
