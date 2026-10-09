# agents 配置仓库

AI 代理的用户级配置：全局指令 `AGENTS.md` 与全部用户级 skills（`skills/`，由 harness 按 Frontmatter 自动发现挂载）。

## 新主机 bootstrap

```bash
git clone <本仓库> ~/.agents
ln -s ~/.agents/AGENTS.md ~/AGENTS.md
```

注意：

- `skills/local-environment/` 记录的是单台主机的实测事实（路径、已装工具、凭据归档位置），换主机必须逐条重新核实改写；
- `~/work/dogod/cf_token_and_cert/` 等凭据目录**不在本仓库**，需按 `local-environment` 的描述在新主机单独重建；
- 项目级配置（各仓库的 `AGENTS.md` 与 `.agents/skills/`）随各项目仓库走，不在这里。
