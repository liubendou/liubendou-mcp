"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistentTerminal = void 0;
const node_child_process_1 = require("node:child_process");
const security_1 = require("./security");
const isWin = process.platform === 'win32';
/**
 * 持久终端：一个常驻的 shell 进程（Windows 为 PowerShell，其他为 bash）。
 * cd、环境变量、函数等状态会在多次 run_command 之间保留。
 * 每条命令结束时输出一行结束标记（含退出码），据此切分输出。
 * 同一时间只能运行一条前台命令；超时的命令会继续在后台跑，用 command_output 取输出。
 */
class PersistentTerminal {
    cmds;
    defaultCwd;
    proc = null;
    current = null;
    constructor(cmds, defaultCwd) {
        this.cmds = cmds;
        this.defaultCwd = defaultCwd;
    }
    /** 当前正在运行的前台命令（没有则为 null） */
    busy() {
        return this.current?.job ?? null;
    }
    /** 中断当前前台命令：立即释放终端（杀掉终端进程），下次执行时自动重新启动 */
    abort(jobId) {
        const cur = this.current;
        if (!cur || cur.job.id !== jobId)
            return false;
        this.current = null;
        this.stop();
        this.cmds.finishJob(cur.job, 'cancelled', null);
        return true;
    }
    /** 服务停止时调用：结束终端进程（含子进程） */
    stop() {
        const child = this.proc;
        this.proc = null;
        if (!child || child.pid === undefined)
            return;
        try {
            if (isWin) {
                (0, node_child_process_1.spawn)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            }
            else {
                process.kill(-child.pid, 'SIGKILL');
            }
        }
        catch {
            child.kill('SIGKILL');
        }
    }
    ensure() {
        if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null)
            return this.proc;
        const [bin, args] = isWin
            ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']]
            : ['/bin/bash', ['--noprofile', '--norc']];
        const child = (0, node_child_process_1.spawn)(bin, args, {
            cwd: this.defaultCwd(),
            windowsHide: true,
            detached: !isWin,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const onData = (d) => this.onData(child, d.toString('utf8'));
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (e) => this.onExit(child, -1, `[终端启动失败] ${e.message}\n`));
        child.on('close', (code) => this.onExit(child, code));
        if (isWin)
            child.stdin?.write('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n');
        this.proc = child;
        return child;
    }
    /**
     * 在持久终端中执行一条命令。前台等待到 timeoutMs；超时则返回仍在运行的 job。
     * cwd 可选：若给出，先切换到该目录（切换会保留到之后的命令）。
     */
    async exec(command, cwd, timeoutMs) {
        const busy = this.busy();
        if (busy) {
            throw new security_1.ToolError(`终端正忙：命令 ${busy.id}（${busy.command.slice(0, 80)}）仍在运行。请用 command_output 查看，或用 command_cancel 中断后再执行。`);
        }
        const child = this.ensure();
        const id = Math.random().toString(36).slice(2, 10);
        const marker = `__LAC_END_${id}__:`;
        const job = this.cmds.createJob(command, cwd ?? this.defaultCwd(), child);
        this.current = { job, marker, pending: '' };
        const prefix = cwd === undefined ? '' : isWin ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}' -ErrorAction Stop\n` : `cd -- '${cwd.replace(/'/g, "'\\''")}' || true\n`;
        const tail = isWin
            ? `$__lacOk = $?\n$__lacExit = $LASTEXITCODE\nif ($__lacExit -eq 0 -and -not $__lacOk) { $__lacExit = 1 }\nWrite-Output ('${marker}' + $__lacExit)\n`
            : `__lac_rc=$?; printf '\\n%s%s\\n' '${marker}' "$__lac_rc"\n`;
        const reset = isWin ? '$global:LASTEXITCODE = 0\n' : '';
        child.stdin?.write(prefix + reset + command + '\n' + tail);
        let timer;
        await Promise.race([
            job.done,
            new Promise((r) => {
                timer = setTimeout(r, timeoutMs);
            }),
        ]);
        clearTimeout(timer);
        return job;
    }
    onData(child, text) {
        if (child !== this.proc || !this.current)
            return;
        const cur = this.current;
        cur.pending += text;
        const idx = cur.pending.indexOf(cur.marker);
        if (idx < 0) {
            // 保留末尾可能是标记前缀的部分，其余先输出
            const keep = cur.marker.length;
            if (cur.pending.length > keep) {
                const safe = cur.pending.slice(0, cur.pending.length - keep);
                this.cmds.appendOutput(cur.job, safe);
                cur.pending = cur.pending.slice(safe.length);
            }
            return;
        }
        const before = cur.pending.slice(0, idx).replace(/\n$/, '');
        const after = cur.pending.slice(idx + cur.marker.length);
        const nl = after.indexOf('\n');
        if (nl < 0)
            return; // 退出码还没收全
        const code = parseInt(after.slice(0, nl), 10);
        this.cmds.appendOutput(cur.job, before);
        this.current = null;
        this.cmds.finishJob(cur.job, 'exited', Number.isNaN(code) ? null : code);
    }
    onExit(child, code, note = '') {
        if (child !== this.proc)
            return;
        this.proc = null;
        if (this.current) {
            const cur = this.current;
            this.current = null;
            if (note)
                this.cmds.appendOutput(cur.job, note);
            this.cmds.finishJob(cur.job, 'exited', code);
        }
    }
}
exports.PersistentTerminal = PersistentTerminal;
