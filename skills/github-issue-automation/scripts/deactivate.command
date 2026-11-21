#!/bin/bash
set -euo pipefail
label="com.chaoset.github-issue-agent"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
echo "已停止 $label"
