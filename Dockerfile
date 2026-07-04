FROM ubuntu:22.04

RUN apt-get update && apt-get install -y curl git xz-utils sudo && rm -rf /var/lib/apt/lists/*

RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup

RUN curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list \
    && apt-get update && apt-get install -y ngrok

EXPOSE 8545

RUN echo '#!/bin/bash\n\
# 1. 備份現有狀態（如果存在）\n\
if [ -f "/anvil_state.json" ]; then\n\
  cp /anvil_state.json /anvil_state_backup.json\n\
fi\n\
\n\
# 2. 清理舊進程\n\
pkill -f anvil\n\
pkill -f ngrok\n\
sleep 1\n\
\n\
# 3. 多節點動態探活池\n\
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
# 4. 啟動 Anvil 並開啟狀態持久化（--state 與 --dump-state-on-by）\n\
# 這會讓 Anvil 在接收到關閉信號或定期將所有錢包餘額、轉賬記錄保存到硬碟中\n\
anvil --fork-url "$FORK_URL" \\\n\
      --chain-id 1 \\\n\
      --host 0.0.0.0 \\\n\
      --port 8545 \\\n\
      --state /anvil_state.json \\\n\
      --dump-state-on-by receive-signal &\n\
sleep 3\n\
\n\
# 5. 啟動 ngrok\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
