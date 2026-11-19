# Figma Local Bridge

通用 Figma 桌面桥与设计规范自动化工作流。

## 目录结构

```text
figma-local-bridge/
├── SKILL.md                          # 技能规范与完整使用指南
├── README.md                         # 概览文档
├── plugin/                           # Figma 桌面插件（一次导入，全局复用）
│   ├── manifest.json                 # 插件清单（声明 networkAccess 与 ui: ui.html）
│   ├── ui.html                       # 插件 UI iframe（WebSocket 客户端与状态显示）
│   ├── code.js                       # 场景主线程脚本（Plugin API 执行与 IPC 转发）
│   └── README.md                     # 插件导入与使用说明
└── scripts/                          # 控制台脚本与通用工具
    ├── figma-bridge.mjs              # 一键自动化 CLI（支持 status/eval/save-version/start/stop）
    ├── server.mjs                    # Bun 本地服务守护进程
    ├── verify-figma-bridge.mjs       # 自动化协议冒烟测试
    ├── build-figma-plugin.mjs        # 通用设计规范打包器
    └── figma-runtime.js              # 运行时引擎（Token、变量、组件与画板构建）
```

## 快速开始

```bash
# 运行协议自检
node scripts/verify-figma-bridge.mjs

# 查看状态
node scripts/figma-bridge.mjs status
```
