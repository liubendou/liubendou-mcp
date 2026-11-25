// Build a native Windows installer (Setup.exe) for LiuBenDou MCP v2.
// No 7z / NSIS / Inno / electron-builder on this box -> use .NET csc.exe.
// Payload is embedded as manifest resources (one per file) so the installer
// needs no external archiver and no admin rights.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = 'C:\\Users\\Administrator\\Desktop\\\u516d\u672c\u8c46mcp-v2';
const DIST = path.join(ROOT, 'dist-portable');
const OUTDIR = path.join(ROOT, 'installer');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

const SKIP_DIR = '\u672c\u5730AI\u9065\u63a7\u53f0'; // redundant nested old copy (281 MB)

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === SKIP_DIR) continue;
      walk(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, out);
    } else if (e.isFile()) {
      out.push(rel ? rel + '/' + e.name : e.name);
    }
  }
  return out;
}

function esc(s) {
  let o = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 128) o += ch;
    else for (const u of ch) o += '\\u' + u.charCodeAt(0).toString(16).padStart(4, '0');
  }
  return o;
}

const files = walk(DIST, '', []).sort();
console.log('payload files: ' + files.length);
let total = 0;
for (const f of files) {
  const sz = fs.statSync(path.join(DIST, f)).size;
  total += sz;
  console.log('  ' + f + '  ' + sz);
}
console.log('payload bytes: ' + total);

fs.mkdirSync(OUTDIR, { recursive: true });

const csPath = path.join(OUTDIR, 'Installer.cs');
const fileList = files.map(f => '        "' + esc(f) + '",').join('\n');

const cs = `// LiuBenDou MCP v2 - self contained Windows installer (generated)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace LiuBenDou
{
    static class Program
    {
        public const string APP = "\\u516d\\u672c\\u8c46mcp-v2";
        public const string VER = "0.3.2";
        static string[] FILES = new string[]
        {
${fileList}
        };

        [STAThread]
        static void Main(string[] args)
        {
            bool silent = false, uninstall = false, launch = false;
            foreach (string a in args)
            {
                if (a == "--silent") silent = true;
                else if (a == "uninstall") uninstall = true;
                else if (a == "--launch") launch = true;
            }
            string me = Path.GetFileName(Assembly.GetExecutingAssembly().Location);
            bool isUninstaller = string.Equals(me, "Uninstall.exe", StringComparison.OrdinalIgnoreCase);
            if (uninstall || isUninstaller) { Uninstall(); return; }
            if (silent)
            {
                try { Install(null); Console.WriteLine("INSTALL_OK " + InstallDir); }
                catch (Exception e) { Console.WriteLine("INSTALL_FAIL " + e.Message); Environment.Exit(1); }
                if (launch) TryLaunch();
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Form1());
        }

        public static string InstallDir
        {
            get
            {
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", APP);
            }
        }

        static string ResName(int i) { return "P" + i.ToString("D4"); }

        static void CopyRes(string res, string outPath)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(outPath));
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(res))
            {
                if (s == null) throw new Exception("missing resource " + res);
                using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
                {
                    s.CopyTo(fs);
                }
            }
        }

        public static void Install(Action<string> log)
        {
            string dir = InstallDir;
            Directory.CreateDirectory(dir);
            for (int i = 0; i < FILES.Length; i++)
            {
                string rel = FILES[i].Replace('/', Path.DirectorySeparatorChar);
                string outPath = Path.Combine(dir, rel);
                CopyRes(ResName(i), outPath);
                if (log != null) log(rel);
            }
            CopyRes("UNINSTALLER", Path.Combine(dir, "Uninstall.exe"));

            string exe = Path.Combine(dir, APP + ".exe");
            if (!File.Exists(exe)) throw new Exception("payload exe missing");

            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP + ".lnk"), exe, dir);
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP);
            Directory.CreateDirectory(menu);
            Shortcut(Path.Combine(menu, APP + ".lnk"), exe, dir);
            Shortcut(Path.Combine(menu, "\\u5378\\u8f7d " + APP + ".lnk"), Path.Combine(dir, "Uninstall.exe"), dir);

            using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(
                "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\LiuBenDouMcpV2"))
            {
                k.SetValue("DisplayName", APP);
                k.SetValue("DisplayVersion", VER);
                k.SetValue("Publisher", "LocalAIConsole");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\\"" + Path.Combine(dir, "Uninstall.exe") + "\\"");
                k.SetValue("QuietUninstallString", "\\"" + Path.Combine(dir, "Uninstall.exe") + "\\"");
                k.SetValue("DisplayIcon", exe);
                k.SetValue("NoModify", 1);
                k.SetValue("NoRepair", 1);
            }
        }

        static void Shortcut(string lnkPath, string target, string workdir)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) return;
            object sh = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnkPath });
            t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workdir });
            t.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { APP + " " + VER });
            t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
            t.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }

        public static void Uninstall()
        {
            string dir = InstallDir;
            try
            {
                string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP);
                if (Directory.Exists(menu)) Directory.Delete(menu, true);
            }
            catch { }
            try
            {
                string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP + ".lnk");
                if (File.Exists(lnk)) File.Delete(lnk);
            }
            catch { }
            try
            {
                Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(
                    "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\LiuBenDouMcpV2", false);
            }
            catch { }
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                }
            }
            catch { }
            // self delete (file may be locked while running)
            try
            {
                string self = Process.GetCurrentProcess().MainModule.FileName;
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \\"" + dir + "\\"") { CreateNoWindow = true });
                Thread.Sleep(400);
            }
            catch { }
        }

        public static void TryLaunch()
        {
            try
            {
                string exe = Path.Combine(InstallDir, APP + ".exe");
                if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = InstallDir });
            }
            catch { }
        }
    }

    class Form1 : Form
    {
        TextBox log; ProgressBar bar; Button btnInstall, btnOpen, btnUninstall; Label pathLbl, title;
        public Form1()
        {
            Text = Program.APP;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            ClientSize = new Size(470, 320);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F);

            title = new Label();
            title.Text = Program.APP + "  " + Program.VER;
            title.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
            title.AutoSize = true; title.Location = new Point(24, 22);
            Controls.Add(title);

            Label sub = new Label();
            sub.Text = "\\u684c\\u9762\\u5ba2\\u6237\\u7aef \\u00b7 \\u5b89\\u88c5\\u5230\\u5f53\\u524d\\u7528\\u6237\\u76ee\\u5f55\\uff0c\\u65e0\\u9700\\u7ba1\\u7406\\u5458\\u6743\\u9650";
            sub.AutoSize = true; sub.Location = new Point(24, 58);
            sub.ForeColor = Color.FromArgb(90, 90, 98);
            Controls.Add(sub);

            pathLbl = new Label();
            pathLbl.Text = "\\u5b89\\u88c5\\u76ee\\u5f55\\uff1a" + Program.InstallDir;
            pathLbl.AutoSize = false; pathLbl.Size = new Size(422, 34);
            pathLbl.Location = new Point(24, 84);
            pathLbl.ForeColor = Color.FromArgb(30, 30, 36);
            Controls.Add(pathLbl);

            bar = new ProgressBar();
            bar.Location = new Point(24, 122); bar.Size = new Size(422, 16);
            bar.Style = ProgressBarStyle.Continuous;
            Controls.Add(bar);

            log = new TextBox();
            log.Location = new Point(24, 148); log.Size = new Size(422, 108);
            log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical;
            log.BackColor = Color.White; log.BorderStyle = BorderStyle.FixedSingle;
            log.Font = new Font("Consolas", 9F);
            Controls.Add(log);

            btnInstall = new Button();
            btnInstall.Text = "\\u5f00\\u59cb\\u5b89\\u88c5"; btnInstall.Size = new Size(132, 34);
            btnInstall.Location = new Point(24, 266);
            btnInstall.Click += delegate { DoInstall(); };
            Controls.Add(btnInstall);

            btnOpen = new Button();
            btnOpen.Text = "\\u6253\\u5f00\\u7a0b\\u5e8f"; btnOpen.Size = new Size(132, 34);
            btnOpen.Location = new Point(164, 266);
            btnOpen.Click += delegate { Program.TryLaunch(); };
            Controls.Add(btnOpen);

            btnUninstall = new Button();
            btnUninstall.Text = "\\u5378\\u8f7d"; btnUninstall.Size = new Size(132, 34);
            btnUninstall.Location = new Point(304, 266);
            btnUninstall.Click += delegate { Program.Uninstall(); Application.Exit(); };
            Controls.Add(btnUninstall);
        }

        void DoInstall()
        {
            btnInstall.Enabled = false;
            bar.Style = ProgressBarStyle.Marquee;
            Application.DoEvents();
            try
            {
                Program.Install(delegate(string s) { log.AppendText(s + "\\r\\n"); Application.DoEvents(); });
                log.AppendText("\\u5b89\\u88c5\\u5b8c\\u6210\\uff1a" + Program.InstallDir + "\\r\\n");
                log.AppendText("\\u684c\\u9762\\u5feb\\u6377\\u65b9\\u5f0f\\u548c\\u5f00\\u59cb\\u83dc\\u5355\\u5feb\\u6377\\u65b9\\u5f0f\\u5df2\\u521b\\u5efa\\u3002\\r\\n");
                bar.Style = ProgressBarStyle.Continuous; bar.Value = 100;
                btnInstall.Enabled = true; btnInstall.Text = "\\u91cd\\u65b0\\u5b89\\u88c5";
                MessageBox.Show("\\u5b89\\u88c5\\u5b8c\\u6210\\uff01\\r\\n\\r\\n\\u76ee\\u5f55\\uff1a" + Program.InstallDir, Program.APP, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception e)
            {
                bar.Style = ProgressBarStyle.Continuous;
                btnInstall.Enabled = true;
                MessageBox.Show("\\u5b89\\u88c5\\u5931\\u8d25\\uff1a" + e.Message, Program.APP, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
`;
fs.writeFileSync(csPath, cs, 'utf8');
console.log('wrote ' + csPath + ' (' + cs.length + ' bytes)');

function csc(args) {
    console.log('csc ' + args.join(' ').slice(0, 300));
    const r = cp.spawnSync(CSC, args, { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stdout.write(r.stderr);
    if (r.status !== 0) { console.log('CSC_FAILED status=' + r.status); process.exit(2); }
}

const ICON_ARG = '/win32icon:' + path.join(ROOT, 'src', 'assets', 'icon.ico');

// 1) uninstaller (no payload)
csc(['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', ICON_ARG,
    '/out:' + path.join(OUTDIR, 'Uninstall.exe'),
    '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    csPath]);

// 2) setup.exe (payload + uninstaller)
const resArgs = [];
for (let i = 0; i < files.length; i++) {
    resArgs.push('/resource:' + path.join(DIST, files[i].replace(/\//g, '\\')) + ',P' + String(i).padStart(4, '0'));
}
resArgs.push('/resource:' + path.join(OUTDIR, 'Uninstall.exe') + ',UNINSTALLER');
csc(['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', ICON_ARG,
    '/out:' + path.join(OUTDIR, 'Setup.exe'),
    '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    csPath].concat(resArgs));

for (const f of ['Setup.exe', 'Uninstall.exe']) {
    const p = path.join(OUTDIR, f);
    console.log(f + ' = ' + fs.statSync(p).size + ' bytes');
}
console.log('BUILD_OK');
