#!/usr/bin/env bash
# run-turn.sh — 在远端后台跑一个 headless turn（供 remote-subagent MCP 调用）
# 用法: run-turn.sh <jobdir> <workdir> <dsh-bin> <session-id|-> <turn>
set -euo pipefail
JOB="$1"; WS="$2"; DSH="$3"; SID="$4"; TURN="$5"
mkdir -p "$JOB"
TASKF="$JOB/task-$TURN.txt"
LOG="$JOB/run-$TURN.log"
EXITF="$JOB/exit-$TURN"
PIDF="$JOB/pid-$TURN"
rm -f "$EXITF" "$PIDF"
: > "$LOG"
if [ "$SID" = "-" ]; then
  setsid bash -c 'cd "$0" || exit 3; "$1" headless --json - < "$2" > "$3" 2>&1; echo $? > "$4"' "$WS" "$DSH" "$TASKF" "$LOG" "$EXITF" >/dev/null 2>&1 &
else
  setsid bash -c 'cd "$0" || exit 3; "$1" headless --json --session-id "$2" - < "$3" > "$4" 2>&1; echo $? > "$5"' "$WS" "$DSH" "$SID" "$TASKF" "$LOG" "$EXITF" >/dev/null 2>&1 &
fi
echo $! > "$PIDF"
echo "$TURN" > "$JOB/turn"
