"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Approvals = exports.ToolError = void 0;
exports.assertNoReservedName = assertNoReservedName;
exports.resolveInRoots = resolveInRoots;
exports.safeName = safeName;
exports.isDangerousCommand = isDangerousCommand;
exports.needsApproval = needsApproval;
exports.tokenEquals = tokenEquals;
exports.classifyCommand = classifyCommand;
exports.commandGate = commandGate;
exports.assertAsciiCommand = assertAsciiCommand;
exports.scrubSecrets = scrubSecrets;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
class ToolError extends Error {
}
exports.ToolError = ToolError;
const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);
/** 对路径取真实位置（跟随符号链接）；路径不存在时，对最近的已存在父目录取真实路径 */
function realpathLoose(p) {
    let cur = node_path_1.default.resolve(p);
    const tail = [];
    while (!node_fs_1.default.existsSync(cur)) {
        const parent = node_path_1.default.dirname(cur);
        if (parent === cur)
            break;
        tail.unshift(node_path_1.default.basename(cur));
        cur = parent;
    }
    const real = node_fs_1.default.existsSync(cur) ? node_fs_1.default.realpathSync(cur) : cur;
    return node_path_1.default.join(real, ...tail);
}
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
/** 拦截 Windows 保留设备名（CON、NUL、COM1 等，忽略扩展名与大小写） */
function assertNoReservedName(p) {
    for (const seg of p.split(/[\\/]+/)) {
        const base = seg.replace(/[ .]+$/, '').split('.')[0];
        if (base && RESERVED.test(base))
            throw new ToolError(`路径包含 Windows 保留名：${seg}`);
    }
}
/**
 * 把用户给的路径解析为真实路径。
 * allowOutside=false 时，越界（含通过符号链接越界）抛出 ToolError；
 * allowOutside=true 时不限制位置，但保留名与空路径仍然拒绝。
 */
function resolveInRoots(roots, p, base, allowOutside = false) {
    if (typeof p !== 'string' || p.trim() === '')
        throw new ToolError('路径不能为空');
    assertNoReservedName(p);
    const abs = node_path_1.default.resolve(base ?? roots[0], p);
    const real = realpathLoose(abs);
    if (allowOutside)
        return real;
    for (const root of roots) {
        const rel = node_path_1.default.relative(fold(realpathLoose(root)), fold(real));
        const inside = rel === '' || (rel !== '..' && !rel.startsWith('..' + node_path_1.default.sep) && !node_path_1.default.isAbsolute(rel));
        if (inside)
            return real;
    }
    throw new ToolError(`路径不在允许的工作区内：${abs}`);
}
/** 文件名只允许单个安全的文件名（用于收件箱/发件箱） */
function safeName(name) {
    const raw = String(name ?? '').trim();
    if (!raw || raw.includes('/') || raw.includes('\\'))
        throw new ToolError('文件名无效');
    if (raw === '.' || raw === '..' || /[<>:"|?*\x00-\x1f]/.test(raw))
        throw new ToolError('文件名无效');
    return raw;
}
const DANGEROUS_A_PATTERNS = [
    // A类：不可逆 / 系统级——必须 confirm:"YES" 明示授权（或面板批准）
    /\brm\s+-[a-zA-Z]*r/i,
    /\brm\s+-[a-zA-Z]*f/i,
    /\bdel\s+\/s/i,
    /\berase\s+\/s/i,
    /\bRemove-Item\b[^\n;]*(?:-Recurse|-r\b)/i,
    /\bformat(?:\.com)?\s+[a-z]:/i,
    /\bformat-volume\b/i,
    /\bdiskpart\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bcipher\s+\/w/i,
    /\bshutdown\b/i,
    /\brestart-computer\b/i,
    /\breg\s+(delete|import)\b/i,
    /\bsc\s+delete\b/i,
    /\bmsiexec\b/i,
    /\bgit\s+(push\b.*(--force|\s-f\b)|reset\s+--hard|clean\s+-\w*f)/i,
    /\b(npm|pnpm|yarn)\b.*\s(-g|--global)\b.*\b(uninstall|remove)\b/i,
    /\b(winget|choco|scoop)\s+(uninstall|remove)\b/i,
    /\bschtasks\s+\/(delete|change)\b/i,
    /\|\s*(sh|bash|powershell|pwsh|iex)\b/i,
    /\bInvoke-Expression\b|\biex\b/i,
];
const DANGEROUS_B_PATTERNS = [
    // B类：影响运行、可恢复——放行但输出提醒
    /\bStop-Process\b/i,
    /\btaskkill\b/i,
    /\bRemove-Item\b/i,
    /\brm\b/i,
    /\bdel\b/i,
    /\berase\b/i,
    /\brmdir\b/i,
    /\brd\b/i,
    /\bsc\s+(stop|config)\b/i,
    /\bschtasks\s+\/(run|end)\b/i,
    /\breg\s+add\b/i,
    /\b(npm|pnpm|yarn)\b.*\s(-g|--global)\b/i,
    /\bchmod\s+-R\b/i,
];
function classifyCommand(cmd) {
    const s = String(cmd || '');
    if (DANGEROUS_A_PATTERNS.some((re) => re.test(s)))
        return 'A';
    if (DANGEROUS_B_PATTERNS.some((re) => re.test(s)))
        return 'B';
    return '';
}
function isDangerousCommand(cmd) {
    return classifyCommand(cmd) !== '';
}
/** A类命令：无 confirm/未获批准直接拒绝并给替代指引；B类给提醒 */
function commandGate(cmd, confirm, approved) {
    const cls = classifyCommand(String(cmd || ''));
    if (cls === 'A') {
        const ok = String(confirm || '').trim().toUpperCase() === 'YES' || approved === true;
        if (!ok)
            throw new ToolError('A类危险命令（不可逆：递归删除/格式化/注册表删除/强推代码等）：必须传 confirm:"YES" 明示授权（或在面板批准）后才能执行。若只想删普通文件，请去掉 -Recurse/-Force 等参数；改文件优先用 apply_patch/write_file。');
        return { cls, note: '[授权] A类危险命令，已获授权执行。' };
    }
    if (cls === 'B') {
        const tray = /Stop-Process|taskkill/i.test(String(cmd || ''));
        return { cls, note: tray
            ? '[提醒] 结束进程类命令：窗口 × 只是缩托盘，执行后请在进程列表确认目标进程确已退出。'
            : '[提醒] 该命令影响运行中的进程/服务/文件（可恢复）：如在打包或验证，记得随后恢复现场并记入 CHANGELOG。' };
    }
    return { cls, note: '' };
}
/** 命令文本必须纯 ASCII（防 PowerShell 控制台 GBK 乱码解析崩）；确需非 ASCII 时 allow=true */
function assertAsciiCommand(cmd, allow) {
    if (allow === true)
        return;
    if (/[^\x00-\x7F]/.test(String(cmd || ''))) {
        throw new ToolError('命令文本含非 ASCII 字符（中文等）：Windows PowerShell 控制台会把它们变成乱码并导致解析失败。请把中文内容用 write_file 写入文件后，用纯 ASCII 命令读取处理（如 Get-Content -Encoding UTF8）；或用变量拼接/8.3 短名。确实需要非 ASCII 时传 allow_non_ascii:true。');
    }
}
/** 输出脱敏：私钥块、token/secret 键值、mcp 路径 token、会话 id */
function scrubSecrets(s) {
    let t = String(s ?? '');
    t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]');
    t = t.replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, (_m, k, eq) => `${k}${eq}***`);
    t = t.replace(/(\/mcp\/)[A-Za-z0-9_\-]{8,}/g, '$1***');
    t = t.replace(/(mcp-session-id['":\s=]+)[A-Za-z0-9\-]{8,}/gi, '$1***');
    return t;
}
function needsApproval(mode, tool, args) {
    const cmd = (tool === 'run_command' || tool === 'job_start') ? String((args && args.command) ?? '') : '';
    const preauth = String((args && args.confirm) || '').trim().toUpperCase() === 'YES';
    if (mode === 'never')
        return { need: false, reason: '' };
    if (mode === 'always')
        return { need: true, reason: `「每次确认」模式：每次调用都需要确认（${tool}）` };
    if (cmd && classifyCommand(cmd) === 'A' && !preauth) {
        return { need: true, reason: 'A类危险命令（不可逆）：请在面板批准，或传 confirm:"YES" 明示授权' };
    }
    if (cmd && !preauth && isDangerousCommand(cmd)) {
        return { need: true, reason: '命令可能删除、修改系统设置或发起危险操作' };
    }
    if (tool === 'kill_port') {
        return { need: true, reason: '会结束占用该端口的进程' };
    }
    if (['ui_click', 'ui_type', 'ui_key', 'ui_focus'].includes(tool)) {
        return { need: true, reason: '会控制鼠标或键盘，可能影响你正在使用的软件' };
    }
    return { need: false, reason: '' };
}
function tokenEquals(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && node_crypto_1.default.timingSafeEqual(x, y);
}
const APPROVAL_TIMEOUT_MS = 120_000;
/** 待审批队列：工具调用挂起，直到面板允许/拒绝，或超时（视为拒绝） */
class Approvals {
    items = new Map();
    request(tool, summary, reason) {
        const id = node_crypto_1.default.randomUUID().slice(0, 8);
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.decide(id, false), APPROVAL_TIMEOUT_MS);
            this.items.set(id, {
                item: { id, tool, summary, reason, createdAt: new Date().toISOString() },
                resolve,
                timer,
            });
        });
    }
    list() {
        return [...this.items.values()].map((v) => v.item);
    }
    decide(id, allow) {
        const entry = this.items.get(id);
        if (!entry)
            return false;
        clearTimeout(entry.timer);
        this.items.delete(id);
        entry.resolve(allow);
        return true;
    }
}
exports.Approvals = Approvals;