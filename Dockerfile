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
# 1. 清理舊進程\n\
pkill -f anvil\n\
pkill -f ngrok\n\
sleep 1\n\
\n\
# 2. 定義多個備用節點池（包含高質量 Archive 節點）\n\
NODES=(\n\
  "https://cloudflare-eth.com"\n\
  "https://eth.llamarpc.com"\n\
  "https://rpc.ankr.com/eth"\n\
  "https://ethereum.publicnode.com"\n\
)\n\
\n\
FORK_URL=""\n\
# 自動檢測哪個節點可用\n\
for node in "${NODES[@]}"; do\n\
  echo "正在測試節點: $node ..."\n\
  if curl -s -X POST -H "Content-Type: application/json" --data '"'"'{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'"'"' "$node" | grep -q "result"; then\n\
    FORK_URL=$node\n\
    echo "✅ 成功選定節點: $FORK_URL"\n\
    break\n\
  fi\n\
done\n\
\n\
if [ -z "$FORK_URL" ]; then\n\
  echo "❌ 所有節點都不可用，使用默認 Cloudflare"\n\
  FORK_URL="https://cloudflare-eth.com"\n\
fi\n\
\n\
# 3. 後台啟動 Anvil\n\
anvil --fork-url "$FORK_URL" --chain-id 1 --host 0.0.0.0 --port 8545 &\n\
sleep 3\n\
\n\
# 4. 啟動 ngrok\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
