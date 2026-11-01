---
name: network-access
description: 下载依赖、访问被墙站点、配置镜像源与代理的规则。触发：安装依赖 / 拉取代码 / 访问 github、google、npm、crates.io 等可能被墙的资源；需要选镜像源；配置 HTTP/SOCKS 代理；网络超时或失败。
---

# 网络访问与代理（Network Access）

涉及网络下载与镜像/代理选择时加载。优先级：国内镜像源 → 本地 xray 代理 → 停止并说明。

访问可能被墙的网站（网页、文档、API、CDN 等）时直接走本地 xray 代理；开发类依赖下载/代码拉取的优先级：国内镜像源 → 本地 xray 代理 → 停止并说明（**npm/pnpm/bun 例外：默认官方源，见下条**）。以下镜像与代理均可用，若失效先重新探活再换方案。

- 优先镜像源：**除 npm/pnpm/bun 外**，有国内镜像的工具直接在项目/工具配置中固定镜像，不走代理（npm 系是例外，见下条）：
  - npm/pnpm/bun：**默认一律 npmjs 官方源，禁止把镜像写进配置文件**（全机五仓库均按此落地）：
    - 配置文件零 registry：`~/.npmrc`、项目 `.npmrc`、`bunfig.toml`、`.yarnrc*`、环境变量、CI/Dockerfile **一律不写 registry**。本机全局配置均不存在，`npm/pnpm config get registry` 均为官方 `https://registry.npmjs.org/`。
    - 仅当官方源**确认不可用**时，才用命令行参数**临时**走 npmmirror，用完即弃：`npm/pnpm <cmd> --registry https://registry.npmmirror.com`、`bun install --registry https://registry.npmmirror.com`。坚决杜绝写回任何配置文件（用户红线：不采用全局镜像策略）。
    - lockfile 会烙死下载 URL 绕过 registry 默认值：删掉 registry 配置后 lockfile 里仍可能残留 npmmirror URL。迁移方法：**域名替换** `registry.npmmirror.com` → `registry.npmjs.org`（镜像 tarball 与官方字节一致，integrity 不变、版本零漂移），再 `npm ci` / `pnpm|bun install --frozen-lockfile` 实装校验（五个存量仓库全部通过；删除 lockfile 重装会引入依赖漂移，禁用）。
      当前**仍有仓库未迁移**（本机仍有多份 lockfile 含 npmmirror），核查命令：
      `grep -rl registry.npmmirror.com ~/work --include='bun.lock' --include='package-lock.json'`。
  - Go：**本机尚未配置**（`go env GOPROXY` 当前是官方 `https://proxy.golang.org,direct`）。需要时按需设 `GOPROXY=https://goproxy.cn,direct`，不要以为已生效。
  - Rust：**本机未配置 crates.io 镜像**（`~/.cargo/config.toml` 不存在）；但 `~/.zshrc` 已把 `RUSTUP_DIST_SERVER` / `RUSTUP_UPDATE_ROOT` 指向清华 TUNA，装 toolchain 走镜像。
  - pip：`-i https://pypi.tuna.tsinghua.edu.cn/simple`
  - Maven/Gradle：`https://maven.aliyun.com/repository/public`
- 无镜像源的资源用本地 xray 代理：HTTP `http://127.0.0.1:10809`，SOCKS5 `socks5://127.0.0.1:10808`（注意：10809 只接受 HTTP 协议，SOCKS5 在 10808）。
  - **Docker / OrbStack 例外**：`docker pull` 由 daemon（VM 内）发起，**不读 shell 的 http_proxy/https_proxy**，也不读 macOS 系统代理的 shell 副本；daemon 实际走 OrbStack 内置 `proxy.orb.internal:8305`，由 `orbctl config set network_proxy <url>` 控制（默认 `auto` 跟随 macOS 系统代理，本机系统代理为关）。国内直连 Docker Hub 会 502，需显式：
    `orbctl config set network_proxy http://127.0.0.1:10809`（详见 `local-environment` 的代理环境一节）。
  - **`gh` 走代理异常时先显式传大写变量**：`~/.zshrc` 配的是小写
    `http_proxy/https_proxy`；`gh run list` 可能报 `net/http: TLS handshake timeout`（gh 2.103.3 直连通常正常——遇到再按本条排障，别当必然现象），而
    `curl -x http://127.0.0.1:10809 https://api.github.com/...` 同一时刻返回 200。
    **真因未定位**（Go 标准库其实大小写都读，见 `net/http/httpproxy` 的 `getEnvAny`），
    不要据此推断机制。判据：代理探活正常（`curl -x ... https://www.google.com/generate_204` 得
    204）但 `gh` 仍超时 ⇒ 显式传大写重试：

    ```bash
    HTTPS_PROXY=http://127.0.0.1:10809 HTTP_PROXY=http://127.0.0.1:10809 \
      gh run list --limit 5      # 大写即可
    ```

    不要叠加 `ALL_PROXY` 或清空 `NO_PROXY`（那样反而失败）；
    替代方案是用 `curl -x` 直接打 GitHub REST API。
  - **现状提示**：`~/.zshrc:106-107` 已 `export http_proxy/https_proxy=http://127.0.0.1:10809`（全局生效），且运行环境已注入 `no_proxy=localhost,127.0.0.1,::1`（`env` 中存在，不在 `~/.zshrc` 内）——即本机当前**就是**全局代理策略。下述"只对单条命令临时生效"是更保守的替代做法，不是当前现状；不要因为"禁止全局代理"的其他说法去改动用户已配置好的 shell。
  - 单条命令临时指定：命令前缀 `http_proxy=http://127.0.0.1:10809 https_proxy=http://127.0.0.1:10809 <命令>`，curl/wget 用 `-x`。
  - git 按域名局部配置代理（仓库内 `--local`）：`git config http.https://github.com/.proxy http://127.0.0.1:10809`；不设全局 `http.proxy`。

- **代理慢的排障结论**：报"走代理尤其 github 很慢"时，先分层定位再改配置。方法与结果：
  1. 经代理 `curl -x http://127.0.0.1:10809 -o /dev/null -w '%{speed_download}'` 分别下载 github 大文件（codeload tarball）与其他 geosite 目标（speed.cloudflare.com）——若**所有目标都只有 KB/s 量级**，瓶颈在隧道/服务器，不是 github 或协议。
  2. 对照 `curl --noproxy '*'` 直连 `https://speed.cloudflare.com/__down?bytes=10000000`：1.79 MB/s 说明本机→CF 边缘线路健康；**注意本机 ~/.zshrc 全局设了 http_proxy，测"直连"必须显式 --noproxy，否则数据全是走代理的假象**（会误判为 CF 被限速）。
  3. 协议层排除法：把 config 复制改 alpn（h3→h2）、xhttp mode（packet-up→stream-up）、换端口起临时 xray 实例对照下载，吞吐无差别（~10-25KB/s）→ 排除 ALPN/模式，锁定中转服务器（源站）一侧带宽/回源问题，需机场方或上服务器排查，本地配置无需改动。
  4. 本地 xray 健康：`log show --predicate 'process CONTAINS "xray"' --last 40m` 无 warn/error 也支持此结论。
  5. 对照实验配置放项目 `.workwork/`；诊断用临时端口（11808/11809、12808/12809），xray 多实例监听同端口不报错但会分流，必须各用一套端口，测完 kill。**xray 项目位置等本机机器事实见 `local-environment` skill**。
- 使用前先探活：`curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:10809 https://www.google.com/generate_204` 返回 204 才可用（另：本机 `no_proxy` 含 127.0.0.1，访问本机端口无需 `--noproxy`）；镜像源与代理都失败时停止并说明，不反复重试。
