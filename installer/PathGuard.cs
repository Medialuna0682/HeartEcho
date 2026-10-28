using System;
using System.IO;

// 在创建或递归处理目录前检查已存在的每一级，避免通过 junction 绕过路径边界。
internal static class PathGuard
{
    internal static void RejectReparseAncestors(string value)
    {
        string current = Path.GetFullPath(value);
        while (!String.IsNullOrEmpty(current))
        {
            if (File.Exists(current) || Directory.Exists(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("路径包含链接或重解析点，不能自动处理：" + current);
            }
            string parent = Path.GetDirectoryName(current.TrimEnd(Path.DirectorySeparatorChar));
            if (String.IsNullOrEmpty(parent) || String.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
            current = parent;
        }
    }
}
