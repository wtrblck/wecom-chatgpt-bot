using System.IO;
using System.Windows;

namespace WeChatDesktop;
public partial class App : Application
{
    private Mutex? singleton;
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var projectRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".."));
        var defaultRoot = File.Exists(Path.Combine(projectRoot, "src", "index.ts")) && File.Exists(Path.Combine(projectRoot, "package.json"))
            ? projectRoot : Path.Combine(AppContext.BaseDirectory, "app");
        var root = e.Args.SkipWhile(a => a != "--project").Skip(1).FirstOrDefault() ?? defaultRoot;
        root = Path.GetFullPath(root);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(root.ToLowerInvariant())))[..20];
        singleton = new Mutex(true, @"Local\WeChatGPT.Desktop." + digest, out var created);
        if (!created) { MessageBox.Show("这个项目的桌面工作台已经打开。", "WeChatGPT"); Shutdown(); return; }
        DispatcherUnhandledException += (_, args) => {
            if (e.Args.Contains("--smoke-test")) { Directory.CreateDirectory(Path.Combine(root, ".cache")); File.WriteAllText(Path.Combine(root, ".cache", "desktop-startup-error.txt"), args.Exception.ToString()); Shutdown(1); }
            else MessageBox.Show(args.Exception.Message, "操作未完成"); args.Handled = true;
        };
        try { new MainWindow(root, e.Args.Contains("--smoke-test")).Show(); }
        catch (Exception ex) {
            if (e.Args.Contains("--smoke-test")) { Directory.CreateDirectory(Path.Combine(root, ".cache")); File.WriteAllText(Path.Combine(root, ".cache", "desktop-startup-error.txt"), ex.ToString()); }
            else MessageBox.Show(ex.Message, "无法启动 WeChatGPT"); Shutdown(1);
        }
    }
    protected override void OnExit(ExitEventArgs e) { singleton?.Dispose(); base.OnExit(e); }
}
