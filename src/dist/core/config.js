"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigStore = exports.APP_VERSION = void 0;
exports.normalizeApprovalMode = normalizeApprovalMode;
exports.defaultDataDir = defaultDataDir;
exports.newToken = newToken;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
exports.APP_VERSION = '0.3.2';
const LEGACY_MODE = {
    all: 'always',
    dangerous: 'ask-dangerous',
    full: 'never',
};
function normalizeApprovalMode(v) {
    const s = String(v ?? '');
    if (s === 'always' || s === 'ask-dangerous' || s === 'never')
        return s;
    if (LEGACY_MODE[s])
        return LEGACY_MODE[s];
    throw new Error(`审批模式无效：${s}（可选 always / ask-dangerous / never）`);
}
/** %APPDATA%\LocalAIConsole（可用环境变量 LAC_DATA_DIR 覆盖，便于测试） */
function defaultDataDir() {
    if (process.env.LAC_DATA_DIR)
        return process.env.LAC_DATA_DIR;
    if (process.platform !== 'win32') {
        // Linux / Kali：遵循 XDG 规范，默认 ~/.config/LocalAIConsole
        const xdg = process.env.XDG_CONFIG_HOME || node_path_1.default.join(node_os_1.default.homedir(), '.config');
        return node_path_1.default.join(xdg, 'LocalAIConsole');
    }
    const appData = process.env.APPDATA ?? node_path_1.default.join(node_os_1.default.homedir(), 'AppData', 'Roaming');
    return node_path_1.default.join(appData, 'LocalAIConsole');
}
function newToken() {
    return node_crypto_1.default.randomBytes(24).toString('base64url');
}
function checkPort(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        throw new Error(`端口无效（需为 1024-65535）：${String(v)}`);
    }
    return n;
}
function checkIdle(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1440)
        throw new Error('会话空闲时间需为 1-1440 分钟');
    return n;
}
class ConfigStore {
    dataDir;
    cfg;
    file;
    constructor(dataDir) {
        this.dataDir = dataDir;
        node_fs_1.default.mkdirSync(dataDir, { recursive: true });
        this.file = node_path_1.default.join(dataDir, 'config.json');
        const base = {
            port: 8765,
            panelPort: 8766,
            token: newToken(),
            workspaceRoots: [node_path_1.default.join(node_os_1.default.homedir(), 'Documents', 'LocalAIConsole')],
            approvalMode: 'ask-dangerous',
            allowOutsideWorkspace: false,
            requireBearer: false,
            sessionIdleMinutes: 30,
            autoLaunch: false,
        // 应用自管 SSH 反向隧道（默认开，关了就不自动拉公网）
        autoTunnel: true,
            darkMode: false,
            customInstructions: '',
            promptMain: '',
            promptProject: {},
            disabledTools: [],
            memoryBackend: 'local',
        };
        let saved = {};
        if (node_fs_1.default.existsSync(this.file)) {
            try {
                saved = JSON.parse(node_fs_1.default.readFileSync(this.file, 'utf8'));
            }
            catch {
                saved = {};
            }
        }
        const merged = { ...base, ...saved };
        // 迁移旧版本的提示词字段 p1/p2/p3 与旧审批模式名
        const old = saved.prompts;
        if (old) {
            if (!saved.customInstructions && old.p1)
                merged.customInstructions = String(old.p1);
            if (!saved.promptMain && old.p2)
                merged.promptMain = String(old.p2);
            if (old.p3 && merged.workspaceRoots[0]) {
                merged.promptProject = { ...merged.promptProject, [merged.workspaceRoots[0]]: String(old.p3) };
            }
            delete merged.prompts;
        }
        try {
            merged.approvalMode = normalizeApprovalMode(merged.approvalMode);
        }
        catch {
            merged.approvalMode = 'ask-dangerous';
        }
        this.cfg = merged;
        if (!this.cfg.token)
            this.cfg.token = newToken();
        this.save();
    }
    get() {
        return structuredClone(this.cfg);
    }
    /** 只接受白名单字段；令牌请用 regenerateToken() */
    update(patch) {
        const next = structuredClone(this.cfg);
        if (patch.port !== undefined)
            next.port = checkPort(patch.port);
        if (patch.panelPort !== undefined)
            next.panelPort = checkPort(patch.panelPort);
        if (next.port === next.panelPort)
            throw new Error('MCP 端口与控制面板端口不能相同');
        if (Array.isArray(patch.workspaceRoots)) {
            const roots = patch.workspaceRoots
                .map((r) => String(r).trim())
                .filter(Boolean)
                .map((r) => node_path_1.default.resolve(r));
            if (roots.length === 0)
                throw new Error('至少需要一个工作区目录');
            for (const r of roots)
                node_fs_1.default.mkdirSync(r, { recursive: true });
            next.workspaceRoots = roots;
        }
        if (patch.approvalMode !== undefined)
            next.approvalMode = normalizeApprovalMode(patch.approvalMode);
        if (typeof patch.allowOutsideWorkspace === 'boolean')
            next.allowOutsideWorkspace = patch.allowOutsideWorkspace;
        if (typeof patch.requireBearer === 'boolean')
            next.requireBearer = patch.requireBearer;
        if (patch.sessionIdleMinutes !== undefined)
            next.sessionIdleMinutes = checkIdle(patch.sessionIdleMinutes);
        if (Array.isArray(patch.disabledTools)) {
            next.disabledTools = [...new Set(patch.disabledTools.map((x) => String(x)))];
        }
        if (patch.memoryBackend !== undefined) {
            const mb = String(patch.memoryBackend).toLowerCase();
            if (mb !== 'json' && mb !== 'local' && mb !== 'hymemory')
                throw new Error('memoryBackend 无效：' + mb + '（可选 json / local / hymemory）');
            next.memoryBackend = mb;
        }
        if (typeof patch.autoLaunch === 'boolean')
            next.autoLaunch = patch.autoLaunch;
        if (typeof patch.autoTunnel === 'boolean')
            next.autoTunnel = patch.autoTunnel;
        if (typeof patch.darkMode === 'boolean')
            next.darkMode = patch.darkMode;
        if (typeof patch.customInstructions === 'string')
            next.customInstructions = patch.customInstructions;
        if (typeof patch.promptMain === 'string')
            next.promptMain = patch.promptMain;
        if (patch.promptProject && typeof patch.promptProject === 'object') {
            // 只保存非空项目提示词；清空即回退到上层
            next.promptProject = Object.fromEntries(Object.entries(patch.promptProject)
                .map(([k, v]) => [node_path_1.default.resolve(k), String(v ?? '')])
                .filter(([, v]) => v.trim() !== ''));
        }
        this.cfg = next;
        this.save();
        return this.get();
    }
    regenerateToken() {
        this.cfg.token = newToken();
        this.save();
        return this.cfg.token;
    }
    ensureRoots() {
        for (const r of this.cfg.workspaceRoots)
            node_fs_1.default.mkdirSync(r, { recursive: true });
    }
    save() {
        node_fs_1.default.mkdirSync(this.dataDir, { recursive: true });
        const tmp = this.file + '.tmp';
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), 'utf8');
        node_fs_1.default.renameSync(tmp, this.file);
    }
}
exports.ConfigStore = ConfigStore;
