$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$relativePaths = @(
    '.cache/desktop-build', '.cache/desktop-smoke', '.cache/npm', '.cache/pip',
    '.cache/pycache', '.cache/tests', '.cache/tmp', '.nuget', '.dotnet-home',
    'native/WeChatDesktop/bin', 'native/WeChatDesktop/obj',
    'native/WeChatBridge/bin', 'native/WeChatBridge/obj',
    'native/WeChatAccessibility/bin', 'native/WeChatAccessibility/obj',
    'dist/test', 'release/WeChatGPT/app/.cache/desktop-smoke',
    'release/WeChatGPT/app/.cache/tmp', 'release/WeChatGPT/app/.cache/pycache',
    'release/WeChatGPT/app/.dotnet-home', 'release/WeChatGPT/app/.nuget'
)
$total = 0L
foreach ($relative in $relativePaths) {
    $target = [IO.Path]::GetFullPath((Join-Path $project $relative))
    if (!$target.StartsWith($project + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe cleanup target: $target" }
    if (!(Test-Path -LiteralPath $target)) { continue }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (!$resolved.StartsWith($project + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Target escaped project: $resolved" }
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse-point cleanup: $resolved" }
    $bytes = (Get-ChildItem -LiteralPath $resolved -Recurse -File -Force | Measure-Object Length -Sum).Sum
    Remove-Item -LiteralPath $resolved -Recurse -Force
    $total += $bytes
    Write-Output ("Removed {0} ({1:N1} MB)" -f $relative, ($bytes / 1MB))
}
$files = @('.cache/desktop-startup-error.txt', '.cache/desktop-smoke-error.txt', 'release/WeChatGPT/app/logs/desktop.log')
foreach ($relative in $files) {
    $target = [IO.Path]::GetFullPath((Join-Path $project $relative))
    if (!$target.StartsWith($project + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe cleanup file: $target" }
    if (Test-Path -LiteralPath $target) { $total += (Get-Item -LiteralPath $target).Length; Remove-Item -LiteralPath $target -Force }
}
Write-Output ("Total reclaimed: {0:N1} MB" -f ($total / 1MB))
