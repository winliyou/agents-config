# agents 配置仓库

AI 代理的用户级配置：全局指令 `AGENTS.md` 与全部用户级 skills（`skills/`，由 harness 按 Frontmatter 自动发现挂载）。

## 新主机 bootstrap

```bash
git clone <本仓库> ~/.agents
ln -s ~/.agents/AGENTS.md ~/AGENTS.md
ln -s ~/.agents/bin/agent-browser ~/.local/bin/agent-browser
```

注意：

- `bin/agent-browser` 是自建包装器（会话固化 + 沙盒自适应，被 hotspot/frontend、dsh-plugins 的 skill 依赖），前置依赖：`agent-browser` 本体已通过 bun 安装在 `~/.bun/bin`（见 `toolchain-setup` skill）；

- `skills/local-environment/` 记录的是单台主机的实测事实（路径、已装工具、凭据归档位置），换主机必须逐条重新核实改写；
- `~/work/dogod/cf_token_and_cert/` 等凭据目录**不在本仓库**，需按 `local-environment` 的描述在新主机单独重建；
- 项目级配置（各仓库的 `AGENTS.md` 与 `.agents/skills/`）随各项目仓库走，不在这里。

## 第三方 skill（不归本仓库维护）

来自外部仓库或上游发布包，本地改了会被覆盖，**不在维护范围内**：

| 判定来源 | 说明 |
|---|---|
| `.third-party-skills` | 显式清单（自动识别不出来时手工登记） |
| `.skill-lock.json` | skills CLI 锁定的来源与 hash（`agent-browser`、`find-skills`） |
| frontmatter 特征 | 带 `metadata.author` / `license:` / `argument-hint:` 的上游格式 |

规则：不追着修它们失效的路径/命令、不要求它们带实测日期；**绝不往里追加本地内容**
（上游更新会静默冲掉），需要补充就写自建 skill。`skill-lint` 默认跳过，输出 `SKIP` 属预期，
加 `--with-third-party` 才检查。

### 更新（官方 CLI，2026-10-31 实测）

统一用 skills CLI，不要手工改文件：

```bash
npx skills list -g              # 看每个 skill 的 Source：非 local 才可更新
npx skills update -g -y         # 更新全部全局 skill
npx skills update <name> -g -y  # 只更新指定 skill
```

**坑：`update` 只比对远端版本，检测不到本地漂移。** 若模板文件被手工改过而远端没发新版，
`update` 会报「all up to date」却留着本地改动。要拿回纯净上游版必须重装：

```bash
npx skills remove -g -s <name> -y
npx skills add <owner/repo> -g -y -s <name> --copy
```

### 两类的更新能力不同

| skill | Source | 能否 `npx skills update` |
|---|---|---|
| `agent-browser` | `vercel-labs/agent-browser` | 能 |
| `find-skills` | `vercel-labs/skills` | 能 |
| `brand` / `design` / `design-system` / `slides` / `ui-styling` / `ui-ux-pro-max` | `local` | **不能**，官方 CLI 不知道来源 |

后 6 个来自 ClaudeKit（`metadata.author: claudekit`），官方更新通道是它自己的 CLI：

```bash
npm i -g claudekit-cli                                  # 提供 ck 命令（npm 实测 v4.5.2）
ck skills --list                                        # 列官方 skill（需先有 ClaudeKit 安装）
ck skills --name <skill> -a claude-code -g -y           # 装/更新单个 skill
ck init -g --kit engineer                               # 更新整套 kit
```

**但当前账号拿不到官方源（2026-10-31 实测）**：

- 官方仓库是 `claudekit/claudekit-engineer`（私有）。`ck versions` 实测报：
  `404 ... You may not have been invited to the repository yet`。
- gh CLI 已登录 `winliyou`（含 `repo` scope），但该仓库同样 404；无待接受邀请；
  org 成员只有 `WuLongTou` / `ShanWuYinShe`。**这是权限问题，gh token 解决不了。**
- `ck init --use-git` 可改用 SSH/HTTPS 凭据，但同样要求仓库权限。

**公开镜像不能替代更新**（已逐个核对，都是旧快照且结构不同）：

| 公开仓库 | 最后推送 | 含我们哪些 skill | 能否代替 |
|---|---|---|---|
| `mrgoonie/claudekit-skills`（作者是 bestagentkits 创始人） | 2026-04-03 | 仅 `ui-styling` | 否（本地 2026-09-18 装，公开版更旧） |
| `bestagentkits/ck-skills` | 2026-05-18 | `design`、`ui-ux-pro-max` | 否（`design` 的 name 是 `ckm:design`，改名会破坏引用） |
| `bestagentkits/agency-skills` | 2026-06-30 | `design-system` | 否（162 行 vs 本地 244 行，是另一变体） |

另有两点操作前提：`ck` 默认装到 `~/.claude/skills/`，而 DSH 读 `~/.agents/skills/`，装完需同步；
`brand` / `slides` 在以上公开仓库里都找不到。

**结论**：在被邀请进 `claudekit/claudekit-engineer` 之前，这 6 个只能当 `local` 副本用。
拿到权限后一行命令即可：`GH_TOKEN=$(gh auth token) ck skills --name <skill> -a claude-code -g -y`。



## 知识保鲜与自检

沉淀会腐烂：旧结论随工具升级、项目迭代变成错误，继续沿用会主动误导后续 AI。
规程见 `knowledge-maintenance` skill，红线见 `AGENTS.md`「知识保鲜」一节。

```bash
skill-lint                    # 体检用户级 skills（~/.agents/skills）
skill-lint --all              # 体检用户级 + ~/work 下全部项目级
skill-lint --json             # 机器可读
skill-lint --with-third-party # 连第三方 skill 一起查（默认跳过）
```

检测：frontmatter 缺失（DSH 会静默忽略该 skill）、description 超 500 字符（目录截断丢触发词）、
引用路径不存在、引用不存在的 skill 名、全文无实测日期、项目级孤儿 skill（无任何 Markdown 提及）。

退出码 0 = 无 ERROR。**每次新增或大改 skill 后建议跑一次**；ERROR 必修，WARN 逐条判断
（「路径不存在」在说明某文件本机未配置时属正确描述，脚本已对含「不存在/未配置」的行豁免）。