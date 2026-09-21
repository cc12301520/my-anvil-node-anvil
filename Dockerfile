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
COPY node-monitor-restored.js /opt/node-monitor/node-monitor-restored.js

EXPOSE 8545
EXPOSE 3000

RUN <<'DOCKER_BUILD_EOF'
cat > /start.sh <<'START_SCRIPT_EOF'
#!/bin/bash

# 不使用 set -e：单个公共 RPC 或辅助进程失败时，主服务仍可自行切换与恢复。

# ---------- 1. 清理旧进程 ----------
pkill -f anvil 2>/dev/null || true
pkill -f ngrok 2>/dev/null || true
pkill -f node-monitor-restored.js 2>/dev/null || true
pkill -f "nc -l" 2>/dev/null || true
sleep 1

# ---------- 2. 原版 RPC Pool ----------
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

# 保留原版随机顺序，避免每次启动都集中使用同一个免费 RPC。
mapfile -t RPC_POOL < <(
  for rpc in "${RPC_POOL[@]}"; do
    printf '%s %s\n' "$RANDOM" "$rpc"
  done | sort -n | cut -d' ' -f2-
)

RPC_BLACKLIST_SECONDS=1800
FORK_URL=""
ANVIL_PID=""

is_rpc_blacklisted() {
  local rpc="$1"
  [ -z "$rpc" ] && return 0

  local safe_hash
  local cache_file
  local last
  local now
  safe_hash=$(echo -n "$rpc" | md5sum | cut -d' ' -f1)
  cache_file="/tmp/bad_rpc_${safe_hash}"

  if [ -f "$cache_file" ]; then
    last=$(cat "$cache_file")
    now=$(date +%s)
    if (( now - last < RPC_BLACKLIST_SECONDS )); then
      return 0
    fi
    rm -f "$cache_file"
  fi
  return 1
}

mark_rpc_bad() {
  local rpc="$1"
  [ -z "$rpc" ] && return

  local safe_hash
  safe_hash=$(echo -n "$rpc" | md5sum | cut -d' ' -f1)
  date +%s > "/tmp/bad_rpc_${safe_hash}"
}

rpc_failure_reason() {
  local exit_code="$1"
  local http_code="$2"
  if [ "$exit_code" -eq 28 ]; then echo "Timeout"
  elif [ "$exit_code" -eq 7 ]; then echo "Connection Refused"
  elif [ "$http_code" = "429" ]; then echo "429"
  elif [ "$exit_code" -eq 52 ] || [ "$exit_code" -eq 56 ]; then echo "EOF"
  else echo "Unknown"
  fi
}

test_rpc_once() {
  local rpc="$1"
  local response
  local exit_code
  local http_code
  local body

  response=$(curl -s --max-time 8 --write-out $'\n%{http_code}' \
    -X POST \
    -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}' \
    "$rpc")
  exit_code=$?
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  RPC_TEST_EXIT_CODE="$exit_code"
  RPC_TEST_HTTP_CODE="$http_code"
  [ "$exit_code" -eq 0 ] \
    && [ "$http_code" = "200" ] \
    && echo "$body" | grep -q '"result"'
}

find_rpc() {
  FORK_URL=""
  for node in "${RPC_POOL[@]}"; do
    [ -z "$node" ] && continue
    if is_rpc_blacklisted "$node"; then
      echo "[Skip] $node (blacklisted)"
      continue
    fi

    echo "[Testing] $node"
    if ! test_rpc_once "$node"; then
      echo "[Failed] $node (Reason: $(rpc_failure_reason "$RPC_TEST_EXIT_CODE" "$RPC_TEST_HTTP_CODE"))"
      mark_rpc_bad "$node"
      continue
    fi

    # 保留原版双重测试，避免选择只能偶尔成功一次的 RPC。
    sleep 2
    if ! test_rpc_once "$node"; then
      echo "[Failed] $node (Second request: $(rpc_failure_reason "$RPC_TEST_EXIT_CODE" "$RPC_TEST_HTTP_CODE"))"
      mark_rpc_bad "$node"
      continue
    fi

    FORK_URL="$node"
    echo "[Selected] $node"
    return 0
  done
  return 1
}

# ---------- 3. Anvil：完整保留原版 chain-id、端口、1秒出块与 state ----------
STATE_PARAM="--state /anvil_state.json"

start_anvil() {
  if ! find_rpc || [ -z "$FORK_URL" ]; then
    echo "[Error] No RPC Available"
    return 1
  fi

  anvil --fork-url "$FORK_URL" \
        --fork-retry-backoff 3000 \
        --chain-id 1 \
        --host 0.0.0.0 \
        --port 8545 \
        --block-time 1 \
        $STATE_PARAM &
  ANVIL_PID=$!

  sleep 5
  if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo "[Anvil Failed]"
    mark_rpc_bad "$FORK_URL"
    return 1
  fi
  return 0
}

restart_anvil() {
  echo "[Restart] Current RPC: $FORK_URL"
  echo "[Restart] Saving state and switching upstream RPC..."

  # SIGTERM 让 Anvil 有机会按 --state 写回 /anvil_state.json。
  if [ -n "$ANVIL_PID" ]; then
    kill -TERM "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  mark_rpc_bad "$FORK_URL"

  sleep 60
  local loop_retry=30
  while ! start_anvil; do
    echo "[Retry after ${loop_retry}s]"
    sleep "$loop_retry"
    if [ "$loop_retry" -lt 300 ]; then
      loop_retry=$((loop_retry * 2))
      [ "$loop_retry" -gt 300 ] && loop_retry=300
    fi
  done
  echo "[Restart] New RPC: $FORK_URL"
  echo "[Restart] Anvil restarted successfully"
}

RETRY=30
while ! start_anvil; do
  echo "[Retry after ${RETRY}s]"
  sleep "$RETRY"
  if [ "$RETRY" -lt 300 ]; then
    RETRY=$((RETRY * 2))
    [ "$RETRY" -gt 300 ] && RETRY=300
  fi
done

# ---------- 4. Render 内部唯一余额保护器 ----------
# 如果 JS 意外退出，5秒后自动重启；不需要本地电脑或 Terminal 常驻。
monitor_supervisor() {
  while true; do
    echo "[Monitor] Starting original-feature balance protector..."
    RPC_URL="http://127.0.0.1:8545" \
    DATA_DIR="/opt/node-monitor/data" \
    HEALTH_PORT="8546" \
      node /opt/node-monitor/node-monitor-restored.js
    monitor_exit=$?
    echo "[Monitor] Exited with code ${monitor_exit}; restarting after 5s"
    sleep 5
  done
}
monitor_supervisor &

# ---------- 5. Anvil 健康检查与自动切换 ----------
health_loop() {
  local fail_count=0
  local max_fail=5

  while true; do
    sleep 15
    local response
    local exit_code
    local http_code
    local body
    local final_reason="Unknown"

    response=$(curl -s --max-time 5 --write-out $'\n%{http_code}' \
      -X POST \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}' \
      http://127.0.0.1:8545)
    exit_code=$?
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$exit_code" -eq 0 ] && [ "$http_code" = "200" ] && echo "$body" | grep -q '"result"'; then
      fail_count=0
      echo "[Health] OK"
      continue
    fi

    # 保留原版二次确认，避免一次网络抖动就重启并影响正在处理的交易。
    sleep 2
    response=$(curl -s --max-time 5 --write-out $'\n%{http_code}' \
      -X POST \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}' \
      http://127.0.0.1:8545)
    exit_code=$?
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$exit_code" -eq 0 ] && [ "$http_code" = "200" ] && echo "$body" | grep -q '"result"'; then
      fail_count=0
      echo "[Health] OK after retry"
      continue
    fi

    final_reason=$(rpc_failure_reason "$exit_code" "$http_code")
    fail_count=$((fail_count + 1))
    echo "[Health] FAIL ${fail_count}/${max_fail} (Reason: $final_reason)"

    if [ "$fail_count" -ge "$max_fail" ]; then
      restart_anvil
      fail_count=0
    fi
  done
}
health_loop &

# ---------- 6. Render 对外健康端口 ----------
# 不再永远返回绿灯：Anvil 可响应才返回 200，否则返回 503。
render_health_server() {
  while true; do
    if curl -s --max-time 2 \
      -X POST \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      http://127.0.0.1:8545 | grep -q '"result"'; then
      status="200 OK"
      body="OK"
    else
      status="503 Service Unavailable"
      body="Anvil unavailable"
    fi

    printf 'HTTP/1.1 %s\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n%s\n' \
      "$status" "$body" | nc -l -p "${PORT:-3000}" -q 1
  done
}
render_health_server &

# ---------- 7. ngrok 保持原版固定域名逻辑 ----------
if [ -z "${NGROK_AUTHTOKEN:-}" ]; then
  echo "[Fatal] NGROK_AUTHTOKEN is not configured"
  exit 1
fi

ngrok config add-authtoken "$NGROK_AUTHTOKEN"
if [ -z "${NGROK_DOMAIN:-}" ]; then
  exec ngrok http 8545
else
  exec ngrok http --url="https://${NGROK_DOMAIN}" 8545
fi
START_SCRIPT_EOF

chmod +x /start.sh
DOCKER_BUILD_EOF

CMD ["/start.sh"]
