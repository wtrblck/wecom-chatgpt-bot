using System.Windows;

namespace WeChatBridge;

internal static class ChatHeaderVerifierTests
{
    // Synthetic UIA snapshots never read or operate the user's WeChat session.
    internal static int Run()
    {
        const string target = "测试群";
        const string titleId = "content_view.top_content_view.title_h_view.left_ui_.big_title_line_h_view.current_chat_name_label";
        var window = new Rect(0, 0, 2560, 1528);
        var title = new ChatHeaderElement("Text", titleId, target, new Rect(474, 68, 84, 30));
        var tests = 0;
        void Check(string name, bool expected, Rect bounds, params ChatHeaderElement[] elements)
        {
            if (ChatHeaderVerifier.Matches(bounds, elements, target) != expected)
                throw new InvalidOperationException($"Chat header regression failed: {name}");
            tests++;
        }
        Check("maximized 2560px, title left of the former 27% cutoff", true, window, title);
        Check("restored window", true, new Rect(0, 0, 1320, 960), title);
        Check("200% DPI title below the former 110px cutoff", true, new Rect(0, 0, 3840, 2160),
            title with { Bounds = new Rect(632, 112, 112, 40) });
        Check("negative monitor origin", true, new Rect(-2560, -100, 2560, 1528),
            title with { Bounds = new Rect(-2086, -32, 84, 30) });
        Check("short semantic ID", true, window, title with { AutomationId = "current_chat_name_label" });
        Check("wrong target", false, window, title with { Name = target + "二" });
        Check("hidden name label", false, window, title with { IsOffscreen = true });
        Check("duplicate name labels", false, window, title, title);
        Check("label outside window", false, window, title with { Bounds = new Rect(2600, 68, 84, 30) });
        Check("stale zero-sized label", false, window, title with { Bounds = new Rect(474, 68, 0, 0) });
        Check("wrong control type", false, window, title with { Type = "Button" });
        Check("dedicated label must match exactly, not drop real name suffix", false, window,
            title with { Name = target + "(6)" });
        var combined = new ChatHeaderElement("Text", "combined", target + "(6)", new Rect(800, 68, 240, 30));
        Check("mismatched name cannot be overridden by other header text", false, window,
            title with { Name = "别的群" }, combined);
        Check("duplicate name cannot fall back", false, window, title, title, combined);
        var list = new ChatHeaderElement("List", "chat_message_list", "", new Rect(450, 120, 2100, 1180));
        Check("combined header anchored to real chat pane on wide windows", true, window, list,
            combined with { Bounds = new Rect(474, 68, 240, 30) });
        Check("full-width member count", true, window, list, combined with { Name = target + "（16）" });
        Check("sidebar name is not current chat", false, window, list,
            combined with { Bounds = new Rect(110, 68, 240, 30) });
        Check("message body is not header", false, window, list,
            combined with { Bounds = new Rect(800, 140, 240, 30) });
        Check("hidden message list", false, window, list with { IsOffscreen = true }, combined);
        Check("ambiguous message lists", false, window, list, list, combined);
        Check("combined header rejects similar names", false, window, list, combined with { Name = target + "二(6)" });
        Check("combined header rejects mismatched brackets", false, window, list, combined with { Name = target + "（6)" });
        Check("legacy header provider remains supported", true, window, combined);
        Check("legacy hidden header", false, window, combined with { IsOffscreen = true });
        Check("no exposed controls", false, window);
        Check("invalid window", false, Rect.Empty, title);
        if (ChatHeaderVerifier.Matches(window, [title], " ")) throw new InvalidOperationException("Empty target accepted");
        tests++;
        return tests;
    }
}
