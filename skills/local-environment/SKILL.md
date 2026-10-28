---
name: local-environment
description: 本机环境事实：macOS 路径、已装工具、凭据归档位置（含敏感文件读取规范）。触发：需要 Android Studio JBR / JAVA_HOME / ANDROID_HOME、Godot / DevEco Studio / DevEco 模拟器路径；需要 Cloudflare token 或源站证书、凭据或密钥放在哪、能否读取敏感文件；确认本机装了什么工具、某命令为何 command not found、工具装在哪个路径；需要确认本机是否为 macOS / 用哪个 shell。
---

# 本机环境（Local Environment）

需要本机具体路径或凭据位置时加载。凭据相关红线见全局 `~/AGENTS.md`「敏感凭据」一节，始终生效。

> **可移植性说明**：本文件记录的是**某台主机的实测事实**。迁到新主机后，所有路径、已装工具、版本必须重新核实改写，不得直接沿用；其他 skill 为跨主机通用规程。

## 系统与凭据与通用红线

- OS：macOS（Darwin），Shell 为 zsh。
- Cloudflare 管理 token 与各域名源站证书统一归档在 `~/work/dogod/cf_token_and_cert/`（2026-10-04 核实：`~/work/personal_files/` 不存在，旧文曾误写该路径）：`cf_account_token`（CF API token，管理 yinghuoren.com / chaoset.com 两个 zone 的 DNS 及签发 Origin CA 证书，已设 IP 白名单仅服务器可调）、各域名同名子目录（cert.pem / cert.key 源站证书与私钥；ops.yinghuoren.com/ 存 ops-portal 管理员客户端 p12）、`cloudflare-origin-pull-ca.pem`（Authenticated Origin Pulls CA）；结构与换证书注意事项详见目录内 README.md。这些是敏感凭据：需要时从该目录按需读取使用，禁止将其内容写入代码、文档、commit 或日志。
- **工具存在性检查禁止写在 `&&` 链尾**（曾被纠正）：
  `git describe --tags && which gh || echo NO_GH` 这类写法，链上任一环失败都会短路到
  `||` 兜底，把「没执行」伪装成「不存在」——本次 `which gh` 根本没跑就输出了 NO_GH，
  而 gh 实际存在于 /opt/homebrew/bin。存在性检查必须**独立成句**单独执行。

## 已装工具与路径

- Android Studio：已安装，自带 JBR；Android SDK 位于 `~/Library/Android/sdk`；gradlew/Gradle 命令需设 `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` 与 `ANDROID_HOME="$HOME/Library/Android/sdk"`。
- Godot：`/Applications/Godot_mono.app/Contents/MacOS/Godot`（mono 版，含 C# 支持）。
- DevEco Studio：已安装。
- Go、Rust、Docker（OrbStack）已安装。
- Node：通过 nvm 管理，已安装直接使用。
- Bun：已安装（`~/.bun/bin/bun`，官方安装脚本），前端默认包管理器。
- gh CLI：`/opt/homebrew/bin/gh`（Homebrew 安装；实测为 2.102.0，版本号会变、用时以 `gh --version` 为准），已登录 `winliyou`（git 协议 ssh）。
  沙盒内 `gh run view` 的日志缓存可直接写（`~/.cache/gh` 已放行）。
- 沙盒内 `go install`/`go build`/`go env -w`：`~/go`（整棵，含 `pkg/mod`、`pkg/sumdb`、`bin`）、
  `~/Library/Caches/go-build`、`~/Library/Application Support/go`（GOENV 与遥测）已由
  sandbox-extra-roots 放行（补齐 desktop profile 缺口后实测通过），默认环境直接跑即可；
  报 EPERM 就把该目录加进插件配置（见 `sandbox-adaptation`），不要重定向。

## 网络与代理

- **代理环境**：`~/.zshrc:106-107` export 了 `http_proxy/https_proxy=http://127.0.0.1:10809`（v2ray 类）；`no_proxy/NO_PROXY` 只含 `localhost,127.0.0.1,::1,[::1]`。Firefox 也配了走 127.0.0.1:10809（`lsof -nP -i :10809` 可见 ESTABLISHED）。
- **Docker 拉镜像的代理不走 shell 环境变量（2026-10-22 实测）**：`docker info` 的 HTTP/HTTPS Proxy 显示 `http://proxy.orb.internal:8305`（OrbStack VM 内置代理）；它由 OrbStack 设置 `network_proxy` 控制，默认 `auto` = 跟随 **macOS 系统代理**（`scutil --proxy` 当前 HTTPEnable/HTTPSEnable/SOCKSEnable 全 0），**与 `~/.zshrc` 的 http_proxy 无关**。所以 shell 明明有代理，`docker pull` 仍直连 Docker Hub，国内网络下报
  `failed to do request: Head "https://registry-1.docker.io/...": Bad Gateway`。
  修复（立即生效，已实测 pull 成功）：
  ```bash
  orbctl config set network_proxy http://127.0.0.1:10809   # 指向本地 xray HTTP 代理
  orbctl config show | grep network_proxy                  # 核对
  docker pull golang:1.26.10-alpine                        # 实测通过
  ```
  回退：`orbctl config set network_proxy auto`。注意 xray 未启动时 docker pull 会失败；容器出网同样经该代理（OrbStack 的 proxy.orb.internal 链到 xray），内部地址在 No Proxy 列表内不受影响。
- **排障结论（两个回合修正后）**：Firefox 走 xray 访问 `https://<name>.<compose 项目名>.orb.local/` **是通的，xray 无需任何改动**——Firefox 手动代理全量发给 127.0.0.1:10809（prefs.js 确认，无排除列表），xray 路由 `network: tcp,udp → direct` 兜底，freedom 出站（AsIs）把域名交给 macOS 系统解析，`curl -x http://127.0.0.1:10809` 实测 200。**注意**：xray 的 dns.servers（公网 DoH）解析不了 `.local`，但不影响 direct 出站——路由 `domainStrategy: AsIs` 不查 DNS 模块，freedom AsIs 走系统解析栈。首回合误判「代理拦截 orb.local」的真因：当时 nginx 容器刚启动 2 秒未就绪，OrbStack 443 回源被掐（SSL_ERROR_SYSCALL）；**报「orb.local 加载不出来」先查容器是否在跑/刚启动**。
- **OrbStack 的 *.orb.local HTTPS 机制**：容器只 `listen 80` 时，`https://name.orb.local` 也能通——OrbStack 在宿主侧自动终结 TLS，证书由 `OrbStack Development Root CA` 签发，该 CA 已装 login keychain 且受信任（`security dump-trust-settings` 可见）；但按**容器 IP 直连 443** 会报 `tlsv1 alert internal error`（无域名路由），必须用域名访问。
- **macOS `.local` 域名的解析分裂**：只有走系统解析栈（`dscacheutil`、getaddrinfo/cgo）能解析 OrbStack 本地域名；`dig`（读 /etc/resolv.conf=223.5.5.5）与纯 Go resolver 都查不到——`dig` 查不通不代表系统解析不了，判断 DNS 问题用 `dscacheutil -q host -a name <域>` 为准。
- **ToDesk macOS 版「打开就提示网络有问题」排障**：GUI 只是壳，联网全靠 root 后台服务 `/Library/LaunchDaemons/com.youqu.todesk.service.plist`（`KeepAlive`+`RunAtLoad`）。判断服务是否在：`ps aux | grep ToDesk_Service`（无进程）+ `launchctl print system/com.youqu.todesk.service`（报 Could not find service）——两条例证即服务未加载，与本机网络无关（DNS 用 `dscacheutil` 验证、服务器 443 用 `nc -z` 验证全通）。修复需管理员密码，dsh 沙盒内 `sudo` 被拦（Operation not permitted），让用户在终端自跑：`sudo launchctl bootstrap system /Library/LaunchDaemons/com.youqu.todesk.service.plist`（报 already bootstrapped 则 `sudo launchctl enable system/com.youqu.todesk.service && sudo launchctl kickstart -k system/com.youqu.todesk.service`）；bootstrap 报 Operation not permitted 时去 系统设置→通用→登录项与扩展→允许在后台 检查 ToDesk 是否被关。服务器域名（strings 提取自 ToDesk_Service 二进制）：uc/authds/authbuss.todesk.com、www.todesk.com；注意 `authds.todesk.com` 是认证服务器，不响应普通 HTTPS GET（curl 000 属正常），判通以 `nc -z` TCP 握手为准。
- **xray 项目与对照实验**：xray 项目在 `~/work/xray/`；对照实验配置按其 `AGENTS.md` 放该仓库 `.workwork/`；诊断用临时端口 11808/11809、12808/12809（xray 多实例同端口不报错但会分流，必须各用一套、测完 kill）。

## DSH 环境与插件

- **DeepSeek Harness `app.asar` 解包（2026-10-19 实测）**：官方打包的 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 数据区起点是 `16 + align4(headerSize)`，**不是** `16 + headerSize`——本机 `headerSize=4780386`（非 4 的倍数）差 2 字节填充，按后者解出的每个文件首部多 2 字节、尾部少 2 字节：`grep` 看不出问题，字节级比对或 read 会报 invalid UTF-8。已按 header 内每个 entry 的 `integrity.hash`（SHA256）逐文件校验的提取器：`~/.agents/skills/local-environment/scripts/extract-asar.mjs`（用法 `node extract-asar.mjs <outdir> <pathRegex>`，输出 `integrity_bad` 必须为 0 才可信）。
- **`dsh` CLI 的 profile 写入红线与插件离线实测（2026-10-19 实测）**：`dsh` 任何子命令在 profile prepare 阶段都会**写** `$DSH_HOME`（沙盒内直接跑 `dsh web --help` 即 `EPERM ... ~/.dsh/profiles/<name>/cordis.yml`）→ 跑 `dsh` 前必须先 `DSH_HOME=<workspace 内副本>`。`~/.dsh/profiles/<name>` 用的是 pnpm `nodeLinker: hoisted`（见其 `pnpm-workspace.yaml`），`node_modules/@chaoset/*` 是**实体目录不是符号链接**，因此验证本地插件改动**不必**走会联网重解依赖的 `dsh plugin add`：rsync 复制 profile 到 workspace 内副本后，原地覆盖该包 `files` 清单（`lib`、`client`、`cordis.patch.yml`、`package.json`、README/CHANGELOG/LICENSE）即可离线升级（实测 `DSH_HOME=<副本> dsh web --port <空闲端口> --no-open` 约 1 秒起，`curl` 插件路由可用）。副本内含 `.credentials.yaml` 等凭据，验证后必须删除；`dsh web` 启动打印的 URL 带 `token=`，留日志前必须 REDACT（`/` 直接 GET 是 401 `dsh web authentication required`，需带 `?token=` 走 303 换 cookie）。
- **DSH profile 与插件配置（2026-10-27 核实）**：桌面 App（GUI 对话）用 `~/.dsh/profiles/desktop/`，
  `dsh web` 用 `~/.dsh/profiles/web/`；`sandbox-extra-roots` 的 `extraWritableRoots` 等插件配置
  **两边分别维护、改动热生效**；目录写权限需求统一加进该配置（用户明确：不必逐个描述、不写工具特例）。
  查当前 App 进程用哪个 profile：
  `lsof -p $(lsof -nP -iTCP:<GUI端口> -sTCP:LISTEN -t) | grep profiles`（cwd 即 profile 目录）。

## 内存耗尽 → macOS jetsam 批量杀进程

- 症状：近期多个进程被杀（模拟器、浏览器、DSH host 等）。根因：16GB 物理内存耗尽，macOS jetsam（bug_type 298）按内存压力批量 SIGKILL。
- 证据：`/Library/Logs/DiagnosticReports/JetsamEvent-*.ips`（10-23 有 00:51 / 14:40 两份）。`.ips` 第一行是 header JSON，正文从第二行起：`tail -n +2 文件 | python3 -m json.tool`。关键字段：`memoryStatus.memoryPages.free`（当时仅 ~5.1–5.5k 页 ×16KB ≈ 80MB）、`compressorSize`（29–39 万页 ≈ 4.5–6GB）；`processes` 按 `rpages` 排序找大户——Emulator 单进程 ~7GB（44% 物理内存），其后 OrbStack Helper ~1.5GB、hdc ~1.2GB、Firefox GPU ~1.1GB、Chrome renderer 每个 0.5–0.9GB。
- 佐证：模拟器未跑的 10-24 12:45 重启后 `memory_pressure -Q` free 86%。**跑模拟器时叠加 OrbStack + 多浏览器 + 多个 Electron 应用必爆内存**。
- 深坑：DSH 崩溃日志（`~/Library/Logs/DeepSeek Harness/`）只记录「host stopped」并误把退出瞬间 stderr 尾部（Node ExperimentalWarning、当时的网络报错）当错误正文，**不含退出 signal/exit code**；判断被杀原因要看 DiagnosticReports（jetsam/.ips/.diag），别在 DSH 日志里找。
- 附带发现：`DeepSeek Harness_*.diag`（Microstackshots）记录 DSH 单日脏写 2.1GB 文件内存（超 24.86KB/s 限）；`shutdown_stall_*.shutdownStall` 是 spindump 二进制（需 root `spindump -i` 转文本），表示关机时有进程拖住。
- 实时排查：`memory_pressure -Q`、`vm_stat`（页大小 16384）、`sysctl vm.swapusage`；沙盒内 `/bin/ps` 会被拦（Operation not permitted），用 `memory_pressure -Q`/`pgrep -fl` 替代。
- DevEco 模拟器限内存（2026-10-24 实测改配）：实例在 `~/.Huawei/Emulator/deployed/`（由 DevEcoStudio26.0 `options/deviceManager.xml` 的 `openharmonyDeployPath` 指向），每实例 `config.ini` 的 `hw.ramSize` + 启动时生成的 `hardware-qemu.ini` 同名字段 + `lists.json` 的 `memoryRamSize` 三处需一致；默认 4096（guest 4GB），host 侧常驻 ≈ guest + ~3GB QEMU/图形开销 ≈ 7GB。已把全部 5 个实例改为 2048（host 预计 ~5GB）。回退：sed 把 2048 改回 4096 同三处。改后下次冷启动生效，Device Manager 需重启刷新显示。默认设备模板在 `/Applications/DevEco-Studio.app/Contents/tools/emulator/emulator.json`（App 内，勿改）。OrbStack VM 上限 `orbctl config show` 的 `memory_mib`（本机 8192=半机），cap docker 机用 `orbctl config set machine.docker.memory_mib <值>`。

## 鼠标点击无响应排障（Firefox 内点击全灭，hover/键盘正常）

- 症状：Firefox 内所有位置点击无反应；hover 正常、键盘正常、新标签页能开（父进程健在）。
- 已排除（每条都有实测证据）：
  1. 硬件/HID 层正常：事发时 CGEventSourceSecondsSinceLastEventType 显示 L-down/L-up 距今仅约 1.2s（用户正在点击），按键未卡（left=0）——物理点击已进入事件层；
  2. 不是 event tap 拦截：CGGetEventTapList 列出本机全部 5 个 tap 均为 loc=1(Tail) opt=1(ListenOnly)——listen-only 尾部 tap 结构上吞不了事件（ToDesk/通知中心的 tap 属此类；无 loc=0(Head) opt=0 的可拦截 tap）；
  3. 不是 Firefox 设置/扩展：prefs.js 无 click/mouse/pointer 可疑项、无 user.js、扩展仅 uBlock Origin/Vue devtools。
- 根因定位在 Firefox 进程内部的事件状态机卡死（唯一干预 = 重启 Firefox 即愈，标签会话原样恢复）。最可能机制二选一（症状一致，事后无法区分，属推测）：① 不可见残留 popup 吃 outside-click——popup 保持 open 态时所有 mousedown 被当作「点弹层外部→关闭弹层」消费掉，不再分发；② 拖拽/滚动条 tracking 丢了 mouseUp 卡住——后续点击全被当作拖拽延续。两者都能解释 hover（走 mouseMoved 管线）与键盘（不走鼠标管线）不受影响。
- 误判教训（本次真实发生）：WindowManager 的 Event Shield Window（CGWindowList 可见：layer=-2147483603 桌面图标层、罩满全部显示器、on=1）是常驻窗、不拦截点击。曾把它当头号嫌疑，但 Firefox 重启修复后它依然存在且点击正常，假设被反证。任何「某窗口拦截点击」的假设，修复后必须回头验证该窗是否随症状消失，否则会误判。
- 取证脚本（只读，不注入事件）：~/.agents/skills/local-environment/scripts/macos-input-probe.c，用法：clang 该文件 -o /tmp/input-probe -framework CoreGraphics -framework CoreFoundation 然后运行 /tmp/input-probe（两个 framework 都要链，缺 CoreFoundation 报 undefined symbols）。判读：opt=0 的 tap 才可能拦事件；since_last L-down 远大于用户实际点击间隔 = 点击没进事件层（查硬件/驱动/输入法改键）；点击进了事件层但应用无反应 = 应用内部状态问题（重启该应用）。
- 修复顺序：① 先判范围——到 Finder/别的应用点一下（确认范围要在动任何东西之前做）：也失效 = 系统级，查 tap 与遮挡窗，可 killall WindowManager / killall NotificationCenter（launchd 会自动拉起），仍不行才重启；只有某应用失效 = 应用内部状态，先 Esc 数次、故意按住再松开左键（清 ghost popup / 补 mouseUp），不行就重启该应用。

## 各仓库包管理器用料（会漂移，以仓库现状为准）

本机 JS/TS 存量仓库当前大致是 **3 个 bun / 3 个 pnpm（均 `packageManager: pnpm@12.4.2`）/ 2 个 npm**，
另有若干混合仓。**不在此处列仓库名**（项目事实写在各项目自己的 `AGENTS.md`）：动手前查该仓
`package.json` 的 `packageManager` 字段或 lockfile 即可，结论永远以仓库现状为准。
> 规则（通用部分）见 `toolchain-setup` skill：`packageManager` > lockfile > 新项目一律 bun；
> **不要**因为"一律 bun"去改动已用 pnpm/npm 的存量仓库。
