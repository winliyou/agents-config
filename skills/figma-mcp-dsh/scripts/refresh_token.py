#!/usr/bin/env python3
"""从本机 Antigravity 的钥匙串凭据刷新 DSH 的 Figma 远程 MCP token。

背景：Figma 远程 MCP（https://mcp.figma.com/mcp）的 OAuth 动态注册只对 Figma
MCP catalog 内客户端开放（非 catalog 客户端 POST /v1/oauth/mcp/register 返回 403）。
Antigravity 通过 Figma 官方插件持有合法 OAuth token，存于 macOS 钥匙串：
  service=antigravity.plugins, account=<userid>/mcp-oauth:figma:https://mcp.figma.com/mcp
值格式 go-keyring-base64:<base64 JSON>，JSON 内含 client_id/client_secret/token
（token.access_token / refresh_token / expiry）。

本脚本只读钥匙串、不修改 Antigravity 的数据；把 access_token 写入 DSH 凭据库
~/.dsh/.credentials.yaml 的 refs.FIGMA_MCP_ACCESS_TOKEN，供 dsh-mcp-client 以
${credential:FIGMA_MCP_ACCESS_TOKEN} 引用（配合 expandTemplates: true）。

用法：
  python3 refresh_token.py            # 重新提取并写入
  python3 refresh_token.py --check    # 只检查当前 keychain token 的到期时间，不写入
"""
import base64
import json
import os
import re
import subprocess
import sys

SERVICE = "antigravity.plugins"
ACCOUNT_PATTERN = r'"acct"<blob>="([^"]*mcp-oauth:figma:[^"]*)"'
CRED = os.path.expanduser("~/.dsh/.credentials.yaml")
KEY = "FIGMA_MCP_ACCESS_TOKEN"


def find_account():
    try:
        out = subprocess.run(["security", "dump-keychain"], capture_output=True, text=True).stdout
        m = re.search(ACCOUNT_PATTERN, out)
        if m:
            return m.group(1)
    except Exception:
        pass
    sys.exit("未在钥匙串中找到 Antigravity 的 Figma MCP 凭据；先在 Antigravity 里连接 Figma")


def read_secret(account):
    r = subprocess.run(
        ["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit("keychain 读取失败（可能需要在系统弹窗里允许 security 访问）：" + r.stderr.strip())
    raw = r.stdout.strip().encode()
    if not raw.startswith(b"go-keyring-base64:"):
        sys.exit("未知的钥匙串值格式：" + raw[:20].decode(errors="replace"))
    return json.loads(base64.b64decode(raw[len(b"go-keyring-base64:"):]))


def update_credentials(token):
    if not os.path.exists(CRED):
        sys.exit("找不到 DSH 凭据文件：" + CRED)
    lines = open(CRED).read().splitlines()
    try:
        idx = next(i for i, l in enumerate(lines) if l.strip() == "refs:")
    except StopIteration:
        sys.exit("凭据文件缺少 refs: 节")
    out = lines[: idx + 1]
    entries = []
    for l in lines[idx + 1:]:
        s = l.strip()
        if not s or s in ("{", "}"):
            continue  # 兼容旧的非标准 flow 写法
        m = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", s)
        if m:
            entries.append((m.group(1), m.group(2)))
    entries = [(k, v) for k, v in entries if k != KEY]
    entries.append((KEY, token))
    open(CRED, "w").write("\n".join(out + [f"  {k}: {v}" for k, v in entries]) + "\n")
    os.chmod(CRED, 0o600)


def main():
    account = find_account()
    data = read_secret(account)
    tok = data.get("token") or {}
    access = tok.get("access_token")
    if not access:
        sys.exit("凭据里没有 access_token")
    expiry = tok.get("expiry", "unknown")
    if "--check" in sys.argv:
        print(f"Antigravity 账目: {account}")
        print(f"access_token 长度: {len(access)}，到期: {expiry}")
        return
    update_credentials(access)
    print(f"已更新 {CRED} 的 {KEY}")
    print(f"access_token 到期: {expiry}")
    print("DSH web profile 有 HMR：凭据变更会触发 MCP 客户端重连；若工具未刷新，重载配置或重启 dsh web。")
    print("验证：调用 mcp__figma_remote__whoami")


if __name__ == "__main__":
    main()
