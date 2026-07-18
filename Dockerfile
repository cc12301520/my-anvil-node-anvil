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
# 2. 多節點動態探活（完全保留 5 版 Baseline）\n\
NODES=(\n\
  "https://cloudflare-eth.com"\n\
  "https://eth.llamarpc.com"\n\
  "https://rpc.ankr.com/eth"\n\
  "https://ethereum.publicnode.com"\n\
)\n\
FORK_URL=""\n\
for node in "${NODES[@]}"; do\n\
  if curl -s -X POST -H "Content-Type: application/json" --data '"'"'{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'"'"' "$node" | grep -q "result"; then\n\
    FORK_URL=$node\n\
    break\n\
  fi\n\
done\n\
if [ -z "$FORK_URL" ]; then\n\
  FORK_URL="https://cloudflare-eth.com"\n\
fi\n\
\n\
# 3. 狀態持久化參數配置（完全保留 5 版 Baseline）\n\
STATE_PARAM=""\n\
if [ -f "/anvil_state.json" ]; then\n\
  STATE_PARAM="--state /anvil_state.json"\n\
else\n\
  STATE_PARAM="--state /anvil_state.json"\n\
fi\n\
\n\
# 4. 後台啟動 Anvil（你的核心發動機：1秒打包、主網分叉，100% 保持 Baseline 邏輯）\n\
anvil --fork-url "$FORK_URL" \\\n\
      --chain-id 1 \\\n\
      --host 0.0.0.0 \\\n\
      --port 8545 \\\n\
      --block-time 1 \\\n\
      $STATE_PARAM &\n\
sleep 5\n\
\n\
# 🎯 [SRE 最小變更外掛：原生非阻塞健康檢查響應器]\n\
# 使用一條極其輕量的 Netcat 死循環，獨立監聽 3000 端口。\n\
# 當 Render 或 UptimeRobot 發起 HTTP 請求時，直接由內核級別的管道回覆標準 200 OK，隨後立即釋放連線。\n\
# 它與 Anvil 處於完全不同的端口和進程空間，絕無搶佔 Anvil 執行緒或死鎖的風險！\n\
while true; do \n\
  echo -e "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nOK" | nc -l -p 3000 -q 1\n\
done &\n\
\n\
# 5. 啟動 ngrok（完全保留 5 版 Baseline）\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
