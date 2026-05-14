const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

log.transports.file.level = 'info';
log.transports.console.level = 'debug';

let mainWindow = null;
let currentSmbPath = null;
let pollInterval = null;
let lastKnownVersion = 0;

// ================================================================
// 窗口创建
// ================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'NICT 吊数计算器 V2.0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pollInterval) clearInterval(pollInterval);
  });

  log.info('[Main] Window created');
}

// ================================================================
// 文件路径工具
// ================================================================
function getSmbBase() { return currentSmbPath; }
function getShipsPath() { return path.join(getSmbBase(), 'ships.json'); }
function getChangelogDir() { return path.join(getSmbBase(), 'changelog'); }
function getSyncLockPath() { return path.join(getSmbBase(), 'sync.lock'); }
function getVersionPath() { return path.join(getSmbBase(), 'version.txt'); }

// ================================================================
// 文件锁机制
// ================================================================
async function acquireLock(maxWaitMs = 10000) {
  const lockPath = getSyncLockPath();
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      // 尝试创建锁文件（排他模式）
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      log.info('[Lock] Acquired lock');
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // 锁存在，检查是否 stale
        try {
          const pid = parseInt(fs.readFileSync(lockPath, 'utf8'));
          // 检查进程是否还活着（简单的检查）
          try {
            process.kill(pid, 0);
            // 进程还活着，等待
          } catch (e) {
            // 进程不存在，删除 stale 锁
            log.warn('[Lock] Removing stale lock');
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (e) {
          // 无法读取锁文件，删除并重试
          try { fs.unlinkSync(lockPath); } catch (e2) {}
        }
        await sleep(200);
      } else {
        throw err;
      }
    }
  }
  throw new Error('无法获取文件锁，等待超时');
}

function releaseLock() {
  const lockPath = getSyncLockPath();
  try {
    fs.unlinkSync(lockPath);
    log.info('[Lock] Released lock');
  } catch (err) {
    log.warn('[Lock] Failed to release lock:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================================================================
// 版本控制
// ================================================================
async function readVersion() {
  const vp = getVersionPath();
  try {
    return parseInt(fs.readFileSync(vp, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

async function writeVersion(v) {
  const vp = getVersionPath();
  fs.writeFileSync(vp, String(v), 'utf8');
}

// ================================================================
// changelog
// ================================================================
async function appendChangelog(action, data) {
  const dir = getChangelogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `change_${ts}_${Date.now()}.json`;
  const fpath = path.join(dir, fname);
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    data,
    pid: process.pid,
    version: lastKnownVersion + 1
  };
  fs.writeFileSync(fpath, JSON.stringify(entry, null, 2), 'utf8');
  log.info('[Changelog] Wrote', action, fname);
}

// ================================================================
// IPC: 选择 SMB 路径
// ================================================================
ipcMain.handle('select-smb-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择共享文件夹路径',
    message: '请选择包含 ships.json 的共享文件夹路径（SMB 共享）',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// ================================================================
// IPC: 设置 SMB 路径
// ================================================================
ipcMain.handle('set-smb-path', async (event, smbPath) => {
  currentSmbPath = smbPath;
  log.info('[SMB] Path set to:', smbPath);
  
  // 初始化服务器端文件（如果不存在）
  const shipsPath = getShipsPath();
  if (!fs.existsSync(shipsPath)) {
    try {
      await acquireLock();
      const initData = {
        version: 1,
        lastModified: new Date().toISOString(),
        groups: {}
      };
      fs.writeFileSync(shipsPath, JSON.stringify(initData, null, 2), 'utf8');
      await writeVersion(1);
      await appendChangelog('init', { groups: {} });
      releaseLock();
    } catch (err) {
      log.error('[SMB] Init failed:', err);
      releaseLock();
      throw err;
    }
  }
  
  return true;
});

// ================================================================
// IPC: 读取数据
// ================================================================
ipcMain.handle('read-data', async () => {
  if (!currentSmbPath) return null;
  const shipsPath = getShipsPath();
  
  try {
    await acquireLock(5000);
    const raw = fs.readFileSync(shipsPath, 'utf8');
    const data = JSON.parse(raw);
    lastKnownVersion = data.version || 0;
    releaseLock();
    log.debug('[SMB] Read data, version:', lastKnownVersion);
    return data;
  } catch (err) {
    releaseLock();
    log.error('[SMB] Read failed:', err.message);
    throw err;
  }
});

// ================================================================
// IPC: 写入数据
// ================================================================
ipcMain.handle('write-data', async (event, newData) => {
  if (!currentSmbPath) throw new Error('未设置 SMB 路径');
  
  try {
    await acquireLock();
    
    // 读取当前版本
    const shipsPath = getShipsPath();
    let currentData = { version: 0, groups: {} };
    try {
      const raw = fs.readFileSync(shipsPath, 'utf8');
      currentData = JSON.parse(raw);
    } catch (e) {
      // 文件不存在或格式错误，使用空数据
    }
    
    const currentVersion = currentData.version || 0;
    
    // 版本冲突检测
    if (newData.version !== undefined && newData.version !== currentVersion) {
      releaseLock();
      log.warn('[SMB] Version conflict:', newData.version, '!=', currentVersion);
      return {
        conflict: true,
        currentVersion,
        incomingVersion: newData.version,
        currentData
      };
    }
    
    // 写入新数据
    const newVersion = currentVersion + 1;
    const updatedData = {
      ...newData,
      version: newVersion,
      lastModified: new Date().toISOString()
    };
    
    fs.writeFileSync(shipsPath, JSON.stringify(updatedData, null, 2), 'utf8');
    await writeVersion(newVersion);
    lastKnownVersion = newVersion;
    
    await appendChangelog('update', { groups: newData.groups });
    releaseLock();
    
    log.info('[SMB] Wrote data, new version:', newVersion);
    return { success: true, version: newVersion };
    
  } catch (err) {
    releaseLock();
    log.error('[SMB] Write failed:', err);
    throw err;
  }
});

// ================================================================
// IPC: 获取当前版本
// ================================================================
ipcMain.handle('get-version', async () => {
  return lastKnownVersion;
});

// ================================================================
// IPC: 获取 SMB 路径
// ================================================================
ipcMain.handle('get-smb-path', async () => {
  return currentSmbPath;
});

// ================================================================
// IPC: 检查连接状态
// ================================================================
ipcMain.handle('check-connection', async () => {
  if (!currentSmbPath) return { connected: false, reason: 'no_path' };
  try {
    const shipsPath = getShipsPath();
    fs.accessSync(shipsPath, fs.constants.R_OK);
    return { connected: true };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
});

// ================================================================
// 轮询变化检测
// ================================================================
let pollTimer = null;
let lastLocalModified = null;

function startPolling(callback, intervalMs = 2000) {
  if (pollTimer) clearInterval(pollTimer);
  
  pollTimer = setInterval(async () => {
    if (!currentSmbPath) return;
    
    try {
      const shipsPath = getShipsPath();
      const stat = fs.statSync(shipsPath);
      const modified = stat.mtime.toISOString();
      
      if (lastLocalModified && modified !== lastLocalModified) {
        lastLocalModified = modified;
        const data = JSON.parse(fs.readFileSync(shipsPath, 'utf8'));
        callback(data);
      } else {
        lastLocalModified = modified;
      }
    } catch (err) {
      // 忽略轮询错误
    }
  }, intervalMs);
  
  log.info('[Poll] Started polling every', intervalMs, 'ms');
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log.info('[Poll] Stopped polling');
  }
}

ipcMain.handle('start-polling', async (event, intervalMs) => {
  startPolling((newData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('data-updated', newData);
    }
  }, intervalMs || 2000);
  return true;
});

ipcMain.handle('stop-polling', async () => {
  stopPolling();
  return true;
});

// ================================================================
// 初始化
// ================================================================
app.whenReady().then(() => {
  log.info('[App] Starting NICT Calculator V2.0');
  createWindow();
});

app.on('window-all-closed', () => {
  stopPolling();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

process.on('uncaughtException', (err) => {
  log.error('[App] Uncaught exception:', err);
});