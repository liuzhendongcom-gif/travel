/**
 * WebSocket 推送封装
 * 替代 Electron 的 win.webContents.send()
 * 每个会话 (sessionId) 对应一个 WebSocket 连接
 *
 * H3 安全模型：同 web 版 ws-handler
 * WebSocket 握手时服务端生成 sessionToken 下发，HTTP 请求须携带 x-session-token
 */

const crypto = require('crypto');

const sessions = new Map(); // sessionId → { ws, records[], token }

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { ws: null, records: [], token: null });
  }
  return sessions.get(sessionId);
}

function registerWs(sessionId, ws) {
  const session = getSession(sessionId);
  session.ws = ws;

  const sessionToken = crypto.randomBytes(32).toString('hex');
  session.token = sessionToken;
  try {
    ws.send(JSON.stringify({ type: 'session-token', token: sessionToken }));
  } catch (_) {}

  ws.on('close', () => {
    session.ws = null;
  });
}

function verifySession(req) {
  const sessionId = req.headers['x-session-id'];
  const sessionToken = req.headers['x-session-token'];
  if (!sessionId || !sessionToken) return null;
  const session = sessions.get(sessionId);
  if (!session || !session.token) return null;
  try {
    const expected = Buffer.from(session.token, 'hex');
    const provided = Buffer.from(sessionToken, 'hex');
    if (expected.length !== provided.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;
  } catch (_) {
    return null;
  }
  return sessionId;
}

function send(sessionId, type, data) {
  const session = sessions.get(sessionId);
  if (!session?.ws) return;
  try {
    session.ws.send(JSON.stringify({ type, ...data }));
  } catch (_) {}
}

function getRecords(sessionId) {
  return sessions.get(sessionId)?.records || [];
}

function setRecords(sessionId, records) {
  getSession(sessionId).records = records;
}

function clearSession(sessionId) {
  sessions.delete(sessionId);
}

module.exports = { registerWs, send, getRecords, setRecords, clearSession, verifySession };
