const { ipcMain, shell, clipboard } = require('electron');
const { prepareForAI } = require('./file-processor');
const { recognizeReceipt } = require('./ai-service');
const { groupByTrip, buildTripSummary } = require('./trip-grouper');
const { buildOutput, sanitizeName } = require('./output-builder');
const { getToken, saveToken, clearToken, getFullConfig, saveFullConfig } = require('./token-store');
const {
  maskToken,
  validateToken,
  resolveTokenInput,
  validateModelName,
  validateBaseUrl,
  validateConcurrency,
  validateIncomingFiles,
  assertOpenablePath,
  clampText,
} = require('./security');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_FILE = path.join(os.homedir(), '.travel-reimbursement', 'debug.log');
function debugLog(...args) {
  const safeArgs = args.map((arg) => {
    const text = String(arg);
    return text.replace(/(sk-|apikey|token)[^\s]*/gi, '[REDACTED]');
  });
  const line = new Date().toISOString() + ' ' + safeArgs.join(' ') + '\n';
  const cfg = getFullConfig();
  if (cfg.debugLog !== false) {
    try {
      const dir = path.dirname(LOG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(LOG_FILE, line);
    } catch (_) {}
  }
  console.log(...safeArgs);
}

let recognizedRecords = [];
let isProcessingFiles = false;
let isExporting = false;

// 判断是否为 API 认证错误（无 Key 或 401）
function isApiAuthError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const status = err.status || err.statusCode;
  return status === 401
    || msg.includes('未配置 API Key')
    || msg.includes('authentication_error')
    || msg.includes('invalid_api_key')
    || msg.toLowerCase().includes('unauthorized');
}

function registerHandlers(win) {
  // 每次注册新窗口时重置全局状态，防止 macOS 重开窗口后残留旧数据
  recognizedRecords = [];
  isProcessingFiles = false;
  isExporting = false;

  const send = (event, data) => {
    if (!win.isDestroyed()) win.webContents.send(event, data);
  };

  const channels = [
    'process:files',
    'process:preview',
    'process:export',
    'open:folder',
    'copy:text',
    'config:get-token',
    'config:set-token',
    'config:clear-token',
    'config:get-settings',
    'config:set-settings',
    'config:clear-log',
    'config:get-log-size',
  ];
  channels.forEach(ch => { try { ipcMain.removeHandler(ch); } catch (_) {} });

  ipcMain.handle('process:files', async (_, files) => {
    if (isProcessingFiles) throw new Error('正在识别中，请稍候');
    isProcessingFiles = true;
    recognizedRecords = [];

    try {
      const safeFiles = validateIncomingFiles(files);
      const cfg = getFullConfig();
      const concurrency = validateConcurrency(cfg.concurrency);
      const ocrEngine = (() => {
        try {
          const { app } = require('electron');
          if (app.isPackaged) return 'vision';
        } catch (_) {}
        return cfg.ocrEngine === 'tesseract' ? 'tesseract' : 'vision';
      })();

      const queue = [...safeFiles];
      const inFlight = new Set();
      let authFailed = false; // 认证失败时中止队列

      async function processOne(file) {
        send('process:file-start', { fileId: file.id, name: file.name });

        try {
          debugLog(`[prepareForAI] 开始处理: ${path.basename(file.path)} ocrEngine=${ocrEngine}`);
          const prepared = await prepareForAI(file.path, { ocrEngine });
          debugLog(`[prepareForAI] 完成: inputType=${prepared.inputType} len=${prepared.content.length}`);
          const result = await recognizeReceipt(prepared.inputType, prepared.content);
          debugLog(`[AI] 识别完成: type=${result.type}`);

          result._fileId = file.id;
          result._fileName = file.name;
          result._filePath = file.path;
          recognizedRecords.push(result);

          send('process:file-done', { fileId: file.id, result });
        } catch (err) {
          debugLog(`[ERROR] 识别失败 [${file.name}]: ${err.message}`);
          if (isApiAuthError(err)) {
            // 认证错误：标记中止，通知渲染进程弹出设置（只发一次）
            if (!authFailed) {
              authFailed = true;
              queue.length = 0; // 清空剩余队列，不再继续
              send('process:need-setup', {});
            }
            // 把当前文件标为待重试状态（不算 error）
            send('process:file-pending', { fileId: file.id });
          } else {
            send('process:file-error', { fileId: file.id, error: err.message });
          }
        }

        await new Promise(r => setTimeout(r, 300));
      }

      while (queue.length > 0 || inFlight.size > 0) {
        while (queue.length > 0 && inFlight.size < concurrency) {
          const file = queue.shift();
          const task = processOne(file).finally(() => { inFlight.delete(task); });
          inFlight.add(task);
        }
        if (inFlight.size > 0) {
          await Promise.race(inFlight);
        }
      }

      return { total: safeFiles.length, success: recognizedRecords.length, authFailed };
    } finally {
      isProcessingFiles = false;
    }
  });

  ipcMain.handle('process:preview', async () => {
    if (recognizedRecords.length === 0) {
      throw new Error('没有已识别的票据');
    }
    const trips = groupByTrip(recognizedRecords);
    return trips.map(t => ({
      id: t.id,
      name: t.name,
      count: t.records.length,
      totalAmount: t.records.reduce((s, r) => s + (Number(r.amount) || 0), 0),
      items: t.records.map(r => ({
        type: r.type,
        date: r.date,
        amount: r.amount,
        description: r.description,
        fileName: r._fileName,
      })),
    }));
  });

  ipcMain.handle('process:export', async () => {
    if (isExporting) throw new Error('正在生成报销包，请稍候');
    if (recognizedRecords.length === 0) {
      throw new Error('没有已识别的票据，请先上传并识别文件');
    }

    isExporting = true;
    try {
      send('process:progress', { message: '正在按行程分组...' });
      const trips = groupByTrip(recognizedRecords);

      send('process:progress', { message: `分为 ${trips.length} 个行程，正在生成文件...` });
      const { zipPath, folderPath } = await buildOutput(trips);

      const tripCards = trips.map(trip => {
        const summary = buildTripSummary(trip);
        const tripFolderPath = path.join(folderPath, sanitizeName(trip.name));
        return {
          id: trip.id,
          name: trip.name,
          folderPath: tripFolderPath,
          unmatched: trip._unmatched || false,
          ...summary,
        };
      });

      send('process:export-done', { zipPath, folderPath, tripCount: trips.length, tripCards });
      return { zipPath, folderPath };
    } finally {
      isExporting = false;
    }
  });

  ipcMain.handle('open:folder', async (_, folderPath) => {
    const safePath = assertOpenablePath(folderPath);
    const err = await shell.openPath(safePath);
    if (err) throw new Error(err);
    return { ok: true };
  });

  ipcMain.handle('copy:text', async (_, text) => {
    clipboard.writeText(clampText(text, 50000, '复制内容'));
    return { ok: true };
  });

  ipcMain.handle('config:get-token', async () => {
    const token = getToken();
    return { hasToken: Boolean(token), token: maskToken(token || '') };
  });

  ipcMain.handle('config:set-token', async (_, token) => {
    const val = validateToken(token);
    saveToken(val);
    process.env.ANTHROPIC_API_KEY = val;
    return { ok: true };
  });

  ipcMain.handle('config:clear-token', async () => {
    clearToken();
    delete process.env.ANTHROPIC_API_KEY;
    return { ok: true };
  });

  ipcMain.handle('config:get-settings', async () => {
    const cfg = getFullConfig();
    return {
      ...cfg,
      token: maskToken(cfg.token),
      hasToken: Boolean(cfg.token),
    };
  });

  ipcMain.handle('config:set-settings', async (_, cfg) => {
    const existing = getFullConfig();
    const config = {
      token: resolveTokenInput(cfg?.token, existing.token),
      model: validateModelName(cfg?.model),
      baseUrl: validateBaseUrl(cfg?.baseUrl),
      concurrency: validateConcurrency(cfg?.concurrency),
      ocrEngine: cfg?.ocrEngine === 'tesseract' ? 'tesseract' : 'vision',
      debugLog: cfg?.debugLog !== false,
      dedupCheck: cfg?.dedupCheck !== false,
      fxTarget: ['CNY', 'HKD'].includes(cfg?.fxTarget) ? cfg.fxTarget : 'CNY',
    };
    saveFullConfig(config);
    process.env.ANTHROPIC_API_KEY = config.token;
    return { ok: true };
  });

  ipcMain.handle('config:clear-log', async () => {
    try {
      if (fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, '', 'utf8');
      }
      return { ok: true };
    } catch (e) {
      throw new Error('清除日志失败: ' + e.message);
    }
  });

  ipcMain.handle('config:get-log-size', async () => {
    try {
      if (fs.existsSync(LOG_FILE)) {
        return fs.statSync(LOG_FILE).size;
      }
      return 0;
    } catch (_) {
      return 0;
    }
  });
}

module.exports = { registerHandlers };
