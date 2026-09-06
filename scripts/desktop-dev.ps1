param([switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $project
$env:DOTNET_CLI_HOME = Join-Path $project '.dotnet-home'
$env:NUGET_PACKAGES = Join-Path $project '.nuget/packages'
& node scripts/project-run.mjs build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
& dotnet build native/WeChatDesktop/WeChatDesktop.csproj -c Debug --nologo -p:UseAppHost=false -p:TargetPlatformDisplayName=Windows
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
$desktopArgs = @("$project/native/WeChatDesktop/bin/Debug/net10.0-windows/WeChatGPT.dll", '--project', $project)
if ($SmokeTest) { $desktopArgs += '--smoke-test' }
& dotnet @desktopArgs
if ($LASTEXITCODE -ne 0) { throw 'Desktop exited with an error' }
