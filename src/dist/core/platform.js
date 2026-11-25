"use strict";
/**
 * 跨平台适配层（Windows / Linux / Kali）
 *
 * 原先散落在各模块里的 Windows 专属调用（PowerShell、taskkill、Get-NetTCPConnection、
 * C:\Windows\System32\OpenSSH\ssh.exe）统一收敛到这里，Linux 走等价实现。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IS_WIN = exports.linuxPortListeners = exports.listSsh = exports.killTreeSync = exports.killTree = exports.sshBinary = exports.linuxSystemInfo = void 0;
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const IS_WIN = process.platform === 'win32';
exports.IS_WIN = IS_WIN;
/** 找到可用的 ssh 可执行文件：Windows 用系统 OpenSSH，Linux 用 PATH 里的 ssh */
function sshBinary() {
    if (IS_WIN) {
        const candidates = [
            path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "OpenSSH", "ssh.exe"),
            "ssh.exe",
        ];
        for (const file of candidates) {
            try {
                if (file && fs.existsSync(file))
                    return file;
            }
            catch { }
        }
        return "ssh.exe";
    }
    for (const c of ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh"]) {
        try {
            if (fs.existsSync(c))
                return c;
        }
        catch { }
    }
    return "ssh";
}
/** 列出本机所有 ssh 进程（进程号 / 命令行），用于识别复用的反向隧道 */
function listSsh() {
    return new Promise((resolve) => {
        if (IS_WIN) {
            const script = "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
            cp.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 8000, windowsHide: true }, (err, stdout) => {
                if (err)
                    return resolve([]);
                const text = String(stdout || "").trim();
                if (!text)
                    return resolve([]);
                try {
                    const raw = JSON.parse(text);
                    const list = Array.isArray(raw) ? raw : [raw];
                    resolve(list.map((row) => ({ pid: Number(row.ProcessId) || 0, cmd: String(row.CommandLine || "") })).filter((row) => row.pid > 0));
                }
                catch {
                    resolve([]);
                }
            });
            return;
        }
        // Linux：ps -eo pid=,args=
        cp.execFile("/bin/ps", ["-eo", "pid=,args="], { timeout: 8000 }, (err, stdout) => {
            if (err)
                return resolve([]);
            const rows = String(stdout || "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                    const m = line.match(/^(\d+)\s+(.*)$/);
                    return m ? { pid: Number(m[1]) || 0, cmd: m[2] } : null;
                })
                .filter((row) => row && row.pid > 0 && /(^|\/)ssh(\s|$)/.test(row.cmd));
            resolve(rows);
        });
    });
}
/** 结束进程树：Windows 用 taskkill /T /F，Linux 用 SIGTERM→SIGKILL */
function killTree(pid) {
    return new Promise((resolve) => {
        if (!pid)
            return resolve();
        if (IS_WIN) {
            cp.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
            return;
        }
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { }
        setTimeout(() => {
            try {
                process.kill(pid, 0);
                process.kill(pid, "SIGKILL");
            }
            catch { }
            resolve();
        }, 400);
    });
}
/** 同步版本（退出路径兜底用） */
function killTreeSync(pid) {
    if (!pid)
        return;
    if (IS_WIN) {
        try {
            cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 4000 });
        }
        catch { }
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    }
    catch { }
}
/** 查本机监听某端口的进程 */
function linuxPortListeners(port) {
    const rows = [];
    // 1) ss -ltnp
    try {
        const out = cp.execFileSync("/usr/bin/ss", ["-ltnp"], { encoding: "utf8", timeout: 8000 });
        for (const line of out.split(/\r?\n/)) {
            if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`))
                continue;
            const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
            if (m)
                rows.push({ pid: Number(m[2]) || 0, name: m[1], path: "" });
        }
    }
    catch { }
    if (!rows.length) {
        try {
            const out = cp.execFileSync("/usr/bin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 8000 });
            for (const line of out.split(/\r?\n/).slice(1)) {
                const m = line.match(/^\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S*)/);
                if (m)
                    rows.push({ pid: Number(m[1]) || 0, name: path.basename(m[2]), path: m[4] || "" });
            }
        }
        catch { }
    }
    return rows;
}
exports.linuxPortListeners = linuxPortListeners;
/** 轻量系统信息（Linux 版） */
function linuxSystemInfo() {
    const lines = [];
    lines.push(`系统：${os.type()} ${os.release()}`);
    lines.push(`主机：${os.hostname()}`);
    lines.push(`架构：${os.arch()}`);
    lines.push(`CPU 核数：${os.cpus().length}`);
    lines.push(`总内存：${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
    lines.push(`可用内存：${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
    lines.push(`Node：${process.version}`);
    lines.push(`工作目录：${process.cwd()}`);
    lines.push(`用户：${os.userInfo().username}`);
    lines.push(`发行版：${(fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : '').split(/\r?\n/).filter((l) => l.startsWith('PRETTY_NAME')).join(', ')}`);
    return lines.join('\n');
}
exports.linuxSystemInfo = linuxSystemInfo;
exports.sshBinary = sshBinary;
exports.listSsh = listSsh;
exports.killTree = killTree;
exports.killTreeSync = killTreeSync;
