using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace WeChatDesktop;
public partial class MainWindow : Window
{
    private readonly string root;
    private readonly bool smoke;
    private readonly HostClient host;
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(2) };
    private readonly Grid pageArea = new();
    private readonly List<FrameworkElement> pages = [];
    private readonly List<Button> nav = [];
    private readonly TextBlock pageTitle = Txt("工作台", 25, true);
    private readonly TextBlock pageSubtitle = Txt("连接微信与灵感，让回答自然发生。", 12, color: "#78877F");
    private readonly TextBlock toast = Txt("正在连接本地服务…", 12);
    private readonly TextBlock runtimeLabel = Txt("●  尚未启动", 12);
    private readonly List<Button> operationButtons = [];
    private JsonNode? state;
    private JsonNode? editingSettings;
    private bool polling, operating, closing, closed, dirty;
    private int selectedPage;

    internal MainWindow(string root, bool smoke)
    {
        this.root = root; this.smoke = smoke;
        Title = "WeChatGPT · 微信智能对话工作台"; Width = 1320; Height = 900; MinWidth = 1120; MinHeight = 760;
        WindowStartupLocation = WindowStartupLocation.CenterScreen; Background = Brush("#F6F8F4");
        host = new HostClient(root);
        Content = BuildShell();
        timer.Tick += async (_, _) => await Refresh();
        Loaded += async (_, _) => {
            await Refresh(); timer.Start();
            if (smoke) await SmokeTest();
        };
        Closing += async (_, e) => {
            if (closed) return; e.Cancel = true;
            if (closing) return;
            if (dirty && MessageBox.Show(this, "设置还没有保存。关闭后将丢弃这些修改，是否继续？", "未保存的修改", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
            closing = true; timer.Stop(); toast.Text = "正在安全停止机器人并关闭浏览器…";
            try { await host.Close(); closed = true; Close(); }
            catch (Exception ex) { closing = false; toast.Text = ex.Message; timer.Start(); }
        };
    }
    private UIElement BuildShell()
    {
        var shell = new Grid { Background = Brush("#F6F8F4") }; shell.ColumnDefinitions.Add(new() { Width = new GridLength(220) }); shell.ColumnDefinitions.Add(new());
        var sidebar = new Border { Background = Brushes.White, BorderBrush = Brush("#E5EAE3"), BorderThickness = new Thickness(0, 0, 1, 0), Padding = new Thickness(21, 30, 21, 24) };
        var side = new DockPanel(); sidebar.Child = side;
        var brand = new StackPanel { Margin = new Thickness(10, 0, 0, 38) };
        var brandRow = Row();
        brandRow.Children.Add(new Border { Width = 35, Height = 35, CornerRadius = new CornerRadius(11), Background = Brush("#22765A"), Child = new TextBlock { Text = "✦", FontSize = 25, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } });
        brandRow.Children.Add(Txt("WeChatGPT", 18, true, margin: new Thickness(10, 4, 0, 0)));
        brand.Children.Add(brandRow); brand.Children.Add(Txt("让对话，多一点可能", 11, color: "#8B968F", margin: new Thickness(0, 12, 0, 0))); DockPanel.SetDock(brand, Dock.Top); side.Children.Add(brand);
        var foot = new StackPanel(); foot.Children.Add(new Border { Background = Brush("#F2F7F1"), CornerRadius = new CornerRadius(10), Padding = new Thickness(14), Child = Stack(Txt("本地运行 · 由你掌控", 12, true), Txt("登录资料保留在本机\n仅监听你启用的会话", 11, color: "#78877F", margin: new Thickness(0, 8, 0, 0))) });
        foot.Children.Add(Txt("DESKTOP  /  v1.1.0", 10, color: "#9BA59D", margin: new Thickness(10, 20, 0, 0))); DockPanel.SetDock(foot, Dock.Bottom); side.Children.Add(foot);
        var links = new StackPanel();
        string[] labels = ["◈    工作台", "☷    监听会话", "✧    回答风格", "≡    运行记录"];
        for (var i = 0; i < labels.Length; i++) { var index = i; var button = Btn(labels[i], () => Navigate(index)); button.HorizontalContentAlignment = HorizontalAlignment.Left; button.Margin = new Thickness(0, 0, 0, 9); button.Padding = new Thickness(18, 14, 18, 14); button.BorderThickness = new Thickness(0); nav.Add(button); links.Children.Add(button); }
        links.Children.Add(Txt("工具与帮助", 10, color: "#9BA59D", margin: new Thickness(16, 28, 0, 12)));
        links.Children.Add(Btn("↗    打开数据文件夹", () => OpenFolder(root)));
        links.Children.Add(Btn("?    使用与兼容性说明", () => OpenGuide(), margin: new Thickness(0, 10, 0, 0)));
        side.Children.Add(links); shell.Children.Add(sidebar);
        var main = new Grid { Margin = new Thickness(32, 27, 32, 20) }; Grid.SetColumn(main, 1);
        main.RowDefinitions.Add(new() { Height = GridLength.Auto }); main.RowDefinitions.Add(new()); main.RowDefinitions.Add(new() { Height = GridLength.Auto });
        var header = new DockPanel { Margin = new Thickness(0, 0, 0, 24) };
        var right = Stack(Txt(DateTime.Now.ToString("yyyy 年 M 月 d 日  ·  dddd"), 11, color: "#89958B"), new Border { Background = Brush("#EDF2EB"), CornerRadius = new CornerRadius(12), Padding = new Thickness(13, 6, 13, 6), Margin = new Thickness(0, 9, 0, 0), HorizontalAlignment = HorizontalAlignment.Right, Child = runtimeLabel });
        DockPanel.SetDock(right, Dock.Right); header.Children.Add(right);
        pageSubtitle.Margin = new Thickness(0, 8, 0, 0); header.Children.Add(Stack(pageTitle, pageSubtitle)); main.Children.Add(header);
        pages.Add(BuildDashboard()); pages.Add(BuildConversations()); pages.Add(BuildStyle()); pages.Add(BuildActivity());
        foreach (var page in pages) { page.Visibility = Visibility.Collapsed; pageArea.Children.Add(page); }
        Grid.SetRow(pageArea, 1); main.Children.Add(pageArea);
        var status = new Border { Background = Brush("#EBF0E8"), CornerRadius = new CornerRadius(7), Padding = new Thickness(13, 9, 13, 9), Margin = new Thickness(0, 15, 0, 0), Child = toast }; Grid.SetRow(status, 2); main.Children.Add(status);
        shell.Children.Add(main); Navigate(0); return shell;
    }
    private void Navigate(int index)
    {
        selectedPage = index;
        string[] titles = ["工作台", "监听会话", "回答风格", "运行记录"];
        string[] subs = ["连接微信与灵感，让回答自然发生。", "只回应你选择的群聊与联系人。", "给机器人一个清晰、稳定的表达方式。", "查看运行动态，及时处理需要关注的回复。"];
        pageTitle.Text = titles[index]; pageSubtitle.Text = subs[index];
        for (var i = 0; i < pages.Count; i++) { pages[i].Visibility = i == index ? Visibility.Visible : Visibility.Collapsed; nav[i].Background = Brush(i == index ? "#E8F1E8" : "#FFFFFF"); nav[i].Foreground = Brush(i == index ? "#22765A" : "#78877F"); nav[i].FontWeight = i == index ? FontWeights.SemiBold : FontWeights.Normal; }
    }
    private async Task Refresh()
    {
        if (polling || closing) return; polling = true;
        try {
            state = await host.Call("state");
            if (editingSettings == null && state?["settings"] != null) { editingSettings = state["settings"]!.DeepClone(); LoadEditors(); }
            RenderState();
            if (toast.Text == "正在连接本地服务…") toast.Text = "本地服务已连接。先检查环境，然后登录 GPT 并启动机器人。";
        } catch (Exception ex) { toast.Text = ex.Message; }
        finally { polling = false; }
    }
    private async Task Operate(string method, string progress, JsonNode? parameters = null)
    {
        if (operating) return;
        operating = true; foreach (var b in operationButtons) b.IsEnabled = false; toast.Text = progress;
        try {
            var result = await host.Call(method, parameters);
            toast.Text = method switch { "start" => "正在启动，运行状态和日志会持续更新。", "stop" => "机器人与登录浏览器已安全停止。", "login" => "请在打开的 GPT 浏览器中完成登录；状态将自动更新。", "diagnose" => "检测完成；控件检测仅代表当前聊天窗口的能力。", "save" => "设置已保存，下次启动生效。", "export" => "诊断报告已导出到 logs 文件夹。", _ => "操作完成。" };
            if (method == "save") { dirty = false; editingSettings = result?.DeepClone(); LoadEditors(); }
            if (method == "newConversation") toast.Text = "已切换到新 GPT 对话。下一条问题会先设置风格，再发送消息正文。";
        } catch (Exception ex) { toast.Text = ex.Message; }
        finally { operating = false; foreach (var b in operationButtons) b.IsEnabled = true; await Refresh(); }
    }
    private void OpenFolder(string directory) { Directory.CreateDirectory(directory); Process.Start(new ProcessStartInfo(directory) { UseShellExecute = true }); }
    private void OpenGuide()
    {
        var file = Path.Combine(root, "docs", "desktop-guide.md");
        if (File.Exists(file)) Process.Start(new ProcessStartInfo("notepad.exe") { ArgumentList = { file } });
        else toast.Text = "请查看程序包中的 使用说明.txt。";
    }
    private async Task SmokeTest()
    {
        try {
            var directory = Path.Combine(root, ".cache", "desktop-smoke"); Directory.CreateDirectory(directory);
            await Operate("diagnose", "正在执行只读环境检测…");
            for (var i = 0; i < pages.Count; i++) {
                Navigate(i); UpdateLayout(); await Task.Delay(220); await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle); UpdateLayout();
                var target = (FrameworkElement)Content;
                var bitmap = new RenderTargetBitmap((int)target.ActualWidth, (int)target.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(target);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using var file = File.Create(Path.Combine(directory, $"page-{i}.png")); encoder.Save(file);
            }
            if (state == null || editingSettings == null) throw new Exception("后端状态未加载");
            File.WriteAllText(Path.Combine(directory, "result.json"), new JsonObject { ["ok"] = true, ["pages"] = pages.Count, ["phase"] = state["phase"]?.ToString(), ["checks"] = state["checks"]?.DeepClone() }.ToJsonString());
        } catch (Exception ex) { File.WriteAllText(Path.Combine(root, ".cache", "desktop-smoke-error.txt"), ex.ToString()); Environment.ExitCode = 1; }
        dirty = false; Close();
    }
    private static SolidColorBrush Brush(string color) => new((Color)ColorConverter.ConvertFromString(color));
    private static TextBlock Txt(string text, double size = 13, bool bold = false, string color = "#233C35", Thickness? margin = null) => new() { Text = text, FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, Foreground = Brush(color), TextWrapping = TextWrapping.Wrap, Margin = margin ?? new Thickness(0), LineHeight = size * 1.65 };
    private static StackPanel Stack(params UIElement[] items) { var panel = new StackPanel(); foreach (var item in items) panel.Children.Add(item); return panel; }
    private static StackPanel Row() => new() { Orientation = Orientation.Horizontal };
    private static Border Card(UIElement child, Thickness? margin = null) => new() { Background = Brushes.White, BorderBrush = Brush("#E3E9DF"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(13), Padding = new Thickness(22), Margin = margin ?? new Thickness(0, 0, 0, 16), Child = child };
    private Button Btn(string label, Action action, bool primary = false, Thickness? margin = null) { var b = new Button { Content = label, Margin = margin ?? new Thickness(0) }; if (primary) { b.Background = Brush("#22765A"); b.Foreground = Brushes.White; b.BorderBrush = Brush("#22765A"); } b.Click += (_, _) => action(); return b; }
    private Button ActionButton(string label, string method, string progress, bool primary = false) { var b = Btn(label, async () => await Operate(method, progress), primary); operationButtons.Add(b); return b; }
    private static ScrollViewer Scroll(UIElement content) => new() { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Padding = new Thickness(0, 0, 10, 0) };
    private static string S(JsonNode? value, string fallback = "") => value?.ToString() ?? fallback;
}
