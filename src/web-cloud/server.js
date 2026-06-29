const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { getFullConfig } = require('./token-store');
const { registerWs } = require('./ws-handler');

const app = express();

app.use(express.json());

// 路由（在静态文件前注册，优先匹配）
app.use('/api/config',   require('./routes/config'));
app.use('/api/process',  require('./routes/process'));
app.use('/api/download', require('./routes/download'));

// 静态资源（CSS、图片等）
app.use(express.static(path.join(__dirname, 'renderer'), { index: false }));
// assets 目录（logo、图标等）映射到 /assets/
app.use('/assets', express.static(path.join(__dirname, '../../assets')));

// 所有页面路径返回 index.html
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'renderer/index.html'));
});

// 启动时加载 token 到环境变量
const cfg = getFullConfig();
if (cfg.token) process.env.ANTHROPIC_API_KEY = cfg.token;

const server = http.createServer(app);

// WebSocket 同端口
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    if (!sessionId) { ws.close(); return; }
    registerWs(sessionId, ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`差旅报销助手 Web 版已启动：http://localhost:${PORT}`);
});
