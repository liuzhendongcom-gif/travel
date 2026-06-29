const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  saveToken: (cfg) => ipcRenderer.send('setup:save-token', cfg),
  skip:      ()    => ipcRenderer.send('setup:skip'),
});
