using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace WeChatAccessibility;

internal static class Program
{
    private sealed record Options(string Mode, int? Pid, string? ExpectedHash, string? FilePath);
    private sealed record ModuleIdentity(int Pid, long StartedAt, long BaseAddress, int Size, string Path, string Version);
    private const uint ReadAccess = 0x0400 | 0x0010;
    private const uint WriteAccess = ReadAccess | 0x0020 | 0x0008;

    private static int Main(string[] args)
    {
        var mutationAttempted = false;
        try
        {
            var options = Parse(args);
            if (options.Mode == "--self-test") { Write(new { ok = true, mode = "self-test", tests = ScannerTests.Run() }); return 0; }
            if (options.Mode == "--scan")
            {
                var bytes = File.ReadAllBytes(options.FilePath!);
                var scanner = new GateScanner(bytes);
                var gate = scanner.Scan();
                Write(new { ok = true, mode = "scan", sha256 = Hash(bytes), imageSize = scanner.ImageSize, evidence = Describe(gate), applied = false });
                return 0;
            }
            var identity = FindIdentity(options.Pid);
            var disk = File.ReadAllBytes(identity.Path);
            var hash = Hash(disk);
            if (options.ExpectedHash is not null && !hash.Equals(options.ExpectedHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Module SHA-256 does not match --expected-sha256");
            var image = new GateScanner(disk);
            var candidate = image.Scan();
            if (image.ImageSize != identity.Size) throw new InvalidOperationException("Loaded module size differs from PE SizeOfImage");
            using var readHandle = Open(identity.Pid, ReadAccess);
            var oldValue = ValidateLive(readHandle, identity, image, candidate);
            var applied = false;
            var value = oldValue;
            if (options.Mode == "--apply")
            {
                using var writeHandle = Open(identity.Pid, WriteAccess);
                // Revalidate immediately on this same thread before the only mutation. No remote threads are created.
                if (FindIdentity(identity.Pid) != identity) throw new InvalidOperationException("Weixin process/module identity changed");
                if (Hash(File.ReadAllBytes(identity.Path)) != hash) throw new InvalidOperationException("Weixin.dll changed on disk during validation");
                value = ValidateLive(writeHandle, identity, image, candidate);
                if (value != oldValue) throw new InvalidOperationException("Accessibility state changed during validation; run --check again");
                if (value == 0)
                {
                    var address = new IntPtr(checked(identity.BaseAddress + candidate.TargetRva));
                    mutationAttempted = true;
                    if (!WriteProcessMemory(writeHandle, address, [1], 1, out var written) || written != 1)
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Single-byte activation write failed; run --check to inspect current state");
                    applied = true;
                    value = Read(writeHandle, address, 1)[0];
                    if (value != 1) throw new InvalidOperationException("Activation read-back failed; current state must be checked before retry");
                }
            }
            Write(new {
                ok = true, mode = options.Mode[2..], pid = identity.Pid, processStartedAtUtc = new DateTime(identity.StartedAt, DateTimeKind.Utc),
                module = new { path = identity.Path, version = identity.Version, sha256 = hash, baseAddress = $"0x{identity.BaseAddress:X}", size = identity.Size },
                evidence = Describe(candidate), previousValue = oldValue, currentValue = value, applied,
                instructionsMatch = true, memoryWritableNonExecutable = true,
                note = "A validated gate is not proof of UIA send support. Re-run wechat:inspect after explicit activation; no chat/window actions are performed here."
            });
            return 0;
        }
        catch (Exception error)
        {
            Write(new { ok = false, error = error.Message, mutationAttempted,
                note = mutationAttempted ? "A write was attempted; use --check to inspect the current state before any further action."
                    : "No process-memory mutation occurred. No candidate guessing or fallback is performed." });
            return 1;
        }
    }

    private static Options Parse(string[] args)
    {
        var mode = args.Length == 0 ? "--check" : args[0];
        if (mode is not ("--check" or "--apply" or "--scan" or "--self-test"))
            throw new ArgumentException("Usage: --check [--pid PID] | --apply --pid PID --expected-sha256 HASH | --scan DLL_PATH | --self-test");
        if (mode == "--self-test")
        {
            if (args.Length != 1) throw new ArgumentException("--self-test takes no other arguments");
            return new(mode, null, null, null);
        }
        if (mode == "--scan")
        {
            if (args.Length != 2) throw new ArgumentException("--scan requires one DLL file path");
            return new(mode, null, null, Path.GetFullPath(args[1]));
        }
        int? pid = null;
        string? hash = null;
        for (var index = 1; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length) throw new ArgumentException("Missing argument value");
            if (args[index] == "--pid" && pid is null && int.TryParse(args[index + 1], out var parsed) && parsed > 0) pid = parsed;
            else if (args[index] == "--expected-sha256" && hash is null && args[index + 1].Length == 64 && args[index + 1].All(Uri.IsHexDigit)) hash = args[index + 1];
            else throw new ArgumentException("Unknown, duplicate or invalid argument");
        }
        if (mode == "--apply" && (pid is null || hash is null))
            throw new ArgumentException("--apply requires an explicit --pid and --expected-sha256 from a prior --check");
        return new(mode, pid, hash, null);
    }

    private static ModuleIdentity FindIdentity(int? pid)
    {
        var identities = new List<ModuleIdentity>();
        var processes = pid.HasValue ? new[] { Process.GetProcessById(pid.Value) } : Process.GetProcessesByName("Weixin");
        foreach (var process in processes)
        {
            using (process)
            {
                if (!process.ProcessName.Equals("Weixin", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("PID is not Weixin.exe");
                var modules = process.Modules.Cast<ProcessModule>().Where(module => module.ModuleName.Equals("Weixin.dll", StringComparison.OrdinalIgnoreCase)).ToArray();
                if (modules.Length == 0) continue;
                if (modules.Length != 1) throw new InvalidOperationException("Ambiguous Weixin.dll modules");
                var module = modules[0];
                var version = FileVersionInfo.GetVersionInfo(module.FileName);
                if (version.FileMajorPart != 4) throw new InvalidOperationException("Only Weixin 4.x is supported");
                identities.Add(new(process.Id, process.StartTime.ToUniversalTime().Ticks, module.BaseAddress.ToInt64(), module.ModuleMemorySize,
                    Path.GetFullPath(module.FileName), $"{version.FileMajorPart}.{version.FileMinorPart}.{version.FileBuildPart}.{version.FilePrivatePart}"));
            }
        }
        if (identities.Count != 1) throw new InvalidOperationException($"Expected one Weixin.exe with Weixin.dll, found {identities.Count}; select --pid explicitly");
        return identities[0];
    }

    private static byte ValidateLive(SafeProcessHandle handle, ModuleIdentity identity, GateScanner scanner, GateCandidate candidate)
    {
        if (FindIdentity(identity.Pid) != identity) throw new InvalidOperationException("Process/module identity changed");
        if (!scanner.MatchesLoadedHeader(Read(handle, new IntPtr(identity.BaseAddress), scanner.HeaderSize), identity.BaseAddress))
            throw new InvalidOperationException("Loaded PE headers differ from the on-disk module (only exact mapped ImageBase relocation is allowed)");
        Match(handle, identity.BaseAddress, candidate.Gate);
        Match(handle, identity.BaseAddress, candidate.LogReference);
        Match(handle, identity.BaseAddress, candidate.Anchor);
        var address = new IntPtr(checked(identity.BaseAddress + candidate.TargetRva));
        if (VirtualQueryEx(handle, address, out var region, (nuint)Marshal.SizeOf<MemoryRegion>()) == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query gate memory page");
        var offset = checked(address.ToInt64() - region.BaseAddress.ToInt64());
        if (region.State != 0x1000 || region.Type != 0x1000000 || region.AllocationBase.ToInt64() != identity.BaseAddress
            || offset < 0 || (ulong)offset >= (ulong)region.Size || region.Protect is not (0x04 or 0x08))
            throw new InvalidOperationException("Gate memory must be committed, writable non-executable MEM_IMAGE belonging to the selected module");
        var value = Read(handle, address, 1)[0];
        if (value > 1) throw new InvalidOperationException($"Gate byte must be 0 or 1, observed {value}");
        return value;
    }

    private static void Match(SafeProcessHandle handle, long baseAddress, Evidence evidence)
    {
        var live = Read(handle, new IntPtr(checked(baseAddress + evidence.Rva)), evidence.Bytes.Length);
        if (!live.SequenceEqual(evidence.Bytes))
        {
            var different = Enumerable.Range(0, live.Length).Where(index => live[index] != evidence.Bytes[index]).ToArray();
            throw new InvalidOperationException($"Loaded bytes do not match on-disk evidence at RVA 0x{evidence.Rva:X}; "
                + $"first mismatch offset=0x{different[0]:X}, mismatched bytes={different.Length}");
        }
    }
    private static SafeProcessHandle Open(int pid, uint access)
    {
        var handle = OpenProcess(access, false, pid);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open selected Weixin process"); }
        return handle;
    }
    private static byte[] Read(SafeProcessHandle handle, IntPtr address, int length)
    {
        var bytes = new byte[length];
        if (!ReadProcessMemory(handle, address, bytes, (nuint)length, out var read) || read != (nuint)length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read complete validation evidence from selected Weixin process");
        return bytes;
    }
    private static object Describe(GateCandidate gate) => new {
        uniqueTarget = true, targetRva = $"0x{gate.TargetRva:X}", dataSection = gate.Section,
        gateInstructionRva = $"0x{gate.Gate.Rva:X}", logReferenceRva = $"0x{gate.LogReference.Rva:X}",
        logAnchorRva = $"0x{gate.Anchor.Rva:X}", logReferenceDistance = gate.ReferenceDistance
    };
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static void Write(object value) => Console.WriteLine(JsonSerializer.Serialize(value));

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryRegion
    {
        public IntPtr BaseAddress, AllocationBase;
        public uint AllocationProtect;
        public nuint Size;
        public uint State, Protect, Type;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(SafeProcessHandle process, IntPtr address, byte[] buffer, nuint size, out nuint read);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(SafeProcessHandle process, IntPtr address, byte[] buffer, nuint size, out nuint written);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nuint VirtualQueryEx(SafeProcessHandle process, IntPtr address, out MemoryRegion information, nuint length);
}
