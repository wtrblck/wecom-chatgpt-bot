$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64,64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(34,118,90))
$white = [System.Drawing.Brushes]::White
$graphics.FillEllipse($white, 11, 12, 42, 33)
$points = [System.Drawing.Point[]]@([System.Drawing.Point]::new(18,37),[System.Drawing.Point]::new(16,52),[System.Drawing.Point]::new(32,40))
$graphics.FillPolygon($white, $points)
$green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34,118,90))
$graphics.FillEllipse($green,21,25,5,5)
$graphics.FillEllipse($green,32,25,5,5)
$graphics.FillEllipse($green,43,25,5,5)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$file = [System.IO.File]::Create((Join-Path $PSScriptRoot '../native/WeChatDesktop/app.ico'))
$icon.Save($file)
$file.Dispose()
$icon.Dispose()
$green.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
