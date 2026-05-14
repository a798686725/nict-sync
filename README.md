# NICT 吊数计算器 - 同步版

基于 V1.6 的港口吊数计算器，增加局域网实时同步功能。

## 功能特点

- 🚀 **局域网同步**：服务器模式下，其他电脑实时接收数据更新
- 📊 **统计视图**：汇总所有船舶作业数据，高亮最高效率
- 🌙 **深色模式**：支持浅色/深色主题切换
- 💾 **自动保存**：数据保存在浏览器 sessionStorage
- 📥 **Excel导出**：支持单页和统计报表导出

## 同步模式

### 服务器模式（电脑A）
1. 点击「🚀 启动服务器」
2. 记下显示的局域网IP和端口（如 `192.168.1.100:8765`）
3. 其他电脑连接到此地址

### 客户端模式（电脑B、电脑C）
1. 点击「🔗 连接」
2. 输入服务器地址（如 `192.168.1.100:8765`）
3. 连接成功后自动同步数据

## 本地开发

```bash
npm install
npm run dev
```

## GitHub Actions 云编译

上传代码到 GitHub 后，Actions 会自动编译：

1. Windows: `.exe` 安装包
2. macOS: `.dmg` 安装包  
3. Linux: `.AppImage`

下载位置：Actions 页面的 Artifacts

## 编译为桌面应用（本地）

需要安装 Rust 和 Node.js：

```bash
npm install
npm run tauri build
```

## 目录结构

```
nict-sync/
├── index.html          # 主应用（HTML）
├── package.json        # 前端依赖
├── vite.config.js      # Vite 配置
├── src-tauri/          # Tauri 后端
│   ├── Cargo.toml
│   ├── build.rs
│   ├── src/main.rs     # WebSocket 服务器
│   └── tauri.conf.json
├── .github/workflows/  # CI/CD
└── README.md
```

## 注意事项

- ⚠️ 图标文件（icons/）需要自行添加
- 🔒 同步功能适用于内网环境
- 💻 推荐在能上网的电脑上触发 GitHub Actions 编译