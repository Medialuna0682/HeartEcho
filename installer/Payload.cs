using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

// 只解压到调用方新建的暂存目录；所有文件通过清单校验后才可进入安装流程。
internal static class Payload
{
    private const long MaxBytes = 2L * 1024 * 1024 * 1024;
    private static readonly Regex HashPattern = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex Reserved = new Regex("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    internal static string SafeRelative(string name)
    {
        string value = name.Replace('\\', '/');
        if (value.Length == 0 || value.StartsWith("/", StringComparison.Ordinal) || value.IndexOf(':') >= 0)
            throw new InvalidDataException("安装包包含绝对路径");
        string[] parts = value.Split('/');
        foreach (string part in parts)
        {
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || Reserved.IsMatch(part) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidDataException("安装包包含不安全的文件名：" + name);
        }
        return string.Join("/", parts);
    }

    internal static string Target(string root, string relative)
    {
        string target = Path.GetFullPath(Path.Combine(root, SafeRelative(relative).Replace('/', Path.DirectorySeparatorChar)));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包文件超出暂存目录");
        return target;
    }

    internal static void ExtractVerified(string archive, string destination)
    {
        string root = Path.GetFullPath(destination);
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("安装暂存目录已经存在");
        Directory.CreateDirectory(root);
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        using (ZipArchive zip = ZipFile.OpenRead(archive))
        {
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal);
                string original = directory ? entry.FullName.TrimEnd('/', '\\') : entry.FullName;
                string name = SafeRelative(original);
                if (!entries.Add(name)) throw new InvalidDataException("安装包包含重复路径：" + name);
                int mode = (entry.ExternalAttributes >> 16) & 0xf000;
                if (mode == 0xa000) throw new InvalidDataException("安装包不能包含符号链接：" + name);
                string file = Target(root, name);
                if (directory) { Directory.CreateDirectory(file); continue; }
                if (entry.Length < 0 || entry.Length > MaxBytes - total) throw new InvalidDataException("安装包解压大小超出上限");
                total += entry.Length;
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                using (Stream input = entry.Open())
                using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    input.CopyTo(output);
                files.Add(name);
            }
        }
        const string manifestName = "SHA256SUMS.txt";
        if (!files.Remove(manifestName)) throw new InvalidDataException("安装包缺少校验清单");
        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string line in File.ReadAllLines(Target(root, manifestName), Encoding.UTF8))
        {
            if (line.Length == 0) continue;
            if (line.Length < 67 || line.Substring(64, 2) != "  " || !HashPattern.IsMatch(line.Substring(0, 64)))
                throw new InvalidDataException("安装包校验清单格式错误");
            string name = SafeRelative(line.Substring(66));
            if (!listed.Add(name) || !files.Contains(name)) throw new InvalidDataException("安装包校验清单有重复或多余文件：" + name);
            string actual;
            using (var stream = File.OpenRead(Target(root, name)))
            using (SHA256 hash = SHA256.Create())
                actual = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(actual, line.Substring(0, 64), StringComparison.Ordinal)) throw new InvalidDataException("安装包文件校验失败：" + name);
        }
        if (!listed.SetEquals(files)) throw new InvalidDataException("安装包包含未列入校验清单的文件");
    }
}
