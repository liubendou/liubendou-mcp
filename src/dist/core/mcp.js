"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_PROTOCOLS = void 0;
exports.handleMessage = handleMessage;
const config_1 = require("./config");
const tools_1 = require("./tools");
exports.SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** 处理一条 JSON-RPC 消息；通知（无 id）返回 null */
async function handleMessage(msg, deps) {
    const id = msg && typeof msg === 'object' && msg.id !== undefined ? msg.id : null;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!msg || typeof msg !== 'object')
        return fail(-32600, 'Invalid Request');
    if (typeof msg.method !== 'string')
        return msg.id === undefined ? null : fail(-32600, 'Invalid Request');
    switch (msg.method) {
        case 'initialize': {
            const requested = msg.params?.protocolVersion;
            const version = exports.SUPPORTED_PROTOCOLS.includes(requested) ? requested : exports.SUPPORTED_PROTOCOLS[0];
            return ok({
                protocolVersion: version,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'local-ai-console', title: '六本豆mcp', version: config_1.APP_VERSION },
                instructions: deps.instructions(),
            });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return null;
        case 'ping':
            return ok({});
        case 'tools/list':
            return ok({ tools: (0, tools_1.listTools)(deps.ctx.cfg.get().disabledTools) });
        case 'tools/call': {
            const name = msg.params?.name;
            if (typeof name !== 'string')
                return fail(-32602, 'Invalid params: name 必须是字符串');
            return ok(await (0, tools_1.callTool)(name, msg.params?.arguments ?? {}, deps.ctx));
        }
        default:
            return msg.id === undefined ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
}
