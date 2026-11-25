"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCore = createCore;
exports.__tunnelProbes = { probeServerEntry, probePublicMcp, probeTunnelProcess };
const node_http_1 = __importDefault(require("node:http"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_os_1 = __importDefault(require("node:os"));
const node_child_process_1 = __importDefault(require("node:child_process"));
const node_https_1 = __importDefault(require("node:https"));
const node_tls_1 = __importDefault(require("node:tls"));
const node_net_1 = __importDefault(require("node:net"));
const config_1 = require("./config");
const store_1 = require("./store");
const memoryBackend_1 = require("./memoryBackend");
const hySidecar_1 = require("./hySidecar");
const commands_1 = require("./commands");
const terminal_1 = require("./terminal");
const security_1 = require("./security");
const log_1 = require("./log");
const transfer_1 = require("./transfer");
const tools_1 = require("./tools");
const projects_1 = require("./projects");
const skills_1 = require("./skills");
const mcp_1 = require("./mcp");
const tunnel_state_1 = require("./tunnel-state");
const platform_1 = require("./platform");
const coord_1 = require("./coord");
const agentBridge_1 = require("./agentBridge");
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                reject(new security_1.ToolError('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function sendText(res, status, body) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
}
function listBox(dir) {
    return node_fs_1.default
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
        const st = node_fs_1.default.statSync(node_path_1.default.join(dir, e.name));
        return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
    })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
}
/** 公网通路检测：SSH 反向隧道 → 自建服务器，公网入口固定 */
const PUBLIC_BASE = 'http://leenzhuanjieben.shop';
const SSH_HOST = 'root@<your-server-ip>';
const TUNNEL_TIMEOUT = 8000;
/** a. 隧道进程：本机存在命令行含 -R 8765 指向自建服务器的 ssh.exe 子进程 */
/** 本机 MCP 端口是否真的在监听（面板过去硬写"运行中"，端口冲突时会误报） */
function probeLocalMcp(port, timeoutMs = 1500) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        const sock = node_net_1.default.connect({ host: '127.0.0.1', port: Number(port) || 8765 });
        let settled = false;
        const done = (ok, detail) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { }
            resolve({ ok, detail, ms: Date.now() - t0 });
        };
        sock.setTimeout(timeoutMs, () => done(false, `本机 MCP 端口 ${port} 无响应`));
        sock.once('connect', () => done(true, `本机 MCP 端口 ${port} 正常`));
        sock.once('error', (e) => done(false, `本机 MCP 端口 ${port} 不可达（${e.code || e.message}）`));
    });
}
function probeTunnelProcess(state) {
    const started = Date.now();
    // Cloudflare 备用模式：不查 ssh，查 cloudflared 进程还在不在
    if (state && state.mode === 'cloudflare') {
        const pid = Number(state.pid) || 0;
        let alive = false;
        try {
            if (pid > 0) {
                process.kill(pid, 0);
                alive = true;
            }
        }
        catch { }
        return Promise.resolve(alive
            ? { ok: true, detail: `Cloudflare 备用隧道正在运行（进程号 ${pid}）`, ms: Date.now() - started }
            : { ok: false, detail: 'Cloudflare 备用隧道进程不在了，请点「一键修复」重新拉起', ms: Date.now() - started });
    }
    return new Promise((resolve) => {
        platform_1.listSsh().then((rows) => {
            const ms = Date.now() - started;
            if (!rows.length) {
                return resolve({ ok: false, detail: '未发现 ssh 进程，SSH 反向隧道没有在跑', ms });
            }
            const hit = rows.find((r) => r.pid > 0 && /-R\s+8765:127\.0\.0\.1:\d+/.test(r.cmd) && r.cmd.includes(SSH_HOST));
            if (!hit) {
                return resolve({ ok: false, detail: '有 ssh 进程，但没有 -R 8765 指向自建服务器的反向隧道，请先启动', ms });
            }
            resolve({ ok: true, detail: `ssh 反向隧道正在运行（进程号 ${hit.pid}，-R 8765 → ${PUBLIC_BASE}）`, ms });
        });
    });
}
/** b. 公网入口：GET 根路径，拿到本机 MCP 的响应头指纹 / 非 5xx 状态码就算通，只有连不上才判异常 */
function probeServerEntry(base, timeoutMs) {
    return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        const finish = (ok, detail) => {
            if (done)
                return;
            done = true;
            resolve({ ok, detail, ms: Date.now() - started });
        };
        let req;
        try {
            const lib = /^https:/i.test(base) ? node_https_1.default : node_http_1.default;
            req = lib.request(base + '/', {
                method: 'GET',
                timeout: timeoutMs,
                headers: { 'user-agent': 'liubendou-tunnel-check', accept: '*/*' },
            }, (res) => {
                const status = res.statusCode ?? 0;
                res.resume();
                if (status === 502 || status === 503 || status === 504) {
                    return finish(false, `入口返回 HTTP ${status}（反代后面没有可用隧道）`);
                }
                const hit = String(res.headers['access-control-expose-headers'] || '').includes('mcp-session-id');
                finish(true, hit ? `公网入口已回源到本机 MCP（HTTP ${status}）` : `入口已响应 HTTP ${status}（根路径返回 404 属正常）`);
            });
        }
        catch (e) {
            return finish(false, `请求发起失败：${e instanceof Error ? e.message : String(e)}`);
        }
        req.on('timeout', () => {
            req.destroy(new Error(`超时 ${timeoutMs} ms`));
        });
        req.on('error', (e) => finish(false, `连接失败：${e instanceof Error ? e.message : String(e)}`));
        req.end();
    });
}
/** c. 公网 MCP：对 <公网入口>/mcp/<token> 发 initialize，200 且带 mcp-session-id 才算通 */
function probePublicMcp(token, timeoutMs, base) {
    return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        const finish = (ok, detail) => {
            if (done)
                return;
            done = true;
            resolve({ ok, detail, ms: Date.now() - started });
        };
        if (!token) {
            return finish(false, '读不到本机 MCP 令牌，跳过公网握手');
        }
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'liubendou-tunnel-check', version: '1.0.0' },
            },
        });
        const target = `${base}/mcp/${encodeURIComponent(token)}`;
        let req;
        try {
            const lib = /^https:/i.test(base) ? node_https_1.default : node_http_1.default;
            req = lib.request(target, {
                method: 'POST',
                timeout: timeoutMs,
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'user-agent': 'liubendou-tunnel-check',
                    'content-length': Buffer.byteLength(payload),
                },
            }, (res) => {
                const sid = res.headers['mcp-session-id'];
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => {
                    if (body.length < 3000)
                        body += c;
                });
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    if (status !== 200) {
                        return finish(false, `握手返回 HTTP ${status}${body ? '：' + body.slice(0, 200) : ''}`);
                    }
                    if (!sid) {
                        return finish(false, '握手返回 200 但没有 mcp-session-id 响应头');
                    }
                    finish(true, `公网 MCP 握手成功（HTTP 200，会话 ${String(sid).slice(0, 8)}…）`);
                });
            });
        }
        catch (e) {
            return finish(false, `请求发起失败：${e instanceof Error ? e.message : String(e)}`);
        }
        req.on('timeout', () => {
            req.destroy(new Error(`超时 ${timeoutMs} ms`));
        });
        req.on('error', (e) => finish(false, `连接失败：${e instanceof Error ? e.message : String(e)}`));
        req.write(payload);
        req.end();
    });
}
async function tunnelCheck(cfg) {
    const token = String(cfg?.token ?? '');
    const now = (0, tunnel_state_1.getTunnelState)();
    // SSH 模式用固定域名；Cloudflare 备用模式用 quick tunnel 给的临时地址
    const base = String(now.url || PUBLIC_BASE).replace(/\/+$/, '');
    const local = await probeLocalMcp(cfg?.port);
    const proc = await probeTunnelProcess(now);
    const [entry, mcp] = await Promise.all([probeServerEntry(base, TUNNEL_TIMEOUT), probePublicMcp(token, TUNNEL_TIMEOUT, base)]);
    const steps = [
        { ok: local.ok, label: '本机 MCP', detail: local.detail, ms: local.ms },
        { ok: proc.ok, label: '隧道进程', detail: proc.detail, ms: proc.ms },
        { ok: entry.ok, label: '公网入口', detail: entry.detail, ms: entry.ms },
        { ok: mcp.ok, label: '公网 MCP', detail: mcp.detail, ms: mcp.ms },
    ];
    return {
        ok: steps.every((s) => s.ok),
        steps,
        // 检测失败也照样给面板当前入口，复制按钮不至于拼出本机地址
        url: base,
        mode: now.mode ?? null,
        fallback: now.mode === 'cloudflare',
        // 面板据此区分「应用自管」与「复用外部进程」
        owned: now.owned,
        phase: now.phase,
        checkedAt: new Date().toISOString(),
    };
}

/** 一键修复：隧道进程缺失则重新拉起隧道；检测失败最多重试 3 轮，每轮之间等待。 */
/** 一键修复：按病因逐项处理（本机端口 / 隧道进程 / 服务器入口 / 公网握手），每轮修完立刻复查。 */
async function tunnelRepair(cfg, opts) {
    const repairLog = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const errText = (e) => (e instanceof Error ? e.message : String(e));
    let result = await tunnelCheck(cfg);
    for (let round = 1; round <= 3 && !result.ok; round++) {
        const [local, proc, entry] = result.steps;
        if (!local.ok) {
            repairLog.push(`第 ${round} 轮：本机 MCP 服务没在监听（${local.detail}）。`);
            if (typeof opts.onRepairLocal === 'function') {
                try { await opts.onRepairLocal(); repairLog.push('已重新监听本机 MCP 端口'); }
                catch (e) { repairLog.push('重新监听本机端口失败：' + errText(e)); }
            }
            else { repairLog.push('本版本不支持自动重启本机端口，请重启应用'); }
            await sleep(1500);
        }
        else if (!proc.ok) {
            repairLog.push(`第 ${round} 轮：隧道进程缺失，正在重新拉起隧道（优先 SSH，失败自动切 Cloudflare 备用隧道）…`);
            if (typeof opts.onRepairTunnel === 'function') {
                try { await opts.onRepairTunnel(); repairLog.push('隧道已重新拉起，正在等公网验证'); }
                catch (e) { repairLog.push('拉起隧道失败：' + errText(e)); }
            }
            else { repairLog.push('本版本不支持自动拉起隧道'); }
            await sleep(2500);
        }
        else if (!entry.ok) {
            if (result.fallback) {
                repairLog.push(`第 ${round} 轮：Cloudflare 备用隧道入口不可达（${entry.detail}），正在重建备用隧道…`);
                if (typeof opts.onRepairTunnel === 'function') {
                    try { await opts.onRepairTunnel(); repairLog.push('备用隧道已重建，正在等公网验证'); }
                    catch (e) { repairLog.push('重建备用隧道失败：' + errText(e)); }
                }
                else { repairLog.push('本版本不支持自动重建备用隧道'); }
            }
            else {
                repairLog.push(`第 ${round} 轮：服务器入口不可达（${entry.detail}），正在检查服务器 Caddy…`);
                if (typeof opts.onRepairServer === 'function') {
                    try { const r = await opts.onRepairServer(); repairLog.push((r && r.detail) || '服务器检查完成'); }
                    catch (e) { repairLog.push('检查服务器失败：' + errText(e)); }
                }
                else { repairLog.push('本版本不支持检查服务器'); }
            }
            await sleep(3000);
        }
        else {
            repairLog.push(`第 ${round} 轮：隧道进程在、服务器入口也通，但公网 MCP 握手失败（${result.steps[3].detail}）——多半是隧道已失效。`);
            if (result.owned && typeof opts.onRepairTunnel === 'function') {
                try { await opts.onRepairTunnel(); repairLog.push('已重建本应用自己的隧道，等它握手恢复'); }
                catch (e) { repairLog.push('重建隧道失败：' + errText(e)); }
            }
            else {
                repairLog.push('当前隧道不是本应用拉起的，不动别人的进程；需要点「强制重建隧道」才会断开旧连接重建');
            }
            await sleep(3000);
        }
        result = await tunnelCheck(cfg);
    }
    const bad = result.steps.filter((x) => !x.ok).map((x) => x.label);
    repairLog.push(result.ok
        ? '四项检测全部通过（本机 MCP / 隧道进程 / 公网入口 / 公网 MCP）'
        : `仍未通过：${bad.join('、')}。SSH 入口不通时应用会自动改用 Cloudflare 临时地址；若仍卡住，点「强制重建隧道」再试一次。`);
    return { ...result, repairLog };
}
/** 强制重建：结束匹配的旧隧道进程（含别的实例留下的），再拉一条新的。 */
async function tunnelRebuild(cfg, opts) {
    const repairLog = [];
    try {
        if (typeof opts.onRepairTunnelForce === 'function') {
            await opts.onRepairTunnelForce();
            repairLog.push('已结束旧隧道进程并重新拉起（SSH 不可用会自动切 Cloudflare 临时地址）');
        }
        else { repairLog.push('本版本不支持强制重建'); }
    }
    catch (e) { repairLog.push('强制重建失败：' + (e instanceof Error ? e.message : String(e))); }
    await new Promise((r) => setTimeout(r, 2500));
    const result = await tunnelCheck(cfg);
    repairLog.push(result.ok ? '重建后四项检测全部通过' : '重建后仍未通过，缺的是：' + result.steps.filter((x) => !x.ok).map((x) => x.label).join('、'));
    return { ...result, repairLog };
}
function createCore(opts) {
    const config = new config_1.ConfigStore(opts.dataDir);
    const store = new store_1.DataStore(opts.dataDir);
    const cmds = new commands_1.CommandManager();
    const approvals = new security_1.Approvals();
    const log = new log_1.ActivityLog();
    const projects = new projects_1.ProjectStore(opts.dataDir);
    const skills = new skills_1.SkillStore(opts.dataDir);
    const sessions = new Map();
    const term = new terminal_1.PersistentTerminal(cmds, () => config.get().workspaceRoots[0]);
    const ctx = { cfg: config, store, memory: (0, memoryBackend_1.createMemoryBackend)(config, store, { keymapPath: node_path_1.default.join(opts.dataDir, 'hy-keymap.json') }), cmds, term, approvals, log, dataDir: opts.dataDir, projects, skills };
    const agentBridge = (0, agentBridge_1.createAgentBridge)(ctx);
    const panelDir = opts.panelDir ?? node_path_1.default.join(__dirname, '..', 'panel');
    let mcpServer = null;
    let panelServer = null;
    let hySidecar = null;
    /** 随 initialize 下发：工作区说明 + 三段自定义指令 */
    const instructions = () => {
        const c = config.get();
        const root = c.workspaceRoots[0];
        // 动态环境信息：每次 initialize 都重新生成
        const env = [
            `运行环境：${node_os_1.default.type()} ${node_os_1.default.release()}（${node_os_1.default.platform()} ${node_os_1.default.arch()}），主机名 ${node_os_1.default.hostname()}。`,
            `当前工作区：${c.workspaceRoots.join('；')}。文件工具只能访问工作区内的路径（当前设置：${c.allowOutsideWorkspace ? '允许越界' : '不允许越界'}）。`,
        ].join('\n');
        const defaultHead = [
            '你正在通过「六本豆mcp」操作一台 Windows 电脑。',
            '工作流程建议：',
            '1. 接手已有项目先调用 project_context 读取目标与上次交接；阶段结束或准备停下时用 project_checkpoint 写交接，把决策和坑点用 project_note 记下。',
            '2. 查找代码用 search_content（按内容搜索）或 find_files（按文件名查找），不要凭记忆猜文件位置。',
            '3. 修改文件前先 read_file 拿到版本号；写入前可用 edit_preview 看 diff；多文件或多处修改用 apply_patch 一次完成。',
            '4. 修改后用 run_tests 运行测试；构建等耗时命令用 job_start 启动，再用 job_poll（带 wait_ms）取结果；并如实汇报结果，没有运行过的，不要说已经通过。',
            '5. 多个 AI 同时改同一项目时：先 agent_register 注册；改文件前用 reserve_files 预占，改完用 release_files 释放；需要分支隔离时用 worktree_create，完成后用 worktree_remove 清理。',
            '6. 遇到不认识的文件或别人的未提交改动，保留并绕开，不要擅自覆盖。',
            '7. 服务重启后用 wait_for_http 等待它就绪；端口冲突或服务没起来时用 port_status 查看占用进程，必要时用 kill_port 结束（需要审批）。',
            '8. 多步骤任务用 plan_create 一次性拆出带验收标准的任务清单，然后按 task_status 循环执行；开始每个子步骤前用 task_progress 说明正在做什么，完成后用 task_complete 附证据。',
            '9. 不确定的事先查看文件或运行一次检查再下结论，不要凭记忆猜测。',
            '10. 长时间运行的步骤开始前先简短说明正在做什么，完成后汇报结果。',
            '11. 写文件、改文件、运行命令、后台任务、结束进程时，必须带 why 参数，用一句大白话说明理由。缺少 why 会返回 NEEDS_EXPLANATION，补上后重试。用户会在确认卡片上看到这句话。',
        ].join('\n');
        // 优先级：promptProject > promptMain > 默认；customInstructions 始终追加在末尾
        const projectPrompt = (c.promptProject[root] ?? '').trim();
        const mainPrompt = c.promptMain.trim();
        const head = projectPrompt || mainPrompt || defaultHead;
        return [env, head, c.customInstructions.trim()].filter(Boolean).join('\n\n');
    };
    /** 回收空闲超过 sessionIdleMinutes 的会话（每次请求与状态查询时都执行） */
    const pruneSessions = () => {
        const ttl = opts.sessionIdleMsForTest ?? config.get().sessionIdleMinutes * 60 * 1000;
        const now = Date.now();
        for (const [id, seen] of sessions)
            if (now - seen > ttl)
                sessions.delete(id);
    };
    const onlineSessions = () => {
        pruneSessions();
        return sessions.size;
    };
    async function handleMcp(req, res, url) {
        const pathname = url.split('?')[0];
        const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(pathname);
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-expose-headers', 'mcp-session-id');
        if (!m || !(0, security_1.tokenEquals)(m[1], config.get().token))
            return sendText(res, 404, 'not found');
        if (config.get().requireBearer) {
            const auth = String(req.headers.authorization ?? '');
            const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? '';
            if (!bearer || !(0, security_1.tokenEquals)(bearer, config.get().token)) {
                return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: '需要有效的 Bearer 令牌' } });
            }
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'POST, DELETE, GET, OPTIONS',
                'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization',
            });
            return res.end();
        }
        if (req.method === 'GET')
            return sendJson(res, 405, { error: '仅支持 POST（Streamable HTTP）' });
        if (req.method === 'DELETE') {
            const sid = req.headers['mcp-session-id'];
            if (typeof sid === 'string')
                sessions.delete(sid);
            res.writeHead(200);
            return res.end();
        }
        if (req.method !== 'POST')
            return sendJson(res, 405, { error: 'method not allowed' });
        let body;
        try {
            const raw = await readBody(req, 80 * 1024 * 1024);
            body = JSON.parse(raw.toString('utf8') || 'null');
        }
        catch {
            return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const messages = Array.isArray(body) ? body : [body];
        const isInit = messages.some((m) => m?.method === 'initialize');
        const sid = req.headers['mcp-session-id'];
        let newSession;
        if (isInit) {
            newSession = node_crypto_1.default.randomUUID();
            sessions.set(newSession, Date.now());
        }
        else if (typeof sid === 'string') {
            pruneSessions();
            if (!sessions.has(sid)) {
                return sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
            }
            sessions.set(sid, Date.now());
        }
        else {
            return sendJson(res, 400, {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: '缺少 Mcp-Session-Id 请求头，请先发送 initialize' },
            });
        }
        const replies = [];
        for (const m of messages) {
            const r = await (0, mcp_1.handleMessage)(m, { ctx, instructions });
            if (r)
                replies.push(r);
        }
        if (newSession)
            res.setHeader('mcp-session-id', newSession);
        if (replies.length === 0) {
            res.writeHead(202);
            return res.end();
        }
        sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
    }
    async function handleApi(req, res, p, u) {
        const cfg = config.get();
        const method = req.method ?? 'GET';
        try {
            if (method === 'GET' && p === '/api/status') {
                return sendJson(res, 200, {
                    version: config_1.APP_VERSION,
                    mcpUp: !!(mcpServer && mcpServer.listening),
                    mcpUrl: `http://127.0.0.1:${cfg.port}/mcp/${cfg.token}`,
                    token: cfg.token,
                    mcpPort: cfg.port,
                    panelPort: cfg.panelPort,
                    onlineSessions: onlineSessions(),
                    approvalMode: cfg.approvalMode,
                    roots: cfg.workspaceRoots,
                    todos: store.listTodos(),
                    plan: store.getPlan(),
                    progress: store.getProgress(),
                    pending: approvals.list(),
                    running: cmds
                        .list()
                        .filter((j) => j.status === 'running')
                        .map((j) => ({ id: j.id, command: j.command.slice(0, 160), startedAt: j.startedAt })),
                });
            }
            if (method === 'GET' && p === '/api/coord') {
                coord_1.init(opts.dataDir);
                return sendJson(res, 200, coord_1.dashboard(cfg));
            }
            if (method === 'POST' && p === '/api/coord/task-delete') {
                const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
                const dir = String(body.dir || (cfg.workspaceRoots && cfg.workspaceRoots[0]) || '');
                const r = (0, coord_1.deleteTaskById)(dir, body.task_id, body.reason, { agentId: 'panel', force: !!body.force });
                sendJson(res, r.ok ? 200 : 400, r);
                return;
            }
            if (method === 'POST' && p === '/api/coord/plan-delete') {
                const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
                const dir = String(body.dir || (cfg.workspaceRoots && cfg.workspaceRoots[0]) || '');
                const r = (0, coord_1.deletePlanById)(dir, body.reason, { agentId: 'panel', force: !!body.force });
                sendJson(res, r.ok ? 200 : 400, r);
                return;
            }
            if (method === 'POST' && p === '/api/tunnel-repair') {
                return sendJson(res, 200, await tunnelRepair(cfg, opts));
            }
            if (method === 'POST' && p === '/api/tunnel-rebuild') {
                return sendJson(res, 200, await tunnelRebuild(cfg, opts));
            }
            if (method === 'GET' && p === '/api/tunnel-check') {
                return sendJson(res, 200, await tunnelCheck(cfg));
            }
            if (method === 'GET' && p === '/api/tools') {
                return sendJson(res, 200, (0, tools_1.toolCatalog)(cfg.disabledTools));
            }
            if (method === 'GET' && p === '/api/skills') {
                const skillName = u.searchParams.get('name');
                if (skillName) {
                    return sendJson(res, 200, { name: String(skillName), content: skills.read(String(skillName)) });
                }
                return sendJson(res, 200, { skills: skills.list() });
            }
            if (method === 'GET' && p === '/api/transfers') {
                return sendJson(res, 200, (0, transfer_1.listTransfers)(opts.dataDir).slice().reverse());
            }
            if (method === 'GET' && p === '/api/projects') {
                const list = cfg.workspaceRoots.map((root, i) => {
                    const m = projects.load(root);
                    return {
                        path: root,
                        primary: i === 0,
                        exists: node_fs_1.default.existsSync(root),
                        goal: m.goal,
                        status: m.status,
                        handoffs: m.handoffs.length,
                        notes: m.notes.length,
                        lastHandoff: m.handoffs[m.handoffs.length - 1] ?? null,
                    };
                });
                return sendJson(res, 200, list);
            }
            if (method === 'GET' && p === '/api/logs') {
                return sendJson(res, 200, log.list(Number(u.searchParams.get('since') ?? 0)));
            }
            if (method === 'GET' && p === '/api/config')
                return sendJson(res, 200, cfg);
            if (method === 'POST' && p === '/api/config') {
                const patch = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
                const next = config.update(patch);
                const portsChanged = next.port !== cfg.port || next.panelPort !== cfg.panelPort;
                opts.onConfigChanged?.(next);
                sendJson(res, 200, { config: next, restarted: portsChanged });
                if (portsChanged)
                    res.on('finish', () => void restart().catch((e) => console.error(e)));
                return;
            }
            if (method === 'POST' && p === '/api/token') {
                const token = config.regenerateToken();
                return sendJson(res, 200, { token, mcpUrl: `http://127.0.0.1:${cfg.port}/mcp/${token}` });
            }
            const ap = /^\/api\/approvals\/([A-Za-z0-9-]+)$/.exec(p);
            if (method === 'POST' && ap) {
                const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
                const found = approvals.decide(ap[1], body.allow === true);
                return sendJson(res, found ? 200 : 404, { ok: found });
            }
            const fm = /^\/api\/files\/(inbox|outbox)(?:\/([^/]+))?$/.exec(p);
            if (fm) {
                const box = fm[1];
                const dir = node_path_1.default.join(opts.dataDir, box);
                if (method === 'GET' && !fm[2])
                    return sendJson(res, 200, listBox(dir));
                if (method === 'GET' && fm[2]) {
                    const name = (0, security_1.safeName)(decodeURIComponent(fm[2]));
                    const abs = node_path_1.default.join(dir, name);
                    if (!node_fs_1.default.existsSync(abs))
                        return sendText(res, 404, 'not found');
                    res.writeHead(200, {
                        'content-type': 'application/octet-stream',
                        'content-length': node_fs_1.default.statSync(abs).size,
                        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
                    });
                    return node_fs_1.default.createReadStream(abs).pipe(res);
                }
                if (method === 'POST' && box === 'inbox' && !fm[2]) {
                    const name = (0, security_1.safeName)(u.searchParams.get('name'));
                    const data = await readBody(req, transfer_1.UPLOAD_MAX + 1024);
                    if (data.length > transfer_1.UPLOAD_MAX)
                        throw new security_1.ToolError('文件超过 50MB 上限');
                    const saved = (0, transfer_1.saveUnique)(dir, name, data);
                    return sendJson(res, 200, { ok: true, name: saved, size: data.length });
                }
                if (method === 'DELETE' && fm[2]) {
                    const name = (0, security_1.safeName)(decodeURIComponent(fm[2]));
                    const abs = node_path_1.default.join(dir, name);
                    if (!node_fs_1.default.existsSync(abs))
                        return sendJson(res, 404, { error: '文件不存在' });
                    node_fs_1.default.unlinkSync(abs);
                    return sendJson(res, 200, { ok: true });
                }
            }
            if (p.startsWith('/api/agent-bridge/')) {
                const bridgeRes = await agentBridge.handleBridgeApi(
                    method,
                    p,
                    async () => JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}')
                );
                if (bridgeRes) {
                    return sendJson(res, bridgeRes.status, bridgeRes.body);
                }
            }
            return sendJson(res, 404, { error: 'not found' });
        }
        catch (e) {
            return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
    }
    async function handlePanel(req, res, url) {
        const cfg = config.get();
        const host = req.headers.host ?? '';
        if (host !== `127.0.0.1:${cfg.panelPort}` && host !== `localhost:${cfg.panelPort}`) {
            return sendText(res, 403, 'forbidden host');
        }
        const u = new URL(url, 'http://127.0.0.1');
        const p = u.pathname;
        if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
            const file = node_path_1.default.join(panelDir, 'index.html');
            if (!node_fs_1.default.existsSync(file))
                return sendText(res, 500, '找不到面板文件');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return node_fs_1.default.createReadStream(file).pipe(res);
        }
        if (p.startsWith('/api/')) {
            const origins = [`http://127.0.0.1:${cfg.panelPort}`, `http://localhost:${cfg.panelPort}`];
            const origin = req.headers.origin;
            const isBridge = p.startsWith('/api/agent-bridge/');
            const isExtOrigin = typeof origin === 'string' && (origin.startsWith('moz-extension://') || origin.startsWith('chrome-extension://'));
            if (isBridge) {
                res.setHeader('access-control-allow-origin', origin || '*');
                res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
                res.setHeader('access-control-allow-headers', 'content-type, x-panel');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    return res.end();
                }
            }
            if (origin && !origins.includes(origin) && !(isBridge && isExtOrigin))
                return sendJson(res, 403, { error: '来源不允许' });
            if (req.method !== 'GET' && req.headers['x-panel'] !== '1')
                return sendJson(res, 403, { error: '缺少 X-Panel 头' });
            return handleApi(req, res, p, u);
        }
        return sendText(res, 404, 'not found');
    }
    function makeMcpServer() {
        return node_http_1.default.createServer((req, res) => {
            handleMcp(req, res, req.url ?? '/').catch((err) => {
                if (!res.headersSent)
                    sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } });
            });
        });
    }
    /** 只重启 MCP 监听（面板服务器不动，避免掐断正在处理的请求） */
    async function restartMcp() {
        const cfg = config.get();
        if (mcpServer) {
            const old = mcpServer;
            mcpServer = null;
            await new Promise((r) => { old.close(() => r()); if (old.closeAllConnections) old.closeAllConnections(); });
        }
        mcpServer = makeMcpServer();
        await listen(mcpServer, cfg.port);
    }
    function listen(server, port) {
        return new Promise((resolve, reject) => {
            const onError = (e) => reject(e);
            server.once('error', onError);
            server.listen(port, '127.0.0.1', () => {
                server.off('error', onError);
                resolve();
            });
        });
    }
    async function start() {
        config.ensureRoots();
        const cfg = config.get();
        if (ctx.memory && ctx.memory.name === 'hymemory' && !process.env.HY_MEMORY_SIDECAR_URL) {
            hySidecar = new hySidecar_1.HySidecar({ root: node_path_1.default.resolve(__dirname, '..', '..', '..'), dataDir: opts.dataDir, log });
            hySidecar.start().catch(() => { });
        }
        mcpServer = makeMcpServer();
        panelServer = node_http_1.default.createServer((req, res) => {
            handlePanel(req, res, req.url ?? '/').catch((err) => {
                if (!res.headersSent)
                    sendJson(res, 500, { error: String(err) });
            });
        });
        await listen(mcpServer, cfg.port);
        try {
            await listen(panelServer, cfg.panelPort);
        }
        catch (e) {
            mcpServer.close();
            mcpServer = null;
            throw e;
        }
    }
    async function stop() {
        const servers = [mcpServer, panelServer].filter((s) => s !== null);
        await Promise.all(servers.map((s) => new Promise((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
        })));
        mcpServer = null;
        panelServer = null;
        if (hySidecar) {
            hySidecar.stop();
            hySidecar = null;
        }
        term.stop();
    }
    async function restart() {
        await stop();
        await start();
    }
    return { config, start, stop, restart, restartMcp };
}
