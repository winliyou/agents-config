---
name: github-ci-flow
description: GitHub Actions 门禁优先的开发流程：开发分支推送到 GitHub → 开 PR → gh 检测 CI 状态 → 全绿后 rebase 合并 → 清理分支与 worktree。触发：需要提交改动并验证、决定本地跑哪些检查、把编译/测试等重活移到 GitHub、创建/合并 PR、等待或排查 Actions 结果、推送开发分支与清理远程分支、CI 红灯诊断。
---

# GitHub CI 门禁流程（GitHub CI Flow）

把编译、全量测试、打包、E2E、镜像构建等**重活交给 GitHub Actions**，本机只跑秒级静态检查；
改动一律以 PR 形式合并，CI 全绿才准入。目的：不让本地构建测试拖慢日常使用电脑。

与 `git-workflow` skill 配合使用：worktree/commit/tag 规范仍在那边，本 skill 管「推送 → PR → CI → 合并」这一段。

## 前置检查（首次使用或异常时）

```bash
gh auth status                    # 需已登录；Git 操作协议 ssh 时确认 `ssh -T git@github.com` 通过
gh repo view --json visibility    # 或 gh api repos/{owner}/{repo} --jq .visibility
```

- 仓库为 public 时 Actions 免费不限量；private 仓库遇到 Billing 注解失败按 `git-workflow` 的处置办（转 public，不做本地构建替代）。
- 现有 CI 的 `on:` 必须包含 `pull_request`。没有就补，否则 PR 不会产生检查。

## 标准流程（每个改动都走这条）

```bash
# 1) 在 worktree 中开发（worktree 规则见 git-workflow）
git worktree add -b <type>/<slug> .agents/worktrees/<type>/<slug> main
#    确认 .agents/worktrees/ 已被忽略（插件会放一个内容为 * 的 .gitignore）：
git check-ignore -v .agents/worktrees/probe

# 2) 本地只跑秒级检查（见下节「本地 vs CI 分工」），提交
git add -A && git commit -F .workwork/commit-msg-<任务>.txt

# 3) 推分支（允许且必须作为 PR head；不再「开发分支禁止推远程」）
git push -u origin <type>/<slug>

# 4) 立即开 PR（draft 即可，draft 同样触发 pull_request CI）
gh pr create --draft --title "<中文标题>" --body-file .workwork/pr-body-<任务>.md

# 5) 等待 CI（长等待用后台 job，不要前台干等）
gh pr checks <PR 号> --watch --interval 30

# 6) 全绿 → 转 ready → rebase 合并并删远程分支
gh pr ready <PR 号>
gh pr merge <PR 号> --rebase --delete-branch

# 7) 本地同步 + 清理 worktree（主工作树执行）
git fetch --prune && git pull --ff-only
git worktree remove .agents/worktrees/<type>/<slug>
git branch -d <type>/<slug>
```

- 提交与 PR 创建完成后立即删除 `.workwork` 里的 commit-msg 与 pr-body 临时文件；worktree 收尾时整个 `.workwork/` 随目录丢弃，主工作树写的那份自己清（规则见 `workspace-and-shell` skill 的 `.workwork` 生命周期）。
- 合并方式统一 `--rebase`：线性历史、无 Merge Commit，保留分支内提交；不用 `--merge`，也不用 `--squash`（除非用户明确要求）。
- PR 标题/正文用中文；正文按下节「PR/MR 描述：证据与排查记录」四段式写全（含 CI run 链接与截图/日志）。创建 PR 时按 `dsh-badge` skill 在正文末尾加 powered by dsh 徽章。
- **PR 未全绿不得合并**；失败先修再推，禁止 `--admin` 绕过（除非用户在会话中明确要求）。
- 一个 PR 只做一件事；基线始终是本地最新 main（先 `git fetch` + 确认 main 已同步）。

## PR/MR 描述：证据与排查记录（所有项目必带）

评审者应当**不打开代码仓库、不跑本地环境**就能核对「问题 → 改动 → 证据」。任何 PR 正文固定四段：

1. **背景 / 问题**：现象 → 根因。排查/实现过程中发现的坑、关键 `log` / 命令输出贴 fenced 代码块（贴原始输出，
   不要只写「已修复」）；涉及设计稿/接口契约的标注来源（节点号、文档链接）。
2. **改动**：按模块列点并标关键文件；不复述 diff 里已能看出的细节。
3. **证据**：截图 / 录屏 / 日志 / 接口返回，尽量给前后对比：
   - **日志类**直接 fenced 贴正文（含失败码、request id、关键字段），长日志截取相关片段；
   - **截图先用 `sips --resampleWidth 540`（或等价工具）压缩，单张 ≤300KB**，优先提交进仓库
     （建议 `.github/pr-evidence/<分支slug>/`，项目已有约定则从项目约定），正文用 raw 链接内联：
     `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`；合并后把 `<ref>` 从分支名切到默认分支
     （`main`），保证分支删除后图片仍可查看；
   - 仓库不适合入库图片时（私有仓库体积、平台限制、无法提交二进制）：把压缩图放临时目录并在正文列路径清单，
     说明「由作者在 PR 网页端拖拽上传」；或贴外部图床链接。**gist 等只支持文本的通道不能放图片**，不要尝试；
   - 纯文档/注释改动可省略截图，但「背景/问题」与「验证」两段不可省。
4. **验证**：CI 结论（job 数、是否全绿、run 链接）+ 本地构建/单测/静态检查结论 + 端上/浏览器走查要点；
   写明未覆盖项与已知风险。

```markdown
## 背景 / 问题
<现象 → 根因；关键日志/命令输出>

## 改动
- <模块>：<做了什么>（<关键文件>）

## 证据
<截图/录屏/日志；设计稿或接口契约对照>

## 验证
| 项 | 结果 |
|---|---|
| CI | <n/n 全绿，run 链接> |
| 本地 | <构建/单测/静态检查> |
| 走查/实测 | <要点> |
```

- 项目可在自身 AGENTS.md 追加更严格细则（截图目录、压缩命令、必须贴的 job）；**全局条款是底线**，不因项目未写而省略。
- 敏感信息不入库；日志中的 secret 一律打码。GitHub/GitLab 均适用（MR 同理），正文四段一致。

## 本地 vs CI 分工

| 本地（提交前，秒级） | GitHub Actions（权威门禁） |
| --- | --- |
| 格式化检查（gofmt / prettier / swift-format 等，仅改动文件） | 全量单测、`-race`、覆盖率门禁 |
| 静态检查/类型检查（go vet、tsc、svelte-check、lint） | 全部构建（含平台构建、交叉编译、打包） |
| 语法级快速编译（`go build ./...`、`cargo check` 等秒级命令） | E2E / 集成测试 / Docker 镜像构建 / 冒烟 |
| 只读自查（`git diff`、PR 描述准确性） | 依赖审计、安全扫描、多平台矩阵 |

Docker 项目：镜像构建、容器内集成/E2E、发布前镜像验证全部由 CI 在 PR 上执行（workflow 里有 `docker build` / `image-build` job 的项目以该 job 为门禁）；本地 `docker build` / `compose up` 只用于交互式调试与排障。发版 tag 的 Release workflow 负责构建并分发镜像等产物。

- 项目自有例外（真机、模拟器、鸿蒙 hvigor、音频设备、发版前本地 Docker 门禁等）以项目 AGENTS.md 为准；CI 覆盖不到的必须保留本地并在项目 AGENTS.md 写明。
- 本地命令要限定在改动文件/单包上，避免顺手跑全量；不需要在本地复现 CI 的全部步骤。

## CI 状态检测与失败排查

```bash
gh pr checks <PR>                      # 一次性快照：所有检查的名称/结论/链接
gh pr checks <PR> --watch --interval 30 # 阻塞等待，全部结束才返回（放后台 job）
gh pr checks <PR> --json name,state,link --jq '.[] | "\(.state) \(.name)"'
gh run list --limit 5 --json status,conclusion,workflowName,headBranch,databaseId
gh run view <run-id>                    # 汇总：哪个 job 失败
gh run view <run-id> --log-failed       # 失败步骤日志（最常用）
gh run rerun <run-id>                   # 怀疑 flaky 时重跑同一 run
```

- 长等待（macOS runner 排队可达十几分钟）：把 `gh pr checks --watch` 用后台 job 跑，期间继续做其他项目/其他 PR 的工作，用 `job_output` 收结果；不要用 sleep 空转。
- **同一个 PR 连续推送会取消旧 run**（CI 通常配了 concurrency）——等最新 commit 的 run 即可，旧 run cancelled 属正常。
- **久置 PR 的 checks 是历史 run，合并前必须确证它属于当前 head**：dependabot 等机器人 PR 可能创建后长期无人动，`gh pr checks` 展示的 pass 是创建当时的 run；直接据此合并前先核对 `gh api repos/{owner}/{repo}/actions/runs/<run-id> --jq .head_sha`（注意 REST 字段是 snake_case，camelCase 的 .headSha 恒为 null）与 `gh pr view --json headRefOid` 一致——一致则旧 run 对当前 head 仍有效可直接合并；不一致（主分支变化要求重跑等场景）先 `gh pr update-branch` 或推空提交触发新 run。
- **job 稳定 15m 左右失败且无日志＝runner 容量问题，不是代码问题**：判据是
  `gh run view <run-id>` 的 ANNOTATIONS 出现「The job was not acquired by Runner of
  type hosted even after multiple attempts」+「capacity constraints」（macOS arm64
  常见），check-run conclusion 为 cancelled、`gh run view --job` 报 log not found
  （job 根本没启动）。处置：间隔重跑 `gh run rerun <run-id> --failed`（可后台挂
  延迟重试），其余平台 job 的结论仍然有效；不要为它改 workflow 或镜像源。
- CI 卡在 apt/pip/npm 安装且耗时异常：先判断上游基础设施故障，不要改镜像源或构建流程（详见 `git-workflow` 的同名小节）。
- 失败日志里出现与本次改动无关的既有红灯：先确认 main 上是否同样红；main 也红说明是存量问题，单独修 CI 的 PR 处理，不要混进本 PR。

## 合并后必做

1. `git fetch --prune` 后确认远程分支已删、本地 main 已前进（`git log --oneline -1`）。
2. 删除 worktree 与本地分支（见上命令）；worktree 里的 `.workwork/` 随目录一并丢弃，主工作树的 `.workwork/` 不会——本次会话若在主树写过中间产物，按 `workspace-and-shell` skill 收尾清理。
   `gh pr merge --delete-branch` 会删除远程分支，实测还会注销 linked worktree 与本地分支；
   仍以 `git worktree list` / `git branch` 复核，残留时手动 `worktree remove` + `branch -d`。
3. 远程只应存在主干分支、项目声明的长期适配线与 CI 自动创建的分支（dependabot 等）；PR 合并后残留的远程开发分支必须删（`gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/<branch>` 或 `git push origin --delete <branch>`）。

## 已知坑

- **draft PR 不能直接 merge**：必须先 `gh pr ready`。
- **分支推送本身可能不触发 CI**：多数 workflow 的 `push.branches` 只写 main，so 必须开 PR 触发 `pull_request`；若项目 workflow 有 `paths` 过滤且改动不在过滤范围，PR 不会有检查——这种 PR 要么补触发路径，要么在正文说明「CI 不适用（纯文档改动）」并人工确认。
- **required status checks 未设置时**，全绿只是流程约定，不是平台强制；不要因为"能合并"就跳过等待。
- **rebase 合并后本地 main 不能直接 merge 分支**，用 `git pull --ff-only` 同步，旧分支已 merged，`git branch -d` 可删。
- **PR 正文里的命令/日志不要贴敏感凭据**；CI 日志中出现的 secret 一律打码。
- **组织仓库需要 admin 权限才能改保护规则**；不是 admin 时跳过平台强制，仅按流程执行。
- **发布 tag 流程不变**：发版仍按 `git-workflow` 的 tag 纪律，一个一个推；PR 流程只管日常合并。
