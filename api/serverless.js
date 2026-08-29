const { spawn } = require("child_process");
const net = require("net");
const url = require("url");
const { createWebSocketStream } = require("ws");

// const UUID = process.env.UUID || "ffffffff-ffff-ffff-ffff-ffffffffffff";
const UUID = process.env.UUID || uuidv4()

const port = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || 'lalifeier-vl';
const HTTP_UPGRADE_PATH = process.env.HTTP_UPGRADE_PATH || 'lalifeier-http-upgrade-vl';

const DOMAIN = process.env.DOMAIN;
const AUTHORIZATION_TOKEN = process.env.AUTHORIZATION_TOKEN || 'lalifeier';

const AUTHORIZATION_USER = process.env.AUTHORIZATION_USER || 'lalifeier';
const AUTHORIZATION_PASSWORD = process.env.AUTHORIZATION_PASSWORD || '123456';

const CF_DOMAIN = process.env.CF_DOMAIN || ''

const ENABLE_LOG = process.env.ENABLE_LOG;

if (process.env.NODE_ENV === 'production' || !ENABLE_LOG) {
  console = console || {};
  console.log = function () { };
}

function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ Math.random() * 16 >> c / 4).toString(16)
  );
}

function init() {
  // 监听进程退出事件
  process.on("exit", () => {
    console.log("Node.js process is exiting.");
  });

  const fastify = require("fastify")({
    logger: !!ENABLE_LOG,
  });

  fastify.register(require("@fastify/websocket"));

  const server = fastify.server;

  server.on('upgrade', (request, socket, head) => {
    console.log('Received upgrade request.');

    if (request.headers.upgrade.toLowerCase() !== "websocket" || request.headers.connection.toLowerCase() !== "upgrade") {
      console.log('Invalid upgrade request. Closing connection.');
      socket.end("HTTP/1.1 400 Bad Request");
      return;
    }

    if (!request.headers['sec-websocket-key'] || !request.headers['sec-websocket-version']) {
      console.log('Missing WebSocket headers. Closing connection.');
      socket.end();
      return;
    }

    const url = require('url');
    const pathname = url.parse(request.url).pathname;

    if (pathname === `/${HTTP_UPGRADE_PATH}`) {
      const response = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        '\r\n'
      ].join('\r\n');

      console.log('Sending WebSocket handshake response.');
      socket.write(response);

      socket.on("data", (vlessBuffer) => {
        console.log('Received data from client.');

        const version = new Uint8Array(vlessBuffer.slice(0, 1));
        const uuid = vlessBuffer.slice(1, 17);

        // 校验UUID是否相同
        if (!Buffer.from(UUID.replace(/-/g, ""), 'hex').equals(uuid)) {
          console.error("UUID mismatch. Received:", uuid.toString('hex'), "Expected:", UUID.replace(/-/g, ""));
          return
        }

        const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
        const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
        const isUDP = command === 2;
        if (command != 1) {
          return
        }

        const portIndex = 18 + optLength + 1;
        const portRemote = vlessBuffer.slice(portIndex, portIndex + 2).readUInt16BE(0);

        let addressIndex = portIndex + 2;
        const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));

        const addressType = addressBuffer[0];
        let addressLength = 0;
        let addressValueIndex = addressIndex + 1;
        let addressValue = '';

        // 解析地址类型
        switch (addressType) {
          case 1:
            // IPv4
            addressLength = 4;
            addressValue = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
          case 2:
            // Domain
            addressLength = vlessBuffer[addressValueIndex++];
            addressValue = vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength).toString('utf-8');
            break;
          case 3:
            // IPv6
            addressLength = 16;
            const ipv6 = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength))
              .map((value, index) => vlessBuffer.readUInt16BE(addressIndex + index * 2).toString(16));
            addressValue = ipv6.join(':');
            break;
          default:
            return;
        }

        console.log('conn:', addressValue, portRemote);

        // 发送一个成功的响应给客户端
        socket.write(new Uint8Array([version[0], 0]));

        try {
          console.log('Creating TCP connection to target website.');

          const tcpSocket = net.createConnection({ host: addressValue, port: portRemote }, () => {
            console.log('Connected to target website.');

            const rawClientData = vlessBuffer.slice(addressValueIndex + addressLength);
            tcpSocket.write(rawClientData);

            console.log('Piping data between client and target website.');
            socket.pipe(tcpSocket).pipe(socket);
          });

          tcpSocket.on('end', () => {
            console.log('Connection to target website closed.');
          });

          tcpSocket.on('error', (err) => {
            console.error('Error connecting to target website:', err);
          });
        } catch (error) {
          console.error("WebSocket Connection Error:", err);
        }
      });
      return;
    }

  })

  server.on('connect', (request, socket, head) => {
    console.log('Received CONNECT request:', request.url);

    try {
      if (request.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(`${AUTHORIZATION_USER}:${AUTHORIZATION_PASSWORD}`).toString('base64')) {

        console.error('Invalid authorization header.');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.end();
        return;
      }

      const parts = request.url.split(':');
      const host = parts[0];
      const port = parseInt(parts[1], 10);

      console.log('Connecting to target website:', host, port);

      const tcpSocket = net.createConnection({ host, port }, () => {
        console.log('Connected to target website.');

        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        console.log('Piping data between client and target website.');
        tcpSocket.pipe(socket).pipe(tcpSocket);
      });

      tcpSocket.on('end', () => {
        console.log('Connection to target website closed.');
      });

      tcpSocket.on('error', (err) => {
        console.error('Error connecting to target website:', err);
      });

      socket.on('error', (err) => {
        console.error('Error with client socket:', err);
      });

      socket.on('close', () => {
        console.log('Client socket closed.');
        tcpSocket.end();
      });
    } catch (err) {
      console.error("Connect Error:", err);
    }
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.headers['proxy-connection']) {
      console.log('Received HTTP request:', request.method, request.url);

      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
      });

      console.log('Received HTTP response:', response.status, response.statusText);

      return reply.send(response.body);
    }
  });

  fastify.all("/", async (request, reply) => {
    if (!request.headers['proxy-connection'] || request.url === '/') {
      return { hello: "world" };
    }

    console.log('Received HTTP request:', request.method, request.url);

    if (request.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(`${AUTHORIZATION_USER}:${AUTHORIZATION_PASSWORD}`).toString('base64')) {

      console.error('Invalid authorization header.');
      reply.code(401).send('Unauthorized');
      return;
    }

    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
    });

    console.log('Received HTTP response:', response.status, response.statusText);

    return reply.send(response.body);

  });

  fastify.get('/proxy', async (request, reply) => {
    reply.hijack();
    const { socket } = reply.raw;

    const { port, hostname } = url.parse(request.url);
    const targetSocket = net.connect(port, 'hostname');
    socket.pipe(targetSocket).pipe(socket);
  });

  function generateWebSocketAccept(key) {
    const crypto = require("crypto")
    const sha1 = crypto.createHash('sha1');
    sha1.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    return sha1.digest('base64');
  }

  fastify.get(`/${HTTP_UPGRADE_PATH}`, async (request, reply) => {
    if (request.headers.upgrade === 'websocket') {
      // 升级到 WebSocket
      reply.raw.writeHead(101, {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
      });
    } else {
      const { res } = reply.raw;

      return { hello: 'world' };
    }
  });

  // 1 字节     16 字节      1 字节       M 字节       1 字节    2 字节    1 字节    S 字节   X 字节
  // 协议版本    等价 UUID    附加信息长度 M    附加信息ProtoBuf    指令     端口     地址类型    地址    请求数据
  function handleMessage(vlessBuffer, ws) {
    console.log(vlessBuffer)

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const uuid = vlessBuffer.slice(1, 17);

    // 校验UUID是否相同
    if (!Buffer.from(UUID.replace(/-/g, ""), 'hex').equals(uuid)) {
      console.error("UUID mismatch. Received:", uuid.toString('hex'), "Expected:", UUID.replace(/-/g, ""));
      return;
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const isUDP = command === 2;
    if (command != 1) {
      return
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = vlessBuffer.slice(portIndex, portIndex + 2).readUInt16BE(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));

    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    // 解析地址类型
    switch (addressType) {
      case 1:
        // IPv4
        addressLength = 4;
        addressValue = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
        break;
      case 2:
        // Domain
        addressLength = vlessBuffer[addressValueIndex++];
        addressValue = vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength).toString('utf-8');
        break;
      case 3:
        // IPv6
        addressLength = 16;
        const ipv6 = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength))
          .map((value, index) => vlessBuffer.readUInt16BE(addressIndex + index * 2).toString(16));
        addressValue = ipv6.join(':');
        break;
      default:
        return;
    }

    console.log('conn:', addressValue, portRemote);

    // 发送一个成功的响应给客户端
    ws.send(new Uint8Array([version[0], 0]));

    try {
      // 使用 createWebSocketStream() 创建双工流对象
      const wsStream = createWebSocketStream(ws);

      // 创建 TCP 连接到目标网站
      const tcpSocket = net.createConnection({ host: addressValue, port: portRemote }, () => {
        console.log('Connected to target website.');

        const rawClientData = vlessBuffer.slice(addressValueIndex + addressLength);
        tcpSocket.write(rawClientData);

        wsStream.pipe(tcpSocket).pipe(wsStream);
      });

      wsStream.on('close', () => {
        console.log('WebSocket Stream closed.');
        tcpSocket.end();
      });

      wsStream.on('error', (error) => {
        console.error('WebSocket Stream error:', error);
        tcpSocket.end();
      });

      tcpSocket.on('end', () => {
        console.log('Connection to target website closed.');
      });

      tcpSocket.on('error', (err) => {
        console.error('Error connecting to target website:', err);
      });

    } catch (err) {
      console.error("WebSocket Connection Error:", err);
    }
  }

  fastify.register(async function (fastify) {
    fastify.get(`/${WS_PATH}`, { websocket: true }, (connection, req) => {
      const ws = connection.socket;

      console.log('WebSocket connection established.');

      ws.on("message", (msg) => {
        console.log('Received message:', Buffer.from(msg).toString());

        handleMessage(msg, ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });

      ws.on('close', (code, reason) => {
        console.log(`WebSocket closed with code ${code} and reason: ${reason}`);
      });
    });
  });

  function getDomainPrefix(hostname) {
    return hostname.split('.')[0];
  }

  const PREFER_DOMAINS = [
    "www.visa.com.hk", "www.visa.cn", "www.mastercard.com.hk", "www.paypal.com",
    "ip.sb", "time.is", "speed.cloudflare.com", "www.udemy.com",
    "www.shopify.com", "www.vimeo.com", "www.digitalocean.com",
    "icook.tw", "www.skyscanner.jp", "singapore.com", "japan.com", "www.hktv.com.hk",
    "dash.cloudflare.com", "workers.dev", "pages.dev", "cdnjs.cloudflare.com",
    "www.who.int", "www.un.org", "www.csgo.com", "update.microsoft.com", "gateway.icloud.com",
    "ip.164746.xyz", "cdn.2020111.xyz", "bestcf.top", "cfip.cfcdn.vip", "freeyx.cloudflare88.eu.org", "cfip.xxxxxxxx.tk", "saas.sin.fan", "cf.090227.xyz", "cloudflare.182682.xyz", "bestcf.030101.xyz"
  ];

  fastify.get("/sub", async (request, reply) => {
    if (request.query.token != AUTHORIZATION_TOKEN) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const ENABLE_HTTP_UPGRADE = request.query.type === 'upgrade';

    const NODE_NAME = require("os").hostname();

    let hostname = request.hostname;
    if (request.headers["x-forwarded-host"]) {
      hostname = request.headers["x-forwarded-host"];
    }

    const host = process.env.DOMAIN ? process.env.DOMAIN.split(',')[0] : hostname;

    const selectedPrefers = PREFER_DOMAINS
      .sort(() => Math.random() - 0.5)
      .slice(0, 6);

    const addressPool = [host, ...selectedPrefers];

    const nodes = [];

    const transportPath = ENABLE_HTTP_UPGRADE ? HTTP_UPGRADE_PATH : WS_PATH;

    addressPool.forEach(addr => {
      const isDirect = (addr === host);
      const tag = isDirect ? "直连" : "优选";

      const vlessQs = new URLSearchParams({
        encryption: 'none',
        security: 'tls',
        sni: host,
        type: ENABLE_HTTP_UPGRADE ? 'httpupgrade' : 'ws',
        host: host,
        path: `/${transportPath}`
      }).toString();

      nodes.push(`vless://${UUID}@${addr}:443?${vlessQs}#${addr}-VLESS-${tag}`);
    });

    const finalContent = nodes.sort(() => Math.random() - 0.5).join('\n');

    return Buffer.from(finalContent).toString('base64');
  });

  return fastify;
}

const app = init();

app.listen({ port, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`server listening on ${address}`);
});
