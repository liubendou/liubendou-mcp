"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.shellQuote = shellQuote;
exports.diagnose = diagnose;
exports.git = git;
exports.findDefinitions = findDefinitions;
exports.findReferences = findReferences;
exports.projectOverview = projectOverview;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const commands_1 = require("./commands");
const fileOps_1 = require("./fileOps");
const IS_WIN = process.platform === 'win32';
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next', 'coverage']);
/** 安全地把参数放进 shell 命令（PowerShell 与 bash 通用的单引号转义） */
function shellQuote(s) {
    return IS_WIN ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
}
function clip(s, max = 60000) {
    return s.length > max ? '…（前面的输出已省略）\n' + s.slice(-max) : s;
}
async function run(cmds, command, cwd, timeoutMs = 120000) {
    const job = await cmds.runForeground(command, cwd, timeoutMs);
    return { code: job.exitCode, status: job.status, out: (0, commands_1.readOutput)(job).text };
}
/** 从 root 开始向上找 tsconfig.json（不越过 root） */
function findTsconfig(start, root) {
    let dir = node_fs_1.default.statSync(start).isDirectory() ? start : node_path_1.default.dirname(start);
    const rootAbs = node_path_1.default.resolve(root);
    for (;;) {
        const f = node_path_1.default.join(dir, 'tsconfig.json');
        if (node_fs_1.default.existsSync(f))
            return f;
        if (node_path_1.default.resolve(dir) === rootAbs || node_path_1.default.dirname(dir) === dir)
            return null;
        dir = node_path_1.default.dirname(dir);
    }
}
/**
 * 诊断：目标是文件或目录。
 * - 找到 tsconfig.json 则运行 tsc --noEmit
 * - 否则对 .js/.mjs/.cjs 运行 node --check，对 .py 运行 py_compile
 */
async function diagnose(cmds, root, target) {
    const notes = [];
    const isDir = node_fs_1.default.existsSync(target) && node_fs_1.default.statSync(target).isDirectory();
    const ext = node_path_1.default.extname(target).toLowerCase();
    const tsconfig = findTsconfig(target, root);
    if (tsconfig) {
        const r = await run(cmds, `npx --no-install tsc --noEmit -p ${shellQuote(tsconfig)}`, node_path_1.default.dirname(tsconfig));
        if (/not found|无法将|is not recognized|could not determine executable/i.test(r.out) && r.code !== 0) {
            notes.push('[tsc] 未安装 TypeScript（在项目里执行 npm install 后再试）');
        }
        else {
            notes.push(r.code === 0 && r.out.trim() === ''
                ? '[tsc] 通过，没有类型错误'
                : `[tsc] 退出码 ${r.code}\n${clip(r.out.trim(), 20000)}`);
        }
    }
    if (!isDir && ['.js', '.mjs', '.cjs'].includes(ext) && !tsconfig) {
        const r = await run(cmds, `node --check ${shellQuote(target)}`, node_path_1.default.dirname(target));
        notes.push(r.code === 0 ? '[node --check] 语法正确' : `[node --check] 退出码 ${r.code}\n${clip(r.out.trim(), 20000)}`);
    }
    if (!isDir && ext === '.py') {
        const py = IS_WIN ? 'python' : 'python3';
        const r = await run(cmds, `${py} -m py_compile ${shellQuote(target)}`, node_path_1.default.dirname(target));
        notes.push(r.code === 0 ? '[py_compile] 语法正确' : `[py_compile] 退出码 ${r.code}\n${clip(r.out.trim(), 20000)}`);
    }
    if (notes.length === 0) {
        return isDir
            ? '该目录下没有找到 tsconfig.json，也没有可检查的 .js/.py 文件。'
            : `暂不支持检查 ${ext || '该类型'} 文件。已支持：.ts/.tsx（需 tsconfig）、.js/.mjs/.cjs、.py。`;
    }
    return notes.join('\n\n');
}
/** Git：在 cwd 下执行 git 子命令 */
async function git(cmds, cwd, args) {
    const r = await run(cmds, `git ${args}`, cwd, 60000);
    return { code: r.code, out: r.out };
}
/** 代码导航（启发式，基于正则，不是语言服务器） */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function findDefinitions(root, name) {
    const n = escapeRe(name);
    const pattern = `(\\b(function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait)\\s+${n}\\b)` +
        `|(^\\s*(export\\s+)?(default\\s+)?(async\\s+)?${n}\\s*[:=]\\s*(async\\s*)?(\\(|function\\b|[A-Za-z_]\\w*\\s*=>))` +
        `|(^\\s*${n}\\s*\\([^)]*\\)\\s*\\{)`;
    return (0, fileOps_1.searchContent)(root, pattern, { limit: 100 }).matches;
}
function findReferences(root, name) {
    return (0, fileOps_1.searchContent)(root, `\\b${escapeRe(name)}\\b`, { limit: 200 }).matches;
}
/** 项目概览：目录结构、脚本、README 开头、文件类型统计 */
function projectOverview(root, dir) {
    const parts = [];
    const lines = [];
    const walkTree = (d, depth, prefix) => {
        if (depth > 2 || lines.length > 200)
            return;
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(d, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries = entries
            .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (const e of entries) {
            lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
            if (e.isDirectory())
                walkTree(node_path_1.default.join(d, e.name), depth + 1, prefix + '  ');
        }
    };
    walkTree(dir, 0, '');
    parts.push(`## 目录结构（${(0, fileOps_1.toRel)(root, dir) || '.'}，最多两层）\n${lines.join('\n') || '（空）'}`);
    const pkg = node_path_1.default.join(dir, 'package.json');
    if (node_fs_1.default.existsSync(pkg)) {
        try {
            const j = JSON.parse(node_fs_1.default.readFileSync(pkg, 'utf8'));
            parts.push(`## package.json\n名称：${j.name ?? '—'}\n脚本：${Object.keys(j.scripts ?? {}).join(', ') || '无'}\n依赖数：${Object.keys(j.dependencies ?? {}).length}，开发依赖数：${Object.keys(j.devDependencies ?? {}).length}`);
        }
        catch {
            parts.push('## package.json\n（解析失败）');
        }
    }
    for (const name of ['README.md', 'readme.md', 'README.txt']) {
        const f = node_path_1.default.join(dir, name);
        if (node_fs_1.default.existsSync(f)) {
            const head = node_fs_1.default.readFileSync(f, 'utf8').split(/\r?\n/).slice(0, 30).join('\n');
            parts.push(`## ${name}（前 30 行）\n${head}`);
            break;
        }
    }
    const counts = new Map();
    let total = 0;
    for (const f of (0, fileOps_1.walk)(dir, 5000)) {
        total++;
        const e = node_path_1.default.extname(f).toLowerCase() || '(无扩展名)';
        counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    parts.push(`## 文件统计\n共 ${total} 个文件（上限 5000）\n${top.map(([e, n]) => `${e}: ${n}`).join('\n')}`);
    return parts.join('\n\n');
}
