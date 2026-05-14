const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startServer: (port) => ipcRenderer.send('start-server', port),
  stopServer: () => ipcRenderer.send('stop-server'),
  getServerStatus: () => ipcRenderer.sendSync('get-server-status'),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  broadcastData: (data) => ipcRenderer.send('broadcast-data', data),
  onClientCount: (callback) => {
    ipcRenderer.on('client-count', (event, count) => callback(count));
  }
});
