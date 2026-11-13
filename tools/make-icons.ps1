# 앱 아이콘(PNG)을 그려서 icons 폴더에 저장한다. 아이콘을 바꾸고 싶을 때만 다시 실행.
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

foreach ($size in 192, 512) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAlias'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#17181B'))

  # 가운데 "글" 한 글자 (청록). 폰이 아이콘 가장자리를 둥글게 잘라도 안 잘리게 가운데 60% 안에 둔다.
  $font = New-Object System.Drawing.Font('Malgun Gothic', ($size * 0.42), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#5EC4B6'))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, ($size * 0.02), $size, $size
  $g.DrawString([string][char]0xAE00, $font, $brush, $rect, $fmt)

  # 아래 밑줄 (원고지 느낌)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#5EC4B6')), ($size * 0.025)
  $y = $size * 0.76
  $g.DrawLine($pen, ($size * 0.32), $y, ($size * 0.68), $y)

  $g.Dispose()
  $bmp.Save((Join-Path $outDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
"아이콘 저장 완료: $outDir"
