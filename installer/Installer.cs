using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;
using Microsoft.Win32;

// 安装器只安装本项目与 Node；QQ 协议端由用户自行下载并选择目录。
internal static class Installer
{
#if TB_EDITION
    private const string Edition = "tb";
    private const string DisplayName = "领航员终端";
    private const string ProgramDirectory = "NavigatorTerminal";
    private const string LauncherName = "领航员终端.exe";
#else
    private const string Edition = "generic";
    private const string DisplayName = "心语";
    private const string ProgramDirectory = "HeartEcho";
    private const string LauncherName = "心语.exe";
#endif

    private static string Local { get { return Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    private static string Roaming { get { return Environment.GetEnvironmentVariable("APPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
    private static string DefaultDestination { get { return Path.Combine(Local, "Programs", ProgramDirectory); } }
    private static string DefaultData { get { return Edition == "tb" ? Path.Combine(Local, "心语TB", "data") : Path.Combine(Local, "心语"); } }
    private static string UninstallKey { get { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + ProgramDirectory; } }

    private static string Option(string[] args, string prefix)
    {
        foreach (string arg in args) if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return arg.Substring(prefix.Length);
        return "";
    }
    private static bool Has(string[] args, string flag) { return Array.Exists(args, item => String.Equals(item, flag, StringComparison.OrdinalIgnoreCase)); }

    private static void Shortcut(string file, string target, string arguments)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new IOException("无法创建 Windows 快捷方式");
        dynamic shell = Activator.CreateInstance(shellType);
        dynamic link = shell.CreateShortcut(file);
        if (File.Exists(file) && !String.Equals(Path.GetFullPath(Convert.ToString(link.TargetPath)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
            throw new IOException("快捷方式已指向其他程序，请先处理：" + file);
        link.TargetPath = target;
        link.Arguments = arguments;
        link.WorkingDirectory = Path.GetDirectoryName(target);
        link.Description = DisplayName;
        link.Save();
    }

    private static void RemoveOwnedShortcut(string file, string target)
    {
        if (!File.Exists(file)) return;
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new IOException("无法检查现有开机快捷方式");
        dynamic shell = Activator.CreateInstance(shellType);
        dynamic link = shell.CreateShortcut(file);
        if (String.Equals(Path.GetFullPath(Convert.ToString(link.TargetPath)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Delete(file);
    }

    private static string ReadLicenses()
    {
        var content = new System.Text.StringBuilder();
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("heartecho.payload"))
        {
            if (input == null) throw new IOException("安装包缺少许可文件");
            using (var zip = new ZipArchive(input, ZipArchiveMode.Read))
            {
                foreach (string name in new[] { "app/LICENSE", "runtime/Node-LICENSE.txt", "app/EXTENSIONS.md", "app/EXTENSION-AUTHORS.txt", "app/NOTICE" })
                {
                    // .NET Framework 的 CreateFromDirectory 在 Windows 可能写入反斜杠。
                    ZipArchiveEntry entry = zip.GetEntry(name) ?? zip.GetEntry(name.Replace('/', '\\'));
                    if (entry == null) throw new IOException("安装包缺少许可或来源说明：" + name);
                    using (var reader = new StreamReader(entry.Open())) content.AppendLine("===== " + name + " =====").AppendLine(reader.ReadToEnd()).AppendLine();
                }
            }
        }
        return content.ToString();
    }

    private static void ShowLicenses(IWin32Window owner)
    {
        using (var view = new Form { Text = "许可与来源", Width = 850, Height = 650, StartPosition = FormStartPosition.CenterParent })
        {
            view.Controls.Add(new TextBox { Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Both, WordWrap = false, ReadOnly = true, Text = ReadLicenses() });
            view.ShowDialog(owner);
        }
    }

    private static string ReadDataDir(string target)
    {
        string settings = Edition == "tb" ? Path.Combine(Local, "心语TB", "心语TB设置.json") : Path.Combine(target, "心语设置.json");
        string data = InstallCore.SettingsDataDir(settings);
        if (data.Length == 0) return DefaultData;
        return Path.IsPathRooted(data) ? Path.GetFullPath(data) : Path.GetFullPath(Path.Combine(target, data));
    }

    private static string ReadInstancesHome(string target)
    {
        string settings = Edition == "tb" ? Path.Combine(Local, "心语TB", "心语TB设置.json") : Path.Combine(target, "心语设置.json");
        string home = Environment.GetEnvironmentVariable("HEARTECHO_INSTANCES_HOME");
        if (String.IsNullOrWhiteSpace(home)) home = InstallCore.SettingsString(settings, "instancesHome");
        if (String.IsNullOrWhiteSpace(home)) return target;
        return Path.GetFullPath(Path.IsPathRooted(home) ? home : Path.Combine(target, home));
    }

    private static string EmbeddedManifest()
    {
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("heartecho.payload"))
        {
            if (input == null) throw new IOException("卸载程序缺少文件清单");
            using (var zip = new ZipArchive(input, ZipArchiveMode.Read))
            {
                var entry = zip.GetEntry("SHA256SUMS.txt");
                if (entry == null) throw new IOException("卸载程序缺少文件清单");
                using (var reader = new StreamReader(entry.Open())) return reader.ReadToEnd();
            }
        }
    }

    private static bool SameFile(string a, string b)
    {
        using (SHA256 hash = SHA256.Create())
        using (FileStream one = File.OpenRead(a))
        using (FileStream two = File.OpenRead(b))
            return Convert.ToBase64String(hash.ComputeHash(one)) == Convert.ToBase64String(hash.ComputeHash(two));
    }

    private static void CheckRegistration(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, false))
        {
            string previous = key == null ? "" : Convert.ToString(key.GetValue("InstallLocation", ""));
            if (previous.Length > 0 && !String.Equals(Path.GetFullPath(previous), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
                throw new IOException("此版本已经登记在其他安装目录，请先处理已有安装。");
        }
    }

    private static void Register(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", DisplayName);
            key.SetValue("InstallLocation", target);
            key.SetValue("DisplayIcon", Path.Combine(target, LauncherName));
            key.SetValue("Publisher", "HeartEcho contributors");
            key.SetValue("UninstallString", "\"" + Path.Combine(target, "卸载.exe") + "\" --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    private static void RemoveRegistration(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, false))
        {
            string previous = key == null ? "" : Convert.ToString(key.GetValue("InstallLocation", ""));
            if (previous.Length == 0 || !String.Equals(Path.GetFullPath(previous), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) return;
        }
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
    }

    private static void Install(string target, bool desktop, bool startMenu, bool autostart, bool launch, bool register, string importSource)
    {
        using (OperationLock.Acquire(target))
        {
            if (register) CheckRegistration(target);
            string dataDir = ReadDataDir(target);
            using (OperationLock.Acquire(dataDir))
            using (Migration.Prepared pending = String.IsNullOrWhiteSpace(importSource) ? null : Migration.Prepare(importSource, dataDir))
                InstallPrepared(target, desktop, startMenu, autostart, launch, register, dataDir, pending);
        }
    }

    private static void InstallPrepared(string target, bool desktop, bool startMenu, bool autostart, bool launch, bool register, string dataDir, Migration.Prepared pending)
    {
        string archive = Path.GetTempFileName();
        try
        {
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("heartecho.payload"))
            {
                if (input == null) throw new IOException("安装包缺少程序文件");
                using (FileStream output = new FileStream(archive, FileMode.Truncate, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            }
            InstallCore.Install(archive, target, Edition, dataDir, null, Assembly.GetExecutingAssembly().Location, ReadInstancesHome(target));
        }
        finally { File.Delete(archive); }
        if (pending != null)
        {
            try { pending.Commit(); }
            catch (Exception error) { throw new IOException("程序文件已安装，但旧数据导入失败；原数据未删除。请检查后重试：" + error.Message, error); }
        }
        string launcher = Path.Combine(target, LauncherName);
        string menu = Path.Combine(Roaming, "Microsoft", "Windows", "Start Menu", "Programs");
        if (desktop) Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DisplayName + ".lnk"), launcher, "");
        if (startMenu) Shortcut(Path.Combine(menu, DisplayName + ".lnk"), launcher, "");
        string startup = Path.Combine(menu, "Startup", Edition == "tb" ? "领航员终端.lnk" : "心语机器人.lnk");
        if (autostart) Shortcut(startup, launcher, "--tray");
        else RemoveOwnedShortcut(startup, launcher);
        if (register) Register(target);
        if (launch) Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = target });
    }

    private static string DataRemovalRoot(string target)
    {
        string actual = Path.GetFullPath(ReadDataDir(target)).TrimEnd(Path.DirectorySeparatorChar);
        Migration.EnsureNotRunning(actual);
        string expected = Path.GetFullPath(DefaultData).TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            throw new IOException("使用了自定义数据目录，卸载器不会自动删除；请自行检查：" + actual);
        string root = Edition == "tb" ? Path.GetDirectoryName(expected) : expected;
        PathGuard.RejectReparseAncestors(root);
        if (String.IsNullOrEmpty(root) || !String.Equals(Path.GetDirectoryName(root), Path.GetFullPath(Local).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new IOException("默认数据目录不符合预期，不能自动删除");
        string install = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        if (String.Equals(root, install, StringComparison.OrdinalIgnoreCase) || install.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || root.StartsWith(install + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException("数据目录与安装目录重叠，不能自动删除；请手动备份并检查");
        if (Directory.Exists(root)) CheckDataTree(root);
        return root;
    }

    private static void CheckDataTree(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("数据目录包含链接或重解析点，不能自动删除：" + directory);
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("数据目录包含链接或重解析点，不能自动删除：" + entry);
            if ((attributes & FileAttributes.Directory) != 0) CheckDataTree(entry);
        }
    }

    private static void Uninstall(string target, bool register, bool deleteData)
    {
        using (OperationLock.Acquire(target))
        using (OperationLock.Acquire(ReadDataDir(target))) UninstallLocked(target, register, deleteData);
    }

    private static void UninstallLocked(string target, bool register, bool deleteData)
    {
        string dataRemoval = deleteData ? DataRemovalRoot(target) : "";
        string uninstaller = Path.Combine(target, "卸载.exe");
        string self = Assembly.GetExecutingAssembly().Location;
        if (String.Equals(Path.GetFullPath(uninstaller), Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase)) throw new IOException("卸载器需要从临时位置运行");
        if (File.Exists(uninstaller) && !SameFile(uninstaller, self)) throw new IOException("卸载程序已变化，请保留并手动处理");
        string manifest = EmbeddedManifest();
        var kept = UninstallCore.Remove(target, Edition, manifest);
        if (kept.Count > 0) throw new IOException("以下已修改或不可删除的文件已保留：\n" + String.Join("\n", kept.ToArray()));
        string launcher = Path.Combine(target, LauncherName);
        string menu = Path.Combine(Roaming, "Microsoft", "Windows", "Start Menu", "Programs");
        RemoveOwnedShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DisplayName + ".lnk"), launcher);
        RemoveOwnedShortcut(Path.Combine(menu, DisplayName + ".lnk"), launcher);
        RemoveOwnedShortcut(Path.Combine(menu, "Startup", Edition == "tb" ? "领航员终端.lnk" : "心语机器人.lnk"), launcher);
        if (deleteData && Directory.Exists(dataRemoval))
        {
            Migration.EnsureNotRunning(ReadDataDir(target));
            CheckDataTree(dataRemoval);
            Directory.Delete(dataRemoval, true);
        }
        if (register) RemoveRegistration(target);
        if (File.Exists(uninstaller)) File.Delete(uninstaller);
        UninstallCore.FinalizeRemoval(target, Edition, manifest);
        try { Directory.Delete(target, false); } catch (IOException) { /* 用户设置、协议端或备份需要保留 */ }
    }

    private static string QuoteArgument(string value)
    {
        var result = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(ch); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static void LaunchUninstaller(string target, bool deleteData)
    {
        string helper = Path.Combine(Path.GetTempPath(), "heartecho-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
        File.Copy(Assembly.GetExecutingAssembly().Location, helper, false);
        try
        {
            var start = new ProcessStartInfo(helper, "--uninstall-helper " + QuoteArgument("--dir=" + target) + " --parent=" + Process.GetCurrentProcess().Id + (deleteData ? " --delete-data --confirm-delete-data" : ""));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            if (Process.Start(start) == null) throw new IOException("无法启动卸载助手");
        }
        catch { File.Delete(helper); throw; }
    }

    private static void RemoveTemporaryHelperAfterExit()
    {
        string self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        string name = Path.GetFileName(self);
        if (!String.Equals(Path.GetDirectoryName(self), temp, StringComparison.OrdinalIgnoreCase) ||
            !name.StartsWith("heartecho-uninstall-", StringComparison.Ordinal) || !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return;
        // 单一 PowerShell 进程只删除该助手自身；路径和进程号通过环境变量传递，不拼接进脚本。
        string script = "$p=$env:HEARTECHO_UNINSTALL_SELF; $id=[int]$env:HEARTECHO_UNINSTALL_PID; Wait-Process -Id $id -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue";
        string encoded = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(script));
        try
        {
            var start = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["HEARTECHO_UNINSTALL_SELF"] = self;
            start.EnvironmentVariables["HEARTECHO_UNINSTALL_PID"] = Process.GetCurrentProcess().Id.ToString();
            Process.Start(start);
        }
        catch { /* 临时文件可在之后手动删除，不影响用户数据 */ }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        if (Has(args, "--verify-resources"))
        {
            try { return ReadLicenses().Length > 0 && EmbeddedManifest().Length > 0 ? 0 : 1; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        string target = Option(args, "--dir=");
        if (target.Length == 0) target = DefaultDestination;
        bool helper = Has(args, "--uninstall-helper");
        bool direct = Has(args, "--uninstall-direct");
        if (helper || direct)
        {
            if (Option(args, "--dir=").Length == 0 || (direct && (!Has(args, "--silent") || !Has(args, "--accept-uninstall")))) return 2;
            if (Has(args, "--delete-data") && !Has(args, "--confirm-delete-data")) return 2;
            try
            {
                int parent;
                if (helper && Int32.TryParse(Option(args, "--parent="), out parent) && parent > 0)
                {
                    try { using (Process process = Process.GetProcessById(parent)) if (!process.WaitForExit(15000)) throw new IOException("卸载入口仍在运行，请重新尝试"); }
                    catch (ArgumentException) { /* 卸载入口已经退出 */ }
                }
                bool deleteData = Has(args, "--delete-data");
                Uninstall(Path.GetFullPath(target), !Has(args, "--no-register"), deleteData);
                if (!Has(args, "--silent")) MessageBox.Show(deleteData ? "卸载完成。已删除默认数据目录，协议端和安装备份已保留。" : "卸载完成。用户数据、协议端和安装备份已保留。", DisplayName);
                return 0;
            }
            catch (Exception error)
            {
                if (!Has(args, "--silent")) MessageBox.Show("卸载未完成：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally { if (helper) RemoveTemporaryHelperAfterExit(); }
        }
        if (Has(args, "--uninstall") || String.Equals(Path.GetFileName(Assembly.GetExecutingAssembly().Location), "卸载.exe", StringComparison.OrdinalIgnoreCase))
        {
            target = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            DialogResult choice = MessageBox.Show("卸载 " + DisplayName + "？\n\n是：保留用户数据（推荐）\n否：删除默认用户数据\n取消：不卸载\n\n协议端和安装备份会保留。", DisplayName, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (choice == DialogResult.Cancel) return 1;
            bool deleteData = choice == DialogResult.No;
            if (deleteData)
            {
                try
                {
                    string data = DataRemovalRoot(target);
                    if (MessageBox.Show("将永久删除以下目录中的角色、记忆、设置和备份：\n" + data + "\n\n确定删除？", DisplayName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return 1;
                }
                catch (Exception error) { MessageBox.Show(error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
            }
            try { LaunchUninstaller(target, deleteData); return 0; }
            catch (Exception error) { MessageBox.Show("无法启动卸载：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
        }
        if (Has(args, "--silent"))
        {
            if (!Has(args, "--accept-license")) return 2;
            try { Install(Path.GetFullPath(target), Has(args, "--desktop"), Has(args, "--start-menu"), Has(args, "--autostart"), false, Has(args, "--register"), Option(args, "--import-dir=")); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        using (var form = new Form { Text = DisplayName + " 安装（开发预览）", Width = 660, Height = 510, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false })
        {
            var intro = new Label { Left = 24, Top = 20, Width = 600, Height = 48, Text = "安装到当前用户目录。QQ 和协议端需要自行准备；本安装包不包含 SnowLuma。" };
            var input = new TextBox { Left = 24, Top = 74, Width = 490, Text = target };
            var browse = new Button { Left = 520, Top = 72, Width = 100, Text = "选择目录" };
            browse.Click += (s, e) => { using (var dialog = new FolderBrowserDialog()) if (dialog.ShowDialog(form) == DialogResult.OK) input.Text = dialog.SelectedPath; };
            var desktop = new CheckBox { Left = 24, Top = 115, Width = 550, Text = "创建桌面快捷方式", Checked = true };
            var menu = new CheckBox { Left = 24, Top = 145, Width = 550, Text = "创建开始菜单快捷方式", Checked = true };
            var startup = new CheckBox { Left = 24, Top = 175, Width = 550, Text = "登录 Windows 后自动在托盘启动（可在面板关闭）", Checked = true };
            var import = new CheckBox { Left = 24, Top = 211, Width = 590, Text = "复制导入旧数据（不会删除原目录，目标必须为空）" };
            string nearby = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string old = Path.Combine(nearby, "data");
            if (!Directory.Exists(old)) old = Path.Combine(nearby, "dist", "data");
            if (Directory.Exists(old)) import.Text = "检测到旧数据；勾选后复制导入（不会删除原目录）";
            var oldData = new TextBox { Left = 24, Top = 240, Width = 490, Text = Directory.Exists(old) ? old : "" };
            var chooseOld = new Button { Left = 520, Top = 238, Width = 100, Text = "旧数据目录" };
            chooseOld.Click += (s, e) => { using (var dialog = new FolderBrowserDialog()) if (dialog.ShowDialog(form) == DialogResult.OK) { oldData.Text = dialog.SelectedPath; import.Checked = true; } };
            var terms = new CheckBox { Left = 24, Top = 285, Width = 600, Height = 42, Text = "我已阅读并接受心语 AGPL、Node 及随附扩展的许可与来源说明。" };
            var licenses = new LinkLabel { Left = 24, Top = 328, Width = 570, Text = "查看许可与第三方扩展来源" };
            licenses.Click += (s, e) => { try { ShowLicenses(form); } catch (Exception error) { MessageBox.Show(form, error.Message, DisplayName); } };
            var progress = new Label { Left = 24, Top = 360, Width = 590, Height = 20, Text = "" };
            var go = new Button { Left = 400, Top = 380, Width = 105, Height = 32, Text = "安装" };
            var cancel = new Button { Left = 515, Top = 380, Width = 105, Height = 32, Text = "取消", DialogResult = DialogResult.Cancel };
            int result = 1;
            go.Click += async (s, e) => {
                if (!terms.Checked) { MessageBox.Show(form, "请先确认许可说明。", DisplayName); return; }
                if (import.Checked && String.IsNullOrWhiteSpace(oldData.Text)) { MessageBox.Show(form, "请选择旧数据目录。", DisplayName); return; }
                if (startup.Checked && MessageBox.Show(form, "登录 Windows 后会自动在托盘启动。可取消勾选，也可稍后在面板关闭。继续安装？", DisplayName, MessageBoxButtons.YesNo) != DialogResult.Yes) return;
                string selectedTarget;
                try { selectedTarget = Path.GetFullPath(input.Text); }
                catch (Exception error) { MessageBox.Show(form, "安装目录无效：" + error.Message, DisplayName); return; }
                bool desktopOption = desktop.Checked, menuOption = menu.Checked, startupOption = startup.Checked;
                string importOption = import.Checked ? oldData.Text : "";
                go.Enabled = cancel.Enabled = browse.Enabled = chooseOld.Enabled = false;
                form.ControlBox = false;
                progress.Text = "正在校验文件、备份并安装，请稍候…";
                try {
                    var completion = new System.Threading.Tasks.TaskCompletionSource<bool>();
                    var worker = new System.Threading.Thread(() => {
                        try { Install(selectedTarget, desktopOption, menuOption, startupOption, true, true, importOption); completion.SetResult(true); }
                        catch (Exception error) { completion.SetException(error); }
                    });
                    worker.SetApartmentState(System.Threading.ApartmentState.STA);
                    worker.Start();
                    await completion.Task;
                    MessageBox.Show(form, "安装完成。请自行准备 QQ 与协议端，并在面板中选择协议端目录。", DisplayName);
                    result = 0; form.Close();
                } catch (Exception error) {
                    MessageBox.Show(form, "安装失败：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    progress.Text = "安装未完成，请检查提示后重试。";
                    go.Enabled = cancel.Enabled = browse.Enabled = chooseOld.Enabled = true;
                    form.ControlBox = true;
                }
            };
            form.Controls.AddRange(new Control[] { intro, input, browse, desktop, menu, startup, import, oldData, chooseOld, terms, licenses, progress, go, cancel });
            form.AcceptButton = go; form.CancelButton = cancel;
            Application.Run(form);
            return result;
        }
    }
}
