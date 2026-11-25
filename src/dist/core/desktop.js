"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireWindows = requireWindows;
exports.screenshot = screenshot;
exports.nativeAction = nativeAction;
exports.envInfo = envInfo;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const commands_1 = require("./commands");
const security_1 = require("./security");
const devtools_1 = require("./devtools");
const node_child_process_1 = __importDefault(require("node:child_process"));
const platform_1 = require("./platform");
// 注意：脚本使用 String.raw，保留反斜杠；脚本中不要出现反引号或 ${
const SCREENSHOT_PS1 = String.raw `param([string]$Out, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class LacDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[LacDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($W -le 0) { $W = $b.Width }
if ($H -le 0) { $H = $b.Height }
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("OK " + $W + "x" + $H)
`;
const NATIVE_PS1 = String.raw `param([string]$Action, [int]$X = 0, [int]$Y = 0, [string]$Button = 'left', [string]$InputFile = '')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LacNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
[LacNative]::SetProcessDPIAware() | Out-Null
switch ($Action) {
  'click' {
    [LacNative]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 80
    if ($Button -eq 'right') { $down = [uint32]8; $up = [uint32]16 } else { $down = [uint32]2; $up = [uint32]4 }
    [LacNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [LacNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    Write-Output ("OK click " + $X + "," + $Y)
  }
  'focus' {
    $t = (Get-Content -Raw -Encoding UTF8 $InputFile).Trim()
    [Microsoft.VisualBasic.Interaction]::AppActivate($t)
    Write-Output "OK focus"
  }
  'type' {
    $t = Get-Content -Raw -Encoding UTF8 $InputFile
    $esc = [regex]::Replace($t, '([\+\^\%\~\(\)\{\}\[\]])', '{$1}')
    [System.Windows.Forms.SendKeys]::SendWait($esc)
    Write-Output "OK type"
  }
  'key' {
    $k = (Get-Content -Raw -Encoding UTF8 $InputFile).Trim()
    [System.Windows.Forms.SendKeys]::SendWait($k)
    Write-Output "OK key"
  }
  'windows' {
    Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
      Write-Output ($_.Id.ToString() + ' | ' + $_.ProcessName + ' | ' + $_.MainWindowTitle)
    }
  }
}
`;
const IS_WIN = process.platform === 'win32';
function scriptsDir(dataDir) {
    const d = node_path_1.default.join(dataDir, 'scripts');
    node_fs_1.default.mkdirSync(d, { recursive: true });
    return d;
}
function writeScripts(dataDir) {
    const d = scriptsDir(dataDir);
    const screenshot = node_path_1.default.join(d, 'screenshot.ps1');
    const native = node_path_1.default.join(d, 'native.ps1');
    node_fs_1.default.writeFileSync(screenshot, SCREENSHOT_PS1, 'utf8');
    node_fs_1.default.writeFileSync(native, NATIVE_PS1, 'utf8');
    return { screenshot, native };
}
function requireWindows() {
    if (!IS_WIN)
        throw new security_1.ToolError('桌面操作目前仅支持 Windows');
}
/** 在 PATH 里找可执行文件（Linux 分支用） */
function hasBin(name) {
    const dirs = String(process.env.PATH || '').split(node_path_1.default.delimiter);
    for (const d of dirs) {
        try {
            if (d && node_fs_1.default.existsSync(node_path_1.default.join(d, name)))
                return true;
        }
        catch { }
    }
    return false;
}
function runBin(bin, args, timeoutMs = 20000) {
    const r = node_child_process_1.default.spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs });
    if (r.error)
        throw new security_1.ToolError(`执行 ${bin} 失败：${r.error.message}`);
    if (r.status !== 0)
        throw new security_1.ToolError(`执行 ${bin} 失败（退出码 ${r.status}）：${String(r.stderr || r.stdout || '').trim().slice(-400)}`);
    return String(r.stdout || '').trim();
}
/** Linux 截图：scrot → ImageMagick import → gnome-screenshot */
function linuxScreenshot(dataDir, region) {
    const outDir = node_path_1.default.join(dataDir, 'screenshots');
    node_fs_1.default.mkdirSync(outDir, { recursive: true });
    const file = node_path_1.default.join(outDir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}-${node_crypto_1.default.randomBytes(2).toString('hex')}.png`);
    const x = Math.trunc(region.x ?? 0), y = Math.trunc(region.y ?? 0);
    const w = Math.trunc(region.w ?? 0), h = Math.trunc(region.h ?? 0);
    if (hasBin('scrot')) {
        const args = (w > 0 && h > 0) ? ['-a', `${x},${y},${w},${h}`, '-o', file] : ['-o', file];
        runBin('scrot', args);
        return { file, info: `OK (scrot) ${file}` };
    }
    if (hasBin('import')) {
        const args = ['-window', 'root'];
        if (w > 0 && h > 0)
            args.push('-crop', `${w}x${h}+${x}+${y}`, '+repage');
        args.push(file);
        runBin('import', args, 30000);
        return { file, info: `OK (imagemagick) ${file}` };
    }
    if (hasBin('gnome-screenshot')) {
        runBin('gnome-screenshot', ['-f', file], 30000);
        return { file, info: `OK (gnome-screenshot) ${file}` };
    }
    throw new security_1.ToolError('Linux 下截图需要安装 scrot / imagemagick / gnome-screenshot 之一：sudo apt install scrot imagemagick');
}
/** Linux 下的窗口/键鼠操作：xdotool（可选 wmctrl 列窗口） */
function linuxNativeAction(action, opts = {}) {
    if (action === 'windows') {
        if (hasBin('wmctrl'))
            return runBin('wmctrl', ['-l']);
        if (hasBin('xdotool'))
            return runBin('xdotool', ['search', '--name', '.*', 'getwindowname', '%@']);
        throw new security_1.ToolError('列出窗口需要安装 wmctrl 或 xdotool：sudo apt install wmctrl xdotool');
    }
    if (!hasBin('xdotool'))
        throw new security_1.ToolError('Linux 下窗口/键鼠操作需要 xdotool：sudo apt install xdotool');
    if (action === 'focus') {
        const title = String(opts.text ?? '').trim();
        if (!title)
            throw new security_1.ToolError('focus 需要标题');
        runBin('xdotool', ['search', '--name', title, 'windowactivate', '--sync']);
        return `OK focus ${title}`;
    }
    if (action === 'click') {
        runBin('xdotool', ['mousemove', String(Math.trunc(opts.x ?? 0)), String(Math.trunc(opts.y ?? 0)), 'click', opts.button === 'right' ? '3' : '1']);
        return `OK click ${Math.trunc(opts.x ?? 0)},${Math.trunc(opts.y ?? 0)}`;
    }
    if (action === 'type') {
        const text = String(opts.text ?? '');
        runBin('xdotool', ['type', '--clearmodifiers', '--', text]);
        return 'OK type';
    }
    if (action === 'key') {
        runBin('xdotool', ['key', '--clearmodifiers', String(opts.text ?? '').trim()]);
        return 'OK key';
    }
    throw new security_1.ToolError(`不支持的桌面动作：${action}`);
}
async function ps(cmds, script, args, timeoutMs = 60000) {
    const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${(0, devtools_1.shellQuote)(script)} ` +
        args.map((a) => (0, devtools_1.shellQuote)(a)).join(' ');
    const job = await cmds.runForeground(cmd, node_path_1.default.dirname(script), timeoutMs);
    const out = (0, commands_1.readOutput)(job).text.trim();
    if (job.exitCode !== 0)
        throw new security_1.ToolError(`PowerShell 执行失败（退出码 ${job.exitCode}）：\n${out.slice(-2000)}`);
    return out;
}
/** 截取屏幕（或区域），返回 PNG 文件路径 */
async function screenshot(cmds, dataDir, region) {
    if (!IS_WIN) {
        return linuxScreenshot(dataDir, region || {});
    }
    requireWindows();
    const { screenshot: script } = writeScripts(dataDir);
    const outDir = node_path_1.default.join(dataDir, 'screenshots');
    node_fs_1.default.mkdirSync(outDir, { recursive: true });
    const file = node_path_1.default.join(outDir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}-${node_crypto_1.default.randomBytes(2).toString('hex')}.png`);
    const info = await ps(cmds, script, [
        file,
        String(Math.trunc(region.x ?? 0)),
        String(Math.trunc(region.y ?? 0)),
        String(Math.trunc(region.w ?? 0)),
        String(Math.trunc(region.h ?? 0)),
    ]);
    return { file, info };
}
/** 调用 native.ps1；需要传文本时写入临时文件，避免命令行转义问题 */
async function nativeAction(cmds, dataDir, action, opts = {}) {
    if (!IS_WIN) {
        return linuxNativeAction(action, opts);
    }
    requireWindows();
    const { native } = writeScripts(dataDir);
    let inputFile = '';
    if (action === 'focus' || action === 'type' || action === 'key') {
        const d = scriptsDir(dataDir);
        inputFile = node_path_1.default.join(d, `input-${node_crypto_1.default.randomBytes(4).toString('hex')}.txt`);
        node_fs_1.default.writeFileSync(inputFile, opts.text ?? '', 'utf8');
    }
    try {
        const args = [action, String(Math.trunc(opts.x ?? 0)), String(Math.trunc(opts.y ?? 0)), opts.button ?? 'left', inputFile];
        return await ps(cmds, native, args, 30000);
    }
    finally {
        if (inputFile)
            node_fs_1.default.rmSync(inputFile, { force: true });
    }
}
/** 环境检查：常用工具是否可用及版本 */
async function envInfo(cmds, cwd) {
    const tools = [
        ['node', '--version'],
        ['npm', '--version'],
        ['git', '--version'],
        ['python', '--version'],
        ['python3', '--version'],
        ['dotnet', '--version'],
        ['java', '-version'],
        ['go', 'version'],
        ['rustc', '--version'],
        ['cargo', '--version'],
    ];
    const results = await Promise.all(tools.map(async ([cmd, arg]) => {
        const job = await cmds.runForeground(`${cmd} ${arg}`, cwd, 10000);
        const first = (0, commands_1.readOutput)(job).text.trim().split(/\r?\n/)[0] ?? '';
        return `${cmd.padEnd(10)} ${job.exitCode === 0 ? first : '未安装或不可用'}`;
    }));
    const sys = [
        `系统：${node_os_1.default.type()} ${node_os_1.default.release()} (${node_os_1.default.arch()})`,
        `内存：${(node_os_1.default.totalmem() / 1073741824).toFixed(1)} GB 总量，${(node_os_1.default.freemem() / 1073741824).toFixed(1)} GB 可用`,
        `CPU：${node_os_1.default.cpus()[0]?.model ?? '未知'} × ${node_os_1.default.cpus().length}`,
    ];
    return [...sys, '', ...results].join('\n');
}
