// Adapted from fanyuantaier/wechatauto-replica (Apache-2.0), uia_driver.py,
// commit b9a9f5619f34c6a3e6eb15c27ec73d0adbbb4386. See THIRD_PARTY_NOTICES.md.
// Changes: strict PE validation, mandatory log-string references, unique target,
// non-executable writable data section, no hard-coded RVA or nearest-target fallback.
using System.Buffers.Binary;
using System.Reflection.PortableExecutable;
using System.Text;

namespace WeChatAccessibility;

internal sealed record Evidence(int Rva, byte[] Bytes);
internal sealed record GateCandidate(int TargetRva, string Section, int ReferenceDistance, Evidence Gate, Evidence LogReference, Evidence Anchor);

internal sealed class GateScanner
{
    private readonly byte[] data;
    private readonly SectionHeader[] sections;
    public int ImageSize { get; }
    public int HeaderSize { get; }
    public int Timestamp { get; }
    public byte[] HeaderBytes => data[..HeaderSize];

    public bool MatchesLoadedHeader(byte[] loaded, long actualBase)
    {
        if (loaded.AsSpan().SequenceEqual(data.AsSpan(0, HeaderSize))) return true;
        // Some loaders rewrite OptionalHeader.ImageBase to the mapped base. Accept
        // exactly that field/value, never mask arbitrary relocated header differences.
        var expected = HeaderBytes;
        var imageBaseOffset = checked(BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(0x3c, 4)) + 48);
        if (imageBaseOffset < 0 || imageBaseOffset + 8 > expected.Length) return false;
        BinaryPrimitives.WriteInt64LittleEndian(expected.AsSpan(imageBaseOffset, 8), actualBase);
        return loaded.AsSpan().SequenceEqual(expected);
    }

    public GateScanner(byte[] data)
    {
        this.data = data;
        using var reader = new PEReader(new MemoryStream(data, writable: false));
        var headers = reader.PEHeaders;
        if (headers.CoffHeader.Machine != Machine.Amd64 || headers.PEHeader?.Magic != PEMagic.PE32Plus)
            throw new InvalidDataException("Only a Windows x64 PE32+ Weixin.dll is supported");
        ImageSize = headers.PEHeader.SizeOfImage;
        HeaderSize = headers.PEHeader.SizeOfHeaders;
        Timestamp = headers.CoffHeader.TimeDateStamp;
        if (ImageSize <= 0 || HeaderSize <= 0 || HeaderSize > data.Length || HeaderSize > 1_048_576)
            throw new InvalidDataException("Invalid PE image/header size");
        sections = headers.SectionHeaders.ToArray();
        if (sections.Length is < 1 or > 96) throw new InvalidDataException("Invalid PE section count");
        foreach (var section in sections)
        {
            if (section.PointerToRawData < 0 || section.SizeOfRawData < 0 || section.VirtualAddress < 0
                || section.VirtualSize < 0 || (long)section.PointerToRawData + section.SizeOfRawData > data.Length
                || (long)section.VirtualAddress + Math.Max(section.VirtualSize, section.SizeOfRawData) > ImageSize)
                throw new InvalidDataException("PE section exceeds file/image bounds");
        }
        var ordered = sections.OrderBy(section => section.VirtualAddress).ToArray();
        for (var index = 1; index < ordered.Length; index++)
            if ((long)ordered[index - 1].VirtualAddress + Math.Max(ordered[index - 1].VirtualSize, ordered[index - 1].SizeOfRawData)
                > ordered[index].VirtualAddress) throw new InvalidDataException("Overlapping PE sections");
    }

    private static bool Executable(SectionHeader section) => (section.SectionCharacteristics & SectionCharacteristics.MemExecute) != 0;
    private static bool Writable(SectionHeader section) => (section.SectionCharacteristics & SectionCharacteristics.MemWrite) != 0;
    private SectionHeader SectionAt(int rva) => sections.Single(section => rva >= section.VirtualAddress
        && (long)rva < (long)section.VirtualAddress + Math.Max(section.VirtualSize, section.SizeOfRawData));

    public GateCandidate Scan()
    {
        var anchorBytes = Encoding.ASCII.GetBytes("qt.accessibility.core");
        var anchors = new List<Evidence>();
        foreach (var section in sections.Where(section => !Executable(section) && !Writable(section)))
        {
            var end = section.PointerToRawData + section.SizeOfRawData - anchorBytes.Length;
            for (var offset = section.PointerToRawData; offset <= end; offset++)
                if (data.AsSpan(offset, anchorBytes.Length).SequenceEqual(anchorBytes))
                    anchors.Add(new(section.VirtualAddress + offset - section.PointerToRawData, anchorBytes));
        }
        if (anchors.Count != 1) throw new InvalidDataException($"Expected one read-only qt.accessibility.core anchor, found {anchors.Count}");
        var anchor = anchors[0];
        var references = new List<Evidence>();
        foreach (var section in sections.Where(Executable))
        {
            var end = section.PointerToRawData + section.SizeOfRawData;
            for (var offset = section.PointerToRawData; offset + 7 <= end; offset++)
            {
                var rva = section.VirtualAddress + offset - section.PointerToRawData;
                if (data[offset] is >= 0x40 and <= 0x4f && data[offset + 1] == 0x8d && (data[offset + 2] & 0xc7) == 0x05
                    && (long)rva + 7 + BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 3, 4)) == anchor.Rva)
                    references.Add(new(rva, data[offset..(offset + 7)]));
                if (data[offset] == 0x8d && (data[offset + 1] & 0xc7) == 0x05
                    && (long)rva + 6 + BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 2, 4)) == anchor.Rva)
                    references.Add(new(rva, data[offset..(offset + 6)]));
            }
        }
        if (references.Count == 0) throw new InvalidDataException("No RIP-relative code reference to accessibility log anchor");
        var candidates = new List<GateCandidate>();
        foreach (var section in sections.Where(Executable))
        {
            var end = section.PointerToRawData + section.SizeOfRawData;
            for (var offset = section.PointerToRawData; offset + 18 <= end; offset++)
            {
                // Upstream pattern: 48 85 C9 0F 84 ???? 80 3D <disp32> 00 0F 84.
                if (data[offset] != 0x48 || data[offset + 1] != 0x85 || data[offset + 2] != 0xc9
                    || data[offset + 3] != 0x0f || data[offset + 4] != 0x84 || data[offset + 9] != 0x80
                    || data[offset + 10] != 0x3d || data[offset + 15] != 0 || data[offset + 16] != 0x0f || data[offset + 17] != 0x84) continue;
                var gateRva = section.VirtualAddress + offset - section.PointerToRawData;
                var target = (long)gateRva + 16 + BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset + 11, 4));
                if (target < 0 || target >= ImageSize) continue;
                SectionHeader targetSection;
                try { targetSection = SectionAt((int)target); } catch (InvalidOperationException) { continue; }
                if (!Writable(targetSection) || Executable(targetSection)) continue;
                var reference = references.MinBy(item => Math.Abs((long)item.Rva - gateRva))!;
                var distance = Math.Abs((long)reference.Rva - gateRva);
                if (distance > 0x20000) continue;
                candidates.Add(new((int)target, targetSection.Name, (int)distance,
                    new(gateRva, data[offset..(offset + 18)]), reference, anchor));
            }
        }
        var targets = candidates.Select(candidate => candidate.TargetRva).Distinct().ToArray();
        if (targets.Length != 1) throw new InvalidDataException($"Expected one validated gate target, found {targets.Length}");
        // Several instructions can guard the same byte; ambiguity across addresses is always rejected.
        return candidates.OrderBy(candidate => candidate.ReferenceDistance).First();
    }
}
