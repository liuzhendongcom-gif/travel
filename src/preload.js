const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 单监听器辅助——每次注册前移除旧监听，确保只有一个回调生效
function singleListener(channel) {
  let currentHandler = null;
  return (cb) => {
    if (currentHandler) ipcRenderer.removeListener(channel, currentHandler);
    currentHandler = (_, data) => cb(data);
    ipcRenderer.on(channel, currentHandler);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  processFiles: (files) => ipcRenderer.invoke('process:files', files),
  previewTrips: () => ipcRenderer.invoke('process:preview'),
  exportPackage: () => ipcRenderer.invoke('process:export'),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  copyText: (text) => ipcRenderer.invoke('copy:text', text),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  getTokenConfig: () => ipcRenderer.invoke('config:get-token'),
  saveTokenConfig: (token) => ipcRenderer.invoke('config:set-token', token),
  clearTokenConfig: () => ipcRenderer.invoke('config:clear-token'),
  getSettings: () => ipcRenderer.invoke('config:get-settings'),
  saveSettings: (cfg) => ipcRenderer.invoke('config:set-settings', cfg),
  clearDebugLog: () => ipcRenderer.invoke('config:clear-log'),
  getDebugLogSize: () => ipcRenderer.invoke('config:get-log-size'),

  onFileStart:   singleListener('process:file-start'),
  onFileDone:    singleListener('process:file-done'),
  onFileError:   singleListener('process:file-error'),
  onFilePending: singleListener('process:file-pending'),
  onExportDone:  singleListener('process:export-done'),
  onProgress:    singleListener('process:progress'),
  onNeedSetup:   singleListener('process:need-setup'),
  onSetupSaved:  singleListener('setup:saved'),
  requestSetup:  () => ipcRenderer.send('setup:request'),
});
