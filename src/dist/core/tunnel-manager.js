"use strict";
/**
 * 自管隧道管理器（SSH 反向隧道 → 自建服务器；SSH 不可用时自动切 Cloudflare 快速隧道）
 *
 * 职责：
 * 1. 启动时先看本机有没有已经在跑的同款反向隧道（命令行含 -R 8765 指向自建服务器）：有就验证后复用，不重复起；
 * 2. 没有就 spawn 系统自带的 OpenSSH，把服务器的 127.0.0.1:8765 反向映射到本机 MCP 端口；
 * 3. 不再"进程活着就算就绪"：必须公网入口真的回源到本机 MCP 才标记 ready；
 * 4. SSH 连不上（端口被封/服务器不可达/握手失败）时自动拉起 Cloudflare 快速隧道，
 *    把临时公网地址写进状态，保证 AI 客户端仍有入口；cloudflared 随应用退出一起收掉；
 * 5. 状态写进 tunnel-state，供 app.js 的 /api/tunnel-check 读取；
 * 6. 应用退出时只收掉本进程 spawn 出来的子进程，绝不杀别人的 ssh。
 */
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { setTunnelState, getTunnelState } = require("./tunnel-state");
const platform_1 = require("./platform");

/** 服务器上的 Caddy 监听 80，反代到 127.0.0.1:8765，公网入口固定为这个域名 */
const PUBLIC_URL = "http://leenzhuanjieben.shop";
const SSH_HOST = "root@<your-server-ip>";
/** 服务器侧固定占用 8765，不随本机 MCP 端口变化 */
const REMOTE_PORT = 8765;
/** 私钥必须显式 -i 指定，否则服务器会 Permission denied (publickey) */
const SSH_KEY = path.join(os.homedir(), ".ssh", "id_ed25519_hk");
/** SSH 起来后最多等这么久，公网入口仍不回源就切 Cloudflare（进程先不退也算失败） */
const SSH_VERIFY_MS = 18000;
/** Cloudflare 快速隧道拿到地址后，最多等这么久回源 */
const CF_VERIFY_MS = 30000;
/** Cloudflare 快速隧道连续重连上限 */
const MAX_CF_RESTARTS = 3;
/** 本机 MCP 的响应指纹：公网回源成功时一定带这个头 */
const MCP_FINGERPRINT_HEADER = "mcp-session-id";

let child = null;
let cfChild = null;
let spawnPort = 0;
let verifyTimer = null;
let cfVerifyTimer = null;
let cfUrlTimer = null;
let outputTail = "";
let cfOutputTail = "";
let cfUrl = null;
let mode = null;
let cfRestarts = 0;
let stopping = false;
let options = { getConfig: null, port: 8765 };

function log(...args) {
    console.log("[tunnel]", ...args);
}

function sshBinary() {
    return (0, platform_1.sshBinary)();
}

/** 找 cloudflared：优先环境变量 / Electron resources / 便携目录，Linux 走 PATH */
function cloudflaredBinary() {
    const name = platform_1.IS_WIN ? "cloudflared.exe" : "cloudflared";
    const candidates = [];
    if (process.env.CLOUDFLARED_PATH)
        candidates.push(process.env.CLOUDFLARED_PATH);
    try {
        if (process.resourcesPath)
            candidates.push(path.join(process.resourcesPath, name));
    }
    catch { }
    candidates.push(path.join(__dirname, "..", "..", "..", "dist-portable", "resources", name));
    candidates.push(path.join(process.cwd(), "dist-portable", "resources", name));
    for (const file of candidates) {
        try {
            if (file && fs.existsSync(file))
                return file;
        }
        catch { }
    }
    return platform_1.IS_WIN ? null : "cloudflared";
}

/** ssh 反向隧道参数：-R <服务器端口>:127.0.0.1:<本机 MCP 端口> */
function sshArgs(port) {
    return [
        "-i",
        SSH_KEY,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-R",
        `${REMOTE_PORT}:127.0.0.1:${port}`,
        SSH_HOST,
    ];
}

/** 列出本机所有 ssh 进程（进程号 / 命令行），用于复用手工建好的反向隧道 */
function listSsh() {
    return (0, platform_1.listSsh)();
}

/** 命令行是否是本方案的反向隧道（-R 8765 → 自建服务器） */
function isOurTunnel(cmd) {
    return /-R\s+8765:127\.0\.0\.1:\d+/.test(cmd) && cmd.includes(SSH_HOST);
}

function killTree(pid) {
    return (0, platform_1.killTree)(pid);
}

function clearVerify() {
    if (verifyTimer) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
    }
}

function clearCfTimers() {
    if (cfVerifyTimer) {
        clearTimeout(cfVerifyTimer);
        cfVerifyTimer = null;
    }
    if (cfUrlTimer) {
        clearTimeout(cfUrlTimer);
        cfUrlTimer = null;
    }
}

/** 公网入口是否真的回源到本机 MCP（看响应头指纹，不看"进程还活着"） */
function probePublic(url, timeoutMs = 6000) {
    return new Promise((resolve) => {
        const base = String(url || "").replace(/\/+$/, "");
        const lib = /^https:/i.test(base) ? https : http;
        let done = false;
        const finish = (ok, detail) => {
            if (done)
                return;
            done = true;
            resolve({ ok, detail });
        };
        let req;
        try {
            req = lib.get(base + "/", {
                timeout: timeoutMs,
                headers: { "user-agent": "liubendou-tunnel-verify", accept: "*/*" },
            }, (res) => {
                const hit = String(res.headers["access-control-expose-headers"] || "").includes(MCP_FINGERPRINT_HEADER);
                res.resume();
                finish(hit
                    ? true
                    : false, hit
                    ? `公网入口已回源（HTTP ${res.statusCode}）`
                    : `公网端口通了但响应不是本机 MCP（HTTP ${res.statusCode}）`);
            });
        }
        catch (e) {
            return finish(false, `请求发起失败：${e instanceof Error ? e.message : String(e)}`);
        }
        req.on("timeout", () => {
            req.destroy(new Error(`超时 ${timeoutMs} ms`));
        });
        req.on("error", (e) => finish(false, `连接失败：${e instanceof Error ? e.message : String(e)}`));
        req.end();
    });
}

/** 从 cloudflared 输出里抠出快速隧道地址 */
function parseQuickTunnelUrl(text) {
    const m = String(text || "").match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
    return m ? m[0].toLowerCase() : null;
}

function markReady(url, pid, owned, kind) {
    mode = kind;
    const detail = kind === "cloudflare"
        ? `Cloudflare 备用隧道已就绪（进程号 ${pid ?? "未知"}，临时地址，重启后会变）：${url}`
        : owned
            ? `SSH 反向隧道已就绪（进程号 ${pid ?? "未知"}）：${url}`
            : `复用已在运行的 SSH 反向隧道（进程号 ${pid ?? "未知"}），没有重复启动：${url}`;
    setTunnelState({
        phase: "ready",
        mode: kind,
        url,
        pid: pid ?? null,
        owned,
        detail,
    });
    log("公网地址", url, kind === "cloudflare" ? "（Cloudflare 备用隧道）" : owned ? "（应用自管）" : "（复用外部进程）");
}

function spawnChild(port) {
    const binary = sshBinary();
    const args = sshArgs(port);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let proc;
    try {
        proc = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    }
    catch (e) {
        setTunnelState({
            phase: "starting",
            mode: "ssh",
            url: null,
            pid: null,
            owned: false,
            detail: `ssh 启动失败：${e instanceof Error ? e.message : String(e)}，正在切换 Cloudflare 备用隧道…`,
        });
        startCloudflare(port, "ssh 启动失败");
        return null;
    }
    child = proc;
    spawnPort = port;
    outputTail = "";
    setTunnelState({
        phase: "starting",
        mode: "ssh",
        url: null,
        pid: proc.pid ?? null,
        owned: true,
        detail: `SSH 反向隧道已启动（进程号 ${proc.pid ?? "未知"}），正在验证公网入口…`,
    });
    const onChunk = (buf) => {
        outputTail = (outputTail + String(buf ?? "")).slice(-1500);
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (e) => {
        if (child !== proc)
            return;
        child = null;
        clearVerify();
        setTunnelState({
            phase: "starting",
            mode: "ssh",
            url: null,
            pid: null,
            owned: false,
            detail: `ssh 启动失败：${e instanceof Error ? e.message : String(e)}，正在切换 Cloudflare 备用隧道…`,
        });
        startCloudflare(port, "ssh 启动失败");
    });
    proc.on("exit", (code, signal) => {
        if (child !== proc)
            return;
        child = null;
        clearVerify();
        const tail = outputTail.trim().slice(-300);
        setTunnelState({
            phase: "starting",
            mode: "ssh",
            url: null,
            pid: null,
            owned: false,
            detail: `ssh 反向隧道已退出（${code ?? signal ?? "未知原因"}）${tail ? "；最近输出：" + tail : ""}，正在切换 Cloudflare 备用隧道…`,
        });
        startCloudflare(port, `SSH 隧道退出（${code ?? signal ?? "未知原因"}）`);
    });
    verifySsh(proc, port);
    log("已启动 ssh 反向隧道", binary, args.join(" "));
    return proc;
}

/** SSH 进程活着不算数：必须公网入口回源；超时/退出都切 Cloudflare */
function verifySsh(proc, port) {
    const deadline = Date.now() + SSH_VERIFY_MS;
    clearVerify();
    const tick = async () => {
        verifyTimer = null;
        if (child !== proc)
            return;
        const r = await probePublic(PUBLIC_URL, 5000);
        if (child !== proc)
            return;
        if (r.ok) {
            markReady(PUBLIC_URL, proc.pid ?? null, true, "ssh");
            return;
        }
        if (Date.now() >= deadline) {
            setTunnelState({
                phase: "starting",
                mode: "ssh",
                url: null,
                pid: proc.pid ?? null,
                owned: true,
                detail: `SSH 隧道 ${Math.round(SSH_VERIFY_MS / 1000)} 秒内没回源（${r.detail}），正在切换 Cloudflare 备用隧道…`,
            });
            void stopSshOnly();
            startCloudflare(port, "SSH 隧道未回源");
            return;
        }
        verifyTimer = setTimeout(tick, 1500);
    };
    verifyTimer = setTimeout(tick, 1200);
}

/** 只收自己的 ssh，不动 Cloudflare 子进程 */
async function stopSshOnly() {
    const proc = child;
    child = null;
    clearVerify();
    if (proc && proc.pid) {
        try {
            await killTree(proc.pid);
        }
        catch { }
    }
}

/** Cloudflare 快速隧道：SSH 不可用时的备用公网入口 */
function startCloudflare(port, reason) {
    if (stopping)
        return;
    if (cfChild)
        return;
    const cfg = options.getConfig?.() || {};
    if (cfg.autoTunnel === false) {
        setTunnelState({
            phase: "disabled",
            mode: null,
            url: null,
            pid: null,
            owned: false,
            detail: "设置里关闭了「启动时自动开公网隧道」，本次没有启用备用隧道",
        });
        return;
    }
    const binary = cloudflaredBinary();
    if (!binary) {
        setTunnelState({
            phase: "error",
            mode: null,
            url: null,
            pid: null,
            owned: false,
            detail: `${reason}；本机没找到 cloudflared，无法启用 Cloudflare 备用隧道`,
        });
        return;
    }
    const logFile = path.join(os.tmpdir(), "liubendou-cloudflared.log");
    const args = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "http2", "--logfile", logFile];
    let proc;
    try {
        proc = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    catch (e) {
        setTunnelState({
            phase: "error",
            mode: null,
            url: null,
            pid: null,
            owned: false,
            detail: `Cloudflare 备用隧道启动失败：${e instanceof Error ? e.message : String(e)}`,
        });
        return;
    }
    cfChild = proc;
    mode = "cloudflare";
    spawnPort = port;
    cfOutputTail = "";
    cfUrl = null;
    setTunnelState({
        phase: "starting",
        mode: "cloudflare",
        url: null,
        pid: proc.pid ?? null,
        owned: true,
        detail: `${reason}，已启动 Cloudflare 备用隧道（进程号 ${proc.pid ?? "未知"}），正在等公网地址…`,
    });
    const onChunk = (buf) => {
        const text = String(buf ?? "");
        cfOutputTail = (cfOutputTail + text).slice(-2000);
        // 按累计输出解析，避免地址被分块截断
        const found = parseQuickTunnelUrl(cfOutputTail);
        if (found && !cfUrl) {
            cfUrl = found;
            log("Cloudflare 备用隧道地址", found);
            verifyCloudflare(proc, found);
        }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (e) => {
        if (cfChild !== proc)
            return;
        cfChild = null;
        clearCfTimers();
        setTunnelState({
            phase: "error",
            mode: null,
            url: null,
            pid: null,
            owned: false,
            detail: `Cloudflare 备用隧道启动失败：${e instanceof Error ? e.message : String(e)}`,
        });
    });
    proc.on("exit", (code, signal) => {
        if (cfChild !== proc)
            return;
        cfChild = null;
        clearCfTimers();
        cfUrl = null;
        if (stopping)
            return;
        if (cfRestarts < MAX_CF_RESTARTS) {
            cfRestarts++;
            setTunnelState({
                phase: "starting",
                mode: "cloudflare",
                url: null,
                pid: null,
                owned: true,
                detail: `Cloudflare 备用隧道退出（${code ?? signal ?? "未知原因"}），3 秒后第 ${cfRestarts} 次重连…`,
            });
            setTimeout(() => startCloudflare(port, "Cloudflare 隧道重连"), 3000);
            return;
        }
        setTunnelState({
            phase: "error",
            mode: null,
            url: null,
            pid: null,
            owned: false,
            detail: `Cloudflare 备用隧道连续退出（${code ?? signal ?? "未知原因"}），已停止重试`,
        });
    });
    // 20 秒还没打印出地址，说明 cloudflared 自己卡住了
    if (cfUrlTimer)
        clearTimeout(cfUrlTimer);
    cfUrlTimer = setTimeout(() => {
        cfUrlTimer = null;
        if (cfChild === proc && !cfUrl) {
            setTunnelState({
                phase: "error",
                mode: "cloudflare",
                url: null,
                pid: proc.pid ?? null,
                owned: true,
                detail: "Cloudflare 备用隧道启动后 20 秒没拿到公网地址，请点「强制重建隧道」重试",
            });
        }
    }, 20000);
    log("已启动 Cloudflare 备用隧道", binary, args.join(" "));
}

function verifyCloudflare(proc, url) {
    const deadline = Date.now() + CF_VERIFY_MS;
    clearCfTimers();
    const tick = async () => {
        cfVerifyTimer = null;
        if (cfChild !== proc)
            return;
        const r = await probePublic(url, 6000);
        if (cfChild !== proc)
            return;
        if (r.ok) {
            cfRestarts = 0;
            markReady(url, proc.pid ?? null, true, "cloudflare");
            return;
        }
        if (Date.now() >= deadline) {
            setTunnelState({
                phase: "error",
                mode: "cloudflare",
                url,
                pid: proc.pid ?? null,
                owned: true,
                detail: `Cloudflare 隧道已建立，但公网入口 ${Math.round(CF_VERIFY_MS / 1000)} 秒内没回源（${r.detail}）`,
            });
            return;
        }
        cfVerifyTimer = setTimeout(tick, 2000);
    };
    cfVerifyTimer = setTimeout(tick, 1500);
}

/**
 * 清掉服务器上残留的 8765 端口占用：换网络后旧 sshd 会一直占着，导致新隧道绑不上。
 * 返回 networkFail=true 表示本机连 SSH 端口都到不了（超时/不可达），调用方应直接走 Cloudflare。
 */
function freeRemotePort() {
    return new Promise((resolve) => {
        const bin = sshBinary();
        const remote = `fuser -k ${REMOTE_PORT}/tcp >/dev/null 2>&1; sleep 0.3; true`;
        const args = [
            "-i", SSH_KEY,
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=5",
            SSH_HOST,
            remote,
        ];
        let done = false;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            if (result.detail)
                log("清理服务器残留端口：", result.detail);
            resolve(result);
        };
        try {
            const p = execFile(bin, args, { windowsHide: true, timeout: 9000 }, (err, _stdout, stderr) => {
                if (!err) {
                    return finish({ ok: true, networkFail: false, detail: `已释放 ${REMOTE_PORT}` });
                }
                const text = String(stderr || err.message || "");
                const networkFail = /timed out|timeout|unreachable|no route|connection refused|connect failed/i.test(text);
                finish({ ok: false, networkFail, detail: `失败（忽略）${text.trim().slice(0, 160)}` });
            });
            p.on?.("error", (e) => finish({ ok: false, networkFail: true, detail: `失败（忽略）${e.message}` }));
        }
        catch (e) {
            finish({ ok: false, networkFail: true, detail: `失败（忽略）${e instanceof Error ? e.message : String(e)}` });
        }
    });
}

/** 建立隧道：先 SSH，连端口都到不了就直接用 Cloudflare */
async function connect(port, opts = {}) {
    if (stopping)
        return;
    if (!opts.skipFree) {
        const freed = await freeRemotePort();
        if (stopping)
            return;
        if (freed.networkFail) {
            startCloudflare(port, "SSH 端口不可达");
            return;
        }
    }
    spawnChild(port);
}

/** 应用启动时调用一次；不阻塞 UI，就绪后由面板轮询取走 */
async function start(next) {
    if (next)
        options = { ...options, ...next };
    stopping = false;
    if (!options.getConfig) {
        setTunnelState({ phase: "error", mode: null, url: null, pid: null, owned: false, detail: "隧道管理器缺少配置来源，未启动" });
        return;
    }
    const cfg = options.getConfig() || {};
    if (cfg.autoTunnel === false) {
        setTunnelState({
            phase: "disabled",
            mode: null,
            url: null,
            pid: null,
            owned: false,
            detail: "设置里关闭了「启动时自动开公网隧道」，本次没有启动 ssh 反向隧道",
        });
        log("设置已关闭自动隧道，跳过启动");
        return;
    }
    if (child || cfChild)
        return;
    const port = Number(cfg.port) || options.port || 8765;
    setTunnelState({ phase: "starting", mode: null, url: null, pid: null, owned: false, detail: "正在检查本机是否已有同款 SSH 反向隧道…" });

    const running = await listSsh();
    const external = running.filter((row) => isOurTunnel(row.cmd) && (!child || row.pid !== child.pid));
    if (external.length) {
        setTunnelState({
            phase: "starting",
            mode: "ssh",
            url: null,
            pid: external[0].pid,
            owned: false,
            detail: `发现已在运行的外部 SSH 隧道（进程号 ${external[0].pid}），正在验证公网入口…`,
        });
        const probe = await probePublic(PUBLIC_URL, 6000);
        if (probe.ok) {
            markReady(PUBLIC_URL, external[0].pid, false, "ssh");
            return;
        }
        log("外部 SSH 隧道未回源：", probe.detail);
    }
    await connect(port, { skipFree: external.length > 0 });
}

/** 只重建本应用自己拉起的隧道：结束自己的子进程后重连，不动别人的 ssh */
async function restartOwn(port) {
    await stop();
    stopping = false;
    const p = Number(port) || options.port || 8765;
    await connect(p);
    log("已重建本应用自己的隧道，端口", p);
}

/** 强制重建：结束所有匹配的旧隧道进程（含别的实例留下的），再拉一条新的（会短暂中断公网入口） */
async function rebuild(port) {
    const running = await listSsh();
    const olds = running.filter((r) => isOurTunnel(r.cmd));
    for (const row of olds) {
        try {
            process.kill(row.pid, "SIGTERM");
            log("已结束旧隧道进程", row.pid);
        }
        catch (e) {
            log("结束旧隧道进程失败", row.pid, e && e.message);
        }
    }
    await new Promise((r) => setTimeout(r, 800));
    await stop();
    stopping = false;
    const p = Number(port) || options.port || 8765;
    await connect(p);
    log("强制重建隧道完成，端口", p);
}

/** 设置变更时调用：开关、MCP 端口变化都据此调整 */
async function applyConfig(cfg) {
    if (!cfg)
        return;
    if (cfg.autoTunnel === false) {
        if (child || cfChild)
            await stop();
        else
            setTunnelState({ phase: "disabled", mode: null, url: null, pid: null, owned: false, detail: "设置里关闭了「启动时自动开公网隧道」" });
        return;
    }
    const port = Number(cfg.port) || options.port || 8765;
    if ((child || cfChild) && port !== spawnPort) {
        log("MCP 端口变化，重建隧道", spawnPort, "->", port);
        await stop();
        stopping = false;
        options = { ...options, port };
        await start({ port });
        return;
    }
    if (!child && !cfChild && (getTunnelState().phase === "disabled" || getTunnelState().phase === "stopped")) {
        await start({ port });
    }
}

async function stop() {
    stopping = true;
    const proc = child;
    child = null;
    const cf = cfChild;
    cfChild = null;
    clearVerify();
    clearCfTimers();
    if (proc && proc.pid) {
        await killTree(proc.pid);
        log("已收掉自己起的 ssh 反向隧道", proc.pid);
    }
    if (cf && cf.pid) {
        await killTree(cf.pid);
        log("已收掉自己起的 Cloudflare 备用隧道", cf.pid);
    }
    mode = null;
    cfRestarts = 0;
    setTunnelState({ phase: "stopped", mode: null, url: null, pid: null, owned: false, detail: "隧道已随应用退出" });
}

/** 退出路径上的兜底：同步收进程，只动自己 spawn 的子进程 */
function stopSync() {
    stopping = true;
    const proc = child;
    child = null;
    const cf = cfChild;
    cfChild = null;
    clearVerify();
    clearCfTimers();
    if (proc && proc.pid) {
        (0, platform_1.killTreeSync)(proc.pid);
        try {
            proc.kill();
        }
        catch {
            // 进程可能已经没了
        }
        log("退出时同步收掉 ssh 反向隧道", proc.pid);
    }
    if (cf && cf.pid) {
        (0, platform_1.killTreeSync)(cf.pid);
        try {
            cf.kill();
        }
        catch {
            // 进程可能已经没了
        }
        log("退出时同步收掉 Cloudflare 备用隧道", cf.pid);
    }
    mode = null;
    setTunnelState({ phase: "stopped", mode: null, url: null, pid: null, owned: false, detail: "隧道已随应用退出" });
}

async function restart() {
    await stop();
    stopping = false;
    await start();
}

function status() {
    return {
        ...getTunnelState(),
        mode,
        fallback: mode === "cloudflare",
        binary: sshBinary(),
        cloudflared: cloudflaredBinary(),
        key: SSH_KEY,
        publicUrl: PUBLIC_URL,
        remotePort: REMOTE_PORT,
        port: spawnPort || options.port || 8765,
    };
}

/** 服务器入口不可达时：经 SSH 检查服务器 Caddy，只在未运行时才拉起（运行中不动） */
function remoteCaddyRepair() {
    return new Promise((resolve) => {
        const args = ["-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
            "-o", "StrictHostKeyChecking=accept-new", SSH_HOST,
            "systemctl is-active --quiet caddy || systemctl restart caddy; sleep 1; systemctl is-active caddy"];
        execFile(sshBinary(), args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
            const last = String(stdout || "").trim().split(/\r?\n/).pop();
            if (last === "active") {
                return resolve({ ok: true, detail: "服务器 Caddy 运行中（已确认，未重启）" });
            }
            if (err) {
                return resolve({ ok: false, detail: "SSH 检查服务器失败：" + String(stderr || err.message).trim().slice(0, 200) });
            }
            resolve({ ok: false, detail: "服务器 Caddy 未能启动，状态：" + last });
        });
    });
}

module.exports = {
    start,
    stop,
    stopSync,
    restart,
    restartOwn,
    rebuild,
    applyConfig,
    status,
    binaryPath: sshBinary,
    cloudflaredPath: cloudflaredBinary,
    PUBLIC_URL,
    remoteCaddyRepair,
    _test: { parseQuickTunnelUrl, probePublic, isOurTunnel, cloudflaredBinary },
};
