---
name: web-service-conventions
description: 独立网站通用约定：子域划分、顶级入口预留（/admin 页面、/admin/api/v1 管理接口、/api/v1 业务接口、/healthz 探针）、版本号钉死与产物引用。触发：新建独立网站或子域；定 API 前缀与版本；加管理后台；服务从聚合仓拆分为独立站；健康检查与版本对齐。
---

# 独立网站通用约定（Web Service Conventions）

多站点（各独立子域）统一遵守，单站 AGENTS 不重复写，冲突时以本 skill 为准。源自 hotspot 网关与契约重构实战。

- 域名：每站独立子域，边缘网关按 Host 路由；产品仓不知道自己部署在哪，平台仓不写产品逻辑。
- 寻址：一律 IPv6-only——源站只监听/只暴露 IPv6，DNS 只建 AAAA 记录，禁止在任何记录、配置、文档中出现源站 IPv4。经 CF 代理的站点公开解析含 CF 共享 anycast IPv4 属预期（非源站地址，源站被 CF 隐藏）；切灰云直连（解析零 IPv4、源站 IPv6 公开、失去 mTLS 防线）需用户显式批准。
- 顶级入口（每个域名通用）：
  - `/admin/` 只给管理页面（SPA，网关回落静态，不反代后端）
  - `/admin/api/v1/` 管理 JSON API（独立限流、审计、IP 白名单）
  - `/api/v1/` 业务 API（匿名还是登录看 JWT，不看前缀；破坏性变更才升 v2）
  - `GET /healthz` 无鉴权存活探针（只回 status/version/commit/build_time；业务健康走业务接口）
- 版本：每站单 tag 序列，部署引用镜像 digest（服务器只 pull 不 build）；客户端 pin 死版本号，不调无版本号路径（健康/探针端点除外：`GET /healthz` 无版本前缀是全站统一探针口径，容器 healthcheck 与排障用的 `/health`、`/api/health` 等同类端点同样不受版本化约束——它们不进 OpenAPI 业务契约）。
- 前缀收敛：新服务只暴露 `/api/v1`，不再新增无版本号的 `/api/*`；存量旧别名由各仓自行收敛到 404（music_server 已收敛，media_server 仍处过渡期兼容，见其 AGENTS.md），收敛完成即删除兼容代码。
- 契约：OpenAPI 的 `servers[0].url` 必须匹配上述前缀；CI 加 grep 门禁禁止旧前缀回潮（参考 hotspot 的 contract-guard）。
- 默认地址：代码默认一律 localhost，生产域名只能构建期注入；源码 grep 到生产域名直接失败（文档示例除外）。
  已登记例外：纯客户端仓（media_app、music_app）在「用户未配置服务端地址」时允许回落内置生产默认地址（`https://media.chaoset.com/api/v1` / `https://music.chaoset.com/api/v1`），这是可用性回落而非部署耦合——服务端仓仍严守本条。
- 静态站网关的 SPA fallback 不得吞资源 404（2026-10-07 game.chaoset.com 实测）：`try_files $uri $uri/ /index.html` 类回退无条件生效时，缺失的 json/图片会返回 200 HTML，前端资源加载器（PixiJS Assets.load 等）拿到 HTML 解析失败，表现为启动挂死且 console 无错误（本地 dev/preview 尊重 Accept 头不复现，仅线上炸）。写法：资源扩展名走独立 location `try_files $uri =404`，fallback 只服务页面路由；用「静态 #boot 文字未移除 + 某请求长期 pending」定位。同一根域混合多个游戏/应用时，子路径应用用 `root`（非 alias：URI 首段=目录名，嵌套 location 可继承 root；alias 与 try_files 拼接是著名坑）+ 嵌套资源 404 location，根应用占 / 时子路径无尾斜杠 301。
- 本机有代理时，curl/浏览器「直连源站」的结论可能全是假的（2026-10-07 审计实战）：环境变量代理下 curl 走 CONNECT 隧道，看到的证书 issuer 是 Cloudflare 边缘证书（Google Trust Services）而非源站 Origin CA——所谓「绕过 CF 直连」实际测的是 CF。核对点：curl -v 出现「CONNECT tunnel」= 走了代理；真直连用 --noproxy '*'（或 openssl s_client 指定源站 IPv6）。另外服务器本机 curl 容器 ipvlan IPv6 必然 000（ipvlan 不允许宿主↔容器直通），不代表外部不通；源站 mTLS 闸的有效证据是直连握手出现 Request CERT 且 HTTP 层 400，与已知带闸站点行为对照。
