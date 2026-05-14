const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startWsServer: (port) => ipcRenderer.invoke('start-ws-server', port),
  stopWsServer: () => ipcRenderer.invoke('stop-ws-server'),
  getWsStatus: () => ipcRenderer.invoke('get-ws-status'),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
});
