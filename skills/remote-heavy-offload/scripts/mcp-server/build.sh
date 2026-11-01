#!/usr/bin/env bash
# 重新打包 server.bundle.mjs（修改 server.mjs 后运行；依赖 bun）
set -euo pipefail
cd "$(dirname "$0")"
BUN=$(command -v bun || true)
[ -n "$BUN" ] || { echo "需要 bun 来打包" >&2; exit 1; }
if [ ! -d node_modules ]; then
  echo "首次构建：安装打包依赖..."
  npm install --no-audit --no-fund
fi
"$BUN" build server.mjs --target node --format esm --outfile server.bundle.mjs
echo "built server.bundle.mjs ($(wc -c < server.bundle.mjs) bytes)"
