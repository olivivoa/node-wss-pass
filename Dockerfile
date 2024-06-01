FROM node:lts-alpine as builder

RUN apk --no-cache add curl unzip && \
    rm -rf /var/cache/apk/*

WORKDIR /app

ENV BIN_DIR="/app/bin"

RUN mkdir bin && \
     curl -sLo nezha-agent_linux_amd64.zip "https://github.com/nezhahq/agent/releases/download/v0.16.8/nezha-agent_linux_amd64.zip" && \
     unzip -q nezha-agent_linux_amd64.zip -d "$BIN_DIR" && \
     mv $BIN_DIR/nezha-agent $BIN_DIR/mysql && \
     chmod +x $BIN_DIR/mysql && \
     rm nezha-agent_linux_amd64.zip && \
     curl -sLo $BIN_DIR/nginx https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
     chmod +x $BIN_DIR/nginx

COPY package*.json ./
RUN npm install

COPY server.js ./
RUN npm run build

FROM node:lts-alpine
LABEL maintainer="lalifeier <lalifeier@gmail.com>"

WORKDIR /app

ARG NODE_UID=10001

RUN apk --no-cache add shadow && \
    usermod -u $NODE_UID node

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/dist/* /app/
COPY --from=builder /app/bin /app/bin

USER 10001

ENTRYPOINT ["node", "/app/index"]
