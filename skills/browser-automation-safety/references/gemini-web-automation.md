# Gemini 网页自动化细节（上传/模型切换/读答复）

> 本文是 browser-automation-safety 的 reference，仅在操作 Gemini 网页（传图/文件、切模型与思考等级、读回答、多图批量审查）时加载；红线与默认决策见 SKILL.md。

## 一、用户日常 Chrome 上的 AI 网页自动化（仅用户明确要求时）


**前提：仅限用户明确要求操作其日常 Chrome（用其登录态）时使用，即上方红线 3 的唯一例外场景；AI 不得自行选择此模式。** 下文直连 CDP 与 `--auto-connect` 是同一前提的两种入口。

**auto-connect 模式下命令默认跟随用户的「当前活动标签」**——用 `--auto-connect
--pin-tab` 钉住自己的标签（`tab new <url>` 时带 `--pin-tab` 即建即钉），之后所有
命令（含截图）只打该标签，用户看哪都不影响。

**唯一可行方案：直连 CDP 用 `Input.dispatchDragEvent` 做真实文件拖拽**
（2026-10-14 实测：4/4 图片全部附加成功、缩略图完整渲染、Gemini 正常受理）。

**CDP 会话全程复用（2026-10-14 用户重申，弹窗铁律）：整个任务只允许发生一次 browser 级 WS 握手、一次 target attach——下述流程第 1-2 步建立连接后，取坐标、拖拽、输入、发送、轮询响应（第 3-7 步）全部复用这条连接与这个 attach session，直到任务结束。禁止每步操作重开 WS 或重 attach。意外断线只允许单次退避重连；连续失败说明 Chrome 端状态已变，停下来报告用户，严禁循环重连（每条新握手都弹一次窗）。**

### 流程（Node 22+ 内置 WebSocket，无需依赖）

1. **拿 WS 端点**：读用户 Chrome profile 的 `DevToolsActivePort` 文件
   （`~/Library/Application Support/Google/Chrome/DevToolsActivePort`，两行：
   端口 + `/devtools/browser/<uuid>`）。HTTP `/json/*` 对默认 profile 404，
   不影响 WS 直连。**文件 mtime 偏旧 ≠ 端点失效**：Chrome 不重启则端口与 UUID
   不变（2026-10-14 实测：mtime 6 天前的文件仍直连成功）；失效的判据是
   端口无监听（`lsof -iTCP:<port> -sTCP:LISTEN`）或 WS 连接失败，此时停下来
   请用户以调试模式重启 Chrome，禁止自行重启用户 Chrome 或反复试探。
2. **找页并 attach**：`Target.getTargets` 按 URL 找页 targetId →
   `Target.attachToTarget {targetId, flatten:true}`。
3. **取投放点**：`Runtime.evaluate` 读 composer 的
   `getBoundingClientRect` 中心坐标。
4. **拖拽**：`Input.dispatchDragEvent` 依次 `dragEnter`/`dragOver`/`drop`，
   `DragData = {items:[], files:[本地绝对路径...], dragOperationsMask:1}`——
   **files 传本地绝对路径**，Chromium 按真实系统拖拽处理（isTrusted=true）。
5. **输入提示词**：真实 click 聚焦 contenteditable →
   `keyboard inserttext "$(cat prompt.md)"`（CDP Input.insertText，多行中文可靠）。
6. **发送**：eval 找 aria-label 含 `发送` 的 button 并 click。
7. **捕获响应**：eval 轮询响应容器 innerText 长度，连续 2 次稳定即完成
   （高思考等级 1-3 分钟）。

### 注意

- attach + evaluate 偶发渲染器崩溃（`Target crashed`）——捕获后 `Page.reload`
  等重生、重 attach 即恢复；崩溃会丢 composer 附件状态，需重新拖拽。
  **此处「重 attach」属异常恢复例外（原 session 已随渲染器崩溃死亡），每个任务至多一次；连续崩溃即停并报告，不得反复重生重连。**
- 附件验证用 `Page.captureScreenshot` 目视确认芯片缩略图（DOM 属性计数不可靠）。
- 模型/思考等级选择（点 Pro 按钮 → 菜单）：菜单项用
  `[role=menu] [role=menuitem]` 精确层级选择（「3.1 Pro」→ 重开菜单 → 「高点」）。
- 页面 Angular 重渲染会复位模型选择与附件状态——每步之间 eval 读 DOM 确认。
**对用户日常 Chrome 发起 CDP 握手 = 弹窗风险,失败一次即停（2026-10-14 晚用户严厉纠错）**：
某会话把「WS 连接重试脚本（单次 6 连发）」当探测手段跨多轮反复执行，累计数十次握手，
用户不在场无法点弹窗，回来面对弹窗轰炸。红线细则：
① 连接失败**一次即停**——本轮禁止一切 CDP 尝试，写进交接说明等用户在场处理；
② 重试上限 = 每会话 1 次，且需环境已变化的证据（如 DevToolsActivePort uuid 变更）；
③ 探测 Chrome 状态优先走无副作用通道（读 DevToolsActivePort 文件、lsof），
不发起连接本身；④ 「等恢复再试」永远是伪命题——坑位不释放不会自愈，
唯一出路是用户重启 Chrome 后、在场时执行一次。
**会话级连接预算要机制化（2026-10-14 晚补充验收标准）**：「最多一次连接请求」
不能靠口头纪律，要状态文件硬闸：连接失败写持久标记（如 cdp-state.json result:fail），
后续调用直接拒绝；结果可复用时（文件已存在）优先复用不重发；全流程合并为单命令，
整个进程只握手一次。验证方式：写 fail 标记后调用应被拒绝、无连接产生。
**Chrome 自动化统一单一 profile（2026-10-14 晚用户验收；2026-10-15 起 `profiles/main` 为浏览器 owner 专属，用户命令跑在房客里——见「复用铁律」，某前端项目 的 auto profile 作为显式指定继续有效）**：全部自动化
（截图/e2e/登录态操作）固定用 **一个** profile + 固定 session 名（本项目实例：
/tmp/<项目>-agent-profile + session auto），每条调用显式带 --session 与 --profile，
缺一个就会落到 wrapper 注入的默认临时 profile（假性数据「丢失」）。位置选 /tmp
而非 home：home 下 Chrome 运行时写入被 DSH 沙盒拒（exit 21，privileged 单命令
只覆盖那一次执行）；/tmp 已实测可写且全机可达，代价是机器重启后 profile 清空
（需重新登录一次）。另：agent-browser eval 结果输出走 stderr，2>/dev/null 会
误判为无输出。清理旧 profile 先 du 盘点并确认无活进程占用（ProcessSingleton）。

## 二、Gemini 网页常规自动化（默认 headless owner）


与上一节的差别：**不需要直连用户日常 Chrome** —— 走 wrapper 默认房客（owner = `profiles/main` headless，登录态已持久），全程零弹窗、零抢焦点。本节所有结论均在本机实测复现。

**开箱可用脚本**：`.workwork/gemini-upload/gemini-image-ask.sh`（示例副本，可自行复制到别处；同目录 `README.md` 有完整排障笔记）。用法
`./gemini-image-ask.sh -f <图片绝对路径> -p "<提示词>" [-o 输出目录] [-n 在当前对话继续]`。
它已内置本节全部坑的规避与重试：可见性置前、CSS 选择器点击、菜单内注入、`naturalWidth` 校验、`textContent` + 停止按钮 + 长度稳定的三重完成判据。2026-10-15 实测端到端多轮成功（含"用户给的终端截图"识别为 Homebrew 阿里云镜像配置这类真实判据；单轮约 28-35 秒）。

**独立验证结论（2026-10-15，另一 agent 在独立 `AGENT_BROWSER_GLOBAL_SESSION` 实例上复测）**：端到端 **7/7 成功**（跨两个脚本版本各 3 次 + 1 次"先把标签强制切后台再启动"的自愈测试）。反例也全部如实失败：不点菜单直接 `upload` → `Element not found`；用错 `accept` 选择器 → 同上；传相对路径 → 命令报 `✓ Done` 但 `att=0, has-error=1`（**证实"不能信 upload 的 ✓ Done"**）。该 agent 还用 CDP `Target.activateTarget` 做了受控对照，**实测 rAF 节流：前台 91-93 次/1.2s → 后台恒 1 次/1.2s（约 90 倍）**，后台 5/5 轮 `inputs` 恒为 0（即便 `aria-expanded=true`）——本节坑 0 的机制得到独立确证。

**对坑 0 的一处措辞修正**（验证者实测）：后台标签时 `[role=menu]` **并非**完全不生成，实测菜单元素能出现，只是**里面不含 `input[type=file]`**。"input 恒为 0"是硬事实，"菜单 DOM 完全不生成"说得太满。

### 模型 + 思考等级切换（选择器一览）

| 目标 | 选择器 / 判定 |
|---|---|
| 当前模型按钮 | `.picker-primary-text`（取 `[0]`）→ `closest('button')`，取值看其 `aria-label`「打开模式选择器，当前模式为"X"」 |
| 模式菜单 | 点上面这个 button → `.cdk-overlay-pane [role=menu]` |
| 模型项 | `gem-menu-item` / `[role=menuitem]`，文本形如 `4 Argon` + 换行 + `复杂任务`；**用行首精确匹配**，别用 `includes`——菜单里同时有 Pro / Flash-Lite |
| 思考等级 | 菜单里文本为「思考等级」的 `gem-menu-item` → 点开是**二级** `.cdk-overlay-pane`（取 `panes[panes.length-1]`） |
| 三档 | 「低点 + 快速高效」「中等 + 深度适中」「**高点 + 超级详尽**」（"高思考" = 高点）；选中态是 `class` 含 `selected`，**不是** `aria-checked`（实测恒为 null，别用它判断） |

**验证方式（必做）**：切完后读 `aria-label`，必须变成「当前模式为"Argon 高点"」。

### 图片上传：四个致命坑（2026-10-15 二次实测，脚本 `.workwork/gemini-upload/gemini-image-ask.sh`）

**0. 目标标签必须在【前台】——这是最难定位的一个（2026-10-15 实测定位）**

Chrome 对**后台标签**节流 `requestAnimationFrame`。Gemini 的 Angular CDK 菜单在后台标签里**不渲染菜单内容**：点击「上传和工具」后按钮的 `aria-expanded` **已经变成 `"true"`**（所以看 expanded 会误判成"菜单已开"），但菜单 DOM 不生成、`input[type=file]` 数量**恒为 0**，`upload` 一直报 `Element not found`。


- 实测数据：`document.visibilityState === 'hidden'` 时连点 5 轮，仅约 3 轮 `aria-expanded=true`，且 `inputs` 恒为 0；
- `agent-browser tab <该标签的 tabId>` 把它切到前台（`visibilityState === 'visible'`）后，**同一次点击立刻拿到 `inputs=3`**。
- **判据**：动手前先读 `document.visibilityState`；是 `hidden` 就先切到该标签。切完**必须复查**，共享 Chrome 里别的会话可能在同一瞬间又把标签切走，必要时重试一次。
- **怎么定位"我自己的那个标签"——两个弯路都别走**（2026-10-15 实测）：
  | 方法 | 结果 |
  |---|---|
  | 按 URL 找 | ✗ 页面上常有多个 `https://gemini.google.com/app`（重开对话不改 URL），会选错 |
  | `document.title` 打标记再按 title 找 | ✗ Gemini 是 SPA，立刻把 title 改回会话名；且 `tab list` 的 title 有缓存，刚设的标记常读不到 |
  | **`agent-browser tab`（无参）输出里带 `→` 的那行** | ✓ **正解**：`agent-browser tab 2>/dev/null \| grep -- "→" \| grep -oE "t[0-9]+" \| head -1` 拿到本会话 pinned 的 `t<N>`，再 `agent-browser tab <t<N>>` 激活 |
  | 兜底：本会话 `.target` 文件里的 `targetId` | ✓ `~/.agent-browser/${session}.target` 的 `targetId` 也可直接喂给 `tab` |

1. **`input[type=file]` 只在「上传和工具」菜单打开时才存在于 DOM**。菜单关闭时 `querySelectorAll('input[type=file]')` 返回 `[]`，`upload` 直接报 `Element not found`。
   正确顺序：点 `[aria-label="上传和工具"]`（即 composer 左侧的 `+`）→ sleep 2~3s → **立即** `upload 'input[type=file][accept="image/*"]' <path>`（菜单里有 2~3 个 file input，必须带 `accept="image/*"` 区分）。
   > 曾经"成功"过一次纯属巧合：那次恰好是同一段菜单会话未关闭。

2. **必须传绝对路径**。传相对路径时 `upload` **返回 `✓ Done` 但 Chromium 静默拒绝**——附件立刻带 `has-error`，且**网络面板里根本没有上传请求**（不是网络问题！）。本次对照实验：同一个小 PNG，相对路径 8 次全失败、绝对路径一次成功。

3. **不要用 `find role ... --name` 点这个按钮——它会静默失败**。`agent-browser find role button click --name "上传和工具"` 实测 **exit 0、无任何输出、菜单也不展开**，看起来像"点过了"。用 CSS 选择器 `agent-browser click 'button[aria-label="上传和工具"]'` 才稳定命中（2026-10-15 实测，两种写法各跑多轮对照）。

**不要试图用合成的 DragEvent/DataTransfer 伪造拖放**（2026-10-15 实测不可行）：`xap-uploader-dropzone` 在菜单关闭时**根本不在 DOM 里**（实测数量 = 0），`drop` 事件无处可投，dispatch 后附件数仍为 0。真实文件拖拽只有走 `Input.dispatchDragEvent` + `files:[绝对路径]`（见上一节）才成立。

**成功判据（别信 chips 数量）**：

| 状态 | 信号 |
|---|---|
| 失败 | `uploader-file-preview-container` 带 `has-error`；内部是 `gem-attachment-loading-error`；无 `gem-media-attachment` |
| 成功 | `has-error` 消失；出现 `gem-media-attachment`；`gem-media-attachment img` 有 `src`（blob: 缩略图）且 **`naturalWidth > 0`** |

**截图必须传绝对路径（2026-10-15 实测）**：`agent-browser screenshot "$OUTDIR/answer.png"` 传相对路径会**静默失败**——截图相对 daemon 的工作目录解析，不在你的 cwd。实测 `-o ./.out` 只落了 `answer.json`、没有 png。先 `ABS_OUT="$(cd "$OUTDIR" && pwd)"` 再传绝对路径，并检查文件确实存在（别被 `|| true` 吞掉错误）。

**推荐的机器可判定口径（2026-10-15 实测，脚本已内置）**：
```bash
# 附件计数（判"是否注入成功"）
agent-browser eval 'document.querySelectorAll("gem-media-attachment").length'
# 最强判据：确实是有效图片预览，且尺寸与源图一致
agent-browser eval 'var i=document.querySelector("gem-media-attachment img"); i&&i.naturalWidth>0?("ok:"+i.naturalWidth+"x"+i.naturalHeight):"bad"'
```
后者会返回 `ok:1172x876` 这样的结果，可直接与源图尺寸比对——比数 chips 数量可靠得多。

上传成功的网络链路（用于排障对照）：`OPTIONS/POST push.clients6.google.com/upload/` → `POST .../ProcessFile`，均 200。**若这两条一个都没有，就是本地阶段被拒（路径问题），不是网络问题。**

### 提交与读取回答

- **发送必须用真实点击** `agent-browser click '[aria-label="发送"]'`。`eval "button.click()"` 会返回 sent 但消息**发不出去**（输入框文本原样残留）；`press Enter` 同样无效。发送成功的判据：`.ql-editor` 变空、`[aria-label*=停止]` 出现、附件 chip 消失。
- **真实点击超时时，CDP 直发 `Input.dispatchKeyEvent` 回车是可靠兜底（2026-10-15 某媒体项目 UI 审查实测）**：与上条不矛盾——`press Enter`（经 agent-browser 键入）无效，但经 browser 端 WS 直发 `{type:keyDown/keyUp, key:Enter, code:Enter, windowsVirtualKeyCode:13}` 是 trusted 输入，编辑器有焦点时 Gemini composer 收到即发送。`Input.dispatchMouseEvent` 找不到元素/超时时用它接管。
- **大文本 `Input.insertText` 超时 ≠ 插入失败（同日实测，28.6K 中文字符 + 代码块）**：CDP 调用 30s 超时抛错，但重连后读 `.ql-editor` 的 `textContent.length` 与头尾内容，确认**文本已全部插入**（渲染进程忙于处理大文本，响应没赶回来）。**先查状态再决定是否重试**——盲目重发会让输入内容翻倍。
- **渲染器迟缓是连锁的（同日实测）**：insertText 超时后紧接着 `Input.dispatchMouseEvent` 也超时（同一渲染进程忙）。此时轻量 `Runtime.evaluate`（20s 超时）始终可用，判障/读状态/兜底发送全走它；`dispatchMouseEvent` 只留给必须真实指针的场景（开菜单、选模型）。后台 gradle 构建抢 CPU 会显著加剧迟缓，审查流水线别与其并发。
- **大 prompt 整份插入会被重复执行（2026-10-16 某媒体项目 UI 审查实测，接上条的反面）**：46KB 单次 `agent-browser keyboard inserttext` 后，`.ql-editor` 里出现 **4 份完全相同**文本（textContent 长度 161,772 ≈ 4×41K 字符）——即这次调用被重试，而**每次都已写入成功**，与上条"超时≠失败"是同一机制的另一面。规避：**先精简再发**（同一份内容改发"增量 diff"版 5.8KB，单份通过、秒级完成）；必须发大文本时**分段插入**，每段后 eval 统计目标串出现次数与总长度，发现多份就重载页面（`open` 同一 URL 会清空 composer 但保留线程）重来。
- 回答容器：`model-response`（或 `[class*=model-response]`）。轮询其长度，`[aria-label*=停止]` 消失即完成（Argon 高点实测 <1 分钟）。
- **完成判据不能只看"长度 > N"（2026-10-15 实测踩坑）**：写死 `length > 20` 会让**短回答**白等满全部轮次——实测 Gemini 答"主色调为深绿色和亮绿色。"（13 字符）、"深绿色"（3 字符）、"有"（1 字符）都是正常完整回答。正确判据是三条件并列：① 长度 > 0；② 页面上没有"停止"按钮（`[aria-label*=停止],[aria-label*=Stop]` 计数为 0 = 生成已结束）；③ 长度连续 2 次不变。修正后同场景耗时由 4 分钟降到 28 秒。
- **必须读 `textContent`，不要读 `innerText`（2026-10-15 实测更正）**：无头浏览器里后台标签的 `innerText` **返回空**——实测 `model-response` 的 `innerText.length` 只有 8（就是 "Gemini 说" 这几个字），而 `textContent.length` 有 513。用 innerText 轮询会**永远判不出回答已生成**，误以为"Gemini 没回答"。此前的"轮询 innerText.length"结论只在前台标签成立。
- **取正文要剥离"非正文"节点，别只删 `img`**（2026-10-15 二次定位）：污染源其实是回答末尾的**引用来源卡片** `<sources-carousel-inline><source-inline-chip><span class="source-title">PNG</span><span class="source-count">+ 2</span>`，拼进正文后是 `…位于画面的中上方。   PNG+ 2`——**看着像图片 alt，实际是来源标签**（第一次排查被它带偏过）。稳妥的 `cloneNode(true)` 后剔除列表：
  `img,svg,source,picture,sources-carousel-inline,sources-list,source-footnote,source-inline-chip,response-actions,message-actions,gem-icon-button,mat-icon,thinking-overlay`
- `eval` 返回**对象**时 agent-browser 自己就会输出 JSON（`agent-browser eval '({a:1})'` → `{\n "a": 1\n}`）。**不要再套一层 `JSON.stringify`**，否则落盘文件里是"字符串里再套一层 JSON"，`json.load` 后得到 `str` 而非 `dict`。要拿裸值就直接返回对象；用 `JSON.stringify` 时记住需要二次解析。

### 重渲染会复位状态（务必每步复查）

**刷新或 Angular 重渲染后，思考等级被重置为「低点」、模型可能变回 Pro** —— 本次刷新页面后 `aria-label` 从 Argon 高点 退回 Argon。**上传完图片、发送前，必须重新读 `aria-label` 确认模型与思考等级**，否则白跑。

### 与上一节的取舍

| | 本机默认 owner（headless，本节） | 用户日常 Chrome 直连 CDP（上一节） |
|---|---|---|
| 弹窗风险 | 无 | 有，失败一次即停 |
| 登录态 | `profiles/main` 已持久 | 用户正在用的登录态 |
| 干扰用户 | 零（headless） | 会抢焦点/切标签 |
| 结论 | **默认选这个**；仅当 owner profile 无登录态且用户明确要求时，才走上一节 |

### 多图批量审查流水线补充（2026-10-16 UI 审查实测，8 批 43 图全通过）

- **headless owner 的 tab 必须先设视口**：CDP `Emulation.setDeviceMetricsOverride {width:1440,height:900}` 之后，composer 的「上传和工具」「模式选择器」按钮才会渲染；未设视口时三者全部查不到（modeBtn/uploadBtn/sendBtn 全为 none，脚本报 NO_UPLOAD_BTN）。Gemini 默认窗口下布局塌缩，编辑器虽在但按钮区缺失。
- **`/app` 打开常停在边栏视图**：`.ql-editor` 存在但 composer 不完整。自愈逻辑：探测 modeBtn/uploadBtn 任一缺失 → 真实点击「发起新对话」（aria-label/文本精确匹配）→ 等 8s 再探测。
- **附件缩略图就绪 ≠ 服务端处理完成**：`gem-media-attachment img.naturalWidth>0` 后立刻发送，偶发实际发出的是纯文本（回答「我是一个文本 AI，这超出了我的能力范围。」约 21 字符）。发送前额外 sleep 6s，并校验 `gem-media-attachment` 数量 === 图片数。
- **回答长度 <50 字符 = 附件未带上的强信号**，直接整轮重试（新对话）而不是继续等。
- **模型守卫实测**：Argon 配额耗尽时，菜单切回 Argon 多次尝试均失败（自动回退 Flash-Lite）——接受 Flash-Lite 可正常完成多图 UI 审查（本日 8 批全部产出有效审查，单批 1-6 图、回答 2-5.5K 字符）。
- 连续开多个新对话 tab 无弹窗问题（owner 独立 headless），但偶发菜单 file input 不渲染（rAF 节流）——直接整轮重试即可。



