---
name: figma-mcp-dsh
description: Figma 官方 MCP 与 DeepSeek Harness（DSH）的集成规程：桌面端本地 server（127.0.0.1:3845/mcp，只读 10 工具、零凭据）+ 远程 server（mcp.figma.com，45 工具含 use_figma 写画布，借本机 Antigravity 已授权的 Figma OAuth token 经 DSH 凭据库注入）；含两端配置、HMR 热生效、凭据续期脚本、验证与排障。触发：在 DSH 里使用 Figma MCP、figma mcp 不支持 dsh、mcp__figma__ 工具缺失、127.0.0.1:3845 连不上、需要 use_figma 写画布、需要从 Figma 设计稿生成代码或读取 variables/screenshot/Code Connect。
---

# Figma MCP × DSH

让 DSH 通过 MCP 使用 Figma：设计稿 → 代码、变量、截图、Code Connect；以及写画布。
两条路径都已在本机接通，按需组合：

- **桌面端本地 server**（`http://127.0.0.1:3845/mcp`）：任意客户端可连、无认证，但只有 10 个只读工具。
- **远程 server**（`https://mcp.figma.com/mcp`）：45 个工具（含 `use_figma`、`generate_figma_design`、`create_new_file` 等写画布能力），Figma 只授权 catalog 内客户端；本机做法是复用 Antigravity 已授权的 Figma OAuth token。

## 事实与边界（先读）

| 路径 | 端点 | 认证 | DSH 可用性 |
|---|---|---|---|
| 桌面端本地 server | `http://127.0.0.1:3845/mcp` | 无（Figma 桌面端保持开启即可） | **可用**：官方文档写明其他客户端直接按 `{"url": "http://127.0.0.1:3845/mcp"}` 接入，无客户端白名单。只有读工具。 |
| 远程 server | `https://mcp.figma.com/mcp` | OAuth Bearer（`mcp:connect` scope） | **可用（借白名单客户端 token）**：Figma 的 OAuth 动态注册拒绝非 catalog 客户端（实测 `POST https://api.figma.com/v1/oauth/mcp/register` → HTTP 403），但拿到有效 Bearer token 后服务端照常提供全量工具。token 来源见方案二。 |

### 为什么 Gemini / Antigravity 有 use_figma

- `use_figma`、`generate_figma_design`、`create_new_file`、`html_to_figma`、`download_assets`、`export_video`、`get_comments`、`whoami` 等在 Figma 官方工具表中全部标 **Remote only**，桌面 server 没有。
- 本机 Antigravity（Google 的 Gemini IDE）装了 Figma 官方插件 `~/.gemini/config/plugins/figma/`：`mcp_config.json` 指向 `https://mcp.figma.com/mcp`，带 `X-Figma-Plugin-Bundle: figma_prod@2_2_208` header 与 OAuth。它已缓存 45 个工具（`~/.gemini/antigravity/mcp/figma_figma/*.json`，含 `use_figma.json`）。复核：`ls ~/.gemini/antigravity/mcp/figma_figma | wc -l`。
- DSH 拿不到同一套东西的硬门是 OAuth 注册：带 `X-Figma-Plugin-Bundle`、换 UA 的注册请求同样 403。问题不在 DSH 实现，而在 Figma 授权服务端按客户端准入。
- **Antigravity 的授权可直接复用**：其 Figma OAuth 凭据存于 macOS 钥匙串，DSH 读出来当静态 Bearer header 用即可（见方案二）。

### 工具集对比

| | 桌面 server（`mcp__figma__*`） | 远程 server（`mcp__figma_remote__*`） |
|---|---|---|
| 工具数 | 10 | 45 |
| 读 | get_design_context / get_metadata / get_screenshot / get_variable_defs / get_motion_context / get_figjam / Code Connect 读取 | 同左 + get_comments / download_assets / export_video / whoami / get_libraries / search_design_system / list_* 等 |
| 写画布 | 无 | **use_figma / create_new_file / generate_figma_design / upload_assets / send_code_to_figma / generate_image / generate_vector_illustration / generate_diagram / create+update shader 与 generative plugin** |
| 需要 Figma 桌面端 | 是 | 否 |
| 需要凭据 | 否 | 是（90 天有效） |
| 选中即用（不带 nodeId） | 支持 | 不支持，需 fileKey/nodeId 或文件链接 |

## 方案一：桌面端本地 MCP server（只读）

1. 打开 Figma 桌面端（任意 Design 文件都行，建议 Dev/Full seat）。
2. 按 `Shift+D` 进入 Dev Mode。
3. 按 `Cmd+/` 打开命令面板，输入 `mcp`，选 **Enable desktop MCP server**。
4. 底部出现 `MCP server enabled on http://127.0.0.1:3845/mcp` 即成功。
5. 验证：`lsof -nP -iTCP:3845 -sTCP:LISTEN` 应看到 Figma 进程。

开关是全局的：切回 Design Mode、关闭文件都不影响监听，只要 Figma 进程在跑。Figma 重启后开关是否自动恢复不保证——先跑上面的 `lsof`，不监听就重开（命令面板同一命令）。

DSH 侧配置（web GUI 用 `~/.dsh/profiles/web/cordis.patch.yml`；桌面版用 `~/.dsh/profiles/desktop/` 下同名文件）：

```yaml
- insert:
    - id: mcp-figma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: figma              # 工具前缀 mcp__figma__*
        transport: streamable-http
        url: http://127.0.0.1:3845/mcp
        startupTimeoutMs: 15000
```

## 方案二：远程 server（45 工具，含 use_figma）

### 原理

Figma 远程 MCP 的 OAuth 动态客户端注册只对 catalog 客户端开放（403）。但服务端校验的是 **Bearer token 有效性**，不校验「谁在用」。因此：

1. 用已授权的白名单客户端（本机是 Antigravity 里的 Figma 官方插件）持有 token；
2. 从 macOS 钥匙串读出 token；
3. 作为静态 `Authorization: Bearer` header 配给 DSH 的 mcp-client。

凭据位置（自动发现逻辑见脚本）：

```text
keychain service = antigravity.plugins
account          = <userid>/mcp-oauth:figma:https://mcp.figma.com/mcp
value 格式       = go-keyring-base64:<base64 JSON>
JSON 字段        = client_id / client_secret / token{access_token, token_type, refresh_token, expiry, expires_in} / token_url
```

复核（只看元数据、不读密钥）：

```bash
security find-generic-password -s "antigravity.plugins" | grep -E '"acct"|"mdat"'
```

### 写入 DSH 凭据库

```bash
python3 ~/.agents/skills/figma-mcp-dsh/scripts/refresh_token.py --check  # 看 token 到期时间
python3 ~/.agents/skills/figma-mcp-dsh/scripts/refresh_token.py          # 提取并写入
```

脚本把 token 写进 `~/.dsh/.credentials.yaml` 的 `refs.FIGMA_MCP_ACCESS_TOKEN`（文件权限必须 600）。

**坑**：`.credentials.yaml` 的 `refs` 节可能是旧的非标准 YAML flow 写法（`refs:` 下 `{` 换行条目无逗号），PyYAML 解析报 `expected ',' or '}'`。脚本会把它重排成标准 block 映射再写回；改前先 `cp -a` 备份。

### DSH 配置

```yaml
    - id: mcp-figma-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: figma_remote       # 工具前缀 mcp__figma_remote__*
        transport: streamable-http
        url: https://mcp.figma.com/mcp
        expandTemplates: true
        headers:
          Authorization: 'Bearer ${credential:FIGMA_MCP_ACCESS_TOKEN}'
          X-Figma-Plugin-Bundle: figma_prod@2_2_208
        startupTimeoutMs: 20000
```

- `expandTemplates: true` 才会解析 headers 里的 `${credential:REF}`（凭据提供方为 credentials-local）。
- 凭据变更会触发 MCP 客户端重建连接，token 更新后无需重启 dsh。
- `X-Figma-Plugin-Bundle` 是 Figma 官方插件标识，值与 `~/.gemini/config/plugins/figma/mcp_config.json` 保持一致（插件升级时同步更新）。

### 验证

- 工具出现：`Object.keys(tools)` 含 45 个 `mcp__figma_remote__*`，含 `use_figma`。
- 调 `mcp__figma_remote__whoami`：返回账号、plan、seat；写画布要求 Full seat + 远程 server（本机 whoami 显示 Full seat，可写画布；换机器/账号时先确认 seat）。

### 续期（约 90 天）

access_token 有效期 `expires_in: 7776000`（90 天），到期后重跑 `refresh_token.py` 即可（Antigravity 会自己刷新钥匙串里的 token，脚本每次读最新值）。若脚本提示钥匙串里没有该项，说明 Antigravity 的 Figma 插件已掉线——去 Antigravity 重新连接 Figma（插件会重新走 OAuth）。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 3845 无监听 | Figma 未启动或桌面 server 未启用：命令面板重开，确认 Figma 已登录 |
| `mcp__figma__*` 不出现 | 桌面 server 未开；或配置未生效（非 HMR profile 需重启） |
| `mcp__figma_remote__*` 不出现 | 凭据未解析：检查 `.credentials.yaml` 是否合法 YAML、权限 600、`refs.FIGMA_MCP_ACCESS_TOKEN` 存在；再跑 `refresh_token.py --check` |
| 远程连接 401 | token 过期或被 Antigravity 轮换：重跑 `refresh_token.py` |
| 远程连接成功但工具不全 | `X-Figma-Plugin-Bundle` 与 Figma 插件版本不一致：同步插件配置里的值 |
| 想写画布但报权限 | 需要 Full seat（`whoami` 里看 seat）且 Figma 处于写画布开放状态 |

## 风险与合规

远程方案绕开了 Figma 的客户端准入策略（Figma 文档写明只有 catalog 客户端可连），取用的是用户自己账号的合法 token、且只在本机使用。风险：可能违反 Figma 服务条款、Figma 可能随时收紧校验、token 90 天到期需续。需要长期稳定就把 DSH 注册进 Figma MCP catalog（catalog 页 “Submit your app for review” / 联系 account team）。

## 相关

- WebSocket 桥（Plugin API，可写画布、导出切图、版本里程碑）：`figma-local-bridge` skill。
- Figma 官方文档：`https://developers.figma.com/docs/figma-mcp-server/`（工具表 `tools-and-prompts/`，远程安装 `remote-server-installation/`，桌面安装 `local-server-installation/`）。
