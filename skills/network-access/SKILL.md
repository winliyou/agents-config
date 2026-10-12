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
  - **`gh` 只认大写代理变量（2026-10-12 实测）**：`~/.zshrc` 配的是小写
    `http_proxy/https_proxy`，但 `gh`（Go 程序）**不读小写**——表现为
    `gh run list` 稳定报 `net/http: TLS handshake timeout`，而 `curl -x
    http://127.0.0.1:10809 https://api.github.com/...` 同一时刻返回 200。
    判据：代理探活正常（`curl -x ... https://www.google.com/generate_204` 得
    204）但 `gh` 仍超时 ⇒ 改用大写重试：

    ```bash
    HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 \
      gh run list --limit 5      # 大写即可，实测成功
    ```

    不要叠加 `ALL_PROXY` 或清空 `NO_PROXY`（实测那样反而又失败）；
    替代方案是用 `curl -x` 直接打 GitHub REST API。
  - **现状提示**：`~/.zshrc:106-107` 已 `export http_proxy/https_proxy=http://127.0.0.1:10809`（全局生效），且已设 `no_proxy=localhost,127.0.0.1,::1`——即本机当前**就是**全局代理策略。下述"只对单条命令临时生效"是更保守的替代做法，不是当前现状；不要因为"禁止全局代理"的旧措辞去改动用户已配置好的 shell。
  - 单条命令临时指定：命令前缀 `http_proxy=http://127.0.0.1:10809 https_proxy=http://127.0.0.1:10809 <命令>`，curl/wget 用 `-x`。
  - git 按域名局部配置代理（仓库内 `--local`）：`git config http.https://github.com/.proxy http://127.0.0.1:10809`；不设全局 `http.proxy`。

- **代理慢的排障结论（2026-10-10 实测）**：用户报"走代理尤其 github 很慢"时，先分层定位再改配置。实测方法与结果：
  1. 经代理 `curl -x http://127.0.0.1:10809 -o /dev/null -w '%{speed_download}'` 分别下载 github 大文件（codeload tarball）与其他 geosite 目标（speed.cloudflare.com）——若**所有目标都只有 KB/s 量级**，瓶颈在隧道/服务器，不是 github 或协议。
  2. 对照 `curl --noproxy '*'` 直连 `https://speed.cloudflare.com/__down?bytes=10000000`：实测 1.79 MB/s，说明本机→CF 边缘线路健康；**注意本机 ~/.zshrc 全局设了 http_proxy，测"直连"必须显式 --noproxy，否则数据全是走代理的假象**（本次曾因此误判为 CF 被限速）。
  3. 协议层排除法：把 config 复制改 alpn（h3→h2）、xhttp mode（packet-up→stream-up）、换端口起临时 xray 实例对照下载，吞吐无差别（~10-25KB/s）→ 排除 ALPN/模式，锁定中转服务器（源站）一侧带宽/回源问题，需机场方或上服务器排查，本地配置无需改动。
  4. 本地 xray 健康：`log show --predicate 'process CONTAINS "xray"' --last 40m` 无 warn/error 也支持此结论。
  5. 对照实验配置按 ~/work/xray/AGENTS.md 放 .workwork/；诊断用临时端口（11808/11809、12808/12809），xray 多实例监听同端口不报错但会分流，必须各用一套端口，测完 kill。
- 使用前先探活：`curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:10809 https://www.google.com/generate_204` 返回 204 才可用（另：本机 `no_proxy` 含 127.0.0.1，访问本机端口无需 `--noproxy`）；镜像源与代理都失败时停止并说明，不反复重试。
