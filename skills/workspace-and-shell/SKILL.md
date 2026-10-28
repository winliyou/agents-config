---
name: workspace-and-shell
description: AI 中间文件落盘位置（.workwork/ 按工作树隔离）与 shell 工作目录已知坑。触发：需要写计划/笔记/截图/调研草稿/临时产物，或决定中间文件该放哪、可否写进 docs/；命令莫名失败且报错指向 shell 二进制（spawn ENOENT、spawn /bin/zsh ENOENT）或 cwd 被删后全部命令失效；怀疑文件改错位置、误改主检出而非 worktree；怀疑长文件读写被静默截断丢内容。
---

# 工作目录与 Shell 陷阱（Workspace & Shell）

写中间产物、或不理解某个"报错指向 shell"的诡异失败时加载。

## AI 中间文件落盘：项目根 `.workwork/`

- AI 工作期间产生的所有中间文件一律写入项目根 `.workwork/`（需确保已加入项目 .gitignore），包括但不限于：计划文件、进度文件、任务清单、截图、设计文档草稿（SDD）、调研笔记、方案对比记录、会话记录、临时导出产物等。
- `.workwork/` 按工作树严格隔离，不在不同 worktree 之间共享：中间文件一律写入**当前所在工作树根**下的 `.workwork/`；在 worktree 内工作时禁止读写主工作树的 `.workwork/`，反之亦然，避免并行线互相干扰。worktree 的 `.workwork/` 属该分支临时产物，随 worktree 一并删除（见 `git-workflow` skill 的合并流程，默认可丢弃）。
- **禁止把 `docs/`、`doc/`、`documentation/` 等目录当作 AI 实现过程的文件目录**（计划、进度、任务清单、调研笔记等一律不得写入）；`docs/` 只存放项目的真实文档（用户文档、API 文档、架构文档等需提交的内容）。
- 发现 AI 中间文件被误写入 `docs/` 或项目其他位置时，将其迁移到 `.workwork/` 对应位置，并视情况清理 `git status` 中多余的变更。
- `.workwork/` 禁止存放任何需要提交的代码或配置。
- 例外：项目确需把 `.workwork/` 兼作运行时数据目录时，须在该项目 AGENTS.md 显式声明；默认仍仅放 AI 中间文件。

## skill 发现范围与工具默认输出目录

- skill 发现范围：只认各仓库 `.agents/skills/` 与用户级 `~/.agents/skills/`。`.workwork/` 下的依赖缓存（go-mod、bun caches 等自带 skill）不在发现范围——靠 `.gitignore` 隔离、永不提交；`.claude/skills` 双轨目录不另起一套，一律搬入 `.agents/skills/`。
- 各 AI 工具（opencode/claude/superpowers/zcode 等）的默认输出目录应配置指向 `.workwork/`；工具的固定路径配置不解除按工作树隔离的义务——在 worktree 内工作时输出仍写入该 worktree 的 `.workwork/`。

## shell cwd 被删除 → 后续命令全部报 spawn ENOENT

- 根因（2026-09-15 受控实验证实）：Bash 工具以「上一次调用的工作目录」作为 spawn 的 cwd，该目录被删除后（git worktree remove、rm -rf、依赖重装等）所有后续命令报 `spawn /bin/zsh ENOENT`；报错指向 shell 二进制而非缺失目录，极具误导性，不要往 shell、权限、系统环境方向排查。
- 预防：cd 进某个目录工作结束后（尤其 remove worktree、rm -rf 该目录之前），先 `cd` 回项目根再执行删除；长任务不把持久化工作目录留在临时/worktree 目录里。
- 自愈（实测有效，遇故障禁止盲目重试或等待）：用 Write 工具在缺失目录内写入任意文件（Write 会自动创建父目录）重建目录 → Bash 立即恢复 → 立即 `cd` 回项目根 → 清理临时标记文件。恢复后第一条命令用 `pwd` 确认。

## cwd 跨调用驻留：写文件前先确认目录

- shell 的 cwd 在多次工具调用间保留（实战）：曾出现"以为在 worktree、实际改了主检出"导致发布产物缺字段。一切会产生文件改动的操作（内联脚本、`sed -i`、代码生成等）必须先 `cd` 进目标目录或写绝对路径；提交前用 `pwd` + `git status` 确认位置。

## bash 改过的文件会让 edit 工具版本守卫失效

- **bash（`sed -i` / python / 重定向）改过的文件会让 edit 工具「读后才可改」的版本失效**：紧接着 edit 同一路径会报 `file has not been read`（该路径从未 read 过）或 `file changed since it was read`（read 过但被 bash 改过）；这不是权限或沙盒问题，重新 read 一次该路径即可继续（2026-10-16 实测，同一会话反复出现）。穿插 bash 改动与 edit 时按「bash 改 → read → edit」排序。

## 长文件 read→write 会静默截断

- read 按行分页、超长静默截断（实战踩坑）：超长文件禁止 read→write 整文件往返，写回会静默丢尾（曾一次删掉 500+ 行）。改大文件用字节级精确操作（`sed -i` 按行寻址、python 按行替换），改完用 `git diff --numstat`（增删应对称）+ `wc -l` 对 HEAD 验行数一致；一旦失衡立即 `git checkout` 恢复重做，不要在坏文件上继续改。
  - **这条同样约束 python 脚本里的 `read_text()` → `replace()` → `write_text()`**：那不是"按行替换"而是整文件往返，照样截断（2026-10-19 实测：一个 585 行的文件写回后 `git diff` 报 106 增 / **585 删**，而改动本身只有 12 行；同一次脚本里改的另一个文件甚至没落盘）。**首选做法：长文件一律用 edit 工具（自带版本守卫）逐处改**；必须用脚本时只在**短文件**上用，且写盘后立刻 `git diff --numstat` 自检，失衡就 `git checkout -- <file>` 重来。
  - 判别信号：意图只有几行改动，`git diff --stat` 却出现几十/几百行删除 —— 立即停下核对，别在该文件上继续叠加改动。

## macOS 自带 bash 3.2 的多字节变量名解析坑

- 脚本里「$VAR」后紧跟多字节字符（如中文省略号 …、中文标点）时，bash 3.2 会把该字符首字节并入变量名解析，报「VAR<0xe2>: unbound variable」并中断脚本；同脚本在 bash 4+/zsh 下正常，极具迷惑性（2026-10-07 deploy.sh 实测）。
- 修复/预防：变量后接非 ASCII 字符时一律加花括号「${VAR}…」显式定界；写脚本时变量后直接跟 CJK 字符的写法直接避免。
- 后续在 agent-browser wrapper 上复测再次命中，全角句号「。」同样触发；花括号定界修复有效。

## 模板串里生成 shell 的规范（TS/JS × bash）

在编程语言模板字符串里写 bash 是高频事故源，写之前过此清单（2026-10-15 会话多次实证）：

1. **bash 的「美元符+花括号」序列一律转义后写入**——含参数展开、默认值等一切形式，否则被模板引擎当插值解析，报 Unexpected token（实测：一处参数展开未转义致整个程序解析失败，连带审批等待超时烧掉 12 分钟）。写完目测一遍有无裸序列；**更稳的做法：复杂 bash 片段独立落盘为脚本文件再执行，或在 TS 中改用单引号字符串数组（反引号与美元花括号均无需转义），heredoc 尽量避免**。
2. **模板串内嵌 markdown 行内代码的反引号会提前终止字符串**——报 missing required property 或 Expression expected（本次各 1 次）。要么全部转义，要么改用单引号字符串。
3. **edit 的 old_string 从 read 输出原样复制**，禁止凭记忆重打——全角/半角标点（半角逗号 vs 全角逗号、半角冒号 vs 全角冒号）差异必致匹配失败（本次 2 次）。
4. **bash 片段改完立即 bash -n 语法检查再投入使用**；重要脚本过 shellcheck（本机 0.11.0，`shellcheck -S style <file>`，本次 wrapper 修复后最严格级别零警告）。

## macOS/BSD 工具链与解析规范

1. `cat -A` 不存在（GNU 专属）→ 用 `cat -ev`；GNU 专属选项先验证再用。
2. grep 模式以 `-` 开头必须 `grep -e` 加模式（或 `--` 分隔）——本次 `->` 前缀报 invalid option，端口自愈链因此失效一轮。
3. grep 多 pattern 用多个 `-e`，不用 BRE 的「\|」——中文行内容时「\|」会整段漏匹配，导致误判「文件未修改」（本次误报一次）。
4. **统计进程/对象禁止按命令行关键词 grep 计数**：daemon 进程名统一（如 agent-browser-darwin），按 session 名 grep 恒为数 0（实际 2 个，本次误判「无残留」）；按「Google Chrome」计数把用户日常浏览器混进来（误报双实例）。用 `lsof -p <pid>` 看 fd/sock 归属，或 `pgrep -f 完整特征串`。
5. **清理类操作禁止盲删「非当前/非自己的」对象**（曾按「除第一个外全关」清理 tab——若那些不是死残留而是活跃会话的 tab，就是事故重演）。先甄别归属，只删确属自己或确认已死的。
6. 管道后 `$?` 是末命令的退出码；要真实退出码先落盘（`cmd > log` 后 `echo $?`）或用 PIPESTATUS。
7. **消费第三方 CLI 的参数分隔/解析规则先实测再依赖**：README 写「comma or newline separated」，agent-browser 0.38.2 换行实测不生效、逗号硬拆——含逗号的值（如 Chrome `--window-position=x,y`）经此通道必然损坏，残尾数字被 Chrome 当整数 IP URL（即「0.0.3.32 tab」事件，0.0.3.32 = 整数 800）。产品侧细节见 `browser-automation-safety` skill。

## 检索审计：显式补查 gitignored 目录

内容检索工具（grep/rg 系）默认遵守 `.gitignore`：`.worktrees/`、`.workwork/`、`node_modules/` 会被静默跳过（2026-10-27 实测）。

- 做「全库有没有用 X」类审计时，**主检索之外必须按目录显式补查这两类路径**（如 `grep -rl 关键字 <项目>/.worktrees <项目>/.workwork`），并核对结果总数是否触达工具的返回上限。
- 实测一次审计因此漏掉 30 个引用文件（含整个 worktree 的脚本副本），导致「某模式只有 A 项目在用」的结论险些失真；依赖类冲突（playwright/puppeteer）还要查 lockfile，不能只 grep 源码。
