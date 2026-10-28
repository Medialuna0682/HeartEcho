using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

// 安装事务只替换心语管理的代码；设置、协议端和用户数据始终留在原处。
internal static class InstallCore
{
    private const string Marker = "INSTALL-EDITION.txt";

    internal static string SettingsString(string setting, string key)
    {
        if (Directory.Exists(setting)) throw new IOException("设置路径是目录，无法确认数据位置：" + setting);
        if (!File.Exists(setting)) return "";
        try
        {
            PathGuard.RejectReparseAncestors(setting);
            var parsed = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(File.ReadAllText(setting)) as Dictionary<string, object>;
            if (parsed == null) throw new InvalidDataException("设置必须是对象");
            object value;
            if (!parsed.TryGetValue(key, out value) || value == null) return "";
            string text = value as string;
            if (text == null) throw new InvalidDataException(key + " 必须是字符串");
            return text.Trim();
        }
        catch (Exception error) { throw new IOException("无法读取数据目录设置，请检查：" + setting, error); }
    }

    internal static string SettingsDataDir(string setting) { return SettingsString(setting, "dataDir"); }

    private static bool SameOrChild(string candidate, string parent)
    {
        string value = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
        string root = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar);
        return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static void BackupDatabase(string dataDir)
    {
        if (String.IsNullOrWhiteSpace(dataDir)) return;
        string source = Path.Combine(Path.GetFullPath(dataDir), "database");
        if (!Directory.Exists(source)) return;
        PathGuard.RejectReparseAncestors(source);
        string[] files = Directory.GetFiles(source, "*.db*");
        if (files.Length == 0) return;
        string target = Path.Combine(dataDir, "backups", "installer-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N"));
        PathGuard.RejectReparseAncestors(target);
        Directory.CreateDirectory(target);
        foreach (string file in files)
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("数据库文件是链接，不能自动备份：" + file);
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), false);
        }
    }

    private static void BackupAllDatabases(string installRoot, string mainData, string instanceHome)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        Action<string> backup = data => {
            if (String.IsNullOrWhiteSpace(data)) return;
            string resolved = Path.GetFullPath(data);
            if (seen.Add(resolved)) { Migration.EnsureNotRunning(resolved); BackupDatabase(resolved); }
        };
        backup(mainData);
        string home = Path.GetFullPath(String.IsNullOrWhiteSpace(instanceHome) ? installRoot : instanceHome);
        PathGuard.RejectReparseAncestors(home);
        var instances = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string directory = Path.Combine(home, "instances");
        if (Directory.Exists(directory))
        {
            PathGuard.RejectReparseAncestors(directory);
            foreach (string item in Directory.GetDirectories(directory)) instances.Add(Path.GetFullPath(item));
        }
        string registry = Path.Combine(home, "instances.json");
        if (Directory.Exists(registry)) throw new IOException("实例登记表路径是目录：" + registry);
        if (File.Exists(registry))
        {
            try
            {
                PathGuard.RejectReparseAncestors(registry);
                var parsed = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(File.ReadAllText(registry)) as Dictionary<string, object>;
                object raw;
                if (parsed == null || !parsed.TryGetValue("instances", out raw) || !(raw is object[])) throw new InvalidDataException("实例登记表格式无效");
                foreach (object entry in (object[])raw)
                {
                    var item = entry as Dictionary<string, object>;
                    object value;
                    if (item == null || !item.TryGetValue("dir", out value) || !(value is string) || String.IsNullOrWhiteSpace((string)value)) throw new InvalidDataException("实例路径无效");
                    string itemPath = (string)value;
                    instances.Add(Path.GetFullPath(Path.IsPathRooted(itemPath) ? itemPath : Path.Combine(installRoot, itemPath)));
                }
            }
            catch (Exception error) { throw new IOException("无法读取实例登记表，已停止升级：" + registry, error); }
        }
        foreach (string instance in instances)
        {
            if (String.Equals(instance.TrimEnd(Path.DirectorySeparatorChar), home.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
                String.Equals(instance.TrimEnd(Path.DirectorySeparatorChar), installRoot.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) continue;
            PathGuard.RejectReparseAncestors(instance);
            string setting = Path.Combine(instance, "心语设置.json");
            string configured = SettingsDataDir(setting);
            string resolved = configured.Length == 0 ? Path.Combine(instance, "data") : Path.IsPathRooted(configured) ? configured : Path.Combine(instance, configured);
            backup(resolved);
        }
    }

    internal static void EnsureStopped(string root)
    {
        var executables = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            Path.GetFullPath(Path.Combine(root, "runtime", "node.exe")),
            Path.GetFullPath(Path.Combine(root, "心语.exe")),
            Path.GetFullPath(Path.Combine(root, "领航员终端.exe"))
        };
        foreach (string name in new[] { "node", "心语", "领航员终端" })
        {
            foreach (Process process in Process.GetProcessesByName(name))
            {
                using (process)
                {
                    string executable;
                    try { executable = process.MainModule.FileName; }
                    catch (Exception error)
                    {
                        if (name != "node") throw new IOException("无法确认心语是否已退出，请关闭后重试", error);
                        continue;
                    }
                    if (executables.Contains(Path.GetFullPath(executable))) throw new IOException("心语或其子实例仍在运行，请先退出后再安装或升级");
                }
            }
        }
    }

    internal static string Install(string archive, string destination, string edition, string dataDir, Action<string> progress = null, string uninstallerSource = null, string instanceHome = null)
    {
        if (edition != "generic" && edition != "tb") throw new ArgumentException("未知产品版本");
        string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
        PathGuard.RejectReparseAncestors(root);
        string parent = Path.GetDirectoryName(root);
        if (String.IsNullOrEmpty(parent) || root.Equals(Path.GetPathRoot(root).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new IOException("不能安装到磁盘根目录");
        if (!String.IsNullOrWhiteSpace(dataDir) && (SameOrChild(dataDir, Path.Combine(root, "app")) || SameOrChild(dataDir, Path.Combine(root, "runtime"))))
            throw new IOException("用户数据目录位于程序文件夹内，请先迁移数据后再安装");
        if (!String.IsNullOrWhiteSpace(dataDir) && SameOrChild(root, dataDir))
            throw new IOException("安装目录不能位于用户数据目录内，请选择其他目录");
        if (File.Exists(root)) throw new IOException("安装位置不是目录");
        bool existed = Directory.Exists(root);
        if (existed && (File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录不能是链接或重解析点");
        bool upgrade = existed && File.Exists(Path.Combine(root, Marker));
        if (upgrade && File.ReadAllText(Path.Combine(root, Marker)).Trim() != edition) throw new IOException("安装目录属于另一个版本");
        if (existed && !upgrade && Directory.GetFileSystemEntries(root).Length != 0) throw new IOException("安装目录非空且不是已有的心语安装，请选择空目录");
        if (upgrade) EnsureStopped(root);
        Directory.CreateDirectory(parent);
        string stage = Path.Combine(parent, ".heartecho-stage-" + Guid.NewGuid().ToString("N"));
        Payload.ExtractVerified(archive, stage);
        string launcher = edition == "tb" ? "领航员终端.exe" : "心语.exe";
        string[] directories = { "app", "runtime" };
        var files = new List<string> { launcher, "VERSION.json", Marker, "SHA256SUMS.txt" };
        if (uninstallerSource != null)
        {
            File.Copy(uninstallerSource, Path.Combine(stage, "卸载.exe"), false);
            files.Add("卸载.exe");
        }
        if (!File.Exists(Path.Combine(stage, Marker)) || File.ReadAllText(Path.Combine(stage, Marker)).Trim() != edition)
            throw new InvalidDataException("安装包版本与安装器不匹配");
        foreach (string name in directories)
        {
            string target = Path.Combine(root, name);
            if (!Directory.Exists(Path.Combine(stage, name)) || File.Exists(target)) throw new InvalidDataException("安装包缺少必要目录或目标路径类型冲突：" + name);
            if (Directory.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new IOException("程序目录不能是链接：" + name);
        }
        foreach (string name in files)
        {
            string target = Path.Combine(root, name);
            if (!File.Exists(Path.Combine(stage, name)) || Directory.Exists(target)) throw new InvalidDataException("安装包缺少必要文件或目标路径类型冲突：" + name);
            if (File.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new IOException("程序文件不能是链接：" + name);
        }
        if (!File.Exists(Path.Combine(stage, "app", "index.mjs")) || !File.Exists(Path.Combine(stage, "runtime", "node.exe")))
            throw new InvalidDataException("安装包缺少程序入口或 Node 运行时");
        if (upgrade) { EnsureStopped(root); BackupAllDatabases(root, dataDir, instanceHome); }
        Directory.CreateDirectory(root);
        string backup = Path.Combine(root, ".heartecho-update-backup-" + Guid.NewGuid().ToString("N"));
        if (upgrade) Directory.CreateDirectory(backup);
        var movedOld = new List<string>();
        var movedNew = new List<string>();
        try
        {
            foreach (string name in directories)
            {
                string target = Path.Combine(root, name);
                if (Directory.Exists(target)) { Directory.Move(target, Path.Combine(backup, name)); movedOld.Add(name); }
                Directory.Move(Path.Combine(stage, name), target); movedNew.Add(name);
                if (progress != null) progress(name);
            }
            foreach (string name in files)
            {
                string target = Path.Combine(root, name);
                if (File.Exists(target)) { File.Move(target, Path.Combine(backup, name)); movedOld.Add(name); }
                File.Move(Path.Combine(stage, name), target); movedNew.Add(name);
                if (progress != null) progress(name);
            }
        }
        catch
        {
            for (int i = movedNew.Count - 1; i >= 0; i--)
            {
                string name = movedNew[i];
                string installed = Path.Combine(root, name);
                if (Directory.Exists(installed)) Directory.Move(installed, Path.Combine(stage, name));
                else if (File.Exists(installed)) File.Move(installed, Path.Combine(stage, name));
            }
            for (int i = movedOld.Count - 1; i >= 0; i--)
            {
                string name = movedOld[i];
                string original = Path.Combine(backup, name);
                if (Directory.Exists(original)) Directory.Move(original, Path.Combine(root, name));
                else if (File.Exists(original)) File.Move(original, Path.Combine(root, name));
            }
            throw;
        }
        // stage 是当前进程生成并验证过的专属目录；已安装文件已移走。
        Directory.Delete(stage, true);
        return upgrade ? backup : "";
    }
}
