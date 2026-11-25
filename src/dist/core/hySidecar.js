"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HySidecar = void 0;
/**
 * Hy-Memory sidecar 生命周期管理（六本豆mcp v2，P5）
 * 直接拉起 hy-memory 2.0.5 自带的 stdlib 服务器：`python -m hy_memory.server`
 * （不修改 SDK）。职责：
 *   1. 优先用 v2\venv-hy\Scripts\python.exe，其次 python/python3/py；
 *   2. 检查 hy_memory 包可导入；
 *   3. 加载可选环境文件 <root>\hy-memory.env（KEY=VALUE，用户放 MEMORY_EMBEDDER_*）；
 *   4. 端口已有健康实例则直接复用（防止僵尸 sidecar 抢端口）；
 *   5. spawn 后轮询 /healthz 直到就绪或超时；stop() 只杀自己拉起的进程。
 * 任何失败只把 ready 置 false，绝不抛错——由 memoryBackend 自动回退 JSON。
 */
const child_process_1 = require("child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DEFAULT_PORT = 19527;
class HySidecar {
    constructor(opts) {
        this.proc = null;
        this.ready = false;
        this.spawned = false;
        this.port = (opts && opts.port) || Number(process.env.HY_MEMORY_SIDECAR_PORT || DEFAULT_PORT);
        this.dataDir = (opts && opts.dataDir) || '';
        this.root = (opts && opts.root) || (0, node_path_1.resolve)(__dirname, '..', '..', '..');
        this.python = (opts && opts.python) || '';
        this.log = (opts && opts.log) || { info: () => { }, warn: () => { }, error: () => { } };
        this.readyTimeoutMs = (opts && opts.readyTimeoutMs) || 60000;
    }
    get endpoint() {
        return 'http://127.0.0.1:' + this.port;
    }
    findPython() {
        const candidates = [];
        if (this.python)
            candidates.push(this.python);
        candidates.push((0, node_path_1.join)(this.root, 'venv-hy', 'Scripts', 'python.exe'));
        candidates.push((0, node_path_1.join)(this.root, 'venv-hy', 'bin', 'python'));
        candidates.push('python', 'python3', 'py');
        for (const cmd of candidates) {
            try {
                const out = (0, child_process_1.spawnSync)(cmd, ['--version'], { encoding: 'utf8', timeout: 8000 });
                if (out && out.status === 0)
                    return cmd;
            }
            catch { }
        }
        return '';
    }
    hasHyMemory(python) {
        try {
            const out = (0, child_process_1.spawnSync)(python, ['-c', 'import hy_memory; print(getattr(hy_memory, "__version__", "ok"))'], { encoding: 'utf8', timeout: 20000 });
            return !!(out && out.status === 0);
        }
        catch {
            return false;
        }
    }
    buildEnv() {
        const env = Object.assign({}, process.env);
        // 可选 env 文件：MEMORY_EMBEDDER_API_KEY / MEMORY_EMBEDDER_BASE_URL / MEMORY_EMBEDDER_MODEL 等
        try {
            const envFile = (0, node_path_1.join)(this.root, 'hy-memory.env');
            if ((0, node_fs_1.existsSync)(envFile)) {
                for (const line of (0, node_fs_1.readFileSync)(envFile, 'utf8').split(/\r?\n/)) {
                    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
                    if (m && m[1] && !line.trim().startsWith('#'))
                        env[m[1]] = m[2].replace(/^["']|["']$/g, '');
                }
            }
        }
        catch { }
        if (this.dataDir)
            env['MEMORY_DATA_DIR'] = (0, node_path_1.join)(this.dataDir, 'hy-memory');
        // D1：只用 lite（Embedding only，不调 LLM）。server 默认 MEMORY_MODE=pro，必须显式压回 lite
        if (!env['MEMORY_MODE'])
            env['MEMORY_MODE'] = 'lite';
        return env;
    }
    async health() {
        try {
            const r = await fetch(this.endpoint + '/healthz', { signal: AbortSignal.timeout(2000) });
            if (!r.ok)
                return false;
            const j = await r.json();
            return !!(j && j.status === 'ok');
        }
        catch {
            return false;
        }
    }
    async start() {
        try {
            if (await this.health()) {
                this.ready = true;
                this.log.info('[hySidecar] 复用已有实例 ' + this.endpoint);
                return true;
            }
            const python = this.findPython();
            if (!python || !this.hasHyMemory(python)) {
                this.log.warn('[hySidecar] python 或 hy_memory 不可用，hymemory 后端回退 JSON');
                return false;
            }
            this.proc = (0, child_process_1.spawn)(python, ['-m', 'hy_memory.server', '--port', String(this.port), '--host', '127.0.0.1'], {
                env: this.buildEnv(),
                stdio: 'ignore',
                windowsHide: true,
            });
            this.spawned = true;
            this.proc.on('exit', (code) => {
                this.ready = false;
                this.spawned = false;
                this.log.warn('[hySidecar] 进程退出 code=' + code);
            });
            const deadline = Date.now() + this.readyTimeoutMs;
            while (Date.now() < deadline) {
                if (await this.health()) {
                    this.ready = true;
                    this.log.info('[hySidecar] 就绪 ' + this.endpoint);
                    return true;
                }
                await new Promise((r) => setTimeout(r, 500));
            }
            this.log.warn('[hySidecar] 就绪超时，回退 JSON');
            this.stop();
            return false;
        }
        catch (e) {
            this.log.warn('[hySidecar] 启动异常：' + e);
            this.ready = false;
            return false;
        }
    }
    stop() {
        this.ready = false;
        try {
            if (this.spawned && this.proc && !this.proc.killed)
                this.proc.kill();
        }
        catch { }
        this.proc = null;
        this.spawned = false;
    }
}
exports.HySidecar = HySidecar;
