const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

let mainWindow = null;
let wss = null;
let clients = new Set();
let sharedData = null;
let isServerRunning = false;
let serverPort = 8765;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'NICT 吊数计算器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopServer();
  });
}

// WebSocket 服务器
function startSyncServer(port) {
  if (wss) {
    stopServer();
  }

  serverPort = port || 8765;
  wss = new WebSocketServer({ port: serverPort });
  isServerRunning = true;
  clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);

    // 发送当前在线人数
    broadcastClientCount();

    // 发送完整数据给新连接
    if (sharedData) {
      ws.send(JSON.stringify({
        type: 'full_sync',
        data: sharedData,
        clients: clients.size
      }));
    }

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        handleServerMessage(ws, msg);
      } catch (e) {
        // ignore
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      broadcastClientCount();
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  wss.on('error', (err) => {
    console.log('WebSocket server error:', err.message);
  });

  return serverPort;
}

function stopServer() {
  if (wss) {
    clients.forEach(ws => ws.close());
    clients.clear();
    wss.close();
    wss = null;
    isServerRunning = false;
  }
}

function handleServerMessage(ws, msg) {
  if (msg.type === 'data_update') {
    // 更新共享数据
    if (msg.data) {
      sharedData = msg.data;
    }
    // 广播给所有其他客户端
    broadcast(ws, msg);
    broadcastClientCount();
  } else if (msg.type === 'request_full_sync') {
    // 发送完整数据
    if (sharedData) {
      ws.send(JSON.stringify({
        type: 'full_sync',
        data: sharedData,
        clients: clients.size
      }));
    }
  }
}

function broadcast(sender, msg) {
  const data = JSON.stringify(msg);
  clients.forEach(client => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function broadcastClientCount() {
  const count = clients.size + 1; // +1 for server itself
  const msg = JSON.stringify({ type: 'client_count', count: count });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
  // 通知渲染进程
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('client-count', count);
  }
}

// IPC 处理器
ipcMain.on('start-server', (event, port) => {
  const actualPort = startSyncServer(port);
  return actualPort;
});

ipcMain.on('stop-server', () => {
  stopServer();
});

ipcMain.on('get-server-status', (event) => {
  return {
    running: isServerRunning,
    port: serverPort,
    clients: clients.size
  };
});

ipcMain.on('get-local-ip', (event) => {
  const os = require('os');
  const ifs = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(ifs)) {
    for (const info of ifs[name]) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses[0] || '127.0.0.1';
});

ipcMain.on('broadcast-data', (event, data) => {
  if (wss && isServerRunning) {
    sharedData = data;
    const msg = JSON.stringify({ type: 'data_update', data: data, clients: clients.size + 1 });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }
});

ipcMain.handle('get-local-ip', async () => {
  const os = require('os');
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const info of ifs[name]) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
