#!/usr/bin/env bash
# offload.sh — 把重负载任务放到远程 dsh 主机执行（macOS 只留隧道/浏览器/终端）
# 主机事实见 local-environment skill；可用 OFFLOAD_* 环境变量覆盖。
# 用法: offload.sh help

set -uo pipefail

HOST="${OFFLOAD_HOST:-dsh-arch}"
LOCAL_PORT="${OFFLOAD_LOCAL_PORT:-18765}"
REMOTE_PORT="${OFFLOAD_REMOTE_PORT:-8765}"
REMOTE_WS="${OFFLOAD_REMOTE_WORKSPACE:-/home/liyou/workspace}"
DSH="${OFFLOAD_DSH:-/home/liyou/.local/bin/dsh}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/dsh-offload"
PIDFILE="$CACHE/tunnel.pid"
SESSION_DIR="$CACHE/sessions"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST")

die() { echo "offload: $*" >&2; exit 1; }
tunnel_up() { lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; }

cmd_status() {
  "${SSH[@]}" '
    echo "== host =="; uname -sr; nproc
    echo "== load =="; uptime
    echo "== mem =="; free -h | head -2
    echo "== disk =="; df -h / | tail -1
    echo "== service =="; systemctl --user is-active dsh-web 2>/dev/null; systemctl --user is-enabled dsh-web 2>/dev/null
    echo "== listen =="; ss -tln 2>/dev/null | grep ":8765" | head -2
    echo "== tmux/进程 =="; tmux ls 2>/dev/null | head -5; pgrep -af "dsh headless|bun |gradle" 2>/dev/null | head -5
  '
}

cmd_tunnel() {
  local action="${1:-start}"
  if [ "$action" = "--stop" ] || [ "$action" = "stop" ]; then
    if [ -f "$PIDFILE" ]; then
      local pid; pid=$(cat "$PIDFILE")
      if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null && echo "tunnel stopped (pid $pid)"; else echo "tunnel pid $pid 已不存在"; fi
      rm -f "$PIDFILE"
    else
      echo "no tunnel pid file"
    fi
    return 0
  fi
  if tunnel_up; then echo "tunnel already up on 127.0.0.1:$LOCAL_PORT"; return 0; fi
  mkdir -p "$CACHE"
  nohup ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$HOST" >"$CACHE/tunnel.log" 2>&1 &
  echo $! > "$PIDFILE"
  local i
  for i in $(seq 1 40); do
    tunnel_up && { echo "tunnel up on 127.0.0.1:$LOCAL_PORT (pid $(cat "$PIDFILE"))"; return 0; }
    sleep 0.25
  done
  die "tunnel 启动失败，见 $CACHE/tunnel.log"
}

cmd_url() {
  local mask="${1:-}" url
  url=$("${SSH[@]}" "journalctl --user -u dsh-web -o cat --no-pager 2>/dev/null | grep -oE 'http://127\\.0\\.0\\.1:8765/\\?token=[^[:space:]]+' | tail -1" 2>/dev/null)
  [ -n "$url" ] || die "未取到 token URL（服务 active？systemctl --user status dsh-web）"
  url=${url/127.0.0.1:$REMOTE_PORT/127.0.0.1:$LOCAL_PORT}
  if [ "$mask" = "--mask" ]; then
    echo "URL 已生成（含凭据，未打印）：http://127.0.0.1:$LOCAL_PORT/?token=<REDACTED>（长度 $(printf %s "$url" | wc -c | tr -d ' ')）"
  else
    echo "$url"
    echo "# 含一次性 token：只在本机浏览器用，勿粘贴到文档/聊天/日志" >&2
  fi
}

cmd_web() {
  cmd_tunnel start >/dev/null
  local url; url=$(cmd_url 2>/dev/null)
  [ -n "$url" ] || die "未取到 URL"
  if command -v open >/dev/null 2>&1; then open "$url" && echo "已用默认浏览器打开（URL 含 token，未重复打印）"; else echo "$url"; fi
}

cmd_sync() {
  local src="" dst="" clean=0 extra=() args=("$@") i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --clean) clean=1 ;;
      --exclude) i=$((i+1)); extra+=(--exclude "${args[$i]}") ;;
      *) if [ -z "$src" ]; then src="${args[$i]}"; else dst="${args[$i]}"; fi ;;
    esac
    i=$((i+1))
  done
  [ -n "$src" ] || die "用法: offload.sh sync <本地目录> [远端子目录] [--clean] [--exclude PATTERN]"
  src=$(cd "$src" && pwd) || die "目录不存在: $src"
  local name target
  name="${dst:-$(basename "$src")}"
  target="$REMOTE_WS/$name"
  [ "$clean" = 1 ] && "${SSH[@]}" "rm -rf '$target'"
  echo "sync $src -> $HOST:$target"
  COPYFILE_DISABLE=1 tar -C "$src" -cf - \
    --exclude './node_modules' --exclude './.gradle' --exclude './build' --exclude './target' \
    --exclude './dist' --exclude './.next' --exclude './.venv' --exclude './venv' \
    --exclude './.DS_Store' --exclude './.workwork' --exclude './.worktrees' \
    --exclude './.agents/worktrees' \
    --exclude '*/node_modules' --exclude '*/.workwork' --exclude '*/.worktrees' \
    --exclude '*/.agents/worktrees' \
    --exclude '*/dist' --exclude '*/build' --exclude '*/target' ${extra[@]+"${extra[@]}"} . 2>/dev/null | \
    "${SSH[@]}" "mkdir -p '$target' && tar -C '$target' -xf -" || die "sync 失败"
  "${SSH[@]}" "cd '$target' && printf 'remote: '; du -sh . | cut -f1; git rev-parse --short HEAD 2>/dev/null || echo 'git: none'"
}

cmd_pull() {
  local sub="" dest="" clean=0 args=("$@") i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --clean) clean=1 ;;
      *) if [ -z "$sub" ]; then sub="${args[$i]}"; else dest="${args[$i]}"; fi ;;
    esac
    i=$((i+1))
  done
  [ -n "$sub" ] && [ -n "$dest" ] || die "用法: offload.sh pull <远端子目录> <本地目录> [--clean]"
  local target="$REMOTE_WS/$sub"
  mkdir -p "$dest"
  if [ "$clean" = 1 ]; then
    [ "$dest" != "/" ] || die "拒绝清理 /"
    find "$dest" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi
  echo "pull $HOST:$target -> $dest"
  "${SSH[@]}" "cd '$target' && tar -cf - \
    --exclude='./node_modules' --exclude='./.gradle' --exclude='./build' --exclude='./target' \
    --exclude='./dist' --exclude='./.next' --exclude='./.venv' --exclude='./venv' ." 2>/dev/null | \
    tar -C "$dest" -xf - || die "pull 失败"
  echo "pulled -> $dest"
}

cmd_run() {
  local dir="." args=("$@") i=0 cmd_args=()
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --dir) i=$((i+1)); dir="${args[$i]}" ;;
      --) i=$((i+1)); while [ $i -lt ${#args[@]} ]; do cmd_args+=("${args[$i]}"); i=$((i+1)); done; break ;;
      *) die "用法: offload.sh run [--dir 子目录] -- <命令...>" ;;
    esac
    i=$((i+1))
  done
  [ ${#cmd_args[@]} -gt 0 ] || die "用法: offload.sh run [--dir 子目录] -- <命令...>"
  local cmd_str="${cmd_args[*]}" b64
  b64=$(printf %s "$cmd_str" | base64 | tr -d '\n')
  "${SSH[@]}" "cd '$REMOTE_WS/$dir' || exit 2; exec bash -c \"\$(printf %s '$b64' | base64 -d)\""
}

cmd_headless() {
  [ $# -ge 1 ] || die "用法: offload.sh headless '<任务描述>'"
  local task="$1" b64
  b64=$(printf %s "$task" | base64 | tr -d '\n')
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "cd '$REMOTE_WS' || exit 2; TASK=\$(printf %s '$b64' | base64 -d); exec '$DSH' headless \"\$TASK\""
}

_sha() { printf '%s' "$1" | shasum 2>/dev/null | cut -c1-12 || printf '%s' "$1" | md5 -q 2>/dev/null | cut -c1-12; }

# 在远端跑一个 headless turn（多轮续接的核心）：$1=工作区子目录 $2=sessionId（可空） $3=消息 $4=事件输出文件 $5=sessionId 输出文件
_send_turn() {
  local dir="$1" sid="$2" msg="$3" out="$4" sidfile="$5" b64 sid_arg=""
  b64=$(printf %s "$msg" | base64 | tr -d '\n')
  [ -n "$sid" ] && sid_arg="--session-id '$sid'"
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "cd '$REMOTE_WS/$dir' || exit 2; exec '$DSH' headless --json $sid_arg \"\$(printf %s '$b64' | base64 -d)\"" > "$out" 2>"$out.err"
  local rc=$?
  python3 - "$out" "$rc" "$sidfile" <<'PY'
import json, os, sys
out, rc, sidfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sid = None
final = None
for line in open(out, encoding='utf-8', errors='replace'):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    if ev.get('type') == 'session' and ev.get('sessionId'):
        sid = ev['sessionId']
    if ev.get('type') == 'final':
        final = ev.get('text', '')
if final is None:
    err = out + '.err'
    if os.path.exists(err):
        sys.stderr.write(open(err, encoding='utf-8', errors='replace').read()[-2000:])
    sys.exit(rc or 1)
if sid:
    open(sidfile, 'w').write(sid + '\n')
print(final)
PY
}

_save_meta() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys, time
meta, name, dir_, sid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
json.dump({'name': name, 'dir': dir_, 'sessionId': sid, 'updated': time.strftime('%Y-%m-%dT%H:%M:%S')}, open(meta, 'w'), ensure_ascii=False, indent=1)
PY
}

# 续接同一会话发一条消息：offload.sh ask [--name N] [--dir 子目录] [--new] -- '<消息>'
cmd_ask() {
  local name="default" dir="." new=0 msg="" args=("$@") i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --name) i=$((i+1)); name="${args[$i]}" ;;
      --dir) i=$((i+1)); dir="${args[$i]}" ;;
      --new) new=1 ;;
      --) i=$((i+1)); while [ $i -lt ${#args[@]} ]; do msg="$msg ${args[$i]}"; i=$((i+1)); done; break ;;
      *) msg="$msg ${args[$i]}" ;;
    esac
    i=$((i+1))
  done
  msg="${msg# }"
  [ -n "$msg" ] || die "用法: offload.sh ask [--name 名称] [--dir 子目录] [--new] -- <消息>"
  mkdir -p "$SESSION_DIR"
  local key; key=$(_sha "$dir|$name")
  local meta="$SESSION_DIR/$key.json" sid=""
  [ "$new" = 1 ] && rm -f "$meta"
  if [ "$new" = 0 ] && [ -f "$meta" ]; then
    sid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sessionId",""))' "$meta" 2>/dev/null)
  fi
  local out="$CACHE/last-turn.jsonl" sidfile="$CACHE/last-sid.txt" reply rc
  reply=$(_send_turn "$dir" "$sid" "$msg" "$out" "$sidfile"); rc=$?
  [ "$rc" = 0 ] || die "远端 turn 失败 (rc=$rc)"
  sid=$(cat "$sidfile" 2>/dev/null)
  [ -n "$sid" ] && _save_meta "$meta" "$name" "$dir" "$sid"
  printf '%s\n' "$reply"
}

# 交互式多轮对话：offload.sh chat [--name N] [--dir 子目录]
cmd_chat() {
  local name="default" dir="." new=0 args=("$@") i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --name) i=$((i+1)); name="${args[$i]}" ;;
      --dir) i=$((i+1)); dir="${args[$i]}" ;;
      --new) new=1 ;;
      *) die "用法: offload.sh chat [--name 名称] [--dir 子目录] [--new]" ;;
    esac
    i=$((i+1))
  done
  mkdir -p "$SESSION_DIR"
  local key; key=$(_sha "$dir|$name")
  local meta="$SESSION_DIR/$key.json" sid=""
  [ "$new" = 1 ] && rm -f "$meta"
  [ -f "$meta" ] && sid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sessionId",""))' "$meta" 2>/dev/null)
  echo "offload chat — 目录: $dir 会话: $name（/new 新会话，/exit 退出，Ctrl-D 退出）"
  local line out="$CACHE/last-turn.jsonl" sidfile="$CACHE/last-sid.txt" reply rc
  while true; do
    if [ -n "$sid" ]; then printf 'you> '; else printf 'you(new)> '; fi
    IFS= read -r line || break
    [ -z "$line" ] && continue
    case "$line" in
      /exit|/quit) break ;;
      /new) rm -f "$meta"; sid=""; echo "(新会话)"; continue ;;
    esac
    reply=$(_send_turn "$dir" "$sid" "$line" "$out" "$sidfile"); rc=$?
    if [ "$rc" != 0 ]; then echo "offload: turn 失败 (rc=$rc)" >&2; continue; fi
    sid=$(cat "$sidfile" 2>/dev/null)
    [ -n "$sid" ] && _save_meta "$meta" "$name" "$dir" "$sid"
    printf 'dsh> %s\n\n' "$reply"
  done
}

# 列出已保存的会话
cmd_sessions() {
  [ -d "$SESSION_DIR" ] || { echo "no sessions"; return 0; }
  python3 - "$SESSION_DIR" <<'PY'
import glob, json, os, sys
for f in sorted(glob.glob(os.path.join(sys.argv[1], '*.json'))):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    print('%s\t%s\t%s\t%s' % (d.get('updated', ''), d.get('name', ''), d.get('dir', ''), d.get('sessionId', '')))
PY
}

cmd_help() {
  cat <<'EOF'
offload.sh — 把重负载任务放到远程 dsh 主机执行（macOS 只留隧道/浏览器/终端）

用法: offload.sh <子命令> [参数]

子命令:
  status                    远端负载/内存/磁盘/服务/端口
  tunnel [--stop]           起/停 ssh 隧道（复用 pid 文件）
  url [--mask]              打印最新 token URL（改写到本地端口；--mask 不打印凭据）
  web                       起隧道并打开浏览器
  sync <本地目录> [远端子目录] [--clean] [--exclude PATTERN]
  pull <远端子目录> <本地目录> [--clean]
  run [--dir 子目录] -- <命令...>
  headless '<任务描述>'      远端 dsh headless 跑一次性任务（新会话）
  ask [--name N] [--dir 子目录] [--new] -- <消息>  续接同一会话发一条消息
  chat [--name N] [--dir 子目录]   交互式多轮对话（/new 新会话，/exit 退出）
  sessions                  列出本机保存的远端会话
  help                      显示本帮助
EOF
}

case "${1:-help}" in
  status) cmd_status ;;
  tunnel) shift; cmd_tunnel "${1:-}" ;;
  url) shift; cmd_url "${1:-}" ;;
  web) cmd_web ;;
  sync) shift; cmd_sync "$@" ;;
  pull) shift; cmd_pull "$@" ;;
  run) shift; cmd_run "$@" ;;
  headless) shift; cmd_headless "$@" ;;
  ask) shift; cmd_ask "$@" ;;
  chat) shift; cmd_chat "$@" ;;
  sessions) cmd_sessions ;;
  help|-h|--help) cmd_help ;;
  *) die "未知子命令: ${1:-}（用 offload.sh help）" ;;
esac
