const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.travel-reimbursement-cloud', 'config.json');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL    = 'claude-sonnet-4-6';

function getFullConfig() {
  const cfg = {
    token: '',
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    concurrency: 1,
    ocrEngine: 'tesseract',
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
    if (saved.debugLog !== undefined) cfg.debugLog = Boolean(saved.debugLog);
    if (saved.dedupCheck !== undefined) cfg.dedupCheck = Boolean(saved.dedupCheck);
    if (['CNY', 'HKD'].includes(saved.fxTarget)) {
      cfg.fxTarget = saved.fxTarget;
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
    ocrEngine: 'tesseract',
    debugLog: cfg.debugLog !== false,
    dedupCheck: cfg.dedupCheck !== false,
    fxTarget: ['CNY', 'HKD'].includes(cfg.fxTarget) ? cfg.fxTarget : 'CNY',
  }, null, 2), { mode: 0o600 });
}

module.exports = { CONFIG_PATH, DEFAULT_BASE_URL, DEFAULT_MODEL, getFullConfig, saveFullConfig };
