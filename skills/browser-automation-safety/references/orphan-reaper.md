# 会话/标签回收与孤儿 reaper（公共层兜底）

> 本文是 browser-automation-safety 的 reference：清理义务的完整命令、公共层 reaper 的实现与边界、reaper 盲区与手动收割口径。日常清理照 SKILL.md「清理义务」执行；处理孤儿或调整 reaper 时读本文。

## 一、用完必清：会话与标签回收


**清理红线**：打开的 Chrome 标签与会话只要不用就必须清理掉，不得留到任务结束。

**泄漏规模**：一轮 a11y 矩阵审计跑批（多个 worker × 多次重跑）结束不清理，`agent-browser session list` 可残留 **8 个 `<项目前缀>-audit-*` 会话**，`ps aux | grep 'Chrome for Testing'` 达 **81 个进程**，且每个会话各带多个标签。

**硬规则**：

1. **每个任务/脚本结束时必须回收自己的会话**：房客直接 `agent-browser close`；独立实例（`AGENT_BROWSER_GLOBAL_SESSION=<名>` / `--session <名>`）用 `agent-browser --session <名> close`。
2. **跑批脚本必须在 trap EXIT 中关闭自身 session**（某项目 的 `scripts/browser-a11y.sh` / `browser-touch.sh` 已实现；新脚本照此模式），否则一次矩阵 6 组合 × 多次重跑会累积成几十个 Chrome。
3. **人工任务收尾三连检查**（写进每轮工作流程）：
   ```bash
   agent-browser session list                  # 只应剩当前任务会话
   ps aux | grep '[r]emote-debugging-port=0' | grep -vc -- '--type='   # 主进程数，期望 0 或仅活跃任务数
   agent-browser tab list                       # 当前会话只留 1 个标签
   ```
4. **禁止 `close --all`**（wrapper 硬拦）；也**不得关别人的会话**，先确认该会话无 active socket/无任务（`lsof ~/.agent-browser/<名>.sock`）。
5. **同一会话顺序复用单个 tab**：`open` 的语义就是导航当前 tab；不要用 `tab new` 累积标签，除非明确需要多标签对照。

**清理命令（可直接复用）**：

```bash
for s in $(agent-browser session list | grep -o '<项目前缀>-audit-[A-Za-z0-9-]*'); do
  agent-browser --session "$s" close
done
agent-browser session list                      # 确认只剩当前 dsh-* 房客
ps aux | grep -c 'Chrome for Testing'            # 0
```

**归属判断口径**：`dsh-*` / `shared` 是 wrapper 管辖的房客与 owner，不要动；`<项目前缀>-audit-*`、`lead-*`、`manual-*` 这类临时会话按任务归属自行清理。


## 二、孤儿 daemon+Chrome 收割器（公共层兜底）


**为什么需要**：显式 `--session` 独立实例（自带 headless Chrome + 临时 profile）的宿主脚本被 SIGINT/SIGTERM/SIGKILL 打断、或 `close` 失败被 `|| true` 吞掉时，daemon 与它拉起的 Chrome 都不会自退（attach 型 daemon 豁免空闲回收）。一夜可累积多组孤儿（峰值 8 组 ≈112% CPU + 5.2GB 内存，整机 load >15）。wrapper 的 `purgeDeadSessionState` 只清「进程已死」的残留状态文件，管不到「进程活着但宿主已消失」的实例——`~/.agents/bin/ab-reap-orphans.mjs` 补这一层，wrapper 每次调用自动节流派发（1h 至多一次，stamp `~/.agent-browser/.last-orphan-reap`）。

**判据与保障**：
- **永不触碰**：`shared`（owner）、`dsh-*` / `manual-*`（房客，attach 模式不自带 Chrome）、`AB_REAP_PROTECT_SESSIONS` 额外名单（wrapper 注入调用方当前会话）、以及任何持 `profiles/main` Chrome 的会话。
- **候选**：sock 存在 + daemon 存活（pid 需核「进程命令行含 agent-browser + 是本会话 sock 持有者」双重身份，防 pid 回绕复用误杀）+ 其 Chrome 子进程用临时 profile（`agent-browser-chrome-*`）。
- **两段式**：首次发现写标记 `~/.agent-browser/.orphan-mark/<会话>`；标记满最小龄（默认 600s，`--min-age` 可覆盖）且 sock 仍无 daemon 之外的客户端才收割——活任务两次采样之间必有命令连接，不会误杀；宿主无论怎么死（含 SIGKILL）都能兜住。
- **动作顺序**：先记 Chrome 子进程 pid + user-data-dir（daemon 死后子进程过继 launchd，`pgrep -P` 将失效）→ TERM→2s→KILL daemon → Chrome 按「pid + user-data-dir 双重核对」TERM→KILL → 删状态文件与临时 profile 目录。

**手动命令**：

```bash
node ~/.agents/bin/ab-reap-orphans.mjs --dry-run    # 只评估不动手
node ~/.agents/bin/ab-reap-orphans.mjs --min-age 0  # 立即收割当前确认孤儿（先核实无活任务再用）
```

**端到端验证**：dry-run 正确列出 7 个孤儿（4 组带 chrome + 3 组 chrome-less 残留 daemon），保护名单零误报；`--min-age 0` 实跑全部收割，Chrome 主进程 5→1（仅剩 owner），4 个临时 profile 目录删除，shared / dsh-* / manual-* 全部完好；wrapper 冒烟（tab list）exit=0 且派发 stamp 正常刷新。

**可迁移规则**：
- 脚本侧 `trap '... close ... || true' EXIT` 是单点：close 失败静默、SIGKILL 时 trap 不执行。生命周期清理必须有公共层兜底，不能依赖每个调用方都写对。
- 判活不能只看 `kill -0`：pid 会回绕复用（chrome-guard 的同类坑），必须核对进程命令行 + 会话 sock 持有者。
- 「daemon 存活」≠「宿主还在」：daemon daemonize 后父进程是 launchd，无法从进程树推断归属，只能靠 sock 客户端活跃度 + 时间窗近似。

## 三、reaper 盲区：状态文件被清的孤儿


**盲区成因（两层叠加）**：① wrapper `purgeDeadSessionState` 以 `.pid` 文件判死删 sock，同名会话跨代重建时 `.pid` 落后于真实 sock 持有者 → 误删活 daemon 的 sock；② **上游真身二进制的 `session list` 等命令自带 prune**：见 `.pid` 为死 pid 即 prune 整个会话（对照实验：死 .pid 组 6 个状态文件连活 sock 全清、活 daemon 断联；正确 .pid 组完好）。被 prune 的实例「daemon 活着 + Chrome 活着 + 状态文件与 sock 全没了」，目录扫描看不见、任何客户端也无法再连 = 100% 孤儿。`cnm-e2e` 一个名字可泄漏 3 套 daemon+Chrome，`session list` 与 reaper 均不可见。

**处置（`~/.agents/bin/ab-reap-orphans.mjs` + wrapper，端到端验证 PASS）**：
1. **wrapper purge 判死前核实真实持有者**：`.pid` 死但 sock 存活时 `lsof -t <sock>` 找 holder，有存活的 agent-browser 进程 → **治愈**（把真实持有者写回 `.pid`，消除上游 prune 可见的不一致）并整组跳过；真正无主的陈旧 sock 照旧清理（反向对照 PASS）。
2. **reaper 盲区扫描**：进程级发现——`pgrep` 全部 daemon × `lsof -p` 所持 sock × 磁盘路径已消失 → 孤儿候选，按 `<名>.<pid>` 粒度两段式标记（`MARK_DIR/blind/`），保护名单与 profiles/main 红线同主路径。复现失联态后 dry-run 正确发现、收割后 daemon+Chrome+临时 profile 三者全清。
3. **dry-run 忠实模拟两段式**：无标记候选输出「将标记」而非「将收割」，不得把分钟级的活跃会话列进收割名单。
4. **新鲜度护栏 `--fresh-secs`（默认 600s）**：daemon 启动未满龄的候选一律跳过。**红线：`--min-age 0` 必须带保护名单**——刚引导的会话是活任务在两条命令之间的空档，不是孤儿，不带保护名单实跑会误杀活跃会话（实测可一次误杀 5 个刚拉的会话）。手动实跑必须带 `AB_REAP_PROTECT_SESSIONS` 且先核对 daemon 启动时间。

**其余仍需人工判断的边界**：`dsh-*`/`manual-*` 房客 daemon（attach 模式、无自带 Chrome）属 wrapper 保护类，即使宿主会话疑似已结束也不动手，报告即可；9h 无客户端的独立实例用 `agent-browser --session <名> close` 显式关（受 close 硬闸放行，daemon+Chrome+profile 三者全清）；**daemon TERM 会自行带走 Chrome 并删临时 profile 目录（约 2s）**，收割器无需再补杀。

## 四、清理义务细则与规模基线


**公共层兜底（reaper）不是豁免理由**，每个调用方仍负有清理义务：

1. **独立实例用完即关**：`agent-browser --session <名> close`（只关自己的；`close --all` 仍是红线）。
   宿主被 SIGKILL 时 trap 不会执行——那由 reaper 兜底，但正常路径必须自己 close。
2. **任务收尾复查两件事**：`agent-browser session list`（有没有不该存在的会话）、
   `ps aux | grep '[r]emote-debugging-port=0' | grep -vc -- '--type='`（headless 主进程数是否超出预期）。
   **口径坑**：直接 `grep -c 'remote-debugging-port=0'` 会把每个渲染/GPU/utility 子进程都算进去——
   条数可虚高约 10 倍（实测 22 条 vs 真实主进程 2 条）；用 `grep 'Chrome for Testing'` 又只匹配 Testing 构建，
   本机默认用 Google Chrome（Stable）时完全数不到。必须用上面「排除 `--type=`」的口径。
   发现异常残留：先核实无活任务，再 `node ~/.agents/bin/ab-reap-orphans.mjs --min-age 0` 立即收割。
3. **产物不落公共目录**：截图/HAR/下载等属项目中间产物，落项目 `.workwork/`；
   确因工具默认路径落到 `~/.agent-browser/tmp/` 的，reaper 按 7 天 TTL（`AB_TMP_TTL_DAYS`）自动清理，
   需要保留的当场挪走——`--dry-run` 可预览将清理的文件数。
4. **持久 profile 不用了要删**：`~/.agent-browser/profiles/<用途>/` 与项目自建 profile。
   项目废弃或改方案时连同状态文件一并清；删前 tar 备份到 `~/.dsh/backups/`。
5. **会话命名按任务独立**（`--session <名>-$$` 或项目固定名），禁止复用他人/他项目的名字；
   跨项目固定名冲突会让两个任务共用同一浏览器实例（标签互抢）。
6. **多轮迭代循环（goal/ralph/逐轮验证）必须每轮结束回收本轮实例**：
   一轮起 N 个命名独立实例、close 攒到整个任务最后一轮才做 = 轮间空档全是泄漏窗口
   （4 个实例仅推迟收尾即可挂 6 小时，叠加其他负载可把 8 核 16GB 整机压到 load 38、
   内存压力等级 2、鼠标卡顿）。
   reaper 两段式（标记 + ≥600s 最小龄 + 1h 节流派发 + 需 wrapper 调用触发）只能慢一步兜底，
   不能替代每轮自清。验证口径：每轮收尾后 `agent-browser session list` 只剩受保护会话、
   `ps` 里 headless Chrome 主进程数回落到当轮预期。
   **配套约束**：清理/删除类动作的前置守卫核验到**活进程/活引用时必须中止执行**（exit 非零），
   不能「打印警告后继续」——否则会打印 pgrep 命中清单却照样 rm，误删刚启动实例的临时 profile；
   且 close 扫描的同一分钟窗口内可能冒出新的临时实例，删目录前以「当下 pgrep 结果」为准，不以几分钟前的快照为准。

**规模基线**：一夜可累积 8 组孤儿 ≈112% CPU + 5.2GB 内存占用。泄漏不值得，清理不麻烦。

## 五、socket 目录重定向不在收割范围

**边界**：reaper 只扫描 `~/.agent-browser/` 下的会话；显式设置 `AGENT_BROWSER_SOCKET_DIR` 把 socket 重定向到别处（如仓库/worktree 内）的会话**不在收割范围**，且 `AGENT_BROWSER_SOCKET_DIR` 重定向不是现行路径（现行路径：目录写权限走 sandbox-extra-roots 放行 + 默认 socket 目录）。

## 六、空闲租约回收器 ab-reap-idle（任务收尾即回收的机械兜底）

**背景**：DSH 会话结束没有钩子；房客走 `--cdp` attach 属上游 user-attached browser，永不空闲关闭；独立实例又被 wrapper 显式设了 `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`。因此「agent 主动 close」之外还需要一层不依赖会话结束、也不依赖后续有人再调浏览器的兜底——否则用户完成一个任务后直接开新会话，旧实例会残留到过夜（无兜底时 3 组独立实例可跨会话残留 10 小时，合计 781MB 内存 + 317MB 临时 profile）。

**机制**：
- wrapper 每次**非 close** 调用刷新 `~/.agent-browser/<session>.last-used`（==`<名>.last-used`== 随后续 close 一并清除）；
- launchd 任务 `com.chaoset.ab-idle-reaper`（`~/Library/LaunchAgents/`，StartInterval 300s）运行 `~/.agents/bin/ab-reap-idle.mjs`：对「sock 在 + daemon 活 + 无 CLI 客户端 + last-used 距现在 ≥ 阈值」的**非 owner** 会话执行 `agent-browser --session <名> close`——房客先摘自己的 pinned tab 再退 daemon；独立实例连自带 Chrome 与临时 profile 一起回收；`shared` 永不碰。
- 阈值：`AB_IDLE_CLOSE_MS` 默认 900000（15 分钟）；`AB_IDLE_MIN_AGE_MS` 默认 120000（会话存在不足 2 分钟不碰）。手动检查：`node ~/.agents/bin/ab-reap-idle.mjs --dry-run -v`；立即回收：`AB_IDLE_MIN_AGE_MS=0 node ~/.agents/bin/ab-reap-idle.mjs`（先确认无活任务）。
- 状态：每次真实运行写 `~/.agent-browser/.last-idle-reap`；动作日志 `~/.agent-browser/idle-reaper.log`（launchd 落盘）。

**边界**：
- 它是兜底，不是替代——主路径仍是任务收尾主动 `close`（见 SKILL.md「清理义务」第 1、2 条）。
- 任务中途若超过阈值不操作浏览器（长构建/长等待），实例会被回收；下次命令自动重建但页面状态丢失。长等待前可发 `agent-browser wait` / `eval` 保活，或临时调大阈值。
- 判定采「严格模式」：**没有 `last-used` 的会话一律不自动回收**（wrapper 未写时间戳 / 绕过 wrapper 直连上游 binary 的会话无法证明任务已结束），留人工 close；因此该机制的覆盖范围 = 经本机 wrapper 发起的所有会话（guest 与显式实例均写时间戳，普通 `--session X` 与 `--profile` 单独指定的 `default` 会话都覆盖）。
- 与 `ab-reap-orphans.mjs` 的差异：后者按「sock + daemon 活 + 临时 profile Chrome」判定孤儿、按名字前缀保护 `dsh-*`（会豁免 `dsh-pu-toggle`/`dsh-stable` 这类显式命名的独立实例），且只在有人调用 agent-browser 时搭车运行；本回收器按**实际活动时间戳**判定且定时运行，能覆盖跨会话、无人再用浏览器的场景。
- 停用：`launchctl bootout gui/$(id -u)/com.chaoset.ab-idle-reaper` + 删 `~/Library/LaunchAgents/com.chaoset.ab-idle-reaper.plist`。发现仍用 `AGENT_BROWSER_SOCKET_DIR` 重定向的脚本时按非现行做法处理。
