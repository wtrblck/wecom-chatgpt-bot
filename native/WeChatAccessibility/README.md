# WeChat accessibility diagnostic helper

Standalone Windows x64 / .NET 10 helper. It scans the running Weixin 4.x module for the Qt accessibility gate using the attributed upstream algorithm with stricter validation. It never selects a chat, restores a window, enters text, sends a message, injects a DLL or creates a remote thread.

The default mode is read-only. Keep the published folder inside this project.

```powershell
# Use the project's cached build environment, then publish:
$env:DOTNET_CLI_HOME = "$PWD/.dotnet-home"
$env:NUGET_PACKAGES = "$PWD/.nuget/packages"
$env:TEMP = "$PWD/.cache/tmp"
$env:TMP = $env:TEMP
dotnet publish native/WeChatAccessibility/WeChatAccessibility.csproj -c Release -r win-x64 --self-contained false -o native/WeChatAccessibility/publish

# Offline synthetic PE tests (no running process access):
native/WeChatAccessibility/publish/WeChatAccessibility.exe --self-test

# Read-only candidate and live-byte validation; reports PID, version and hash:
native/WeChatAccessibility/publish/WeChatAccessibility.exe --check

# Optional disk-only scan:
native/WeChatAccessibility/publish/WeChatAccessibility.exe --scan 'C:/path/to/Weixin.dll'
```

Activation is a separate explicit command, never invoked by the bot, setup or `--check`. Use the exact PID and SHA-256 reported by a recent successful `--check`:

```powershell
native/WeChatAccessibility/publish/WeChatAccessibility.exe --apply --pid <PID> --expected-sha256 <SHA256>
```

`--apply` rechecks the process start time, module version/path/base/size, disk hash, PE headers, candidate instruction and log-reference bytes in memory, committed image-page ownership/protection, and original value of 0 or 1 immediately before writing. It writes **one byte, 0 → 1**, then reads that byte back. An original value of 1 performs no write. It does not make memory executable, change page protections, inject code or bypass access-denied errors.

PE headers must match byte-for-byte, with one precise loader allowance: the PE32+ `OptionalHeader.ImageBase` field may equal the actual mapped module base instead of the preferred on-disk base. Every other header byte still must match. This allowance was observed in the local 4.1.13.12 module and has dedicated positive/negative offline tests.

The algorithm requires a unique target, not merely the closest match. Multiple targets, absent log evidence, changed process/module, unexpected byte values, wrong page attributes or mismatched disk/live bytes stop execution. There is no forced mode or hard-coded offset fallback. Some legitimate Weixin builds may therefore be rejected.

Successful `--check` proves that the guarded candidate matches current evidence; it does **not** prove semantic correctness or that activation has been tested. Successful `--apply` proves only byte read-back, not UIA sending. After an intentional activation, run `npm run wechat:inspect` and validate available controls before enabling the bot. Activation can be lost when Weixin exits. This helper does not restore the byte to 0 because an accessibility client may rely on the enabled state.

Output is one JSON record without message content, contacts or database keys. Exceptions after an attempted write report failure; inspect the current state with `--check` before deciding what to do next.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and the Apache 2.0 license.
