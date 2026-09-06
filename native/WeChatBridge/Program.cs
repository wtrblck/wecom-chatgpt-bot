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
    string[]? CanonicalNames);
internal sealed record HealthState(bool ProcessRunning, bool WindowFound, bool LoggedIn, string? WindowTitle, string? Detail);
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
                    "poll" => automation.Poll(request),
                    "send" => Send(automation, request),
                    "select" => Select(automation, request),
                    "snapshot" => Snapshot(automation, request),
                    "inspect" => automation.Inspect(),
                    "ocr-inspect" => automation.OcrInspect(),
                    "stop" => new { stopped = true },
                    _ => throw new InvalidOperationException($"Unknown operation: {request.Operation}")
                };
                Write(new { id = request.Id, ok = true, result });
                if (request.Operation == "stop") break;
            }
            catch (Exception error)
            {
                Write(new { id = request?.Id ?? 0, ok = false, error = error.Message });
            }
        }
    }

    private static object Send(WeChatAutomation automation, Request request)
    {
        if (string.IsNullOrWhiteSpace(request.DisplayName) || string.IsNullOrWhiteSpace(request.Text))
            throw new ArgumentException("displayName and text are required");
        automation.Send(request.DisplayName, request.Text);
        return new { sent = true };
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
    private static readonly string[] ProcessNames = ["Weixin", "WeChat", "WeChatAppEx"];
    private static readonly Regex UnreadRegex = new(@"(?:(\d+)\s*条)?新消息|unread", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TimeRegex = new(@"^(\d{1,2}:\d{2}|昨天|星期.|周.|\d{1,2}/\d{1,2})$", RegexOptions.Compiled);
    private static readonly string[] IgnoredLabels = ["搜索", "通讯录", "聊天", "收藏", "朋友圈", "小程序", "视频号", "Search", "Contacts", "Chats"];

    public HealthState Health()
    {
        var processes = FindProcesses();
        var window = FindWindow(processes);
        if (window is null) return new(processes.Count > 0, false, false, null, "请启动 Windows 官方微信客户端并完成登录");
        var title = Safe(() => window.Current.Name) ?? string.Empty;
        var rect = SafeRect(window);
        var descendants = FindDescendants(window).Cast<AutomationElement>().ToList();
        var exposedControls = descendants.Any(IsConversationOrEditor);
        var mainWindowSize = !rect.IsEmpty && rect.Width >= 650 && rect.Height >= 450;
        var explicitLogin = Regex.IsMatch(title, "登录|login", RegexOptions.IgnoreCase);
        var loggedIn = !explicitLogin && (exposedControls || mainWindowSize);
        var detail = loggedIn
            ? $"ready; size={(int)rect.Width}x{(int)rect.Height}; accessible_elements={descendants.Count}"
            : $"微信窗口存在，但尚未检测到已登录聊天界面; size={(int)rect.Width}x{(int)rect.Height}; accessible_elements={descendants.Count}";
        return new(true, true, loggedIn, title, detail);
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
            title = Safe(() => root.Current.Name) ?? string.Empty,
            width = (int)rootRect.Width,
            height = (int)rootRect.Height,
            accessibleElementCount = descendants.Count,
            controlTypeCounts = counts,
            leftCandidates,
            unreadCandidateCount = leftCandidates.Count(item => item.UnreadMatch)
        };
    }

    public object OcrInspect()
    {
        var root = RequireLoggedInWindow();
        return WeChatVision.Inspect(root, CaptureBitmap);
    }

    public void Send(string displayName, string text)
    {
        var root = RequireLoggedInWindow();
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
            .Where(element => Regex.IsMatch(Safe(() => element.Current.Name) ?? string.Empty, @"^(微信|WeChat)$", RegexOptions.IgnoreCase))
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
        return FindDescendants(root).Cast<AutomationElement>()
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
