---
name: git-workflow
description: Git 工作流细则：worktree 创建、合并流程与清理、commit 格式与模型署名、版本号 tag 规范、打/推 tag 纪律。触发：需要修改/新增/删除项目文件并提交；创建或删除 worktree；合并分支；执行 git commit / merge / rebase / push；整理提交历史；定版本号、打发版 tag、一次发布多个 tag、tag 没触发 CI、删错 tag。
---

# Git 工作流（Git Workflow）

任何会产生提交的改动都要加载。红线（主干保护、开发分支不推远程）同时保留在 AGENTS.md，本 skill 提供完整流程与命令。**双主源纪律：改任何一条红线必须两处同改**（`~/AGENTS.md` 与本 skill），只改一处即漂移。

- 禁止改写 main/master 历史（限主工作树/main 分支）：reset --hard、push --force、rebase；分支内整理历史（rebase/reset）一律在 Worktree 中进行，见下。
- 合并统一使用 `git merge --ff-only`，禁止 Merge Commit。
- **仅当需要更改项目文件（修改/新增/删除代码、配置、文档等会产生提交的操作；单文件、typo、简单 bugfix 等无例外）时才新建 Worktree**：开发分支必须通过 `git worktree add` 独占目录创建，严禁在主工作树上修改/提交代码或 `git checkout -b` / `git switch -c` 切分支。
- 只读类操作（代码梳理、架构调研、阅读/检索代码、运行不产生文件改动的命令等）不需要新建 Worktree，直接在主工作树进行。
- 主工作树允许的操作：`git fetch`、`git pull --ff-only`、`git merge --ff-only`、`git push`（推送合并后的 main）、发版 tag（`git tag` 打在合并后的 main 上再推送）、`git worktree add|list|remove`、`git branch -d`（清理已合并分支）以及只读命令（`status`/`log`/`diff`/`show`/`describe`…）。
- 主工作树禁止的 git 写操作：`commit`、`checkout`、`switch`、`reset`、`rebase`、`cherry-pick`、`stash`、非 `--ff-only` 的 `merge`、新建/改名/非 `-d` 删除的 `branch`、推送非主干分支（见下条）。
- **开发分支（feature/fix/refactor 等）一律禁止推送到远程**：分支只在本地 Worktree 生命周期内存在，合并进主分支后即删除。任何情况下不执行 `git push origin <开发分支>`（含 `-u` / `--set-upstream`）；`git push` 仅允许推送合并后的主分支（dsh-plugins 额外允许 `alpha` 版本分支）与发版 tag。远程仓库只应存在主干分支与 CI 自动创建的分支（dependabot 等）；发现远程出现开发分支即为违规，须先合并或确认丢弃，再删除远程分支。
- 主工作树存在未提交改动且挡住合并时：若改动内容已逐字节确认完整存档进待合并分支，允许清理这些文件（`git restore <paths>`）；否则先与用户确认处置方式，不得擅自丢弃。
- 每条并行线一个 Worktree，互不干扰；Worktree 内可自由 rebase/reset/amend 整理历史。
- Worktree 位置：项目根 `.worktrees/<分支名>`（已 gitignore），避免污染主仓库 git status；基线除非用户指定，一律基于本地主分支创建（`git worktree add -b <分支名> .worktrees/<分支名> main`），创建前确认主分支已同步到最新。

### 合并流程（合并后清理）

1. Worktree 中 `git rebase main`，必要时 `git reset --soft main && git commit` 整理为单个提交。
2. 按「完成前验证」过完全部检查（format、lint、test、build）。
3. 主分支 `git merge --ff-only <分支>` 合并完成后，**自动删除该 Worktree 与已合并分支**，无需询问用户：
   - 若该 worktree 启动过 compose 环境，先清理其 compose 资源；
   - `git worktree remove .worktrees/<分支名>`，再 `git branch -d <分支名>`（必须先 remove 再 -d，分支被 worktree 占用时无法删除；可先 `git branch --merged main` 做防御性确认）；
   - 若 `worktree remove` 因存在未跟踪文件失败，先检查是否为需要保留的产物（`.workwork/` 中间产物默认可丢弃），再决定是否 `--force`。
4. 推送在主工作树进行：`git push`（推送合并后的 main）；发版 tag 打在合并后的 main 上再推送。Worktree 内的 commit 不直接 push，开发分支也不推远程建立跟踪——只有合并进主分支的更改才推送。

### Commit 格式

- 格式：`<分类>(<范围>): <中文描述>`；分类：新增 / 修复 / 重构 / 文档 / 测试 / 样式 / 性能 / 构建 / 持续集成；范围可选（中文，如"战斗"、"认证"）。项目有既定惯例（如 dsh-plugins 的 `新增:` 冒号式）时，以项目 AGENTS.md 声明为准。
- 提交末尾标注实际使用的 AI 模型名：从当前会话 system prompt 末尾获取真正背后运行的模型名，而非笼统的助手名；禁止凭记忆填写过往会话的模型名，每次 commit 前重新确认。

```
Model: <模型名>
```

- **多行/含引号的提交消息一律用 `-F <文件>`，不要内联 `-m`（2026-09-25 实测）**：消息里出现 ASCII 双引号时，外层 shell 的双引号包裹会在第一个 `"` 处截断，`git commit` 静默失败或把消息剩余部分当独立命令执行——stdout 还常常是空的，极易误以为成功。安全做法：把消息写入临时文件（如 `.workwork/commit-msg.txt`）后 `git commit -F <文件>`；提交后必须 `git log --oneline` + `git show --stat` 复核提交数与文件归属，不能只看命令退出与否。
### 版本号以 tag 为源（发版项目，源自 media_app 实战）

- 版本号只由 git tag（`vX.Y.Z`）决定：构建期用 `git describe` 读取派生，禁止手改版本文件；打完 tag 即“自动更新版本”，无需改任何文件。
- 标准四步（代码改完、发版前执行）：
  1. 在 Worktree 内提交代码变更（确保要发布的 commit 已就绪）。
  2. 按变更类型决定下一 SemVer：破坏性改动升 major、新功能升 minor、bug 修复升 patch。
  3. 合并进主分支后，在主工作树于当前 commit 打 tag 并推送（**先推分支、再单独推 tag**，命令见下节「打 tag 与推送纪律」；tag 必须在要发布的 commit 上，且落在 `origin/main` 上）。
  4. 随后构建即得到干净版本号（`git describe` 在 tag 上无 `-dev` 后缀）。
- tag 后有新 commit 的构建必须带 `-dev.N` 后缀标识未发布构建；无 tag 时 fallback 默认版本，不阻断构建。

### 打 tag 与推送纪律（任何仓库通用，CI 由 tag 触发时尤其关键）

**一个 tag 一条推送命令，推完确认再推下一个。** GitHub 的两条平台级限制会让
批量/连推 tag **静默失败**——`git push` 不报任何错，只是事件没产生或流水被取消，
事后才发现「发了版但 CI 没跑 / Release 没出现」。以下与具体仓库无关，只用 tag
驱动发版的仓库一律适用：

1. **单次推送超过 3 个 tag，GitHub 不为其中任何一个产生 `push` 事件**，CI 完全
   不触发。官方文档（Events that trigger workflows，`push` 一节）原文：
   「Events will not be created for tags when more than three tags are pushed at
   once.」上限是**推送批次**的粒度——推 4 个是**全部**不触发，不是「前 3 个能过」。
   `delete` 事件同样限 3 个一批，所以**删 tag 也要一个一个删**。
2. **逐个推还不够：连推不等会取消流水。** 若 workflow 用了仓库级并发组
   （`concurrency: group: <x>`），GitHub 同一时刻只允许 **1 个 running + 1 个
   pending**，且默认 `queue: single`——**新排队的 run 会取消当前 pending 的 run**。
   于是快速连推时中间 tag 的流水被顶成 `cancelled`，对应发布永远不执行。逐个推
   不增加总耗时：并发组本来就把这些 run 串行化了，一起推也只是排队、还可能互相顶掉。

多包/多 tag 同发的固定顺序：**先推分支**（`git push`，让 tag 落在远程已存在的
提交上）→ **再逐个 tag 推送并逐条确认**：

```bash
git tag -a <tag> -m "<说明>"        # annotated（发布 tag 必须，轻量 tag 不可审计）
git show <tag> --stat              # 核对 tag 指向的提交
git push                           # 先推分支

for t in <tag1> <tag2>; do
  git push origin "$t" || break
  # 确认该 tag 触发了流水（`--branch` 接受 tag 名）；输出为空 = 没触发，停止排查
  RUN=$(gh run list --workflow=<wf>.yml --branch "$t" --limit 1 \
    --json databaseId,event --jq 'map(select(.event=="push")) | .[0].databaseId // empty')
  [ -n "$RUN" ] || { echo "$t 未触发 CI，停止后续推送"; break; }
  gh run watch "$RUN" --exit-status || break     # 确认成功再推下一个
done
```

- **禁止 `git push --tags`**（会把本地所有 tag 一次性推出，必然超限），也禁止
  `git push origin <tag1> <tag2> <tag3> <tag4>` 这类批量推送。
- **分支推送永远用 plain `git push`，不用 `--follow-tags`**：该选项会把 annotated
  tag 顺带推出，让「显式打 tag」形同虚设，也绕过本节纪律。
- **已推过的 tag 重复 `git push origin <tag>` 是安全空操作**（输出
  `Everything up-to-date`，退出码 0）——但也**不会补触发当初漏掉的 CI**；漏了只能
  删 tag 重推（见下）。
- 环境没有 `gh` 或无 CI 时，可改用 `git ls-remote --tags origin <tag>` 确认 ref 已
  推送；但「事件是否产生」只有平台侧（Actions 运行记录）能证明，故 tag 驱动发布
  时优先用 `gh` 验证。

**推错了/漏触发了怎么办**：

- **还没推**：`git tag -d <tag>` 删本地重打。
- **已推、但 CI 侧没有对应运行或没有 Release**（刚推就发现，含批量超限漏发、
  流水被并发组顶掉）：删本地再删远程后重推——
  `git tag -d <tag> && git push origin :refs/tags/<tag>`，然后重打重推。
  删远程 tag 前先确认没有同名 Release。远程 tag 同样要**一个一个删**。
- **Release/发布已建**：**永不删、不移动该 tag**，升版本号打新 tag 覆盖叙事。
- 版本号用过即作废：即使删了 tag 重打，也只允许 tag 内容逐字节一致的**原样重打**，
  不得借机改内容或复用版本号发别的东西。

**推送后必须确认 CI 实际结果（2026-09-25 实测教训）**：

- `git push` 成功 ≠ CI 通过。tag/分支推送后用 `gh run list --limit 3` 核对结论；
  需要失败日志时 `XDG_CACHE_HOME=<workspace>/.workwork/cache gh run view <id> --log-failed`
  （gh 的日志缓存默认写 `~/.cache/gh`，沙盒内不可写会直接报错）。
- CI 长期红会被「上次也是红的」麻痹成常态：AnyDLNA 的 Linux CI 因
  `TestBundledToolDirFrom` 缺平台门控自 2026-09-20 起连挂 5 次（含纯文档提交）才被发现。
  看到连续失败必须先修再发，不许带红 tag 发布。
- 同一 commit 双 run（tag 触发 + 分支触发）一绿一红，优先怀疑时间敏感用例 flaky：
  `gh run rerun <id>` 重跑确认；确认 flaky 后应修测试的时间阈值，而不是反复重跑。
