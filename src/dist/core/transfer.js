"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHUNK_MAX = exports.DOWNLOAD_MAX = exports.UPLOAD_MAX = void 0;
exports.uploadToInbox = uploadToInbox;
exports.saveUnique = saveUnique;
exports.readChunk = readChunk;
exports.recordTransfer = recordTransfer;
exports.listTransfers = listTransfers;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const security_1 = require("./security");
exports.UPLOAD_MAX = 50 * 1024 * 1024;
exports.DOWNLOAD_MAX = 2 * 1024 * 1024 * 1024;
exports.CHUNK_MAX = 1024 * 1024;
const LOG_KEEP = 200;
const sha256Hex = (buf) => node_crypto_1.default.createHash('sha256').update(buf).digest('hex');
/** 上传：AI → 本机收件箱。文件名只允许单个安全的文件名；重名时自动加序号，不覆盖已有文件。 */
function uploadToInbox(dataDir, filename, contentBase64, expectedSha) {
    const name = (0, security_1.safeName)(filename);
    if (typeof contentBase64 !== 'string' || contentBase64.length === 0)
        throw new security_1.ToolError('content_base64 不能为空');
    // 估算解码后大小，超限时不做解码
    if (Math.floor((contentBase64.length * 3) / 4) > exports.UPLOAD_MAX + 4)
        throw new security_1.ToolError('文件超过 50MB 上限');
    const buf = Buffer.from(contentBase64, 'base64');
    if (buf.length === 0)
        throw new security_1.ToolError('文件内容为空或 base64 无效');
    if (buf.length > exports.UPLOAD_MAX)
        throw new security_1.ToolError('文件超过 50MB 上限');
    const digest = sha256Hex(buf);
    if (expectedSha !== undefined && String(expectedSha).toLowerCase() !== digest) {
        throw new security_1.ToolError(`sha256 校验失败：收到 ${digest}，与声明的值不一致，文件未保存`);
    }
    const target = saveUnique(node_path_1.default.join(dataDir, 'inbox'), name, buf);
    return { name: target, bytes: buf.length, sha256: digest };
}
/** 写入目录；重名时自动加序号，不覆盖已有文件。返回实际保存的文件名。 */
function saveUnique(dir, name, buf) {
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const ext = node_path_1.default.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let target = name;
    for (let n = 2; node_fs_1.default.existsSync(node_path_1.default.join(dir, target)); n++)
        target = `${stem} (${n})${ext}`;
    const abs = node_path_1.default.join(dir, target);
    const tmp = abs + '.part';
    node_fs_1.default.writeFileSync(tmp, buf);
    node_fs_1.default.renameSync(tmp, abs);
    return target;
}
/**
 * 下载分块：读取 [offset, offset+length) 的字节。
 * 1MB 以内的文件一次就能返回全部内容；更大的文件（最大 2GB）分块取，直到 done 为 true。
 * offset 为 0 时同时计算整个文件的 sha256，便于 AI 最后校验拼接结果。
 */
function readChunk(abs, offset, length) {
    const st = node_fs_1.default.statSync(abs);
    if (!st.isFile())
        throw new security_1.ToolError('不是普通文件');
    if (st.size > exports.DOWNLOAD_MAX)
        throw new security_1.ToolError('文件超过 2GB 上限，无法下载');
    if (!Number.isInteger(offset) || offset < 0 || offset > st.size)
        throw new security_1.ToolError(`offset 无效（文件大小 ${st.size}）`);
    const n = Math.max(0, Math.min(length, exports.CHUNK_MAX, st.size - offset));
    const data = Buffer.alloc(n);
    if (n > 0) {
        const fd = node_fs_1.default.openSync(abs, 'r');
        try {
            node_fs_1.default.readSync(fd, data, 0, n, offset);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
    }
    let sha;
    if (offset === 0) {
        const h = node_crypto_1.default.createHash('sha256');
        const fd = node_fs_1.default.openSync(abs, 'r');
        try {
            const block = Buffer.alloc(1024 * 1024);
            let pos = 0;
            for (;;) {
                const got = node_fs_1.default.readSync(fd, block, 0, block.length, pos);
                if (got <= 0)
                    break;
                h.update(block.subarray(0, got));
                pos += got;
            }
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
        sha = h.digest('hex');
    }
    return { bytes: st.size, from: offset, to: offset + n, done: offset + n >= st.size, data, sha256: sha };
}
/** 发件记录（面板的发件箱页读取） */
function recordTransfer(dataDir, rec) {
    const file = node_path_1.default.join(dataDir, 'transfer-log.json');
    let list = [];
    try {
        list = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
    }
    catch {
        list = [];
    }
    list.push(rec);
    node_fs_1.default.writeFileSync(file, JSON.stringify(list.slice(-LOG_KEEP), null, 2), 'utf8');
}
function listTransfers(dataDir) {
    try {
        return JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(dataDir, 'transfer-log.json'), 'utf8'));
    }
    catch {
        return [];
    }
}
