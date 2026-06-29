const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.travel-reimbursement', 'config.json');

function getToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.token) return cfg.token;
  } catch (_) {}

  return null;
}

function saveToken(token) {
  // 读取现有配置并 merge，避免覆写 model/baseUrl/concurrency 等其他字段
  const existing = getFullConfig();
  saveFullConfig({ ...existing, token });
}

function clearToken() {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  } catch (_) {}
}

const DEFAULT_BASE_URL = 'http://devpilot.zhonganonline.com/devpilot/v1/external/direct/claudecode';
const DEFAULT_MODEL    = 'claude-sonnet-4-6';

function getFullConfig() {
  const cfg = {
    token: '',
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    concurrency: 1,
    ocrEngine: 'vision',
    debugLog: true,
    dedupCheck: true,
    fxTarget: 'CNY',
  };
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (saved.token) cfg.token = saved.token;
    if (saved.model) cfg.model = saved.model;
    if (saved.baseUrl) cfg.baseUrl = saved.baseUrl;
    if (saved.concurrency != null) cfg.concurrency = Number(saved.concurrency);
    if (saved.ocrEngine) cfg.ocrEngine = saved.ocrEngine;
    if (saved.debugLog !== undefined) cfg.debugLog = Boolean(saved.debugLog);
    if (saved.dedupCheck !== undefined) cfg.dedupCheck = Boolean(saved.dedupCheck);
    // 向后兼容旧版 fxConversion boolean
    if (['CNY', 'HKD'].includes(saved.fxTarget)) {
      cfg.fxTarget = saved.fxTarget;
    } else if (saved.fxConversion === true) {
      // L1：仅当旧版明确开启时才设为 CNY；false/undefined 保持默认，不强制开启
      cfg.fxTarget = 'CNY';
    }
  } catch (_) {}
  return cfg;
}

function saveFullConfig(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    token: cfg.token || '',
    model: cfg.model || '',
    baseUrl: cfg.baseUrl || '',
    concurrency: cfg.concurrency != null ? Number(cfg.concurrency) : 1,
    ocrEngine: cfg.ocrEngine === 'tesseract' ? 'tesseract' : 'vision',
    debugLog: cfg.debugLog !== false,
    dedupCheck: cfg.dedupCheck !== false,
    fxTarget: ['CNY', 'HKD'].includes(cfg.fxTarget) ? cfg.fxTarget : 'CNY',
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600); // 修正已存在文件的权限
}

module.exports = { CONFIG_PATH, DEFAULT_BASE_URL, DEFAULT_MODEL, getToken, saveToken, clearToken, getFullConfig, saveFullConfig };

