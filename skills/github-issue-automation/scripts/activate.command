#!/bin/bash
set -euo pipefail
label="com.chaoset.github-issue-agent"
uid="$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
if [ ! -f "$plist" ]; then
  echo "找不到 $plist"
  echo "请先运行: $HOME/.bun/bin/bun $HOME/.agents/skills/github-issue-automation/scripts/install-launchd.ts"
  exit 1
fi
launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
launchctl kickstart -k "gui/$uid/$label"
echo "已启动 $label"
echo "日志: $HOME/.agents/.state/github-issue-automation/launchd.out.log"
