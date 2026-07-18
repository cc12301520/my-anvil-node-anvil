FROM ubuntu:22.04

# 1. 完美還原 Baseline 環境安裝（加入 netcat 作為極輕量非阻塞健康檢查工具）
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
# 2. 多節點動態探活（優化策略：剔除高频429节点，严格校验 jsonrpc 响应）\n\
NODES=(\n\
  "https://eth.llamarpc.com"\n\
  "https://rpc.ankr.com/eth"\n\
)\n\
FORK_URL=""\n\
for node in "${NODES[@]}"; do\n\
  echo "Testing $node"\n\
  RESPONSE=$(curl -s --max-time 8 \\\n\
    -X POST \\\n\
    -H "Content-Type: application/json" \\\n\
    --data '"'"'{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}''"'" "$node")\n\
  echo "$RESPONSE"\n\
  if echo "$RESPONSE" | grep -q '"'"'"result"'"'"'; then\n\
    FORK_URL=$node\n\
    echo "Selected $node"\n\
    break\n\
  fi\n\
done\n\
\n\
if [ -z "$FORK_URL" ]; then\n\
  echo "Error: All public RPC nodes failed. Exiting."\n\
  exit 1\n\
fi\n\
\n\
# 3. 狀態持久化參數配置\n\
STATE_PARAM="--state /anvil_state.json"\n\
\n\
# 4. 後台啟動 Anvil（加入 fork 失败自动指数退避等待机制）\n\
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
\n\
# 嚴格健康檢查：若 Anvil 啟動失敗，直接退出腳本讓 Render 感知並重啟\n\
if ! kill -0 $ANVIL_PID 2>/dev/null; then\n\
  echo "Anvil failed to start. Exiting."\n\
  exit 1\n\
fi\n\
\n\
# 🎯 [SRE 最小變更外掛：原生非阻塞健康檢查響應器]\n\
while true; do \n\
  echo -e "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nOK" | nc -l -p 3000 -q 1\n\
done &\n\
\n\
# 5. 啟動 ngrok（使用 exec 讓 ngrok 成為 PID 1，確保 Render 訊號穩定管理）\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  exec ngrok http 8545\n\
else\n\
  exec ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
