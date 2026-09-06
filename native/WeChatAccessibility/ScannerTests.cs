using System.Buffers.Binary;
using System.Text;

namespace WeChatAccessibility;

internal static class ScannerTests
{
    public static int Run()
    {
        var passed = 0;
        void Check(bool condition) { if (!condition) throw new InvalidOperationException("Offline scanner assertion failed"); passed++; }
        void Reject(Action<byte[]> mutate)
        {
            var bytes = Fixture(); mutate(bytes);
            try { new GateScanner(bytes).Scan(); }
            catch (Exception error) when (error is InvalidDataException or BadImageFormatException) { passed++; return; }
            throw new InvalidOperationException("Unsafe synthetic PE was accepted");
        }
        var valid = new GateScanner(Fixture()).Scan();
        Check(valid.TargetRva == 0x3000 && valid.Section == ".data" && valid.Gate.Rva == 0x1040);
        Check(valid.LogReference.Rva == 0x1080 && valid.ReferenceDistance == 0x40 && valid.Anchor.Rva == 0x2000);
        var headerImage = new GateScanner(Fixture());
        var loadedHeader = headerImage.HeaderBytes;
        BinaryPrimitives.WriteInt64LittleEndian(loadedHeader.AsSpan(0xb0, 8), 0x7fff12340000);
        Check(headerImage.MatchesLoadedHeader(loadedHeader, 0x7fff12340000));
        Check(!headerImage.MatchesLoadedHeader(loadedHeader, 0x7fff56780000));
        loadedHeader[0x9a] ^= 1;
        Check(!headerImage.MatchesLoadedHeader(loadedHeader, 0x7fff12340000));
        Reject(bytes => WriteGate(bytes, 0x460, 0x1060, 0x3001)); // Two possible addresses: never pick the closest.
        Reject(bytes => bytes.AsSpan(0x800, 21).Clear()); // Mandatory log anchor.
        Reject(bytes => Encoding.ASCII.GetBytes("qt.accessibility.core").CopyTo(bytes, 0x840)); // Ambiguous anchor.
        Reject(bytes => bytes.AsSpan(0x480, 7).Clear()); // Mandatory RIP-relative reference.
        Reject(bytes => U32(bytes, 0x188 + 2 * 40 + 36, 0xE0000040)); // Writable+executable destination.
        Reject(bytes => U32(bytes, 0x188 + 2 * 40 + 36, 0x40000040)); // Read-only destination.
        Reject(bytes => U16(bytes, 0x84, 0xaa64)); // Wrong architecture.
        Reject(bytes => U16(bytes, 0x98, 0x10b)); // Wrong optional header format.
        Reject(bytes => U32(bytes, 0x188 + 20, 0xffffff00)); // Raw section outside file.
        Reject(bytes => U32(bytes, 0x188 + 40 + 12, 0x1000)); // Overlapping virtual sections.
        Reject(bytes => bytes[0x440] = 0x49); // Similar opcode is insufficient.
        var sameTarget = Fixture();
        WriteGate(sameTarget, 0x460, 0x1060, 0x3000);
        Check(new GateScanner(sameTarget).Scan().TargetRva == 0x3000); // Multiple guards of exactly the same byte are allowed.
        return passed;
    }

    private static byte[] Fixture()
    {
        var bytes = new byte[0xc00];
        bytes[0] = (byte)'M'; bytes[1] = (byte)'Z'; U32(bytes, 0x3c, 0x80);
        bytes[0x80] = (byte)'P'; bytes[0x81] = (byte)'E';
        U16(bytes, 0x84, 0x8664); U16(bytes, 0x86, 3); U16(bytes, 0x94, 0xf0); U16(bytes, 0x96, 0x2022);
        U16(bytes, 0x98, 0x20b); U32(bytes, 0x98 + 32, 0x1000); U32(bytes, 0x98 + 36, 0x200);
        U32(bytes, 0x98 + 56, 0x4000); U32(bytes, 0x98 + 60, 0x400); U32(bytes, 0x98 + 108, 16);
        Section(bytes, 0, ".text", 0x1000, 0x400, 0x400, 0x60000020);
        Section(bytes, 1, ".rdata", 0x2000, 0x800, 0x200, 0x40000040);
        Section(bytes, 2, ".data", 0x3000, 0xa00, 0x200, 0xc0000040);
        WriteGate(bytes, 0x440, 0x1040, 0x3000);
        bytes[0x480] = 0x48; bytes[0x481] = 0x8d; bytes[0x482] = 0x0d;
        U32(bytes, 0x483, 0x2000 - 0x1080 - 7);
        Encoding.ASCII.GetBytes("qt.accessibility.core").CopyTo(bytes, 0x800);
        return bytes;
    }
    private static void Section(byte[] bytes, int index, string name, uint rva, uint raw, uint length, uint flags)
    {
        var offset = 0x188 + index * 40;
        Encoding.ASCII.GetBytes(name).CopyTo(bytes, offset);
        U32(bytes, offset + 8, length); U32(bytes, offset + 12, rva);
        U32(bytes, offset + 16, length); U32(bytes, offset + 20, raw); U32(bytes, offset + 36, flags);
    }
    private static void WriteGate(byte[] bytes, int offset, int rva, int target)
    {
        byte[] pattern = [0x48, 0x85, 0xc9, 0x0f, 0x84, 0, 0, 0, 0, 0x80, 0x3d, 0, 0, 0, 0, 0, 0x0f, 0x84];
        pattern.CopyTo(bytes, offset);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset + 11, 4), target - rva - 16);
    }
    private static void U16(byte[] bytes, int offset, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset, 2), value);
    private static void U32(byte[] bytes, int offset, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset, 4), value);
}
