using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

// 只提供进程入口；路径、配置、单实例和业务行为由心语负责。
internal static class Launcher
{
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
            }
            else
            {
                result.Append('\\', slashes);
                result.Append(ch);
            }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string node = Path.Combine(root, "runtime", "node.exe");
            string entry = Path.Combine(root, "app", "index.mjs");
            if (!File.Exists(node) || !File.Exists(entry))
                throw new FileNotFoundException("程序文件不完整，请重新安装心语。", !File.Exists(node) ? node : entry);
            var arguments = new StringBuilder(Quote(entry));
            arguments.Append(" --tray");
#if TB_EDITION
            arguments.Append(" --tb");
#endif
            foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
            var start = new ProcessStartInfo(node, arguments.ToString());
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["HEARTECHO_INSTALLED"] = "1";
            start.EnvironmentVariables["HEARTECHO_INSTALL_ROOT"] = root;
            start.EnvironmentVariables["HEARTECHO_APP_DIR"] = root;
            start.EnvironmentVariables.Remove("HEARTECHO_INSTANCE");
#if TB_EDITION
            start.EnvironmentVariables["HEARTECHO_EDITION"] = "tb";
#else
            start.EnvironmentVariables.Remove("HEARTECHO_EDITION");
#endif
            using (Process process = Process.Start(start))
            {
                if (process == null) throw new InvalidOperationException("无法启动心语运行时。");
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show("启动失败：" + error.Message, "心语", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
