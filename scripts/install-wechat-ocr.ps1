$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot '..\native\WeChatBridge\tessdata'
New-Item -ItemType Directory -Force -Path $destination | Out-Null

$models = @('chi_sim', 'eng')
foreach ($model in $models) {
    $target = Join-Path $destination "$model.traineddata"
    $existing = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
    if ($existing -and $existing.Length -gt 10000000) {
        Write-Host "OCR model already present: $model"
        continue
    }
    $url = "https://github.com/tesseract-ocr/tessdata_best/raw/main/$model.traineddata"
    Write-Host "Downloading high-accuracy local OCR model: $model"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target
}

Write-Host 'Local WeChat OCR models are ready.'
