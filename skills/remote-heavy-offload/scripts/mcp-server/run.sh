#!/bin/sh
# 找到 node 并运行打包后的 MCP server（供 dsh-mcp-client 的 stdio command 使用）
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for n in "$HOME/.nvm/versions/node/"*/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$n" ]; then exec "$n" "$here/server.bundle.mjs" "$@"; fi
done
echo "remote-subagent mcp: node not found" >&2
exit 127
