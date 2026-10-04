param(
  [Parameter(Mandatory=$true)][string]$Img,
  [Parameter(Mandatory=$true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1
})[0]
function Await($WinRtTask, $ResultType) {
    $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Img)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("zh-Hans-CN"))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw "no OCR engine available" }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0; $maxY = 0
    foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        $minX = [Math]::Min($minX, $r.X); $minY = [Math]::Min($minY, $r.Y)
        $maxX = [Math]::Max($maxX, $r.X + $r.Width); $maxY = [Math]::Max($maxY, $r.Y + $r.Height)
    }
    $lines += [pscustomobject]@{
        text = $line.Text
        x = [Math]::Round($minX, 1); y = [Math]::Round($minY, 1)
        w = [Math]::Round($maxX - $minX, 1); h = [Math]::Round($maxY - $minY, 1)
    }
}
$obj = [pscustomobject]@{ width = $decoder.PixelWidth; height = $decoder.PixelHeight; lines = $lines }
[System.IO.File]::WriteAllText($Out, ($obj | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Output "OK $($lines.Count) lines -> $Out"
