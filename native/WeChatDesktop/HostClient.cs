using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WeChatDesktop;
internal sealed class HostClient
{
    private readonly Process process;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonNode?>> pending = new();
    private readonly SemaphoreSlim writer = new(1);
    private int nextId;
    internal HostClient(string root)
    {
        var node = Path.Combine(root, "runtime", "node.exe");
        if (!File.Exists(node)) node = Path.Combine(AppContext.BaseDirectory, "app", "runtime", "node.exe");
        if (!File.Exists(node)) node = "node.exe";
        var script = Path.Combine(root, "dist", "scripts", "desktop-host.js");
        if (!File.Exists(script)) throw new FileNotFoundException("未找到桌面后端，请完整解压程序包，或先运行 npm run build。", script);
        var start = new ProcessStartInfo(node) {
            WorkingDirectory = root, CreateNoWindow = true, UseShellExecute = false,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        start.ArgumentList.Add(script);
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) => {
            if (args.Data == null) return;
            try {
                var response = JsonNode.Parse(args.Data)!;
                if (pending.TryRemove(response["id"]!.GetValue<int>(), out var task)) {
                    if (response["ok"]!.GetValue<bool>()) task.TrySetResult(response["result"]?.DeepClone());
                    else task.TrySetException(new InvalidOperationException(response["error"]?.ToString() ?? "操作失败"));
                }
            } catch (JsonException) { }
        };
        var errors = new StringBuilder();
        process.ErrorDataReceived += (_, args) => { if (args.Data != null && errors.Length < 4000) errors.AppendLine(args.Data); };
        process.Exited += (_, _) => { foreach (var p in pending) if (pending.TryRemove(p.Key, out var task)) task.TrySetException(new IOException("桌面后端已退出。" + errors)); };
        process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
    }
    internal async Task<JsonNode?> Call(string method, JsonNode? parameters = null)
    {
        if (process.HasExited) throw new IOException("桌面后端已退出，请关闭并重新打开工作台。");
        var id = Interlocked.Increment(ref nextId);
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = tcs;
        try {
            await writer.WaitAsync();
            try {
                await process.StandardInput.WriteLineAsync(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters?.DeepClone() }.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
                await process.StandardInput.FlushAsync();
            } finally { writer.Release(); }
            return await tcs.Task.WaitAsync(TimeSpan.FromSeconds(method is "close" or "stop" ? 195 : 100));
        } finally { pending.TryRemove(id, out _); }
    }
    internal async Task Close()
    {
        if (!process.HasExited) { await Call("close"); process.StandardInput.Close(); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
        process.Dispose();
    }
}
