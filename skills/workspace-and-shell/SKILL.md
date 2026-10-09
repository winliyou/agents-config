---
name: workspace-and-shell
description: AI 中间文件落盘位置（.workwork/ 按工作树隔离）与 shell 工作目录已知坑。触发：需要写计划/笔记/截图/调研草稿/临时产物，或决定中间文件该放哪、可否写进 docs/；命令莫名失败且报错指向 shell 二进制（spawn ENOENT、spawn /bin/zsh ENOENT）或 cwd 被删后全部命令失效；怀疑文件改错位置、误改主检出而非 worktree；怀疑长文件读写被静默截断丢内容。
---

# 工作目录与 Shell 陷阱（Workspace & Shell）

写中间产物、或不理解某个"报错指向 shell"的诡异失败时加载。

- AI 工作期间产生的所有中间文件一律写入项目根 `.workwork/`（需确保已加入项目 .gitignore），包括但不限于：计划文件、进度文件、任务清单、截图、设计文档草稿（SDD）、调研笔记、方案对比记录、会话记录、临时导出产物等。
- `.workwork/` 按工作树严格隔离，不在不同 worktree 之间共享：中间文件一律写入**当前所在工作树根**下的 `.workwork/`；在 worktree 内工作时禁止读写主工作树的 `.workwork/`，反之亦然，避免并行线互相干扰。worktree 的 `.workwork/` 属该分支临时产物，随 worktree 一并删除（见「合并流程」，默认可丢弃）。
- **禁止把 `docs/`、`doc/`、`documentation/` 等目录当作 AI 实现过程的文件目录**（计划、进度、任务清单、调研笔记等一律不得写入）；`docs/` 只存放项目的真实文档（用户文档、API 文档、架构文档等需提交的内容）。
- 发现 AI 中间文件被误写入 `docs/` 或项目其他位置时，将其迁移到 `.workwork/` 对应位置，并视情况清理 `git status` 中多余的变更。
- `.workwork/` 禁止存放任何需要提交的代码或配置。
- 例外：项目确需把 `.workwork/` 兼作运行时数据目录时（如 fuck_etf），须在项目 AGENTS.md 显式声明；默认仍仅放 AI 中间文件。
- skill 发现范围：只认各仓库 `.agents/skills/` 与用户级 `~/.agents/skills/`。`.workwork/` 下的依赖缓存（go-mod、bun caches 等自带 skill）不在发现范围——靠 `.gitignore` 隔离、永不提交；`.claude/skills` 双轨目录不另起一套，一律搬入 `.agents/skills/`。
- 各 AI 工具（opencode/claude/superpowers/zcode 等）的默认输出目录应配置指向 `.workwork/`；工具的固定路径配置不解除按工作树隔离的义务——在 worktree 内工作时输出仍写入该 worktree 的 `.workwork/`。

- 根因（2026-09-15 受控实验证实）：Bash 工具以「上一次调用的工作目录」作为 spawn 的 cwd，该目录被删除后（git worktree remove、rm -rf、依赖重装等）所有后续命令报 `spawn /bin/zsh ENOENT`；报错指向 shell 二进制而非缺失目录，极具误导性，不要往 shell、权限、系统环境方向排查。
- 预防：cd 进某个目录工作结束后（尤其 remove worktree、rm -rf 该目录之前），先 `cd` 回项目根再执行删除；长任务不把持久化工作目录留在临时/worktree 目录里。
- 自愈（实测有效，遇故障禁止盲目重试或等待）：用 Write 工具在缺失目录内写入任意文件（Write 会自动创建父目录）重建目录 → Bash 立即恢复 → 立即 `cd` 回项目根 → 清理临时标记文件。恢复后第一条命令用 `pwd` 确认。

- cwd 跨调用驻留，写文件前先确认目录（源自 dsh-plugins 实战）：shell 的 cwd 在多次工具调用间保留，曾出现“以为在 worktree、实际改了主检出”导致发布产物缺字段。一切会产生文件改动的操作（内联脚本、`sed -i`、代码生成等）必须先 `cd` 进目标目录或写绝对路径；提交前用 `pwd` + `git status` 确认位置。
- read 按行分页、超长静默截断（源自 hotspot 实战）：超长文件禁止 read→write 整文件往返，写回会静默丢尾（曾一次删掉 500+ 行）。改大文件用字节级精确操作（`sed -i` 按行寻址、python 按行替换），改完用 `git diff --numstat`（增删应对称）+ `wc -l` 对 HEAD 验行数一致；一旦失衡立即 `git checkout` 恢复重做，不要在坏文件上继续改。
- macOS 自带 bash 3.2 的多字节变量名解析坑（2026-10-07 travel deploy.sh 实测）：脚本里「$VAR」后紧跟多字节字符（如中文省略号 …、中文标点）时，bash 3.2 会把该字符首字节并入变量名解析，报「VAR<0xe2>: unbound variable」并中断脚本；同脚本在 bash 4+/zsh 下正常，极具迷惑性。修复/预防：变量后接非 ASCII 字符时一律加花括号「${VAR}…」显式定界；写脚本时变量后直接跟 CJK 字符的写法直接避免。
