# Scans the publicPlotLibrary folder and writes publicPlotLibrary\index.json so every plot file is listed.
$candidates = @(
  (Join-Path $PSScriptRoot 'publicPlotLibrary'),
  (Join-Path (Split-Path $PSScriptRoot -Parent) 'publicPlotLibrary'),
  (Join-Path (Get-Location).Path 'publicPlotLibrary')
)
$dir = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $dir) { Write-Host 'Could not find a publicPlotLibrary folder.'; exit 1 }
$out = Join-Path $dir 'index.json'

# keep any extra info already in index.json
$old = @{}
if (Test-Path -LiteralPath $out) {
  try {
    $json = Get-Content -LiteralPath $out -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($s in $json.publicPlotLibrary) { $old[$s.file] = $s }
  } catch { }
}

$files = Get-ChildItem -LiteralPath $dir -File |
  Where-Object { $_.Extension -match '^\.(hpgl|plt|hpg)$' } |
  Sort-Object { [regex]::Replace($_.Name, '\d+', { param($m) $m.Value.PadLeft(20, '0') }) }

$list = @()
foreach ($f in $files) {
  $entry = [ordered]@{ file = 'publicPlotLibrary/' + $f.Name }
  $prev = $old[$entry.file]
  if ($prev) {
    foreach ($p in $prev.PSObject.Properties) {
      if ($p.Name -ne 'file' -and $p.Name -ne 'size') { $entry[$p.Name] = $p.Value }
    }
  }
  $entry['size'] = $f.Length
  $list += , $entry
}

$text = (@{ publicPlotLibrary = $list } | ConvertTo-Json -Depth 5)
[System.IO.File]::WriteAllText($out, $text + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('Wrote ' + $list.Count + ' plot(s) to ' + $out)