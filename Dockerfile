FROM node:lts-alpine

LABEL maintainer="lalifeier <lalifeier@gmail.com>"

ARG NODE_UID=10001

RUN apk --no-cache add curl unzip && \
    rm -rf /var/cache/apk/*

RUN apk --no-cache add shadow && \
    usermod -u $NODE_UID node

WORKDIR /app

ENV BIN_DIR="/app/bin"

RUN curl -sLo nezha-agent_linux_amd64.zip "https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip" && \
    unzip -q nezha-agent_linux_amd64.zip -d "$BIN_DIR" && \
    chmod +x $BIN_DIR/nezha-agent && \
    rm nezha-agent_linux_amd64.zip && \
    curl -sLo $BIN_DIR/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x $BIN_DIR/cloudflared

COPY server.js package.json package-lock.json ./

RUN npm install

EXPOSE 3000

ENTRYPOINT ["node", "server.js"]

USER 10001
