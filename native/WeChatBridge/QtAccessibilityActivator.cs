using System.Buffers.Binary;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

namespace WeChatBridge;

/// <summary>
/// Activates the accessibility provider already embedded in Weixin.dll.
/// The target is accepted only after PE-section, instruction-pattern and
/// current-byte validation. No code is injected and no on-disk file is changed.
/// </summary>
internal static class QtAccessibilityActivator
{
    private const uint ProcessVmOperation = 0x0008;
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessVmWrite = 0x0020;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ImageScnMemExecute = 0x20000000;
    private const uint ImageScnMemWrite = 0x80000000;
    private static readonly byte[] CoreMarker = Encoding.ASCII.GetBytes("qt.accessibility.core");
    private static readonly Dictionary<string, int> RvaCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<int> ActivatedProcesses = [];
    private static readonly object Sync = new();

    private sealed record PeSection(int VirtualSize, int VirtualAddress, int RawSize, int RawOffset, uint Characteristics);

    public static bool TryActivate(AutomationElement root, out string detail)
    {
        detail = "not_attempted";
        try
        {
            var hwnd = new IntPtr(root.Current.NativeWindowHandle);
            if (hwnd == IntPtr.Zero)
            {
                detail = "missing_window_handle";
                return false;
            }
            GetWindowThreadProcessId(hwnd, out var pidValue);
            var pid = checked((int)pidValue);
            if (pid <= 0)
            {
                detail = "missing_process_id";
                return false;
            }
            lock (Sync)
            {
                if (ActivatedProcesses.Contains(pid))
                {
                    detail = $"already_activated; pid={pid}";
                    return true;
                }
            }

            using var process = Process.GetProcessById(pid);
            var module = process.Modules.Cast<ProcessModule>().FirstOrDefault(item =>
                string.Equals(item.ModuleName, "Weixin.dll", StringComparison.OrdinalIgnoreCase));
            if (module?.FileName is not { Length: > 0 } dllPath || module.BaseAddress == IntPtr.Zero)
            {
                detail = $"weixin_dll_not_found; pid={pid}";
                return false;
            }

            var rva = FindGateRva(dllPath);
            if (rva is null)
            {
                detail = $"gate_pattern_not_found; version={FileVersionInfo.GetVersionInfo(dllPath).FileVersion ?? "unknown"}";
                return false;
            }

            var access = ProcessQueryInformation | ProcessVmRead | ProcessVmWrite | ProcessVmOperation;
            var processHandle = OpenProcess(access, false, pidValue);
            if (processHandle == IntPtr.Zero)
            {
                detail = $"open_process_failed; pid={pid}; win32={Marshal.GetLastWin32Error()}";
                return false;
            }
            try
            {
                var address = new IntPtr(module.BaseAddress.ToInt64() + rva.Value);
                if (!TryReadByte(processHandle, address, out var current) || current is not (0 or 1))
                {
                    detail = $"gate_byte_invalid; pid={pid}; rva=0x{rva:x}";
                    return false;
                }
                if (current == 0 && !TryWriteByte(processHandle, address, 1))
                {
                    detail = $"gate_write_failed; pid={pid}; rva=0x{rva:x}; win32={Marshal.GetLastWin32Error()}";
                    return false;
                }
                if (!TryReadByte(processHandle, address, out var verified) || verified != 1)
                {
                    detail = $"gate_verification_failed; pid={pid}; rva=0x{rva:x}";
                    return false;
                }
                lock (Sync) ActivatedProcesses.Add(pid);
                detail = $"activated; pid={pid}; rva=0x{rva:x}; previous={current}";
                return true;
            }
            finally
            {
                CloseHandle(processHandle);
            }
        }
        catch (Exception error)
        {
            detail = $"activation_error; type={error.GetType().Name}; message={error.Message}";
            return false;
        }
    }

    private static int? FindGateRva(string dllPath)
    {
        lock (Sync)
        {
            if (RvaCache.TryGetValue(dllPath, out var cached)) return cached;
        }
        var data = File.ReadAllBytes(dllPath);
        var sections = ReadSections(data);
        if (sections.Count == 0) return null;
        var coreOffset = FindSequence(data, CoreMarker, 0);
        var coreRva = coreOffset >= 0 ? OffsetToRva(sections, coreOffset) : null;
        var coreReferences = coreRva is int markerRva ? FindRipReferences(data, sections, markerRva) : [];
        var candidates = new List<(long Distance, int Rva)>();

        for (var offset = 0; offset <= data.Length - 18; offset++)
        {
            if (data[offset] != 0x48 || data[offset + 1] != 0x85 || data[offset + 2] != 0xc9
                || data[offset + 3] != 0x0f || data[offset + 4] != 0x84
                || data[offset + 9] != 0x80 || data[offset + 10] != 0x3d
                || data[offset + 15] != 0x00 || data[offset + 16] != 0x0f || data[offset + 17] != 0x84)
                continue;
            var matchRva = OffsetToRva(sections, offset);
            var displacementRva = OffsetToRva(sections, offset + 11);
            if (matchRva is null || displacementRva is null) continue;
            var matchSection = SectionForRva(sections, matchRva.Value);
            if (matchSection is null || (matchSection.Characteristics & ImageScnMemExecute) == 0) continue;
            var compareRva = displacementRva.Value - 2;
            var displacement = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 11, 4));
            var targetRva = compareRva + 7 + displacement;
            var targetSection = SectionForRva(sections, targetRva);
            if (targetSection is null || (targetSection.Characteristics & ImageScnMemWrite) == 0) continue;
            var distance = coreReferences.Count == 0
                ? int.MaxValue
                : coreReferences.Min(reference => (long)Math.Abs(reference - matchRva.Value));
            if (coreReferences.Count > 0 && distance > 0x20000) continue;
            candidates.Add((distance, targetRva));
        }
        if (candidates.Count == 0) return null;
        var result = candidates.OrderBy(item => item.Distance).First().Rva;
        lock (Sync) RvaCache[dllPath] = result;
        return result;
    }

    private static List<PeSection> ReadSections(byte[] data)
    {
        var output = new List<PeSection>();
        if (data.Length < 0x40) return output;
        var peOffset = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(0x3c, 4));
        if (peOffset < 0 || peOffset + 24 > data.Length || data[peOffset] != (byte)'P' || data[peOffset + 1] != (byte)'E')
            return output;
        var coff = peOffset + 4;
        var count = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(coff + 2, 2));
        var optionalSize = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(coff + 16, 2));
        var sectionOffset = coff + 20 + optionalSize;
        for (var index = 0; index < count; index++)
        {
            var offset = sectionOffset + index * 40;
            if (offset < 0 || offset + 40 > data.Length) return [];
            output.Add(new PeSection(
                BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 8, 4)),
                BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 12, 4)),
                BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 16, 4)),
                BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 20, 4)),
                BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset + 36, 4))));
        }
        return output;
    }

    private static int? OffsetToRva(IEnumerable<PeSection> sections, int offset)
    {
        foreach (var section in sections)
            if (offset >= section.RawOffset && offset < section.RawOffset + section.RawSize)
                return section.VirtualAddress + offset - section.RawOffset;
        return null;
    }

    private static PeSection? SectionForRva(IEnumerable<PeSection> sections, int rva) => sections.FirstOrDefault(section =>
        rva >= section.VirtualAddress && rva < section.VirtualAddress + Math.Max(section.VirtualSize, section.RawSize));

    private static List<int> FindRipReferences(byte[] data, IEnumerable<PeSection> sections, int targetRva)
    {
        var output = new List<int>();
        foreach (var section in sections.Where(item => (item.Characteristics & ImageScnMemExecute) != 0))
        {
            var end = Math.Min(data.Length, section.RawOffset + section.RawSize);
            for (var offset = section.RawOffset; offset <= end - 7; offset++)
            {
                if (data[offset] is >= 0x40 and <= 0x4f && data[offset + 1] == 0x8d && (data[offset + 2] & 0xc7) == 0x05)
                {
                    var displacement = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 3, 4));
                    var instructionRva = section.VirtualAddress + offset - section.RawOffset;
                    if (instructionRva + 7 + displacement == targetRva) output.Add(instructionRva);
                }
                if (data[offset] == 0x8d && (data[offset + 1] & 0xc7) == 0x05)
                {
                    var displacement = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 2, 4));
                    var instructionRva = section.VirtualAddress + offset - section.RawOffset;
                    if (instructionRva + 6 + displacement == targetRva) output.Add(instructionRva);
                }
            }
        }
        return output;
    }

    private static int FindSequence(byte[] data, byte[] sequence, int start)
    {
        for (var offset = Math.Max(0, start); offset <= data.Length - sequence.Length; offset++)
            if (data.AsSpan(offset, sequence.Length).SequenceEqual(sequence)) return offset;
        return -1;
    }

    private static bool TryReadByte(IntPtr process, IntPtr address, out byte value)
    {
        var buffer = new byte[1];
        var ok = ReadProcessMemory(process, address, buffer, (UIntPtr)1, out var count) && count.ToUInt64() == 1;
        value = ok ? buffer[0] : (byte)0;
        return ok;
    }

    private static bool TryWriteByte(IntPtr process, IntPtr address, byte value)
    {
        var buffer = new[] { value };
        return WriteProcessMemory(process, address, buffer, (UIntPtr)1, out var count) && count.ToUInt64() == 1;
    }

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
