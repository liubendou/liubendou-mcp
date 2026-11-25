"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAgentBridge = createAgentBridge;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const config_1 = require("./config");
const security_1 = require("./security");
const fileOps_1 = require("./fileOps");
const tools_1 = require("./tools");

function buildHandshakePrompt(ctx) {
    const cfg = ctx.cfg.get();
    const root = cfg.workspaceRoots[0] || process.cwd();
    const lines = [
        `你现在已通过「六本豆本地 Agent 桥接器 (arena-mcp-bridge)」连接到用户的本地 Windows 电脑（${node_os_1.default.type()} ${node_os_1.default.release()}）。`,
        `当前默认工作区目录：\`${root}\`（支持相对工作区路径或工作区内的绝对路径${cfg.allowOutsideWorkspace ? '，已开启允许访问工作区外路径' : ''}）。`,
        '',
        '### 本地工具调用协议（必须严格遵守）',
        '当你需要查看电脑文件、搜索代码、修改文件或执行终端命令时，请直接输出一个语言标记为 `mcp-call` 的代码块，内容为单行或多行 JSON，格式如下：',
        '```mcp-call',
        '{"name": "工具名", "arguments": {"参数名": "参数值"}}',
        '```',
        '重要规则：',
        '1. 每次输出 `mcp-call` 代码块后请**立即停止本轮回答**，不要自己编造执行结果。',
        '2. 本地桥接器会自动拦截 `mcp-call` 并在本机真实执行，随后将真实输出以 `mcp-result` 代码块发回给你，你可以根据结果继续下一步调用，直到完成任务。',
        '3. 如果一次需要调用多个相互独立的只读工具，可以连续输出多个 `mcp-call` 代码块。',
        '',
        '### 常用本地工具速查表',
        '- `list_dir`：列出目录内容。参数：`{"path": "."}`',
        '- `find_files`：按通配符找文件。参数：`{"pattern": "*.js", "path": "."}`',
        '- `search_content`：按正则搜索代码内容。参数：`{"pattern": "function\\s+main", "path": ".", "case_insensitive": true}`',
        '- `read_file`：读取文件内容与行号。参数：`{"path": "相对或绝对路径", "start_line": 1, "end_line": 200}`',
        '- `write_file`：新建或覆盖文件。参数：`{"path": "路径", "content": "完整内容", "why": "简述原因"}`',
        '- `edit_file`：精确替换文件中唯一出现的片段。参数：`{"path": "路径", "old_text": "原片段", "new_text": "新片段", "why": "简述原因"}`',
        '- `apply_patch`：多处或多文件补丁修改。参数：`{"patch": "*** Begin Patch\\n*** Update File: a.txt\\n@@\\n-old\\n+new\\n*** End Patch", "why": "简述原因"}`',
        '- `run_command`：在本地 PowerShell 持久终端执行命令。参数：`{"command": "命令", "cwd": ".", "why": "简述原因"}`',
        '- `command_output`：查看后台或超时命令输出。参数：`{"id": "命令id"}`',
        '- `git_status` / `git_diff` / `git_log`：查看 Git 状态与改动。参数：`{"cwd": "."}`',
        '- `memory_search` / `memory_set`：检索或写入本地跨会话记忆。参数：`{"query": "关键词"}` / `{"key": "键", "value": "值"}`',
        '',
        '收到此消息后，如果你已准备好，请简短回复：「已连接本地电脑工具（工作区：`' + root + '`），请直接告诉我你要处理的任务。」（若下方附带了【用户任务】，请直接开始调用工具执行该任务！）'
    ];
    return lines.join('\n');
}

function createAgentBridge(ctx) {
    const sessions = new Map();
    const execHistory = [];

    function pruneSessions() {
        const now = Date.now();
        for (const [id, s] of sessions) {
            if (now - s.lastSeen > 5 * 60 * 1000 && (!s.commandQueue || s.commandQueue.length === 0)) {
                sessions.delete(id);
            }
        }
    }

    function getSessionList() {
        pruneSessions();
        const now = Date.now();
        return Array.from(sessions.values())
            .map((s) => ({
                sessionId: s.sessionId,
                clientId: s.clientId,
                tabId: s.tabId,
                url: s.url,
                title: s.title,
                busy: !!s.busy,
                stepCount: s.stepCount || 0,
                maxSteps: s.maxSteps || 12,
                autoExec: s.autoExec !== false,
                forceAgent: s.forceAgent !== false,
                online: now - s.lastSeen < 15000,
                lastSeen: s.lastSeen,
                queuedCommands: s.commandQueue.length,
                messages: Array.isArray(s.messages) ? s.messages : [],
            }))
            .sort((a, b) => b.lastSeen - a.lastSeen);
    }

    function pickTargetSession(requestedSessionId) {
        pruneSessions();
        if (requestedSessionId && sessions.has(requestedSessionId)) {
            return sessions.get(requestedSessionId);
        }
        let best = null;
        for (const s of sessions.values()) {
            if (!best || s.lastSeen > best.lastSeen) {
                best = s;
            }
        }
        return best;
    }

    async function execBridgeTool(name, rawArgs) {
        const t0 = Date.now();
        const toolName = String(name || '').trim();
        const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? { ...rawArgs } : {};
        if (!args.why) {
            args.why = '本地 Agent 桥接自动执行';
        }
        if ((toolName === 'run_command' || toolName === 'job_start') && args.allow_non_ascii === undefined) {
            args.allow_non_ascii = true;
        }
        if ((toolName === 'write_file' || toolName === 'edit_file') && args.path && !args.expected_version) {
            try {
                const cfg = ctx.cfg.get();
                const abs = (0, security_1.resolveInRoots)(cfg.workspaceRoots, String(args.path), undefined, cfg.allowOutsideWorkspace);
                if (node_fs_1.default.existsSync(abs) && node_fs_1.default.statSync(abs).isFile()) {
                    args.expected_version = (0, fileOps_1.sha256)(node_fs_1.default.readFileSync(abs));
                }
            }
            catch { }
        }
        const res = await (0, tools_1.callTool)(toolName, args, ctx);
        const ms = Date.now() - t0;
        const output = Array.isArray(res?.content)
            ? res.content.map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c))).join('\n')
            : String(res ?? '');
        const isError = !!res?.isError;
        const record = {
            id: node_crypto_1.default.randomUUID().slice(0, 8),
            ts: new Date().toISOString(),
            tool: toolName,
            args: JSON.stringify(rawArgs || {}).slice(0, 240),
            ok: !isError,
            isError,
            ms,
            outputPreview: output.slice(0, 600),
        };
        execHistory.push(record);
        if (execHistory.length > 100) {
            execHistory.splice(0, execHistory.length - 100);
        }
        return {
            ok: !isError,
            isError,
            tool: toolName,
            ms,
            output,
        };
    }

    async function handleBridgeApi(method, pathname, readJsonBody) {
        const cfg = ctx.cfg.get();
        const enabledTools = (0, tools_1.toolCatalog)(cfg.disabledTools).filter((t) => t.enabled);

        if (method === 'GET' && pathname === '/api/agent-bridge/status') {
            return {
                status: 200,
                body: {
                    ok: true,
                    version: config_1.APP_VERSION,
                    workspace: cfg.workspaceRoots[0] || '',
                    roots: cfg.workspaceRoots,
                    allowOutsideWorkspace: !!cfg.allowOutsideWorkspace,
                    toolCount: enabledTools.length,
                    sessions: getSessionList(),
                    execHistory: execHistory.slice(-40).reverse(),
                },
            };
        }

        if (method === 'POST' && pathname === '/api/agent-bridge/handshake') {
            return {
                status: 200,
                body: {
                    ok: true,
                    workspace: cfg.workspaceRoots[0] || '',
                    toolCount: enabledTools.length,
                    prompt: buildHandshakePrompt(ctx),
                },
            };
        }

        if (method === 'POST' && pathname === '/api/agent-bridge/exec') {
            const body = await readJsonBody();
            if (!body || !body.name) {
                return { status: 400, body: { ok: false, isError: true, error: '缺少工具名称 name' } };
            }
            const result = await execBridgeTool(body.name, body.arguments);
            return { status: 200, body: result };
        }

        if (method === 'POST' && pathname === '/api/agent-bridge/sync') {
            const body = await readJsonBody();
            const clientId = String(body.clientId || 'browser').slice(0, 64);
            const tabId = Number(body.tabId) || 0;
            const sessionId = `${clientId}:${tabId}`;
            let s = sessions.get(sessionId);
            if (!s) {
                s = {
                    sessionId,
                    clientId,
                    tabId,
                    url: '',
                    title: '',
                    busy: false,
                    stepCount: 0,
                    maxSteps: 12,
                    autoExec: true,
                    forceAgent: true,
                    messages: [],
                    commandQueue: [],
                    lastSeen: Date.now(),
                };
                sessions.set(sessionId, s);
            }
            s.url = String(body.url || s.url || '');
            s.title = String(body.title || s.title || '');
            s.busy = !!body.busy;
            s.stepCount = Number(body.stepCount) || 0;
            s.maxSteps = Number(body.maxSteps) || 12;
            if (body.autoExec !== undefined) s.autoExec = !!body.autoExec;
            if (body.forceAgent !== undefined) s.forceAgent = !!body.forceAgent;
            if (Array.isArray(body.messages)) {
                s.messages = body.messages.slice(-30).map((m) => ({
                    role: m?.role === 'user' ? 'user' : 'assistant',
                    text: String(m?.text || '').slice(0, 12000),
                }));
            }
            s.lastSeen = Date.now();
            const commands = s.commandQueue.splice(0, s.commandQueue.length);
            return {
                status: 200,
                body: {
                    ok: true,
                    sessionId,
                    workspace: cfg.workspaceRoots[0] || '',
                    toolCount: enabledTools.length,
                    commands,
                },
            };
        }

        if (method === 'POST' && pathname === '/api/agent-bridge/command') {
            const body = await readJsonBody();
            const action = String(body.action || '').trim();
            if (action === 'clear_history') {
                execHistory.length = 0;
                return { status: 200, body: { ok: true } };
            }
            const target = pickTargetSession(body.sessionId ? String(body.sessionId) : '');
            if (!target) {
                return {
                    status: 404,
                    body: {
                        ok: false,
                        error: '当前没有在线的 Arena 浏览器实例，请先在「六本豆工作台」打开一个实例（支持隐身模式）',
                    },
                };
            }
            const cmdId = node_crypto_1.default.randomUUID().slice(0, 8);
            if (action === 'send_prompt') {
                const rawText = String(body.text || '').trim();
                if (!rawText) {
                    return { status: 400, body: { ok: false, error: '发送内容不能为空' } };
                }
                const finalPrompt = body.withHandshake
                    ? `${buildHandshakePrompt(ctx)}\n\n---\n### 【用户任务】\n${rawText}`
                    : rawText;
                target.commandQueue.push({ id: cmdId, type: 'send_prompt', text: finalPrompt, createdAt: Date.now() });
            }
            else if (action === 'inject_handshake') {
                target.commandQueue.push({
                    id: cmdId,
                    type: 'send_prompt',
                    text: buildHandshakePrompt(ctx),
                    createdAt: Date.now(),
                });
            }
            else if (action === 'new_chat') {
                target.commandQueue.push({
                    id: cmdId,
                    type: 'new_chat',
                    autoHandshake: !!body.autoHandshake,
                    createdAt: Date.now(),
                });
            }
            else if (action === 'stop' || action === 'reset_steps') {
                target.commandQueue.push({ id: cmdId, type: action, createdAt: Date.now() });
            }
            else if (action === 'set_prefs') {
                target.commandQueue.push({
                    id: cmdId,
                    type: 'set_prefs',
                    prefs: body.prefs || {},
                    createdAt: Date.now(),
                });
            }
            else {
                return { status: 400, body: { ok: false, error: `未知指令动作：${action}` } };
            }
            return {
                status: 200,
                body: {
                    ok: true,
                    sessionId: target.sessionId,
                    queued: target.commandQueue.length,
                },
            };
        }

        return null;
    }

    return {
        handleBridgeApi,
        getSessionList,
        execBridgeTool,
        buildHandshakePrompt,
    };
}

