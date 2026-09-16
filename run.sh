#!/usr/bin/env bash
# =============================================================
#  WARDOGS 投票站 —— Linux 服务器一键启停
#
#    ./run.sh start     后台启动（gunicorn，端口 8000）
#    ./run.sh stop      关闭
#    ./run.sh restart   重启
#    ./run.sh status    状态
#    ./run.sh logs      看日志
#    ./run.sh reset     清空投票
#
#  配置：把 SECRET_KEY / ADMIN_TOKEN / PORT 写进同目录的 .env 文件
# =============================================================
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"
VENV="$ROOT/.venv"
PIDFILE="$ROOT/.run.pid"
LOGFILE="$ROOT/server.log"

# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

PORT="${PORT:-8000}"
export SECRET_KEY="${SECRET_KEY:-$(hostname)-change-me}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-admin123}"
export PORT

ensure_venv() {
  if [ ! -x "$VENV/bin/python" ]; then
    echo "首次运行：创建虚拟环境并安装依赖…"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q flask gunicorn
  fi
}

running_pid() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    cat "$PIDFILE"; return 0
  fi
  return 1
}

health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; }

start() {
  if pid=$(running_pid); then
    echo "已经在运行 (PID $pid) → http://127.0.0.1:$PORT"; return
  fi
  ensure_venv
  nohup "$VENV/bin/gunicorn" \
      -w 1 -k gthread --threads 8 \
      -b "0.0.0.0:$PORT" \
      --access-logfile - --error-logfile - \
      app:app >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"

  for _ in $(seq 20); do
    sleep 0.3
    if out=$(health); then
      echo
      echo "  ✅ 已启动  PID $(cat "$PIDFILE")  端口 $PORT"
      echo "  本机     : http://127.0.0.1:$PORT"
      echo "  外网     : http://$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || echo '服务器IP'):$PORT"
      echo "  管理口令 : $ADMIN_TOKEN"
      echo "  健康检查 : $out"
      echo
      return
    fi
  done
  echo "❌ 启动失败，日志尾部："; tail -n 20 "$LOGFILE"; exit 1
}

stop() {
  if pid=$(running_pid); then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "🛑 已关闭 (PID $pid)"
  else
    rm -f "$PIDFILE"
    echo "没有在运行的服务。"
  fi
}

status() {
  if pid=$(running_pid); then
    echo "● 运行中  PID $pid  端口 $PORT  $(health || echo '（健康检查无响应）')"
  else
    echo "○ 未运行 —— 用 ./run.sh start 启动"
  fi
}

reset_votes() {
  read -r -p '确定清空所有投票？输入 yes 确认: ' ans
  [ "$ans" = "yes" ] || { echo '已取消。'; exit 0; }
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/admin/reset" \
       -H "X-Admin-Token: $ADMIN_TOKEN" && echo && echo "🧹 已清空"
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 0.5; start ;;
  status)  status ;;
  logs)    tail -n 50 -f "$LOGFILE" ;;
  reset)   reset_votes ;;
  *)       echo "用法: $0 {start|stop|restart|status|logs|reset}"; exit 1 ;;
esac
