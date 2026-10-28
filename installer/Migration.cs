using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

// 旧数据只复制到空目录，绝不删除或覆盖来源。
internal static class Migration
{
    internal sealed class Prepared : IDisposable
    {
        private readonly string source;
        private readonly string destination;
        private readonly string stage;
        private bool committed;
        internal Prepared(string source, string destination, string stage) { this.source = source; this.destination = destination; this.stage = stage; }
        internal void Commit()
        {
            if (committed) throw new InvalidOperationException("旧数据已经导入");
            EnsureNotRunning(source);
            if (File.Exists(destination) || (Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length != 0))
                throw new IOException("目标数据目录已有内容，不会覆盖");
            if (Directory.Exists(destination))
            {
                if ((File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0) throw new IOException("目标数据目录不能是链接");
                Directory.Delete(destination, false);
            }
            Directory.Move(stage, destination);
            committed = true;
        }
        public void Dispose()
        {
            if (!committed && Directory.Exists(stage)) Directory.Delete(stage, true);
        }
    }
    private static bool SameOrChild(string candidate, string parent)
    {
        string value = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
        string root = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar);
        return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    internal static void EnsureNotRunning(string data)
    {
        string digest;
        using (SHA1 hash = SHA1.Create()) digest = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(data).ToLowerInvariant()))).Replace("-", "").ToLowerInvariant().Substring(0, 12);
        string file = Path.Combine(Path.GetTempPath(), "heartecho-" + digest + ".lock");
        if (!File.Exists(file)) return;
        try
        {
            var value = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
            object pid;
            if (value == null || !value.TryGetValue("pid", out pid)) throw new InvalidDataException("锁文件无效");
            int number = Convert.ToInt32(pid);
            try { using (Process process = Process.GetProcessById(number)) if (!process.HasExited) throw new IOException("旧心语仍在运行，请先退出再导入"); }
            catch (ArgumentException) { /* 锁属于已退出的进程 */ }
        }
        catch (IOException) { throw; }
        catch (Exception error) { throw new IOException("无法确认旧数据是否正在使用，请先检查锁文件：" + file, error); }
    }

    private static void CopyTree(string source, string target)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("旧数据包含链接，请先检查：" + source);
        Directory.CreateDirectory(target);
        foreach (string item in Directory.GetFileSystemEntries(source))
        {
            FileAttributes attributes = File.GetAttributes(item);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("旧数据包含链接，请先检查：" + item);
            string to = Path.Combine(target, Path.GetFileName(item));
            if ((attributes & FileAttributes.Directory) != 0) CopyTree(item, to);
            else
            {
                var before = new FileInfo(item);
                long length = before.Length;
                DateTime modified = before.LastWriteTimeUtc;
                File.Copy(item, to, false);
                var after = new FileInfo(item);
                if (length != after.Length || modified != after.LastWriteTimeUtc) throw new IOException("复制时旧数据发生变化，请关闭旧程序后重试：" + item);
            }
        }
    }

    internal static Prepared Prepare(string source, string destination)
    {
        string from = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar);
        string to = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
        if (String.IsNullOrEmpty(Path.GetDirectoryName(from)) || String.IsNullOrEmpty(Path.GetDirectoryName(to)))
            throw new IOException("不能将磁盘根目录用作数据导入路径");
        PathGuard.RejectReparseAncestors(from);
        PathGuard.RejectReparseAncestors(to);
        if (!Directory.Exists(from)) throw new IOException("旧数据目录不存在");
        if (SameOrChild(from, to) || SameOrChild(to, from)) throw new IOException("旧数据目录和目标目录不能相同或互相包含");
        if (!File.Exists(Path.Combine(from, "config.json")) && !Directory.Exists(Path.Combine(from, "characters")) && !Directory.Exists(Path.Combine(from, "database")))
            throw new IOException("所选目录不像心语数据目录，请选择包含 config.json、characters 或 database 的目录");
        if (File.Exists(to) || (Directory.Exists(to) && Directory.GetFileSystemEntries(to).Length != 0))
            throw new IOException("目标数据目录已有内容，不会覆盖；请先备份并选择空目录");
        if (Directory.Exists(to) && (File.GetAttributes(to) & FileAttributes.ReparsePoint) != 0) throw new IOException("目标数据目录不能是链接");
        EnsureNotRunning(from);
        string parent = Path.GetDirectoryName(to);
        if (String.IsNullOrEmpty(parent)) throw new IOException("目标数据目录无效");
        Directory.CreateDirectory(parent);
        string stage = Path.Combine(parent, ".heartecho-import-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyTree(from, stage);
            EnsureNotRunning(from);
            return new Prepared(from, to, stage);
        }
        catch
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
            throw;
        }
    }

    internal static void CopyFrom(string source, string destination)
    {
        using (Prepared prepared = Prepare(source, destination)) prepared.Commit();
    }
}
