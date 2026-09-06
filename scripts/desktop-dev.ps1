$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $project
$env:DOTNET_CLI_HOME = Join-Path $project '.dotnet-home'
$env:NUGET_PACKAGES = Join-Path $project '.nuget/packages'
& node scripts/project-run.mjs build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
& dotnet build native/WeChatDesktop/WeChatDesktop.csproj -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
& "$project/native/WeChatDesktop/bin/Release/net10.0-windows/WeChatGPT.exe" --project $project
