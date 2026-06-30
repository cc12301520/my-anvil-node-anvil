FROM ubuntu:22.04

RUN apt-get update && apt-get install -y curl git xz-utils sudo && rm -rf /var/lib/apt/lists/*

RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup

RUN curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
    && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list \
    && apt-get update && apt-get install -y ngrok

RUN echo '#!/bin/bash\n\
anvil --fork-url https://ethereum.publicnode.com --chain-id 1 --host 0.0.0.0 --port 8545 &\n\
ngrok config add-authtoken $NGROK_AUTHTOKEN\n\
if [ -z "$NGROK_DOMAIN" ]; then\n\
  ngrok http 8545\n\
else\n\
  ngrok http --domain=$NGROK_DOMAIN 8545\n\
fi' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
