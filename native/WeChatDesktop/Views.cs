using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WeChatDesktop;
public partial class MainWindow
{
    private readonly TextBlock wechatStatus = Txt("等待检测", 19, true), gptStatus = Txt("尚未验证", 19, true), controlsStatus = Txt("等待检测", 19, true);
    private readonly TextBlock wechatDetail = Txt("检测微信主窗口和登录状态", 11, color: "#78877F"), gptDetail = Txt("打开专用浏览器完成登录", 11, color: "#78877F"), controlsDetail = Txt("检查当前聊天窗口的可访问控件", 11, color: "#78877F");
    private readonly TextBlock completedCount = Txt("0", 29, true), enabledCount = Txt("0", 29, true), pendingCount = Txt("0", 29, true), attentionCount = Txt("0", 29, true);
    private readonly StackPanel checksList = new(), recentList = new(), fullLog = new(), outboxList = new();
    private readonly TextBlock checkedTime = Txt("尚未执行检测", 10, color: "#9BA59D");
    private readonly TextBlock listenerHint = Txt("请先添加需要监听的会话", 12, color: "#78877F");
    private Button startButton = null!, stopButton = null!;
    private CheckBox onlyProblems = null!;
    private string? renderedActivities;
    private FrameworkElement BuildDashboard()
    {
        var page = new StackPanel();
        var hero = new Grid(); hero.ColumnDefinitions.Add(new()); hero.ColumnDefinitions.Add(new() { Width = new GridLength(218) });
        var intro = Stack(Txt("YOUR CONVERSATION COMPANION", 10, true, "#5A8767"), Txt("让每一次对话，\n都更有回应。", 29, true, margin: new Thickness(0, 12, 0, 8)), Txt("微信 × ChatGPT  ·  一个安静、专注的智能助手", 12, color: "#64826D"));
        hero.Children.Add(intro);
        var actions = Stack(Txt("准备好，开始连接", 14, true), Txt("登录后开启你的智能对话", 11, color: "#78877F", margin: new Thickness(0, 7, 0, 17)));
        startButton = ActionButton("▶   启动机器人", "start", "正在启动机器人…", true); actions.Children.Add(startButton);
        stopButton = ActionButton("Ⅱ   安全停止", "stop", "正在安全停止，请稍候…"); stopButton.Margin = new Thickness(0, 9, 0, 0); actions.Children.Add(stopButton); actions.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(actions, 1); hero.Children.Add(actions);
        var heroCard = Card(hero); heroCard.Background = new LinearGradientBrush(Color.FromRgb(231, 241, 219), Color.FromRgb(243, 247, 235), 15); heroCard.Padding = new Thickness(28, 23, 28, 23); page.Children.Add(heroCard);
        var health = new Grid(); for (var i = 0; i < 3; i++) health.ColumnDefinitions.Add(new());
        var cards = new[] { StatusCard("01  /  微信客户端", wechatStatus, wechatDetail, "检测环境", "diagnose"), StatusCard("02  /  GPT 账号", gptStatus, gptDetail, "登录 / 打开 GPT", "login"), StatusCard("03  /  控件兼容性", controlsStatus, controlsDetail, "重新检测控件", "diagnose") };
        for (var i = 0; i < cards.Length; i++) { cards[i].Margin = new Thickness(i == 0 ? 0 : 7, 0, i == 2 ? 0 : 7, 16); Grid.SetColumn(cards[i], i); health.Children.Add(cards[i]); } page.Children.Add(health);
        var metrics = new Grid(); for (var i = 0; i < 4; i++) metrics.ColumnDefinitions.Add(new());
        string[] metricLabels = ["今日完成回答", "启用的监听会话", "等待与处理中", "需要核对的分片"];
        TextBlock[] values = [completedCount, enabledCount, pendingCount, attentionCount];
        for (var i = 0; i < 4; i++) { var item = Stack(values[i], Txt(metricLabels[i], 11, color: "#78877F")); item.Margin = new Thickness(i == 0 ? 0 : 24, 0, 0, 0); Grid.SetColumn(item, i); metrics.Children.Add(item); } page.Children.Add(Card(metrics));
        var lower = new Grid(); lower.ColumnDefinitions.Add(new()); lower.ColumnDefinitions.Add(new() { Width = new GridLength(1.1, GridUnitType.Star) });
        var setup = Card(Stack(Txt("连接检查", 15, true), checkedTime, checksList), new Thickness(0, 0, 8, 0)); checkedTime.Margin = new Thickness(0, 5, 0, 12); lower.Children.Add(setup);
        var recent = Card(Stack(Txt("最近动态", 15, true), listenerHint, recentList), new Thickness(8, 0, 0, 0)); listenerHint.Margin = new Thickness(0, 7, 0, 14); Grid.SetColumn(recent, 1); lower.Children.Add(recent); page.Children.Add(lower);
        return Scroll(page);
    }
    private Border StatusCard(string title, TextBlock status, TextBlock detail, string label, string method)
    {
        status.Margin = new Thickness(0, 12, 0, 7); detail.MinHeight = 42;
        var button = ActionButton(label, method, method == "login" ? "正在打开 GPT 浏览器…" : "正在检查环境和微信控件…"); button.Margin = new Thickness(0, 12, 0, 0); button.Padding = new Thickness(8, 8, 8, 8);
        return Card(Stack(Txt(title, 11, color: "#78877F"), status, detail, button));
    }
    private FrameworkElement BuildActivity()
    {
        var page = new StackPanel();
        var tools = Row(); tools.Children.Add(ActionButton("导出诊断报告", "export", "正在导出诊断…", true)); tools.Children.Add(Btn("打开日志文件夹", () => OpenFolder(System.IO.Path.Combine(root, "logs")), margin: new Thickness(12, 0, 0, 0))); onlyProblems = new CheckBox { Content = "只看警告与错误", Margin = new Thickness(22, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center }; onlyProblems.Click += (_, _) => RenderState(); tools.Children.Add(onlyProblems); page.Children.Add(Card(tools));
        page.Children.Add(Card(Stack(Txt("需要核对的发送记录", 16, true), Txt("未知状态的回复可能已经提交，请先在微信核对。此处展示记录，不自动补发。", 12, color: "#78877F", margin: new Thickness(0, 8, 0, 15)), outboxList)));
        page.Children.Add(Card(Stack(Txt("本次工作台运行日志", 16, true), Txt("展示最近 200 条运行事件；完整机器人日志见 latest.log。", 12, color: "#78877F", margin: new Thickness(0, 7, 0, 15)), fullLog)));
        return Scroll(page);
    }
    private void RenderState()
    {
        if (state == null) return;
        var phase = S(state["phase"]); var external = state["externalPid"] != null;
        runtimeLabel.Text = external ? "●  命令行机器人运行中" : phase switch { "starting" => "●  正在启动", "running" => "●  正在运行", "stopping" => "●  正在停止", "error" => "●  运行异常", _ => "●  尚未启动" };
        runtimeLabel.Foreground = Brush(phase == "running" ? "#22765A" : phase == "error" ? "#B0523A" : "#78877F");
        startButton.IsEnabled = !operating && !external && phase is "stopped" or "error" && !dirty;
        stopButton.IsEnabled = !operating && !external;
        gptStatus.Text = S(state["account"]) switch { "authenticated" => "已登录", "signed-out" => "需要登录", _ => S(state["browser"]) == "CLOSED" ? "浏览器未打开" : "登录待确认" };
        gptStatus.Foreground = Brush(S(state["account"]) == "authenticated" ? "#22765A" : "#AB8540");
        gptDetail.Text = S(state["account"]) switch { "authenticated" => S(state["browser"]) == "GENERATING" ? "已登录 · 正在生成回答" : "已识别账号标记，登录资料保留在本机", "signed-out" => "请在专用 GPT 浏览器中手动登录", _ => "打开 GPT 后检测；输入框可见不等于已登录" };
        var checks = state["checks"]?.AsArray();
        var wx = checks?.FirstOrDefault(c => S(c?["name"]) == "wechat"); var controls = checks?.FirstOrDefault(c => S(c?["name"]) == "controls");
        wechatStatus.Text = wx == null ? "等待检测" : S(wx["status"]) == "ok" ? "已登录" : "需要处理";
        controlsStatus.Text = controls == null ? "等待检测" : S(controls["status"]) == "ok" ? "当前控件可用" : "兼容性待确认";
        wechatStatus.Foreground = Brush(S(wx?["status"]) == "ok" ? "#22765A" : "#AB8540"); controlsStatus.Foreground = Brush(S(controls?["status"]) == "ok" ? "#22765A" : "#AB8540");
        if (wx != null) wechatDetail.Text = S(wx["detail"]); if (controls != null) controlsDetail.Text = S(controls["detail"]);
        if (DateTime.TryParse(S(state["checkedAt"]), out var checkedAt)) checkedTime.Text = "上次检测 " + checkedAt.ToLocalTime().ToString("HH:mm:ss") + " · 手动刷新";
        completedCount.Text = S(state["stats"]?["completed"], "0"); pendingCount.Text = S(state["stats"]?["pending"], "0"); attentionCount.Text = S(state["stats"]?["attention"], "0");
        var count = state["settings"]?["conversations"]?.AsArray().Count(c => c?["enabled"]?.GetValue<bool>() == true) ?? 0; enabledCount.Text = count.ToString(); listenerHint.Text = count > 0 ? $"已配置 {count} 个监听会话 · {(phase == "running" ? "监听中" : "等待启动")}" : "前往「监听会话」添加第一个群聊";
        checksList.Children.Clear();
        if (checks == null || checks.Count == 0) checksList.Children.Add(Txt("点击「检测环境」，检查配置、浏览器、\n微信窗口与读取依赖。", 12, color: "#78877F"));
        else foreach (var c in checks) { var ok = S(c?["status"]) == "ok"; var name = S(c?["name"]) switch { "configuration" => "监听配置", "chromium" => "GPT 浏览器", "reader" => "消息读取依赖", "wechat" => "微信登录", "controls" => "微信控件", _ => S(c?["name"]) }; var item = Txt((ok ? "✓   " : "!   ") + name + (ok ? "  ·  就绪" : "  ·  需要关注"), 12, color: ok ? "#4B7757" : "#AB8540", margin: new Thickness(0, 0, 0, 9)); item.ToolTip = S(c?["detail"]); checksList.Children.Add(item); }
        var activitySignature = state["activities"]?.ToJsonString() + "|" + onlyProblems.IsChecked;
        if (activitySignature != renderedActivities) {
            renderedActivities = activitySignature;
        var activities = state["activities"]?.AsArray().Reverse().ToList() ?? [];
        recentList.Children.Clear(); foreach (var item in activities.Take(4)) recentList.Children.Add(LogRow(item));
        fullLog.Children.Clear(); foreach (var item in activities.Where(i => onlyProblems.IsChecked != true || S(i?["level"]) != "info")) fullLog.Children.Add(LogRow(item));
        if (fullLog.Children.Count == 0) fullLog.Children.Add(Txt("暂无符合筛选条件的记录", 12, color: "#78877F"));
        }
        outboxList.Children.Clear();
        if (state["stats"]?["error"] != null) outboxList.Children.Add(Txt("读取任务记录失败：" + S(state["stats"]?["error"]), 12, color: "#B0523A"));
        else if (state["stats"]?["outbox"] is JsonArray outbox && outbox.Count > 0) foreach (var item in outbox) outboxList.Children.Add(Txt($"{S(item?["status"])}  ·  {S(item?["delivery_key"])}  ·  第 {S(item?["part"])} 片\n{S(item?["error"], "等待核对")}", 12, color: "#AB8540", margin: new Thickness(0, 0, 0, 12)));
        else outboxList.Children.Add(Txt("✓  暂无需要核对的发送记录", 13, color: "#4B7757"));
    }
    private static UIElement LogRow(JsonNode? item)
    {
        var time = DateTime.TryParse(S(item?["time"]), out var parsed) ? parsed.ToLocalTime().ToString("HH:mm:ss") : "";
        return new Border { BorderBrush = Brush("#EFF2EC"), BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(0, 9, 0, 9), Child = Stack(Txt(time + "  ·  " + (S(item?["level"]) switch { "error" => "错误", "warning" => "注意", _ => "运行" }), 10, color: "#9BA59D"), Txt(S(item?["message"]), 12, color: S(item?["level"]) == "error" ? "#B0523A" : "#526C59")) };
    }
}
