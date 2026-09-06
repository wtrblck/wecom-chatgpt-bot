param([switch]$SkipBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force -Path '.cache/tmp' | Out-Null
$env:TEMP = Join-Path $projectRoot '.cache/tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $projectRoot '.cache/pip'
$env:PYTHONPYCACHEPREFIX = Join-Path $projectRoot '.cache/pycache'
$env:npm_config_cache = Join-Path $projectRoot '.cache/npm'
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Setup command failed: $LASTEXITCODE" } }
npm ci --no-audit --no-fund
Check-Exit
if (!(Test-Path '.venv-wechatdb/Scripts/python.exe')) {
  python -m venv .venv-wechatdb
  Check-Exit
}
& '.venv-wechatdb/Scripts/python.exe' -m pip install -r scripts/requirements-wechat-db.txt
Check-Exit
node scripts/project-run.mjs native
Check-Exit
node scripts/project-run.mjs accessibility-build
Check-Exit
if (!$SkipBrowser) {
  node scripts/project-run.mjs playwright
  Check-Exit
}
if (!(Test-Path '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (!(Test-Path 'config/wechat-conversations.json')) {
  Copy-Item -LiteralPath 'config/wechat-conversations.example.json' -Destination 'config/wechat-conversations.json'
}
Write-Host 'Setup complete. Edit config/wechat-conversations.json and .env, then run npm run doctor.'
