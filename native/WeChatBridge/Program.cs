using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Forms;
using AutomationCondition = System.Windows.Automation.Condition;

namespace WeChatBridge;

internal sealed record Request(
    int Id,
    string Operation,
    string? DisplayName,
    string? Text,
    string? FilePath,
    bool? RequirePrefix,
    string[]? Prefixes,
    string[]? CanonicalNames,
    bool? ResumeVerifiedDraft);
internal sealed record HealthState(bool ProcessRunning, bool WindowFound, bool LoggedIn, string? WindowTitle, string? Detail,
    int ProtocolVersion = 2, string SendMode = "uia", bool WindowMinimized = false, string SendAction = "enter");
internal sealed record SendReceipt(bool Submitted, bool Verified, string Transport, string Confirmation, string Action);
internal sealed class DeliveryException(string message, bool deliveryUnknown = false) : Exception(message)
{
    public bool DeliveryUnknown { get; } = deliveryUnknown;
}
internal sealed record IncomingMessage(string MessageId, string UserId, string DisplayName, string Text, long Timestamp, bool IsSelf);
internal sealed record DiagnosticElement(string Type, string AutomationId, int X, int Y, int Width, int Height, int NameLength, bool UnreadMatch, int DescendantCount);

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    [STAThread]
    private static void Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        var automation = new WeChatAutomation();
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            Request? request = null;
            try
            {
                request = JsonSerializer.Deserialize<Request>(line, JsonOptions)
                    ?? throw new InvalidOperationException("Invalid request");
                object? result = request.Operation switch
                {
                    "health" => automation.Health(),
                    "poll" => DesktopOperationLease.Run(() => automation.Poll(request)),
                    "send" => DesktopOperationLease.Run(() => Send(automation, request)),
                    "select" => DesktopOperationLease.Run(() => Select(automation, request)),
                    "snapshot" => Snapshot(automation, request),
                    "inspect" => automation.Inspect(),
                    "windows-inspect" => automation.InspectWindows(),
                    "lease-self-test" => new { tests = DesktopOperationLease.SelfTest() },
                    "header-self-test" => new { tests = ChatHeaderVerifierTests.Run() },
                    "header-inspect" => automation.InspectHeader(request.DisplayName
                        ?? throw new ArgumentException("displayName is required")),
                    "ocr-inspect" => automation.OcrInspect(),
                    "stop" => new { stopped = true },
                    _ => throw new InvalidOperationException($"Unknown operation: {request.Operation}")
                };
                Write(new { id = request.Id, ok = true, result });
                if (request.Operation == "stop") break;
            }
            catch (Exception error)
            {
                var unknown = error is DeliveryException delivery && delivery.DeliveryUnknown;
                Write(new { id = request?.Id ?? 0, ok = false, error = error.Message,
                    code = request?.Operation == "send"
                        ? unknown ? "WECHAT_DELIVERY_UNKNOWN" : "WECHAT_SEND_REJECTED"
                        : "WECHAT_BRIDGE_ERROR",
                    deliveryUnknown = unknown });
            }
        }
    }

    private static object Send(WeChatAutomation automation, Request request)
    {
        if (string.IsNullOrWhiteSpace(request.DisplayName) || string.IsNullOrWhiteSpace(request.Text))
            throw new ArgumentException("displayName and text are required");
        return automation.Send(request.DisplayName, request.Text, request.ResumeVerifiedDraft == true);
    }

    private static object Select(WeChatAutomation automation, Request request)
    {
        if (string.IsNullOrWhiteSpace(request.DisplayName))
            throw new ArgumentException("displayName is required");
        automation.Select(request.DisplayName);
        return new { selected = true };
    }

    private static object Snapshot(WeChatAutomation automation, Request request)
    {
        if (string.IsNullOrWhiteSpace(request.FilePath)) throw new ArgumentException("filePath is required");
        automation.Snapshot(request.FilePath);
        return new { saved = true };
    }

    private static void Write(object value) => Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
}

internal sealed class WeChatAutomation
{
    private static string SendAction
    {
        get
        {
            var action = (Environment.GetEnvironmentVariable("WECHAT_SEND_ACTION") ?? "enter").Trim().ToLowerInvariant();
            return action is "enter" or "ctrl-enter" or "invoke" ? action
                : throw new InvalidOperationException("WECHAT_SEND_ACTION 只能是 enter、ctrl-enter 或 invoke");
        }
    }
    private static string SendMode
    {
        get
        {
            var mode = (Environment.GetEnvironmentVariable("WECHAT_SEND_MODE") ?? "uia").Trim().ToLowerInvariant();
            return mode is "uia" or "legacy" ? mode
                : throw new InvalidOperationException("WECHAT_SEND_MODE 只能是 uia 或 legacy");
        }
    }
    private static readonly string[] ProcessNames = ["Weixin", "WeChat", "WeChatAppEx"];
    private static readonly Regex UnreadRegex = new(@"(?:(\d+)\s*条)?新消息|unread", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TimeRegex = new(@"^(\d{1,2}:\d{2}|昨天|星期.|周.|\d{1,2}/\d{1,2})$", RegexOptions.Compiled);
    private static readonly string[] IgnoredLabels = ["搜索", "通讯录", "聊天", "收藏", "朋友圈", "小程序", "视频号", "Search", "Contacts", "Chats"];

    public HealthState Health()
    {
        var processes = FindProcesses();
        var window = FindWindow(processes);
        if (window is null) return new(processes.Count > 0, false, false, null, "请启动 Windows 官方微信客户端并完成登录", SendMode: SendMode, SendAction: SendAction);
        var title = Safe(() => window.Current.Name) ?? string.Empty;
        var rect = SafeRect(window);
        var descendants = FindDescendants(window).Cast<AutomationElement>().ToList();
        var exposedControls = descendants.Any(IsConversationOrEditor);
        var mainWindowSize = !rect.IsEmpty && rect.Width >= 650 && rect.Height >= 450;
        var explicitLogin = Regex.IsMatch(title, "登录|login", RegexOptions.IgnoreCase);
        var minimized = IsIconic(new IntPtr(window.Current.NativeWindowHandle));
        var loggedIn = !explicitLogin && (exposedControls || mainWindowSize);
        var detail = loggedIn
            ? $"ready; size={(int)rect.Width}x{(int)rect.Height}; accessible_elements={descendants.Count}"
            : minimized ? $"微信窗口已最小化，当前无法判定登录或发送控件能力; accessible_elements={descendants.Count}"
            : $"微信窗口存在，但尚未检测到已登录聊天界面; size={(int)rect.Width}x{(int)rect.Height}; accessible_elements={descendants.Count}";
        return new(true, true, loggedIn, title, detail, SendMode: SendMode, WindowMinimized: minimized, SendAction: SendAction);
    }

    public IReadOnlyList<IncomingMessage> Poll(Request request)
    {
        var root = RequireLoggedInWindow();
        var unread = FindUnreadConversations(root).ToList();
        if (unread.Count == 0 && !FindDescendants(root).Cast<AutomationElement>().Any(IsConversationOrEditor))
            return WeChatVision.Poll(
                root,
                CaptureBitmap,
                CaptureScreenBitmap,
                Click,
                RightClick,
                request.RequirePrefix ?? false,
                request.Prefixes ?? [],
                request.CanonicalNames ?? []);
        var result = new List<IncomingMessage>();
        foreach (var conversation in unread)
        {
            var name = GetConversationDisplayName(conversation);
            if (string.IsNullOrWhiteSpace(name)) continue;
            var automationId = Safe(() => conversation.Current.AutomationId) ?? string.Empty;
            var identity = string.IsNullOrWhiteSpace(automationId) || Regex.IsMatch(automationId, "^(list|item|button)", RegexOptions.IgnoreCase)
                ? name
                : automationId;
            var unreadCount = ParseUnreadCount(Safe(() => conversation.Current.Name) ?? string.Empty);
            Activate(conversation);
            Thread.Sleep(250);
            result.AddRange(ReadLatestMessages(root, name, identity, unreadCount));
        }
        return result;
    }

    public object Inspect()
    {
        var root = RequireLoggedInWindow();
        var rootRect = SafeRect(root);
        var descendants = FindDescendants(root).Cast<AutomationElement>().ToList();
        var counts = descendants.GroupBy(TypeName).ToDictionary(group => group.Key, group => group.Count());
        var leftCandidates = descendants
            .Where(IsConversationCandidate)
            .Select(element => ToDiagnostic(element, rootRect))
            .Where(item => item.X < rootRect.Width * 0.5)
            .Take(100)
            .ToList();
        return new
        {
            protocolVersion = 2,
            sendMode = SendMode,
            sendAction = SendAction,
            windowMinimized = IsIconic(new IntPtr(root.Current.NativeWindowHandle)),
            windowClass = Safe(() => root.Current.ClassName),
            title = Safe(() => root.Current.Name) ?? string.Empty,
            width = (int)rootRect.Width,
            height = (int)rootRect.Height,
            accessibleElementCount = descendants.Count,
            controlTypeCounts = counts,
            leftCandidates,
            unreadCandidateCount = leftCandidates.Count(item => item.UnreadMatch),
            sendCapabilities = new
            {
                readableComposer = FindChatEditor(root) is { } editor && CanReadText(editor),
                invokableSendButton = FindSendButton(root) is not null,
                composer = InspectComposer(root),
                sendButton = InspectSendButton(root),
                note = "严格 UIA 发送要求唯一目标、前台输入焦点和草稿核验；仅 invoke 动作要求发送按钮，不自动切换提交动作或使用坐标点击"
            }
        };
    }

    public object OcrInspect()
    {
        var root = RequireLoggedInWindow();
        return WeChatVision.Inspect(root, CaptureBitmap);
    }

    public object InspectWindows()
    {
        var processIds = FindProcesses().Select(process => (uint)process.Id).ToHashSet();
        var windows = new List<object>();
        EnumWindows((handle, _) =>
        {
            GetWindowThreadProcessId(handle, out var processId);
            if (!processIds.Contains(processId)) return true;
            var element = Safe(() => AutomationElement.FromHandle(handle));
            var name = element is not null ? Safe(() => element.Current.Name) ?? string.Empty : string.Empty;
            var className = element is not null ? Safe(() => element.Current.ClassName) ?? string.Empty : string.Empty;
            GetWindowRect(handle, out var rect);
            windows.Add(new { processId, handle = handle.ToInt64(), visible = IsWindowVisible(handle),
                minimized = IsIconic(handle), width = rect.Right - rect.Left, height = rect.Bottom - rect.Top,
                className, nameLength = name.Length, nameIsMain = name is "微信" or "WeChat" or "Weixin",
                uiaAvailable = element is not null });
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public SendReceipt Send(string displayName, string text, bool resumeVerifiedDraft = false)
    {
        var root = RequireLoggedInWindow();
        if (SendMode == "legacy")
        {
            // Legacy automation cannot prove whether an exception occurred before submission.
            try { SendLegacy(root, displayName, text); }
            catch (Exception error) { throw new DeliveryException(error.Message, true); }
            return new(true, false, "legacy", "unverified", "legacy-enter");
        }
        EnsureInteractiveWindow(root);
        SelectStrict(root, displayName);
        var editor = FindChatEditor(root)
            ?? throw new DeliveryException("当前微信未暴露可访问的聊天输入框；严格 UIA 模式已停止发送");
        var draft = ReadText(editor);
        var resume = !string.IsNullOrEmpty(draft) && resumeVerifiedDraft
            && string.Equals(draft, NormalizeEditorText(text), StringComparison.Ordinal);
        if (!string.IsNullOrEmpty(draft) && !resume)
            throw new DeliveryException("目标聊天输入框存在草稿，已停止发送以避免覆盖或混入草稿");
        var action = SendAction;
        if (action == "invoke" && FindSendButton(root) is null)
            throw new DeliveryException("当前微信未暴露可 Invoke 的发送按钮；严格 UIA 模式已停止发送");
        // Re-check the target after control discovery and immediately before submission.
        RequireTargetHeader(root, displayName);
        if (!resume) SetTextVerified(root, editor, text);
        RequireTargetHeader(root, displayName);
        if (!string.Equals(ReadText(editor), NormalizeEditorText(text), StringComparison.Ordinal))
            throw new DeliveryException("微信输入框内容与待发送内容不一致，已停止发送");
        // Qt can replace child providers when the composer changes. Never submit
        // using a button captured before filling the composer.
        editor = FindChatEditor(root) ?? throw new DeliveryException("微信输入框已失效，已停止发送");
        editor.SetFocus();
        RequireInputFocus(root, editor);
        RequireTargetHeader(root, displayName);
        if (!string.Equals(ReadText(editor), NormalizeEditorText(text), StringComparison.Ordinal))
            throw new DeliveryException("微信输入框内容发生变化，已停止发送");
        var send = action == "invoke" ? FindSendButton(root) : null;
        var submitted = false;
        try
        {
            object? pattern = null;
            if (action == "invoke" && (send is null || !send.Current.IsEnabled
                || !send.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)))
                throw new DeliveryException("微信发送按钮不可用，已停止发送");
            RequireInputFocus(root, editor);
            RequireTargetHeader(root, displayName);
            // Perform exactly one configured action. A failed Invoke is never
            // followed by Enter, and a configured Enter is never repeated.
            submitted = true;
            if (action == "invoke") ((InvokePattern)pattern!).Invoke();
            else SendKeys.SendWait(action == "ctrl-enter" ? "^{ENTER}" : "{ENTER}");
            var confirmed = WaitUntil(() =>
            {
                var currentEditor = FindChatEditor(root);
                return currentEditor is not null && HasTargetHeader(root, displayName)
                    && string.IsNullOrEmpty(ReadText(currentEditor));
            }, 3_000);
            if (!confirmed) throw new DeliveryException($"已执行 {action} 提交但未能确认输入框清空，请人工核对，勿自动重发", true);
            return new(true, true, "uia", "composer-cleared", action);
        }
        catch (Exception error)
        {
            throw new DeliveryException(error.Message, submitted);
        }
    }

    private static void SendLegacy(AutomationElement root, string displayName, string text)
    {
        if (!FindDescendants(root).Cast<AutomationElement>().Any(IsConversationOrEditor))
        {
            WeChatVision.Send(root, displayName, text, CaptureBitmap, Click);
            return;
        }
        var conversation = FindConversation(root, displayName);
        if (conversation is not null)
        {
            Activate(conversation);
        }
        else
        {
            var search = FindSearchEditor(root)
                ?? throw new InvalidOperationException("找不到微信搜索框，可能需要更新 UI 定位规则");
            SetText(search, displayName);
            Thread.Sleep(250);
            SendKeys.SendWait("{ENTER}");
        }
        Thread.Sleep(250);
        var editor = FindChatEditor(root)
            ?? throw new InvalidOperationException("找不到微信聊天输入框，可能需要更新 UI 定位规则");
        SetText(editor, text);
        SendKeys.SendWait("{ENTER}");
    }

    public void Select(string displayName)
    {
        var root = RequireLoggedInWindow();
        var conversation = FindConversation(root, displayName);
        if (conversation is not null)
        {
            Activate(conversation);
            return;
        }
        WeChatVision.Select(root, displayName, CaptureBitmap, Click);
    }

    public void Snapshot(string filePath)
    {
        var root = FindWindow(FindProcesses()) ?? throw new InvalidOperationException("微信窗口不存在，无法截图");
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        using var bitmap = CaptureBitmap(root);
        bitmap.Save(filePath, ImageFormat.Png);
    }

    private static Bitmap CaptureBitmap(AutomationElement root)
    {
        var rect = root.Current.BoundingRectangle;
        if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) throw new InvalidOperationException("微信窗口尺寸无效");
        var bitmap = new Bitmap((int)rect.Width, (int)rect.Height);
        using var graphics = Graphics.FromImage(bitmap);
        var windowHandle = new IntPtr(root.Current.NativeWindowHandle);
        var deviceContext = graphics.GetHdc();
        var captured = false;
        try { captured = PrintWindow(windowHandle, deviceContext, 2); }
        finally { graphics.ReleaseHdc(deviceContext); }
        if (!captured) graphics.CopyFromScreen((int)rect.Left, (int)rect.Top, 0, 0, bitmap.Size);
        return bitmap;
    }

    private static Bitmap CaptureScreenBitmap(AutomationElement root)
    {
        var rect = root.Current.BoundingRectangle;
        if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) throw new InvalidOperationException("微信窗口尺寸无效");
        var bitmap = new Bitmap((int)rect.Width, (int)rect.Height);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.CopyFromScreen((int)rect.Left, (int)rect.Top, 0, 0, bitmap.Size);
        return bitmap;
    }

    private static List<Process> FindProcesses() => ProcessNames
        .SelectMany(Process.GetProcessesByName)
        .Where(process => !process.HasExited)
        .ToList();

    private static AutomationElement? FindWindow(IEnumerable<Process> processes)
    {
        var processList = processes.ToList();
        var candidates = new List<AutomationElement>();
        var handles = new HashSet<IntPtr>();
        foreach (var process in processList)
        {
            if (process.MainWindowHandle == IntPtr.Zero) continue;
            var element = Safe(() => AutomationElement.FromHandle(process.MainWindowHandle));
            if (element is not null && handles.Add(process.MainWindowHandle)) candidates.Add(element);
        }
        var processIds = processList.Select(item => (uint)item.Id).ToHashSet();
        EnumWindows((handle, _) =>
        {
            GetWindowThreadProcessId(handle, out var processId);
            if (!processIds.Contains(processId) || !IsWindowVisible(handle)) return true;
            if (!GetWindowRect(handle, out var rect) || rect.Right - rect.Left < 240 || rect.Bottom - rect.Top < 240) return true;
            var element = Safe(() => AutomationElement.FromHandle(handle));
            if (element is not null && handles.Add(handle)) candidates.Add(element);
            return true;
        }, IntPtr.Zero);
        return candidates
            .Where(element => Regex.IsMatch(Safe(() => element.Current.Name) ?? string.Empty, @"^(微信|WeChat|Weixin)$", RegexOptions.IgnoreCase)
                || string.Equals(Safe(() => element.Current.ClassName), "mmui::MainWindow", StringComparison.Ordinal))
            .OrderByDescending(element =>
            {
                var rect = SafeRect(element);
                return rect.IsEmpty ? 0 : rect.Width * rect.Height;
            })
            .FirstOrDefault();
    }

    private static AutomationElement RequireLoggedInWindow()
    {
        var processes = FindProcesses();
        var window = FindWindow(processes) ?? throw new InvalidOperationException("未找到 Windows 官方微信主窗口");
        var title = Safe(() => window.Current.Name) ?? string.Empty;
        if (Regex.IsMatch(title, "登录|login", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("微信客户端尚未登录");
        return window;
    }

    private static AutomationElementCollection FindDescendants(AutomationElement root) =>
        root.FindAll(TreeScope.Descendants, AutomationCondition.TrueCondition);

    private static bool IsConversationOrEditor(AutomationElement element)
    {
        var type = Safe(() => element.Current.ControlType);
        return type == ControlType.List || type == ControlType.ListItem || type == ControlType.Edit || type == ControlType.Document;
    }

    private static IEnumerable<AutomationElement> FindUnreadConversations(AutomationElement root)
    {
        var rootRect = root.Current.BoundingRectangle;
        foreach (AutomationElement element in FindDescendants(root))
        {
            var type = Safe(() => element.Current.ControlType);
            if (!IsConversationCandidate(element)) continue;
            var rect = SafeRect(element);
            if (rect.IsEmpty || rect.Left > rootRect.Left + rootRect.Width * 0.46) continue;
            var name = Safe(() => element.Current.Name) ?? string.Empty;
            var subtreeText = name + " " + string.Join(" ", element.FindAll(TreeScope.Descendants, AutomationCondition.TrueCondition)
                .Cast<AutomationElement>().Select(item => Safe(() => item.Current.Name) ?? string.Empty));
            if (UnreadRegex.IsMatch(subtreeText)) yield return element;
        }
    }

    private static AutomationElement? FindConversation(AutomationElement root, string displayName)
    {
        var rootRect = root.Current.BoundingRectangle;
        return FindDescendants(root).Cast<AutomationElement>().FirstOrDefault(element =>
        {
            var type = Safe(() => element.Current.ControlType);
            var rect = SafeRect(element);
            var name = GetConversationDisplayName(element);
            return (type == ControlType.ListItem || type == ControlType.Button || type == ControlType.Custom || type == ControlType.DataItem)
                && !rect.IsEmpty && rect.Left < rootRect.Left + rootRect.Width * 0.46
                && string.Equals(name, displayName, StringComparison.OrdinalIgnoreCase);
        });
    }

    private static AutomationElement? FindSearchEditor(AutomationElement root)
    {
        var rootRect = root.Current.BoundingRectangle;
        return FindDescendants(root).Cast<AutomationElement>()
            .Where(element => Safe(() => element.Current.ControlType) == ControlType.Edit)
            .Where(element =>
            {
                var rect = SafeRect(element);
                var name = Safe(() => element.Current.Name) ?? string.Empty;
                return !rect.IsEmpty && rect.Left < rootRect.Left + rootRect.Width * 0.5
                    && (Regex.IsMatch(name, "搜索|search", RegexOptions.IgnoreCase) || rect.Top < rootRect.Top + 160);
            })
            .OrderBy(element => element.Current.BoundingRectangle.Top)
            .FirstOrDefault();
    }

    private static AutomationElement? FindChatEditor(AutomationElement root)
    {
        var rootRect = root.Current.BoundingRectangle;
        var descendants = FindDescendants(root).Cast<AutomationElement>().ToList();
        var exact = descendants.Where(element =>
            string.Equals(Safe(() => element.Current.AutomationId), "chat_input_field", StringComparison.Ordinal)).ToList();
        if (exact.Count > 1) return null;
        if (exact.Count == 1) return exact[0];
        return descendants
            .Where(element =>
            {
                var type = Safe(() => element.Current.ControlType);
                var rect = SafeRect(element);
                return (type == ControlType.Edit || type == ControlType.Document)
                    && !rect.IsEmpty
                    && rect.Left > rootRect.Left + rootRect.Width * 0.25
                    && rect.Top > rootRect.Top + rootRect.Height * 0.5;
            })
            .OrderByDescending(element =>
            {
                var rect = element.Current.BoundingRectangle;
                return rect.Width * rect.Height;
            })
            .FirstOrDefault();
    }

    private static IEnumerable<IncomingMessage> ReadLatestMessages(AutomationElement root, string displayName, string contactIdentity, int unreadCount)
    {
        var rootRect = root.Current.BoundingRectangle;
        var candidates = FindDescendants(root).Cast<AutomationElement>()
            .Select(element => new
            {
                Element = element,
                Type = Safe(() => element.Current.ControlType),
                Name = (Safe(() => element.Current.Name) ?? string.Empty).Trim(),
                Rect = SafeRect(element),
            })
            .Where(item => (item.Type == ControlType.Text || item.Type == ControlType.ListItem || item.Type == ControlType.Custom || item.Type == ControlType.DataItem)
                && !item.Rect.IsEmpty
                && item.Rect.Left > rootRect.Left + rootRect.Width * 0.27
                && item.Rect.Top > rootRect.Top + 90
                && !string.IsNullOrWhiteSpace(item.Name)
                && item.Name.Length <= 400
                && !TimeRegex.IsMatch(item.Name)
                && !IgnoredLabels.Contains(item.Name, StringComparer.OrdinalIgnoreCase))
            .OrderBy(item => item.Rect.Top)
            .ThenBy(item => item.Rect.Left)
            .GroupBy(item => new { item.Name, Top = (int)item.Rect.Top, Left = (int)item.Rect.Left })
            .Select(group => group.First())
            .ToList();
        var selected = candidates.TakeLast(Math.Max(1, Math.Min(unreadCount, 20)));
        var userId = StableUserId(contactIdentity);
        var ordinal = 0;
        foreach (var item in selected)
        {
            ordinal += 1;
            var isSelf = item.Rect.Left + item.Rect.Width / 2 > rootRect.Left + rootRect.Width * 0.66;
            var runtime = Safe(() => string.Join("-", item.Element.GetRuntimeId())) ?? ordinal.ToString();
            var messageId = Hash($"{userId}|{runtime}|{item.Name}|{ordinal}")[..32];
            yield return new(messageId, userId, displayName, item.Name, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), isSelf);
        }
    }

    private static void SelectStrict(AutomationElement root, string displayName)
    {
        var candidates = FindExactConversations(root, displayName);
        if (candidates.Count > 1) throw new DeliveryException("微信存在多个同名会话，无法确认发送目标");
        if (candidates.Count == 0)
        {
            var search = FindSearchEditor(root)
                ?? throw new DeliveryException("未找到目标会话或可访问的搜索框，已停止发送");
            SetTextVerified(root, search, displayName);
            WaitUntil(() => FindExactConversations(root, displayName).Count > 0, 2_000);
            candidates = FindExactConversations(root, displayName);
        }
        if (candidates.Count != 1) throw new DeliveryException("未找到唯一的同名微信会话，已停止发送");
        var conversation = candidates[0];
        if (conversation.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection))
            ((SelectionItemPattern)selection).Select();
        else if (conversation.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
            ((InvokePattern)invoke).Invoke();
        else throw new DeliveryException("目标会话不支持 UIA 选择，严格模式不会改用鼠标点击");
        if (!WaitUntil(() => HasTargetHeader(root, displayName), 2_000))
            throw new DeliveryException("未能精确核验微信聊天标题，已停止发送");
    }

    private static void EnsureInteractiveWindow(AutomationElement root)
    {
        var handle = new IntPtr(root.Current.NativeWindowHandle);
        if (handle == IntPtr.Zero) throw new DeliveryException("微信主窗口句柄不可用，已停止发送");
        if (IsIconic(handle))
        {
            if (!root.TryGetCurrentPattern(WindowPattern.Pattern, out var window))
                throw new DeliveryException("微信窗口已最小化且不支持 UIA 还原，请先还原窗口");
            ((WindowPattern)window).SetWindowVisualState(WindowVisualState.Normal);
            if (!WaitUntil(() => !IsIconic(handle), 1_000))
                throw new DeliveryException("微信窗口未能还原，已停止发送");
        }
        try { root.SetFocus(); } catch { }
        if (GetForegroundWindow() != handle) SetForegroundWindow(handle);
        if (!WaitUntil(() => GetForegroundWindow() == handle && !IsIconic(handle), 1_000))
            throw new DeliveryException("无法确认微信主窗口为前台窗口，已停止发送");
    }

    private static List<AutomationElement> FindExactConversations(AutomationElement root, string displayName)
    {
        var rootRect = root.Current.BoundingRectangle;
        return FindDescendants(root).Cast<AutomationElement>()
            .Where(element =>
            {
                var type = Safe(() => element.Current.ControlType);
                var rect = SafeRect(element);
                return (type == ControlType.ListItem || type == ControlType.DataItem || type == ControlType.Button
                        || (type == ControlType.Custom && (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _)
                            || element.TryGetCurrentPattern(InvokePattern.Pattern, out _))))
                    && !rect.IsEmpty && rect.Left < rootRect.Left + rootRect.Width * 0.46
                    && rect.Top > rootRect.Top + 45 && rect.Height < rootRect.Height * 0.3
                    && Safe(() => element.Current.IsOffscreen) == false
                    && string.Equals(GetConversationDisplayName(element), displayName.Trim(), StringComparison.Ordinal);
            }).ToList();
    }

    private static bool HasTargetHeader(AutomationElement root, string displayName)
    {
        return ChatHeaderVerifier.Matches(root.Current.BoundingRectangle, ReadHeaderElements(root), displayName);
    }

    private static List<ChatHeaderElement> ReadHeaderElements(AutomationElement root) =>
        FindDescendants(root).Cast<AutomationElement>()
            .Where(element => Safe(() => element.Current.ControlType) is { } type
                && (type == ControlType.Text || type == ControlType.Button || type == ControlType.List))
            .Select(element => new ChatHeaderElement(TypeName(element),
                Safe(() => element.Current.AutomationId) ?? string.Empty,
                Safe(() => element.Current.Name) ?? string.Empty, SafeRect(element),
                Safe(() => element.Current.IsOffscreen) != false))
            .ToList();

    // Read-only target verification uses the same matcher as every pre-send check.
    public object InspectHeader(string displayName)
    {
        var root = RequireLoggedInWindow();
        var elements = ReadHeaderElements(root);
        return new {
            verified = ChatHeaderVerifier.Matches(root.Current.BoundingRectangle, elements, displayName),
            namedHeaderCount = elements.Count(element => ChatHeaderVerifier.IsNameLabel(element.AutomationId)),
            width = root.Current.BoundingRectangle.Width,
            height = root.Current.BoundingRectangle.Height,
            windowMinimized = IsIconic(new IntPtr(root.Current.NativeWindowHandle)),
        };
    }

    private static void RequireTargetHeader(AutomationElement root, string displayName)
    {
        if (!HasTargetHeader(root, displayName)) throw new DeliveryException("微信当前聊天标题与发送目标不一致，已停止发送");
    }

    private static AutomationElement? FindSendButton(AutomationElement root)
    {
        var rootRect = root.Current.BoundingRectangle;
        var buttons = FindDescendants(root).Cast<AutomationElement>().Where(element =>
        {
            var rect = SafeRect(element);
            var name = (Safe(() => element.Current.Name) ?? string.Empty).Trim();
            return Safe(() => element.Current.ControlType) == ControlType.Button
                && !rect.IsEmpty && rect.Left > rootRect.Left + rootRect.Width * 0.27
                && rect.Top > rootRect.Top + rootRect.Height * 0.5
                && Safe(() => element.Current.IsOffscreen) == false
                && Regex.IsMatch(name, @"^(发送|Send)(\s*[(（][^()（）]+[)）])?$", RegexOptions.IgnoreCase)
                && element.TryGetCurrentPattern(InvokePattern.Pattern, out _);
        }).ToList();
        return buttons.Count == 1 ? buttons[0] : null;
    }

    private static bool CanReadText(AutomationElement element) =>
        element.TryGetCurrentPattern(ValuePattern.Pattern, out _)
        || element.TryGetCurrentPattern(TextPattern.Pattern, out _);

    private static object? InspectComposer(AutomationElement root)
    {
        var editor = FindChatEditor(root);
        if (editor is null) return null;
        var hasValue = editor.TryGetCurrentPattern(ValuePattern.Pattern, out var value);
        var hasText = editor.TryGetCurrentPattern(TextPattern.Pattern, out var text);
        var valueContent = hasValue ? Safe(() => ((ValuePattern)value).Current.Value) : null;
        var textContent = hasText ? Safe(() => ((TextPattern)text).DocumentRange.GetText(-1)) : null;
        return new
        {
            automationId = Safe(() => editor.Current.AutomationId),
            className = Safe(() => editor.Current.ClassName),
            type = TypeName(editor),
            hasValue, hasText,
            valueReadOnly = hasValue ? Safe(() => ((ValuePattern)value).Current.IsReadOnly) : (bool?)null,
            valueLength = valueContent?.Length,
            textLength = textContent?.Length,
            empty = (valueContent ?? textContent) is string content ? NormalizeEditorText(content).Length == 0 : (bool?)null,
            valueAndTextAgree = valueContent is not null && textContent is not null
                ? NormalizeEditorText(valueContent) == NormalizeEditorText(textContent) : (bool?)null,
            enabled = Safe(() => editor.Current.IsEnabled),
            focused = Safe(() => editor.Current.HasKeyboardFocus),
        };
    }

    private static object? InspectSendButton(AutomationElement root)
    {
        var button = FindSendButton(root);
        if (button is null) return null;
        return new
        {
            automationId = Safe(() => button.Current.AutomationId),
            className = Safe(() => button.Current.ClassName),
            enabled = Safe(() => button.Current.IsEnabled),
            focused = Safe(() => button.Current.HasKeyboardFocus)
        };
    }

    private static string ReadText(AutomationElement element)
    {
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value))
            return NormalizeEditorText(((ValuePattern)value).Current.Value);
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out var text))
            return NormalizeEditorText(((TextPattern)text).DocumentRange.GetText(-1));
        throw new DeliveryException("微信输入框不支持读取内容，无法验证草稿或发送结果");
    }

    private static string NormalizeEditorText(string value) => value.Replace("\r\n", "\n").TrimEnd('\r', '\n');

    private static void SetTextVerified(AutomationElement root, AutomationElement element, string text)
    {
        if (!CanReadText(element)) throw new DeliveryException("微信输入框内容无法读取，已停止发送");
        element.SetFocus();
        RequireInputFocus(root, element);
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value) && !((ValuePattern)value).Current.IsReadOnly)
            ((ValuePattern)value).SetValue(text);
        else
        {
            var handle = new IntPtr(root.Current.NativeWindowHandle);
            if (handle == IntPtr.Zero || (GetForegroundWindow() != handle && !SetForegroundWindow(handle)))
                throw new DeliveryException("无法确认微信为前台窗口，已停止键盘输入");
            element.SetFocus();
            RequireInputFocus(root, element);
            var previous = System.Windows.Forms.Clipboard.GetDataObject();
            try
            {
                System.Windows.Forms.Clipboard.SetText(text);
                RequireInputFocus(root, element);
                SendKeys.SendWait("^a");
                RequireInputFocus(root, element);
                SendKeys.SendWait("^v");
                if (!WaitUntil(() => string.Equals(ReadText(element), NormalizeEditorText(text), StringComparison.Ordinal), 1_000))
                    throw new DeliveryException("微信粘贴内容校验失败，已停止发送");
            }
            finally
            {
                // Restore only if the clipboard still contains our value; retain concurrent user copies.
                try
                {
                    if (System.Windows.Forms.Clipboard.ContainsText() && System.Windows.Forms.Clipboard.GetText() == text)
                    {
                        if (previous is not null) System.Windows.Forms.Clipboard.SetDataObject(previous, true);
                        else System.Windows.Forms.Clipboard.Clear();
                    }
                }
                catch { }
            }
        }
        if (!WaitUntil(() => string.Equals(ReadText(element), NormalizeEditorText(text), StringComparison.Ordinal), 1_000))
            throw new DeliveryException("微信输入框内容校验失败，已停止发送");
    }

    private static void RequireInputFocus(AutomationElement root, AutomationElement editor)
    {
        if (GetForegroundWindow() != new IntPtr(root.Current.NativeWindowHandle))
            throw new DeliveryException("微信失去前台焦点，已停止键盘输入");
        var focused = AutomationElement.FocusedElement;
        for (var depth = 0; focused is not null && depth < 8; depth++)
        {
            if (Automation.Compare(focused, editor)) return;
            focused = TreeWalker.ControlViewWalker.GetParent(focused);
        }
        throw new DeliveryException("微信输入框未获得焦点，已停止键盘输入");
    }

    private static bool WaitUntil(Func<bool> predicate, int timeoutMs)
    {
        var clock = Stopwatch.StartNew();
        do
        {
            if (predicate()) return true;
            Thread.Sleep(80);
        } while (clock.ElapsedMilliseconds < timeoutMs);
        return false;
    }

    private static void Activate(AutomationElement element)
    {
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection))
            ((SelectionItemPattern)selection).Select();
        else if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
            ((InvokePattern)invoke).Invoke();
        else
        {
            var rect = element.Current.BoundingRectangle;
            Click((int)(rect.Left + rect.Width / 2), (int)(rect.Top + rect.Height / 2));
        }
    }

    private static void SetText(AutomationElement element, string text)
    {
        element.SetFocus();
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var value) && !((ValuePattern)value).Current.IsReadOnly)
            ((ValuePattern)value).SetValue(text);
        else
        {
            SendKeys.SendWait("^a");
            SendKeys.SendWait(EscapeSendKeys(text));
        }
    }

    private static string CleanConversationName(string value)
    {
        value = value.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? value;
        var cleaned = UnreadRegex.Replace(value, string.Empty);
        cleaned = Regex.Replace(cleaned, @"\b\d{1,2}:\d{2}\b", string.Empty);
        return cleaned.Trim(' ', ',', '，', ':', '：', '[', ']', '(', ')');
    }

    private static string GetConversationDisplayName(AutomationElement element)
    {
        var children = element.FindAll(TreeScope.Descendants, AutomationCondition.TrueCondition)
            .Cast<AutomationElement>()
            .Select(item => CleanConversationName(Safe(() => item.Current.Name) ?? string.Empty))
            .Where(name => !string.IsNullOrWhiteSpace(name)
                && name.Length <= 80
                && !TimeRegex.IsMatch(name)
                && !UnreadRegex.IsMatch(name)
                && !IgnoredLabels.Contains(name, StringComparer.OrdinalIgnoreCase))
            .ToList();
        return children.FirstOrDefault() ?? CleanConversationName(Safe(() => element.Current.Name) ?? string.Empty);
    }

    private static int ParseUnreadCount(string value)
    {
        var match = UnreadRegex.Match(value);
        return match.Success && int.TryParse(match.Groups[1].Value, out var count) ? Math.Clamp(count, 1, 20) : 1;
    }

    private static string StableUserId(string displayName) => $"wxui_{Hash(displayName)[..24]}";
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string EscapeSendKeys(string value) => Regex.Replace(value, @"([+^%~(){}\[\]])", "{$1}");
    private static T? Safe<T>(Func<T> action) { try { return action(); } catch { return default; } }
    private static Rect SafeRect(AutomationElement element) { try { return element.Current.BoundingRectangle; } catch { return Rect.Empty; } }
    private static bool IsConversationCandidate(AutomationElement element)
    {
        var type = Safe(() => element.Current.ControlType);
        return type == ControlType.ListItem || type == ControlType.Button || type == ControlType.Custom || type == ControlType.DataItem;
    }
    private static string TypeName(AutomationElement element) =>
        (Safe(() => element.Current.ControlType?.ProgrammaticName) ?? "unknown").Replace("ControlType.", string.Empty);
    private static DiagnosticElement ToDiagnostic(AutomationElement element, Rect rootRect)
    {
        var rect = SafeRect(element);
        var name = Safe(() => element.Current.Name) ?? string.Empty;
        var descendants = element.FindAll(TreeScope.Descendants, AutomationCondition.TrueCondition).Cast<AutomationElement>().ToList();
        var combined = name + " " + string.Join(" ", descendants.Select(item => Safe(() => item.Current.Name) ?? string.Empty));
        return new(
            TypeName(element), Safe(() => element.Current.AutomationId) ?? string.Empty,
            (int)(rect.Left - rootRect.Left), (int)(rect.Top - rootRect.Top),
            (int)rect.Width, (int)rect.Height, name.Length, UnreadRegex.IsMatch(combined), descendants.Count);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr window, IntPtr deviceContext, uint flags);
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
    private static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
    private static void RightClick(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
    }
}
