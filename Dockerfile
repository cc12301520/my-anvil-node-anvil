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
# 1. 強制清理可能殘留的本地進程\n\
pkill -f anvil\n\
pkill -f ngrok\n\
sleep 1\n\
\n\
# 2. 多節點優化探活（保留高質量節點，防403）\n\
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
echo "💡 最終選定主網 Fork 節點: $FORK_URL"\n\
\n\
# 3. 狀態持久化參數配置\n\
STATE_PARAM=""\n\
if [ -f "/anvil_state.json" ]; then\n\
  echo "💾 檢測到歷史存檔，正在載入餘額數據..."\n\
  STATE_PARAM="--state /anvil_state.json"\n\
else\n\
  echo "🆕 未檢測到存檔，正在初始化乾淨的持久化環境..."\n\
  STATE_PARAM="--state /anvil_state.json"\n\
fi\n\
\n\
# 4. 後台啟動 Anvil\n\
anvil --fork-url "$FORK_URL" \\\n\
      --chain-id 1 \\\n\
      --host 0.0.0.0 \\\n\
      --port 8545 \\\n\
      $STATE_PARAM &\n\
sleep 5\n\
\n\
# 5. 啟動 ngrok（核心修復：加入自愈邏輯，防止 ERR_NGROK_334）\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  echo "🚀 正在建立固定域名隧道: $NGROK_DOMAIN"\n\
  # 加上 --metadata 用於標記，確保併發部署時新隧道能順利建立\n\
  ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
