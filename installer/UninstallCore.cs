using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

// 清除安装器清单中且内容未变化的程序文件，保留用户数据与未知文件。
internal static class UninstallCore
{
    private static readonly Regex HashPattern = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);

    private static bool HasReparsePoint(string root, string target)
    {
        string current = target;
        while (!String.Equals(current, root, StringComparison.OrdinalIgnoreCase))
        {
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
            current = Path.GetDirectoryName(current);
            if (String.IsNullOrEmpty(current)) return true;
        }
        return false;
    }

    internal static List<string> Remove(string destination, string edition, string trustedManifest)
    {
        if (edition != "generic" && edition != "tb") throw new ArgumentException("未知产品版本");
        string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
        PathGuard.RejectReparseAncestors(root);
        if (String.IsNullOrEmpty(Path.GetDirectoryName(root)) || root.Equals(Path.GetPathRoot(root).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new IOException("不能卸载磁盘根目录");
        if (!Directory.Exists(root) || (File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录不存在或是链接");
        string marker = Path.Combine(root, "INSTALL-EDITION.txt");
        string manifest = Path.Combine(root, "SHA256SUMS.txt");
        if (!File.Exists(marker) || HasReparsePoint(root, marker) || File.ReadAllText(marker).Trim() != edition) throw new IOException("目录不是对应版本的心语安装");
        if (!File.Exists(manifest) || HasReparsePoint(root, manifest) || File.ReadAllText(manifest) != trustedManifest) throw new IOException("安装清单已变化，不能安全自动卸载");
        InstallCore.EnsureStopped(root);
        var files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string launcher = edition == "tb" ? "领航员终端.exe" : "心语.exe";
        foreach (string line in trustedManifest.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string text = line.TrimEnd('\r');
            if (text.Length < 67 || text.Substring(64, 2) != "  " || !HashPattern.IsMatch(text.Substring(0, 64))) throw new InvalidDataException("安装清单格式错误");
            string name = Payload.SafeRelative(text.Substring(66));
            if (!name.StartsWith("app/", StringComparison.OrdinalIgnoreCase) && !name.StartsWith("runtime/", StringComparison.OrdinalIgnoreCase) && name != launcher && name != "VERSION.json" && name != "INSTALL-EDITION.txt")
                throw new InvalidDataException("安装清单包含不受管理的文件：" + name);
            if (files.ContainsKey(name)) throw new InvalidDataException("安装清单包含重复文件");
            files.Add(name, text.Substring(0, 64));
        }
        if (!files.ContainsKey(launcher) || !files.ContainsKey("INSTALL-EDITION.txt")) throw new InvalidDataException("安装清单缺少必要文件");
        var kept = new List<string>();
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in files.Where(item => !String.Equals(item.Key, "INSTALL-EDITION.txt", StringComparison.OrdinalIgnoreCase)))
        {
            string target = Payload.Target(root, item.Key);
            string parent = Path.GetDirectoryName(target);
            while (!String.Equals(parent, root, StringComparison.OrdinalIgnoreCase)) { directories.Add(parent); parent = Path.GetDirectoryName(parent); }
            if (!File.Exists(target)) continue;
            if (HasReparsePoint(root, target)) { kept.Add(item.Key); continue; }
            try
            {
                string actual;
                using (var stream = File.OpenRead(target)) using (var hash = SHA256.Create())
                    actual = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actual, item.Value, StringComparison.Ordinal)) { kept.Add(item.Key); continue; }
                File.Delete(target);
            }
            catch (IOException) { kept.Add(item.Key); }
            catch (UnauthorizedAccessException) { kept.Add(item.Key); }
        }
        foreach (string dir in directories.OrderByDescending(value => value.Length))
        {
            try { if (Directory.Exists(dir) && !HasReparsePoint(root, dir)) Directory.Delete(dir, false); }
            catch (IOException) { /* 用户可能放了自己的文件，保留目录 */ }
            catch (UnauthorizedAccessException) { /* 保留无权删除的目录 */ }
        }
        return kept;
    }

    internal static void FinalizeRemoval(string destination, string edition, string trustedManifest)
    {
        string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
        string marker = Path.Combine(root, "INSTALL-EDITION.txt");
        string manifest = Path.Combine(root, "SHA256SUMS.txt");
        if (!File.Exists(marker) || HasReparsePoint(root, marker) || File.ReadAllText(marker).Trim() != edition ||
            !File.Exists(manifest) || HasReparsePoint(root, manifest) || File.ReadAllText(manifest) != trustedManifest)
            throw new IOException("安装信息已变化，保留卸载记录");
        File.Delete(manifest);
        File.Delete(marker);
    }
}
