"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TEXT_BYTES = void 0;
exports.sha256 = sha256;
exports.toRel = toRel;
exports.readTextFile = readTextFile;
exports.globToRegex = globToRegex;
exports.walk = walk;
exports.findFiles = findFiles;
exports.searchContent = searchContent;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const security_1 = require("./security");
exports.MAX_TEXT_BYTES = 4 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information']);
const WIN = process.platform === 'win32';
function sha256(data) {
    return node_crypto_1.default.createHash('sha256').update(data).digest('hex');
}
function toRel(base, abs) {
    return node_path_1.default.relative(base, abs).split(node_path_1.default.sep).join('/') || '.';
}
function readTextFile(abs) {
    if (!node_fs_1.default.existsSync(abs))
        throw new security_1.ToolError(`文件不存在：${abs}`);
    const st = node_fs_1.default.statSync(abs);
    if (st.isDirectory())
        throw new security_1.ToolError('这是目录，不是文件');
    if (st.size > exports.MAX_TEXT_BYTES)
        throw new security_1.ToolError(`文件过大（${st.size} 字节，上限 4MB）`);
    const buf = node_fs_1.default.readFileSync(abs);
    if (buf.includes(0))
        throw new security_1.ToolError('文件看起来是二进制文件（图片请用 read_image）');
    return { buf, text: buf.toString('utf8'), version: sha256(buf) };
}
/** 通配符转正则：* 不跨 /，** 跨目录，? 匹配单个字符 */
function globToRegex(glob) {
    const g = glob.replace(/\\/g, '/');
    let re = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                i++;
                if (g[i + 1] === '/') {
                    i++;
                    re += '(?:.*/)?';
                }
                else {
                    re += '.*';
                }
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$', WIN ? 'i' : '');
}
function* walk(root, maxFiles = 20000) {
    const stack = [root];
    let count = 0;
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const full = node_path_1.default.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name.toLowerCase()))
                    stack.push(full);
            }
            else if (e.isFile()) {
                yield full;
                if (++count >= maxFiles)
                    return;
            }
        }
    }
}
function findFiles(base, pattern, limit = 500) {
    const g = pattern.replace(/\\/g, '/');
    const byName = !g.includes('/');
    const re = globToRegex(g);
    const out = [];
    for (const f of walk(base)) {
        const rel = toRel(base, f);
        if (re.test(byName ? node_path_1.default.basename(f) : rel)) {
            out.push(rel);
            if (out.length >= limit)
                break;
        }
    }
    return out;
}
function searchContent(base, pattern, opts) {
    let re;
    try {
        re = new RegExp(pattern, opts.caseInsensitive ? 'i' : '');
    }
    catch (e) {
        throw new security_1.ToolError(`正则无效：${e.message}`);
    }
    const fileRe = opts.fileGlob ? globToRegex(opts.fileGlob) : null;
    const limit = opts.limit ?? 300;
    const matches = [];
    for (const f of walk(base)) {
        if (fileRe && !fileRe.test(node_path_1.default.basename(f)))
            continue;
        let size = 0;
        try {
            size = node_fs_1.default.statSync(f).size;
        }
        catch {
            continue;
        }
        if (size > 2 * 1024 * 1024)
            continue;
        let buf;
        try {
            buf = node_fs_1.default.readFileSync(f);
        }
        catch {
            continue;
        }
        if (buf.includes(0))
            continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                matches.push(`${toRel(base, f)}:${i + 1}: ${lines[i].slice(0, 300)}`);
                if (matches.length >= limit)
                    return { matches, truncated: true };
            }
        }
    }
    return { matches, truncated: false };
}
