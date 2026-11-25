"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolCatalog = toolCatalog;
exports.listTools = listTools;
exports.callTool = callTool;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const commands_1 = require("./commands");
const security_1 = require("./security");
const fileOps_1 = require("./fileOps");
const patch_1 = require("./patch");
const devtools_1 = require("./devtools");
const web_1 = require("./web");
const desktop_1 = require("./desktop");
const transfer_1 = require("./transfer");
const exact_1 = require("./exact");
const coord_1 = require("./coord");
const platform_1 = require("./platform");
const text = (s) => ({ type: 'text', text: s });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const roots = (c) => c.cfg.get().workspaceRoots;
const baseDir = (c) => roots(c)[0];
const resolvePath = (c, p) => (0, security_1.resolveInRoots)(roots(c), p, undefined, c.cfg.get().allowOutsideWorkspace);
function mimeFromExt(p) {
    const e = node_path_1.default.extname(p.split('?')[0]).toLowerCase();
    const map = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
    };
    return map[e] ?? '';
}
function boxDir(c, box) {
    return node_path_1.default.join(c.dataDir, box);
}
const TOOLS = [
    {
        name: 'read_file',
        description: '查看文本文件内容的首选工具，返回带行号的内容与版本号（sha256）。修改前必须先读取，并把版本号用于 apply_patch / write_file / edit_file 的版本校验。需要同时看多个文件时用 read_files。',
        inputSchema: obj({
            path: str('文件路径（相对工作区或工作区内的绝对路径）'),
            start_line: num('起始行，从 1 开始（可选）'),
            end_line: num('结束行，包含（可选）'),
        }, ['path']),
        handler: async (a, c) => {
            const abs = resolvePath(c, a.path);
            const { text: src, version } = (0, fileOps_1.readTextFile)(abs);
            const lines = src.split(/\r?\n/);
            if (lines.length > 1 && lines[lines.length - 1] === '')
                lines.pop();
            const s = Math.max(1, Number(a.start_line ?? 1));
            const e = Math.min(lines.length, Number(a.end_line ?? lines.length));
            const body = lines
                .slice(s - 1, e)
                .map((l, i) => `${s + i}: ${l}`)
                .join('\n');
            return `文件：${(0, fileOps_1.toRel)(baseDir(c), abs)}\n版本：${version}\n共 ${lines.length} 行，显示第 ${s}-${e} 行\n\n${body}`;
        },
    },
    {
        name: 'write_file',
        description: '新建文件，或整体覆盖已有文件。覆盖已有文件必须提供 expected_version（来自 read_file）；版本不一致会被拒绝（STALE_FILE），防止覆盖别人的改动。',
        inputSchema: obj({
            path: str('文件路径'),
            content: str('完整文件内容'),
            expected_version: str('已有文件的版本号（覆盖时必填）'),
            agent_id: str('调用者 agent_id（agent_register 返回）。用于预占冲突检查：填了才能写入自己预占的路径；不填则只允许写未被他人预占的路径'),
        }, ['path', 'content']),
        handler: async (a, c) => {
            const abs = resolvePath(c, a.path);
            if (node_fs_1.default.existsSync(abs)) {
                if (node_fs_1.default.statSync(abs).isDirectory())
                    throw new security_1.ToolError('目标是目录');
                const cur = (0, fileOps_1.sha256)(node_fs_1.default.readFileSync(abs));
                if (!a.expected_version) {
                    throw new security_1.ToolError(`文件已存在，覆盖前必须提供 expected_version（当前版本：${cur}）`);
                }
                if (a.expected_version !== cur) {
                    throw new security_1.ToolError(`STALE_FILE：文件已被修改（当前版本：${cur}），请重新 read_file 后再写`);
                }
            }
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(abs), { recursive: true });
            const data = String(a.content);
            node_fs_1.default.writeFileSync(abs, data, 'utf8');
            return `已写入 ${(0, fileOps_1.toRel)(baseDir(c), abs)}（${Buffer.byteLength(data)} 字节），新版本：${(0, fileOps_1.sha256)(data)}`;
        },
    },
    {
        name: 'edit_file',
        description: '单处小改动用。old_text 必须在文件中恰好出现一次，否则拒绝；请包含足够上下文使其唯一。涉及多个文件或多处修改时，优先用 apply_patch（一次完成、失败整体回滚）。',
        inputSchema: obj({
            path: str('文件路径'),
            old_text: str('要替换的原文（需唯一）'),
            new_text: str('替换后的内容'),
            expected_version: str('可选：read_file 返回的版本号'),
            agent_id: str('调用者 agent_id（agent_register 返回）。用于预占冲突检查：填了才能写入自己预占的路径；不填则只允许写未被他人预占的路径'),
        }, ['path', 'old_text', 'new_text']),
        handler: async (a, c) => {
            const abs = resolvePath(c, a.path);
            const { text: src, version } = (0, fileOps_1.readTextFile)(abs);
            if (a.expected_version && a.expected_version !== version) {
                throw new security_1.ToolError(`STALE_FILE：文件已被修改（当前版本：${version}），请重新 read_file 后再改`);
            }
            if (!a.old_text)
                throw new security_1.ToolError('old_text 不能为空');
            let oldT = String(a.old_text);
            let newT = String(a.new_text ?? '');
            if (src.includes('\r\n')) {
                oldT = oldT.replace(/\r?\n/g, '\r\n');
                newT = newT.replace(/\r?\n/g, '\r\n');
            }
            const count = src.split(oldT).length - 1;
            if (count === 0) {
                // 找与 old_text 首行公共前缀最长的几行，帮助模型定位拼写或空白差异
                const first = (oldT.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
                const commonPrefix = (a, b) => {
                    let k = 0;
                    while (k < a.length && k < b.length && a[k] === b[k])
                        k++;
                    return k;
                };
                const scored = src
                    .split(/\r?\n/)
                    .map((l, i) => ({ n: i + 1, score: commonPrefix(l.trim(), first) }))
                    .filter((x) => x.score >= Math.min(10, Math.ceil(first.length * 0.6)))
                    .sort((x, y) => y.score - x.score)
                    .slice(0, 3);
                const hits = scored.map((x) => x.n);
                throw new security_1.ToolError('未找到 old_text（注意空白、缩进与换行）。' +
                    (hits.length ? `文件中有包含相同开头的行：第 ${hits.join('、')} 行，请对照 read_file 修正。` : '请先 read_file 确认原文。'));
            }
            if (count > 1)
                throw new security_1.ToolError(`old_text 在文件中出现 ${count} 次，必须唯一，请加入更多上下文`);
            const next = src.replace(oldT, () => newT);
            node_fs_1.default.writeFileSync(abs, next, 'utf8');
            return `已修改 ${(0, fileOps_1.toRel)(baseDir(c), abs)}，新版本：${(0, fileOps_1.sha256)(next)}`;
        },
    },
    {
        name: 'find_files',
        description: '按文件名或通配符查找文件。不含 / 的模式匹配任意层级的文件名（如 *.ts）；含 / 的模式匹配相对路径，支持 **（如 src/**/*.json）。最多返回 500 条。',
        inputSchema: obj({
            pattern: str('通配符模式'),
            path: str('搜索起始目录（可选，默认工作区根目录）'),
        }, ['pattern']),
        handler: async (a, c) => {
            const dir = resolvePath(c, a.path ?? '.');
            if (!node_fs_1.default.existsSync(dir) || !node_fs_1.default.statSync(dir).isDirectory())
                throw new security_1.ToolError('搜索目录不存在');
            const list = (0, fileOps_1.findFiles)(dir, String(a.pattern));
            if (list.length === 0)
                return '没有匹配的文件';
            const note = list.length >= 500 ? '\n（结果已截断到 500 条）' : '';
            return `相对于 ${(0, fileOps_1.toRel)(baseDir(c), dir)} 的匹配结果：\n${list.join('\n')}${note}`;
        },
    },
    {
        name: 'search_content',
        description: '按正则在文件内容中搜索，返回 文件名:行号: 内容。适合找字符串、配置项、报错文本。只知道文件名时用 find_files；找函数或类的定义与引用，用 code_definition / code_references。跳过二进制文件与超过 2MB 的文件。最多返回 300 条。',
        inputSchema: obj({
            pattern: str('正则表达式（JavaScript 语法）'),
            path: str('搜索起始目录（可选，默认工作区根目录）'),
            file_glob: str('只搜索匹配该通配符的文件名，如 *.ts（可选）'),
            case_insensitive: bool('是否忽略大小写'),
        }, ['pattern']),
        handler: async (a, c) => {
            const dir = resolvePath(c, a.path ?? '.');
            if (!node_fs_1.default.existsSync(dir) || !node_fs_1.default.statSync(dir).isDirectory())
                throw new security_1.ToolError('搜索目录不存在');
            const { matches, truncated } = (0, fileOps_1.searchContent)(dir, String(a.pattern), {
                caseInsensitive: a.case_insensitive === true,
                fileGlob: a.file_glob ? String(a.file_glob) : undefined,
            });
            if (matches.length === 0)
                return '没有匹配内容';
            return matches.join('\n') + (truncated ? '\n（结果已截断到 300 条）' : '');
        },
    },
    {
        name: 'run_command',
        description: '在持久终端中执行命令（Windows 为 PowerShell，其他系统为 bash）。cd、环境变量等状态会保留到之后的命令。同一时间只能有一条前台命令运行：超时的命令会继续运行并返回 id，用 command_output 取后续输出，用 command_cancel 中断（中断会杀掉整个终端，状态会丢失，下次执行时自动重新启动）。background=true 时在独立进程中后台运行，不占用终端。修改文件请用 apply_patch 等专用工具，不要用命令行写文件。',
        inputSchema: obj({
            command: str('要执行的命令'),
            cwd: str('工作目录（可选，须在工作区内）'),
            timeout_ms: num('前台等待毫秒数，默认 120000，最大 600000。超时后命令继续在后台运行'),
            background: bool('是否在独立进程中后台运行（不占用持久终端）'),
            confirm: str('A类危险命令（不可逆操作）必填 "YES" 明示授权，否则拒绝'),
            allow_non_ascii: bool('命令确实需要非 ASCII 字符时置 true；默认拒绝非 ASCII 命令以防 PowerShell 乱码'),
        }, ['command']),
        handler: async (a, c) => {
            const cwd = resolvePath(c, a.cwd ?? '.');
            if (!node_fs_1.default.existsSync(cwd) || !node_fs_1.default.statSync(cwd).isDirectory())
                throw new security_1.ToolError('工作目录不存在');
            const cmd = String(a.command);
            (0, security_1.assertAsciiCommand)(cmd, a.allow_non_ascii);
            const gate = (0, security_1.commandGate)(cmd, a.confirm, a.__approved === true);
            if (a.background === true) {
                const job = c.cmds.start(cmd, cwd);
                return `已在后台启动，id=${job.id}。用 command_output 查看输出，用 command_cancel 中断。` + (gate.note ? '\n' + gate.note : '');
            }
            const timeout = Math.min(600000, Math.max(1000, Number(a.timeout_ms ?? 120000)));
            const job = await c.term.exec(cmd, a.cwd ? cwd : undefined, timeout);
            const out = (0, security_1.scrubSecrets)((0, commands_1.readOutput)(job).text);
            const shown = out.length > 60000 ? '…（前面的输出已省略）\n' + out.slice(-60000) : out;
            const note = gate.note ? '\n' + gate.note : '';
            if (job.endedAt === null) {
                return `状态：仍在运行（超过等待时间），id=${job.id}。用 command_output 查看后续输出，用 command_cancel 中断。\n${shown}${note}`;
            }
            return `状态：${job.status}，退出码：${job.exitCode ?? '—'}\n${shown}${note}`;
        },
    },
    {
        name: 'command_output',
        description: '读取后台命令的状态与输出。传入 offset 可只取之后的增量输出（返回值中的输出位置即下一次的 offset）。',
        inputSchema: obj({
            id: str('run_command 返回的命令 id'),
            offset: num('输出位置（可选）'),
        }, ['id']),
        handler: async (a, c) => {
            const job = c.cmds.get(String(a.id));
            if (!job)
                throw new security_1.ToolError('没有该命令 id');
            const o = (0, commands_1.readOutput)(job, a.offset === undefined ? undefined : Number(a.offset));
            const head = `状态：${job.status}，退出码：${job.exitCode ?? '—'}，输出位置 ${o.from}-${o.next}` +
                (o.truncatedBefore ? '（较早的输出已被丢弃）' : '');
            return `${head}\n${(0, security_1.scrubSecrets)(o.text)}`;
        },
    },
    {
        name: 'run_tests',
        description: '运行项目测试，只返回汇总与失败项（不返回整段日志）。自动识别：package.json 的 test 脚本、pytest、go test、cargo test；也可用 command 指定。',
        inputSchema: obj({
            cwd: str('项目目录（可选，须在工作区内）'),
            command: str('指定测试命令（可选，不传则自动识别）'),
            timeout_ms: num('最长等待毫秒，默认 300000，最大 900000'),
        }),
        handler: async (a, c) => {
            const cwd = resolvePath(c, a.cwd ?? '.');
            if (!node_fs_1.default.existsSync(cwd) || !node_fs_1.default.statSync(cwd).isDirectory())
                throw new security_1.ToolError('工作目录不存在');
            const has = (f) => node_fs_1.default.existsSync(node_path_1.default.join(cwd, f));
            let cmd = a.command ? String(a.command) : '';
            if (!cmd && has('package.json')) {
                let pkg = {};
                try {
                    pkg = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(cwd, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
                }
                catch { }
                if (pkg.scripts && pkg.scripts.test)
                    cmd = 'npm test --silent';
            }
            if (!cmd && (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tests')))
                cmd = 'python -m pytest -q';
            if (!cmd && has('go.mod'))
                cmd = 'go test ./...';
            if (!cmd && has('Cargo.toml'))
                cmd = 'cargo test';
            if (!cmd)
                throw new security_1.ToolError('无法识别测试命令，请传 command 参数');
            const timeout = Math.min(900000, Math.max(5000, Number(a.timeout_ms ?? 300000)));
            // 直接以子进程运行（不经过持久终端），避免中文路径在终端里乱码
            const run = await new Promise((resolve) => {
                const cp = require("node:child_process");
                const child = cp.spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
                let buf = '';
                const onData = (d) => {
                    buf += d.toString('utf8');
                    if (buf.length > 2000000)
                        buf = buf.slice(-2000000);
                };
                child.stdout.on('data', onData);
                child.stderr.on('data', onData);
                const timer = setTimeout(() => {
                    try { child.kill(); } catch { }
                    resolve({ code: null, out: buf, timedOut: true });
                }, timeout);
                child.on('close', (code) => {
                    clearTimeout(timer);
                    resolve({ code, out: buf, timedOut: false });
                });
            });
            const lines = run.out.split(/\r?\n/);
            const keyRe = /(FAIL|✖|✗|Error|AssertionError|failed|panic|not ok|expected|Tests?:|passed|\d+\s+(pass|fail))/i;
            const picked = lines.filter((l) => keyRe.test(l)).slice(0, 60);
            const status = run.timedOut ? '超时未结束' : run.code === 0 ? '通过' : '失败';
            return `测试命令：${cmd}\n结果：${status}（退出码 ${run.code ?? '—'}）\n` +
                (picked.length ? `关键行（最多 60 行）：\n${picked.join('\n')}\n` : '') +
                `最后 15 行：\n${lines.slice(-15).join('\n')}`;
        },
    },
    {
        name: 'wait_for_http',
        description: '等待本机服务就绪（重启服务后用）：轮询 http://127.0.0.1:<port><path>，拿到任何 HTTP 响应即视为就绪。默认最多等 30 秒。',
        inputSchema: obj({
            port: num('本机端口'),
            path: str('路径，默认 /'),
            timeout_ms: num('最长等待毫秒，默认 30000，最大 120000'),
        }, ['port']),
        handler: async (a) => {
            const port = localPort(a.port);
            const p = String(a.path ?? '/');
            const url = `http://127.0.0.1:${port}${p.startsWith('/') ? p : '/' + p}`;
            const timeout = Math.min(120000, Math.max(1000, Number(a.timeout_ms ?? 30000)));
            const started = Date.now();
            let last = '';
            while (Date.now() - started < timeout) {
                try {
                    const code = await httpPing(url);
                    return `就绪：${url} 返回 HTTP ${code}，用时 ${Date.now() - started} ms`;
                }
                catch (e) {
                    last = e instanceof Error ? e.message : String(e);
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
            throw new security_1.ToolError(`等待超时（${timeout} ms）：${url} 仍不可达（${last}）`);
        },
    },
    {
        name: 'port_status',
        description: '查看本机端口：是否有进程在监听、占用进程（名称与 PID），以及 HTTP 是否可访问。端口冲突或服务没起来时用。',
        inputSchema: obj({ port: num('端口') }, ['port']),
        handler: async (a) => {
            const port = localPort(a.port);
            const ls = portListeners(port);
            let http = '不可达';
            try {
                http = `HTTP ${await httpPing(`http://127.0.0.1:${port}/`)}`;
            }
            catch { }
            if (!ls.length)
                return `端口 ${port}：没有进程在监听。HTTP：${http}`;
            return `端口 ${port}：${ls.map((l) => `${l.name}（PID ${l.pid}）`).join('，')}。HTTP：${http}`;
        },
    },
    {
        name: 'kill_port',
        description: '结束占用某端口的进程（需要审批）。拒绝结束系统进程，以及本应用自己的端口（8765/8766）。',
        inputSchema: obj({ port: num('要释放的端口') }, ['port']),
        handler: async (a, c) => {
            const port = localPort(a.port);
            const cfg = c.cfg.get();
            if ([8765, 8766, Number(cfg.port), Number(cfg.panelPort)].includes(port))
                throw new security_1.ToolError('不能结束本应用自己的端口');
            const ls = portListeners(port);
            if (!ls.length)
                return '该端口没有进程在监听，无需处理';
            const SYSTEM = new Set(['system', 'svchost', 'services', 'lsass', 'explorer', 'wininit', 'csrss', 'smss']);
            const cp = require("node:child_process");
            const out = [];
            for (const l of ls) {
                if (!l.pid || l.pid === 4 || l.pid === process.pid || SYSTEM.has(l.name.toLowerCase())) {
                    out.push(`跳过 ${l.name}（PID ${l.pid}）：系统或受保护进程`);
                    continue;
                }
                try {
                    if (platform_1.IS_WIN)
                        cp.execFileSync('taskkill', ['/PID', String(l.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
                    else
                        (0, platform_1.killTreeSync)(l.pid);
                    out.push(`已结束 ${l.name}（PID ${l.pid}）`);
                }
                catch (e) {
                    out.push(`结束 ${l.name} 失败：${String(e.message).slice(0, 120)}`);
                }
            }
            return out.join('\n');
        },
    },
    {
        name: 'edit_preview',
        description: '修改前预览，不写入文件：检查 old_text 是否在文件中恰好出现一次，返回改动前后的 diff。确认无误后再用 apply_patch 或 edit_file 写入。',
        inputSchema: obj({
            path: str('文件路径'),
            old_text: str('要替换的原文（必须在文件中唯一）'),
            new_text: str('替换后的新文本'),
        }, ['path', 'old_text', 'new_text']),
        handler: async (a, c) => {
            const file = resolvePath(c, String(a.path));
            if (!node_fs_1.default.existsSync(file) || !node_fs_1.default.statSync(file).isFile())
                throw new security_1.ToolError('文件不存在');
            const before = node_fs_1.default.readFileSync(file, 'utf8');
            const oldT = String(a.old_text ?? '');
            const newT = String(a.new_text ?? '');
            const count = oldT ? before.split(oldT).length - 1 : 0;
            if (count !== 1)
                return `不会写入：old_text 在文件中出现 ${count} 次（必须恰好 1 次）。请加长上下文使其唯一。`;
            const after = before.replace(oldT, () => newT);
            const oldLines = before.split(/\r?\n/);
            const newLines = after.split(/\r?\n/);
            let s = 0;
            while (s < oldLines.length && s < newLines.length && oldLines[s] === newLines[s])
                s++;
            let eO = oldLines.length - 1;
            let eN = newLines.length - 1;
            while (eO >= s && eN >= s && oldLines[eO] === newLines[eN]) {
                eO--;
                eN--;
            }
            const out = [`文件：${a.path}`, `第 ${s + 1} 行起改动：删除 ${Math.max(0, eO - s + 1)} 行，新增 ${Math.max(0, eN - s + 1)} 行`];
            for (let i = Math.max(0, s - 2); i < s; i++)
                out.push(`  ${oldLines[i]}`);
            for (let i = s; i <= eO && i - s < 200; i++)
                out.push(`- ${oldLines[i]}`);
            for (let i = s; i <= eN && i - s < 200; i++)
                out.push(`+ ${newLines[i]}`);
            return out.join('\n') + '\n（未写入文件。确认后用 apply_patch 或 edit_file 执行）';
        },
    },
    {
        name: 'worktree_create',
        description: '为一个任务创建独立的 git worktree：目录 .trees/<task>，分支 agent/<task>。多个 AI 各在自己的目录里改，互不干扰；完成后合并分支。目录会自动加入 .git/info/exclude。',
        inputSchema: obj({
            task: str('任务名（字母、数字、- 和 _，如 login-form）'),
            base: str('基于哪个提交或分支，默认 HEAD'),
            cwd: str('仓库目录（可选，默认工作区根）'),
        }, ['task']),
        handler: async (a, c) => {
            const task = String(a.task ?? '');
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task))
                throw new security_1.ToolError('任务名只能包含字母、数字、- 和 _');
            const repo = resolvePath(c, a.cwd ?? '.');
            const cp = require('node:child_process');
            const git = (args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
            const dir = node_path_1.default.join(repo, '.trees', task);
            const branch = `agent/${task}`;
            const unlock = await coord_1.acquireGitLock();
            try {
                if (node_fs_1.default.existsSync(dir))
                    throw new security_1.ToolError(`worktree 已存在：.trees/${task}`);
                const branchExists = (() => {
                    try {
                        git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
                        return true;
                    }
                    catch {
                        return false;
                    }
                })();
                node_fs_1.default.mkdirSync(node_path_1.default.join(repo, '.trees'), { recursive: true });
                const base = a.base ? String(a.base) : 'HEAD';
                git(branchExists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base]);
                const excl = node_path_1.default.join(repo, '.git', 'info', 'exclude');
                try {
                    const cur = node_fs_1.default.existsSync(excl) ? node_fs_1.default.readFileSync(excl, 'utf8') : '';
                    if (!/^\.trees\/?$/m.test(cur))
                        node_fs_1.default.appendFileSync(excl, '\n.trees/\n');
                }
                catch { }
                return `已创建 worktree：.trees/${task}（分支 ${branch}，基于 ${base}）。之后在该目录里修改、提交；完成后用 worktree_remove 清理。`;
            }
            catch (e) {
                if (e instanceof security_1.ToolError)
                    throw e;
                throw new security_1.ToolError('创建 worktree 失败：' + String(e.stderr || e.message).slice(0, 300));
            }
            finally {
                unlock();
            }
        },
    },
    {
        name: 'worktree_remove',
        description: '移除任务的 worktree（目录 .trees/<task>）。有未提交改动时拒绝，除非 force=true。分支 agent/<task> 保留，提交不会丢失。',
        inputSchema: obj({
            task: str('任务名'),
            force: bool('有未提交改动也强制移除（会丢失这些改动）'),
            cwd: str('仓库目录（可选，默认工作区根）'),
        }, ['task']),
        handler: async (a, c) => {
            const task = String(a.task ?? '');
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task))
                throw new security_1.ToolError('任务名格式不对');
            const repo = resolvePath(c, a.cwd ?? '.');
            const cp = require('node:child_process');
            const git = (args, cwd = repo) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
            const dir = node_path_1.default.join(repo, '.trees', task);
            if (!node_fs_1.default.existsSync(dir))
                throw new security_1.ToolError(`没有该 worktree：.trees/${task}`);
            const unlock = await coord_1.acquireGitLock();
            try {
                const dirty = git(['status', '--porcelain'], dir);
                if (dirty && a.force !== true)
                    throw new security_1.ToolError(`worktree 有未提交改动，已拒绝移除。请先提交，或传 force=true 强制移除（会丢失这些改动）：\n${dirty.slice(0, 500)}`);
                git(['worktree', 'remove', '--force', dir]);
                return `已移除 worktree .trees/${task}。分支 agent/${task} 保留（提交不会丢失）。`;
            }
            catch (e) {
                if (e instanceof security_1.ToolError)
                    throw e;
                throw new security_1.ToolError('移除 worktree 失败：' + String(e.stderr || e.message).slice(0, 300));
            }
            finally {
                unlock();
            }
        },
    },
    {
        name: 'job_start',
        description: '启动一个长时间运行的命令（构建、测试、安装等），立即返回 job_id，不阻塞。之后用 job_poll 取状态和输出。审批规则与 run_command 相同。',
        inputSchema: obj({
            command: str('要执行的命令'),
            cwd: str('工作目录（可选，须在工作区内）'),
            confirm: str('A类危险命令（不可逆操作）必填 "YES" 明示授权，否则拒绝'),
            allow_non_ascii: bool('命令确实需要非 ASCII 字符时置 true；默认拒绝非 ASCII 命令以防 PowerShell 乱码'),
        }, ['command']),
        handler: async (a, c) => {
            const cwd = resolvePath(c, a.cwd ?? '.');
            if (!node_fs_1.default.existsSync(cwd) || !node_fs_1.default.statSync(cwd).isDirectory())
                throw new security_1.ToolError('工作目录不存在');
            const cmd = String(a.command);
            (0, security_1.assertAsciiCommand)(cmd, a.allow_non_ascii);
            const gate = (0, security_1.commandGate)(cmd, a.confirm, a.__approved === true);
            const job = c.cmds.start(cmd, cwd);
            return `已启动，job_id=${job.id}。用 job_poll 查看进度和输出（可传 wait_ms 等待结束）。` + (gate.note ? '\n' + gate.note : '');
        },
    },
    {
        name: 'job_poll',
        description: '查看 job_start 启动的任务：运行状态、退出码与新增输出。传 wait_ms（最大 60000）可等待任务结束或超时后再返回，避免频繁轮询。传 offset 只取之后的输出。',
        inputSchema: obj({
            job_id: str('job_start 返回的 job_id'),
            offset: num('上次返回的输出位置（可选）'),
            wait_ms: num('最多等待毫秒数，默认 0，最大 60000'),
        }, ['job_id']),
        handler: async (a, c) => {
            const job = c.cmds.get(String(a.job_id));
            if (!job)
                throw new security_1.ToolError('没有该 job_id');
            const wait = Math.min(60000, Math.max(0, Number(a.wait_ms ?? 0)));
            const until = Date.now() + wait;
            while (job.endedAt === null && Date.now() < until)
                await new Promise((r) => setTimeout(r, 500));
            const o = (0, commands_1.readOutput)(job, a.offset === undefined ? undefined : Number(a.offset));
            const state = job.endedAt === null ? '运行中' : `已结束（${job.status}）`;
            const head = `状态：${state}，退出码：${job.exitCode ?? '—'}，输出位置 ${o.from}-${o.next}` +
                (o.truncatedBefore ? '（较早的输出已被丢弃）' : '');
            return `${head}\n${(0, security_1.scrubSecrets)(o.text)}`;
        },
    },
    {
        name: 'command_cancel',
        description: '中断一个正在运行的命令（后台或前台超时的）。',
        inputSchema: obj({ id: str('命令 id') }, ['id']),
        handler: async (a, c) => {
            const job = c.cmds.cancel(String(a.id));
            c.term.abort(job.id);
            return `命令 ${job.id} 当前状态：${job.status}`;
        },
    },
    {
        name: 'todo_list',
        description: '列出待办事项（面板会实时显示）。',
        inputSchema: obj({}),
        handler: async (_a, c) => {
            const items = c.store.listTodos();
            if (items.length === 0)
                return '暂无待办';
            return items.map((t) => `#${t.id} [${t.status}] ${t.text}`).join('\n');
        },
    },
    {
        name: 'todo_add',
        description: '新增一条待办。',
        inputSchema: obj({ text: str('待办内容') }, ['text']),
        handler: async (a, c) => {
            const t = c.store.addTodo(String(a.text));
            return `已添加待办 #${t.id}`;
        },
    },
    {
        name: 'todo_update',
        description: '修改待办的内容或状态（todo / doing / done）。',
        inputSchema: obj({
            id: num('待办编号'),
            text: str('新内容（可选）'),
            status: { type: 'string', enum: ['todo', 'doing', 'done'], description: '新状态（可选）' },
        }, ['id']),
        handler: async (a, c) => {
            const t = c.store.updateTodo(Number(a.id), { text: a.text, status: a.status });
            return `已更新待办 #${t.id} [${t.status}] ${t.text}`;
        },
    },
    {
        name: 'todo_delete',
        description: '删除一条待办。',
        inputSchema: obj({ id: num('待办编号') }, ['id']),
        handler: async (a, c) => {
            c.store.deleteTodo(Number(a.id));
            return `已删除待办 #${a.id}`;
        },
    },
    {
        name: 'set_todos',
        description: '用一份新列表整体替换待办（面板实时显示）。适合一次性规划多项任务；单项增删改仍可用 todo_add / todo_update / todo_delete。',
        inputSchema: obj({
            items: {
                type: 'array',
                description: '完整的待办列表',
                items: obj({
                    text: str('待办内容'),
                    status: { type: 'string', enum: ['todo', 'doing', 'done'], description: '状态，默认 todo' },
                }, ['text']),
            },
        }, ['items']),
        handler: async (a, c) => {
            const items = Array.isArray(a.items) ? a.items : [];
            if (items.length === 0)
                throw new security_1.ToolError('items 不能为空；要清空请用 todo_delete 逐条删除');
            const list = c.store.setTodos(items.map((it) => ({ text: String(it.text), status: it.status })));
            return list.map((t) => `#${t.id} [${t.status}] ${t.text}`).join('\n');
        },
    },
    {
        name: 'update_plan',
        description: '设置或更新本次任务的计划（分步骤，每步有状态）。整体替换；每完成一步就再调用一次，把对应步骤改为 done，并把正在做的那步设为 doing。计划显示在面板上。',
        inputSchema: obj({
            title: str('计划标题（可选）'),
            steps: {
                type: 'array',
                description: '完整的步骤列表（按顺序）',
                items: obj({
                    text: str('步骤描述'),
                    status: { type: 'string', enum: ['todo', 'doing', 'done'], description: '状态，默认 todo' },
                }, ['text']),
            },
        }, ['steps']),
        handler: async (a, c) => {
            const steps = Array.isArray(a.steps) ? a.steps : [];
            if (steps.length === 0)
                throw new security_1.ToolError('steps 不能为空');
            const plan = c.store.setPlan(String(a.title ?? c.store.getPlan()?.title ?? '当前任务'), steps.map((s) => ({ text: String(s.text), status: s.status ?? 'todo' })));
            const done = plan.steps.filter((s) => s.status === 'done').length;
            return `计划「${plan.title}」已更新：${done}/${plan.steps.length} 完成\n` +
                plan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join('\n');
        },
    },
    {
        name: 'report_progress',
        description: '上报当前正在做什么（一句话，可选百分比）。面板的状态区会实时显示，让用户知道进展。耗时较长的步骤开始前调用。',
        inputSchema: obj({
            text: str('当前正在做的事，一句话'),
            percent: num('完成百分比 0-100（可选）'),
        }, ['text']),
        handler: async (a, c) => {
            const pct = a.percent === undefined ? null : Math.max(0, Math.min(100, Number(a.percent)));
            const p = c.store.setProgress(String(a.text), pct);
            return `已上报进度：${p.text}${p.percent === null ? '' : `（${p.percent}%）`}`;
        },
    },
    {
        name: 'memory_get',
        description: '读取记忆（跨会话保存的上下文）。不传 key 则返回全部。',
        inputSchema: obj({ key: str('记忆键名（可选）') }),
        handler: async (a, c) => {
            const all = await c.memory.get(a.key === undefined ? undefined : String(a.key));
            const keys = Object.keys(all);
            if (keys.length === 0)
                return '没有记忆';
            return keys.map((k) => `## ${k}（更新于 ${all[k].updatedAt}）\n${all[k].value}`).join('\n\n');
        },
    },
    {
        name: 'memory_set',
        description: '保存或覆盖一条记忆（跨会话可用）。',
        inputSchema: obj({ key: str('键名'), value: str('内容') }, ['key', 'value']),
        handler: async (a, c) => {
            await c.memory.set(String(a.key), String(a.value));
            return `已保存记忆：${a.key}`;
        },
    },
    {
        name: 'memory_delete',
        description: '删除一条记忆。',
        inputSchema: obj({ key: str('键名') }, ['key']),
        handler: async (a, c) => ((await c.memory.delete(String(a.key))) ? `已删除记忆：${a.key}` : '没有该记忆'),
    },
    {
        name: 'memory_search',
        description: '在记忆里检索（零模型后端：BM25 词法打分 + 时间衰减，不需要 embedding 服务或密钥）。',
        inputSchema: obj({ query: str('要查的内容'), limit: num('返回条数，默认 8') }, ['query']),
        handler: async (a, c) => {
            if (!c.memory || typeof c.memory.search !== 'function')
                return '当前记忆后端不支持检索（memoryBackend 需为 local 或 hymemory）';
            const hits = await c.memory.search(String(a.query ?? ''), Number(a.limit) || 8);
            if (!hits.length)
                return `没有匹配「${a.query}」的记忆`;
            return hits.map((h, i) => `${i + 1}. ${h.key}（相关度 ${h.score}，更新于 ${h.updatedAt || '未知'}）\n${h.value}`).join('\n\n');
        },
    },
    {
        name: 'read_image',
        description: '读取图片并返回给 AI 查看。支持工作区内的本地路径，或 http(s) 网络地址。单张不超过 10MB。',
        inputSchema: obj({ path: str('本地路径或 http(s) 图片地址') }, ['path']),
        handler: async (a, c) => {
            const src = String(a.path ?? '').trim();
            let buf;
            let mime;
            if (/^https?:\/\//i.test(src)) {
                const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
                if (!r.ok)
                    throw new security_1.ToolError(`下载失败：HTTP ${r.status}`);
                buf = Buffer.from(await r.arrayBuffer());
                mime = (r.headers.get('content-type') ?? '').split(';')[0].trim() || mimeFromExt(src);
            }
            else {
                const abs = resolvePath(c, src);
                if (!node_fs_1.default.existsSync(abs) || node_fs_1.default.statSync(abs).isDirectory())
                    throw new security_1.ToolError('图片文件不存在');
                buf = node_fs_1.default.readFileSync(abs);
                mime = mimeFromExt(abs);
            }
            if (!mime.startsWith('image/'))
                throw new security_1.ToolError(`不是图片（类型：${mime || '未知'}）`);
            if (buf.length > 10 * 1024 * 1024)
                throw new security_1.ToolError('图片超过 10MB');
            return [
                text(`图片类型：${mime}，大小：${buf.length} 字节`),
                { type: 'image', data: buf.toString('base64'), mimeType: mime },
            ];
        },
    },
    {
        name: 'inbox_list',
        description: '列出收件箱（用户放进来、供 AI 读取的文件）。',
        inputSchema: obj({}),
        handler: async (_a, c) => {
            const dir = boxDir(c, 'inbox');
            const names = node_fs_1.default.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
            return names.length ? names.map((n) => `${n}（${node_fs_1.default.statSync(node_path_1.default.join(dir, n)).size} 字节）`).join('\n') : '收件箱为空';
        },
    },
    {
        name: 'inbox_read',
        description: '读取收件箱中的文件。文本以 utf8 返回；二进制以 base64 返回。',
        inputSchema: obj({ name: str('文件名') }, ['name']),
        handler: async (a, c) => {
            const abs = node_path_1.default.join(boxDir(c, 'inbox'), (0, security_1.safeName)(a.name));
            if (!node_fs_1.default.existsSync(abs))
                throw new security_1.ToolError('收件箱中没有该文件');
            const buf = node_fs_1.default.readFileSync(abs);
            if (buf.length > 10 * 1024 * 1024)
                throw new security_1.ToolError('文件超过 10MB，请在面板中下载');
            if (buf.includes(0))
                return `[二进制文件 base64，${buf.length} 字节]\n${buf.toString('base64')}`;
            return buf.toString('utf8');
        },
    },
    {
        name: 'outbox_write',
        description: '把文件写入发件箱，用户可在面板中下载。encoding 为 utf8（默认）或 base64。',
        inputSchema: obj({
            name: str('文件名（不含路径）'),
            content: str('文件内容'),
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: '内容编码，默认 utf8' },
        }, ['name', 'content']),
        handler: async (a, c) => {
            const name = (0, security_1.safeName)(a.name);
            const data = a.encoding === 'base64' ? Buffer.from(String(a.content), 'base64') : Buffer.from(String(a.content), 'utf8');
            if (data.length > 20 * 1024 * 1024)
                throw new security_1.ToolError('单个文件不能超过 20MB');
            node_fs_1.default.writeFileSync(node_path_1.default.join(boxDir(c, 'outbox'), name), data);
            return `已写入发件箱：${name}（${data.length} 字节）`;
        },
    },
    {
        name: 'outbox_list',
        description: '列出发件箱中的文件。',
        inputSchema: obj({}),
        handler: async (_a, c) => {
            const dir = boxDir(c, 'outbox');
            const names = node_fs_1.default.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
            return names.length ? names.join('\n') : '发件箱为空';
        },
    },
    {
        name: 'apply_patch',
        description: '【修改文件的首选方式】两种输入，二选一。①edits：精确替换，每处给 path、old_text（必须唯一）、new_text，必须带 expected_versions；②patch：补丁全文。全部片段都成功才写入，任一失败则整体不改。补丁格式：' +
            '*** Begin Patch 开头；*** Update File: 路径 修改已有文件（@@ 开始一个片段，行首空格为上下文、- 为删除、+ 为新增，上下文需在文件中唯一，可用 *** Move to: 改名）；' +
            '*** Add File: 路径 新建文件（内容行以 + 开头）；*** Delete File: 路径 删除文件；*** End Patch 结尾。修改前先 read_file。',
        inputSchema: obj({
            agent_id: str('调用者 agent_id（agent_register 返回）。用于预占冲突检查'),
            patch: str('补丁全文（与 edits 二选一）'),
            edits: {
                type: 'array',
                description: '精确替换列表（与 patch 二选一）',
                items: obj({
                    path: str('相对工作区的文件路径'),
                    old_text: str('要替换的原文（需唯一，除非 replace_all）'),
                    new_text: str('替换后的内容'),
                    replace_all: bool('是否替换全部出现处（默认 false）'),
                }, ['path', 'old_text', 'new_text']),
            },
            expected_versions: {
                type: 'object',
                description: '{ "相对路径": "read_file 返回的版本号" }。两种模式都建议提供；edits 模式必须提供',
                additionalProperties: { type: 'string' },
            },
        }, []),
        handler: async (a, c) => {
            const expected = (a.expected_versions ?? {});
            const allow = c.cfg.get().allowOutsideWorkspace;
            if (Array.isArray(a.edits)) {
                const lines = (0, exact_1.applyExactEdits)(roots(c), a.edits, expected, allow);
                return '精确替换已应用：\n' + lines.join('\n');
            }
            if (typeof a.patch !== 'string')
                throw new security_1.ToolError('请提供 edits（精确替换）或 patch（补丁全文）之一');
            const r = (0, patch_1.applyPatchText)(roots(c), a.patch, expected, allow);
            return '补丁已应用：\n' + r.summary.join('\n');
        },
    },
    {
        name: 'read_files',
        description: '一次读取多个文本文件（最多 20 个），每个文件返回带行号内容与版本号。单个文件出错不影响其他文件。',
        inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: '文件路径列表' } }, ['paths']),
        handler: async (a, c) => {
            const list = (Array.isArray(a.paths) ? a.paths : []).slice(0, 20).map(String);
            if (list.length === 0)
                throw new security_1.ToolError('paths 不能为空');
            const sections = [];
            for (const p of list) {
                try {
                    const abs = resolvePath(c, p);
                    const { text: src, version } = (0, fileOps_1.readTextFile)(abs);
                    const lines = src.split(/\r?\n/);
                    if (lines.length > 1 && lines[lines.length - 1] === '')
                        lines.pop();
                    const body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
                    sections.push(`### ${(0, fileOps_1.toRel)(baseDir(c), abs)}（版本 ${version}，共 ${lines.length} 行）\n${body}`);
                }
                catch (e) {
                    sections.push(`### ${p}\n错误：${e instanceof Error ? e.message : String(e)}`);
                }
            }
            return sections.join('\n\n');
        },
    },
    {
        name: 'get_diagnostics',
        description: '检查文件或目录的错误：有 tsconfig.json 时运行 tsc --noEmit；.js 运行 node --check；.py 运行 py_compile。修改代码后用它确认没有引入错误。',
        inputSchema: obj({ path: str('文件或目录路径（可选，默认工作区根目录）') }),
        handler: async (a, c) => {
            const target = resolvePath(c, a.path ?? '.');
            const root = roots(c).find((r) => target.startsWith(r)) ?? baseDir(c);
            return (0, devtools_1.diagnose)(c.cmds, root, target);
        },
    },
    {
        name: 'git_status',
        description: '查看 Git 仓库状态（分支、已修改、未跟踪的文件）。修改前后都可以用来确认改动范围。',
        inputSchema: obj({ cwd: str('仓库目录（可选，默认工作区根目录）') }),
        handler: async (a, c) => gitIn(c, a.cwd, 'status --short --branch'),
    },
    {
        name: 'git_diff',
        description: '查看改动内容。不传参数看工作区改动；staged=true 看已暂存改动；传 path 只看某个文件。',
        inputSchema: obj({
            path: str('只看某个文件（可选）'),
            staged: bool('是否查看已暂存的改动'),
            cwd: str('仓库目录（可选）'),
        }, []),
        handler: async (a, c) => {
            const args = ['--no-pager', 'diff'];
            if (a.staged === true)
                args.push('--cached');
            if (a.path)
                args.push('--', (0, devtools_1.shellQuote)(String(a.path)));
            return gitIn(c, a.cwd, args.join(' '));
        },
    },
    {
        name: 'git_log',
        description: '查看最近的提交记录（单行格式）。',
        inputSchema: obj({ n: num('条数，默认 15，最多 100'), cwd: str('仓库目录（可选）') }),
        handler: async (a, c) => {
            const n = Math.min(100, Math.max(1, Number(a.n ?? 15)));
            return gitIn(c, a.cwd, `--no-pager log --oneline -n ${n}`);
        },
    },
    {
        name: 'git_commit',
        description: '只提交指定的文件（必须传 paths，不会提交其他人的未提交改动）。提交前建议先用 git_diff 确认改动。',
        inputSchema: obj({
            message: str('提交说明'),
            paths: { type: 'array', items: { type: 'string' }, description: '要提交的文件路径列表（必填）' },
            cwd: str('仓库目录（可选）'),
        }, ['message', 'paths']),
        handler: async (a, c) => {
            const paths = Array.isArray(a.paths) ? a.paths.map((p) => String(p)) : [];
            if (paths.length === 0)
                throw new security_1.ToolError('必须指定 paths，避免提交他人的改动');
            const q = paths.map((p) => (0, devtools_1.shellQuote)(p)).join(' ');
            await gitIn(c, a.cwd, `add -- ${q}`);
            return gitIn(c, a.cwd, `commit -m ${(0, devtools_1.shellQuote)(String(a.message))} -- ${q}`);
        },
    },
    {
        name: 'code_definition',
        description: '查找函数、类、变量等符号的定义位置（基于正则的启发式查找，支持 TS/JS/Python/Go/Rust 等常见写法）。结果可能不完整，需要时结合 search_content 确认。',
        inputSchema: obj({ name: str('符号名称') }, ['name']),
        handler: async (a, c) => {
            const r = (0, devtools_1.findDefinitions)(baseDir(c), String(a.name));
            return r.length ? r.join('\n') : '没有找到定义';
        },
    },
    {
        name: 'code_references',
        description: '查找符号在工作区中的所有引用（单词边界匹配，启发式）。用于评估改动影响范围。最多 200 条。',
        inputSchema: obj({ name: str('符号名称') }, ['name']),
        handler: async (a, c) => {
            const r = (0, devtools_1.findReferences)(baseDir(c), String(a.name));
            return r.length ? r.join('\n') : '没有找到引用';
        },
    },
    {
        name: 'project_overview',
        description: '了解一个项目的最快方式：返回目录结构（两层）、package.json 的脚本与依赖数、README 开头、文件类型统计。开始接触陌生项目时先调用它。',
        inputSchema: obj({ path: str('项目目录（可选，默认工作区根目录）') }),
        handler: async (a, c) => {
            const dir = resolvePath(c, a.path ?? '.');
            if (!node_fs_1.default.existsSync(dir) || !node_fs_1.default.statSync(dir).isDirectory())
                throw new security_1.ToolError('项目目录不存在');
            const root = roots(c).find((r) => dir.startsWith(r)) ?? baseDir(c);
            return (0, devtools_1.projectOverview)(root, dir);
        },
    },
    // ---- 项目记忆 ----
    {
        name: 'project_context',
        description: '接手项目时最先调用：返回项目目标、状态、最近的交接记录、决策与坑点、以及 Git 当前状态。这是跨会话接力的入口。',
        inputSchema: obj({ path: str('项目目录（可选，默认工作区根目录）') }),
        handler: async (a, c) => {
            const dir = resolvePath(c, a.path ?? '.');
            const m = c.projects.load(dir);
            const recent = m.handoffs
                .slice(-3)
                .map((h) => `- [${h.time}] ${h.summary}\n  下一步：${h.next || '—'}\n  风险：${h.risks || '—'}`)
                .join('\n') || '（暂无交接）';
            const notes = m.notes.slice(-20).map((n) => `- [${n.kind}] ${n.text}`).join('\n') || '（暂无）';
            const g = await (0, devtools_1.git)(c.cmds, dir, '--no-pager status --short --branch');
            const gitState = g.code === 0 ? g.out.trim().slice(0, 3000) || '工作区干净' : '（不是 Git 仓库，或 git 不可用）';
            return [
                `# 项目：${dir}`,
                `目标：${m.goal || '（未设置，可用 project_checkpoint 设置）'}`,
                `状态：${m.status}（更新于 ${m.updatedAt}）`,
                '',
                '## 最近交接',
                recent,
                '',
                '## 决策与坑点（最近 20 条）',
                notes,
                '',
                '## 计划与任务进度',
                coord_1.planSummary(dir),
                '',
                '## Git 状态',
                gitState,
                '',
                '## 最近活动（自动记录）',
                coord_1.journalText(15),
            ].join('\n');
        },
    },
    {
        name: 'project_checkpoint',
        description: '写交接记录：完成了什么（具体到文件或功能）、下一步、风险。阶段性完成或准备结束时调用。可同时更新项目目标与状态。',
        inputSchema: obj({
            path: str('项目目录（可选）'),
            summary: str('完成了什么，具体到文件或功能'),
            next: str('下一步'),
            risks: str('风险或阻塞'),
            goal: str('更新项目目标（可选）'),
            status: { type: 'string', enum: ['active', 'paused', 'done'], description: '项目状态（可选）' },
            agent_id: str('你的 agent_id（可选）：写交接会盖到该 agent 名下，作为 task_complete 完成门禁的凭据'),
        }, ['summary']),
        handler: async (a, c) => {
            const dir = resolvePath(c, a.path ?? '.');
            const m = c.projects.update(dir, (p) => {
                if (a.goal)
                    p.goal = String(a.goal);
                if (a.status)
                    p.status = a.status;
                p.handoffs.push({
                    id: p.nextId++,
                    time: new Date().toISOString(),
                    summary: String(a.summary),
                    next: String(a.next ?? ''),
                    risks: String(a.risks ?? ''),
                });
            });
            const agId = typeof a.agent_id === 'string' && a.agent_id ? a.agent_id : undefined;
            coord_1.stampCheckpoint(agId);
            return `已写入交接 #${m.handoffs.length}（项目状态：${m.status}${agId ? '，已盖章 agent ' + agId : '，未带 agent_id：不会解锁完成门禁'}）`;
        },
    },
    {
        name: 'project_note',
        description: '记录决策（decision：做了什么、为什么）、坑点（gotcha：踩过的坑、环境特性）、约定（convention）或其他信息（note）。之后接手的 AI 会在 project_context 里看到。',
        inputSchema: obj({
            path: str('项目目录（可选）'),
            kind: { type: 'string', enum: ['decision', 'gotcha', 'convention', 'note'], description: '类别' },
            text: str('内容'),
        }, ['kind', 'text']),
        handler: async (a, c) => {
            const kinds = ['decision', 'gotcha', 'convention', 'note'];
            if (!kinds.includes(a.kind))
                throw new security_1.ToolError('kind 必须是 decision / gotcha / convention / note 之一');
            const dir = resolvePath(c, a.path ?? '.');
            c.projects.update(dir, (p) => {
                p.notes.push({ id: p.nextId++, time: new Date().toISOString(), kind: a.kind, text: String(a.text) });
            });
            return '已记录';
        },
    },
    {
        name: 'project_memory_search',
        description: '在项目的交接与笔记中按关键词搜索（多个词都要出现）。用来回答"以前为什么这样做""这个坑踩过没有"。',
        inputSchema: obj({ query: str('关键词，空格分隔'), path: str('项目目录（可选）') }, ['query']),
        handler: async (a, c) => {
            const dir = resolvePath(c, a.path ?? '.');
            const hits = c.projects.search(dir, String(a.query));
            if (hits.length === 0)
                return '没有找到相关记录';
            return hits.map((h) => `[${h.kind}] ${h.time}\n  ${h.text}`).join('\n');
        },
    },
    // ---- 技能 ----
    {
        name: 'skill_list',
        description: '列出可用技能（可复用的工作说明）。任务与某个技能的描述相符时，先用 skill_read 读取完整说明再动手。',
        inputSchema: obj({}),
        handler: async (_a, c) => {
            const list = c.skills.list();
            if (list.length === 0)
                return '没有技能';
            return list
                .map((s) => `- ${s.name}：${s.description}` + (s.files.length ? `（附带文件：${s.files.join(', ')}）` : ''))
                .join('\n');
        },
    },
    {
        name: 'skill_read',
        description: '读取技能的完整说明（SKILL.md），或读取它附带的某个文件。',
        inputSchema: obj({ name: str('技能名'), file: str('附带文件的相对路径（可选）') }, ['name']),
        handler: async (a, c) => c.skills.read(String(a.name), a.file ? String(a.file) : undefined),
    },
    {
        name: 'skill_save',
        description: '把一套做法保存为技能，供以后复用（例如某类任务的固定流程）。body 用 Markdown 写步骤；description 要写清楚适用场景。',
        inputSchema: obj({
            name: str('技能名，小写字母、数字和连字符'),
            description: str('适用场景的一句话描述'),
            body: str('Markdown 正文：步骤与注意事项'),
        }, ['name', 'description', 'body']),
        handler: async (a, c) => {
            c.skills.save(String(a.name), String(a.description), String(a.body));
            return `已保存技能：${a.name}`;
        },
    },
    // ---- 网页 ----
    {
        name: 'web_fetch',
        description: '打开网页并提取正文文本（去掉脚本与样式）。用来读文档、API 说明、更新日志。默认最多 20000 字符。',
        inputSchema: obj({ url: str('网址（http 或 https）'), max_chars: num('最多返回的字符数，默认 20000，最大 100000') }, ['url']),
        handler: async (a) => {
            const max = Math.min(100000, Math.max(1000, Number(a.max_chars ?? 20000)));
            return (0, web_1.webFetch)(String(a.url), max);
        },
    },
    {
        name: 'web_search',
        description: '搜索网页，返回标题、网址与摘要。找到具体页面后，用 web_fetch 读取正文。',
        inputSchema: obj({ query: str('搜索词'), count: num('返回条数，默认 8，最多 15') }, ['query']),
        handler: async (a) => {
            const count = Math.min(15, Math.max(1, Number(a.count ?? 8)));
            const hits = await (0, web_1.webSearch)(String(a.query), count);
            if (hits.length === 0)
                return '没有解析到搜索结果（可能被拦截或页面结构变化），可改用 web_fetch 直接访问相关网址。';
            return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n');
        },
    },
    {
        name: 'web_download',
        description: '下载文件到收件箱（上限 50MB），之后可用 inbox_read 读取，或在面板中查看。',
        inputSchema: obj({ url: str('文件网址'), name: str('保存的文件名（可选，默认用网址中的文件名）') }, ['url']),
        handler: async (a, c) => {
            const { buf, name: remote } = await (0, web_1.webDownload)(String(a.url), 50 * 1024 * 1024);
            const base = String(a.name ?? remote).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
            const dir = node_path_1.default.join(c.dataDir, 'inbox');
            const ext = node_path_1.default.extname(base);
            const stem = ext ? base.slice(0, -ext.length) : base;
            let final = base;
            for (let i = 1; node_fs_1.default.existsSync(node_path_1.default.join(dir, final)); i++)
                final = `${stem}-${i}${ext}`;
            node_fs_1.default.writeFileSync(node_path_1.default.join(dir, final), buf);
            return `已下载到收件箱：${final}（${buf.length} 字节）`;
        },
    },
    // ---- 桌面 ----
    {
        name: 'screenshot',
        description: '截取主屏幕（或指定区域）并返回图片，用来看当前屏幕上的内容。坐标为物理像素（已开启 DPI 感知）。仅 Windows。',
        inputSchema: obj({
            x: num('区域左上角 x（可选）'),
            y: num('区域左上角 y（可选）'),
            w: num('区域宽度（可选）'),
            h: num('区域高度（可选）'),
        }, []),
        handler: async (a, c) => {
            const { file, info } = await (0, desktop_1.screenshot)(c.cmds, c.dataDir, { x: a.x, y: a.y, w: a.w, h: a.h });
            const buf = node_fs_1.default.readFileSync(file);
            return [
                text(`截图已保存：${file}（${info}）`),
                { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
            ];
        },
    },
    {
        name: 'ui_list_windows',
        description: '列出当前有标题的可见窗口（进程号、进程名、窗口标题）。操作某个软件前先用它确认窗口是否存在。仅 Windows。',
        inputSchema: obj({}),
        handler: async (_a, c) => {
            const out = await (0, desktop_1.nativeAction)(c.cmds, c.dataDir, 'windows');
            return out || '没有可见窗口';
        },
    },
    {
        name: 'ui_focus',
        description: '把标题包含指定文字的窗口切换到前台。之后的键盘输入会发给它。仅 Windows。',
        inputSchema: obj({ title: str('窗口标题（完整或部分，需与 ui_list_windows 显示的一致）') }, ['title']),
        handler: async (a, c) => {
            await (0, desktop_1.nativeAction)(c.cmds, c.dataDir, 'focus', { text: String(a.title) });
            return `已尝试切换到窗口：${a.title}（请截图确认）`;
        },
    },
    {
        name: 'ui_click',
        description: '在屏幕指定坐标点击鼠标（物理像素）。点击前建议先 screenshot 确认位置。仅 Windows。',
        inputSchema: obj({
            x: num('横坐标'),
            y: num('纵坐标'),
            button: { type: 'string', enum: ['left', 'right'], description: '鼠标按键，默认 left' },
        }, ['x', 'y']),
        handler: async (a, c) => {
            await (0, desktop_1.nativeAction)(c.cmds, c.dataDir, 'click', { x: Number(a.x), y: Number(a.y), button: a.button ?? 'left' });
            return `已点击 (${a.x}, ${a.y})，请截图确认结果`;
        },
    },
    {
        name: 'ui_type',
        description: '向当前前台窗口输入文字（逐字发送，特殊字符会自动转义）。输入前用 ui_focus 确认目标窗口。仅 Windows。',
        inputSchema: obj({ text: str('要输入的文字') }, ['text']),
        handler: async (a, c) => {
            await (0, desktop_1.nativeAction)(c.cmds, c.dataDir, 'type', { text: String(a.text) });
            return '已输入文字';
        },
    },
    {
        name: 'ui_key',
        description: '发送按键组合（SendKeys 语法）：^ 表示 Ctrl，% 表示 Alt，+ 表示 Shift；特殊键用花括号，如 {ENTER}、{TAB}、{ESC}、{F5}。例如 "^s" 保存，"%{F4}" 关闭窗口。仅 Windows。',
        inputSchema: obj({ keys: str('按键，SendKeys 语法') }, ['keys']),
        handler: async (a, c) => {
            await (0, desktop_1.nativeAction)(c.cmds, c.dataDir, 'key', { text: String(a.keys) });
            return `已发送按键：${a.keys}`;
        },
    },
    {
        name: 'env_info',
        description: '检查环境：操作系统、内存、CPU，以及 node、npm、git、python、dotnet、java 等工具是否可用及版本。',
        inputSchema: obj({}),
        handler: async (_a, c) => (0, desktop_1.envInfo)(c.cmds, baseDir(c)),
    },
];
// ---- 规格名称别名：与已有工具共用实现，旧名字保留 ----
function alias(newName, oldName, description) {
    const t = TOOLS.find((x) => x.name === oldName);
    if (!t)
        throw new Error(`别名目标不存在：${oldName}`);
    return { ...t, name: newName, description: description ?? t.description };
}
TOOLS.push(alias('search_files', 'search_content', '正则搜索文件内容，可用路径过滤。（同 search_content）'), alias('get_command_output', 'command_output', '读取后台命令的状态与增量输出。（同 command_output）'), alias('cancel_command', 'command_cancel', '终止命令（会杀掉整个进程树）。（同 command_cancel）'), alias('list_skills', 'skill_list', '列出所有技能手册。（同 skill_list）'), alias('use_skill', 'skill_read', '调用技能：读取技能的完整说明，或它附带的文件。（同 skill_read）'), alias('save_skill', 'skill_save', '把新的做法沉淀为技能手册。（同 skill_save）'), alias('memory_context', 'memory_get', '读取跨会话记忆。不传 key 则返回全部。（同 memory_get）'), alias('memory_checkpoint', 'memory_set', '写入跨会话记忆（同名覆盖）。（同 memory_set）'), {
    name: 'list_dir',
    description: '列出目录内容：名称、类型（文件/目录）、大小、修改时间。最多返回 1000 项。',
    inputSchema: obj({ path: str('目录路径，默认工作区根目录') }),
    handler: async (a, c) => {
        const dir = resolvePath(c, a.path ?? '.');
        if (!node_fs_1.default.statSync(dir).isDirectory())
            throw new security_1.ToolError('不是目录');
        const entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true }).slice(0, 1000);
        if (entries.length === 0)
            return '目录为空';
        return entries
            .map((d) => {
            const full = node_path_1.default.join(dir, d.name);
            let size = '-';
            let mtime = '-';
            try {
                const st = node_fs_1.default.statSync(full);
                size = d.isDirectory() ? '-' : `${st.size} B`;
                mtime = st.mtime.toISOString();
            }
            catch {
                /* 损坏的符号链接等，保留占位 */
            }
            return `${d.isDirectory() ? '[目录]' : '[文件]'} ${d.name}  ${size}  ${mtime}`;
        })
            .join('\n');
    },
}, {
    name: 'lsp',
    description: '代码导航：action 取 hover（显示符号的定义行）、definition（定义位置）、references（引用位置）。注意：当前是基于正则的近似实现，不是完整的语言服务器，结果需要结合 read_file 核对。',
    inputSchema: obj({
        action: { type: 'string', enum: ['hover', 'definition', 'references'], description: '操作类型' },
        name: str('符号名称'),
    }, ['action', 'name']),
    handler: async (a, c) => {
        const name = String(a.name);
        if (a.action === 'references') {
            const r = (0, devtools_1.findReferences)(baseDir(c), name);
            return r.length ? r.join('\n') : '没有找到引用';
        }
        const r = (0, devtools_1.findDefinitions)(baseDir(c), name);
        if (r.length === 0)
            return '没有找到定义';
        return a.action === 'hover' ? `${name} 的定义：\n${r.slice(0, 5).join('\n')}` : r.join('\n');
    },
});
/** 在指定目录运行 git，失败时抛出含输出的错误 */
async function gitIn(c, cwdArg, args) {
    const cwd = resolvePath(c, typeof cwdArg === 'string' && cwdArg ? cwdArg : '.');
    const r = await (0, devtools_1.git)(c.cmds, cwd, args);
    if (r.code !== 0)
        throw new security_1.ToolError(`git 失败（退出码 ${r.code}）：\n${r.out.trim().slice(-4000)}`);
    const out = r.out.trim();
    return out.length > 60000 ? out.slice(0, 60000) + '\n…（输出已截断）' : out || '（无输出）';
}
TOOLS.push({
    name: 'upload_file',
    description: '把文件从 AI 端上传到本机收件箱（单文件最大 50MB）。内容用 base64 编码；可选 sha256 用于校验。文件保存到收件箱，用户可在面板查看；重名时自动加序号，不覆盖已有文件。',
    inputSchema: obj({
        filename: str('文件名（只允许单个文件名，不含目录）'),
        content_base64: str('文件内容的 base64 编码'),
        sha256: str('文件的 sha256（十六进制，可选，用于校验）'),
    }, ['filename', 'content_base64']),
    handler: async (a, c) => {
        const r = (0, transfer_1.uploadToInbox)(c.dataDir, a.filename, a.content_base64, a.sha256);
        (0, transfer_1.recordTransfer)(c.dataDir, { time: new Date().toISOString(), direction: 'upload', name: r.name, bytes: r.bytes, sha256: r.sha256 });
        return `已保存到收件箱：${r.name}（${r.bytes} 字节，sha256 ${r.sha256}）`;
    },
}, {
    name: 'download_file',
    description: '把本机文件发给 AI。1MB 以内的文件一次返回全部内容（文本直接返回，二进制返回 base64）。更大的文件（最大 2GB）按块返回：每次最多 1MB，用返回值中的"下一次请用 offset=…"继续取，直到"完成：是"。第一块会给出整个文件的 sha256，拼接后可用它校验。',
    inputSchema: obj({
        path: str('文件路径（工作区内）'),
        offset: num('起始字节位置，默认 0'),
        length: num(`本次最多取的字节数，默认与上限 ${transfer_1.CHUNK_MAX}`),
    }, ['path']),
    handler: async (a, c) => {
        const abs = resolvePath(c, a.path);
        const offset = a.offset === undefined ? 0 : Number(a.offset);
        const length = a.length === undefined ? transfer_1.CHUNK_MAX : Math.max(1, Number(a.length));
        const r = (0, transfer_1.readChunk)(abs, offset, length);
        const rel = node_path_1.default.relative(baseDir(c), abs) || node_path_1.default.basename(abs);
        if (offset === 0) {
            (0, transfer_1.recordTransfer)(c.dataDir, {
                time: new Date().toISOString(),
                direction: 'download',
                name: rel,
                bytes: r.bytes,
                sha256: r.sha256 ?? '',
            });
        }
        const head = [
            `文件：${rel}`,
            `大小：${r.bytes} 字节`,
            `本次范围：${r.from}-${r.to}（${r.data.length} 字节）`,
            `完成：${r.done ? '是' : `否，下一次请用 offset=${r.to}`}`,
        ];
        if (r.sha256)
            head.push(`整个文件 sha256：${r.sha256}`);
        const isText = r.done && r.from === 0 && !r.data.includes(0);
        const text = isText ? r.data.toString('utf8') : '';
        if (isText && !text.includes('\uFFFD'))
            return head.join('\n') + '\n\n内容（文本）：\n' + text;
        return head.join('\n') + '\n\n内容（base64）：\n' + r.data.toString('base64');
    },
});
/** 查询本机监听某端口的进程（Windows，PowerShell Get-NetTCPConnection） */
function portListeners(port) {
    if (!platform_1.IS_WIN)
        return (0, platform_1.linuxPortListeners)(port);
    const cp = require("node:child_process");
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{ pid = $_.OwningProcess; name = $p.ProcessName; path = $p.Path } } | ConvertTo-Json -Compress }`;
    try {
        const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
        if (!out)
            return [];
        const raw = JSON.parse(out);
        return (Array.isArray(raw) ? raw : [raw]).map((r) => ({ pid: Number(r.pid), name: String(r.name ?? ""), path: String(r.path ?? "") }));
    }
    catch {
        return [];
    }
}
/** 对本机 URL 发一次 GET，返回 HTTP 状态码；连不上会抛错 */
function httpPing(url, timeoutMs = 3000) {
    const http = require("node:http");
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("timeout", () => req.destroy(new Error("超时")));
        req.on("error", reject);
    });
}
function localPort(v) {
    const p = Number(v);
    if (!Number.isInteger(p) || p < 1 || p > 65535)
        throw new security_1.ToolError("端口不合法");
    return p;
}
/** 这些工具必须带 why（一句大白话说明理由），否则返回 NEEDS_EXPLANATION */
const WHY_TOOLS = new Set([
    'write_file',
    'edit_file',
    'apply_patch',
    'run_command',
    'git_commit',
    'kill_port',
    'ui_click',
    'ui_type',
    'ui_key',
    'ui_focus',
]);
TOOLS.push(...coord_1.makeTools());
const WHY_PROP = {
    type: 'string',
    description: '必填。用一句大白话说明为什么要做这个操作（用户会在确认卡片上看到）',
};
/** 面板用：工具目录（名称、说明、是否启用） */
function toolCatalog(disabled) {
    return TOOLS.map((t) => ({ name: t.name, description: t.description, enabled: !disabled.includes(t.name), exposed: EXPOSED.has(t.name) }));
}
// 与其他工具重复的别名：不再出现在 tools/list 里（仍可调用，保证旧提示词不报错）
// 对外展示的工具（tools/list）。其余工具仍可调用，只是不占用 AI 的工具列表。
const EXPOSED = new Set(['read_file', 'write_file', 'apply_patch', 'search_content', 'find_files', 'run_command', 'command_output', 'command_cancel', 'job_start', 'job_poll', 'run_tests', 'wait_for_http', 'port_status', 'kill_port', 'edit_preview', 'worktree_create', 'worktree_remove', 'project_note', 'session_info', 'agent_register', 'project_context', 'project_checkpoint', 'plan_create', 'task_status', 'task_progress', 'task_complete', 'task_block', 'reserve_files', 'release_files', 'task_accept', 'task_review', 'task_claim', 'report_progress', 'update_plan', 'todo_list', 'todo_add', 'todo_update', 'todo_delete', 'set_todos', 'skill_list', 'skill_read', 'skill_save', 'project_overview', 'project_memory_search', 'upload_file', 'download_file', 'inbox_list', 'inbox_read', 'outbox_list', 'outbox_write', 'git_status', 'git_diff', 'git_log', 'git_commit', 'edit_file', 'read_files', 'list_dir', 'read_image', 'web_search', 'web_fetch', 'get_diagnostics', 'code_definition', 'code_references', 'env_info', 'memory_get', 'memory_set', 'memory_search', 'task_delete', 'plan_delete']);
// job_* 复用对应工具的审批与 why 规则
const POLICY_ALIAS = { job_start: 'run_command', job_poll: 'command_output' };
const HIDDEN_ALIASES = new Set(['list_skills', 'use_skill', 'save_skill', 'memory_context', 'memory_checkpoint', 'search_files', 'get_command_output', 'cancel_command']);
function listTools(disabled = []) {
    return TOOLS.filter((t) => !disabled.includes(t.name) && EXPOSED.has(t.name)).map((t) => {
        if (!WHY_TOOLS.has(POLICY_ALIAS[t.name] ?? t.name))
            return { name: t.name, description: t.description, inputSchema: t.inputSchema };
        const schema = t.inputSchema;
        return {
            name: t.name,
            description: t.description,
            inputSchema: {
                ...schema,
                properties: { ...schema.properties, why: WHY_PROP },
                required: [...schema.required, 'why'],
            },
        };
    });
}
// 写文件类工具：成功后可能触发「记得写交接」就近提醒（每 8 次未交接写入一次）
const WRITE_HINT_TOOLS = new Set(['write_file', 'apply_patch', 'edit_file', 'git_commit']);
async function callTool(name, args, c) {
    const started = Date.now();
    const input = args ?? {};
    const summary = JSON.stringify(input).slice(0, 200);
    const finish = (ok, res) => {
        c.log.add({ tool: name, ok, ms: Date.now() - started, summary });
        return res;
    };
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool)
        return finish(false, { content: [text(`未知工具：${name}`)], isError: true });
    if (c.cfg.get().disabledTools.includes(name)) {
        return finish(false, { content: [text(`工具 ${name} 已在面板中被关闭，请让电脑主人在「工具」页开启`)], isError: true });
    }
    const why = String(input.why ?? '').trim();
    const pname = POLICY_ALIAS[name] ?? name;
    if (WHY_TOOLS.has(pname) && !why) {
        return finish(false, {
            content: [text('NEEDS_EXPLANATION：此操作需要参数 why（一句大白话说明理由）。请补上 why 后重试。')],
            isError: true,
        });
    }
    const { need, reason } = (0, security_1.needsApproval)(c.cfg.get().approvalMode, pname, input);
    if (need) {
        const ok = await c.approvals.request(name, summary, why ? `${why}（${reason}）` : reason);
        if (!ok)
            return finish(false, { content: [text('操作未获批准（被拒绝或等待超时）。A类危险命令可传 confirm:"YES" 明示授权后重试')], isError: true });
        input.__approved = true;
    }
    let unlock = null;
    try {
        // git 写操作串行，避免多个 AI 同时抢 .git/index.lock
        if (coord_1.needsGitLock(name, input))
            unlock = await coord_1.acquireGitLock();
        // 写类工具：检查文件是否被其他 AI 预占
        coord_1.guardWrite(name, input, c);
        const out = await tool.handler(input, c);
        let content = typeof out === 'string' ? [text(out)] : out;
        if (WRITE_HINT_TOOLS.has(name) && typeof out === 'string')
            content = [text(out + coord_1.noteWriteAndHint(typeof input.agent_id === 'string' ? input.agent_id : undefined))];
        return finish(true, { content });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return finish(false, { content: [text(msg)], isError: true });
    }
    finally {
        if (unlock)
            unlock();
    }
}