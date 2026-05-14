const { contextBridge, ipcRenderer } = require('electron');

// 安全桥接：暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 选择 SMB 共享文件夹路径
  selectSmbPath: () => ipcRenderer.invoke('select-smb-path'),
  
  // 设置 SMB 路径（初始化连接）
  setSmbPath: (smbPath) => ipcRenderer.invoke('set-smb-path', smbPath),
  
  // 获取当前 SMB 路径
  getSmbPath: () => ipcRenderer.invoke('get-smb-path'),
  
  // 从服务器读取数据
  readData: () => ipcRenderer.invoke('read-data'),
  
  // 写入数据到服务器
  writeData: (data) => ipcRenderer.invoke('write-data', data),
  
  // 获取当前数据版本
  getVersion: () => ipcRenderer.invoke('get-version'),
  
  // 检查连接状态
  checkConnection: () => ipcRenderer.invoke('check-connection'),
  
  // 启动轮询（检测远程变化）
  startPolling: (intervalMs) => ipcRenderer.invoke('start-polling', intervalMs),
  
  // 停止轮询
  stopPolling: () => ipcRenderer.invoke('stop-polling'),
  
  // 监听数据更新（远程变化回调）
  onDataUpdated: (callback) => {
    const handler = (event, newData) => callback(newData);
    ipcRenderer.on('data-updated', handler);
    // 返回移除监听器的函数
    return () => ipcRenderer.removeListener('data-updated', handler);
  },
  
  // 监听连接状态变化
  onConnectionChange: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('connection-change', handler);
    return () => ipcRenderer.removeListener('connection-change', handler);
  }
});