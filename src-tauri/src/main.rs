// NICT 吊数计算器 - Tauri 后端
// 提供 WebSocket 局域网同步服务

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::{accept_async, tungstenite::Message};

// 全局状态
struct AppState {
    server_running: Mutex<bool>,
    server_port: Mutex<u16>,
    broadcast_tx: broadcast::Sender<String>,
    clients: Mutex<Vec<String>>,
}

impl AppState {
    fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        Self {
            server_running: Mutex::new(false),
            server_port: Mutex::new(0),
            broadcast_tx,
            clients: Mutex::new(Vec::new()),
        }
    }
}

type SharedState = Arc<AppState>;

// Tauri 命令：启动同步服务器
#[tauri::command]
async fn start_server(state: tauri::State<'_, SharedState>, port: u16) -> Result<String, String> {
    // Check if already running (lock scope minimized to avoid跨await)
    {
        let running = state.server_running.lock().unwrap();
        if *running {
            let port = *state.server_port.lock().unwrap();
            return Ok(format!("服务器已在运行，端口：{}", port));
        }
    }

    // Bind before acquiring the running lock
    let addr = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&addr).await.map_err(|e| format!("启动失败：{}", e))?;

    // Now set running=true
    {
        let mut running = state.server_running.lock().unwrap();
        *running = true;
    }
    {
        let mut p = state.server_port.lock().unwrap();
        *p = port;
    }

    let broadcast_tx = state.broadcast_tx.clone();
    let state_clone = state.inner().clone();

    tokio::spawn(async move {
        println!("[NICT Sync Server] WebSocket 服务器已启动，端口：{}", port);

        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let tx = broadcast_tx.clone();
                    let state_inner = state_clone.clone();

                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(stream, addr, tx, state_inner).await {
                            eprintln!("[NICT] 连接处理错误：{}", e);
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[NICT] 接受连接失败：{}", e);
                }
            }
        }
    });

    Ok(format!("服务器已启动，端口：{}", port))
}

// Tauri 命令：停止服务器
#[tauri::command]
async fn stop_server(state: tauri::State<'_, SharedState>) -> Result<String, String> {
    let mut running = state.server_running.lock().unwrap();
    if !*running {
        return Ok("服务器未运行".to_string());
    }

    *running = false;
    *state.server_port.lock().unwrap() = 0;

    // 清空客户端列表
    state.clients.lock().unwrap().clear();

    Ok("服务器已停止".to_string())
}

// Tauri 命令：获取服务器状态
#[tauri::command]
fn get_server_status(state: tauri::State<'_, SharedState>) -> (bool, u16, usize) {
    let running = *state.server_running.lock().unwrap();
    let port = *state.server_port.lock().unwrap();
    let client_count = state.clients.lock().unwrap().len();
    (running, port, client_count)
}

// Tauri 命令：广播数据到所有客户端
#[tauri::command]
async fn broadcast_data(state: tauri::State<'_, SharedState>, data: String) -> Result<usize, String> {
    let count = state.clients.lock().unwrap().len();
    state.broadcast_tx.send(data).map_err(|e| format!("广播失败：{}", e))?;
    Ok(count)
}

// Tauri 命令：获取本机局域网IP
#[tauri::command]
fn get_lan_ip() -> String {
    // 尝试获取本机IP
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if let Ok(_) = socket.connect("8.8.8.8:80") {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    broadcast_tx: broadcast::Sender<String>,
    state: SharedState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws_stream = accept_async(stream).await?;
    let (write, mut read) = ws_stream.split();

    // 注册客户端
    {
        let mut clients = state.clients.lock().unwrap();
        clients.push(addr.to_string());
        println!("[NICT] 客户端连接：{}，当前在线：{}", addr, clients.len());
    }

    // 广播用户加入
    let join_msg = format!(r#"{{"type":"join","addr":"{}","count":{}}}"#, addr, state.clients.lock().unwrap().len());
    let _ = broadcast_tx.send(join_msg);

    // 使用 broadcast channel 接收器
    let mut broadcast_rx = broadcast_tx.subscribe();

    // 创建写回通道
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    // 后台任务：从 broadcast_rx 接收并发送
    let tx_write = tx.clone();
    tokio::spawn(async move {
        let mut rx = broadcast_rx;
        while let Ok(msg) = rx.recv().await {
            if tx_write.send(msg).await.is_err() {
                break;
            }
        }
    });

    // 转发消息循环
    loop {
        tokio::select! {
            // 读取客户端消息
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        // 收到数据，广播给所有客户端
                        let data = format!(r#"{{"type":"data","from":"{}","data":{}}}"#, addr, text);
                        let _ = broadcast_tx.send(data);
                    }
                    Some(Ok(Message::Close())) | None => {
                        break;
                    }
                    _ => {}
                }
            }
            // 发送消息给客户端
            Some(msg) = rx.recv() => {
                use tokio::io::AsyncWriteExt;
                let mut writer = write;
                if writer.write_all(msg.as_bytes()).await.is_err() {
                    break;
                }
                if writer.flush().await.is_err() {
                    break;
                }
            }
        }
    }

    // 客户端断开
    {
        let mut clients = state.clients.lock().unwrap();
        clients.retain(|c| c != &addr.to_string());
        println!("[NICT] 客户端断开：{}，当前在线：{}", addr, clients.len());

        // 广播用户离开
        let leave_msg = format!(r#"{{"type":"leave","addr":"{}","count":{}}}"#, addr, clients.len());
        let _ = broadcast_tx.send(leave_msg);
    }

    Ok(())
}

fn main() {
    let state = Arc::new(AppState::new());

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            get_server_status,
            broadcast_data,
            get_lan_ip,
        ])
        .run(tauri::generate_context!())
        .expect("启动 NICT 吊数计算器失败");
}
