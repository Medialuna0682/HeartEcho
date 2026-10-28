using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// 安装、卸载操作不能同时改写同一个目录。
internal sealed class OperationLock : IDisposable
{
    private readonly Mutex mutex;
    private OperationLock(Mutex mutex) { this.mutex = mutex; }
    internal static OperationLock Acquire(string directory)
    {
        string id;
        using (SHA256 hash = SHA256.Create())
            id = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar).ToLowerInvariant()))).Replace("-", "").Substring(0, 32);
        var mutex = new Mutex(false, @"Local\HeartEcho-Install-" + id);
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) { mutex.Dispose(); throw new IOException("同一目录已有安装或卸载操作，请等待完成"); }
        return new OperationLock(mutex);
    }
    public void Dispose() { mutex.ReleaseMutex(); mutex.Dispose(); }
}
