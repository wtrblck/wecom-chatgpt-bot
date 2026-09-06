using System.Text.RegularExpressions;
using System.Windows;

namespace WeChatBridge;

internal sealed record ChatHeaderElement(string Type, string AutomationId, string Name, Rect Bounds, bool IsOffscreen = false);

internal static class ChatHeaderVerifier
{
    internal static bool IsNameLabel(string id) => id == "current_chat_name_label"
        || id.EndsWith(".current_chat_name_label", StringComparison.Ordinal);

    internal static bool Matches(Rect window, IReadOnlyList<ChatHeaderElement> elements, string displayName)
    {
        if (window.IsEmpty || window.Width <= 0 || window.Height <= 0 || string.IsNullOrWhiteSpace(displayName)) return false;
        var target = displayName.Trim();
        var labels = elements.Where(element => IsNameLabel(element.AutomationId)).ToList();
        if (labels.Count > 0)
        {
            // WeChat 4 exposes the actual name separately from the member count.
            // Its fixed-width sidebar does not grow with a maximized window.
            // Never let another text/button override an ambiguous or mismatched name label.
            return labels.Count == 1 && labels[0].Type == "Text" && VisibleInside(window, labels[0])
                && string.Equals(labels[0].Name.Trim(), target, StringComparison.Ordinal);
        }

        // Older providers may expose only the combined header. Anchor its region
        // above the message list when available, rather than to screen percentages.
        var lists = elements.Where(element => element.Type == "List"
            && element.AutomationId == "chat_message_list").ToList();
        if (lists.Count > 1) return false;
        Rect region;
        if (lists.Count == 1)
        {
            var list = lists[0];
            if (!VisibleInside(window, list) || list.Bounds.Top <= window.Top) return false;
            region = new Rect(list.Bounds.Left, window.Top, list.Bounds.Width, list.Bounds.Top - window.Top);
        }
        else
        {
            // Retain the historical contract for clients without semantic anchors.
            region = new Rect(window.Left + window.Width * 0.27, window.Top,
                window.Width * 0.73, Math.Min(110, window.Height * 0.2));
        }
        var exact = new Regex($"\\A{Regex.Escape(target)}(?:\\s*(?:\\([0-9]+\\)|（[0-9]+）))?\\z", RegexOptions.CultureInvariant);
        return elements.Any(element => (element.Type is "Text" or "Button")
            && VisibleInside(region, element) && exact.IsMatch(element.Name.Trim()));
    }

    private static bool VisibleInside(Rect region, ChatHeaderElement element) => !element.IsOffscreen
        && !element.Bounds.IsEmpty && element.Bounds.Width > 0 && element.Bounds.Height > 0
        && region.Contains(element.Bounds);
}
