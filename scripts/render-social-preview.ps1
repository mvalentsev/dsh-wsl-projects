Add-Type -AssemblyName System.Drawing

$W = 1280; $H = 640
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Color($r, $gr, $b, $a = 255) { [System.Drawing.Color]::FromArgb($a, $r, $gr, $b) }
$bg      = Color 13 17 23        # 0d1117
$card    = Color 22 27 34        # 161b22
$border  = Color 48 54 61        # 30363d
$grid    = Color 48 54 61 90
$text    = Color 230 237 243     # e6edf3
$muted   = Color 139 148 158     # 8b949e
$dim     = Color 110 118 129     # 6e7681
$blue    = Color 88 166 255      # 58a6ff
$violet  = Color 210 168 255     # d2a8ff
$purple  = Color 163 113 247     # a371f7
$green   = Color 63 185 80       # 3fb950
$deepblue = Color 31 111 235     # 1f6feb

$g.Clear($bg)

# dot grid
for ($x = 20; $x -lt $W; $x += 26) {
  for ($y = 20; $y -lt $H; $y += 26) {
    $brush = New-Object System.Drawing.SolidBrush($grid)
    $g.FillEllipse($brush, $x, $y, 3, 3)
    $brush.Dispose()
  }
}

function Round-Rect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $r, $r, 180, 90)
  $p.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
  $p.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
  $p.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
  $p.CloseFigure()
  return $p
}

# ---- logo: three stacked services, each alive
$lx = 110.0; $ly = 240.0
$bars = @(
  @{ x = $lx + 40; w = 184.0; stroke = $blue },
  @{ x = $lx + 20; w = 205.0; stroke = $purple },
  @{ x = $lx;       w = 224.0; stroke = $deepblue }
)
for ($i = 0; $i -lt 3; $i++) {
  $b = $bars[$i]
  $y = $ly + $i * 72
  $path = Round-Rect $b.x $y $b.w 58 16
  $fill = New-Object System.Drawing.SolidBrush($card)
  $pen = New-Object System.Drawing.Pen($b.stroke, 3.4)
  $g.FillPath($fill, $path)
  $g.DrawPath($pen, $path)
  $fill.Dispose(); $pen.Dispose(); $path.Dispose()
  $dot = New-Object System.Drawing.SolidBrush($green)
  $g.FillEllipse($dot, ($b.x + $b.w - 34), ($y + 20), 18, 18)
  $dot.Dispose()
}
# terminal prompt on the bottom bar
$penP = New-Object System.Drawing.Pen($blue, 5.5)
$penP.StartCap = 'Round'; $penP.EndCap = 'Round'
$g.DrawLines($penP, [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point([int]($lx + 26), [int]($ly + 168))),
  (New-Object System.Drawing.Point([int]($lx + 42), [int]($ly + 180))),
  (New-Object System.Drawing.Point([int]($lx + 26), [int]($ly + 192)))
))
$g.DrawLine($penP, ($lx + 58), ($ly + 180), ($lx + 98), ($ly + 180))
$penP.Dispose()

# ---- wordmark with gradient
$family = New-Object System.Drawing.FontFamily('Segoe UI')
$fmt = [System.Drawing.StringFormat]::GenericDefault
$titlePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$titlePath.AddString('dsh-wsl-projects', $family, 1, 62, (New-Object System.Drawing.PointF(430.0, 218.0)), $fmt)
$titleRect = $titlePath.GetBounds()
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($titleRect, $blue, $violet, 0.0)
$g.FillPath($grad, $titlePath)
$grad.Dispose(); $titlePath.Dispose()

# ---- tagline
$fontTag = New-Object System.Drawing.Font($family, 25, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$brushTag = New-Object System.Drawing.SolidBrush($muted)
$g.DrawString('One DeepSeek Harness web server per project, inside WSL2.', $fontTag, $brushTag, 434.0, 316.0)
$fontTag.Dispose(); $brushTag.Dispose()

# ---- chips
function Draw-Chip([string]$label, [float]$x, [float]$y, $strokeColor) {
  $font = New-Object System.Drawing.Font($family, 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $size = $g.MeasureString($label, $font)
  $w = $size.Width + 44; $h = 50
  $path = Round-Rect $x $y $w $h 12
  $fill = New-Object System.Drawing.SolidBrush($card)
  $pen = New-Object System.Drawing.Pen($strokeColor, 2.2)
  $g.FillPath($fill, $path); $g.DrawPath($pen, $path)
  $brush = New-Object System.Drawing.SolidBrush($strokeColor)
  $g.DrawString($label, $font, $brush, ($x + 22), ($y + 12))
  $font.Dispose(); $fill.Dispose(); $pen.Dispose(); $brush.Dispose(); $path.Dispose()
  return ($x + $w + 18)
}
$cx = 434.0
$cx = Draw-Chip 'Windows app' $cx 396 $blue
$cx = Draw-Chip 'WSL2' $cx 396 $purple
$cx = Draw-Chip 'systemd' $cx 396 $green

# ---- footer
$fontFoot = New-Object System.Drawing.Font($family, 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$brushFoot = New-Object System.Drawing.SolidBrush($dim)
$g.DrawString('github.com/mvalentsev/dsh-wsl-projects', $fontFoot, $brushFoot, 434.0, 560.0)
$fontFoot.Dispose(); $brushFoot.Dispose()

$family.Dispose()
$g.Dispose()
$bmp.Save("$PSScriptRoot\..\docs\social-preview.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host 'saved docs/social-preview.png'
