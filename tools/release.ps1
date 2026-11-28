# One-command release: stamps every module URL with a fresh version (so browsers/phones never serve stale files),
# commits everything and pushes to GitHub Pages.
# Usage: powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Message "what changed"
param([Parameter(Mandatory)][string]$Message)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$ver = Get-Date -Format 'yyyyMMddHHmm'
$utf8 = New-Object System.Text.UTF8Encoding($false)      # always read/write UTF-8 (the default PowerShell encoding corrupts files)
foreach ($f in 'src\main.js', 'src\zee.js', 'src\assets.js', 'src\input.js', 'src\enemy.js', 'src\game.js', 'src\sfx.js', 'src\hud.js', 'src\level.js', 'src\camera.js') {
    $p = Join-Path $root $f
    $t = [IO.File]::ReadAllText($p, $utf8)
    $t = [regex]::Replace($t, "from '(\./(?:config|assets|input|zee|enemy|game|sfx|hud|level|camera))\.js(\?v=[0-9a-z]+)?'", "from '`$1.js?v=$ver'")
    [IO.File]::WriteAllText($p, $t, $utf8)
}
$p = Join-Path $root 'index.html'
$h = [IO.File]::ReadAllText($p, $utf8)
$h = [regex]::Replace($h, 'src="src/main\.js(\?v=[0-9a-z]+)?"', "src=`"src/main.js?v=$ver`"")
[IO.File]::WriteAllText($p, $h, $utf8)
git add -A
git commit -m "$Message`n`nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" | Out-Null
git push origin main
Write-Host "released version $ver"
