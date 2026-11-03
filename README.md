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

### 更新（官方 CLI）

统一用 skills CLI，不要手工改文件：

```bash
npx skills list -g              # 看每个 skill 的 Source：非 local 才可更新
npx skills update -g -y         # 更新全部全局 skill
npx skills update <name> -g -y  # 只更新指定 skill
```

**坑 1：`update` 只比对远端版本，检测不到本地漂移。** 若文件被手工改过而远端没发新版，
`update` 会报「all up to date」却留着本地改动。要拿回纯净上游版必须重装：

```bash
npx skills remove -g -s <name> -y
npx skills add <owner/repo> -g -y -s <name> --copy
```

**坑 2：`-s` 不支持逗号分隔**，要写多个 `-s`：`-s brand -s design -s slides`。
写成一个 `-s "brand,design"` 会报 `No matching skills found`。

**坑 3：从本地路径安装会把 lock 记成本地路径**（`source: /tmp/xxx`），之后 `update` 失效。
必须用 `owner/repo` 形式安装，`npx skills list -g` 确认 Source 是仓库名而不是路径。

### 当前 8 个第三方 skill 的来源（全部可 `npx skills update`）

| skill | Source |
|---|---|
| `agent-browser` | `vercel-labs/agent-browser` |
| `find-skills` | `vercel-labs/skills` |
| `brand` / `design` / `design-system` / `slides` / `ui-styling` / `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill` |

后 6 个的 frontmatter 里写着 `metadata.author: claudekit`，但**实际来源是公开仓库
`nextlevelbuilder/ui-ux-pro-max-skill`**。已按此来源纳入 CLI 跟踪：

```bash
npx skills add nextlevelbuilder/ui-ux-pro-max-skill -g -y \
  -s brand -s design -s design-system -s slides -s ui-styling -s ui-ux-pro-max --copy
```

> 判定来源不要只看 frontmatter 的 `metadata.author`（会被上游作者字段误导）；以
> `npx skills list -g` 的 Source 列为准，查不到时用特征文件名去 GitHub 代码搜索反查
> （例如 `claudekit-pitch-251223`、`inject-brand-context` 这类特征串）。

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
引用路径不存在、引用不存在的 skill 名、正文出现日期标注、项目级孤儿 skill（无任何 Markdown 提及）。

退出码 0 = 无 ERROR。**每次新增或大改 skill 后建议跑一次**；ERROR 必修，WARN 逐条判断
（「路径不存在」在说明某文件本机未配置时属正确描述，脚本已对含「不存在/未配置」的行豁免）。