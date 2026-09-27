# syntax=docker/dockerfile:1
FROM ubuntu:22.04

# restored 的安装环境；只补充 util-linux，供单实例文件锁使用。
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl git xz-utils sudo netcat-openbsd gnupg util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs \
    && node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' \
    && rm -rf /var/lib/apt/lists/*
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup
RUN curl -fsS https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
      | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
      | tee /etc/apt/sources.list.d/ngrok.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ngrok \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/node-monitor/data \
    && npm install --prefix /opt/node-monitor --omit=dev ethers@6
COPY node-monitor-restored.js /opt/node-monitor/node-monitor-restored.js
RUN node --check /opt/node-monitor/node-monitor-restored.js
EXPOSE 8545 3000

RUN <<'DOCKER_BUILD_EOF'
cat > /start.sh <<'START_SCRIPT_EOF'
#!/bin/bash
# 三个原有组件：Anvil、JS、ngrok。没有交易代理，没有账本就绪阻塞 ngrok。
DATA_DIR=/opt/node-monitor/data
mkdir -p "$DATA_DIR"
export DATA_DIR
export NODE_STATUS_FILE="$DATA_DIR/anvil-status"
export RPC_URL=http://127.0.0.1:8545
export HEALTH_PORT="${PORT:-3000}"
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
mapfile -t RPC_POOL < <(printf '%s\n' "${RPC_POOL[@]}" | shuf)

status_write() {
  printf '%s\n' "$1" > "$NODE_STATUS_FILE.tmp"
  mv "$NODE_STATUS_FILE.tmp" "$NODE_STATUS_FILE"
}
port_busy() { nc -z -w 1 127.0.0.1 8545 >/dev/null 2>&1; }
local_block() {
  local reply
  reply=$(curl -fsS --max-time 4 -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://127.0.0.1:8545 2>/dev/null) || return 1
  [[ "$reply" =~ \"result\"[[:space:]]*:[[:space:]]*\"(0x[0-9a-fA-F]+)\" ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}
# 只回收本监督器启动的子进程；wait 的调用者也是实际父进程。
stop_child() {
  local child="$1"
  [ -n "$child" ] || return 0
  kill -TERM "$child" 2>/dev/null || true
  local i
  for ((i=0;i<30;i++)); do
    kill -0 "$child" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$child" 2>/dev/null; then
    echo "[Stop] Child $child did not exit in 30s; forcing exit (local state may not flush)"
    kill -KILL "$child" 2>/dev/null || true
  fi
  wait "$child" 2>/dev/null || true
}

anvil_supervisor() {
  exec 9>"$DATA_DIR/anvil-supervisor.lock"
  flock -n 9 || { echo '[Fatal] Another Anvil supervisor owns this container'; return 1; }
  local child="" node http_code block last_block failures stalled deadline token
  local retry=5 started=0 now
  declare -A bad_until
  trap 'status_write stopping; stop_child "$child"; exit 0' TERM INT
  status_write starting
  while true; do
    # 端口冲突是本地进程问题，不归咎上游，不拉黑正常 RPC。
    if port_busy; then
      echo '[Anvil] 8545 is still occupied; not starting a second process'
      sleep 10
      continue
    fi
    started=0
    for node in "${RPC_POOL[@]}"; do
      now=$(date +%s)
      (( now < ${bad_until[$node]:-0} )) && continue
      echo "[Testing] $node"
      # 仍用两次轻量公共 RPC 测试；429 要尊重冷却，不能不断清空黑名单。
      local probe_ok=1 attempt reply
      for attempt in 1 2; do
        reply=$(curl -sS --max-time 8 --write-out $'\n%{http_code}' \
          -H 'Content-Type: application/json' \
          --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}' \
          "$node" 2>/dev/null)
        http_code="${reply##*$'\n'}"
        if [ "$http_code" != 200 ] || ! [[ "$reply" =~ \"result\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]+\" ]]; then
          echo "[RPC] Probe failed HTTP=$http_code: $node"
          bad_until[$node]=$(( $(date +%s) + 120 ))
          [ "$http_code" = 429 ] && bad_until[$node]=$(( $(date +%s) + 1800 ))
          probe_ok=0
          break
        fi
        [ "$attempt" = 1 ] && sleep 2
      done
      [ "$probe_ok" = 1 ] || continue
      if port_busy; then break; fi
      echo "[Selected] $node"
      status_write starting
      # 保留 restored 原启动参数；不加历史裁剪，不改一秒出块。
      anvil --fork-url "$node" --fork-retry-backoff 3000 \
        --chain-id 1 --host 0.0.0.0 --port 8545 \
        --block-time 1 --state /anvil_state.json &
      child=$!
      deadline=$(( $(date +%s) + 120 ))
      while kill -0 "$child" 2>/dev/null && (( $(date +%s) < deadline )); do
        if block=$(local_block) && kill -0 "$child" 2>/dev/null; then
          # 只在本次进程真正监听后发布身份。失败启动不会触发 JS 恢复。
          token="$(date +%s%N)-$child-$RANDOM"
          status_write "ready $token"
          echo "[Anvil] RPC_READY pid=$child upstream=$node"
          started=1
          retry=5
          break
        fi
        sleep 2
      done
      if [ "$started" = 1 ]; then break; fi
      echo "[Anvil] Startup failed or exceeded 120s: $node"
      status_write starting
      stop_child "$child"
      child=""
      bad_until[$node]=$(( $(date +%s) + 1800 ))
    done
    if [ "$started" != 1 ]; then
      echo "[RPC] No ready upstream; checking cooldowns again in ${retry}s"
      sleep "$retry"
      retry=$((retry * 2))
      (( retry > 30 )) && retry=30
      continue
    fi
    failures=0
    stalled=0
    last_block="$block"
    # 同一监督器既启动、检查，也停止 Anvil，避免后台子 shell 的旧 PID。
    while kill -0 "$child" 2>/dev/null; do
      sleep 15
      if block=$(local_block); then
        failures=0
        if [ "$block" = "$last_block" ]; then stalled=$((stalled+1)); else stalled=0; fi
        last_block="$block"
        if (( stalled >= 5 )); then echo '[Health] Block height stalled for 5 checks'; break; fi
      else
        sleep 2
        if block=$(local_block); then failures=0; continue; fi
        failures=$((failures+1))
        echo "[Health] Local RPC FAIL $failures/5"
        (( failures >= 5 )) && break
      fi
    done
    status_write starting
    echo '[Restart] Stopping owned Anvil process before any replacement'
    stop_child "$child"
    child=""
    bad_until[$node]=$(( $(date +%s) + 120 ))
    sleep 5
  done
}
monitor_supervisor() {
  local child=""
  trap 'stop_child "$child"; exit 0' TERM INT
  while true; do
    node /opt/node-monitor/node-monitor-restored.js &
    child=$!
    wait "$child"
    echo "[Monitor] Exited with code $?; restarting after 5s"
    child=""
    sleep 5
  done
}
ngrok_supervisor() {
  local child=""
  trap 'stop_child "$child"; exit 0' TERM INT
  while true; do
    if [ -z "${NGROK_DOMAIN:-}" ]; then ngrok http 8545 &
    else ngrok http --url="https://${NGROK_DOMAIN}" 8545 & fi
    child=$!
    wait "$child"
    echo "[Ngrok] Exited with code $?; retrying in 15s"
    child=""
    sleep 15
  done
}

if [ -z "${NGROK_AUTHTOKEN:-}" ]; then echo '[Fatal] NGROK_AUTHTOKEN missing'; exit 1; fi
ngrok config add-authtoken "$NGROK_AUTHTOKEN" || exit 1
status_write starting
anvil_supervisor &
ANVIL_SUPERVISOR_PID=$!
monitor_supervisor &
MONITOR_SUPERVISOR_PID=$!
ngrok_supervisor &
NGROK_SUPERVISOR_PID=$!
shutdown_all() {
  trap '' TERM INT
  echo '[Shutdown] Stopping ngrok, monitor and Anvil supervisors'
  kill -TERM "$NGROK_SUPERVISOR_PID" "$MONITOR_SUPERVISOR_PID" "$ANVIL_SUPERVISOR_PID" 2>/dev/null || true
  wait "$NGROK_SUPERVISOR_PID" "$MONITOR_SUPERVISOR_PID" "$ANVIL_SUPERVISOR_PID" 2>/dev/null || true
}
trap 'shutdown_all; exit 0' TERM INT
# 各组件自身恢复；监督器本身死亡才退出容器，不能留下虚假的健康状态。
wait -n "$ANVIL_SUPERVISOR_PID" "$MONITOR_SUPERVISOR_PID" "$NGROK_SUPERVISOR_PID"
echo '[Fatal] A component supervisor exited unexpectedly'
shutdown_all
exit 1
START_SCRIPT_EOF
chmod +x /start.sh
bash -n /start.sh
DOCKER_BUILD_EOF
CMD ["/start.sh"]




