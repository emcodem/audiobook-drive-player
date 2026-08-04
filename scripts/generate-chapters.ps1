<#
Generates a "<basename>.chapters.json" sidecar file for each .m4a/.m4b/.mp3
file in a folder, reading embedded chapter markers via ffprobe. Upload both
the audio file and its .chapters.json to the same Google Drive folder, then
pick them together in the app's "Add books from Drive" picker.

Usage:
  .\generate-chapters.ps1 -Path "C:\media\my_vampire_system"

Re-run any time you add new audiobook files to a folder; existing sidecars
are simply overwritten with the same content.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $ffprobe) {
  Write-Error "ffprobe not found on PATH. Install ffmpeg (which includes ffprobe) first."
  exit 1
}

$files = Get-ChildItem -Path $Path -File | Where-Object { $_.Extension -in '.m4a', '.m4b', '.mp3' }
if (-not $files) {
  Write-Warning "No .m4a/.m4b/.mp3 files found in $Path"
  exit 0
}

foreach ($file in $files) {
  Write-Host "Processing: $($file.Name)"

  $json = & ffprobe -v error -show_chapters -show_format -print_format json -- "$($file.FullName)" 2>$null
  if (-not $json) {
    Write-Warning "  ffprobe produced no output for $($file.Name), skipping."
    continue
  }

  $data = $json | ConvertFrom-Json

  $chapters = @()
  foreach ($ch in $data.chapters) {
    $chapters += [PSCustomObject]@{
      title = $ch.tags.title
      start = [double]$ch.start_time
      end   = [double]$ch.end_time
    }
  }

  $duration = $null
  if ($data.format -and $data.format.duration) {
    $duration = [double]$data.format.duration
  }

  $output = [PSCustomObject]@{
    duration = $duration
    chapters = $chapters
  }

  $outPath = Join-Path $file.DirectoryName ($file.BaseName + '.chapters.json')
  $output | ConvertTo-Json -Depth 5 | Set-Content -Path $outPath -Encoding utf8

  if ($chapters.Count -gt 0) {
    Write-Host "  -> $($chapters.Count) chapters written to $(Split-Path $outPath -Leaf)"
  } else {
    Write-Host "  -> No chapters found; wrote an empty chapter list (resume-by-position still works)."
  }
}
