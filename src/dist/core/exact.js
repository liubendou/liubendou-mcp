"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyExactEdits = applyExactEdits;
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const security_1 = require("./security");
const fileOps_1 = require("./fileOps");
/**
 * 精确替换（old/new）：多个文件、多处修改一次完成。
 * - 必须提供 expected_versions（每个被改文件的 read_file 版本号），防止覆盖并发改动；
 * - old_text 必须唯一（replace_all=true 时可替换全部）；
 * - 所有编辑先在内存中校验并计算，全部成功才写入（写入用临时文件 + 重命名）。
 */
function applyExactEdits(roots, edits, expected, allowOutside) {
    if (edits.length === 0)
        throw new security_1.ToolError('edits 不能为空');
    const files = new Map();
    for (const [i, e] of edits.entries()) {
        const key = String(e.path ?? '');
        if (!key)
            throw new security_1.ToolError(`第 ${i + 1} 处编辑缺少 path`);
        if (!e.old_text)
            throw new security_1.ToolError(`第 ${i + 1} 处编辑的 old_text 不能为空`);
        // 按真实绝对路径归并：a.txt 与 ./a.txt 是同一个文件
        const abs = (0, security_1.resolveInRoots)(roots, key, undefined, allowOutside);
        let entry = files.get(abs);
        if (!entry) {
            const { text, version } = (0, fileOps_1.readTextFile)(abs);
            const want = expected[key] ?? expected[abs];
            if (want === undefined) {
                throw new security_1.ToolError(`缺少 expected_versions：请为 ${key} 提供 read_file 返回的版本号`);
            }
            if (want !== version) {
                throw new security_1.ToolError(`STALE_FILE：${key} 已被修改（当前版本：${version}），请重新 read_file 后再改`);
            }
            entry = { abs, text, version, crlf: text.includes('\r\n'), count: 0, label: key };
            files.set(abs, entry);
        }
        let oldT = String(e.old_text);
        let newT = String(e.new_text ?? '');
        if (entry.crlf) {
            oldT = oldT.replace(/\r?\n/g, '\r\n');
            newT = newT.replace(/\r?\n/g, '\r\n');
        }
        const hits = entry.text.split(oldT).length - 1;
        if (hits === 0)
            throw new security_1.ToolError(`第 ${i + 1} 处编辑：${key} 中找不到 old_text，请先 read_file 核对原文`);
        if (hits > 1 && e.replace_all !== true) {
            throw new security_1.ToolError(`第 ${i + 1} 处编辑：${key} 中 old_text 出现 ${hits} 次，请加上更多上下文使其唯一，或设置 replace_all=true`);
        }
        entry.text = e.replace_all === true ? entry.text.split(oldT).join(newT) : entry.text.replace(oldT, () => newT);
        entry.count += hits;
    }
    const summary = [];
    for (const f of files.values()) {
        const tmp = f.abs + '.' + node_crypto_1.default.randomBytes(4).toString('hex') + '.tmp';
        node_fs_1.default.writeFileSync(tmp, f.text, 'utf8');
        node_fs_1.default.renameSync(tmp, f.abs);
        summary.push(`修改 ${f.label}（${f.count} 处替换）`);
    }
    return summary;
}
