---
name: workspace-and-shell
description: AI 中间文件落盘位置（.workwork/ 按工作树隔离）、任务收尾清理与 shell 脚本/工作目录已知坑。触发：需要写计划/笔记/截图/调研草稿/临时产物，或决定中间文件该放哪、可否写进 docs/；任务收尾清理 .workwork 临时文件、主工作树 .workwork 残留占盘、跨项目清理遗留（workwork-gc）；写或生成 shell 脚本、`$VAR` 后接中文/全角字符、报 `unbound variable` 且变量名带乱码、输出静默少字（变量展开必须用 `${VAR}`，用 shell-var-brace-check 自检）；命令莫名失败且报错指向 shell 二进制（spawn ENOENT、spawn /bin/zsh ENOENT）或 cwd 被删后全部命令失效；怀疑文件改错位置、误改主检出而非 worktree；怀疑长文件读写被静默截断丢内容。
---

# 工作目录与 Shell 陷阱（Workspace & Shell）

写中间产物、或不理解某个"报错指向 shell"的诡异失败时加载。

## AI 中间文件落盘：项目根 `.workwork/`

- AI 工作期间产生的所有中间文件一律写入项目根 `.workwork/`（需确保已加入项目 .gitignore），包括但不限于：计划文件、进度文件、任务清单、截图、设计文档草稿（SDD）、调研笔记、方案对比记录、会话记录、临时导出产物等。
- `.workwork/` 按工作树严格隔离，不在不同 worktree 之间共享：中间文件一律写入**当前所在工作树根**下的 `.workwork/`；**禁止写**另一棵树的 `.workwork/`（产物混入、误清理），只读引用可以（如取上一任务的证据/脚本），但只能作参考，不得当作本任务产物清理或当成最新事实。worktree 的 `.workwork/` 属该分支临时产物，随 worktree 一并删除（见 `git-workflow` skill 的合并流程，默认可丢弃）。
- **按任务建子目录**：每个任务在 `.workwork/<任务 slug>/` 下工作（如 `.workwork/ui-r14/`、`.workwork/verify-rc3/`），计划、截图、日志、脚本、验证产物都放该目录；禁止把大批文件平铺在 `.workwork/` 根下——平铺后只能整体猜着删，按任务清理无从下手。
- **禁止把 `docs/`、`doc/`、`documentation/` 等目录当作 AI 实现过程的文件目录**（计划、进度、任务清单、调研笔记等一律不得写入）；`docs/` 只存放项目的真实文档（用户文档、API 文档、架构文档等需提交的内容）。
- 发现 AI 中间文件被误写入 `docs/` 或项目其他位置时，将其迁移到 `.workwork/` 对应位置，并视情况清理 `git status` 中多余的变更。
- `.workwork/` 禁止存放任何需要提交的代码或配置。
- 例外：项目确需把 `.workwork/` 兼作运行时数据目录时，须在该项目 AGENTS.md 显式声明；默认仍仅放 AI 中间文件。

## `.workwork/` 生命周期与收尾清理（红线）

`.workwork/` 没有任何自动清理机制：worktree 的随 worktree 删除，**主工作树的必须自己清**，否则每次任务都会留下几十 MB 到数 GB 残留。

- **任务收尾即删**：给出最终答复前 `rm -rf .workwork/<任务 slug>`，并用 `du -sh .workwork` 复核；默认不保留——「以后可能有用」不构成保留理由，用户明确要求保留的当场挪到交付位置或作为附件发出后再删。任务中断、切换任务同样先清理。
- **主工作树是重点**：只读/验证类任务通常不开 worktree，直接在主工作树产生残留；这类任务的收尾清理与 worktree 内的任务同等强制。同一会话开始新任务前先确认无自己上次任务的残留。需要保留大量验证产物、或验证本身很重的任务，开 worktree 做并随 worktree 一起丢弃，比事后手工清 `.workwork` 更彻底。
- **不删的例外**：项目 AGENTS.md 显式声明的运行时/持久数据（采集数据目录、设备状态文件等）；跨任务复用的构建缓存（gocache、bun-cache、模块缓存）由批量巡检按年龄清理，不要求每次任务收尾删除，但禁止无上限膨胀——repo 副本、浏览器 profile、容器导出等大产物用完即删。
- **归属判断**：非本次任务产生的条目按最新修改时间判断（`find <条目> -type f -exec stat -f '%m' {} + | sort -rn | head -1`）：7 天以上未修改视为可清；近期修改但确认无活跃会话/任务的也可清；无法确认时先把报告给用户再动。
- **批量巡检与清理**：`~/.agents/bin/workwork-gc` 只读报告各项目 `.workwork` 的体积、最新修改时间与可清理量；`workwork-gc --prune`（默认 7 天阈值，`--days N` 可调）删除超龄顶层条目，`--project <dir>` 只处理单个项目，`--roots a,b` 指定扫描根（默认扫描 `~/work` 与 `~/Documents/deepseek-harness` 两个根）。worktree 池内的 `.workwork` 随 worktree 删除、只报告不清理；未合并的遗留 worktree 按 `git-workflow` 删除 worktree，而不是只删其 `.workwork`。
- **错误信号**：出现 `.workwork/.workwork` 嵌套 = 某次会话把 `.workwork` 当成了项目根（cwd 错），删除嵌套并核对 `pwd`；`.workwork` 出现在 `git status` 里 = 项目漏配忽略规则，当场补 `.gitignore`（判据 `git check-ignore -v .workwork`）。

## skill 发现范围与工具默认输出目录

- skill 发现范围（按 DSH `skill-filesystem` 的发现顺序，共 5 个根，优先级从高到低）：项目根的 `.dsh/skills`、项目根的 `.agents/skills`、`$DSH_HOME/skills`（本机默认 `~/.dsh/skills`，当前不存在属正常）、`$DSH_AGENTS_HOME/skills`（本机未设该变量，回退默认 `~/.agents/skills`；**变量名不是 `$AGENTS_HOME`**，asar 内 `AGENTS_HOME_ENV = "DSH_AGENTS_HOME"`）、内置 bundled。`.workwork/` 下的依赖缓存（go-mod、bun caches 等自带 skill）不在发现范围——靠 `.gitignore` 隔离、永不提交；`.claude/skills` 双轨目录不另起一套，一律搬入项目根的 `.agents/skills` 目录。
  - 本机 `~/.dsh/AGENTS.md` 经 `~/AGENTS.md` 间接软链到 `~/.agents/AGENTS.md`（`ls -l` 可见链路），内容只有一份，不要在 `~/.dsh/` 下写主机差异；远端主机该文件才是独立文件（见 `remote-agent-env`）。
- 各 AI 工具（opencode/claude/superpowers/zcode 等）的默认输出目录应配置指向 `.workwork/`；工具的固定路径配置不解除按工作树隔离的义务——在 worktree 内工作时输出仍写入该 worktree 的 `.workwork/`。

## shell cwd 被删除 → 后续命令全部报 spawn ENOENT

- 根因（受控实验证实）：Bash 工具以「上一次调用的工作目录」作为 spawn 的 cwd，该目录被删除后（git worktree remove、rm -rf、依赖重装等）所有后续命令报 `spawn /bin/zsh ENOENT`；报错指向 shell 二进制而非缺失目录，极具误导性，不要往 shell、权限、系统环境方向排查。
- 预防：cd 进某个目录工作结束后（尤其 remove worktree、rm -rf 该目录之前），先 `cd` 回项目根再执行删除；长任务不把持久化工作目录留在临时/worktree 目录里。
- 自愈（遇故障禁止盲目重试或等待）：用 Write 工具在缺失目录内写入任意文件（Write 会自动创建父目录）重建目录 → Bash 立即恢复 → 立即 `cd` 回项目根 → 清理临时标记文件。恢复后第一条命令用 `pwd` 确认。

## cwd 跨调用驻留：写文件前先确认目录

- shell 的 cwd 在多次工具调用间保留：一切会产生文件改动的操作（内联脚本、`sed -i`、代码生成等）必须先 `cd` 进目标目录或写绝对路径；提交前用 `pwd` + `git status` 确认位置，避免以为在 worktree、实际改了主检出。

## bash 改过的文件会让 edit 工具版本守卫失效

- **bash（`sed -i` / python / 重定向）改过的文件会让 edit 工具「读后才可改」的版本失效**：紧接着 edit 同一路径会报 `file has not been read`（该路径从未 read 过）或 `file changed since it was read`（read 过但被 bash 改过）；这不是权限或沙盒问题，重新 read 一次该路径即可继续（同一会话可反复出现）。穿插 bash 改动与 edit 时按「bash 改 → read → edit」排序。

## 长文件 read→write 会静默截断

- read 按行分页、超长静默截断：先分页读到累计行数等于 `totalLines`（或本次 read 未报截断）再整文件写回；无法确认读全时不要 read→write 整文件往返，改用按行精确操作（`sed -i` 按行寻址、python 按行替换、edit 工具）。改完用 `git diff --numstat`（增删应对称）+ `wc -l` 对 HEAD 验行数一致；一旦失衡立即 `git restore -- <file>` 恢复重做，不要在坏文件上继续改。
  - **这条同样约束 python 脚本里的 `read_text()` → `replace()` → `write_text()`**：那不是「按行替换」而是整文件往返，照样截断（表现为 diff 里出现上百行删除，而实际改动只有几行；同一次脚本里改的其他文件可能根本没落盘）。**首选做法：长文件一律用 edit 工具（自带版本守卫）逐处改**；必须用脚本时只在**短文件**上用，且写盘后立刻 `git diff --numstat` 自检，失衡就 `git restore -- <file>` 重来。
  - 判别信号：意图只有几行改动，`git diff --stat` 却出现几十/几百行删除 —— 立即停下核对，别在该文件上继续叠加改动。

## Shell 变量展开：一律 `${VAR}`，禁止 `$VAR` 后接非 ASCII

本机 `bash` / `/bin/bash` 均为 **3.2.57**（locale `zh_CN.UTF-8`）。`$VAR` 后紧跟任何非 ASCII 字节（中文、全角括号 `（`、句号 `。`、省略号 `…`）时，bash 3.2 会把该字符首字节并入变量名：

- `set -u` 下直接中断：`VAR<0xXX>: unbound variable`；
- 无 `set -u` 时不报错但**静默丢字符**（实测 `V=x; echo "$V）"` 输出只剩半个 `）`），比报错更难查。

**硬规则**：写/生成任何 shell 脚本（含落盘脚本、heredoc、`bash -c` 片段）时，参数展开一律 `${VAR}` 花括号定界，不按「后面是不是中文」挑着加；不要赌运行环境是新版 bash（`#!/usr/bin/env bash` 在沙盒/极简 PATH 下仍可能命中 3.2）。

**自检（脚本落地后、提交前）**：

```bash
~/.agents/bin/shell-var-brace-check path/to/script.sh   # 报出每处 `$VAR` 紧跟非 ASCII；--fix 自动加花括号
bash -n path/to/script.sh                                # 语法兜底
```

- 工具支持目录递归（`.sh/.bash` + bash/sh shebang）、无参数时默认检查 git 暂存区脚本；退出码非 0 即存在风险，提交/CI 里可直接挡住。
- 报错里出现 `VAR<0x..>: unbound variable` 或输出莫名少字时，先按「变量名被多字节字符首字节污染」排查，别往权限、环境、编码方向找。

## 模板串里生成 shell 的规范（TS/JS × bash）

在编程语言模板字符串里写 bash 是高频事故源，写之前过此清单：

1. **bash 的「美元符+花括号」序列一律转义后写入**——含参数展开、默认值等一切形式，否则被模板引擎当插值解析，报 Unexpected token（一处参数展开未转义即可致整个程序解析失败）。写完目测一遍有无裸序列；**更稳的做法：复杂 bash 片段独立落盘为脚本文件再执行，或在 TS 中改用单引号字符串数组（反引号与美元花括号均无需转义），heredoc 尽量避免**。
2. **模板串内嵌 markdown 行内代码的反引号会提前终止字符串**——报 missing required property 或 Expression expected。要么全部转义，要么改用单引号字符串。
3. **edit 的 old_string 从 read 输出原样复制**，禁止凭记忆重打——全角/半角标点（半角逗号 vs 全角逗号、半角冒号 vs 全角冒号）差异必致匹配失败。
4. **bash 片段改完立即 bash -n 语法检查再投入使用**；重要脚本过 shellcheck（本机 0.11.0，`shellcheck -S style <file>`）。
5. **模板串里写含反斜杠的代码（C++ 字符串字面量、Windows 注册表/文件路径等）**：模板串 `\\` 落盘只剩一个反斜杠，C++ `L"Software\Chaoset"` 里的 `\C` 是非法转义——编译器只给警告、注册表键名被静默改错（功能失效而非编译失败，交叉编译 CI 抓不到）。写时源码层要翻倍（TS 里写四道杠落盘两道杠），落盘后必须用 grep 工具核对实际字节（与既有同类代码逐字节对照）；注释里的路径不经过转义、无需翻倍，只有**代码字符串字面量**受影响。mingw 本机可用时，单文件 `-fsyntax-only -std=c++17 -DUNICODE` 是秒级兜底。

## macOS/BSD 工具链与解析规范

1. `cat -A` 不存在（GNU 专属）→ 用 `cat -evt`（BSD 等价于 `-vET`：`-e` 行尾 `$`、`-t` 制表符 `^I`、`-v` 不可打印字符；只写 `-ev` 不显示制表符）；GNU 专属选项先验证再用。
2. grep 模式以 `-` 开头必须 `grep -e` 加模式（或 `--` 分隔）——`->` 前缀会报 invalid option，端口自愈链因此失效。
3. grep 多 pattern 用多个 `-e`（或 ERE 的 `|`）：`\|` 的正则方言不一致——默认 BRE 下是 alternation，`grep -E` 与 DSH grep 工具（ripgrep）下是字面量 `|`，会整段漏匹配（系统 BSD grep 的 `\|` 两分支均命中；`grep -E 'a\|b'` 与 ripgrep 均 0 命中），据此会误判「文件未修改」。
4. **统计进程/对象禁止按命令行关键词 grep 计数**：daemon 进程名统一（如 agent-browser-darwin），按 session 名 grep 恒为数 0（实际 2 个）；按「Google Chrome」计数把用户日常浏览器混进来（误报双实例）。用 `lsof -p <pid>` 看 fd/sock 归属，或 `pgrep -f 完整特征串`。
5. **清理类操作禁止盲删「非当前/非自己的」对象**（如按「除第一个外全关」清理 tab，若那些不是死残留而是活跃会话的 tab，就会误关活跃页面）。先甄别归属，只删确属自己或确认已死的。
6. 管道后 `$?` 是末命令的退出码；要真实退出码先落盘（`cmd > log` 后 `echo $?`）或用 PIPESTATUS。
7. **消费第三方 CLI 的参数分隔/解析规则先实测再依赖**：README 写「comma or newline separated」，agent-browser 0.38.2 换行不生效、逗号硬拆——含逗号的值（如 Chrome `--window-position=x,y`）经此通道必然损坏，残尾数字被 Chrome 当整数 IP URL（即「0.0.3.32 tab」现象，0.0.3.32 = 整数 800）。产品侧细节见 `browser-automation-safety` skill。

## 检索审计：显式补查 gitignored 目录

内容检索工具（DSH 的 grep 工具，ripgrep 内核）默认遵守 `.gitignore`：`.agents/worktrees/`、`.workwork/`、`node_modules/` 会被静默跳过；系统 `grep -r` 不读 `.gitignore`，会照常搜到这些目录，不能拿它的结果判断「主检索」范围。

- 做「全库有没有用 X」类审计时，**主检索之外必须按目录显式补查这两类路径**（如 `grep -rl 关键字 <项目>/.agents/worktrees <项目>/.workwork`；仓库仍有历史 `.worktrees/` 检出时一并补查；或对 DSH grep 工具显式传目录路径——显式路径不受 ignore 过滤），并核对结果总数是否触达工具的返回上限。
- 漏查可致 30 个引用文件（含整个 worktree 的脚本副本）被漏掉，使「某模式只有 A 项目在用」的结论失真；依赖类冲突（playwright/puppeteer）还要查 lockfile，不能只 grep 源码。
