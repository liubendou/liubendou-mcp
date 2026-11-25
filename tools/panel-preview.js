'use strict';
/**
 * 新版控制面板本地预览（开发/验收用，不影响正在运行的 0.1.0 便携版）
 *
 * 做法：用**独立数据目录 + 独立端口**启动 v2 内核（core/app.js），
 *   - 面板: http://127.0.0.1:8799/   （默认，可用环境变量改）
 *   - MCP : 127.0.0.1:8798
 *   - 数据目录: %LOCALAPPDATA%\liubendou-ui-preview（临时数据，随便删）
 * 启动时把真实数据目录里的 coord.json / skills / projects 复制一份过去，
 * 这样看板上有真实任务可看，但写入只落在预览目录，不污染线上数据。
 *
 * 用法：
 *   node tools\panel-preview.js
 *   LAC_PREVIEW_PANEL_PORT=8800 LAC_PREVIEW_MCP_PORT=8801 node tools\panel-preview.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVE_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LocalAIConsole');
const dataDir = process.env.LAC_PREVIEW_DIR || path.join(os.homedir(), 'AppData', 'Local', 'liubendou-ui-preview');
const panelPort = Number(process.env.LAC_PREVIEW_PANEL_PORT || 8799);
const mcpPort = Number(process.env.LAC_PREVIEW_MCP_PORT || 8798);

function copyIfExists(from, to) {
    try {
        if (!fs.existsSync(from)) return false;
        const st = fs.statSync(from);
        if (st.isDirectory()) {
            fs.mkdirSync(to, { recursive: true });
            for (const name of fs.readdirSync(from)) copyIfExists(path.join(from, name), path.join(to, name));
            return true;
        }
        // JSON 可能正被运行中的实例写，做几次重试
        if (/\.json$/i.test(from)) {
            for (let i = 0; i < 5; i++) {
                try {
                    JSON.parse(fs.readFileSync(from, 'utf8'));
                    break;
                } catch {
                    if (i === 4) return false;
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
                }
            }
        }
        fs.copyFileSync(from, to);
        return true;
    } catch {
        return false;
    }
}

fs.mkdirSync(dataDir, { recursive: true });
// 复制真实数据（不含 config.json：里面是令牌，且端口要独立）
for (const name of ['coord.json', 'transfer-log.json', 'skills', 'projects', 'inbox', 'outbox']) {
    copyIfExists(path.join(LIVE_DIR, name), path.join(dataDir, name));
}

// 预览专用配置：独立端口、关隧道与开机自启
let base = {};
try { base = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch { base = {}; }
base.port = mcpPort;
base.panelPort = panelPort;
base.autoTunnel = false;
base.autoLaunch = false;
base.workspaceRoots = Array.isArray(base.workspaceRoots) && base.workspaceRoots.length
    ? base.workspaceRoots
    : [path.join(os.homedir(), 'Documents', 'LocalAIConsole')];
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(base, null, 2), 'utf8');

// 已经在跑就别再起一个（端口会被占用）
(async () => {
    try {
        const r = await fetch(`http://127.0.0.1:${panelPort}/api/status`);
        if (r.ok) {
            console.log('[预览] 已在运行: http://127.0.0.1:' + panelPort + '/');
            process.exit(0);
        }
    } catch { /* 没在跑，继续启动 */ }
})().catch(() => { });

process.env.LAC_DATA_DIR = dataDir;
const { createCore } = require(path.join(__dirname, '..', 'src', 'dist', 'core', 'app.js'));
const core = createCore({ dataDir });
core.start()
    .then(() => {
        console.log('[预览] 控制面板: http://127.0.0.1:' + panelPort + '/');
        console.log('[预览] 数据目录: ' + dataDir);
        console.log('[预览] 停止: Ctrl+C');
    })
    .catch((e) => {
        console.error('[预览] 启动失败: ' + (e && e.message ? e.message : String(e)));
        process.exit(1);
    });
process.on('SIGINT', () => { core.stop().finally(() => process.exit(0)); });
