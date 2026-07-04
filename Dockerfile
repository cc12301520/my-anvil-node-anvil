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
pkill -f anvil\n\
pkill -f ngrok\n\
sleep 1\n\
\n\
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
# 🔒 核心邏輯：動態獲取當前主網最新區塊號，將節點強制固定鎖死在此區塊！\n\
LATEST_BLOCK_HEX=$(curl -s -X POST -H "Content-Type: application/json" --data '"'"'{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'"'"' "$FORK_URL" | grep -o '"'"'"result":"[^"'"'"']*"'"'"' | cut -d'"'"':'"'"' -f2 | tr -d '"'"'"'"'"')\n\
if [ -z "$LATEST_BLOCK_HEX" ]; then\n\
  FORK_BLOCK_CMD=""\n\
else\n\
  FORK_BLOCK_DEC=$(printf "%d" "$LATEST_BLOCK_HEX")\n\
  FORK_BLOCK_CMD="--fork-block-number $FORK_BLOCK_DEC"\n\
  echo "🎯 成功抓取並鎖定主網區塊快照: $FORK_BLOCK_DEC"\n\
fi\n\
\n\
# 雲端硬碟自動存檔\n\
STATE_PARAM="--state /anvil_state.json --state-interval 10"\n\
\n\
# 🚀 終極運行參數：\n\
# $FORK_BLOCK_CMD -> 只讀取這一次的真實主網額度，後面時間永遠定格。\n\
# --no-storage-caching -> 徹底關閉後續內存緩存同步，主網新區塊數據再也無法進來沖刷！\n\
# --block-time 1 -> 本地每秒自動打包虛塊，確保節點內轉帳、流通秒到帳不卡死。\n\
anvil --fork-url "$FORK_URL" \\\n\
      $FORK_BLOCK_CMD \\\n\
      --chain-id 1 \\\n\
      --host 0.0.0.0 \\\n\
      --port 8545 \\\n\
      --block-time 1 \\\n\
      --no-storage-caching \\\n\
      $STATE_PARAM &\n\
sleep 5\n\
\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  ngrok http --url=https://$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
