"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const app_1 = require("./core/app");
const config_1 = require("./core/config");
const tunnel_manager_1 = require("./core/tunnel-manager");
let core = null;
let win = null;
let tray = null;
let quitting = false;
function panelUrl() {
    return `http://127.0.0.1:${core?.config.get().panelPort ?? 8766}/?gui=1`;
}
function createWindow() {
    win = new electron_1.BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 920,
        minHeight: 600,
        show: false,
        // 自绘标题栏：像桌面软件而不是网页
        frame: false,
        backgroundColor: '#FFFFFF',
        title: '六本豆mcp',
        icon: node_path_1.default.join(electron_1.app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            preload: node_path_1.default.join(__dirname, 'preload.js'),
        },
    });
    win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
        if (!quitting) {
            e.preventDefault();
            win?.hide();
        }
    });
    win.on('closed', () => {
        win = null;
    });
}
function showWindow() {
    if (!win)
        createWindow();
    if (!win)
        return;
    const url = panelUrl();
    if (win.webContents.getURL() !== url)
        void win.loadURL(url);
    if (win.isMinimized())
        win.restore();
    win.show();
    win.focus();
}
electron_1.ipcMain.on('gui:minimize', () => { win?.minimize(); });
electron_1.ipcMain.on('gui:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
electron_1.ipcMain.on('gui:close', () => { if (win && !quitting) win.hide(); });
function createTray() {
    tray = new electron_1.Tray(node_path_1.default.join(electron_1.app.getAppPath(), 'assets', 'tray.png'));
    tray.setToolTip('六本豆mcp');
    tray.setContextMenu(electron_1.Menu.buildFromTemplate([
        { label: '打开控制面板', click: () => showWindow() },
        {
            label: '重启服务',
            click: () => {
                core
                    ?.restart()
                    .catch((e) => electron_1.dialog.showErrorBox('重启失败', String(e)));
            },
        },
        { type: 'separator' },
        { label: '退出', click: () => void quit() },
    ]));
    tray.on('double-click', () => showWindow());
}
async function quit() {
    quitting = true;
    try {
        // 先收掉自己拉起的 ssh 反向隧道，再停本机服务
        await tunnel_manager_1.stop();
        await core?.stop();
    }
    finally {
        tray?.destroy();
        electron_1.app.quit();
    }
}
async function init() {
    core = (0, app_1.createCore)({
        dataDir: (0, config_1.defaultDataDir)(),
        // 一键修复用：先收掉旧隧道，再按当前配置重新拉起
        onRepairServer: async () => tunnel_manager_1.remoteCaddyRepair(),
        // 只重建本应用自己拉起的隧道（不碰别人的 ssh 进程）
        onRepairTunnel: async () => { await tunnel_manager_1.restartOwn(core?.config.get().port); },
        // 强制重建：会结束匹配的旧隧道进程（含别的实例留下的），需要用户明确点
        onRepairTunnelForce: async () => { await tunnel_manager_1.rebuild(core?.config.get().port); },
        // 本机 MCP 端口没监听时，单独重启 MCP（面板服务器不动，避免掐断请求）
        onRepairLocal: async () => { await core?.restartMcp(); },
        onConfigChanged: (cfg) => {
            electron_1.app.setLoginItemSettings({ openAtLogin: cfg.autoLaunch });
            // 设置里关了自动隧道就收掉，重新打开就再起
            void tunnel_manager_1.applyConfig(cfg).catch((e) => console.error('隧道配置应用失败', e));
        },
    });
    await core.start();
    electron_1.app.setLoginItemSettings({ openAtLogin: core.config.get().autoLaunch });
    createTray();
    showWindow();
    // 应用起来后自己拉起 SSH 反向隧道，不阻塞窗口显示
    void tunnel_manager_1
        .start({ getConfig: () => core.config.get(), port: core.config.get().port })
        .catch((e) => console.error('隧道启动失败', e));
}
if (!electron_1.app.requestSingleInstanceLock()) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => showWindow());
    // 托盘常驻：关闭所有窗口不退出
    electron_1.app.on('window-all-closed', () => { });
    electron_1.app.on('before-quit', () => {
        quitting = true;
    });
    // 兜底：不管从哪条路径退出，都同步收掉自己起的隧道子进程，不留残余
    electron_1.app.on('will-quit', () => {
        tunnel_manager_1.stopSync();
    });
    electron_1.app
        .whenReady()
        .then(init)
        .catch((e) => {
        electron_1.dialog.showErrorBox('启动失败', e instanceof Error ? e.message : String(e));
        electron_1.app.exit(1);
    });
}
