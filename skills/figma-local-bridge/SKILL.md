---
name: figma-local-bridge
description: 通用 Figma 自动化设计排版与桌面桥工作流：强关联组件语义 Frame 封装规约（防撞防错位）、Z 轴层级（Z-Order）防遮挡纪律、胶囊与指标中轴数学对齐方程、吸底 16~32px 避让、三端安全区扩高机制、未加载字体防 Crash 三重预加载；基于本地 WebSocket 桥接与轻量 HTTP 控制台直接驱动 Figma 桌面端执行 Plugin API、导出高清节点切图（export）、创建命名版本里程碑（saveVersionHistoryAsync）与自动化巡检（audit）。触发：需要在 Figma 中生成或修改画板、图层排版对齐与重构、排查图层遮挡/截断/字体报错、创建命名版本、导出节点切图、同步 design tokens。
---

# Figma Local Bridge

通用 Figma 本地桌面桥接与设计规范自动化工作流。通过在 Figma 桌面端常驻一个轻量 WebSocket 插件（Figma Local Bridge）并结合本机守护进程与 CLI 控制台，打通外部脚本、CLI 工具与 AI Agent 直接调用完整 Figma Plugin API 与创建命名版本（`saveVersionHistoryAsync`）的能力。

## 核心架构与通信拓扑

```text
┌────────────────────────────────────────────────────────┐
│                   外部环境 (CLI / AI Agent)              │
│  figma-bridge eval "..."  /  save-version  /  curl     │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP (127.0.0.1:8787)
                            ▼
┌────────────────────────────────────────────────────────┐
│             本机守护进程 (scripts/server.mjs)           │
│           管理请求队列、生命周期与 PID 状态            │
└───────────────────────────┬────────────────────────────┘
                            │ WebSocket 双向长连接
                            ▼
┌────────────────────────────────────────────────────────┐
│           Figma 桌面插件 (plugin/ui.html iframe)       │
│        维护 WebSocket 客户端与实时连接状态指示器       │
└───────────────────────────┬────────────────────────────┘
                            │ Figma 内部 IPC (postMessage)
                            ▼
┌────────────────────────────────────────────────────────┐
│          Figma 主线程沙盒 (plugin/code.js)             │
│   执行 figma.* API、安全序列化、创建命名版本、修改画布 │
└────────────────────────────────────────────────────────┘
```

### 与云端 Figma MCP 的边界分工

1. **云端沙盒限制（Figma MCP `use_figma`）**：
   - 官方 MCP 的 `use_figma` 是云端无头沙盒（WebSocket 直连 Figma 后端），擅长免桌面干扰的画布节点增删改、样式计算与 `get_screenshot` 高清截图。
   - 但云端沙盒未开放编辑器高级能力：调用 `figma.saveVersionHistoryAsync()` 会明确抛出 `Error: in saveVersionHistoryAsync: figma.saveVersionHistoryAsync is not yet supported`；且 Figma 官方 REST API `/v1/files/:file_key/versions` 仅支持 `GET` 查询，不支持 `POST` 创建。
2. **桌面桥（Figma Local Bridge）的核心价值**：
   - 运行在真实的桌面端 Figma 客户端内，拥有完整的 Plugin API 执行权限，能够自动化调用 `figma.saveVersionHistoryAsync(title, description)` 记录带标题与描述的命名版本里程碑。
3. **双通道协同分工**：
   - 画布批量调整、图层重构、视觉巡检、自动化截图：走 **Figma MCP**；
   - 命名版本里程碑留痕、桌面端交互与本地文件系统联动：走 **Figma Local Bridge**。

### 关键设计约定
1. **沙盒边界规约**：Figma 场景主线程（`code.js`）运行于 QuickJS 环境，无全局 `WebSocket` 与浏览器 DOM。网络连接必须由 `figma.showUI` 承载的 UI iframe（`ui.html`）建立，再经由内部消息机制桥接。
2. **网络白名单**：桌面插件清单（`manifest.json`）必须显式声明 `networkAccess.allowedDomains`（包含 `ws://127.0.0.1:8787` 和 `http://127.0.0.1:8787`），避免现代 Figma 拦截连接。
3. **一次安装，跨项目通用**：插件不绑定任何特定业务。开发者在 Figma 桌面端只需导入一次，此后在任何项目中启动 Bridge 服务，该插件均可即开即连。

---

## 一次性安装规程（桌面端）

1. 打开 Figma 桌面端。
2. 菜单栏选择：`Plugins` → `Development` → `Import plugin from manifest…`。
3. 选择本 Skill 目录下的 `plugin/manifest.json`。
4. 运行「Figma Local Bridge」，画布左上角会出现状态小卡片（显示连接状态、当前打开的文件名）。保持该窗口开启即可维持长连接通道。

---

## 自动化 CLI 命令速查

CLI 脚本已软链接至全局 PATH（可直接在任何项目执行 `figma-bridge <命令>`，或调用 `node ~/.agents/skills/figma-local-bridge/scripts/figma-bridge.mjs`）。调用时若检测到后台服务未启动，**CLI 会自动在后台拉起服务**：

```bash
# 1. 查看状态（服务是否启动、桌面插件是否连接、打开的 Figma 文件名）
figma-bridge status

# 2. 在 Figma 中执行任意 Plugin API 代码（支持单行表达式自动求值）
figma-bridge eval "figma.root.name"
figma-bridge eval "figma.currentPage.selection.length"

# 3. 执行多行复杂脚本文件
figma-bridge eval -f path/to/script.js

# 4. 创建 Figma 命名版本里程碑（自动拉起服务）
figma-bridge save-version -t "版本标题" -d "改动内容摘要..."

# 5. 导出指定节点为高清切图（PNG/SVG/PDF，支持倍率，保存至本地）
figma-bridge export <nodeId> -o ./shot.png --scale 2

# 6. 一键运行通用排版、Z轴层级与吸底基准巡检
figma-bridge audit [画板名称过滤]

# 7. 后台服务独立生命周期管理
figma-bridge start     # 后台静默启动
figma-bridge stop      # 停止服务（含端口扫描防孤儿进程）
figma-bridge restart   # 重启服务

# 8. 自动化冒烟自检（协议握手、eval 闭环、打版本测试）
figma-bridge verify
```

---

## 通用设计工程化与排版对齐规约（跨项目通用法则）

无论通过云端 MCP `use_figma` 还是通过 Local Bridge 脚本修改画布，Agent 与脚本必须严格遵守以下工程规范，杜绝散落漂移与视觉事故：

### 1. 强关联组件语义 Frame 封装规约（防漂移与错位）
- **严禁画板顶层散落平铺子节点**：包含品牌 Logo、胶囊背景底、标题文本、折叠/展开指示器、搜索栏微图标等强关联的复合控件，**必须统一封装为命名的语义 Frame 容器**（如 `品牌标志 / BrandLogo`、`搜索胶囊 / SearchBar`）。
- **杜绝绝对坐标踏空**：散落子节点若各自分配顶层画板绝对坐标，在文本字宽变化、多语言换行或视口宽度伸缩时极易出现横向踩踏（如 Logo 图标压住品牌文字、置顶图标压住公告标题）。封装在 Frame 容器内能将其局部相对坐标绝对锁定，容器尺寸由内边距或固定尺寸精准约束。

### 2. Z 轴渲染层级（Z-Order）防遮挡纪律
- **SceneNode 渲染顺序遵从 children 数组索引**：Figma 中索引越大越靠上（越晚被绘制）。
- **浮动操作栏置顶铁律**：页面顶部的浮动导航栏（`顶部导航栏 / TopNavBar`）、返回按钮胶囊、右上角操作胶囊（分享/更多/关闭）在父画板的 `children` 树中，其索引必须大于全出血媒体大图与正文卡片（`index > mediaCard.index`）。
- **全出血大图遮挡防范**：沉浸式详情页的照片卡片若排在浮动导航栏之后，会导致返回按钮被不透明实景大图完全遮挡。生成或调整大图后必须核实图层顺序，确保操作浮层处于顶层。

### 3. 单行胶囊与按钮原生垂直居中方程
- **禁止盲调 Y 轴偏移**：严禁采用 `text.y = bg.y + 3` 这类经验盲调。中文字体内置顶间距差异会导致不同字号高度中心线错位。
- **原生垂直居中标准范式**：
  ```javascript
  text.fontName = { family: "Noto Sans SC", style: style };
  text.textAlignVertical = 'CENTER';
  text.y = bg.y;
  text.resize(text.width, bg.height);
  ```
  让文本节点的外框高度直接等于背景矩形高度（`text.height = bg.height`），`y` 坐标与背景顶对齐，借由 Figma 原生排版引擎以亚像素精度自动完成数学垂直居中。

### 4. 复合胶囊（图标 + 文字）安全布局方程
- **复合胶囊定位公式**：
  $$W_{total} = W_{icon} + \text{gap} + W_{text}$$
  $$X_{start} = X_{bg} + \text{round}\left(\frac{W_{bg} - W_{total}}{2}\right)$$
  $$X_{icon} = X_{start},\quad Y_{icon} = Y_{bg} + \text{round}\left(\frac{H_{bg} - H_{icon}}{2}\right)$$
  $$X_{text} = X_{icon} + W_{icon} + \text{gap},\quad Y_{text} = Y_{bg}$$
  保证容器左右留白完全对称，图标与文字间距清晰（$\text{gap} \ge 4\text{px}$），文字全高居中。

### 5. 指标 / 数据卡片（Stats / Metrics）水平中轴绝对锁定
- **严禁数值与标签独立绝对定位**：数值通常为大号加粗字体（20~24px），标签为小号辅助文本（12~13px）。两者各赋 X 坐标会导致数值向右偏离 15~25px，破坏视觉 1:1 对应关系。
- **中轴对齐公式**：
  $$X_{center} = X_{lbl} + \frac{W_{lbl}}{2}$$
  $$X_{num} = \text{round}\left(X_{center} - \frac{W_{num}}{2}\right)$$
  或为两者设置等宽列框（`width = colWidth`），均开启 `textAlignHorizontal = 'CENTER'`，确保垂直中轴绝对重合。

### 6. 吸底元素安全视距与画板规范尺寸
- **画板规范基准尺寸**：
  - 移动端：标准视口为 $390 \times 891\text{px}$（含顶部 47px 状态栏安全区，内容流高度 844px）。
  - 平板端：标准视口为 $834 \times 1136\text{px}$（含顶部 24px 状态栏安全区，内容流高度 1112px）。
  - 桌面端：标准视口为 $1440 \times 900\text{px}$（无顶部系统栏，全高 900px）。
- **吸底组件（Dock / 评论输入栏）安全视距**：
  - 列表与滚动容器底部必须预留至少 $16 \sim 32\text{px}$ 呼吸间距（Padding-Bottom），严禁滚动正文末尾或操作按钮被吸底悬浮栏（底部固定 TabBar、吸底评论发送条、底部操作 CTA）生硬截断或遮盖。

### 7. 未加载字体防 Crash 三重预加载范式
- **禁止向未加载字体的 TEXT 节点写入任何属性**：Figma 沙盒环境缺失本地系统字体（如 `PingFang SC`）。对含未加载字体的节点执行任何写操作（包含 `characters`、`fontSize`、`textAlignVertical`、`resize` 等）均会触发运行时致命异常：`Cannot write to node with unloaded font`。
- **全样式预加载范式**：不仅加载 `Regular`，必须同时加载待写入的 `Medium` 和 `Bold`：
  ```javascript
  await figma.loadFontAsync({ family: "Noto Sans SC", style: "Regular" });
  await figma.loadFontAsync({ family: "Noto Sans SC", style: "Medium" });
  await figma.loadFontAsync({ family: "Noto Sans SC", style: "Bold" });
  ```
- 修改属性前，先强制重定向至已加载字体：`text.fontName = { family: "Noto Sans SC", style: style };`，再修改 `textAlignVertical` 或重设文本。

### 8. 沙盒边界与数据类型防御
- **`figma.mixed` Symbol 类型防御**：多角不同圆角的矩形其 `cornerRadius` 为 `Symbol(figma.mixed)`。判断必须加类型防护：`typeof n.cornerRadius === 'number' && n.cornerRadius > 3`，防止抛出 `cannot convert symbol to number`。
- **遍历删除级联失效防护**：删除父节点后子节点会被自动级联销毁，遍历列表时需自顶向下删除或包裹 `try { node.remove(); } catch (e) {}`。

---

## 跨项目复用方案

在任何全新项目中接入本套 Bridge 能力：

### 模式 A：直接调用全局 Skill CLI（免拷贝）
无需拷贝任何文件到新项目，直接使用绝对路径运行全局 CLI：
```bash
node ~/.agents/skills/figma-local-bridge/scripts/figma-bridge.mjs eval "figma.root.name"
node ~/.agents/skills/figma-local-bridge/scripts/figma-bridge.mjs save-version -t "项目里程碑"
```

### 模式 B：项目内置脚本与设计规范生成器
如需在项目内沉淀独立构建能力，可将相关脚本复制进目标项目工程目录：
1. 复制 `scripts/server.mjs` 与 `scripts/figma-bridge.mjs` 至项目的脚本目录。
2. 使用 `build-figma-plugin.mjs` 打包项目专有的设计规范插件：
   ```bash
   node scripts/build-figma-plugin.mjs \
     --spec ./design/spec.json \
     --out ./docs/figma-plugin \
     --name "App Design Kit"
   ```

---

## 排障与常见问题

1. **服务启动报 EADDRINUSE 或端口被占用**：
   运行 `node scripts/figma-bridge.mjs restart`，脚本会自动检测占用端口的孤儿进程并执行安全终止。
2. **提示「Bridge 服务已就绪，但 Figma 桌面插件尚未连接」**：
   确认已在 Figma 桌面端中运行「Figma Local Bridge」插件窗口。关闭插件窗口会断开连接，重新运行插件会自动重连。
3. **eval 代码返回 undefined**：
   单行表达式会自动包装 `return (...)`；多行语句块请显式使用 `return <结果>`。

---

## 自动化测试与自证

运行全套模拟闭环测试（启动独立端口实例、模拟 WebSocket 客户端握手、校验 `/eval` 与 `/save-version`）：
```bash
node scripts/verify-figma-bridge.mjs
```
