param([switch]$SkipNative, [switch]$NoArchive)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $project
$env:DOTNET_CLI_HOME = Join-Path $project '.dotnet-home'
$env:NUGET_PACKAGES = Join-Path $project '.nuget/packages'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:TEMP = Join-Path $project '.cache/tmp'
$env:TMP = $env:TEMP
$stage = Join-Path $project 'release/WeChatGPT'
$payload = Join-Path $stage 'app'
$cache = Join-Path $project '.cache/desktop-build'
New-Item -ItemType Directory -Force $payload,$cache,$env:TEMP | Out-Null
function Check-Exit([string]$step) { if ($LASTEXITCODE -ne 0) { throw "$step failed: $LASTEXITCODE" } }
function Copy-Tree([string]$source, [string]$destination) {
    New-Item -ItemType Directory -Force $destination | Out-Null
    & robocopy $source $destination /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD __pycache__ .git /XF '*.pyc' '*.pdb' '*.map' | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed: $source" }
}
& node scripts/project-run.mjs build
Check-Exit 'TypeScript build'
& "$PSScriptRoot/desktop-icon.ps1"
& dotnet publish native/WeChatDesktop/WeChatDesktop.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o $stage --nologo
Check-Exit 'Desktop publish'
if (!$SkipNative) {
    & dotnet publish native/WeChatBridge/WeChatBridge.csproj -c Release -r win-x64 --self-contained true -p:DebugType=None -o "$payload/native/WeChatBridge/publish" --nologo
    Check-Exit 'Bridge publish'
}
Copy-Tree "$project/dist/src" "$payload/dist/src"
Copy-Tree "$project/dist/scripts" "$payload/dist/scripts"
Copy-Tree "$project/scripts" "$payload/scripts"
Copy-Tree "$project/vendor/wechatauto-replica/wechatauto" "$payload/vendor/wechatauto-replica/wechatauto"
Copy-Tree "$project/docs" "$payload/docs"
New-Item -ItemType Directory -Force "$payload/config","$payload/runtime","$payload/node_modules" | Out-Null
Copy-Item -LiteralPath "$project/package.json","$project/LICENSE","$project/.env.example" -Destination $payload -Force
Copy-Item -LiteralPath "$project/config/wechat-conversations.example.json" -Destination "$payload/config" -Force
Copy-Item -LiteralPath "$project/vendor/wechatauto-replica/LICENSE","$project/vendor/wechatauto-replica/UPSTREAM.md" -Destination "$payload/vendor/wechatauto-replica" -Force
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination "$payload/runtime/node.exe" -Force
$nodeVersion = (& node --version).Trim()
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile "$payload/runtime/NODE-LICENSE.txt" -TimeoutSec 60
$dotnetLicenseRoots = @(
    (Join-Path $env:NUGET_PACKAGES 'microsoft.netcore.app.runtime.win-x64'),
    (Join-Path $env:NUGET_PACKAGES 'microsoft.windowsdesktop.app.runtime.win-x64')
)
foreach ($licenseRoot in $dotnetLicenseRoots) {
    if (Test-Path -LiteralPath $licenseRoot) {
        $versionRoot = Get-ChildItem -LiteralPath $licenseRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        foreach ($noticeFile in @('LICENSE','LICENSE.TXT','THIRD-PARTY-NOTICES.TXT')) {
            $source = Join-Path $versionRoot.FullName $noticeFile
            if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $payload "runtime/$($versionRoot.Parent.Name)-$noticeFile") -Force }
        }
    }
}
$modules = & npm.cmd ls --omit=dev --all --parseable
Check-Exit 'Production dependency listing'
foreach ($module in $modules) {
    if ($module.StartsWith((Join-Path $project 'node_modules') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $relative = [IO.Path]::GetRelativePath($project, $module)
        Copy-Tree $module (Join-Path $payload $relative)
    }
}
$browserRegistry = Get-Content "$project/node_modules/playwright-core/browsers.json" -Raw | ConvertFrom-Json
$chromium = $browserRegistry.browsers | Where-Object name -eq 'chromium'
$ffmpeg = $browserRegistry.browsers | Where-Object name -eq 'ffmpeg'
foreach ($browser in @($chromium,$ffmpeg)) {
    $folder = "$($browser.name)-$($browser.revision)"
    if (!(Test-Path -LiteralPath "$project/.cache/ms-playwright/$folder")) { throw "Browser missing: $folder; run npm run playwright:install" }
    Copy-Tree "$project/.cache/ms-playwright/$folder" "$payload/.cache/ms-playwright/$folder"
}
$pythonArchive = Join-Path $cache 'python-embed.zip'
if (!(Test-Path -LiteralPath $pythonArchive)) { Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.14.3/python-3.14.3-embed-amd64.zip' -OutFile $pythonArchive -TimeoutSec 120 }
$pythonRoot = Join-Path $payload 'runtime/python'
New-Item -ItemType Directory -Force $pythonRoot | Out-Null
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonRoot -Force
Set-Content -LiteralPath "$pythonRoot/python314._pth" -Encoding utf8 -Value @('python314.zip','.','Lib/site-packages','import site')
& "$project/.venv-wechatdb/Scripts/python.exe" -m pip install --disable-pip-version-check --cache-dir "$project/.cache/pip" --only-binary=:all: --target "$pythonRoot/Lib/site-packages" --upgrade -r "$project/scripts/requirements-wechat-db.txt"
Check-Exit 'Portable Python dependencies'
& "$pythonRoot/python.exe" -c 'import sqlite3, ctypes, zstandard; from cryptography.hazmat.primitives.ciphers import Cipher; print("Portable Python ready")'
Check-Exit 'Portable Python smoke'
if (!(Test-Path -LiteralPath "$payload/.env")) {
    Set-Content -LiteralPath "$payload/.env" -Encoding utf8 -Value @('WECHAT_ENABLED=true','WECOM_ENABLED=false','WECHAT_READ_MODE=db','WECHAT_SEND_MODE=uia','WECHAT_SEND_ACTION=enter','WECHAT_REQUIRE_PREFIX=true','WECHAT_PREFIX=/gpt','WECHAT_PREFIX_ALIASES=@ChatBOT,@chatbot','WECHAT_DB_PYTHON_PATH=./runtime/python/python.exe')
}
if (!(Test-Path -LiteralPath "$payload/config/wechat-conversations.json")) { Set-Content -LiteralPath "$payload/config/wechat-conversations.json" -Encoding utf8 -Value '{"conversations":[]}' }
Copy-Item -LiteralPath "$project/docs/desktop-guide.md" -Destination "$stage/使用说明.txt" -Force
Set-Content -LiteralPath "$stage/THIRD-PARTY-NOTICES.txt" -Encoding utf8 -Value 'Includes .NET Desktop Runtime, Node.js, Chromium/FFmpeg (Playwright), CPython, Python packages, npm packages and WeChatBridge/Tesseract. License files are retained alongside their components. Python uses the official python.org embedded distribution. No personal account profile, secret, chat history, database or real listener configuration is included.'
Push-Location $payload
try {
    & ./runtime/node.exe --input-type=module -e 'import Database from "better-sqlite3"; const db=new Database(":memory:"); console.log("Portable SQLite ready",db.prepare("select 1 as n").get().n); db.close();'
    Check-Exit 'Portable Node ABI smoke'
} finally { Pop-Location }
if (!$NoArchive) {
    $archive = Join-Path $project 'release/WeChatGPT-1.1.0-win-x64.zip'
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
    Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Format-List
}
Get-Item -LiteralPath "$stage/WeChatGPT.exe" | Select-Object FullName,Length
