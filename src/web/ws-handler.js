/**
 * WebSocket 推送封装
 * 替代 Electron 的 win.webContents.send()
 * 每个会话 (sessionId) 对应一个 WebSocket 连接
 *
 * H3 安全模型：
 * - sessionId 由客户端提供（用于路由），但不足以访问数据
 * - WebSocket 握手时服务端生成 sessionToken（强随机），通过 WS 消息下发给客户端
 * - HTTP 请求（/files、/export 等）必须在 x-session-token 头携带此 token
 * - 服务端校验 sessionId + sessionToken 必须匹配才允许操作
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

  // 生成强随机 session token 并下发给客户端
  const sessionToken = crypto.randomBytes(32).toString('hex');
  session.token = sessionToken;
  try {
    ws.send(JSON.stringify({ type: 'session-token', token: sessionToken }));
  } catch (_) {}

  ws.on('close', () => {
    // 连接关闭时不立即删除 session，保留 records 供 export 使用
    session.ws = null;
  });
}

/**
 * 验证 HTTP 请求的 session 身份：
 * x-session-id + x-session-token 必须匹配服务端记录
 */
function verifySession(req) {
  const sessionId = req.headers['x-session-id'];
  const sessionToken = req.headers['x-session-token'];
  if (!sessionId || !sessionToken) return null;
  const session = sessions.get(sessionId);
  if (!session || !session.token) return null;
  // 使用恒时比较防止时序攻击
  const expected = Buffer.from(session.token, 'hex');
  const provided = Buffer.from(sessionToken, 'hex');
  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;
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
