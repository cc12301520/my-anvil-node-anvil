# syntax=docker/dockerfile:1
FROM ubuntu:22.04

# 原版基础环境；Node.js 在下一步安装受 ethers v6 支持的现代版本。
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl git xz-utils sudo netcat-openbsd gnupg \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 22.04 默认 Node.js 版本过旧，无法解析 ethers v6 的私有方法语法。
# 固定使用 Node.js 20，并在构建期验证主版本，避免部署后保护器反复退出。
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs \
    && node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' \
    && node --version \
    && npm --version \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup

RUN curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
      | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
      | tee /etc/apt/sources.list.d/ngrok.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ngrok \
    && rm -rf /var/lib/apt/lists/*

# Render 内只安装一份保护器及其 ethers 依赖。
RUN mkdir -p /opt/node-monitor/data \
    && npm install --prefix /opt/node-monitor --omit=dev ethers@6
# GitHub 部署时 Dockerfile 与 JS 都放在仓库根目录。
COPY node-monitor-session.js /opt/node-monitor/node-monitor-session.js

EXPOSE 8545
EXPOSE 3000

RUN <<'DOCKER_BUILD_EOF'
cat > /start.sh <<'START_SCRIPT_EOF'
#!/bin/bash
# 每个组件只有一个管理循环；单个上游失败不退出容器。
DATA_DIR="/opt/node-monitor/data"
ANVIL_GENERATION_FILE="$DATA_DIR/anvil-generation"
SESSION_READY_FILE="$DATA_DIR/session-ready"
RESTART_REQUEST_FILE="$DATA_DIR/anvil-restart-request"
FATAL_FILE="$DATA_DIR/fatal-error"
ANVIL_PID=""
NGROK_PID=""
ANVIL_MANAGER_PID=""
MONITOR_MANAGER_PID=""
RPC_BLACKLIST_SECONDS=1800
ANVIL_STARTUP_TIMEOUT=120

mkdir -p "$DATA_DIR"
rm -f "$SESSION_READY_FILE" "$RESTART_REQUEST_FILE" "$FATAL_FILE" "$DATA_DIR/worker-heartbeat"
if [ -z "${NGROK_AUTHTOKEN:-}" ]; then
  echo "[Fatal] NGROK_AUTHTOKEN is not configured"
  exit 2
fi

RPC_POOL=(
  "https://ethereum-rpc.publicnode.com"
  "https://ethereum.publicnode.com"
  "https://rpc.flashbots.net"
  "https://rpc.payload.de"
  "https://ethereum.drpc.org"
  "https://rpc.ankr.com/eth"
  "https://ethereum.blockpi.network/v1/rpc/public"
  "https://rpc.builder0x69.io"
  "https://1rpc.io/eth"
  "https://eth.meowrpc.com"
  "https://rpc.gateway.fm/v1/ethereum/mainnet"
  "https://eth-mainnet.public.blastapi.io"
  "https://eth.llamarpc.com"
  "https://cloudflare-eth.com"
)
SHUFFLED_POOL=()
while IFS= read -r rpc; do SHUFFLED_POOL+=("$rpc"); done < <(
  for rpc in "${RPC_POOL[@]}"; do printf '%s %s\n' "$RANDOM" "$rpc"; done | sort -n | cut -d' ' -f2-
)
RPC_POOL=("${SHUFFLED_POOL[@]}")

beat() {
  printf '%s %s\n' "$(date +%s)" "${BASHPID:-$$}" > "$DATA_DIR/$1.tmp"
  mv "$DATA_DIR/$1.tmp" "$DATA_DIR/$1"
}

manager_sleep() {
  local remaining="$1" heartbeat="$2" step
  while [ "$remaining" -gt 0 ]; do
    beat "$heartbeat"
    step=5
    [ "$remaining" -lt "$step" ] && step="$remaining"
    sleep "$step"
    remaining=$((remaining-step))
  done
  beat "$heartbeat"
}

stop_pid() {
  local target_pid="$1" attempt
  [ -z "$target_pid" ] && return
  kill -TERM "$target_pid" 2>/dev/null || true
  for attempt in {1..12}; do
    kill -0 "$target_pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "$target_pid" 2>/dev/null || true
  wait "$target_pid" 2>/dev/null || true
}

shutdown_all() {
  trap '' TERM INT
  echo "[Shutdown] Releasing endpoint, saving Session, stopping Anvil"
  rm -f "$SESSION_READY_FILE"
  stop_pid "$NGROK_PID"
  stop_pid "$MONITOR_MANAGER_PID"
  stop_pid "$ANVIL_MANAGER_PID"
  exit 0
}
trap shutdown_all TERM INT

rpc_cache_file() {
  local key
  key=$(printf '%s' "$1" | md5sum | cut -d' ' -f1)
  printf '%s/bad-rpc-%s' "$DATA_DIR" "$key"
}
is_rpc_blacklisted() {
  local file last now
  file=$(rpc_cache_file "$1")
  [ -f "$file" ] || return 1
  last=$(cat "$file"); now=$(date +%s)
  [ $((now-last)) -lt "$RPC_BLACKLIST_SECONDS" ]
}
mark_rpc_bad() {
  [ -n "$1" ] && date +%s > "$(rpc_cache_file "$1")"
}

rpc_probe() {
  local url="$1" method="$2" params="$3" timeout="$4" response
  response=$(curl -fsS --max-time "$timeout" -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" "$url" 2>/dev/null) || return 1
  printf '%s' "$response" | node -e '
    let s=""; process.stdin.on("data", x => s+=x);
    process.stdin.on("end", () => { try {
      const r=JSON.parse(s); process.exit(!r.error && /^0x[0-9a-f]+$/i.test(r.result) ? 0 : 1);
    } catch (_) { process.exit(1); } });'
}

find_rpc() {
  FORK_URL=""
  local node
  for node in "${RPC_POOL[@]}"; do
    beat anvil-heartbeat
    if is_rpc_blacklisted "$node"; then continue; fi
    echo "[Testing] $node"
    if rpc_probe "$node" eth_getBalance '["0x0000000000000000000000000000000000000000","latest"]' 8; then
      manager_sleep 2 anvil-heartbeat
      if rpc_probe "$node" eth_getBalance '["0x0000000000000000000000000000000000000000","latest"]' 8; then
        FORK_URL="$node"
        echo "[Selected] $node"
        return 0
      fi
    fi
    echo "[RPC] Probe failed; temporarily blacklisting $node"
    mark_rpc_bad "$node"
  done
  return 1
}

anvil_log_stream() {
  local generation="$1" line
  while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      *"HTTP error 429"*|*"HTTP status 429"*|*"429 Too Many Requests"*|*"Rate limit exceeded"*|*"failed to create genesis"*)
        printf '%s' "$generation" > "$DATA_DIR/anvil-start-error" ;;
    esac
  done
}

start_anvil() {
  find_rpc || return 1
  rm -f "$SESSION_READY_FILE" "$RESTART_REQUEST_FILE" "$DATA_DIR/anvil-start-error"
  local generation started now
  generation="$(date +%s%N)-$RANDOM-$RANDOM"
  printf '%s' "$generation" > "$ANVIL_GENERATION_FILE.tmp"
  mv "$ANVIL_GENERATION_FILE.tmp" "$ANVIL_GENERATION_FILE"
  echo "[Anvil] STARTING generation=$generation"
  # --timeout/--retries约束单次上游等待；不改变链ID、出块、余额或交易规则。
  anvil --fork-url "$FORK_URL" --fork-retry-backoff 3000 --timeout 10000 --retries 2 \
    --chain-id 1 --host 0.0.0.0 --port 8545 --block-time 1 \
    --state "$DATA_DIR/anvil-state.json" > >(anvil_log_stream "$generation") 2>&1 &
  ANVIL_PID=$!
  started=$(date +%s)
  while true; do
    beat anvil-heartbeat
    if ! kill -0 "$ANVIL_PID" 2>/dev/null || [ -f "$DATA_DIR/anvil-start-error" ]; then
      echo "[Anvil] Startup failed/rate limited; trying another upstream"
      break
    fi
    if rpc_probe http://127.0.0.1:8545 eth_blockNumber '[]' 2; then
      echo "[Anvil] RPC_READY generation=$generation"
      return 0
    fi
    now=$(date +%s)
    if [ $((now-started)) -ge "$ANVIL_STARTUP_TIMEOUT" ]; then
      echo "[Anvil] This upstream startup timed out; keeping Session and managers alive"
      break
    fi
    manager_sleep 2 anvil-heartbeat
  done
  stop_pid "$ANVIL_PID"; ANVIL_PID=""
  mark_rpc_bad "$FORK_URL"
  return 1
}

# 唯一拥有Anvil启动/停止权限的循环。初始化完成前没有第二个健康循环。
anvil_supervisor() {
  trap 'stop_pid "$ANVIL_PID"; exit 0' TERM INT
  local retry=5 failures=0 generation requested
  while true; do
    beat anvil-heartbeat
    if ! start_anvil; then
      echo "[Anvil] Retry after ${retry}s; Session preserved"
      manager_sleep "$retry" anvil-heartbeat
      retry=$((retry*2)); [ "$retry" -gt 300 ] && retry=300
      continue
    fi
    retry=5; failures=0
    generation=$(cat "$ANVIL_GENERATION_FILE")
    while kill -0 "$ANVIL_PID" 2>/dev/null; do
      manager_sleep 15 anvil-heartbeat
      requested=""; [ -f "$RESTART_REQUEST_FILE" ] && requested=$(cat "$RESTART_REQUEST_FILE")
      if [ "$requested" = "$generation" ]; then
        echo "[Anvil] Session requested upstream recovery"
        break
      fi
      # 本地轻量检查不依赖上游账户；恢复期不重复启动另一套管理器。
      if rpc_probe http://127.0.0.1:8545 eth_blockNumber '[]' 5; then
        failures=0
      else
        failures=$((failures+1))
        echo "[Anvil] Local RPC failure ${failures}/5"
        [ "$failures" -ge 5 ] && break
      fi
    done
    rm -f "$SESSION_READY_FILE"
    stop_pid "$ANVIL_PID"; ANVIL_PID=""
    mark_rpc_bad "$FORK_URL"
    manager_sleep 15 anvil-heartbeat
  done
}

monitor_supervisor() {
  local monitor_pid="" monitor_exit stamp now launched
  trap 'stop_pid "$monitor_pid"; rm -f "$SESSION_READY_FILE"; exit 0' TERM INT
  while true; do
    beat monitor-heartbeat
    rm -f "$DATA_DIR/worker-heartbeat" "$SESSION_READY_FILE"
    RPC_URL=http://127.0.0.1:8545 DATA_DIR="$DATA_DIR" HEALTH_PORT=8546 PUBLIC_RPC_PORT=8547 \
      MANAGER_HEALTH_PORT="${PORT:-3000}" node /opt/node-monitor/node-monitor-session.js &
    monitor_pid=$!; launched=$(date +%s)
    while kill -0 "$monitor_pid" 2>/dev/null; do
      manager_sleep 5 monitor-heartbeat
      stamp="$launched"; now=$(date +%s)
      if [ -f "$DATA_DIR/worker-heartbeat" ]; then
        read -r stamp _ < "$DATA_DIR/worker-heartbeat"
      fi
      if [ $((now-stamp)) -gt 45 ]; then
        echo "[Monitor] Worker heartbeat stale; restarting only JS, retaining Session"
        stop_pid "$monitor_pid"
        break
      fi
    done
    wait "$monitor_pid"; monitor_exit=$?; monitor_pid=""
    rm -f "$SESSION_READY_FILE"
    if [ "$monitor_exit" -eq 2 ] || [ -f "$FATAL_FILE" ]; then
      echo "[Fatal] Invalid configuration/Session; operator action required"
      while true; do manager_sleep 30 monitor-heartbeat; done
    fi
    echo "[Monitor] Exited ${monitor_exit}; retrying after 5s with current Session"
    manager_sleep 5 monitor-heartbeat
  done
}

# 先让管理健康端口可响应，再在后台连接上游。不存在全局180秒退出条件。
beat main-heartbeat
monitor_supervisor &
MONITOR_MANAGER_PID=$!
anvil_supervisor &
ANVIL_MANAGER_PID=$!
ngrok config add-authtoken "$NGROK_AUTHTOKEN" || { printf 'ngrok configuration failed' > "$FATAL_FILE"; shutdown_all; }

while true; do
  beat main-heartbeat
  if [ -f "$FATAL_FILE" ]; then
    stop_pid "$NGROK_PID"; NGROK_PID=""
    manager_sleep 5 main-heartbeat
    continue
  fi
  if ! kill -0 "$ANVIL_MANAGER_PID" 2>/dev/null || ! kill -0 "$MONITOR_MANAGER_PID" 2>/dev/null; then
    echo "[Fatal] A lifecycle manager exited unexpectedly"
    printf 'lifecycle manager exited' > "$FATAL_FILE"
    continue
  fi
  if [ -z "$NGROK_PID" ]; then
    if [ ! -f "$SESSION_READY_FILE" ]; then
      manager_sleep 5 main-heartbeat
      continue
    fi
    echo "[Ready] Session verified; opening ngrok endpoint"
    if [ -z "${NGROK_DOMAIN:-}" ]; then ngrok http 8547 &
    else ngrok http --url="https://${NGROK_DOMAIN}" 8547 &
    fi
    NGROK_PID=$!
  fi
  if ! kill -0 "$NGROK_PID" 2>/dev/null; then
    wait "$NGROK_PID"; ngrok_exit=$?; NGROK_PID=""
    echo "[Ngrok] Exited ${ngrok_exit}; retrying same endpoint after 15s (no pooling)"
    manager_sleep 15 main-heartbeat
  else
    manager_sleep 5 main-heartbeat
  fi
done
START_SCRIPT_EOF
chmod +x /start.sh
DOCKER_BUILD_EOF

CMD ["/start.sh"]


