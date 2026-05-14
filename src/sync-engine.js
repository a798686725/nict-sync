// ================================================================
// NICT 吊数计算器 - 同步引擎 V2.0
// 负责与 SMB 共享文件夹的数据同步
// ================================================================

const MAX_GROUPS = 9;
const POLL_INTERVAL = 2000; // 2秒轮询

// 存储：groupData 结构（内存中）
let groupData = [];
for (let gi = 0; gi < MAX_GROUPS; gi++) {
  groupData[gi] = { pages: [], pageCount: 0 };
}

// 状态
let smbPath = null;
let isConnected = false;
let isOfflineMode = false;
let localVersion = 0;
let pendingWrite = null;
let removeDataListener = null;
let pollTimer = null;

// ================================================================
// 初始化：检查 SMB 路径
// ================================================================
async function initSync() {
  // 检查 localStorage 中是否已有 SMB 路径
  const savedPath = localStorage.getItem('nictSmbPath');
  
  if (savedPath) {
    smbPath = savedPath;
    // 尝试连接
    try {
      await window.electronAPI.setSmbPath(smbPath);
      const check = await window.electronAPI.checkConnection();
      if (check.connected) {
        isConnected = true;
        await loadFromServer();
        startPolling();
        return true;
      } else {
        console.warn('[Sync] Saved path not accessible:', check.reason);
        isConnected = false;
        showReconnectDialog();
        return false;
      }
    } catch (err) {
      console.error('[Sync] Connection failed:', err);
      isConnected = false;
      showReconnectDialog();
      return false;
    }
  } else {
    // 首次运行，引导选择路径
    await promptSelectPath();
    
    // 更新连接状态指示
    const syncBtn = document.getElementById('syncStatus');
    if (syncBtn) syncBtn.textContent = isConnected ? '🟢 已连接' : '🔴 未连接';
    return true;
  }
}

// ================================================================
// 提示选择 SMB 路径
// ================================================================
async function promptSelectPath() {
  const selected = await window.electronAPI.selectSmbPath();
  if (!selected) {
    showNoPathDialog();
    return false;
  }
  
  smbPath = selected;
  localStorage.setItem('nictSmbPath', smbPath);
  
  try {
    await window.electronAPI.setSmbPath(smbPath);
    isConnected = true;
    await loadFromServer();
    startPolling();
    return true;
  } catch (err) {
    console.error('[Sync] Init failed:', err);
    isConnected = false;
    showErrorDialog('连接失败: ' + err.message);
    return false;
  }
}

// ================================================================
// 从服务器加载数据
// ================================================================
async function loadFromServer() {
  try {
    const serverData = await window.electronAPI.readData();
    if (!serverData) {
      console.warn('[Sync] No data from server');
      return;
    }
    
    localVersion = serverData.version || 0;
    
    // 转换 serverData.groups -> groupData
    convertServerToGroupData(serverData.groups || {});
    
    console.log('[Sync] Loaded from server, version:', localVersion);
    return true;
  } catch (err) {
    console.error('[Sync] Load failed:', err);
    throw err;
  }
}

// ================================================================
// 转换：服务器格式 -> groupData
// ================================================================
function convertServerToGroupData(serverGroups) {
  // 重置
  for (let gi = 0; gi < MAX_GROUPS; gi++) {
    groupData[gi] = { pages: [], pageCount: 0 };
  }
  
  // 遍历服务器数据
  for (let gi = 0; gi < MAX_GROUPS; gi++) {
    const groupKey = `group${gi}`;
    const serverGroup = serverGroups[groupKey];
    
    if (serverGroup && serverGroup.pages) {
      for (let pi = 0; pi < serverGroup.pages.length; pi++) {
        const page = serverGroup.pages[pi];
        if (page) {
          groupData[gi].pages[pi] = {
            shipName: page.shipName || '',
            estCompletionTime: page.estCompletionTime || '',
            departureTime: page.departureTime || '',
            naturalBay: page.naturalBay || '22-26',
            longCraneBay: page.longCraneBay || '22-32',
            qcData: page.qcData || [],
            remark: page.remark || ''
          };
          groupData[gi].pageCount = Math.max(groupData[gi].pageCount, pi + 1);
        }
      }
    }
  }
}

// ================================================================
// 转换：groupData -> 服务器格式
// ================================================================
function convertGroupDataToServer() {
  const serverGroups = {};
  
  for (let gi = 0; gi < MAX_GROUPS; gi++) {
    if (groupData[gi].pageCount === 0) continue;
    
    const pages = [];
    for (let pi = 0; pi < groupData[gi].pageCount; pi++) {
      const page = groupData[gi].pages[pi];
      if (page) {
        pages[pi] = {
          shipName: page.shipName || '',
          estCompletionTime: page.estCompletionTime || '',
          departureTime: page.departureTime || '',
          naturalBay: page.naturalBay || '22-26',
          longCraneBay: page.longCraneBay || '22-32',
          qcData: page.qcData || [],
          remark: page.remark || ''
        };
      }
    }
    
    serverGroups[`group${gi}`] = { pages };
  }
  
  return serverGroups;
}

// ================================================================
// 保存到服务器
// ================================================================
async function saveToServer(gi = null, pi = null) {
  if (!isConnected) {
    console.warn('[Sync] Not connected, cannot save');
    return;
  }
  
  try {
    const serverGroups = convertGroupDataToServer();
    const dataToWrite = { groups: serverGroups, version: localVersion };
    
    const result = await window.electronAPI.writeData(dataToWrite);
    
    if (result.conflict) {
      // 版本冲突
      console.warn('[Sync] Version conflict detected');
      await handleConflict(result, dataToWrite);
      return;
    }
    
    localVersion = result.version;
    console.log('[Sync] Saved, new version:', localVersion);
    
  } catch (err) {
    console.error('[Sync] Save failed:', err);
    // 网络错误，切换离线模式
    isConnected = false;
    showOfflineBanner();
  }
}

// ================================================================
// 冲突处理
// ================================================================
async function handleConflict(conflictResult, localData) {
  // 显示冲突对话框
  const userChoice = showConflictDialog(
    conflictResult.currentVersion,
    conflictResult.incomingVersion
  );
  
  if (userChoice === 'keep_local') {
    // 强制用本地版本（覆盖服务器）
    localData.version = conflictResult.currentVersion;
    const result = await window.electronAPI.writeData(localData);
    localVersion = result.version;
  } else if (userChoice === 'keep_remote') {
    // 用服务器版本（放弃本地）
    const serverGroups = conflictResult.currentData.groups || {};
    convertServerToGroupData(serverGroups);
    localVersion = conflictResult.currentVersion;
    // 通知渲染进程重新渲染
    notifyRenderUpdate();
  } else {
    // 取消，保留本地变更待稍后处理
    pendingWrite = localData;
  }
}

// ================================================================
// 轮询：检测远程变化
// ================================================================
function startPolling() {
  if (pollTimer) return;
  
  pollTimer = setInterval(async () => {
    if (!isConnected || isOfflineMode) return;
    
    try {
      const check = await window.electronAPI.checkConnection();
      if (!check.connected) {
        isConnected = false;
        showOfflineBanner();
        return;
      }
      
      // 读取远程数据
      const serverData = await window.electronAPI.readData();
      if (!serverData) return;
      
      const remoteVersion = serverData.version || 0;
      
      // 检测远程版本变化
      if (remoteVersion !== localVersion) {
        console.log('[Sync] Remote changed:', remoteVersion, '!= local:', localVersion);
        
        // 自动合并：如果本地没有待处理变更，直接应用远程
        if (!pendingWrite && !hasLocalChanges()) {
          convertServerToGroupData(serverData.groups || {});
          localVersion = remoteVersion;
          notifyRenderUpdate();
        } else {
          // 本地有待处理变更，提示冲突
          showPendingConflictDialog(remoteVersion);
        }
      }
    } catch (err) {
      console.warn('[Sync] Poll error:', err.message);
    }
  }, POLL_INTERVAL);
  
  console.log('[Sync] Polling started');
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (removeDataListener) {
    removeDataListener();
    removeDataListener = null;
  }
}

// ================================================================
// 检测本地是否有未保存变更
// ================================================================
let localChangeFlag = false;

function markLocalChanged() {
  localChangeFlag = true;
}

function clearLocalChanged() {
  localChangeFlag = false;
}

function hasLocalChanges() {
  return localChangeFlag;
}

// ================================================================
// 通知渲染进程更新
// ================================================================
function notifyRenderUpdate() {
  // 触发渲染进程的更新回调
  const event = new CustomEvent('sync-data-updated', {
    detail: { groupData, version: localVersion }
  });
  window.dispatchEvent(event);
}

// ================================================================
// 对话框：路径选择提示
// ================================================================
function showNoPathDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'sync-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 99999;
    display: flex; align-items: center; justify-content: center;
  `;
  overlay.innerHTML = `
    <div style="background:#fff; border-radius:16px; padding:40px; max-width:500px; text-align:center; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
      <h2 style="color:#1565c0; margin-bottom:20px; font-size:1.4em;">⚠️ 首次配置</h2>
      <p style="color:#333; margin-bottom:30px; line-height:1.6;">
        请选择共享文件夹路径（由 IT 部门提供）<br>
        文件夹内将自动创建 <code style="background:#f5f9ff; padding:2px 8px; border-radius:4px;">ships.json</code> 文件
      </p>
      <button id="btn-select-path" style="
        background:#1565c0; color:#fff; border:none; padding:12px 32px;
        border-radius:8px; font-size:1.1em; cursor:pointer;
      ">选择文件夹</button>
    </div>
  `;
  document.body.appendChild(overlay);
  
  document.getElementById('btn-select-path').onclick = async () => {
    overlay.remove();
    await promptSelectPath();
  };
}

// ================================================================
// 对话框：离线提示
// ================================================================
function showOfflineBanner() {
  let banner = document.getElementById('offline-banner');
  if (banner) return;
  
  banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 99998;
    background: linear-gradient(135deg, #c62828, #e53935);
    color: #fff; text-align: center; padding: 12px;
    font-size: 1em; font-weight: 600;
    box-shadow: 0 2px 12px rgba(198,40,40,0.4);
  `;
  banner.innerHTML = '⚠️ 网络断开 · 本地模式（更改将在恢复连接后同步）';
  document.body.insertBefore(banner, document.body.firstChild);
  
  // 更新状态指示
  const syncBtn = document.getElementById('syncStatus');
  if (syncBtn) syncBtn.textContent = '🔴 离线';
}

// ================================================================
// 对话框：冲突选择
// ================================================================
function showConflictDialog(currentVersion, incomingVersion) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6); z-index: 99999;
      display: flex; align-items: center; justify-content: center;
    `;
    overlay.innerHTML = `
      <div style="background:#fff; border-radius:16px; padding:40px; max-width:450px; text-align:center; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
        <h2 style="color:#e53935; margin-bottom:16px;">⚡ 数据冲突</h2>
        <p style="color:#333; margin-bottom:12px; line-height:1.5;">
          服务器版本：<strong>v${currentVersion}</strong><br>
          你的版本：<strong>v${incomingVersion}</strong>
        </p>
        <p style="color:#666; margin-bottom:30px; font-size:0.9em;">
          其他电脑已修改数据，请选择保留哪个版本
        </p>
        <div style="display:flex; gap:12px; justify-content:center;">
          <button id="btn-keep-remote" style="
            background:#2e7d32; color:#fff; border:none; padding:10px 24px;
            border-radius:8px; font-size:1em; cursor:pointer;
          ">用服务器版本</button>
          <button id="btn-keep-local" style="
            background:#1565c0; color:#fff; border:none; padding:10px 24px;
            border-radius:8px; font-size:1em; cursor:pointer;
          ">用本地版本</button>
          <button id="btn-cancel" style="
            background:#9e9e9e; color:#fff; border:none; padding:10px 24px;
            border-radius:8px; font-size:1em; cursor:pointer;
          ">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    overlay.querySelector('#btn-keep-remote').onclick = () => { overlay.remove(); resolve('keep_remote'); };
    overlay.querySelector('#btn-keep-local').onclick = () => { overlay.remove(); resolve('keep_local'); };
    overlay.querySelector('#btn-cancel').onclick = () => { overlay.remove(); resolve('cancel'); };
  });
}

// ================================================================
// 对话框：待处理冲突提示
// ================================================================
function showPendingConflictDialog(remoteVersion) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); z-index: 99999;
    display: flex; align-items: center; justify-content: center;
  `;
  overlay.innerHTML = `
    <div style="background:#fff; border-radius:16px; padding:40px; max-width:450px; text-align:center; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
      <h2 style="color:#ff6f00; margin-bottom:16px;">⚡ 检测到远程更新</h2>
      <p style="color:#333; margin-bottom:30px; line-height:1.5;">
        服务器已更新到 <strong>v${remoteVersion}</strong>，<br>
        但你本地有未保存的修改。
      </p>
      <div style="display:flex; gap:12px; justify-content:center;">
        <button id="btn-sync-now" style="
          background:#1565c0; color:#fff; border:none; padding:10px 24px;
          border-radius:8px; font-size:1em; cursor:pointer;
        ">保存本地并同步</button>
        <button id="btn-discard-local" style="
          background:#ef6c00; color:#fff; border:none; padding:10px 24px;
          border-radius:8px; font-size:1em; cursor:pointer;
        ">放弃本地更新</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  
  overlay.querySelector('#btn-sync-now').onclick = async () => {
    overlay.remove();
    await saveToServer();
  };
  overlay.querySelector('#btn-discard-local').onclick = async () => {
    overlay.remove();
    clearLocalChanged();
    await loadFromServer();
    notifyRenderUpdate();
  };
}

// ================================================================
// 对话框：重新连接
// ================================================================
function showReconnectDialog() {
  let dlg = document.getElementById('reconnect-dlg');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'reconnect-dlg';
    dlg.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background:#fff; border-radius:16px; padding:40px; text-align:center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3); z-index: 99999;
    `;
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `
    <h2 style="color:#ff6f00; margin-bottom:16px;">⚠️ 无法连接服务器</h2>
    <p style="color:#666; margin-bottom:24px; line-height:1.5;">
      保存的路径：<code style="background:#f5f9ff; padding:2px 8px;">${smbPath || '未知'}</code><br>
      请检查网络或重新选择路径
    </p>
    <button id="btn-reconnect" style="
      background:#1565c0; color:#fff; border:none; padding:12px 32px;
      border-radius:8px; font-size:1.1em; cursor:pointer;
    ">重新选择路径</button>
    <button id="btn-offline" style="
      background:#9e9e9e; color:#fff; border:none; padding:12px 24px;
      border-radius:8px; font-size:1em; cursor:pointer; margin-left:12px;
    ">离线模式</button>
  `;
  dlg.style.display = 'block';
  
  document.getElementById('btn-reconnect').onclick = async () => {
    dlg.style.display = 'none';
    await promptSelectPath();
  };
  document.getElementById('btn-offline').onclick = () => {
    dlg.style.display = 'none';
    isOfflineMode = true;
    showOfflineBanner();
  };
}

// ================================================================
// 对话框：错误提示
// ================================================================
function showErrorDialog(msg) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); z-index: 99999;
    display: flex; align-items: center; justify-content: center;
  `;
  overlay.innerHTML = `
    <div style="background:#fff; border-radius:16px; padding:40px; max-width:400px; text-align:center; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
      <h2 style="color:#e53935; margin-bottom:16px;">❌ 错误</h2>
      <p style="color:#333; margin-bottom:30px; line-height:1.5;">${msg}</p>
      <button onclick="this.closest('div').parentNode.remove()" style="
        background:#1565c0; color:#fff; border:none; padding:10px 24px;
        border-radius:8px; font-size:1em; cursor:pointer;
      ">确定</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ================================================================
// 导出 syncAPI 给渲染进程调用
// ================================================================
window.syncAPI = {
  init: initSync,
  save: saveToServer,
  saveGroup: (gi) => saveToServer(gi),
  markChanged: markLocalChanged,
  getGroupData: () => groupData,
  isConnected: () => isConnected,
  getSmbPath: () => smbPath,
  reconnect: async () => {
    const selected = await window.electronAPI.selectSmbPath();
    if (selected) {
      smbPath = selected;
      localStorage.setItem('nictSmbPath', smbPath);
      await window.electronAPI.setSmbPath(smbPath);
      isConnected = true;
      isOfflineMode = false;
      const banner = document.getElementById('offline-banner');
      if (banner) banner.remove();
      await loadFromServer();
      startPolling();
      notifyRenderUpdate();
      return true;
    }
    return false;
  }
};

// ================================================================
// 启动
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  initSync();
});