const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');

let mainWindow;
let wss = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'NICT 吊数计算器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// WebSocket 服务器功能
ipcMain.handle('start-ws-server', async (event, port) => {
  return new Promise((resolve, reject) => {
    if (wss) {
      resolve({ success: true, port: wss.options.port });
      return;
    }
    try {
      wss = new WebSocket.Server({ port });
      const clients = new Set();
      
      wss.on('connection', (ws) => {
        clients.add(ws);
        ws.on('message', (data) => {
          // 广播给所有客户端
          const msg = data.toString();
          clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(msg);
            }
          });
          // 同时发回发送者
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
          }
        });
        ws.on('close', () => {
          clients.delete(ws);
        });
      });
      
      wss.on('error', (err) => {
        wss = null;
        reject(err.message);
      });
      
      resolve({ success: true, port });
    } catch (e) {
      reject(e.message);
    }
  });
});

ipcMain.handle('stop-ws-server', async () => {
  return new Promise((resolve) => {
    if (wss) {
      wss.close();
      wss = null;
    }
    resolve({ success: true });
  });
});

ipcMain.handle('get-ws-status', async () => {
  return {
    running: wss !== null,
    port: wss ? wss.options.port : 0
  };
});

ipcMain.handle('get-local-ip', async () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
});
