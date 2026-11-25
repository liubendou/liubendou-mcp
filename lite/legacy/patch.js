"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePatch = parsePatch;
exports.applyHunks = applyHunks;
exports.applyPatchText = applyPatchText;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const security_1 = require("./security");
const fileOps_1 = require("./fileOps");
/**
 * 解析 Codex 风格补丁：
 *   *** Begin Patch
 *   *** Add File: path      （内容行以 + 开头）
 *   *** Update File: path   （可选 *** Move to: newpath；@@ 开始一个片段；行以空格/-/+ 开头）
 *   *** Delete File: path
 *   *** End Patch
 */
function parsePatch(src) {
    const raw = src.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < raw.length && raw[i].trim() === '')
        i++;
    if (raw[i]?.trim() !== '*** Begin Patch')
        throw new security_1.ToolError('补丁必须以 *** Begin Patch 开头');
    i++;
    const ops = [];
    const last = () => ops[ops.length - 1];
    let ended = false;
    for (; i < raw.length; i++) {
        const line = raw[i];
        const head = line.trimEnd();
        if (head === '*** End Patch') {
            ended = true;
            break;
        }
        let m;
        if ((m = /^\*\*\* Add File: (.+)$/.exec(head))) {
            ops.push({ kind: 'add', path: m[1].trim(), lines: [] });
            continue;
        }
        if ((m = /^\*\*\* Delete File: (.+)$/.exec(head))) {
            ops.push({ kind: 'delete', path: m[1].trim() });
            continue;
        }
        if ((m = /^\*\*\* Update File: (.+)$/.exec(head))) {
            ops.push({ kind: 'update', path: m[1].trim(), hunks: [] });
            continue;
        }
        const cur = last();
        if (!cur) {
            if (head === '')
                continue;
            throw new security_1.ToolError(`无法识别的补丁行：${line}`);
        }
        if ((m = /^\*\*\* Move to: (.+)$/.exec(head)) && cur.kind === 'update') {
            cur.moveTo = m[1].trim();
            continue;
        }
        if (cur.kind === 'add') {
            if (!line.startsWith('+'))
                throw new security_1.ToolError(`Add File 的内容行必须以 + 开头：${line}`);
            cur.lines.push(line.slice(1));
            continue;
        }
        if (cur.kind === 'update') {
            if (line.startsWith('@@')) {
                cur.hunks.push({ lines: [] });
                continue;
            }
            if (cur.hunks.length === 0)
                cur.hunks.push({ lines: [] });
            const hunk = cur.hunks[cur.hunks.length - 1];
            if (line === '') {
                hunk.lines.push({ t: ' ', s: '' });
                continue;
            }
            const c = line[0];
            if (c !== ' ' && c !== '-' && c !== '+') {
                throw new security_1.ToolError(`Update 中的行必须以空格、- 或 + 开头：${line}`);
            }
            hunk.lines.push({ t: c, s: line.slice(1) });
            continue;
        }
        // delete 之后的多余行
        if (head !== '')
            throw new security_1.ToolError(`Delete File 之后不能有内容：${line}`);
    }
    if (!ended)
        throw new security_1.ToolError('补丁缺少 *** End Patch');
    if (ops.length === 0)
        throw new security_1.ToolError('补丁中没有任何文件操作');
    return ops;
}
function findAll(lines, block, loose) {
    const eq = (a, b) => (loose ? a.trimEnd() === b.trimEnd() : a === b);
    const out = [];
    for (let i = 0; i + block.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < block.length; j++) {
            if (!eq(lines[i + j], block[j])) {
                ok = false;
                break;
            }
        }
        if (ok)
            out.push(i);
    }
    return out;
}
/** 把片段应用到文本上；片段按顺序匹配，且每个片段的上下文必须唯一 */
function applyHunks(text, hunks, label) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const endsNl = text.endsWith('\n');
    const lines = text === '' ? [] : text.split(/\r?\n/);
    if (endsNl)
        lines.pop();
    let cursor = 0;
    for (const h of hunks) {
        const oldBlock = h.lines.filter((l) => l.t !== '+').map((l) => l.s);
        const newBlock = h.lines.filter((l) => l.t !== '-').map((l) => l.s);
        if (oldBlock.length === 0) {
            throw new security_1.ToolError(`${label}：新增片段必须带上下文行（空格开头的行），否则无法定位`);
        }
        let matches = findAll(lines, oldBlock, false);
        if (matches.length === 0)
            matches = findAll(lines, oldBlock, true);
        if (matches.length === 0) {
            const preview = oldBlock.slice(0, 4).join('\n');
            throw new security_1.ToolError(`${label}：找不到补丁上下文，请先 read_file 确认原文。上下文开头为：\n${preview}`);
        }
        const after = matches.filter((m) => m >= cursor);
        const pick = after.length ? after : matches;
        if (pick.length > 1) {
            throw new security_1.ToolError(`${label}：补丁上下文匹配了 ${pick.length} 处，请增加上下文行使其唯一`);
        }
        const at = pick[0];
        lines.splice(at, oldBlock.length, ...newBlock);
        cursor = at + newBlock.length;
    }
    return lines.length === 0 ? '' : lines.join(eol) + (endsNl ? eol : '');
}
/**
 * 应用补丁：先在内存里计算全部结果（任何失败都不改磁盘），
 * 全部通过后才写入（先写临时文件，再统一重命名）。
 */
function applyPatchText(roots, src, expectedVersions = {}, allowOutside = false) {
    const ops = parsePatch(src);
    const virtual = new Map(); // 绝对路径 -> 新内容（null 表示删除）
    const summary = [];
    const current = (abs, rel) => {
        if (virtual.has(abs)) {
            const v = virtual.get(abs);
            if (v === null || v === undefined)
                throw new security_1.ToolError(`文件已被删除：${rel}`);
            return v;
        }
        if (!node_fs_1.default.existsSync(abs))
            throw new security_1.ToolError(`文件不存在：${rel}`);
        return node_fs_1.default.readFileSync(abs, 'utf8');
    };
    const exists = (abs) => {
        if (virtual.has(abs))
            return virtual.get(abs) !== null;
        return node_fs_1.default.existsSync(abs);
    };
    for (const op of ops) {
        const abs = (0, security_1.resolveInRoots)(roots, op.path, undefined, allowOutside);
        if (op.kind === 'add') {
            if (exists(abs))
                throw new security_1.ToolError(`Add File 失败，文件已存在：${op.path}`);
            const content = op.lines.length ? op.lines.join('\n') + '\n' : '';
            virtual.set(abs, content);
            summary.push(`新增 ${op.path}`);
        }
        else if (op.kind === 'delete') {
            if (!exists(abs))
                throw new security_1.ToolError(`Delete File 失败，文件不存在：${op.path}`);
            virtual.set(abs, null);
            summary.push(`删除 ${op.path}`);
        }
        else {
            const text = current(abs, op.path);
            if (expectedVersions[op.path] && node_fs_1.default.existsSync(abs)) {
                const disk = (0, fileOps_1.sha256)(node_fs_1.default.readFileSync(abs));
                if (disk !== expectedVersions[op.path]) {
                    throw new security_1.ToolError(`STALE_FILE：${op.path} 已被修改（当前版本：${disk}），请重新 read_file`);
                }
            }
            const next = applyHunks(text, op.hunks, op.path);
            if (op.moveTo) {
                const dest = (0, security_1.resolveInRoots)(roots, op.moveTo, undefined, allowOutside);
                virtual.set(abs, null);
                virtual.set(dest, next);
                summary.push(`移动 ${op.path} -> ${op.moveTo} 并修改`);
            }
            else {
                virtual.set(abs, next);
                summary.push(`修改 ${op.path}`);
            }
        }
    }
    // 提交：先全部写入临时文件，再统一重命名，减少中途失败的影响
    const staged = [];
    try {
        for (const [abs, content] of virtual) {
            if (content === null)
                continue;
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(abs), { recursive: true });
            const tmp = abs + '.lac-tmp-' + process.pid + '-' + staged.length;
            node_fs_1.default.writeFileSync(tmp, content, 'utf8');
            staged.push({ abs, tmp });
        }
    }
    catch (e) {
        for (const s of staged)
            node_fs_1.default.rmSync(s.tmp, { force: true });
        throw e;
    }
    for (const s of staged)
        node_fs_1.default.renameSync(s.tmp, s.abs);
    for (const [abs, content] of virtual) {
        if (content === null && node_fs_1.default.existsSync(abs))
            node_fs_1.default.unlinkSync(abs);
    }
    const versions = [...virtual.entries()]
        .filter(([, v]) => v !== null)
        .map(([abs, v]) => `${node_path_1.default.basename(abs)} -> ${(0, fileOps_1.sha256)(v).slice(0, 12)}`);
    return { summary: [...summary, ...versions.map((v) => `新版本：${v}`)] };
}
