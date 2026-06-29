const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { registerHandlers } = require('./ipc-handlers');
const { getToken, saveFullConfig, getFullConfig } = require('./token-store');
const {
  resolveTokenInput,
  validateModelName,
  validateBaseUrl,
} = require('./security');

app.commandLine.appendSwitch('disable-gpu-sandbox');

function createMainWindow() {
  const win = new BrowserWindow({
    width: 794,
    height: 660,
    minWidth: 587,
    minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#EDEEF0',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

function createSetupWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, '../preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/setup.html'));
  return win;
}

// setup 窗口的通用挂载逻辑（供初次启动和"需要 API Key"时复用）
function mountSetupHandlers(setupWin, mainWin) {
  ipcMain.once('setup:save-token', (_, cfg) => {
    const existing = getFullConfig();
    const token = typeof cfg === 'string'
      ? resolveTokenInput(cfg, existing.token)
      : resolveTokenInput(cfg?.token, existing.token);
    const model = validateModelName(
      (typeof cfg === 'object' && cfg.model) ? cfg.model : existing.model
    );
    const baseUrl = validateBaseUrl(
      (typeof cfg === 'object' && cfg.baseUrl) ? cfg.baseUrl : existing.baseUrl
    );
    saveFullConfig({ ...existing, token, model, baseUrl });
    process.env.ANTHROPIC_API_KEY = token;
    setupWin.close();
    // 通知主窗口配置已保存，可以重试
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('setup:saved');
    }
  });

  ipcMain.once('setup:skip', () => {
    setupWin.close();
  });
}

app.whenReady().then(() => {
  const token = getToken();
  if (token) process.env.ANTHROPIC_API_KEY = token;

  // 直接打开主窗口，无论是否已配置 API Key
  const win = createMainWindow();
  registerHandlers(win);

  // 监听主窗口发来的"需要 API Key"请求，按需弹出 setup 窗口
  ipcMain.on('setup:request', () => {
    // 避免重复打开
    const existing = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('setup.html'));
    if (existing) { existing.focus(); return; }
    const setupWin = createSetupWindow();
    mountSetupHandlers(setupWin, win);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const t = getToken();
      if (t) process.env.ANTHROPIC_API_KEY = t;
      const w = createMainWindow();
      registerHandlers(w);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
