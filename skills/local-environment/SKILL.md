---
name: local-environment
description: 本机环境事实：macOS 路径、已装工具、凭据归档位置（含敏感文件读取规范），以及远程开发主机（Arch on WSL2）的路径/工具/服务/凭据事实。触发：需要 Android Studio JBR / JAVA_HOME / ANDROID_HOME、Godot / DevEco Studio / DevEco 模拟器路径；需要 Cloudflare token 或源站证书、凭据或密钥放在哪、能否读取敏感文件；确认本机装了什么工具、某命令为何 command not found、工具装在哪个路径；需要确认本机是否为 macOS / 用哪个 shell；需要连远程开发主机、查其 dsh 安装/端口/systemd 服务/skill 根/凭据位置。
---

# 本机环境（Local Environment）

需要本机或远程开发主机的具体路径、已装工具、服务与凭据位置时加载。凭据相关红线见全局 `~/AGENTS.md`「敏感凭据」一节，始终生效。

> **可移植性说明**：本文件记录的是**两台主机的实测事实**——本机 macOS，以及下面的远程开发主机（同一套工作环境的远端执行端）。迁到新主机后，所有路径、已装工具、版本、服务拓扑必须重新核实改写，不得直接沿用；其他 skill 为跨主机通用规程（远程迁移流程见 `remote-agent-env` skill）。

## 系统与凭据与通用红线

- OS：macOS（Darwin），Shell 为 zsh。
- Cloudflare 管理 token 与各域名源站证书统一归档在 `~/work/dogod/cf_token_and_cert/`（已核实 `~/work/personal_files/` 不存在，勿用该路径）：`cf_account_token`（CF API token，管理 yinghuoren.com / chaoset.com 两个 zone 的 DNS 及签发 Origin CA 证书，已设 IP 白名单仅服务器可调）、各域名同名子目录（cert.pem / cert.key 源站证书与私钥；ops.yinghuoren.com/ 存 ops-portal 管理员客户端 p12）、`cloudflare-origin-pull-ca.pem`（Authenticated Origin Pulls CA）；结构与换证书注意事项详见目录内 README.md。这些是敏感凭据：需要时从该目录按需读取使用，禁止将其内容写入代码、文档、commit 或日志。
- **工具存在性检查禁止写在 `&&` 链尾**：
  `git describe --tags && which gh || echo NO_GH` 这类写法，链上任一环失败都会短路到
  `||` 兜底，把「没执行」伪装成「不存在」——上例中 `which gh` 根本没跑就输出了 NO_GH，
  而 gh 实际存在于 /opt/homebrew/bin。存在性检查必须**独立成句**单独执行。

## 已装工具与路径

- Android Studio：已安装，自带 JBR；Android SDK 位于 `~/Library/Android/sdk`；gradlew/Gradle 命令需设 `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` 与 `ANDROID_HOME="$HOME/Library/Android/sdk"`。
- Godot：`/Applications/Godot_mono.app/Contents/MacOS/Godot`（mono 版，含 C# 支持）。
- DevEco Studio：已安装。
- Go、Rust、Docker（OrbStack）已安装。
- Node：通过 nvm 管理，已安装直接使用。
- Bun：已安装（`~/.bun/bin/bun`，官方安装脚本），前端默认包管理器。
- gh CLI：`/opt/homebrew/bin/gh`（Homebrew 安装；版本号会变，用时以 `gh --version` 为准，不要把数字写死），已登录 `winliyou`（git 协议 ssh）。
  沙盒内 `gh run view` 的日志缓存可直接写（`~/.cache/gh` 已放行）。
- 沙盒内 `go install`/`go build`/`go env -w`：`~/go`（整棵，含 `pkg/mod`、`pkg/sumdb`、`bin`）、
  `~/Library/Caches/go-build`、`~/Library/Application Support/go`（GOENV 与遥测）已由
  sandbox-extra-roots 放行（desktop profile 已含该条），默认环境直接跑即可；
  报 EPERM 就把该目录加进插件配置（见 `sandbox-adaptation`），不要重定向。

## 网络与代理

- **代理环境**：`~/.zshrc:106-107` export 了 `http_proxy/https_proxy=http://127.0.0.1:10809`（v2ray 类）；`no_proxy/NO_PROXY` 只含 `localhost,127.0.0.1,::1,[::1]`。Firefox 也配了走 127.0.0.1:10809（`lsof -nP -i :10809` 可见 ESTABLISHED）。
- **Docker 拉镜像的代理不走 shell 环境变量**：`docker info` 的 HTTP/HTTPS Proxy 显示 `http://proxy.orb.internal:8305`（OrbStack VM 内置代理）；它由 OrbStack 设置 `network_proxy` 控制，默认 `auto` = 跟随 **macOS 系统代理**（`scutil --proxy` 当前 HTTPEnable/HTTPSEnable/SOCKSEnable 全 0），**与 `~/.zshrc` 的 http_proxy 无关**。所以 shell 明明有代理，`docker pull` 仍直连 Docker Hub，国内网络下报
  `failed to do request: Head "https://registry-1.docker.io/...": Bad Gateway`。
  修复（立即生效）：
  ```bash
  orbctl config set network_proxy http://127.0.0.1:10809   # 指向本地 xray HTTP 代理
  orbctl config show | grep network_proxy                  # 核对
  docker pull golang:1.26.10-alpine                        # 核对拉取成功
  ```
  回退：`orbctl config set network_proxy auto`。注意 xray 未启动时 docker pull 会失败；容器出网同样经该代理（OrbStack 的 proxy.orb.internal 链到 xray），内部地址在 No Proxy 列表内不受影响。
- **排障结论**：Firefox 走 xray 访问 `https://<name>.<compose 项目名>.orb.local/` **是通的，xray 无需任何改动**——Firefox 手动代理全量发给 127.0.0.1:10809（prefs.js 确认，无排除列表），xray 路由 `network: tcp,udp → direct` 兜底，freedom 出站（AsIs）把域名交给 macOS 系统解析，`curl -x http://127.0.0.1:10809` 实测 200。**注意**：xray 的 dns.servers（公网 DoH）解析不了 `.local`，但不影响 direct 出站——路由 `domainStrategy: AsIs` 不查 DNS 模块，freedom AsIs 走系统解析栈。**报「orb.local 加载不出来」先查容器是否在跑/刚启动**——nginx 容器启动 2 秒未就绪时 OrbStack 443 回源会被掐（SSL_ERROR_SYSCALL），不要误判为「代理拦截 orb.local」。
- **OrbStack 的 *.orb.local HTTPS 机制**：容器只 `listen 80` 时，`https://name.orb.local` 也能通——OrbStack 在宿主侧自动终结 TLS，证书由 `OrbStack Development Root CA` 签发，该 CA 已装 login keychain 且受信任（`security dump-trust-settings` 可见）；但按**容器 IP 直连 443** 会报 `tlsv1 alert internal error`（无域名路由），必须用域名访问。
- **macOS `.local` 域名的解析分裂**：只有走系统解析栈（`dscacheutil`、getaddrinfo/cgo）能解析 OrbStack 本地域名；`dig`（读 /etc/resolv.conf=223.5.5.5）与纯 Go resolver 都查不到——`dig` 查不通不代表系统解析不了，判断 DNS 问题用 `dscacheutil -q host -a name <域>` 为准。
- **ToDesk macOS 版「打开就提示网络有问题」排障**：GUI 只是壳，联网全靠 root 后台服务 `/Library/LaunchDaemons/com.youqu.todesk.service.plist`（`KeepAlive`+`RunAtLoad`）。判断服务是否在：`ps aux | grep ToDesk_Service`（无进程）+ `launchctl print system/com.youqu.todesk.service`（报 Could not find service）——两条例证即服务未加载，与本机网络无关（DNS 用 `dscacheutil` 验证、服务器 443 用 `nc -z` 验证全通）。修复需管理员密码，dsh 沙盒内 `sudo` 被拦（Operation not permitted），让用户在终端自跑：`sudo launchctl bootstrap system /Library/LaunchDaemons/com.youqu.todesk.service.plist`（报 already bootstrapped 则 `sudo launchctl enable system/com.youqu.todesk.service && sudo launchctl kickstart -k system/com.youqu.todesk.service`）；bootstrap 报 Operation not permitted 时去 系统设置→通用→登录项与扩展→允许在后台 检查 ToDesk 是否被关。服务器域名（strings 提取自 ToDesk_Service 二进制）：uc/authds/authbuss.todesk.com、www.todesk.com；注意 `authds.todesk.com` 是认证服务器，不响应普通 HTTPS GET（curl 000 属正常），判通以 `nc -z` TCP 握手为准。
- **xray 项目与对照实验**：xray 项目在 `~/work/xray/`；对照实验配置按其 `AGENTS.md` 放该仓库 `.workwork/`；诊断用临时端口 11808/11809、12808/12809（xray 多实例同端口不报错但会分流，必须各用一套、测完 kill）。

## DSH 环境与插件

- **DeepSeek Harness `app.asar` 解包**：官方打包的 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 数据区起点是 `16 + align4(headerSize)`，**不是** `16 + headerSize`——`headerSize` 是 offset 12 处的 uint32LE，**该数值随 App 版本变化，不要写死**（用 `node -e 'const b=require("fs").readFileSync(p).subarray(0,16);console.log(b.readUInt32LE(12))'` 现读）；它不是 4 的倍数时需按 `(4 - headerSize % 4) % 4` 补字节（写死具体值会随 App 版本失效），按后者解出的每个文件首部少算填充、尾部多算：`grep` 看不出问题，字节级比对或 read 会报 invalid UTF-8。已按 header 内每个 entry 的 `integrity.hash`（SHA256）逐文件校验的提取器：`~/.agents/skills/local-environment/scripts/extract-asar.mjs`（用法 `node extract-asar.mjs <outdir> <pathRegex>`，输出 `integrity_bad` 必须为 0 才可信）。
- **`dsh` CLI 的 profile 写入红线与插件离线验证**：`dsh` **不在 PATH 里**，实际可执行文件是 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（`command -v dsh` 为空属正常，不要误判为未安装）。`dsh` 任何子命令在 profile prepare 阶段都会**写** `$DSH_HOME`（沙盒内直接跑 `dsh web --help` 即 `EPERM ... ~/.dsh/profiles/<name>/cordis.yml`）→ **按 profile 分开看**（核对 `cordis.patch.yml`）：desktop profile 的 `extraWritableRoots` 已含 `~/.dsh`，沙盒内可直接跑；**web profile 没有这条**，`dsh web` 会话里仍需 `DSH_HOME=<workspace 内副本>`。`~/.dsh/profiles/<name>` 用的是 pnpm `nodeLinker: hoisted`（见其 `pnpm-workspace.yaml`），`node_modules/@chaoset/*` 是**实体目录不是符号链接**，因此验证本地插件改动**不必**走会联网重解依赖的 `dsh plugin add`：rsync 复制 profile 到 workspace 内副本后，原地覆盖该包 `files` 清单（`lib`、`client`、`cordis.patch.yml`、`package.json`、README/CHANGELOG/LICENSE）即可离线升级（实测 `DSH_HOME=<副本> dsh web --port <空闲端口> --no-open` 约 1 秒起，`curl` 插件路由可用）。副本内含 `.credentials.yaml` 等凭据，验证后必须删除；`dsh web` 启动打印的 URL 带 `token=`，留日志前必须 REDACT（`/` 直接 GET 是 401 `dsh web authentication required`，需带 `?token=` 走 303 换 cookie）。
- **DSH profile 与插件配置**：桌面 App（GUI 对话）用 `~/.dsh/profiles/desktop/`，
  `dsh web` 用 `~/.dsh/profiles/web/`；`sandbox-extra-roots` 的 `extraWritableRoots` 等插件配置
  **两边分别维护、改动热生效**；目录写权限需求统一加进该配置（不必逐个描述、不写工具特例）。
  查当前 App 进程用哪个 profile：
  `lsof -p $(lsof -nP -iTCP:<GUI端口> -sTCP:LISTEN -t) | grep profiles`（cwd 即 profile 目录）。

## 内存耗尽 → macOS jetsam 批量杀进程

- 症状：近期多个进程被杀（模拟器、浏览器、DSH host 等）。根因：16GB 物理内存耗尽，macOS jetsam（bug_type 298）按内存压力批量 SIGKILL。
- 证据：`/Library/Logs/DiagnosticReports/JetsamEvent-*.ips`（**现存份数会滚动清理，现查为准**：`ls /Library/Logs/DiagnosticReports/JetsamEvent-*.ips | wc -l`）。`.ips` 第一行是 header JSON，正文从第二行起：`tail -n +2 文件 | python3 -m json.tool`。关键字段：`memoryStatus.memoryPages.free`（现场可能仅 ~5.1–5.5k 页 ×16KB ≈ 80MB）、`compressorSize`（可达 29–39 万页 ≈ 4.5–6GB）；`processes` 按 `rpages` 排序找大户——Emulator 单进程 ~7GB（44% 物理内存），其后 OrbStack Helper ~1.5GB、hdc ~1.2GB、Firefox GPU ~1.1GB、Chrome renderer 每个 0.5–0.9GB。
- 佐证：模拟器未跑时 `memory_pressure -Q` free 可达 86%。**跑模拟器时叠加 OrbStack + 多浏览器 + 多个 Electron 应用必爆内存**。
- 深坑：DSH 崩溃日志（`~/Library/Logs/DeepSeek Harness/`）只记录「host stopped」并误把退出瞬间 stderr 尾部（Node ExperimentalWarning、网络报错等）当错误正文，**不含退出 signal/exit code**；判断被杀原因要看 DiagnosticReports（jetsam/.ips/.diag），别在 DSH 日志里找。
- 附带发现：`DeepSeek Harness_*.diag`（Microstackshots）记录 DSH 单日脏写 2.1GB 文件内存（超 24.86KB/s 限）；`shutdown_stall_*.shutdownStall` 是 spindump 二进制（需 root `spindump -i` 转文本），表示关机时有进程拖住。
- 实时排查：`memory_pressure -Q`、`vm_stat`（页大小 16384）、`sysctl vm.swapusage`；沙盒内 `/bin/ps` 会被拦（Operation not permitted），用 `memory_pressure -Q`/`pgrep -fl` 替代。
- DevEco 模拟器限内存：实例在 `~/.Huawei/Emulator/deployed/`（由 DevEcoStudio26.0 `options/deviceManager.xml` 的 `openharmonyDeployPath` 指向），每实例 `config.ini` 的 `hw.ramSize` + 启动时生成的 `hardware-qemu.ini` 同名字段 + `lists.json` 的 `memoryRamSize` 三处需一致；默认 4096（guest 4GB），host 侧常驻 ≈ guest + ~3GB QEMU/图形开销 ≈ 7GB。本机 5 个实例均为 2048（host 预计 ~5GB）。回退：sed 把 2048 改回 4096 同三处。改后下次冷启动生效，Device Manager 需重启刷新显示。默认设备模板在 `/Applications/DevEco-Studio.app/Contents/tools/emulator/emulator.json`（App 内，勿改）。OrbStack VM 上限 `orbctl config show` 的 `memory_mib`（本机 8192=半机），cap docker 机用 `orbctl config set machine.docker.memory_mib <值>`。

## 鼠标点击无响应排障（Firefox 内点击全灭，hover/键盘正常）

- 症状：Firefox 内所有位置点击无反应；hover 正常、键盘正常、新标签页能开（父进程健在）。
- 排除项（每条都有实测证据）：
  1. 硬件/HID 层正常：CGEventSourceSecondsSinceLastEventType 显示 L-down/L-up 距今仅约 1.2s（用户正在点击），按键未卡（left=0）——物理点击已进入事件层；
  2. 不是 event tap 拦截：CGGetEventTapList 列出本机全部 5 个 tap 均为 loc=1(Tail) opt=1(ListenOnly)——listen-only 尾部 tap 结构上吞不了事件（ToDesk/通知中心的 tap 属此类；无 loc=0(Head) opt=0 的可拦截 tap）；
  3. 不是 Firefox 设置/扩展：prefs.js 无 click/mouse/pointer 可疑项、无 user.js、扩展仅 uBlock Origin/Vue devtools。
- 根因定位在 Firefox 进程内部的事件状态机卡死（唯一干预 = 重启 Firefox 即愈，标签会话原样恢复）。最可能机制二选一（症状一致，事后无法区分，属推测）：① 不可见残留 popup 吃 outside-click——popup 保持 open 态时所有 mousedown 被当作「点弹层外部→关闭弹层」消费掉，不再分发；② 拖拽/滚动条 tracking 丢了 mouseUp 卡住——后续点击全被当作拖拽延续。两者都能解释 hover（走 mouseMoved 管线）与键盘（不走鼠标管线）不受影响。
- 误判坑：WindowManager 的 Event Shield Window（CGWindowList 可见：layer=-2147483603 桌面图标层、罩满全部显示器、on=1）是常驻窗、不拦截点击——不要把它当嫌疑人：Firefox 重启、点击恢复正常后它依然存在。任何「某窗口拦截点击」的假设，在症状消失后必须回头验证该窗是否仍在，否则会误判。
- 取证脚本（只读，不注入事件）：~/.agents/skills/local-environment/scripts/macos-input-probe.c，用法：clang 该文件 -o /tmp/input-probe -framework CoreGraphics -framework CoreFoundation 然后运行 /tmp/input-probe（两个 framework 都要链，缺 CoreFoundation 报 undefined symbols）。判读：opt=0 的 tap 才可能拦事件；since_last L-down 远大于用户实际点击间隔 = 点击没进事件层（查硬件/驱动/输入法改键）；点击进了事件层但应用无反应 = 应用内部状态问题（重启该应用）。
- 修复顺序：① 先判范围——到 Finder/别的应用点一下（确认范围要在动任何东西之前做）：也失效 = 系统级，查 tap 与遮挡窗，可 killall WindowManager / killall NotificationCenter（launchd 会自动拉起），仍不行才重启；只有某应用失效 = 应用内部状态，先 Esc 数次、故意按住再松开左键（清 ghost popup / 补 mouseUp），不行就重启该应用。

## 各仓库包管理器用料（会漂移，以仓库现状为准）

本机 JS/TS 存量仓库混用 **bun / pnpm / npm**。**具体数量会漂移，不要记数字**，用时现取：
`find ~/work -maxdepth 4 -name 'bun.lock*' -o -name 'pnpm-lock.yaml' -o -name 'package-lock.json' | grep -v node_modules`。
另有若干无 lockfile 的混合仓。**不在此处列仓库名**（项目事实写在各项目自己的 `AGENTS.md`）：动手前查该仓
`package.json` 的 `packageManager` 字段或 lockfile 即可，结论永远以仓库现状为准。
> 规则（通用部分）见 `toolchain-setup` skill：`packageManager` > lockfile > 新项目一律 bun；
> **不要**因为"一律 bun"去改动已用 pnpm/npm 的存量仓库。

## 远程开发主机（Arch Linux on WSL2，192.168.2.3）

同一套 dsh 开发环境的远端执行端。**迁移流程见 `remote-agent-env` skill**；本节只记录这台主机的事实
（换主机必须重新核实改写，并同步更新本节）。

- **连接与身份**：`ssh liyou@192.168.2.3`（BatchMode 免密可用）。这是 Windows 主机 `DESKTOP-99MTIG4`
  上的 WSL2 发行版 Arch Linux（现取 `uname -sr`：6.18.40.1-microsoft-standard-WSL2）；WSL 内网卡 `eth0`
  为 172.20.166.193/20（NAT），**LAN 不能直连 distro 端口**——访问服务一律走 ssh 隧道。账号 liyou、
  shell zsh、sudo 免密；systemd 已启用（pid1=systemd，user manager running），`Linger=yes`
  （`loginctl enable-linger liyou` 直连被拒 `Could not enable linger: Access denied`，实际用 `sudo loginctl enable-linger liyou` 成功）。
- **Windows 侧网络与拉起**（WSL2 NAT 的补充）：Windows 用 `netsh portproxy` 把 `0.0.0.0:22` 转发到 WSL:22，
  所以 Mac 连 `192.168.2.3:22` 实际是 Windows 宿主转发进 WSL。Windows 计划任务负责登录后拉起并保活 WSL：
  `WSL-Arch-KeepAlive`（At logon，Delay PT30S，动作 `cmd /c wsl.exe -d Arch -u root -- /usr/bin/sleep infinity`，
  State=Running）与 `WSL-Arch-SSH-Bridge`（约每 2 分钟跑 `D:\WSL\scripts\ssh-bridge.ps1` 维护 portproxy）。
  Windows 侧 `/mnt/c/Users/liyou/.wslconfig`：`[wsl2] memory=8GB processors=8 swap=4GB vmIdleTimeout=2147483647
  localhostForwarding=true`（因此不空闲回收）。
- **Windows 重启后的可用性**：WSL → systemd → linger + enabled 这条链路在**用户 liyou 登录 Windows 后**才被计划任务
  拉起，之后 dsh-web 自动可用；停在登录界面、无人登录时服务不可用（未实跑 Windows 重启验证）。
- **硬件/容量**（现取 `nproc`、`free -h`、`df -h /`）：8 核（Ryzen 7 2700X）、内存 7.8GiB、根分区 1007G（约 949G 空闲）。
- **工具链（pacman 系统级）**：node v26.13.0 / npm 12.2.1 / pnpm 12.16.1；bun 1.4.4；gh 2.102.1（**未登录**，
  私有仓库操作需用户提供认证方式，不要复制私钥）；base-devel、ripgrep/fd/jq/bat/eza/starship、bubblewrap 0.13.1、
  go 1.27.3、uv、pipx、docker 29.9.2（liyou 在 docker 组，`docker run hello-world` 实测成功）、python 3.14.9。
  `python-pip` 未装（用 uv/pipx 替代）。注：Arch 的 base-devel 是 meta 包，`pacman -Sg base-devel` 报 group not found
  属正常，用 `pacman -T base-devel` 校验是否装齐。
- **开发工具链（按 macOS 常用工具补齐；版本现取）**：
  - JDK：仅 `java-21-openjdk`（`archlinux-java` 默认 `java-21-openjdk`，`JAVA_HOME=/usr/lib/jvm/java-21-openjdk`）；不安装 JDK 27。
  - Android SDK（CLI 构建链）：`/home/liyou/Android/Sdk`（约 641M），cmdline-tools latest + platform-tools + `platforms;android-37.0` + `build-tools;36.0.0/37.0.0`，licenses 已接受；`sdkmanager`/`adb` 用 SDK 内版本（`adb version`=SDK platform-tools 37.0.1；不使用系统 android-tools，避免与 SDK 版抢版本）。
  - Godot：`/home/liyou/.local/opt/godot-4.7.2-mono/`（`/home/liyou/.local/bin/godot` 软链，`godot --version`=4.7.2.stable.mono）；export templates 在 `/home/liyou/.local/share/godot/export_templates/4.7.2.stable.mono/`（1.9G）。
  - .NET SDK 10.0.114（Godot C#/mono 需要）；Rust `rust 1:1.99.1`（rustc/cargo；无 rust-analyzer，服务端不需要编辑器 LSP）。
  - 常用 CLI：tmux、tree、shellcheck 0.11.0、actionlint、gitleaks、git-filter-repo、zstd/lz4/opus（构建库）、mingw-w64-gcc（交叉编译 Windows）、unzip/zip/7zip、noto-fonts-cjk（中文渲染）。
  - **显式未装（保持精简）**：libreoffice（office 能力由 dsh 自带 `@deepseek-ai/libreoffice-kit` 的 wasm 后端提供：`dsoffice capabilities --json` 实测 `backend=wasm`，**不需要系统 LibreOffice**）、ffmpeg、imagemagick、clang/cmake/ninja、rust-analyzer、JDK 27、android-tools。
  - **服务与 agent shell 的环境变量**：`/home/liyou/.config/dsh-agent/env`（644，非敏感；JAVA_HOME/ANDROID_HOME/ANDROID_SDK_ROOT/PATH），systemd unit 用 `EnvironmentFile=-/home/liyou/.config/dsh-agent/env` 加载（实测服务进程 environ 含这些变量）；登录 shell 与**非交互 ssh** 共用 `/home/liyou/.zshenv`（source 同一 env 文件，实测 `zsh -c` 中 godot/adb/JAVA_HOME 均可见）。
- **沙箱**：WSL2 未挂 securityfs，但 landlock 可用（实测 LANDLOCK ABI=7）、bwrap 可用；dsh 沙箱按 `workspace-write` 工作。
  目录放行只改 web profile 的 `sandbox-extra-roots.extraWritableRoots`（远端实测清单，按实际目录增删）：
  远端包管理器/构建缓存：`~/.npm`、`~/.bun/install/cache`、`~/.local/share/pnpm`、`~/.cache/pnpm`、`~/.cache/go-build`、`~/go`、`~/.cargo`、
  远端语言/CLI 缓存：`~/.cache/uv`、`~/.cache/pip`、`~/.cache/gh`、`~/.android`、`~/.gradle`、`~/.hvigor`、`~/.ohpm`、`~/.docker/buildx`、
  远端技能与运行时：`~/.cache/ms-playwright`、`~/.agents`、`~/.dsh`。不要关沙盒（见 `sandbox-adaptation` skill）。
- **dsh 安装（用户级，不 sudo）**：远端包体在 `/home/liyou/.local/share/dsh-cli`（`package.json` 固定
  `@deepseek-ai/dsh` 版本 + `npm install`）；远端 `~/.local/bin/dsh` 软链到该目录的 `node_modules/.bin/dsh`；
  版本 `0.2.1-rc.5`（现取远端 `~/.local/bin/dsh --version`，与 macOS 桌面 App 自带 CLI 同版本）。npm 12 默认拦依赖
  install scripts：已 `npm install-scripts approve -a @deepseek-ai/dsh-subprocess-local node-pty @google/genai protobufjs koffi`
  并 `npm rebuild` 同清单，实测 koffi import=KOFFI_OK、node-pty spawn=PTY_OK。**非交互 ssh 不 source `~/.zshrc`，
  PATH 里没有 `~/.local/bin`**，`command -v dsh` 为空属正常（用绝对路径；systemd unit 里显式 `Environment=PATH=`）。
- **web profile**：`~/.dsh/profiles/web/`；bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` +
  7 个 experimental bundle + `@chaoset/provider-usage`、`@chaoset/sandbox-extra-roots`、`@chaoset/session-archive`
  （3 个外部包以 GitHub release tarball 安装，`node_modules/@chaoset` 已就位）；**不启用 `@chaoset/dsh-any-connect`**
  （依赖 WorkBuddy/ZCode 桌面应用，Linux 不适用）。默认模型 `opencode-go/deepseek-v4.1-flash`，
  `llm-pi-ai.providers.opencode-go.apiKeyEnv: OPENCODE_GO_API_KEY`；补丁层已把源机 macOS 路径改成 Linux 路径。
- **常驻服务**：远端 systemd **用户级** unit `dsh-web`（`~/.config/systemd/user/dsh-web.service`，enabled + active）；
  `ExecStart=/home/liyou/.local/bin/dsh web --no-open --host 127.0.0.1 --port 8765`，
  `WorkingDirectory=/home/liyou/workspace`（dsh 默认 workspace 根），`Restart=on-failure`、`RestartSec=3`；
  监听 `127.0.0.1:8765`。常规 `systemctl --user restart` 实测约 4.6s 开始监听；首次冷启动/偶发重载 30–40s
  （实测冷启动 37–38s，属正常，验证等待给足 60s）。就绪后 journal 里有
  `dsh web: http://127.0.0.1:8765/?token=<token>`——token 是进程级凭据，**每次重启都变、旧 token URL 变 401**，
  **不要写进文档/日志/聊天记录**（取法见复核命令，输出时 REDACT）；cookie 签名密钥持久化在凭据文件里，
  **旧 cookie 重启后同 authority 仍有效**。运行中的服务 journal 只有 Started 与 URL 行、
  无 warn/error；`dsh web --help` 等组合检查路径会打印外部插件 `settings gateway unavailable: typert-protocol is
  unavailable ...` / `remote gateway unavailable: ...` 告警，服务运行正常，属良性告警、不要写成故障。
- **访问方式（本机已配 SSH 别名）**：本机 `~/.ssh/config` 有 `Host dsh-arch`（HostName 192.168.2.3、
  User liyou、`LocalForward 127.0.0.1:18765 127.0.0.1:8765`；用 `ssh -G dsh-arch` 复核）。日常 `ssh -N dsh-arch`
  起隧道，浏览器打开 `http://127.0.0.1:18765/?token=<journal 取到的 token>`。
  实测：无 cookie = 401；token URL（authority 换成 `127.0.0.1:18765`）→ 303 +
  `set-cookie: dsh-auth-<authority 派生 hash>=<signed>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`；
  同 authority 带 cookie GET `/` → 200（title=DeepSeek Harness）；把 Host 改回 `127.0.0.1:8765` 打 18765 → 401
  （证明 cookie 名按 authority 派生）。**cookie 跨重启有效**（实测：同 authority 带旧 cookie 不带 token GET `/` 仍 200）：
  服务重启只淘汰 token URL（需重新从 journal 取），不淘汰浏览器会话。因此首次 token→cookie 后，固定本地端口 18765
  且 cookie 未过期（30 天）时，直接打开 `http://127.0.0.1:18765/` 即可，**可加入书签**。
- **headless profile**：远端 `~/.dsh/profiles/headless/` 已存在；headless bundle 默认禁用 credentials，为让
  ssh 一条命令跑任务能读文件凭据，已在其 `cordis.patch.yml` 里加 `- id: credentials` /
  `name: "@deepseek-ai/dsh-credentials-local"` / `disabled: false`；实测
  `dsh headless "运行 bash 命令 uname -a..."` exit=0 并正确返回远端系统信息。
- **凭据**：`~/.dsh/.credentials.yaml`（权限 600、628B，与源机 sha256 一致；refs 为 `OPENCODE_GO_API_KEY`、
  `DEEPSEEK_API_KEY`）。文件型存储由 `dsh-credentials-local` 解析，**不物化进进程环境**；内容只按需使用，
  禁止写入代码/文档/日志。
- **skills 与全局指令**：`~/.agents/` 已同步（`skill-lint` 在远端 ERROR=0；因 macOS 专属路径在本机不存在会出一批 WARN，属预期；数量现取 `ls ~/.agents/skills | wc -l`）；`~/AGENTS.md` 软链到
  `~/.agents/AGENTS.md`（通用指令），`~/.dsh/AGENTS.md` 为本机差异前言（Linux 主机事实）；两个根都会加载、
  同内容去重。工作区级指令：`/home/liyou/workspace/AGENTS.md`（远端工作区约定：无 GUI、项目按需 clone、沙箱/缓存、工具链路径）。技能根是 `~/.agents/skills`（skill-filesystem 的 user-agents rank 500）。
- **workspace 根**：`/home/liyou/workspace`（systemd WorkingDirectory；当前为空目录，项目需自行 clone/同步到远端）。
- **重负载卸载（本机用法）**：本机已装 `offload`（`~/.local/bin/offload` → `~/.agents/skills/remote-heavy-offload/scripts/offload.sh`，详见该 skill）：`offload status` 看远端负载；交互式重活用远程 GUI（`ssh -N dsh-arch` + `offload url`，cookie 后书签 `http://127.0.0.1:18765/`）；批处理用 `offload headless '<任务>'`；项目流程 `offload sync ~/work/xxx` → `offload run --dir xxx -- '<构建/测试命令>'` → `offload pull xxx ~/work/xxx`（.git 可闭环，本机 push）。
- **重负载边界**：远端 8 核 / 8GB，重任务串行、先看 `offload status`；GUI 程序与 Android/DevEco 模拟器不能放远端（WSL2 无 X11、无 `/dev/kvm`）。
- **远程子代理（MCP，推荐）**：本机 dsh 已通过 `@deepseek-ai/dsh-mcp-client` 挂载 `mcp-remote-subagent`（单文件 bundle + `run.sh` 都在 `~/.agents/skills/remote-heavy-offload/scripts/mcp-server/`，无 node_modules、无需安装；修改 `server.mjs` 后运行该目录 `build.sh` 重新打包）。profile 行已加到 desktop 与 web 两个 `cordis.patch.yml`（改前备份后缀 `.bak-before-mcp`），`command` 指向 skill 内 `run.sh`。资源池允许清单 `~/.dsh/fleet-hosts.json`（默认拒绝未授权主机，当前只有 `exec-arch`）。新会话工具：`mcp__remote__remote_status / remote_start_task / remote_task_status / remote_task_followup / remote_task_cancel / remote_run / remote_diff / remote_sync / remote_pull / remote_jobs`；任务目录在远端 `~/.dsh-offload/jobs/`（`run-N.log` 为 JSON 事件流）。验证：`pgrep -f 'mcp-server/server.bundle.mjs'`、`dsh --profile web --dump-config | grep -A6 mcp-remote-subagent`；改 profile 后需新开会话（app HMR 通常自动加载）。
- **资源池**：显式允许清单 `~/.dsh/fleet-hosts.json`（默认拒绝）：`lead`=Mac，`executor`=`exec-arch`（WSL Arch 192.168.2.3，8C/8GB，maxHeavyJobs=1）；排除 `workwork-server`（生产 VPS）、`Ubuntu-YaXin`/`ArchLinux-WuLongTou`（非本人账号 lsyb）、`windows-host`（暂不用 Windows/GPU）。改清单后 MCP 立即生效（文件级校验）。
- **未部署/待补**：Android Studio / DevEco Studio / VS Code 等 GUI 编辑器与 Android 模拟器不在远端部署范围（CLI 构建链已装：JDK21 + Android SDK + Godot mono）；HarmonyOS 命令行工具（hvigor/ohpm/hdc + 内嵌 SDK）需华为账号登录下载，未装（需要时由用户提供下载包）；gh 未登录；python-pip 未装（用 uv/pipx 替代）。
- **复核命令**（改本节前先跑，全部只读）：

```bash
ssh liyou@192.168.2.3 'uname -sr; nproc; free -h | head -2; df -h / | tail -1'
ssh liyou@192.168.2.3 '~/.local/bin/dsh --version; systemctl --user is-active dsh-web; systemctl --user is-enabled dsh-web; loginctl show-user "$USER" -p Linger'
ssh liyou@192.168.2.3 'ss -tlnp 2>/dev/null | grep 127.0.0.1:8765; ls ~/.dsh/profiles/web/node_modules/@chaoset'
ssh liyou@192.168.2.3 'ls ~/.agents/skills | wc -l; stat -c "%a %s" ~/.dsh/.credentials.yaml'
ssh -G dsh-arch | grep -E '^(hostname|user|localforward) '
# token 输出必须 REDACT，不要贴原文
ssh liyou@192.168.2.3 "journalctl --user -u dsh-web -o cat --no-pager | grep -oE 'http://127\.0\.0\.1:8765/\?token=[^[:space:]]+' | tail -1"
```

