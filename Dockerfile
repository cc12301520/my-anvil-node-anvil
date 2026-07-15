FROM ubuntu:22.04

# 1. 完美保留原版環境安裝（加入 python3 用於健康檢查）
RUN apt-get update && apt-get install -y curl git xz-utils sudo python3 && rm -rf /var/lib/apt/lists/*

RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup

RUN curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list \
    && apt-get update && apt-get install -y ngrok

# 暴露原有的 8545，以及專門給健康檢查站崗的 3000 端口
EXPOSE 8545
EXPOSE 3000

RUN echo '#!/bin/bash\n\
# 1. 清理舊進程\n\
pkill -f anvil\n\
pkill -f ngrok\n\
pkill -f http.server\n\
sleep 1\n\
\n\
# 🎯 [新增外掛：極輕量健康檢查響應器]\n\
# 在後台啟動一個只會回覆 200 OK 的服務，死死守住 3000 端口，絕不碰 Anvil 的任何邏輯\n\
mkdir -p /app && echo "OK" > /app/health\n\
cd /app && python3 -m http.server 3000 &\n\
\n\
# 2. 多節點動態探活（原封不動）\n\
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
# 3. 狀態持久化參數配置（原封不動）\n\
STATE_PARAM=""\n\
if [ -f "/anvil_state.json" ]; then\n\
  STATE_PARAM="--state /anvil_state.json"\n\
else\n\
  STATE_PARAM="--state /anvil_state.json"\n\
fi\n\
\n\
# 4. 後台啟動 Anvil（你的核心發動機：1秒打包、主網分叉，原封不動！）\n\
anvil --fork-url "$FORK_URL" \\\n\
      --chain-id 1 \\\n\
      --host 0.0.0.0 \\\n\
      --port 8545 \\\n\
      --block-time 1 \\\n\
      $STATE_PARAM &\n\
sleep 5\n\
\n\
# 5. 啟動 ngrok（原封不動）\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
