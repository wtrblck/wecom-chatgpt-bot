using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using System.Windows.Forms;
using Tesseract;

namespace WeChatBridge;

internal static class WeChatVision
{
    private sealed record OcrLine(string Text, Rectangle Bounds);
    private sealed record CopyAttempt(string? Text, bool Success);
    private sealed record CopiedBubble(string OcrText, string ExactText, long CopiedAt);
    private static TesseractEngine? sharedEngine;
    private static readonly Dictionary<string, string> LastConversationFingerprints = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, long> RecentCopyAttempts = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, int> ConsecutiveCopyFailures = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, long> CopySuspendedUntil = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, List<CopiedBubble>> SuccessfullyCopiedBubbles = new(StringComparer.Ordinal);

    public static object Inspect(AutomationElement root, Func<AutomationElement, Bitmap> capture)
    {
        using var bitmap = capture(root);
        return new
        {
            header = ReadHeader(bitmap),
            lines = ReadChatLines(bitmap).Select(line => new
            {
                text = line.Text,
                x = line.Bounds.X,
                y = line.Bounds.Y,
                width = line.Bounds.Width,
                height = line.Bounds.Height
            }).ToList(),
            conversations = ReadConversationLines(bitmap).Select(line => new
            {
                text = line.Text,
                x = line.Bounds.X,
                y = line.Bounds.Y,
                width = line.Bounds.Width,
                height = line.Bounds.Height
            }).ToList(),
            unreadRows = FindUnreadRowCenters(bitmap).ToList()
        };
    }

    public static IReadOnlyList<IncomingMessage> Poll(
        AutomationElement root,
        Func<AutomationElement, Bitmap> capture,
        Func<AutomationElement, Bitmap> captureScreen,
        Action<int, int> click,
        Action<int, int> rightClick,
        bool requirePrefix,
        IReadOnlyList<string> prefixes,
        IReadOnlyList<string> canonicalNames)
    {
        var result = new List<IncomingMessage>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // Always inspect the selected conversation. A selected row may lose its red badge
        // before the polling cycle starts, especially when the WeChat window is foreground.
        ReadSelected(root, capture, captureScreen, click, rightClick, requirePrefix, prefixes, canonicalNames, result, seen);

        using var initial = capture(root);
        foreach (var rowY in FindUnreadRowCenters(initial))
        {
            var rect = root.Current.BoundingRectangle;
            BringToFront(root);
            click((int)rect.Left + Math.Max(130, (int)(initial.Width * 0.16)), (int)rect.Top + rowY);
            Thread.Sleep(400);
            ReadSelected(root, capture, captureScreen, click, rightClick, requirePrefix, prefixes, canonicalNames, result, seen);
        }
        return result;
    }

    public static void Send(
        AutomationElement root,
        string displayName,
        string text,
        Func<AutomationElement, Bitmap> capture,
        Action<int, int> click)
    {
        root = PrepareWindow(root);
        var rect = GetWindowBounds(root);
        if (rect.IsEmpty || rect.Width < 650 || rect.Height < 450)
            throw new InvalidOperationException(
                $"微信窗口尺寸异常，无法使用视觉发送后备; handle={GetWindowHandle(root)}; size={(int)rect.Width}x{(int)rect.Height}");

        Select(root, displayName, capture, click);

        // Selecting/searching a conversation can restore, move or resize the window.
        // Never use coordinates captured before that interaction.
        root = PrepareWindow(root);
        rect = GetWindowBounds(root);
        if (rect.IsEmpty || rect.Width < 650 || rect.Height < 450)
            throw new InvalidOperationException(
                $"选中会话后微信窗口尺寸异常; handle={GetWindowHandle(root)}; size={(int)rect.Width}x{(int)rect.Height}");

        // Composer is the lower-right portion of the official desktop client.
        click((int)(rect.Left + rect.Width * 0.62), (int)(rect.Top + rect.Height * 0.90));
        Thread.Sleep(100);
        Paste(text);
        SendKeys.SendWait("{ENTER}");
    }

    public static void Select(
        AutomationElement root,
        string displayName,
        Func<AutomationElement, Bitmap> capture,
        Action<int, int> click)
    {
        root = PrepareWindow(root);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            BringToFront(root);
            var rect = GetWindowBounds(root);
            using var bitmap = capture(root);
            var match = FindConversationLine(bitmap, displayName);
            if (match is not null)
            {
                click((int)(rect.Left + rect.Width * 0.16), (int)rect.Top + match.Bounds.Top + match.Bounds.Height / 2);
                Thread.Sleep(850);
                using var verification = capture(root);
                if (NamesMatch(ReadHeader(verification), displayName)) return;
            }
            Thread.Sleep(150);
        }
        // Search box in the conversation column.
        BringToFront(root);
        SendKeys.SendWait("^f");
        Thread.Sleep(150);
        SendKeys.SendWait("^a");
        Paste(displayName);
        Thread.Sleep(450);
        SendKeys.SendWait("{ENTER}");
        Thread.Sleep(850);
        using var searchVerification = capture(root);
        if (!NamesMatch(ReadHeader(searchVerification), displayName))
            throw new InvalidOperationException($"未能选中微信联系人: {displayName}");
    }

    private static void ReadSelected(
        AutomationElement root,
        Func<AutomationElement, Bitmap> capture,
        Func<AutomationElement, Bitmap> captureScreen,
        Action<int, int> click,
        Action<int, int> rightClick,
        bool requirePrefix,
        IReadOnlyList<string> prefixes,
        IReadOnlyList<string> canonicalNames,
        List<IncomingMessage> output,
        HashSet<string> seen)
    {
        using var bitmap = capture(root);
        var displayName = CanonicalizeConversationName(ReadHeader(bitmap), canonicalNames);
        if (string.IsNullOrWhiteSpace(displayName)) return;
        var userId = $"wxui_{Hash(displayName)[..24]}";
        var lines = ReadChatLines(bitmap);
        var ordinalByText = new Dictionary<string, int>(StringComparer.Ordinal);
        var copiedAt = new Dictionary<string, int>(StringComparer.Ordinal);
        var remainingCopyAttempts = 1;
        var fingerprint = Hash(string.Join("|", lines.Select(line => $"{line.Bounds.Top}:{line.Text}")));
        var conversationChanged = !LastConversationFingerprints.TryGetValue(displayName, out var previousFingerprint)
            || !string.Equals(previousFingerprint, fingerprint, StringComparison.Ordinal);
        LastConversationFingerprints[displayName] = fingerprint;
        var recentCopyCandidates = conversationChanged
            ? lines.Where(line => line.Bounds.Right <= bitmap.Width * 0.78 && IsCopyCandidate(line, bitmap))
                .TakeLast(1)
                .ToHashSet()
            : [];
        foreach (var line in lines)
        {
            var isSelf = line.Bounds.Right > bitmap.Width * 0.78;
            var text = line.Text;
            // Only the newest incoming text bubble may use the clipboard. Older visible
            // command-looking OCR lines must never consume the single copy slot.
            var shouldCopy = recentCopyCandidates.Contains(line);
            if (!isSelf
                && shouldCopy
                && remainingCopyAttempts > 0
                && IsCopyCandidate(line, bitmap)
                && LooksLikeTextBubble(bitmap, line)
                && CanAttemptCopy(displayName, line))
            {
                remainingCopyAttempts--;
                var copy = TryCopyMessage(root, line, captureScreen, click, rightClick);
                RegisterCopyResult(displayName, line.Text, copy);
                text = copy.Text ?? text;
            }
            text = NormalizeCommand(text);
            if (string.IsNullOrWhiteSpace(text)) continue;
            if (!isSelf && copiedAt.TryGetValue(text, out var previousY) && Math.Abs(line.Bounds.Top - previousY) < 70)
                continue;
            if (!isSelf) copiedAt[text] = line.Bounds.Top;
            var key = $"{isSelf}|{text}";
            ordinalByText.TryGetValue(key, out var ordinal);
            ordinalByText[key] = ++ordinal;
            var messageId = Hash($"{userId}|{key}|{ordinal}")[..32];
            if (!seen.Add(messageId)) continue;
            output.Add(new IncomingMessage(
                messageId, userId, displayName, text,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), isSelf));
        }
    }

    private static bool HasConfiguredPrefix(string value, IReadOnlyList<string> prefixes)
    {
        var text = value.Trim();
        var configured = prefixes.Count > 0 ? prefixes : ["/gpt", "@ChatBOT"];
        return configured.Any(prefix =>
        {
            var index = text.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
            if (index < 0) return false;
            var after = index + prefix.Length;
            return after == text.Length || char.IsWhiteSpace(text[after]);
        });
    }

    private static string CanonicalizeConversationName(string detectedName, IReadOnlyList<string> canonicalNames)
    {
        var detected = CleanConversationText(detectedName);
        if (string.IsNullOrWhiteSpace(detected) || canonicalNames.Count == 0) return detected;
        var compactDetected = Compact(detected);
        var best = canonicalNames
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name => new
            {
                Name = CleanConversationText(name),
                Distance = Distance(compactDetected, Compact(CleanConversationText(name)))
            })
            .OrderBy(item => item.Distance)
            .FirstOrDefault();
        if (best is null) return detected;
        var compactCanonical = Compact(best.Name);
        var matches = compactDetected.Contains(compactCanonical, StringComparison.OrdinalIgnoreCase)
            || compactCanonical.Contains(compactDetected, StringComparison.OrdinalIgnoreCase)
            || best.Distance <= Math.Max(1, compactCanonical.Length / 3);
        return matches ? best.Name : detected;
    }

    private static string ReadHeader(Bitmap bitmap)
    {
        var selectedTop = FindSelectedRowTop(bitmap);
        if (selectedTop is not null)
        {
            var selected = ReadConversationLines(bitmap)
                .FirstOrDefault(line => Math.Abs(line.Bounds.Top - selectedTop.Value) < 10);
            if (selected is not null && selected.Text.Length >= 2)
                return CleanConversationText(selected.Text);
        }
        var header = ReadHeaderTitle(bitmap);
        if (!string.IsNullOrWhiteSpace(header)) return CleanConversationText(header);
        return string.Empty;
    }

    private static string ReadHeaderTitle(Bitmap bitmap)
    {
        var crop = Rectangle.FromLTRB(
            (int)(bitmap.Width * 0.285), 12,
            (int)(bitmap.Width * 0.72), Math.Min(82, bitmap.Height));
        return Recognize(bitmap, crop, PageSegMode.SingleLine)
            .Select(line => line.Text.Trim())
            .FirstOrDefault(text => text.Length is > 0 and <= 80) ?? string.Empty;
    }

    private static IReadOnlyList<OcrLine> ReadConversationLines(Bitmap bitmap)
    {
        var output = new List<OcrLine>();
        var paneRight = (int)(bitmap.Width * 0.275);
        var nameLeft = Math.Min(148, paneRight - 20);
        const int rowHeight = 81;
        for (var rowTop = 99; rowTop + 45 < bitmap.Height * 0.82; rowTop += rowHeight)
        {
            var crop = Rectangle.FromLTRB(nameLeft, rowTop + 9, paneRight - 38, rowTop + 45);
            var name = Recognize(bitmap, crop, PageSegMode.SingleLine)
                .Select(line => line.Text.Trim())
                .FirstOrDefault(text => text.Length is > 0 and <= 80);
            if (!string.IsNullOrWhiteSpace(name))
                output.Add(new OcrLine(CleanConversationText(name), new Rectangle(nameLeft, rowTop, paneRight - nameLeft, rowHeight)));
        }
        return output;
    }

    private static OcrLine? FindConversationLine(Bitmap bitmap, string displayName) =>
        ReadConversationLines(bitmap)
            .Where(line => line.Bounds.Y >= 90)
            .OrderBy(line => Distance(Compact(line.Text), Compact(displayName)))
            .FirstOrDefault(line => NamesMatch(line.Text, displayName));

    private static IReadOnlyList<OcrLine> ReadChatLines(Bitmap bitmap)
    {
        var crop = Rectangle.FromLTRB(
            (int)(bitmap.Width * 0.29), 88,
            bitmap.Width - 12, (int)(bitmap.Height * 0.80));
        var lines = Recognize(bitmap, crop, PageSegMode.SparseText)
            .Where(line => line.Text.Length is > 0 and <= 500)
            .Where(line => line.Bounds.Top > 0 && line.Bounds.Height >= 8)
            .OrderBy(line => line.Bounds.Top)
            .ThenBy(line => line.Bounds.Left)
            .ToList();

        // Wrapped text in one bubble is returned as adjacent OCR lines. Join only when
        // horizontal alignment and vertical spacing strongly indicate the same bubble.
        var merged = new List<OcrLine>();
        foreach (var line in lines)
        {
            if (merged.Count > 0)
            {
                var previous = merged[^1];
                var gap = line.Bounds.Top - previous.Bounds.Bottom;
                var sameSide = (line.Bounds.Left + line.Bounds.Width / 2 > bitmap.Width * 0.66)
                    == (previous.Bounds.Left + previous.Bounds.Width / 2 > bitmap.Width * 0.66);
                if (sameSide && gap is >= 0 and <= 18 && Math.Abs(line.Bounds.Left - previous.Bounds.Left) < 45)
                {
                    merged[^1] = new OcrLine(
                        previous.Text + "\n" + line.Text,
                        Rectangle.Union(previous.Bounds, line.Bounds));
                    continue;
                }
            }
            merged.Add(line);
        }
        return merged.Select(line => line with { Text = NormalizeCommand(line.Text) }).ToList();
    }

    private static bool IsCopyCandidate(OcrLine line, Bitmap bitmap) =>
        line.Bounds.Left > bitmap.Width * 0.31
        && line.Bounds.Left < bitmap.Width * 0.66
        && !Regex.IsMatch(line.Text, @"^\d{1,2}:\d{2}$");

    private static bool LooksLikeTextBubble(Bitmap bitmap, OcrLine line)
    {
        var sample = line.Bounds;
        sample.Inflate(18, 12);
        sample.Intersect(new Rectangle(Point.Empty, bitmap.Size));
        if (sample.Width < 12 || sample.Height < 12) return false;

        var colors = new Dictionary<int, int>();
        var total = 0;
        for (var y = sample.Top; y < sample.Bottom; y += 3)
        for (var x = sample.Left; x < sample.Right; x += 3)
        {
            var pixel = bitmap.GetPixel(x, y);
            var bucket = (pixel.R / 32 << 6) | (pixel.G / 32 << 3) | pixel.B / 32;
            colors.TryGetValue(bucket, out var count);
            colors[bucket] = count + 1;
            total++;
        }
        if (total == 0) return false;
        var dominantRatio = colors.Values.Max() / (double)total;
        return dominantRatio >= 0.30;
    }

    private static bool CanAttemptCopy(string displayName, OcrLine line)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (CopySuspendedUntil.TryGetValue(displayName, out var suspendedUntil) && suspendedUntil > now)
            return false;

        var ocrText = Compact(line.Text);
        if (SuccessfullyCopiedBubbles.TryGetValue(displayName, out var copied)
            && copied.Any(item => NearlySameMessage(ocrText, item.OcrText) || NearlySameMessage(ocrText, item.ExactText)))
            return false;

        var positionKey = $"{displayName}|{line.Bounds.Left / 24}|{line.Bounds.Top / 24}";
        if (RecentCopyAttempts.TryGetValue(positionKey, out var attemptedAt) && now - attemptedAt < 1_500)
            return false;
        RecentCopyAttempts[positionKey] = now;

        if (RecentCopyAttempts.Count > 2_000)
        {
            foreach (var expired in RecentCopyAttempts.Where(item => now - item.Value > 120_000).Select(item => item.Key).ToList())
                RecentCopyAttempts.Remove(expired);
        }
        return true;
    }

    private static void RegisterCopyResult(string displayName, string ocrText, CopyAttempt result)
    {
        if (result.Success && !string.IsNullOrWhiteSpace(result.Text))
        {
            ConsecutiveCopyFailures[displayName] = 0;
            CopySuspendedUntil.Remove(displayName);
            if (!SuccessfullyCopiedBubbles.TryGetValue(displayName, out var copied))
            {
                copied = [];
                SuccessfullyCopiedBubbles[displayName] = copied;
            }
            copied.Add(new CopiedBubble(
                Compact(ocrText),
                Compact(result.Text),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            if (copied.Count > 200) copied.RemoveRange(0, copied.Count - 200);
            return;
        }

        ConsecutiveCopyFailures.TryGetValue(displayName, out var failures);
        failures++;
        ConsecutiveCopyFailures[displayName] = failures;
        if (failures >= 3)
        {
            CopySuspendedUntil[displayName] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 120_000;
            ConsecutiveCopyFailures[displayName] = 0;
        }
    }

    private static bool NearlySameMessage(string left, string right)
    {
        if (left.Length == 0 || right.Length == 0) return false;
        if (left.Length <= 3 || right.Length <= 3)
            return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        if (left.Contains(right, StringComparison.OrdinalIgnoreCase)
            || right.Contains(left, StringComparison.OrdinalIgnoreCase))
            return true;
        return Distance(left, right) <= Math.Max(1, Math.Max(left.Length, right.Length) / 4);
    }

    private static CopyAttempt TryCopyMessage(
        AutomationElement root,
        OcrLine line,
        Func<AutomationElement, Bitmap> captureScreen,
        Action<int, int> click,
        Action<int, int> rightClick)
    {
        var rect = root.Current.BoundingRectangle;
        var relativeX = line.Bounds.Left + Math.Max(16, line.Bounds.Width / 2);
        var relativeY = line.Bounds.Top + Math.Max(8, line.Bounds.Height / 2);
        var screenX = (int)rect.Left + relativeX;
        var screenY = (int)rect.Top + relativeY;
        string? originalClipboardText = null;
        var sentinel = $"__wechat_bridge_{Guid.NewGuid():N}__";
        try
        {
            if (System.Windows.Forms.Clipboard.ContainsText())
                originalClipboardText = System.Windows.Forms.Clipboard.GetText();
            System.Windows.Forms.Clipboard.SetText(sentinel);
            BringToFront(root);
            rightClick(screenX, screenY);
            Thread.Sleep(220);
            using var menuScreen = captureScreen(root);
            var menuCrop = Rectangle.FromLTRB(
                Math.Max((int)(menuScreen.Width * 0.27), relativeX - 180),
                Math.Max(75, relativeY - 140),
                Math.Min(menuScreen.Width - 1, relativeX + 280),
                Math.Min(menuScreen.Height - 1, relativeY + 340));
            var menuItems = Recognize(menuScreen, menuCrop, PageSegMode.SparseText);
            var menuText = string.Join("", menuItems.Select(item => item.Text.Replace(" ", string.Empty)));
            if (Regex.IsMatch(menuText, "添加到表情|另存为|保存图片|识别图中|提取文字|翻译图片"))
            {
                DismissContextMenu(click, screenX, screenY);
                return new(null, false);
            }
            var copyItem = menuItems
                .FirstOrDefault(item => item.Text.Replace(" ", string.Empty).Contains("复制", StringComparison.Ordinal));
            if (copyItem is null)
            {
                DismissContextMenu(click, screenX, screenY);
                return new(null, false);
            }
            click((int)rect.Left + copyItem.Bounds.Left + copyItem.Bounds.Width / 2,
                (int)rect.Top + copyItem.Bounds.Top + copyItem.Bounds.Height / 2);
            Thread.Sleep(120);
            var copied = System.Windows.Forms.Clipboard.ContainsText()
                ? System.Windows.Forms.Clipboard.GetText().Trim()
                : string.Empty;
            return copied.Length > 0 && copied != sentinel
                ? new(copied, true)
                : new(null, false);
        }
        catch
        {
            DismissContextMenu(click, screenX, screenY);
            return new(null, false);
        }
        finally
        {
            if (originalClipboardText is not null)
            {
                try { System.Windows.Forms.Clipboard.SetText(originalClipboardText); } catch { }
            }
        }
    }

    private static void DismissContextMenu(Action<int, int> click, int screenX, int screenY)
    {
        try
        {
            click(screenX, screenY);
            Thread.Sleep(80);
        }
        catch { }
    }

    private static string NormalizeCommand(string value)
    {
        var text = value.Trim();
        var command = Regex.Match(text, @"^(?:/(?:gpt|new|status|stop|retry|help)|@ChatBOT)\b", RegexOptions.IgnoreCase);
        return command.Success ? text[command.Index..].Trim() : text;
    }

    private static IReadOnlyList<OcrLine> Recognize(Bitmap source, Rectangle crop, PageSegMode mode)
    {
        var dataPath = ResolveTessdata();
        using var prepared = Prepare(source, crop);
        using var stream = new MemoryStream();
        prepared.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        using var pix = Pix.LoadFromMemory(stream.ToArray());
        var engine = sharedEngine ??= new TesseractEngine(dataPath, "chi_sim+eng", EngineMode.LstmOnly);
        engine.SetVariable("preserve_interword_spaces", "1");
        using var page = engine.Process(pix, mode);
        using var iterator = page.GetIterator();
        var output = new List<OcrLine>();
        iterator.Begin();
        do
        {
            var text = Normalize(iterator.GetText(PageIteratorLevel.TextLine));
            if (string.IsNullOrWhiteSpace(text)) continue;
            if (!iterator.TryGetBoundingBox(PageIteratorLevel.TextLine, out var box)) continue;
            output.Add(new OcrLine(text, new Rectangle(
                crop.Left + box.X1 / 2, crop.Top + box.Y1 / 2,
                Math.Max(1, (box.X2 - box.X1) / 2), Math.Max(1, (box.Y2 - box.Y1) / 2))));
        } while (iterator.Next(PageIteratorLevel.TextLine));
        return output;
    }

    private static Bitmap Prepare(Bitmap source, Rectangle crop)
    {
        crop.Intersect(new Rectangle(System.Drawing.Point.Empty, source.Size));
        using var raw = source.Clone(crop, PixelFormat.Format24bppRgb);
        var scaled = new Bitmap(raw.Width * 2, raw.Height * 2, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(scaled))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(raw, new Rectangle(System.Drawing.Point.Empty, scaled.Size));
        }
        // The current official client renders dark-mode text light-on-dark. Invert a
        // dark crop so Tesseract receives its preferred dark-text-on-light image.
        long luminance = 0;
        var samples = 0;
        for (var y = 0; y < scaled.Height; y += 20)
        for (var x = 0; x < scaled.Width; x += 20)
        {
            var pixel = scaled.GetPixel(x, y);
            luminance += pixel.R * 3 + pixel.G * 6 + pixel.B;
            samples += 10;
        }
        if (samples > 0 && luminance / samples < 128)
        {
            var inverted = new Bitmap(scaled.Width, scaled.Height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(inverted))
            using (var attributes = new ImageAttributes())
            {
                attributes.SetColorMatrix(new ColorMatrix(new[]
                {
                    new float[] { -1, 0, 0, 0, 0 },
                    new float[] { 0, -1, 0, 0, 0 },
                    new float[] { 0, 0, -1, 0, 0 },
                    new float[] { 0, 0, 0, 1, 0 },
                    new float[] { 1, 1, 1, 0, 1 }
                }));
                graphics.DrawImage(scaled, new Rectangle(0, 0, scaled.Width, scaled.Height),
                    0, 0, scaled.Width, scaled.Height, GraphicsUnit.Pixel, attributes);
            }
            scaled.Dispose();
            return inverted;
        }
        return scaled;
    }

    private static IEnumerable<int> FindUnreadRowCenters(Bitmap bitmap)
    {
        // Unread counters are compact, nearly circular red components on the
        // upper-right corner of an avatar. Connected-component filtering excludes
        // red artwork inside official-account avatars.
        var left = Math.Min((int)(bitmap.Width * 0.085), bitmap.Width - 1);
        var right = Math.Max(left + 1, (int)(bitmap.Width * 0.13));
        var top = 72;
        var bottom = (int)(bitmap.Height * 0.82);
        var width = right - left;
        var height = bottom - top;
        var mask = new bool[width, height];
        for (var y = 0; y < height; y++)
        for (var x = 0; x < width; x++)
        {
            var pixel = bitmap.GetPixel(left + x, top + y);
            if (pixel.R > 175 && pixel.R > pixel.G * 1.55 && pixel.R > pixel.B * 1.35)
                mask[x, y] = true;
        }
        var visited = new bool[width, height];
        var centers = new List<int>();
        for (var y = 0; y < height; y++)
        for (var x = 0; x < width; x++)
        {
            if (!mask[x, y] || visited[x, y]) continue;
            var queue = new Queue<(int X, int Y)>();
            queue.Enqueue((x, y));
            visited[x, y] = true;
            var count = 0;
            var minX = x; var maxX = x; var minY = y; var maxY = y;
            while (queue.Count > 0)
            {
                var point = queue.Dequeue();
                count++;
                minX = Math.Min(minX, point.X); maxX = Math.Max(maxX, point.X);
                minY = Math.Min(minY, point.Y); maxY = Math.Max(maxY, point.Y);
                for (var dy = -1; dy <= 1; dy++)
                for (var dx = -1; dx <= 1; dx++)
                {
                    var nx = point.X + dx; var ny = point.Y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height || visited[nx, ny] || !mask[nx, ny]) continue;
                    visited[nx, ny] = true;
                    queue.Enqueue((nx, ny));
                }
            }
            var componentWidth = maxX - minX + 1;
            var componentHeight = maxY - minY + 1;
            var fill = count / (double)(componentWidth * componentHeight);
            if (componentWidth is >= 12 and <= 28 && componentHeight is >= 12 and <= 28 && fill >= 0.35)
                centers.Add(top + (minY + maxY) / 2);
        }
        foreach (var center in centers.Distinct().OrderBy(value => value)) yield return center;
    }

    private static string ResolveTessdata()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "tessdata"),
            Path.Combine(Directory.GetCurrentDirectory(), "native", "WeChatBridge", "tessdata")
        };
        var path = candidates.FirstOrDefault(candidate =>
            File.Exists(Path.Combine(candidate, "chi_sim.traineddata")) &&
            File.Exists(Path.Combine(candidate, "eng.traineddata")));
        return path ?? throw new InvalidOperationException(
            "缺少微信 OCR 模型，请运行 npm run wechat:ocr:install");
    }

    private static void BringToFront(AutomationElement root)
    {
        var handle = GetWindowHandle(root);
        if (handle == IntPtr.Zero)
            throw new InvalidOperationException("无法激活微信窗口");
        try { root.SetFocus(); } catch { }
        ShowWindowAsync(handle, 9);
        BringWindowToTop(handle);
        if (!SetForegroundWindow(handle)) throw new InvalidOperationException("无法激活微信窗口");
    }

    private static AutomationElement PrepareWindow(AutomationElement root)
    {
        var handle = GetWindowHandle(root);
        if (handle == IntPtr.Zero || !IsWindow(handle))
            throw new InvalidOperationException("微信窗口句柄已失效");

        ShowWindowAsync(handle, 9);
        BringWindowToTop(handle);
        SetForegroundWindow(handle);
        Thread.Sleep(120);
        try { return AutomationElement.FromHandle(handle); }
        catch { return root; }
    }

    private static IntPtr GetWindowHandle(AutomationElement root)
    {
        try { return new IntPtr(root.Current.NativeWindowHandle); }
        catch { return IntPtr.Zero; }
    }

    private static System.Windows.Rect GetWindowBounds(AutomationElement root)
    {
        var handle = GetWindowHandle(root);
        if (handle != IntPtr.Zero && GetWindowRect(handle, out var nativeRect))
        {
            var width = nativeRect.Right - nativeRect.Left;
            var height = nativeRect.Bottom - nativeRect.Top;
            if (width > 0 && height > 0)
                return new System.Windows.Rect(nativeRect.Left, nativeRect.Top, width, height);
        }
        try { return root.Current.BoundingRectangle; }
        catch { return System.Windows.Rect.Empty; }
    }

    private static void Paste(string value)
    {
        System.Windows.Forms.Clipboard.SetText(value);
        SendKeys.SendWait("^v");
    }

    private static string Normalize(string? value) => (value ?? string.Empty)
        .Replace("\r", string.Empty)
        .Trim();
    private static string Compact(string value) =>
        new(value.Where(character => !char.IsWhiteSpace(character)).ToArray());
    private static bool NamesMatch(string candidateValue, string targetValue)
    {
        var candidate = Compact(CleanConversationText(candidateValue));
        var target = Compact(CleanConversationText(targetValue));
        if (candidate.Length == 0 || target.Length == 0) return false;
        return candidate.Contains(target, StringComparison.OrdinalIgnoreCase)
            || target.Contains(candidate, StringComparison.OrdinalIgnoreCase)
            || Distance(candidate, target) <= Math.Max(1, target.Length / 5);
    }
    private static string CleanConversationText(string value)
    {
        var firstColumn = Regex.Split(value.Trim(), @"\s{2,}")[0];
        var withoutTime = Regex.Replace(firstColumn, @"\s+\d{1,2}:?\d{0,2}$", string.Empty).Trim();
        return Regex.Replace(withoutTime, @"\s*[（(]\d+[)）]\s*$", string.Empty).Trim();
    }
    private static int? FindSelectedRowTop(Bitmap bitmap)
    {
        const int rowHeight = 81;
        for (var rowTop = 99; rowTop + rowHeight < bitmap.Height * 0.82; rowTop += rowHeight)
        {
            var green = 0;
            var total = 0;
            for (var y = rowTop + 8; y < rowTop + rowHeight - 8; y += 5)
            for (var x = 86; x < Math.Min(140, bitmap.Width); x += 5)
            {
                var pixel = bitmap.GetPixel(x, y);
                total++;
                if (pixel.G > 100 && pixel.G > pixel.R * 1.45 && pixel.G > pixel.B * 1.15) green++;
            }
            if (total > 0 && green > total * 0.25) return rowTop;
        }
        return null;
    }
    private static int Distance(string left, string right)
    {
        if (left.Length == 0) return right.Length;
        if (right.Length == 0) return left.Length;
        var previous = Enumerable.Range(0, right.Length + 1).ToArray();
        for (var i = 1; i <= left.Length; i++)
        {
            var current = new int[right.Length + 1];
            current[0] = i;
            for (var j = 1; j <= right.Length; j++)
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1),
                    previous[j - 1] + (left[i - 1] == right[j - 1] ? 0 : 1));
            previous = current;
        }
        return previous[^1];
    }
    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
