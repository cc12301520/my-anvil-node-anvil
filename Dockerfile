FROM ubuntu:22.04
# 1. 完美還原 5 版 Baseline 環境安裝（僅加入 netcat 作為極輕量非阻塞健康檢查工具）
RUN apt-get update && apt-get install -y curl git xz-utils sudo netcat-openbsd && rm -rf /var/lib/apt/lists/*
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup
RUN curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list \
    && apt-get update && apt-get install -y ngrok
# 暴露原有的 8545，以及專門供 Render/UptimeRobot 探測的 3000 獨立物理端口
EXPOSE 8545
EXPOSE 3000
RUN echo '#!/bin/bash\n\
# 1. 清理舊進程\n\
pkill -f anvil\n\
pkill -f ngrok\n\
pkill -f nc\n\
sleep 1\n\
\n\
# ---------- 模塊一：RPC Pool ----------
RPC_POOL=(
  # ===== 第一梯隊（高優先級）=====
  "https://ethereum-rpc.publicnode.com"
  "https://ethereum.publicnode.com"
  "https://rpc.flashbots.net"
  "https://rpc.payload.de"
  "https://ethereum.drpc.org"
  "https://rpc.ankr.com/eth"
  "https://eth-mainnet.g.alchemy.com/v2/demo"

  # ===== 第二梯隊（備援）=====
  "https://1rpc.io/eth"
  "https://eth.meowrpc.com"
  "https://rpc.gateway.fm/v1/ethereum/mainnet"
  "https://eth.llamarpc.com"
  "https://eth-mainnet.public.blastapi.io"
  "https://cloudflare-eth.com"
  "https://ethereum.blockpi.network/v1/rpc/public"
  "https://mainnet.gateway.tenderly.co"
)

# 啟動時隨機打亂
RPC_POOL=($(for r in "${RPC_POOL[@]}"; do
    echo "$RANDOM $r"
done | sort -n | cut -d" " -f2-))
# ---------- 模塊二：RPC 黑名單 ----------\n\
RPC_BLACKLIST_SECONDS=1800\n\
is_rpc_blacklisted(){\n\
  local rpc="$1"\n\
  if [ -z "$rpc" ]; then return 0; fi\n\
  local safe_hash=$(echo -n "$rpc" | md5sum | cut -d" " -f1)\n\
  local cache_file="/tmp/bad_rpc_$safe_hash"\n\
  if [ -f "$cache_file" ]; then\n\
    local last=$(cat "$cache_file")\n\
    local now=$(date +%s)\n\
    if (( now-last < RPC_BLACKLIST_SECONDS )); then\n\
      return 0\n\
    fi\n\
    rm -f "$cache_file"\n\
  fi\n\
  return 1\n\
}\n\
mark_rpc_bad(){\n\
  local rpc="$1"\n\
  if [ -z "$rpc" ]; then return; fi\n\
  local safe_hash=$(echo -n "$rpc" | md5sum | cut -d" " -f1)\n\
  date +%s > "/tmp/bad_rpc_$safe_hash"\n\
}\n\
\n\
# ---------- 模塊三：find_rpc() ----------\n\
find_rpc(){\n\
  FORK_URL=""\n\
  for node in "${RPC_POOL[@]}"; do\n\
    if [ -z "$node" ]; then continue; fi\n\
    if is_rpc_blacklisted "$node"; then\n\
      echo "[Skip] $node (blacklisted)"\n\
      continue\n\
    fi\n\
    echo "[Testing] $node"\n\
    \n\
    RESPONSE1=$(curl -s --max-time 8 --write-out "\\n%{http_code}" \\\n\
      -X POST \\\n\
      -H "Content-Type: application/json" \\\n\
      --data '"'"'{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}'"'"' \\\n\
      "$node")\n\
    local exit_code1=$?\n\
    local http_code1=$(echo "$RESPONSE1" | tail -n1)\n\
    local body1=$(echo "$RESPONSE1" | sed '"'"'$d'"'"')\n\
    \n\
    if [ $exit_code1 -ne 0 ] || [ "$http_code1" -ne 200 ] || ! echo "$body1" | grep -q '"'"'"result"'"'"'; then\n\
      local reason="Unknown"\n\
      if [ $exit_code1 -eq 28 ]; then reason="Timeout"; fi\n\
      if [ $exit_code1 -eq 7 ]; then reason="Connection Refused"; fi\n\
      if [ "$http_code1" -eq 429 ]; then reason="429"; fi\n\
      if [ $exit_code1 -eq 52 ] || [ $exit_code1 -eq 56 ]; then reason="EOF"; fi\n\
      echo "[Failed] $node (Reason: $reason)"\n\
      mark_rpc_bad "$node"\n\
      continue\n\
    fi\n\
    \n\
    sleep 2\n\
    \n\
    RESPONSE2=$(curl -s --max-time 8 --write-out "\\n%{http_code}" \\\n\
      -X POST \\\n\
      -H "Content-Type: application/json" \\\n\
      --data '"'"'{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}'"'"' \\\n\
      "$node")\n\
    local exit_code2=$?\n\
    local http_code2=$(echo "$RESPONSE2" | tail -n1)\n\
    local body2=$(echo "$RESPONSE2" | sed '"'"'$d'"'"')\n\
    \n\
    if [ $exit_code2 -ne 0 ] || [ "$http_code2" -ne 200 ] || ! echo "$body2" | grep -q '"'"'"result"'"'"'; then\n\
      local reason="Second Request Failed"\n\
      if [ $exit_code2 -eq 28 ]; then reason="Timeout"; fi\n\
      if [ $exit_code2 -eq 7 ]; then reason="Connection Refused"; fi\n\
      if [ "$http_code2" -eq 429 ]; then reason="429"; fi\n\
      if [ $exit_code2 -eq 52 ] || [ $exit_code2 -eq 56 ]; then reason="EOF"; fi\n\
      echo "[Failed] $node (Reason: $reason)"\n\
      mark_rpc_bad "$node"\n\
      continue\n\
    fi\n\
    \n\
    FORK_URL="$node"\n\
    echo "[Selected] $node"\n\
    return 0\n\
  done\n\
  return 1\n\
}\n\
\n\
# ---------- 模塊四：start_anvil() ----------\n\
start_anvil(){\n\
  find_rpc\n\
  if [ -z "$FORK_URL" ]; then\n\
    echo "[Error] No RPC Available"\n\
    return 1\n\
  fi\n\
  \n\
  anvil --fork-url "$FORK_URL" \\\n\
        --fork-retry-backoff 3000 \\\n\
        --chain-id 1 \\\n\
        --host 0.0.0.0 \\\n\
        --port 8545 \\\n\
        --block-time 1 \\\n\
        $STATE_PARAM &\n\
  ANVIL_PID=$!\n\
  \n\
  sleep 5\n\
  if ! kill -0 $ANVIL_PID 2>/dev/null; then\n\
    echo "[Anvil Failed]"\n\
    mark_rpc_bad "$FORK_URL"\n\
    return 1\n\
  fi\n\
  return 0\n\
}\n\
\n\
# ---------- 新增微調模塊：restart_anvil() ----------\n\
restart_anvil(){\n\
  echo "[Restart]"\n\
  echo "Current RPC:"\n\
  echo "$FORK_URL"\n\
  echo "Switching..."\n\
  \n\
  kill $ANVIL_PID 2>/dev/null\n\
  wait $ANVIL_PID 2>/dev/null\n\
  mark_rpc_bad "$FORK_URL"\n\
  \n\
  sleep 60\n\
  \n\
  local loop_retry=30\n\
  while ! start_anvil; do\n\
    echo "[Retry after ${loop_retry}s]"\n\
    sleep $loop_retry\n\
    if [ $loop_retry -lt 300 ]; then\n\
      loop_retry=$((loop_retry*2))\n\
    fi\n\
  done\n\
  \n\
  echo "New RPC:"\n\
  echo "$FORK_URL"\n\
  echo "Anvil restarted successfully"\n\
}\n\
\n\
# 3. 狀態持久化參數配置（完全保留 5 版 Baseline）\n\
STATE_PARAM=""\n\
if [ -f "/anvil_state.json" ]; then\n\
  STATE_PARAM="--state /anvil_state.json"\n\
else\n\
  STATE_PARAM="--state /anvil_state.json"\n\
fi\n\
\n\
# ---------- 模塊八：指數退避啟動器 ----------\n\
RETRY=30\n\
while ! start_anvil; do\n\
  echo "[Retry after ${RETRY}s]"\n\
  sleep $RETRY\n\
  if [ $RETRY -lt 300 ]; then\n\
    RETRY=$((RETRY*2))\n\
  fi\n\
done\n\
\n\
# ---------- 模塊五 & 六：health_loop() ----------\n\
health_loop(){\n\
  local fail_count=0\n\
  local max_fail=5\n\
  while true; do\n\
    sleep 15\n\
    \n\
    RESPONSE1=$(curl -s --max-time 5 --write-out "\\n%{http_code}" \\\n\
      -X POST \\\n\
      -H "Content-Type: application/json" \\\n\
      --data '"'"'{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}'"'"' \\\n\
      http://127.0.0.1:8545)\n\
    local ec1=$?\n\
    local hc1=$(echo "$RESPONSE1" | tail -n1)\n\
    local b1=$(echo "$RESPONSE1" | sed '"'"'$d'"'"')\n\
    \n\
    local is_bad=0\n\
    local final_reason="Unknown"\n\
    \n\
    if [ $ec1 -ne 0 ] || [ "$hc1" -ne 200 ] || ! echo "$b1" | grep -q '"'"'"result"'"'"'; then\n\
      sleep 2\n\
      RESPONSE2=$(curl -s --max-time 5 --write-out "\\n%{http_code}" \\\n\
        -X POST \\\n\
        -H "Content-Type: application/json" \\\n\
        --data '"'"'{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"],"id":1}'"'"' \\\n\
        http://127.0.0.1:8545)\n\
      local ec2=$?\n\
      local hc2=$(echo "$RESPONSE2" | tail -n1)\n\
      local b2=$(echo "$RESPONSE2" | sed '"'"'$d'"'"')\n\
      \n\
      if [ $ec2 -ne 0 ] || [ "$hc2" -ne 200 ] || ! echo "$b2" | grep -q '"'"'"result"'"'"'; then\n\
        is_bad=1\n\
        if [ $ec2 -eq 28 ]; then final_reason="Timeout"; fi\n\
        if [ $ec2 -eq 7 ]; then final_reason="Connection Refused"; fi\n\
        if [ "$hc2" -eq 429 ]; then final_reason="429"; fi\n\
        if [ $ec2 -eq 52 ] || [ $ec2 -eq 56 ]; then final_reason="EOF"; fi\n\
      fi\n\
    fi\n\
    \n\
    if [ "$is_bad" -eq 0 ]; then\n\
      fail_count=0\n\
      echo "[Health] OK"\n\
    else\n\
      fail_count=$((fail_count+1))\n\
      echo "[Health] FAIL ${fail_count}/${max_fail} (Reason: $final_reason)"\n\
    fi\n\
    \n\
    if [ "$fail_count" -ge "$max_fail" ]; then\n\
      restart_anvil\n\
      fail_count=0\n\
    fi\n\
  done\n\
}\n\
health_loop &\n\
\n\
# 🎯 [SRE 最小變更外掛：原生非阻塞健康檢查響應器]\n\
while true; do \n\
  echo -e "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nOK" | nc -l -p 3000 -q 1\n\
done &\n\
\n\
# 5. 啟動 ngrok（修改處四：使用 exec 啟動 ngrok）\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  exec ngrok http 8545\n\
else\n\
  exec ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh
CMD ["/start.sh"]
