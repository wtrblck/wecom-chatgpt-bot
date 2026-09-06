using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;

namespace WeChatDesktop;
public partial class MainWindow
{
    private TextBox systemPrompt = null!, prefixBox = null!, aliasBox = null!, pollBox = null!, sendBox = null!, searchBox = null!;
    private TextBox replyPrefixBox = null!, replySuffixBox = null!;
    private CheckBox prefixRequired = null!;
    private ComboBox sendAction = null!;
    private DataGrid conversationsGrid = null!;
    private TextBlock promptCount = null!;
    private bool loadingEditors;
    private sealed record ConversationRow(int Index, string Name, string Type, string Status, string Prompt, string Id);
    private FrameworkElement BuildConversations()
    {
        var page = new StackPanel();
        page.Children.Add(Card(Stack(Txt("选择你的对话范围", 21, true), Txt("添加群聊或联系人，填写微信中准确且唯一的名称。只有启用的会话会收到自动回复。", 12, color: "#78877F", margin: new Thickness(0, 9, 0, 0)))));
        var toolbar = new DockPanel { Margin = new Thickness(0, 0, 0, 18) };
        var buttons = Row(); buttons.Children.Add(Btn("＋ 添加会话", () => EditConversation(null), true)); buttons.Children.Add(Btn("编辑", () => { if (conversationsGrid.SelectedItem is ConversationRow row) EditConversation(row.Index); else toast.Text = "请先选择一个会话。"; }, margin: new Thickness(10, 0, 0, 0))); buttons.Children.Add(Btn("移除", RemoveConversation, margin: new Thickness(10, 0, 0, 0))); DockPanel.SetDock(buttons, Dock.Right); toolbar.Children.Add(buttons);
        searchBox = new TextBox { Width = 260, HorizontalAlignment = HorizontalAlignment.Left, ToolTip = "按名称搜索", Margin = new Thickness(0, 0, 18, 0) }; searchBox.TextChanged += (_, _) => RefreshConversations(); toolbar.Children.Add(Stack(Txt("搜索会话", 10, color: "#78877F"), searchBox));
        var newChat = Btn("新建 GPT 对话", async () => await NewConversation(), margin: new Thickness(10, 0, 0, 0)); buttons.Children.Add(newChat); operationButtons.Add(newChat);
        conversationsGrid = new DataGrid { MinHeight = 190, MaxHeight = 350 };
        foreach (var (header, property, width) in new[] { ("会话名称", "Name", 2.0), ("类型", "Type", .65), ("监听状态", "Status", .8), ("补充风格", "Prompt", 1.5) }) conversationsGrid.Columns.Add(new DataGridTextColumn { Header = header, Binding = new Binding(property), Width = new DataGridLength(width, DataGridLengthUnitType.Star) });
        conversationsGrid.MouseDoubleClick += (_, _) => { if (conversationsGrid.SelectedItem is ConversationRow row) EditConversation(row.Index); };
        page.Children.Add(Card(Stack(toolbar, conversationsGrid, Txt("双击一行编辑。稳定微信 ID 可选；重名会话请先设置唯一群名或备注。", 11, color: "#9BA59D", margin: new Thickness(0, 15, 0, 0)))));
        var trigger = new Grid(); trigger.ColumnDefinitions.Add(new()); trigger.ColumnDefinitions.Add(new());
        prefixRequired = new CheckBox { Content = "仅在消息以触发词开头时回复", IsChecked = true }; prefixRequired.Click += (_, _) => MarkDirty();
        prefixBox = new TextBox { MaxLength = 40 }; prefixBox.TextChanged += (_, _) => MarkDirty();
        aliasBox = new TextBox { MaxLength = 800, Margin = new Thickness(0, 7, 0, 0) }; aliasBox.TextChanged += (_, _) => MarkDirty();
        trigger.Children.Add(Stack(Txt("触发规则", 16, true), prefixRequired, Txt("关闭后，启用会话中的新文本消息都会触发回复。", 11, color: "#78877F"), Txt("触发词别名（用逗号分隔）", 12, true, margin: new Thickness(0, 14, 0, 0)), aliasBox));
        var triggerRight = Stack(Txt("主触发词", 12, true), prefixBox, Txt("例如 /gpt 问题内容，或 @ChatBOT 问题内容。\n别名默认含 @ChatBOT 和 @chatbot，可自由增删。", 11, color: "#78877F", margin: new Thickness(0, 8, 0, 0))); prefixBox.Margin = new Thickness(0, 10, 0, 0); triggerRight.Margin = new Thickness(24, 0, 0, 0); Grid.SetColumn(triggerRight, 1); trigger.Children.Add(triggerRight); page.Children.Add(Card(trigger));
        page.Children.Add(SaveBar()); return Scroll(page);
    }
    private FrameworkElement BuildStyle()
    {
        var page = new StackPanel();
        page.Children.Add(Card(Stack(Txt("好的回答，从一个清晰的角色开始。", 22, true), Txt("每个新 GPT 对话先设置一次全局风格和群聊补充要求，后续只发送消息正文。", 12, color: "#78877F", margin: new Thickness(0, 10, 0, 0)))));
        var presets = Row();
        var choices = new[] {
            ("✧  自然友好", "你是一位友好、真诚的聊天助手。使用自然的中文，先直接回答问题，再补充必要说明。避免套话与过度夸赞，信息不确定时明确说明。"),
            ("≡  简洁高效", "你是一位简洁、准确的助手。优先在三句话内回答核心问题；复杂任务再用简短步骤展开。不要重复问题，不要添加无关结语。"),
            ("⌘  专业严谨", "你是一位专业严谨的助手。先给出结论，再说明依据、关键假设与限制。区分已知事实和推测，不编造数据、引用或来源。根据问题复杂度安排篇幅。"),
            ("☀  轻松有趣", "你是一位轻松、有趣但尊重他人的群聊助手。用自然中文和适量幽默回答，先解决问题。避免刷屏、冒犯或刻意玩梗，严肃问题保持认真。")
        };
        foreach (var (label, prompt) in choices) presets.Children.Add(Btn(label, () => systemPrompt.Text = prompt, margin: new Thickness(0, 0, 10, 0)));
        systemPrompt = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 205, MaxLength = 16000, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(0, 16, 0, 0) }; systemPrompt.TextChanged += (_, _) => { MarkDirty(); if (promptCount != null) promptCount.Text = $"{systemPrompt.Text.Length:N0} / 16,000"; };
        promptCount = Txt("0 / 16,000", 10, color: "#9BA59D"); promptCount.HorizontalAlignment = HorizontalAlignment.Right;
        page.Children.Add(Card(Stack(Txt("全局回复风格", 16, true), Txt("选择一个起点，再写成你自己的风格。预设会替换当前文本，保存前可继续修改。", 11, color: "#78877F", margin: new Thickness(0, 8, 0, 14)), presets, systemPrompt, promptCount, Txt("修改后保存并重新启动，再新建 GPT 对话应用新风格。可发送 /gpt /new、@chatbot /new，或在监听会话页点击「新建 GPT 对话」。", 11, color: "#9BA59D", margin: new Thickness(0, 9, 0, 0)))));
        replyPrefixBox = new TextBox { MaxLength = 100, Margin = new Thickness(0, 8, 0, 0) };
        replySuffixBox = new TextBox { MaxLength = 100, Margin = new Thickness(0, 8, 0, 0) };
        replyPrefixBox.TextChanged += (_, _) => MarkDirty(); replySuffixBox.TextChanged += (_, _) => MarkDirty();
        var format = new Grid(); format.ColumnDefinitions.Add(new()); format.ColumnDefinitions.Add(new());
        var before = Stack(Txt("固定前缀（例如：主人）", 12), replyPrefixBox); before.Margin = new Thickness(0, 12, 20, 0); format.Children.Add(before);
        var after = Stack(Txt("固定后缀（例如：喵）", 12), replySuffixBox); after.Margin = new Thickness(0, 12, 0, 0); Grid.SetColumn(after, 1); format.Children.Add(after);
        page.Children.Add(Card(Stack(Txt("回复固定格式", 16, true), format, Txt("程序确保每条生成回答的正文带上前后缀，已有时不重复添加。留空关闭；群内 @ 提醒位于正文之前。命令和错误提示不添加。", 11, color: "#78877F", margin: new Thickness(0, 12, 0, 0)))));
        var advanced = new Grid(); for (var i = 0; i < 3; i++) advanced.ColumnDefinitions.Add(new());
        pollBox = new TextBox(); sendBox = new TextBox(); sendAction = new ComboBox(); foreach (var item in new[] { "Enter", "Ctrl + Enter", "控件按钮 Invoke" }) sendAction.Items.Add(item);
        pollBox.TextChanged += (_, _) => MarkDirty(); sendBox.TextChanged += (_, _) => MarkDirty(); sendAction.SelectionChanged += (_, _) => MarkDirty();
        var items = new[] { Stack(Txt("消息轮询间隔（毫秒）", 12), pollBox), Stack(Txt("发送间隔（毫秒）", 12), sendBox), Stack(Txt("微信发送快捷键", 12), sendAction) };
        for (var i = 0; i < items.Length; i++) { items[i].Margin = new Thickness(0, 14, i == 2 ? 0 : 20, 0); Grid.SetColumn(items[i], i); advanced.Children.Add(items[i]); }
        page.Children.Add(Card(Stack(Txt("运行节奏", 16, true), advanced, Txt("轮询最小 500 ms，发送最小 300 ms。快捷键必须与微信客户端设置一致。", 11, color: "#9BA59D", margin: new Thickness(0, 13, 0, 0)))));
        page.Children.Add(SaveBar()); return Scroll(page);
    }
    private UIElement SaveBar()
    {
        var row = new DockPanel(); var button = Btn("保存全部设置", async () => await SaveAll(), true); operationButtons.Add(button); DockPanel.SetDock(button, Dock.Right); row.Children.Add(button);
        var note = Txt("保存前请安全停止机器人与登录浏览器。修改将在下次启动生效。", 11, color: "#78877F"); note.VerticalAlignment = VerticalAlignment.Center; row.Children.Add(note); return row;
    }
    private void MarkDirty() { if (loadingEditors || editingSettings == null) return; dirty = true; toast.Text = "有未保存的设置。停止机器人后点击「保存全部设置」，再启动即可生效。"; if (startButton != null) startButton.IsEnabled = false; }
    private void LoadEditors()
    {
        if (editingSettings == null) return; loadingEditors = true;
        replyPrefixBox.Text = S(editingSettings["replyPrefix"]); replySuffixBox.Text = S(editingSettings["replySuffix"]);
        try { systemPrompt.Text = S(editingSettings["systemPrompt"]); prefixBox.Text = S(editingSettings["prefix"], "/gpt"); aliasBox.Text = editingSettings["prefixAliases"] is JsonArray aliases ? string.Join(", ", aliases.Select(a => S(a))) : "@ChatBOT, @chatbot"; prefixRequired.IsChecked = editingSettings["requirePrefix"]?.GetValue<bool>() ?? true; pollBox.Text = S(editingSettings["pollIntervalMs"], "1000"); sendBox.Text = S(editingSettings["sendIntervalMs"], "300"); sendAction.SelectedIndex = S(editingSettings["sendAction"]) switch { "ctrl-enter" => 1, "invoke" => 2, _ => 0 }; RefreshConversations(); }
        finally { loadingEditors = false; }
    }
    private async Task SaveAll()
    {
        if (editingSettings == null) return;
        if (!int.TryParse(pollBox.Text, out var poll) || !int.TryParse(sendBox.Text, out var send)) { toast.Text = "间隔必须填写整数毫秒。"; return; }
        var settings = editingSettings.DeepClone(); settings["systemPrompt"] = systemPrompt.Text; settings["prefix"] = prefixBox.Text; settings["prefixAliases"] = new JsonArray(aliasBox.Text.Split([',', '，'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(a => (JsonNode?)JsonValue.Create(a)).ToArray()); settings["requirePrefix"] = prefixRequired.IsChecked == true; settings["pollIntervalMs"] = poll; settings["sendIntervalMs"] = send; settings["sendAction"] = sendAction.SelectedIndex switch { 1 => "ctrl-enter", 2 => "invoke", _ => "enter" };
        settings["replyPrefix"] = replyPrefixBox.Text; settings["replySuffix"] = replySuffixBox.Text;
        await Operate("save", "正在校验并保存全部设置…", settings);
    }
    private void RefreshConversations()
    {
        if (conversationsGrid == null || editingSettings?["conversations"] is not JsonArray chats) return;
        var filter = searchBox?.Text ?? "";
        conversationsGrid.ItemsSource = chats.Select((c, i) => new ConversationRow(i, S(c?["name"]), S(c?["type"]) == "group" ? "群聊" : "联系人", c?["enabled"]?.GetValue<bool>() != false ? "● 已启用" : "已停用", string.IsNullOrWhiteSpace(S(c?["systemPrompt"])) ? "跟随全局风格" : S(c?["systemPrompt"]).Replace('\n', ' '), S(c?["id"]))).Where(c => c.Name.Contains(filter, StringComparison.OrdinalIgnoreCase)).ToList();
    }
    private void RemoveConversation()
    {
        if (conversationsGrid.SelectedItem is not ConversationRow row || editingSettings?["conversations"] is not JsonArray chats) { toast.Text = "请先选择一个会话。"; return; }
        chats.RemoveAt(row.Index); RefreshConversations(); MarkDirty();
    }
    private async Task NewConversation()
    {
        if (dirty) { toast.Text = "请先保存设置，再新建 GPT 对话。"; return; }
        if (conversationsGrid.SelectedItem is not ConversationRow row) { toast.Text = "请先选择一个会话。"; return; }
        await Operate("newConversation", "正在切换到新 GPT 对话…", new JsonObject { ["index"] = row.Index, ["name"] = row.Name });
    }
    private void EditConversation(int? index)
    {
        if (editingSettings?["conversations"] is not JsonArray chats) return;
        var old = index.HasValue ? chats[index.Value] : null;
        var dialog = new Window { Title = index.HasValue ? "编辑监听会话" : "添加监听会话", Owner = this, Width = 560, Height = 640, ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Brush("#F6F8F4") };
        var name = new TextBox { Text = S(old?["name"]), MaxLength = 150 }; var type = new ComboBox(); type.Items.Add("群聊"); type.Items.Add("联系人"); type.SelectedIndex = S(old?["type"], "group") == "group" ? 0 : 1;
        var id = new TextBox { Text = S(old?["id"]), MaxLength = 200 }; var enabled = new CheckBox { Content = "启用此会话的自动回复", IsChecked = old?["enabled"]?.GetValue<bool>() ?? true };
        var prompt = new TextBox { Text = S(old?["systemPrompt"]), AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 130, MaxLength = 16000, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        var error = Txt("", 11, color: "#B0523A");
        var save = Btn("保存到待保存设置", () => {
            if (string.IsNullOrWhiteSpace(name.Text)) { error.Text = "请填写微信中准确的群名或联系人名称。"; return; }
            if (chats.Where((_, i) => i != index).Any(c => S(c?["name"]) == name.Text.Trim() && c?["enabled"]?.GetValue<bool>() != false && enabled.IsChecked == true)) { error.Text = "已经有同名的启用会话，请使用唯一名称。"; return; }
            var value = new JsonObject { ["name"] = name.Text.Trim(), ["type"] = type.SelectedIndex == 0 ? "group" : "contact", ["enabled"] = enabled.IsChecked == true };
            if (!string.IsNullOrWhiteSpace(id.Text)) value["id"] = id.Text.Trim(); if (!string.IsNullOrWhiteSpace(prompt.Text)) value["systemPrompt"] = prompt.Text.Trim();
            if (index.HasValue) chats[index.Value] = value; else chats.Add(value); RefreshConversations(); MarkDirty(); dialog.Close();
        }, true);
        dialog.Content = new Border { Padding = new Thickness(28), Child = Stack(Txt("会话名称", 12, true), name, Txt("会话类型", 12, true, margin: new Thickness(0, 12, 0, 4)), type, Txt("稳定微信 ID（可选）", 12, true, margin: new Thickness(0, 12, 0, 4)), id, enabled, Txt("这个会话的补充提示词", 12, true, margin: new Thickness(0, 8, 0, 5)), prompt, Txt("留空跟随全局风格；填写后追加到全局提示词。", 11, color: "#78877F"), error, save) };
        dialog.ShowDialog();
    }
}
