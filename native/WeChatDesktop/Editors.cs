using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;

namespace WeChatDesktop;
public partial class MainWindow
{
    private TextBox systemPrompt = null!, prefixBox = null!, aliasBox = null!, pollBox = null!, sendBox = null!, searchBox = null!;
    private TextBox replyPrefixBox = null!, replySuffixBox = null!;
    private CheckBox prefixRequired = null!, styleEnabled = null!, mediaEnabled = null!;
    private TextBox personaBox = null!, languageStyleBox = null!, stylePreview = null!;
    private FrameworkElement styleFields = null!, instructionFields = null!;
    private readonly System.Windows.Threading.DispatcherTimer previewTimer = new() { Interval = TimeSpan.FromMilliseconds(300) };
    private int previewRevision;
    private ComboBox sendAction = null!, instructionTemplateBox = null!;
    private DataGrid conversationsGrid = null!;
    private TextBlock promptCount = null!, instructionCount = null!;
    private bool loadingEditors, updatingInstruction, instructionManuallyEdited;
    private sealed record ConversationRow(int Index, string Name, string Type, string Status, string Prompt, string Id);
    private sealed record InstructionTemplateChoice(string Id, string Name) { public override string ToString() => Name; }
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
        return EditorPage(page);
    }
    private FrameworkElement BuildStyle()
    {
        var page = new StackPanel();
        styleEnabled = new CheckBox { Content = "启用回答风格", IsChecked = true, FontWeight = FontWeights.SemiBold, FontSize = 15 };
        styleEnabled.Click += (_, _) => { MarkDirty(); SchedulePreview(); };
        page.Children.Add(Card(Stack(Txt("设定人物，编辑实际发送的首次指令。", 22, true),
            Txt("每个新 GPT 对话只发送一次首次指令；可以直接修改全文，或从已保存的模板快速切换。", 12, color: "#78877F", margin: new Thickness(0, 8, 0, 10)), styleEnabled,
            Txt("修改后请保存并新建 GPT 对话。关闭开关不会清除已有对话中的记忆。", 11, color: "#78877F"))));
        personaBox = StyleInput(2000, 105); languageStyleBox = StyleInput(2000, 82);
        replyPrefixBox = StyleInput(100); replySuffixBox = StyleInput(100);
        systemPrompt = StyleInput(16000, 115);
        promptCount = Txt("0 / 16,000", 10, color: "#9BA59D");
        systemPrompt.TextChanged += (_, _) => promptCount.Text = $"{systemPrompt.Text.Length:N0} / 16,000";
        var presets = new WrapPanel { Margin = new Thickness(0, 10, 0, 14) };
        foreach (var (label, persona, language) in new[] {
            ("劳大 · 群聊", "姓名：劳大\n年龄：42\n现居地：地狱\n特长爱好：打篮球、肘击\n最喜欢的东西：冰红茶\n最讨厌的东西：直升机", "口癖：阐述事实观点前说“孩子们”；震惊或愤怒时用“man！”；无奈或失望时说“what can i say”；表达失败或淘汰时用“out”或“mamba out”。"),
            ("猫娘 · 甜蜜", "猫娘", "甜蜜、温柔、俏皮，使用自然中文"),
            ("助手 · 简洁", "聊天助手", "简洁、直接，先回答核心问题"),
            ("顾问 · 严谨", "专业顾问", "严谨、清晰，区分事实与推测") }) {
            presets.Children.Add(Btn(label, () => { personaBox.Text = persona; languageStyleBox.Text = language; }, margin: new Thickness(0, 0, 8, 8)));
        }
        var fields = Stack(Txt("快速填入人物与语气", 12, true), presets,
            Txt("01  人物设定", 13, true), personaBox, Txt("可填写姓名、经历、性格、爱好、禁忌等完整设定。", 11, color: "#78877F"),
            Txt("02  语言风格", 13, true, margin: new Thickness(0, 14, 0, 0)), languageStyleBox);
        var format = new Grid { Margin = new Thickness(0, 14, 0, 14) }; format.ColumnDefinitions.Add(new()); format.ColumnDefinitions.Add(new());
        var before = Stack(Txt("03  固定前缀", 13, true), replyPrefixBox); before.Margin = new Thickness(0, 0, 12, 0); format.Children.Add(before);
        var after = Stack(Txt("04  固定后缀", 13, true), replySuffixBox); Grid.SetColumn(after, 1); format.Children.Add(after); fields.Children.Add(format);
        fields.Children.Add(Txt("前后缀留空可省略；程序补齐缺失内容，已有时不重复。", 11, color: "#78877F"));
        fields.Children.Add(new Expander { Header = "05  补充要求（可选）", IsExpanded = false, Margin = new Thickness(0, 14, 0, 0), Content = Stack(systemPrompt, promptCount) });
        fields.Children.Add(Btn("按左侧设定重建首次指令", async () => await RegenerateInstruction(), true, new Thickness(0, 18, 0, 0)));
        fields.Children.Add(Txt("重建会覆盖右侧当前指令；之后仍可直接编辑全文。", 11, color: "#78877F", margin: new Thickness(0, 8, 0, 0)));
        styleFields = fields;
        var columns = new Grid(); columns.ColumnDefinitions.Add(new() { Width = new GridLength(1.15, GridUnitType.Star) }); columns.ColumnDefinitions.Add(new());
        columns.Children.Add(Card(fields, new Thickness(0, 0, 16, 0)));
        instructionTemplateBox = new ComboBox { Margin = new Thickness(0, 8, 0, 8) };
        var templateActions = new WrapPanel();
        templateActions.Children.Add(Btn("使用所选模板", UseInstructionTemplate, true, new Thickness(0, 0, 8, 8)));
        templateActions.Children.Add(Btn("保存为新模板", AddInstructionTemplate, margin: new Thickness(0, 0, 8, 8)));
        templateActions.Children.Add(Btn("删除模板", RemoveInstructionTemplate, margin: new Thickness(0, 0, 0, 8)));
        stylePreview = new TextBox { IsReadOnly = false, MaxLength = 16000, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 430,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Brush("#F5F8F3"), FontSize = 12, Padding = new Thickness(12), Margin = new Thickness(0, 8, 0, 4) };
        instructionCount = Txt("0 / 16,000", 10, color: "#9BA59D"); instructionCount.HorizontalAlignment = HorizontalAlignment.Right;
        stylePreview.TextChanged += (_, _) => {
            instructionCount.Text = $"{stylePreview.Text.Length:N0} / 16,000";
            if (loadingEditors || updatingInstruction) return;
            instructionManuallyEdited = true; previewRevision++;
            if (editingSettings != null) editingSettings["selectedInstructionTemplateId"] = "";
            instructionTemplateBox.SelectedIndex = -1; MarkDirty();
        };
        instructionFields = Stack(Txt("指令模板", 12, true), instructionTemplateBox, templateActions,
            Txt("选择后点击使用；新模板保存当前指令全文。", 11, color: "#78877F"),
            Txt("首次发送的指令", 16, true, margin: new Thickness(0, 16, 0, 0)),
            Txt("可直接修改 · 保存后与后端实际指令一致", 11, color: "#78877F", margin: new Thickness(0, 6, 0, 0)), stylePreview, instructionCount,
            Txt("初始化确认不会转发到微信。会话自己的补充要求会在发送时追加。", 11, color: "#78877F", margin: new Thickness(0, 8, 0, 0)));
        var preview = Card(instructionFields, new Thickness(0));
        preview.VerticalAlignment = VerticalAlignment.Top; Grid.SetColumn(preview, 1); columns.Children.Add(preview); page.Children.Add(columns);
        previewTimer.Tick += async (_, _) => { previewTimer.Stop(); await RefreshPreview(); };
        return EditorPage(page);
    }
    private TextBox StyleInput(int maximum, double height = 38)
    {
        var box = new TextBox { MaxLength = maximum, Height = height, AcceptsReturn = height > 38, TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = height > 38 ? ScrollBarVisibility.Auto : ScrollBarVisibility.Hidden, Margin = new Thickness(0, 7, 0, 6) };
        box.TextChanged += (_, _) => { MarkDirty(); SchedulePreview(); }; return box;
    }
    private void ApplyStyleFields(JsonNode settings)
    {
        settings["styleEnabled"] = styleEnabled.IsChecked == true; settings["persona"] = personaBox.Text; settings["languageStyle"] = languageStyleBox.Text;
        settings["systemPrompt"] = systemPrompt.Text; settings["replyPrefix"] = replyPrefixBox.Text; settings["replySuffix"] = replySuffixBox.Text;
    }
    private void SchedulePreview()
    {
        if (loadingEditors || editingSettings == null || stylePreview == null) return;
        styleFields.IsEnabled = styleEnabled.IsChecked == true; instructionFields.IsEnabled = styleEnabled.IsChecked == true;
        if (styleEnabled.IsChecked != true || instructionManuallyEdited) return;
        previewRevision++; previewTimer.Stop(); previewTimer.Start();
    }
    private async Task RegenerateInstruction()
    {
        if (styleEnabled.IsChecked != true) { toast.Text = "请先启用回答风格。"; return; }
        instructionManuallyEdited = false;
        if (editingSettings != null) editingSettings["selectedInstructionTemplateId"] = "";
        instructionTemplateBox.SelectedIndex = -1; await RefreshPreview(true); MarkDirty();
    }
    private async Task RefreshPreview(bool force = false)
    {
        if (editingSettings == null || closing || styleEnabled.IsChecked != true || (!force && instructionManuallyEdited)) return;
        var revision = previewRevision; var settings = editingSettings.DeepClone(); ApplyStyleFields(settings);
        settings["initialInstruction"] = "";
        try {
            var result = await host.Call("composeInstruction", settings);
            if (revision == previewRevision && !closing) SetInstructionText(result?["instructions"]?.ToString() ?? "", false);
        } catch (Exception ex) { if (revision == previewRevision) toast.Text = "生成首次指令失败：" + ex.Message; }
    }
    private void SetInstructionText(string text, bool manual)
    {
        updatingInstruction = true;
        try { stylePreview.Text = text; instructionManuallyEdited = manual; previewRevision++; }
        finally { updatingInstruction = false; }
    }
    private void RefreshInstructionTemplates(string? preferredId = null)
    {
        if (instructionTemplateBox == null || editingSettings?["instructionTemplates"] is not JsonArray templates) return;
        var selectedId = preferredId ?? S(editingSettings["selectedInstructionTemplateId"]);
        var choices = templates.Select(t => new InstructionTemplateChoice(S(t?["id"]), S(t?["name"]))).ToList();
        instructionTemplateBox.ItemsSource = choices;
        instructionTemplateBox.SelectedItem = choices.FirstOrDefault(choice => choice.Id == selectedId);
    }
    private void UseInstructionTemplate()
    {
        if (editingSettings?["instructionTemplates"] is not JsonArray templates || instructionTemplateBox.SelectedItem is not InstructionTemplateChoice choice) { toast.Text = "请先选择一个指令模板。"; return; }
        var template = templates.FirstOrDefault(item => S(item?["id"]) == choice.Id);
        if (template == null) { toast.Text = "所选指令模板已不存在。"; return; }
        SetInstructionText(S(template["content"]), true); editingSettings["selectedInstructionTemplateId"] = choice.Id;
        RefreshInstructionTemplates(choice.Id); MarkDirty(); toast.Text = $"已使用指令模板「{choice.Name}」，请保存全部设置。";
    }
    private void AddInstructionTemplate()
    {
        if (editingSettings?["instructionTemplates"] is not JsonArray templates) return;
        if (string.IsNullOrWhiteSpace(stylePreview.Text)) { toast.Text = "首次指令为空，无法保存为模板。"; return; }
        if (templates.Count >= 50) { toast.Text = "最多保存 50 个指令模板。"; return; }
        var dialog = new Window { Title = "保存指令模板", Owner = this, Width = 460, Height = 260, ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Brush("#F6F8F4") };
        var name = new TextBox { MaxLength = 80, Margin = new Thickness(0, 8, 0, 8) };
        var error = Txt("", 11, color: "#B0523A");
        var save = Btn("添加到模板列表", () => {
            var trimmed = name.Text.Trim();
            if (string.IsNullOrWhiteSpace(trimmed)) { error.Text = "请填写模板名称。"; return; }
            if (templates.Any(item => string.Equals(S(item?["name"]), trimmed, StringComparison.OrdinalIgnoreCase))) { error.Text = "已经存在同名模板。"; return; }
            var id = Guid.NewGuid().ToString("N");
            templates.Add(new JsonObject { ["id"] = id, ["name"] = trimmed, ["content"] = stylePreview.Text.Trim() });
            editingSettings["selectedInstructionTemplateId"] = id; RefreshInstructionTemplates(id); MarkDirty(); dialog.Close();
            toast.Text = $"已添加模板「{trimmed}」，点击「保存全部设置」后持久保存。";
        }, true);
        dialog.Content = new Border { Padding = new Thickness(28), Child = Stack(Txt("模板名称", 13, true), name, Txt("将保存当前“首次发送的指令”全文。", 11, color: "#78877F"), error, save) };
        dialog.ShowDialog();
    }
    private void RemoveInstructionTemplate()
    {
        if (editingSettings?["instructionTemplates"] is not JsonArray templates || instructionTemplateBox.SelectedItem is not InstructionTemplateChoice choice) { toast.Text = "请先选择要删除的指令模板。"; return; }
        if (choice.Id == "builtin-laoda") { toast.Text = "默认的「劳大」模板会始终保留。"; return; }
        for (var i = 0; i < templates.Count; i++) if (S(templates[i]?["id"]) == choice.Id) { templates.RemoveAt(i); break; }
        if (S(editingSettings["selectedInstructionTemplateId"]) == choice.Id) editingSettings["selectedInstructionTemplateId"] = "";
        RefreshInstructionTemplates("builtin-laoda"); MarkDirty(); toast.Text = $"已从待保存设置中删除模板「{choice.Name}」。";
    }
    private FrameworkElement BuildSettings()
    {
        var page = new StackPanel();
        mediaEnabled = new CheckBox { Content = "解析本地图片 / 表情并上传给 ChatGPT", IsChecked = false, FontSize = 14 };
        mediaEnabled.Click += (_, _) => MarkDirty();
        page.Children.Add(Card(Stack(Txt("图片与表情", 21, true), Txt("可选功能 · 默认关闭", 12, color: "#22765A", margin: new Thickness(0, 8, 0, 10)), mediaEnabled,
            Txt("开启后，已启用会话中的图片和表情可作为附件上传。群聊中先发图，再用 @ 别名提问，会附带最近尚未提交的上下文。", 13, margin: new Thickness(0, 8, 0, 10)),
            Txt("关闭触发词限制时，新图片也可直接触发回复。动态表情上传首帧；本地未下载或无法解码的媒体保留文字占位。仅数据库读取模式支持。", 12, color: "#78877F"))));
        var advanced = new Grid(); for (var i = 0; i < 3; i++) advanced.ColumnDefinitions.Add(new());
        pollBox = new TextBox(); sendBox = new TextBox(); sendAction = new ComboBox(); foreach (var item in new[] { "Enter", "Ctrl + Enter", "控件按钮 Invoke" }) sendAction.Items.Add(item);
        pollBox.TextChanged += (_, _) => MarkDirty(); sendBox.TextChanged += (_, _) => MarkDirty(); sendAction.SelectionChanged += (_, _) => MarkDirty();
        var items = new[] { Stack(Txt("消息轮询间隔（毫秒）", 12), pollBox), Stack(Txt("发送间隔（毫秒）", 12), sendBox), Stack(Txt("微信发送快捷键", 12), sendAction) };
        for (var i = 0; i < items.Length; i++) { items[i].Margin = new Thickness(0, 14, i == 2 ? 0 : 20, 0); Grid.SetColumn(items[i], i); advanced.Children.Add(items[i]); }
        page.Children.Add(Card(Stack(Txt("运行节奏", 16, true), advanced, Txt("轮询最小 500 ms，发送最小 300 ms。快捷键需与微信设置一致。", 12, color: "#78877F", margin: new Thickness(0, 13, 0, 0)))));
        return EditorPage(page);
    }
    private FrameworkElement EditorPage(UIElement content)
    {
        var grid = new Grid(); grid.RowDefinitions.Add(new()); grid.RowDefinitions.Add(new() { Height = GridLength.Auto });
        grid.Children.Add(Scroll(content));
        var footer = new Border { Background = Brush("#F6F8F4"), Padding = new Thickness(0, 16, 10, 0), Child = SaveBar() };
        Grid.SetRow(footer, 1); grid.Children.Add(footer); return grid;
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
        styleEnabled.IsChecked = editingSettings["styleEnabled"]?.GetValue<bool>() ?? true;
        mediaEnabled.IsChecked = editingSettings["mediaEnabled"]?.GetValue<bool>() ?? false;
        personaBox.Text = S(editingSettings["persona"], S(editingSettings["role"])); languageStyleBox.Text = S(editingSettings["languageStyle"]);
        replyPrefixBox.Text = S(editingSettings["replyPrefix"]); replySuffixBox.Text = S(editingSettings["replySuffix"]);
        try { systemPrompt.Text = S(editingSettings["systemPrompt"]); prefixBox.Text = S(editingSettings["prefix"], "/gpt"); aliasBox.Text = editingSettings["prefixAliases"] is JsonArray aliases ? string.Join(", ", aliases.Select(a => S(a))) : "@ChatBOT, @chatbot"; prefixRequired.IsChecked = editingSettings["requirePrefix"]?.GetValue<bool>() ?? true; pollBox.Text = S(editingSettings["pollIntervalMs"], "1000"); sendBox.Text = S(editingSettings["sendIntervalMs"], "300"); sendAction.SelectedIndex = S(editingSettings["sendAction"]) switch { "ctrl-enter" => 1, "invoke" => 2, _ => 0 }; RefreshConversations(); RefreshInstructionTemplates(); var initial = S(editingSettings["initialInstruction"]); SetInstructionText(initial, !string.IsNullOrWhiteSpace(initial)); }
        finally { loadingEditors = false; SchedulePreview(); }
    }
    private async Task SaveAll()
    {
        if (editingSettings == null) return;
        if (!int.TryParse(pollBox.Text, out var poll) || !int.TryParse(sendBox.Text, out var send)) { toast.Text = "间隔必须填写整数毫秒。"; return; }
        var settings = editingSettings.DeepClone(); settings["systemPrompt"] = systemPrompt.Text; settings["prefix"] = prefixBox.Text; settings["prefixAliases"] = new JsonArray(aliasBox.Text.Split([',', '，'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(a => (JsonNode?)JsonValue.Create(a)).ToArray()); settings["requirePrefix"] = prefixRequired.IsChecked == true; settings["pollIntervalMs"] = poll; settings["sendIntervalMs"] = send; settings["sendAction"] = sendAction.SelectedIndex switch { 1 => "ctrl-enter", 2 => "invoke", _ => "enter" };
        settings["replyPrefix"] = replyPrefixBox.Text; settings["replySuffix"] = replySuffixBox.Text;
        ApplyStyleFields(settings); settings["initialInstruction"] = stylePreview.Text; settings["mediaEnabled"] = mediaEnabled.IsChecked == true;
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
