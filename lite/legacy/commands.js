"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandManager = void 0;
exports.readOutput = readOutput;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = __importDefault(require("node:crypto"));
const MAX_OUTPUT = 1024 * 1024;
function shellFor(command) {
    if (process.platform === 'win32') {
        return [
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + command,
            ],
        ];
    }
    return ['/bin/bash', ['-c', command]];
}
function killTree(child) {
    if (!child.pid)
        return;
    try {
        if (process.platform === 'win32') {
            (0, node_child_process_1.execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { });
        }
        else {
            process.kill(-child.pid, 'SIGKILL');
        }
    }
    catch {
        try {
            child.kill('SIGKILL');
        }
        catch {
            /* 已经退出 */
        }
    }
}
class CommandManager {
    jobs = new Map();
    /** 登记一个由外部（持久终端）管理的任务，输出与结束由调用方通过 appendOutput / finishJob 写入 */
    createJob(command, cwd, child) {
        let markDone = () => { };
        const done = new Promise((r) => (markDone = r));
        const job = {
            id: node_crypto_1.default.randomBytes(4).toString('hex'),
            command,
            cwd,
            status: 'running',
            exitCode: null,
            startedAt: Date.now(),
            endedAt: null,
            base: 0,
            output: '',
            child,
            done,
            markDone,
        };
        this.jobs.set(job.id, job);
        this.prune();
        return job;
    }
    start(command, cwd) {
        const [bin, args] = shellFor(command);
        const child = (0, node_child_process_1.spawn)(bin, args, {
            cwd,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let markDone = () => { };
        const done = new Promise((r) => (markDone = r));
        const job = {
            id: node_crypto_1.default.randomBytes(4).toString('hex'),
            command,
            cwd,
            status: 'running',
            exitCode: null,
            startedAt: Date.now(),
            endedAt: null,
            base: 0,
            output: '',
            child,
            done,
            markDone,
        };
        const onData = (d) => this.append(job, d.toString('utf8'));
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (e) => {
            this.append(job, `\n[启动失败] ${e.message}\n`);
            this.finish(job, 'exited', -1);
        });
        child.on('close', (code) => this.finish(job, 'exited', code));
        this.jobs.set(job.id, job);
        this.prune();
        return job;
    }
    /** 前台运行：等待结束或超时；超时则终止进程 */
    async runForeground(command, cwd, timeoutMs) {
        const job = this.start(command, cwd);
        let timer;
        await Promise.race([
            job.done,
            new Promise((r) => {
                timer = setTimeout(r, timeoutMs);
            }),
        ]);
        clearTimeout(timer);
        if (job.endedAt === null) {
            job.status = 'timeout';
            killTree(job.child);
            await Promise.race([job.done, new Promise((r) => setTimeout(r, 3000))]);
        }
        return job;
    }
    get(id) {
        return this.jobs.get(id);
    }
    list() {
        return [...this.jobs.values()];
    }
    cancel(id) {
        const job = this.jobs.get(id);
        if (!job)
            throw new Error(`没有找到命令：${id}`);
        if (job.status === 'running') {
            job.status = 'cancelled';
            killTree(job.child);
        }
        return job;
    }
    finishJob(job, status, code) {
        this.finish(job, status, code);
    }
    appendOutput(job, text) {
        this.append(job, text);
    }
    finish(job, status, code) {
        if (job.endedAt !== null)
            return;
        if (job.status === 'running')
            job.status = status;
        job.exitCode = code;
        job.endedAt = Date.now();
        job.markDone();
    }
    append(job, text) {
        job.output += text;
        if (job.output.length > MAX_OUTPUT) {
            const drop = job.output.length - MAX_OUTPUT;
            job.output = job.output.slice(drop);
            job.base += drop;
        }
    }
    prune() {
        if (this.jobs.size <= 60)
            return;
        const finished = [...this.jobs.values()].filter((j) => j.endedAt !== null);
        for (const j of finished.slice(0, Math.max(0, finished.length - 30)))
            this.jobs.delete(j.id);
    }
}
exports.CommandManager = CommandManager;
function readOutput(job, offset) {
    const start = Math.max(offset ?? job.base, job.base);
    return {
        text: job.output.slice(start - job.base),
        from: start,
        next: job.base + job.output.length,
        truncatedBefore: offset !== undefined && offset < job.base,
    };
}
