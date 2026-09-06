namespace WeChatBridge;

/** Covers separate bridge processes (bot, smoke test and manual resend) in one desktop session. */
internal static class DesktopOperationLease
{
    private const string ProductionName = @"Local\WeChatBridge.DesktopOperation.v2";

    public static T Run<T>(Func<T> action) => Run(ProductionName, action);

    private static T Run<T>(string name, Func<T> action)
    {
        using var mutex = new Mutex(false, name);
        var acquired = false;
        try
        {
            try { acquired = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new InvalidOperationException("另一个微信桥接进程正在操作窗口，本次操作未开始");
            return action();
        }
        finally { if (acquired) mutex.ReleaseMutex(); }
    }

    // Synthetic concurrency checks use a random mutex and never touch UIA or Weixin.
    internal static int SelfTest()
    {
        var name = @"Local\WeChatBridge.LeaseTest." + Guid.NewGuid().ToString("N");
        using var acquired = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        Exception? ownerError = null;
        var owner = new Thread(() =>
        {
            try { Run(name, () => { acquired.Set(); release.Wait(); return true; }); }
            catch (Exception error) { ownerError = error; acquired.Set(); }
        }) { IsBackground = true };
        owner.Start();
        var tests = 0;
        try
        {
            if (!acquired.Wait(TimeSpan.FromSeconds(3)) || ownerError is not null)
                throw new InvalidOperationException("Could not acquire synthetic mutex", ownerError);
            var invoked = false;
            try { Run(name, () => { invoked = true; return true; }); }
            catch (InvalidOperationException) { tests++; }
            if (invoked || tests != 1) throw new InvalidOperationException("Contending operation was not rejected");
        }
        finally
        {
            release.Set();
            if (!owner.Join(TimeSpan.FromSeconds(3))) throw new InvalidOperationException("Synthetic mutex owner did not terminate");
        }
        if (Run(name, () => 42) != 42) throw new InvalidOperationException("Released lease was not reusable");
        tests++;
        try { Run<int>(name, () => throw new ArgumentException("synthetic action failure")); }
        catch (ArgumentException) { tests++; }
        if (!Run(name, () => true)) throw new InvalidOperationException("Failed action did not release lease");
        return tests + 1;
    }
}
