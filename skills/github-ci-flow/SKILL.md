---
name: github-ci-flow
description: GitHub Actions 门禁优先的开发流程：开发分支推送到 GitHub → 开 PR（正文必带证据：截图/日志/UI 改动前后对比图/排查记录）→ gh 检测 CI 状态 → 全绿后 rebase 合并 → 清理分支与 worktree。触发：需要提交改动并验证、决定本地跑哪些检查、把编译/测试等重活移到 GitHub、创建/合并 PR、写 PR/MR 描述与证据（截图、日志、走查记录）、UI/交互改动要出 Before/After 对比图、PR 正文要写设计意图与方案取舍、等待或排查 Actions 结果、推送开发分支与清理远程分支、CI 红灯诊断。
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

# 4) 写正文 → 证据门禁 → 开 PR（draft 同样触发 pull_request CI）
#    正文先按四段式写到 .workwork/pr-body-<任务>.md（UI 改动含 Before/After）
~/.agents/bin/pr-evidence-check --body .workwork/pr-body-<任务>.md   # 非 0 退出不许建 PR
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
3. **证据**：截图 / 录屏 / 日志 / 接口返回，尽量给前后对比；**UI 与交互类改动必须给 Before / After**（判定口径与采集见下节「UI / 交互类改动」）：
   - **日志类**直接 fenced 贴正文（含失败码、request id、关键字段），长日志截取相关片段；
   - **截图用 `gh` 的 `--attach` 上传，不提交进仓库**：先压缩（`sips --resampleWidth 540` 或
     `~/.agents/bin/pr-evidence` 的 `shrink`，单张 ≤300KB），正文照常写 `![改前](./before.png)`，建 PR 时把本地文件一并 attach：
     `gh pr create --body-file <正文> --attach 'before.png#改前' --attach 'after.png#改后'`。
     gh 按文件名把正文里的本地路径替换成附件地址（`https://github.com/user-attachments/assets/<uuid>`），
     合并、删分支都不影响这条地址；
   - **`--attach` 必须与正文写入在同一条命令里**：上传不可撤销，且附件未被 PR 引用时匿名访问是 404——
     命令失败就等于留下永久死链；一次最多 50 个文件，图片上限 10MB、视频 100MB，需要仓库 WRITE 权限；
   - 追加到已有 PR：`gh pr comment <PR> --body "…" --attach "…"`（`gh pr edit <PR> --attach "…"` 同理）；
     **gist 不接受二进制**（`binary file not supported`），不要用 gist 托管图片；
   - 纯文档/注释改动可省略截图，但「背景/问题」与「验证」两段不可省。
4. **验证**：CI 结论（job 数、是否全绿、run 链接）+ 本地构建/单测/静态检查结论 + 端上/浏览器走查要点；
   写明未覆盖项与已知风险。

```markdown
## 背景 / 问题
<现象 → 根因；关键日志/命令输出>

## 改动
- <模块>：<做了什么>（<关键文件>）

## 证据
<截图/录屏/日志；UI 改动给 Before/After 并排表；设计稿或接口契约对照>

## 验证
| 项 | 结果 |
|---|---|
| CI | <n/n 全绿，run 链接> |
| 本地 | <构建/单测/静态检查> |
| 走查/实测 | <要点> |
```

- 项目可在自身 AGENTS.md 追加更严格细则（截图目录、压缩命令、必须贴的 job）；**全局条款是底线**，不因项目未写而省略。
- 敏感信息不入库；日志中的 secret 一律打码。GitHub/GitLab 均适用（MR 同理），正文四段一致。

### UI / 交互类改动：Before / After 对比（必带）

命中任一即算 UI 改动：页面/组件视觉与布局、设计 token 与主题（深浅色）、交互流程与反馈（hover/focus/拖拽/展开/弹层）、动画与过渡、加载与空/错误态、响应式断点、无障碍（热区、对比度、读屏文案）、移动端与 TV 端形态。**纯新功能没有旧界面**时给「改前入口位置 + 改后新界面 + 设计稿」，并在正文写明「无 Before」。

采集纪律：

1. **动手改之前先截基线**：改前在 worktree 里跑当前版本截一组 `before-*.png`，改完用同一环境截 `after-*.png`。基线丢了就 `git worktree add .agents/worktrees/before-<slug> <base-commit>` 检出旧版本补截，不要用旧截图或「记忆中的样子」凑数。
2. **同条件才叫对比**：同视口尺寸与缩放（桌面 1440×900、移动端 390×844 一类，项目有既有口径从项目）、同主题、同数据、同状态。尺寸或主题不一致的两张图等于没对比。
3. **多状态矩阵**：交互类至少覆盖「默认 + 关键交互态 + 异常态」；动画/过渡给 3–5 张关键帧序列，或录屏。
4. **取图**：Web 走 `agent-browser`（命令面以 `agent-browser skills get core --full` 为准，headless 约定见 `browser-automation-safety`）；Android `adb -s <serial> exec-out screencap -p > shot.png`；鸿蒙 `hdc shell snapshot_display`；桌面端 `screencapture -x -o <file>`。
5. **压缩**：`sips --resampleWidth 540 <in> --out <out>`（macOS 自带，实测 1024×1024、296KB 的 PNG 压到 540 宽后约 107KB），单张 ≤300KB。
6. **拼图/录屏**：先 `command -v magick ffmpeg` 确认；不可用时不要为此装工具——直接用正文两列表格并排（GitHub 会渲染成左右对比），动画给关键帧序列。

正文并排写法（比拼成一张图更清晰，还自带状态标注）：

```markdown
## 证据
桌面 1440×900 / 浅色主题 / 同一组数据

| 状态 | Before（`main`） | After（本 PR） |
|---|---|---|
| 默认态 | ![before](<附件地址>) | ![after](<附件地址>) |
| 展开 + hover | ![before](<附件地址>) | ![after](<附件地址>) |
| 空态 | ![before](<附件地址>) | ![after](<附件地址>) |

设计稿：<链接 / 节点号>；实现与稿子的差异：<逐条列出并说明是否有意为之>
```

- 只有「改后」、用设计稿冒充「改后实拍」（纯设计稿 PR 除外）、两张图尺寸不一致，都按证据不足处理，PR 不算完成。
- **证据图不进仓库**：截图只存在本地临时目录（`.workwork/evidence/`，随任务清理）与 GitHub 附件存储，
  不写进 `.github/pr-evidence/` 之类路径，也不为采集截图单独提交。仓库里出现一次性截图按错误处理、应当删除。
- **正文与附件一一对应**：正文引用几张就 `--attach` 几张，文件名保持可辨识（`before-*.png` / `after-*.png`）；
  同一张图在正文重复引用会复用同一个附件地址。
- **取图有优先级，够用即止**：本地能跑 → 设备/模拟器 → 线上已部署版本 → 已有设计稿；哪条成本低走哪条，拿到一张能说明前后差异就停，不追求多角度、多尺寸的完美组图。
- **拿不到就别硬耗**：一条路试一次（最多 5 分钟）不通就停，别反复折腾模拟器、镜像、驱动或网络。直接在正文写「无 Before：<具体原因>」（无设备/无模拟器/环境起不来/改动不可视），并用替代证据补位——单测用例名与断言、logcat/dump 片段、设计稿对照。
- **理由要具体，不许糊弄**：「纯 Compose 实现，无第三方依赖」「已本地验证」这类与证据无关的话按证据不足处理；写的必须是可复核的事实（设备未连接、模拟器启动失败的原样报错等）。

一步到位的最小取证片段（截图 → 压缩 → 建 PR 时 attach）：

```bash
mkdir -p .workwork/evidence
adb -s <serial> exec-out screencap -p > .workwork/evidence/before-settings.png
sips --resampleWidth 540 .workwork/evidence/before-settings.png --out .workwork/evidence/before-settings.png

# 正文里照常写本地路径：![改前](.workwork/evidence/before-settings.png)
gh pr create --draft --title "…" --body-file .workwork/pr-body-<任务>.md \
  --attach '.workwork/evidence/before-settings.png#改前：设置页' \
  --attach '.workwork/evidence/after-settings.png#改后：设置页'
```

正文里的相对路径按 `--body-file` 所在目录解析，找不到再回退到当前工作目录。

### 把 PR 写成创造过程档案

PR 是日后回看「当时为什么这么做」的唯一入口，正文要比 diff 和代码注释更完整，至少覆盖：

- **设计意图**：这块界面/交互要解决什么、给谁用、怎样算成功；
- **方案取舍**：2–3 个候选（含被否掉的），各自代价与最终选择理由；
- **迭代轨迹**：初版 → 调整 → 定稿各阶段的关键变化与触发原因（评审意见、走查发现、性能或一致性约束）；
- **坑**：误导性表象 → 真正根因 → 验证过的解法（贴原始报错，不写「已修复」了事）；
- **走查清单**：测了哪些尺寸/机型/主题/状态，哪些没测及原因；
- **遗留与后续**：已知问题、下个 PR 要接的事。

边界：过程记录写进 PR 正文与 commit message，**不往仓库文档/注释里堆方案对比笔记**（见 AGENTS.md「方案选择」）。

## 证据图门禁：`pr-evidence`

`~/.agents/bin/pr-evidence`（Node 实现，源码同名 `.mjs`）把「有没有图、图能不能打开」变成退出码，是 UI 类改动开 PR 前后的硬门禁：

```bash
~/.agents/bin/pr-evidence shrink <截图...>                         # 压缩到 .workwork/evidence/
~/.agents/bin/pr-evidence-check --body .workwork/pr-body-<任务>.md  # 建 PR 前：查正文引用与本地文件
gh pr view <PR> --json body --jq .body > /tmp/body.md
~/.agents/bin/pr-evidence-check --body /tmp/body.md --post         # 建 PR 后：查真实附件地址
```

| 退出码 | 含义 | 处置 |
|---|---|---|
| 0 | 通过（无 UI 改动 / 有可用图 / 已声明免图） | 继续 |
| 1 | UI 改动但正文没有任何图 | `shrink` 压缩后补正文，或声明免图 |
| 2 | 图不可用（本地文件缺失 / 远程非 200） | 按提示修：补文件、或确认建 PR 时带了 `--attach` |
| 64 | 用法错误（缺 `--body`、目录不对） | 修命令 |

- **UI 判定**：改动文件命中 `(^|/)(ui|res/layout|res/values|res/drawable|components|pages|views|screens|theme|styles)/` 或 `*.svelte|vue|tsx|jsx|css|scss|less|html|storyboard|xib|qml`，且不落在 `test/`、`build/`、`.github/pr-evidence/`、`*.md|json|yml` 等跳过路径。命中即要求证据图。
- **免图声明**：正文写 `pr-evidence: n/a <至少 6 个字的原因>`（例如「仅调整日志文案，无可见界面变化」），工具认这一行放行；空话或过短的理由不算。
- **基线**：默认 `origin/main` 的 merge-base（`origin/master` 同理）；没有远程时退化到 `HEAD~1`，再退到根提交，避免首次提交就报错。
- **复核方式**：`pr-evidence-check` 的 stdout 与退出码就是证据，收进 PR 的「验证」段时贴这两行即可。建 PR 前的 `check` 只看本地文件是否就位，**建完 PR 必须用 `--post` 复核一次**——它带 token 校验附件地址，才能证明正文里真的是可访问的图而不是 404 死链。
- **附件校验要带 token**：`user-attachments` 地址在附件未被公开 PR 引用前匿名访问是 404，匿名探测会误判成破图；工具已自动对 `github.com` 域附加 `gh auth token`。
- **门禁范围**：只覆盖「dsh 在本地建 PR」这条路径——执行者调 `pr-evidence-check`，退出码非 0 不建 PR。网页端、其他 agent、其他工具建的 PR 不在此范围，**不要为此往仓库塞读 `pull_request.body` 的 workflow**（维护成本高于收益）；已合并的历史 PR 也不回填。

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
gh run view <run-id>                    # 汇总：哪个 job 失败（必须指定 run-id，严禁裸跑）
gh run view <run-id> --log-failed       # 失败步骤日志（最常用；必须指定 run-id）
gh run rerun <run-id>                   # 怀疑 flaky 时重跑同一 run
```

- **严禁执行不带 `<run-id>` 的 `gh run view`（红线）**：不给 run ID 时 `gh` 在存在多条 run 时会弹出交互式选择菜单（`? Select a workflow run [Use arrows to move, type to filter]`）；在脚本或 agent 后台命令等非交互式环境下，因缺乏终端键盘输入会导致进程永远卡死 hang 住直到超时。排查失败必须先用 `gh run list --branch <branch> --json databaseId` 查明具体 ID，再带 ID 执行。
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
- **裸跑 `gh run view` 会交互式卡死**：不带 run ID 时 gh 会触发终端方向键交互选择（`? Select a workflow run`），在非交互式后台中无限 hang 住，必须通过 `gh run list --json databaseId` 获取明确 ID 后再查看。
