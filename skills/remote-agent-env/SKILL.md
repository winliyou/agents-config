---
name: remote-agent-env
description: 把 dsh AI agent 开发环境从本机迁移到远程 Linux 主机的可复用规程：目标架构选型（远程 loopback + SSH 隧道）、前置检查、同版本 CLI 安装（含 npm 12 安装脚本审批）、web profile 补丁层与外部插件迁移、凭据与 skills/AGENTS.md 迁移、systemd 常驻、访问通道与验收清单、WSL2/跨平台同步与平台差异坑。触发：在远程 Linux / WSL2 主机部署或迁移 dsh 环境；远程主机用 npm 安装 dsh 或 npm 12 拦截安装脚本；迁移 dsh web profile 的 cordis.patch.yml 与外部插件；配置 systemd 常驻 dsh web；用 ssh -L 隧道访问远程 GUI；远程 dsh web 起不来、401/403、headless 缺凭据、macOS rsync 同步失败。
---

# 远程 agent 环境（Remote Agent Environment）

把本机上跑通的 dsh AI agent 开发环境迁到远程 Linux 主机：agent 的 shell 与文件工具在远端执行，
浏览器留在本机。本文件是**跨主机通用规程**；目标主机的 IP、用户、端口、unit 名、安装路径、
凭据位置等「这台机器长什么样」的事实写在 `local-environment` skill，不要复制到这里。

> 语义前提：迁移后 agent **只能操作远端文件**。本机项目目录不在远端视野内，需要时另行在远端
> `git clone` / 同步；不要把「环境迁过去了」误当成「本机工作区也过去了」。

迁移顺序（按此执行，每步都有校验）：

```
前置检查 → 安装同版本 CLI → 首次启动初始化 web profile → 外部插件 → 补丁层适配 → 凭据
        → skills/AGENTS.md → systemd 常驻 → SSH 隧道访问 → 验收清单
```

## 目标架构选型

默认架构（单人、内网、从本机访问）：

```
本机浏览器 ──ssh -L 隧道──> 远端 127.0.0.1:<port>  dsh web（systemd user 常驻）
                                   └─ agent 的 shell/文件工具全部在远端执行
```

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 远程 loopback + SSH 隧道（默认）** | 远端 `dsh web --host 127.0.0.1 --port <port> --no-open`；本机 `ssh -N -L 127.0.0.1:<本地端口>:127.0.0.1:<port>` | 不需要 TLS、域名、代理、防火墙放行；端口不暴露到 LAN；登录仍需启动 token。缺点是隧道断了页面即不可用 |
| B. 绑定 LAN 地址直连 | `--host <本机某一个具体 IP>` | `dsh web` 明确拒绝通配地址；非 loopback 且无 TLS 时是明文 HTTP 并在启动时警告；Host/Origin 栅栏只接受绑定 IP 本身，其他 authority 要 `--trusted-host`。WSL2 NAT 下 LAN 也够不到，基本不选 |
| C. 反向代理 + TLS | 代理终止 TLS，dsh 用 `--public-url` 公告根 + `--trusted-host` 放行代理 authority | 适合多人/公网访问；单人内网迁移是过度设计（还要维护证书与代理） |

**结论**：默认 A；只有明确需要多人或公网访问时才升级到 C（并复用 `web-service-conventions` skill 的暴露约定）。

## 前置检查（全部只读）

```bash
REMOTE=<user>@<host>
ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE" 'echo ok'
ssh "$REMOTE" 'uname -sr; head -2 /etc/os-release; echo "$SHELL"'
ssh "$REMOTE" 'command -v node npm pnpm; node --version; npm --version; pnpm --version'
ssh "$REMOTE" 'ps -p 1 -o comm=; systemctl --user is-system-running'
ssh "$REMOTE" 'loginctl show-user "$USER" -p Linger'
ssh "$REMOTE" 'npm config get prefix'
```

判定与处理：

- **ssh 免交互可达**：BatchMode 不通说明没有免密 key，后续自动化全部会卡，先修 ssh。
- **Node/npm 存在**：dsh 是 npm 包，不含 node 运行时，Node 由远端包管理器/版本管理器提供即可。
- **pnpm 存在**：外部插件安装走 `dsh plugin` → pnpm；缺 pnpm 时明确报
  `dsh: pnpm was not found; install pnpm and make it available on PATH`。
- **systemd 可用**：`ps -p 1 -o comm=` 应为 `systemd`；`systemctl --user is-system-running` 为 `running` 才能用 user unit。
  WSL2 需先在 `/etc/wsl.conf` 打开 `[boot] systemd=true` 并重启 distro。
- **npm prefix**：输出 `/usr` 表示非 root 不能往默认前缀装全局包——本项目一律用用户级前缀，不 sudo。
- **Linger**：`Linger=no` 时用户服务随最后一个登录会话退出，需要 `loginctl enable-linger`。
- **磁盘**：dsh CLI 首次安装约 600 个依赖包、近 1GB（以 npm 输出为准），另加 profile 依赖，留出几 GB。

本机侧同时记录 dsh 版本（两端必须一致）：

```bash
dsh --version        # macOS 上可能不在 PATH，实际可执行路径见 local-environment skill
```

## 安装同版本 dsh CLI

版本必须与本机一致：profile bundles/插件按 `engines.dsh` 与 DSH peer 范围做兼容检查，不同版本会被拒绝加载
（临时豁免要显式接受风险，不建议）。先确认公共 registry 有该版本：

```bash
dsh --version                                                    # 以命令输出为准，不要写死版本号
npm view @deepseek-ai/dsh@<version> version bin dist.tarball     # bin 应为 dsh
```

远端**用户级前缀**安装（不 sudo）。npm 12 默认拦截依赖的安装脚本，必须显式审批并 rebuild，
否则原生依赖能力不完整：

```bash
# 1) 建远端安装目录（示例布局：~/.local/share/dsh-cli），并将 package.json 固定到同一版本
ssh "$REMOTE" 'mkdir -p ~/.local/share/dsh-cli'
# 在远端写 ~/.local/share/dsh-cli/package.json：
#   {"name":"dsh-cli-install","private":true,"dependencies":{"@deepseek-ai/dsh":"<version>"}}
ssh "$REMOTE" 'cd ~/.local/share/dsh-cli && npm install --no-audit --no-fund'

# 2) 审批被拦截的安装脚本，再重跑这些包的 install 脚本（-a 对全部依赖生效）
#    包清单以 npm install-scripts ls 现列为准；实测版本为：
#    @deepseek-ai/dsh-subprocess-local、node-pty、@google/genai、protobufjs、koffi
ssh "$REMOTE" 'cd ~/.local/share/dsh-cli && npm install-scripts ls'
ssh "$REMOTE" 'cd ~/.local/share/dsh-cli && npm install-scripts approve -a @deepseek-ai/dsh-subprocess-local node-pty @google/genai protobufjs koffi'
ssh "$REMOTE" 'cd ~/.local/share/dsh-cli && npm rebuild @deepseek-ai/dsh-subprocess-local node-pty @google/genai protobufjs koffi'

# 3) 暴露到 PATH 并校验（远端 ~/.local/bin/dsh 是符号链接）
ssh "$REMOTE" 'mkdir -p ~/.local/bin && ln -sfn ~/.local/share/dsh-cli/node_modules/.bin/dsh ~/.local/bin/dsh'
ssh "$REMOTE" '~/.local/bin/dsh --version'    # 必须与本机一致
```

原生依赖校验（安装脚本审批是否真的生效）：

```bash
ssh "$REMOTE" 'cd ~/.local/share/dsh-cli && node -e "import(\"koffi\").then(()=>console.log(\"KOFFI_OK\"))"'
ssh "$REMOTE" 'cd ~/.local/share/dsh-cli && node -e "const pty=require(\"node-pty\");const p=pty.spawn(\"bash\",[\"-lc\",\"echo PTY_OK\"]);p.onData(d=>{process.stdout.write(d);p.kill();process.exit(0)})"'
```

要点：

- **npm 12 的 allowScripts 拦截**：不审批时 node-pty/koffi 等的 install script 会被跳过——实测 dsh web 仍能启动，
  但原生功能有风险，不要依赖这种状态；按上面显式审批 + rebuild 才是可复现的安装。
- 首次安装为数百包、近 1GB，可能耗时数分钟，不要过早判定卡死；判活看 npm 是否仍在下载（`ps`/网络流量），重装前先确认。
- 远端真实入口是 `~/.local/share/dsh-cli/node_modules/.bin/dsh`（`~/.local/bin/dsh` 指向它）。
- **`~/.local/bin` 不在非交互 ssh 的默认 PATH 里**（ssh 执行命令不 source `~/.zshrc`）：
  `command -v dsh` 为空不代表没装，用绝对路径校验；systemd unit 必须显式 `Environment=PATH=...`。
- 不要 sudo 装全局包；也不要为了省事发到系统目录。

## 初始化 web profile（首次运行）

```bash
ssh "$REMOTE" '~/.local/bin/dsh web --no-open --host 127.0.0.1 --port <port>'   # 首次会建 profile；看到 "dsh web:" 行后 Ctrl-C
ssh "$REMOTE" 'ls ~/.dsh/profiles/web/'                                        # 确认初始化产物
```

首次运行会从随附模板初始化 `$DSH_HOME/profiles/web/`（`$DSH_HOME` 默认 `~/.dsh`）：

- `package.json`：`dsh.profile.bundles` = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`dependencies` 初始为空；
- `cordis.yml`：空的 profile 根（不要手改，组合结果由 patch 层生成）；
- `cordis.patch.yml`：用户补丁层，初始为 `[]`；
- `pnpm-workspace.yaml`；此时还没有 `node_modules`。

要点：

- 初始化要写 `$DSH_HOME`，受限沙盒/只读环境里会失败（本机 web profile 的 EPERM 坑见 `local-environment`）。
- 非默认 profile 名用 `dsh --profile <name> --from-default-profile web`（用随附 web 模板新建/重置）。
- `desktop` profile 名称保留给 Electron：CLI 拒绝其启动与配置 dump，npm 版 CLI 也拒绝其插件管理 → **迁移只搬 web**
  （需要 headless 用途时见下文 headless 坑）。
- 不启动即可校验组合结果：`dsh --profile web --dump-config | head`，能看到 `# == @deepseek-ai/dsh-base` 等分段即正常。

## 迁移 profile 补丁层

配置层级：各 bundle 的 patch → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`。
用户改动应只写 profile 的 `cordis.patch.yml`；patch 会**替换目标行整个 `config`**（不是深合并）。

1. 读源机 `~/.dsh/profiles/web/cordis.patch.yml`，逐项分类：
   - **保留**：主题、搜索/抓取 provider、preset 默认值、`llm-*` 的模型清单与 `apiKeyEnv`。
   - **改默认模型/provider**：源机默认模型可能绑桌面 App 的凭据（例如 `zcode` 来自桌面客户端插件，
     Linux 上没有该宿主）。迁移时改成远端可用的 provider/model，并在 `llm-*` providers 里补对应 `apiKeyEnv`；
     实测可用写法是 `agent-default-model` 用 `opencode-go/deepseek-v4.1-flash`，`llm-pi-ai.providers.opencode-go.apiKeyEnv: OPENCODE_GO_API_KEY`。
   - **改路径**：`sandbox-extra-roots.extraWritableRoots` 等含本机绝对路径的配置。macOS 专有路径在 Linux 不存在，删除；
     实测写入的 Linux 清单（示例，按远端实际目录增删）：`~/.npm`、`~/.bun/install/cache`、`~/.local/share/pnpm`、`~/.cache/pnpm`、`~/.cache/go-build`、`~/go`、`~/.cargo`、`~/.cache/uv`、`~/.cache/pip`、`~/.cache/gh`、`~/.android`、`~/.gradle`、`~/.hvigor`、`~/.ohpm`、`~/.docker/buildx`、`~/.cache/ms-playwright`、`~/.agents`、`~/.dsh`。
   - **删除**：桌面 App / 本机专有插件条目，以及**依赖桌面客户端的插件**（例如依赖 WorkBuddy/ZCode 等桌面应用凭据的
     any-connect 类插件在 Linux 无宿主，不要启用、也不要装；它会把桌面应用的连接方式带进配置）。
2. 备份并写入远端（先备份远端初始化生成的模板 patch）：

```bash
ssh "$REMOTE" 'cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak'   # 远端备份
scp -p ~/.dsh/profiles/web/cordis.patch.yml "$REMOTE":~/.dsh/profiles/web/cordis.patch.yml
```

3. 先装好 patch 引用的外部插件（下一节）再启动；否则 loader 解析不到对应 entry，启动报错。
4. 校验用户层已生效：

```bash
ssh "$REMOTE" '~/.local/bin/dsh --profile web --dump-config | grep -n "patched by"'
```

预期出现形如 `# == <bundle>, patched by ~/.dsh/profiles/web/cordis.patch.yml` 的分段注释。

## 外部插件（tarball / git 分发的组合包）

源机 profile 的 `package.json` 有两处要对照：`dsh.profile.bundles`（**有序**组合包列表）与 `dependencies`
（外部包的安装 spec，常见是 GitHub release tarball URL）。其中 `@deepseek-ai/dsh-*` 是随安装提供的内置 bundle，
由 dsh 安装目录解析、不用装；只有 `@chaoset/*` 这类外部包需要重新安装（不要 rsync `node_modules`：
平台/架构不同，且必须和远端运行时版本匹配）。

两种安装方式（都实测过）：

**方式 A：单包安装**（`dsh plugin --profile web add`，本机验证）：

```bash
ssh "$REMOTE" '~/.local/bin/dsh plugin --profile web add "<tarball-or-git-spec>"'
```

**方式 B：批量安装**（整体覆盖 profile `package.json` 后 `dsh plugin --profile web install`，远端验证）：

```bash
# 把源机 web profile 的 package.json（bundles + dependencies + trustedDependencies）写到远端同名文件
scp -p ~/.dsh/profiles/web/package.json "$REMOTE":~/.dsh/profiles/web/package.json
ssh "$REMOTE" '~/.local/bin/dsh plugin --profile web install'
```

两种方式的共同点与校验：

- `dsh plugin --profile <name> <pnpm args...>` 把参数转发给 profile 目录里的 pnpm；需要 PATH 上有 pnpm。
- `bundles` 顺序必须与源机一致（配置优先级按 bundles 顺序叠加），批量覆盖时尤其要核对。
- 安装成功的标志：profile `package.json` 的 `dependencies` 出现该包，`dsh.profile.bundles` 含该包，
  `~/.dsh/profiles/web/node_modules/<scope>/<pkg>` 出现实体目录。
- 版本不兼容（`engines.dsh` / DSH peer）会让安装失败并恢复 profile 清单与锁文件；不要为了装上去随手加
  `version-exemptions` / `allow-version`，除非用户明确接受风险。
- 校验：

```bash
ssh "$REMOTE" 'ls ~/.dsh/profiles/web/node_modules/@chaoset 2>/dev/null'
ssh "$REMOTE" '~/.local/bin/dsh --profile web --dump-config | grep -n "<插件id>"'
```

### headless profile 的凭据坑

`@deepseek-ai/dsh-headless` 的 bundle 默认把 `credentials`（`@deepseek-ai/dsh-credentials-local`）与
`authorization` 两条 entry 设为 `disabled: true`——设计上一次性任务只认启动环境变量，不读文件型凭据。
若要把 headless 当常驻/服务端用（例如 ssh 一条命令跑任务），需要在远端 headless profile 的
`~/.dsh/profiles/headless/cordis.patch.yml` 里重新启用（该文件首次不存在，新建即可）：

```yaml
- id: credentials
  name: "@deepseek-ai/dsh-credentials-local"
  disabled: false
```

- 未启用时的实测报错：`MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "opencode-go" ...`。
- 启用后 `dsh headless "运行 bash 命令 uname -a 并原样返回"` 可 exit=0 并正确返回远端系统信息，
  证明文件凭据 + bash 工具都通。
- web profile 不受此坑影响（凭据插件默认启用）。

## 凭据迁移

- 凭据存储：`$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`），文件型存储、权限 600；
  由 `dsh-credentials-local` 插件解析，**不会被物化进进程环境**。
- 查找优先级（README 口径）：**存储文件 > 启动环境（进程启动时快照）> 项目 `.env` > `$DSH_HOME/.env`**。
- 复制（内容绝不打印、绝不写文档/commit/日志；凭据文件是 `version/records/refs` 结构，refs 里是 provider 的 apiKeyEnv 名）：

```bash
scp -p ~/.dsh/.credentials.yaml "$REMOTE":~/.dsh/.credentials.yaml      # 只复制，不 cat
ssh "$REMOTE" 'chmod 600 ~/.dsh/.credentials.yaml && stat -c "%a %s %n" ~/.dsh/.credentials.yaml'
# 完整性可核对（不打印内容）：两端 shasum -a 256 / sha256sum 一致
```

- systemd 场景：进程环境是启动时快照；需要环境变量型凭据时用 `EnvironmentFile=`（文件 600，不写进 unit 正文、
  不进 git），或直接依赖凭据文件。两种都别把值贴进 unit 文件。
- 迁移前对齐**名字**（不比对值）：patch 里每个 `apiKeyEnv: <NAME>` 必须在凭据文件或服务环境里有对应项。
- 验证只验证「已配置」：GUI 模型设置页显示可用、启动日志无缺 key 报错、一次最小对话成功——不要读值。
- 红线：任何 token/key/私钥内容不得出现在文档、命令输出、日志、commit；`dsh web` 启动 URL 里的 token 同样算凭据。

## 迁移 skills 与全局 AGENTS.md

DSH 默认用户级发现根（skill-filesystem provider 的 rank 顺序）：

| rank | 来源 | 路径 |
|---|---|---|
| 400 | user-dsh | `$DSH_HOME/skills` |
| 500 | user-agents | `$DSH_AGENTS_HOME` 或 `~/.agents` 下的 `skills/` |

项目级还有 `<projectRoot>/.dsh/skills`（100）与 `<projectRoot>/.agents/skills`（200）。
用户全局指令链：`$DSH_HOME/AGENTS.md` → `<agentsHome>/AGENTS.md`（即 `~/.agents/AGENTS.md`）。

**推荐布局（远端主机）**：通用指令放 `~/.agents/AGENTS.md`（随 agents 配置仓库走、可复用），**主机差异**（路径/工具/端口/服务拓扑）
放 `~/.dsh/AGENTS.md`；两个根都会加载、内容相同会去重，但分开放可以避免每换一台主机就改通用指令。
`~/AGENTS.md` 通常是 `~/.agents/AGENTS.md` 的符号链接（沿用本机约定即可）。
> 本机 macOS 的 `~/.dsh/AGENTS.md` 经 `~/AGENTS.md` 软链到 `~/.agents/AGENTS.md`，**不要在该路径写主机差异**（见 `workspace-and-shell`）；远端主机该文件才是独立文件。

同步（**macOS 默认方案是 tar 管道**，见下节 rsync 坑）：

```bash
COPYFILE_DISABLE=1 tar -C ~/.agents -cf - . | ssh "$REMOTE" 'mkdir -p ~/.agents && tar -C ~/.agents -xf -'
```

- 必须包含 `~/.agents/AGENTS.md`（全局红线在这里）与 `~/.agents/skills/`；`~/.agents/bin/` 可选（如 skill-lint）。
- **只放一处**：不要把同名 skill 同时放进 `<dshHome>/skills` 与 `<agentsHome>/skills`（两个都是用户根，会出现同名漂移）。
- 第三方 skill 的本地改动不要往上游目录追加；项目专属规则不写进用户级 skill。
- 文件级校验：

```bash
ssh "$REMOTE" 'ls ~/.agents/skills | wc -l; head -1 ~/.agents/skills/<name>/SKILL.md'
ssh "$REMOTE" 'chmod +x ~/.agents/bin/skill-lint 2>/dev/null; ~/.agents/bin/skill-lint 2>&1 | tail -2'   # 需 bash + python3
```

- 会话级校验：连上后在对话里让 agent 列出可用 skill / 复述一条 `~/.agents/AGENTS.md` 的规则，确认确实加载了迁移的 skill。

## 跨平台同步文件的坑（macOS → Linux）

- **macOS 自带 rsync 是 openrsync（protocol 29）**，与新版 Linux rsync（3.5.x）协商失败，实测报
  `rsync: [Receiver] buffer overflow: recv_rules (file=exclude.c)`。不要反复调 rsync 参数，改用 tar 管道
  （上一节命令），或只同步真正需要的文件。
- macOS 的 xattr/资源分叉会让 tar 刷 `LIBARCHIVE.xattr` 警告，不影响内容；用 `COPYFILE_DISABLE=1` 抑制。
- `scp -p` 复制单个文件（如凭据、package.json、cordis.patch.yml）不受影响。
- 同步后必须校验：关键文件存在性 `ls`、文件数/条数对比、`sha256sum` 比对，不要只看命令退出码。
- Linux→Linux 之间 rsync 版本一致时，`rsync -a` 仍是更省事的备选。

## 目标机开发工具链（按源机实际清单补齐）

迁移只搬 agent 运行时是不够的：目标机要能真正跑源机上的构建/测试，需要按**源机实际使用的工具**补齐工具链。原则：

1. **先审计源机再装**：列出源机常用 CLI/语言/SDK 版本（如 `command -v` 探测、应用目录、SDK 目录），逐项映射到目标发行版包或官方分发包；不要按发行版「全家桶」默认装。
2. **只装 CLI 构建链，不装 GUI 套件**：无显示器的服务端不装 Android Studio / DevEco / VS Code / 模拟器等；但 JDK、Android SDK cmdline-tools、Gradle wrapper 所依赖的 Java、Godot headless/mono、.NET SDK、Rust 等 CLI 工具是可用的。
3. **版本对齐源机**：版本号以 `--version` 现取，不写死；Arch 上同名包可能比源机新（如 JDK、Rust），优先选与源机主版本一致的包，必要时并行装多个 JDK 由 `archlinux-java` 切换。
4. **环境变量双写**：服务端 agent 的 shell 不读交互 shell 的 rc 文件——
   - systemd unit 加 `EnvironmentFile=-%h/.config/dsh-agent/env`（文件 644、无凭据），写 `JAVA_HOME`/`ANDROID_HOME`/`PATH` 等；重启后用 `/proc/<MainPID>/environ` 复核；
   - 交互与非交互 ssh 都要拿到同一套变量时，写目标用户的 `~/.zshenv`（zsh 每次调用都会读，含 `ssh host 'cmd'` 的非交互执行）；只写 `~/.zshrc` 时非交互 ssh 拿不到，脚本必须用绝对路径或先 source。
5. **工作区级 AGENTS.md**：在 workspace 根写该主机的工作约定（无 GUI、项目按需 clone、构建缓存/沙箱可写目录、工具链路径），让每个会话自动带上目标机约束。

已知取舍（实测）：

- **Office 文档能力不需要系统 LibreOffice**：dsh 安装自带 `@deepseek-ai/libreoffice-kit`，实测 `dsoffice capabilities --json` 的 `runtime.backend=wasm`，转换/渲染/重算可用；**不要**为此装 `libreoffice-fresh`（体积大且用户可能完全不用）。
- **HarmonyOS 命令行工具**（hvigor/ohpm/hdc + 内嵌 SDK）只在华为下载中心提供、需账号登录，无法全自动获取；需要时由用户提供 Command Line Tools 包再解压配 PATH。
- **重复包要清**：如系统 `android-tools` 与 SDK `platform-tools` 都提供 `adb`，保留一个（通常用 SDK 版并确保 PATH 优先）；安装完成后清远端包管理器的下载缓存与 pacman 缓存可回收数 GB（缓存位置见 `local-environment`）。
- 用户明确说「用不到」的工具一律卸载：先用 `pacman -Qi` 看安装体积，再 `pacman -Rs` 连同不再需要的依赖一起删（`-Rs` 无人依赖才删），最后 `df -h` 对比。

> 部署完成后的日常用法——把构建/测试/agent 会话等重负载真正放到目标机执行（远程 GUI、headless、项目同步/回传、资源边界）——见 `remote-heavy-offload` skill。

## systemd 常驻（web 服务）

用户级 unit（无需 root；unit 文件放远端用户目录）。实测模板：

```ini
# 远端 ~/.config/systemd/user/<unit>.service
[Unit]
Description=dsh web (remote agent) 127.0.0.1:<port>
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/<remote-user>/<workspace-dir>
Environment=HOME=/home/<remote-user>
Environment=PATH=/home/<remote-user>/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=LANG=en_US.UTF-8
ExecStart=/home/<remote-user>/.local/bin/dsh web --no-open --host 127.0.0.1 --port <port>
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

- `WorkingDirectory` 决定 dsh 的默认 workspace 根目录（agent 默认读写位置），不能留 `/`。
- 不传 `--host` 时默认只监听 loopback；显式写 `--host 127.0.0.1` 更清楚。`--host` 只接受具体地址，拒绝通配地址。
- `--no-open` 必须加（无浏览器/DISPLAY 环境；SSH 启动本身也会抑制自动打开）。
- **systemd user service 不读 `~/.zshrc`**：PATH、代理、PNPM_HOME 等要么写进 `Environment=`，要么确保默认 PATH 够用
  （`~/.local/bin` 不在默认 PATH 是常见坑）。
- 启用 + 免登录常驻（**linger 通常需要提权**：实测直接 `loginctl enable-linger <user>` 报
  `Could not enable linger: Access denied`，用 `sudo loginctl enable-linger <user>` 才成功）：

```bash
ssh "$REMOTE" 'systemctl --user daemon-reload && systemctl --user enable --now <unit>'
ssh "$REMOTE" 'sudo loginctl enable-linger <user>'
ssh "$REMOTE" 'loginctl show-user "$USER" -p Linger'        # 期望 Linger=yes；/var/lib/systemd/linger/<user> 存在
ssh "$REMOTE" 'systemctl --user is-enabled <unit>'          # 期望 enabled
```

- 时间预期：常规 `systemctl --user restart` 秒级开始监听，首次冷启动/偶发重载可达 30–40s，均属正常；验证时给足 60s 再判定失败，别把等待超时误判成服务异常（判据：`systemctl --user is-active <unit>` = active 且 journal 出现 `dsh web:` 行）。
- 校验：

```bash
ssh "$REMOTE" 'systemctl --user is-active <unit>'
ssh "$REMOTE" 'journalctl --user -u <unit> -n 30 --no-pager | grep "dsh web:"'
ssh "$REMOTE" 'ss -tlnp | grep "127.0.0.1:<port>"'
# 取启动 URL（token 是凭据：记录/输出时一律以 <REDACTED> 示例，不贴原文）
ssh "$REMOTE" "journalctl --user -u <unit> -o cat --no-pager | grep -oE 'http://127\\.0\\.0\\.1:<port>/\\?token=[^[:space:]]+' | tail -1"
```

- 启动日志形如 `dsh web: http://127.0.0.1:<port>/?token=<token>`。token 是**进程级凭据**：只用于本次访问，
  不要粘贴到文档/工单/聊天记录；每次重启都会变化，**旧 token URL 重启后变 401**（实测），新 token URL 仍可 303 换 cookie。
- **cookie 可跨重启**（实测）：会话 cookie 的签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的
  `client-connection/browser-session` 记录里，默认有效期 30 天（`Max-Age=2592000`）；服务重启后，
  同一 authority 下**旧 cookie 不带 token GET `/` 仍返回 200**（实测）。即重启只淘汰 token URL、
  不淘汰浏览器会话。
- **书签用法**：首次用 token URL 换到 cookie 后，只要隧道本地端口固定（authority 不变）且 cookie 未过期，
  日常直接打开 `http://127.0.0.1:<local-port>/`（不带 token）即可，可加入书签；换端口/换主机名等于换
  authority，需要重新用 token URL 换 cookie。服务重启后已有 cookie 的浏览器无需重取 token URL。
- 服务重启：`systemctl --user restart <unit>`（重启后从 journal 重新取 token URL）。

## SSH 隧道访问

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L 127.0.0.1:<local-port>:127.0.0.1:<port> <user>@<host>
```

- 浏览器打开 `http://127.0.0.1:<local-port>/?token=<token>`：把日志里打印 URL 的**端口换成本地隧道端口**，
  host 保持 127.0.0.1。
- **首次访问必须直接用隧道 authority**：Web 认证 cookie 的名字按请求 Host authority 派生（`dsh-auth-<hash>`）。
  先用远端 authority 换 cookie、再换本地端口访问会 401；本地端口与远端端口相同最省心，不同也能用（实测
  本地端口与远端不同时经隧道 401→303→200 全通），但全程必须用同一个 authority。
- 实测到的 cookie 形态：`set-cookie: dsh-auth-<authority 派生 hash>=<signed>; Max-Age=2592000; Path=/; HttpOnly;
  SameSite=Strict`；同 authority 带 cookie GET `/` 返回 200（页面 title 含 DeepSeek Harness），
  把 Host 改成远端 authority 再打隧道端口 → 401（反证 cookie 名按 authority 派生）。
- **固定本地端口 + 书签**：完成一次 token→cookie 后，把 `http://127.0.0.1:<local-port>/` 加入书签；
  只要隧道一直用同一个本地端口（authority 不变）且 cookie 未过期，直接打开书签即可，无需再带 token。
  服务重启不影响 cookie；只有清 cookie、换端口或换主机名时才需要重新从 journal 取 token URL。
- 日常可把主机与转发固化进 `~/.ssh/config` 的 Host 别名（HostName/User/LocalForward），之后 `ssh -N <alias>`
  即起隧道；具体别名与端口属于本机事实，见 `local-environment` skill。
- 诊断口径：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<local-port>/   # 401 = 链路通、未认证（预期）
```

| 现象 | 含义 / 处理 |
|---|---|
| 401 | 链路正常但没带 token/cookie；或进程重启后 token 变了；或换了 authority（cookie 名不匹配） |
| 403 | Host/Origin 栅栏拒绝：用了非 loopback 的 authority，或反向代理场景没配 `--trusted-host` |
| 303 + Set-Cookie | token 交换成功；随后同 authority 的 `/` 应 200 |
| 连接被拒/超时 | 隧道没起、端口写错，或远端服务没在监听 |

- 隧道断开时页面全部请求失败；保持 ssh 会话可用 autossh 或客户端自带的断线重连。
- 服务刚重启的几秒内隧道转发可能报 `connect failed: Connection refused`，等 ready 后再访问。

## 验收清单

全部通过才算迁移完成（逐条实际执行）：

- [ ] 两端版本一致：本机 `dsh --version` == 远端 `~/.local/bin/dsh --version`
- [ ] 原生依赖可用：`KOFFI_OK`、`PTY_OK`（见安装节命令）
- [ ] profile 初始化且用户层生效：`ls ~/.dsh/profiles/web/` 有 package.json/cordis.patch.yml；`--dump-config | grep "patched by"` 有输出
- [ ] 外部插件在远端可解析：`ls ~/.dsh/profiles/web/node_modules/<scope>/<pkg>` 存在，`--dump-config` 能看到对应条目
- [ ] 服务常驻：`systemctl --user is-active <unit>` = active；`systemctl --user is-enabled <unit>` = enabled；Linger=yes
- [ ] 监听正确：`ss -tlnp | grep 127.0.0.1:<port>`
- [ ] 认证链路：远端 loopback 无 token = 401；隧道后同样 401；带 token 303 → cookie 后 200（首页 title 含 DeepSeek Harness）；把 Host 换成远端 authority 打隧道端口 = 401（特权分离生效）
- [ ] 重启与轮换：`systemctl --user restart <unit>` rc=0，约 5s 开始监听；旧 token URL = 401、新 token URL = 303；**同一 authority 的旧 cookie 不带 token GET `/` 仍 = 200**（cookie 跨重启有效）
- [ ] 书签可用：固定隧道本地端口后，不带 token 直接打开 `http://127.0.0.1:<local-port>/` = 200（可加入书签）
- [ ] agent 确实在远端执行：在 GUI 里让 agent 跑 `uname -a; hostname`，输出必须是远端而不是本机
- [ ] skills/AGENTS.md 生效：会话里能列出迁移的自建 skill，`~/.agents/AGENTS.md` 与 `~/.dsh/AGENTS.md` 的规则被加载
- [ ] 凭据：`stat -c '%a' ~/.dsh/.credentials.yaml` = 600；一次模型调用成功；文档/日志无凭据内容
- [ ] 重启稳定性：`systemctl --user restart <unit>` 后恢复 active 且重新取 URL 可访问；重启主机/重启 WSL 后服务能自动起来（受 linger 与 WSL 行为影响，见下）

## WSL2 与平台差异坑

- **NAT 与 LAN 直连**：WSL2 默认 NAT，distro 内 `eth0` 是 172.x 私网地址，LAN 设备不能直接访问 distro 端口。
  能 ssh 登录只说明 Windows 侧有转发或网络模式配置，**不要据此假设 dsh 端口也能从 LAN 直连**——一律用 ssh 隧道。
- **systemd**：WSL2 需要 `/etc/wsl.conf` 里 `[boot] systemd=true` 并重启 distro；验证 `ps -p 1 -o comm=` 输出 systemd、
  `systemctl --user is-system-running` 为 running。没有 systemd 时只能用 tmux/nohup 兜底，不推荐长期。
- **linger**：`Linger=no` 时用户服务随最后一个会话退出；`loginctl enable-linger` 后才开机自启/免登录常驻（可能需要授权）。
- **WSL 空闲回收**：WSL2 在没有会话时是否终止 distro 取决于 Windows 侧行为。迁移后要实测：关掉所有 ssh 会话几分钟后，
  从 Windows `wsl -l -v` 看 distro STATE，或重新 ssh 后查 `systemctl --user is-active <unit>`。不满足时用 Windows 侧
  计划任务/常驻方式保活（按平台文档），不要假设「服务装了就一直活着」。
- **系统级依赖差异**：远端 Node/npm 由发行版包管理器提供（滚动发行版会升级）；升级后重跑 `dsh --version` 与
  `dsh web` 启动验证。npm 全局 prefix 可能是 `/usr`，非 root 不可写——用用户前缀安装。
- **npm 安装脚本策略**：npm 11+/12 默认按 allowScripts 跳过依赖安装脚本，见安装节的审批流程；不要 `--ignore-scripts` 一刀切。
- **服务环境不继承登录 shell**：代理、PATH、PNPM_HOME 等要显式写 unit 的 `Environment=`；安装阶段的交互 shell
  代理与服务运行环境是两套，不要混。
- **已知良性告警**：某些外部插件在 `dsh web --help` / 组合检查路径会打印
  `settings gateway unavailable: typert-protocol is unavailable ...` 或 `remote gateway unavailable: ...`
  （例如 sandbox-extra-roots、session-archive 这类外部插件的配置入口）。**运行中的服务 journal 只有 Started
  与 URL 行、无 warn/error 时，按良性告警处理，不要写成故障**。
- **沙箱**：WSL2 上 dsh 沙箱按 `workspace-write` 工作（landlock/bwrap 可用性视内核与发行版而定）；如需放行目录，
  按 `sandbox-adaptation` skill 加到 `sandbox-extra-roots` 配置，不要关沙盒。
- **macOS 侧**：桌面 App 自带的 dsh CLI 可能不在 PATH（用绝对路径或软链）；版本以 `dsh --version` 为准。
- **profile/patch 的 macOS 痕迹**：`cordis.patch.yml` 里的 `~/Library/...` 等路径在 Linux 不存在；`desktop` profile 不迁移。

## 回退与清理

```bash
ssh "$REMOTE" 'systemctl --user disable --now <unit> && rm ~/.config/systemd/user/<unit>.service && systemctl --user daemon-reload'
```

- 重置自定义 profile 到随附模板：`dsh --profile <name> --from-default-profile web`（替换该 profile 内容，已有配置会丢，谨慎）。
  web profile 自身要回默认时：先备份 `~/.dsh/profiles/web`，再删除该目录后首次运行重建（会丢现有 patch 与插件）。
- 凭据：先在 provider 侧吊销/轮换，再删除远端凭据文件；只删本地副本不算 revocation。
- `~/.agents`、workspace 数据按需保留或删除；不要在服务运行时直接删 `~/.dsh`（含会话与凭据）。
- 关闭隧道 ssh 进程（不要把隧道当常驻服务遗留在后台）。

## 本规程的事实来源与复核

- dsh CLI 入口/flag：`dsh --help`、`dsh web --help`（每次以实际输出为准，不凭记忆）。
- profile 层叠与 bundles 顺序：dsh 包内 `README.zh.md`「Profile」一节。
- skills 发现根 / AGENTS.md 加载链 / 凭据优先级：dsh 包内 `dsh-skill-filesystem`、`dsh-agent-instructions`、
  `dsh-credentials-local` 的 `README.zh.md`。
- 访问与认证行为：`dsh web` 实际启动输出 + `curl` 状态码（401/303/200）+ 浏览器实际加载。
- 两端的「这台机器有什么」：见 `local-environment` skill（本机事实），换主机后必须重新核实改写。
