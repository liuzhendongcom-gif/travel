const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.docx', '.txt']);
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_AI_CONTENT_CHARS = 50000;
const MAX_CLIPBOARD_CHARS = 50000;
const MAX_TOKEN_LEN = 512;
const MAX_MODEL_LEN = 128;
const MAX_BASE_URL_LEN = 512;
const MAX_FILES_PER_BATCH = 100;

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 6) return '***';
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return true;

  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function validateBaseUrl(raw) {
  const val = String(raw || '').trim();
  if (!val) throw new Error('Base URL 不能为空');
  if (val.length > MAX_BASE_URL_LEN) throw new Error('Base URL 过长');

  let parsed;
  try {
    parsed = new URL(val);
  } catch (_) {
    throw new Error('Base URL 格式无效');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL 仅支持 http/https');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('Base URL 不允许指向本机或内网地址');
  }
  return val.replace(/\/+$/, '');
}

function validateModelName(raw) {
  const val = String(raw || '').trim();
  if (!val) throw new Error('模型名称不能为空');
  if (val.length > MAX_MODEL_LEN) throw new Error('模型名称过长');
  if (!/^[a-zA-Z0-9._\-:\/]+$/.test(val)) {
    throw new Error('模型名称包含非法字符');
  }
  return val;
}

function validateToken(raw) {
  const val = String(raw || '').trim();
  if (!val || val.length < 8) throw new Error('请输入有效的 API Key（至少 8 个字符）');
  if (val.length > MAX_TOKEN_LEN) throw new Error('API Key 过长');
  return val;
}

function resolveTokenInput(inputToken, existingToken) {
  const val = String(inputToken || '').trim();
  if (!val) throw new Error('请输入有效的 API Key（至少 8 个字符）');
  if (val.includes('***')) {
    if (!existingToken) throw new Error('请重新输入完整的 API Key');
    return existingToken;
  }
  return validateToken(val);
}

function validateConcurrency(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, Math.floor(n)));
}

function assertSafeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('文件路径无效');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error('仅支持绝对路径文件');
  }

  let resolved;
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('文件不存在，请确认文件路径是否正确');
    throw new Error('文件路径无法访问');
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    throw new Error('文件不存在，请确认文件路径是否正确');
  }
  if (!stat.isFile()) throw new Error('路径不是普通文件');
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（>${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB）`);
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`不支持的文件格式: ${ext}`);
  }
  return resolved;
}

function validateIncomingFiles(files) {
  if (!Array.isArray(files)) throw new Error('文件列表无效');
  if (files.length === 0) throw new Error('没有可识别的文件');
  if (files.length > MAX_FILES_PER_BATCH) {
    throw new Error(`单次最多处理 ${MAX_FILES_PER_BATCH} 个文件`);
  }

  return files.map((file, idx) => {
    const id = String(file?.id || `file-${idx}`);
    const name = String(file?.name || path.basename(file?.path || 'unknown')).slice(0, 255);
    const safePath = assertSafeFilePath(file?.path);
    return { id, name, path: safePath };
  });
}

function assertOpenablePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('路径无效');
  }
  if (!path.isAbsolute(targetPath)) {
    throw new Error('仅允许打开绝对路径');
  }

  const resolved = fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const allowedRoots = [
    downloadsDir,
    path.join(os.homedir(), '.travel-reimbursement'),
  ];

  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root) + path.sep;
    return resolved === path.resolve(root) || resolved.startsWith(normalizedRoot);
  });
  if (!allowed) {
    throw new Error('仅允许打开下载目录或应用配置目录中的路径');
  }
  return resolved;
}

function clampText(text, maxLen) {
  const val = String(text ?? '');
  if (val.length > maxLen) return val.slice(0, maxLen);
  return val;
}

function truncateForAI(text) {
  const val = String(text ?? '');
  if (val.length <= MAX_AI_CONTENT_CHARS) return val;
  return val.slice(0, MAX_AI_CONTENT_CHARS) + '\n[内容已截断]';
}

module.exports = {
  ALLOWED_EXTS,
  MAX_FILE_BYTES,
  MAX_AI_CONTENT_CHARS,
  maskToken,
  validateBaseUrl,
  validateModelName,
  validateToken,
  resolveTokenInput,
  validateConcurrency,
  assertSafeFilePath,
  validateIncomingFiles,
  assertOpenablePath,
  clampText,
  truncateForAI,
};
