<#
  CastFlow Packaging Script
  Usage: powershell -ExecutionPolicy Bypass -File build.ps1
  Output: dist\CastFlow\ (Complete portable runtime directory)
          dist\CastFlow.exe (Packaged executable)
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = $PSScriptRoot
Set-Location $Root

$Dist = Join-Path $Root 'dist'
$App = Join-Path $Dist 'CastFlow'
$Exe = Join-Path $Dist 'CastFlow.exe'
$Target = 'node22-win-x64'

Write-Host ''
Write-Host '  CastFlow Build & Package' -ForegroundColor Cyan
Write-Host '  ─────────────────────────────' -ForegroundColor DarkGray

# ---------- 1. Dependencies ----------
if (Test-Path 'node_modules\ws') {
  Write-Host '  [1/4] Dependencies already installed' -ForegroundColor DarkGray
} else {
  Write-Host '  [1/4] Installing dependencies...' -ForegroundColor DarkGray
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

# ---------- 2. Package exe ----------
Write-Host "  [2/4] Packaging $Target..." -ForegroundColor DarkGray
if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
New-Item -ItemType Directory -Force $Dist | Out-Null

# Use @yao-pkg/pkg to package Node 22
npx --yes @yao-pkg/pkg . --targets $Target --output $Exe
if (-not (Test-Path $Exe)) { throw 'Packaging failed: CastFlow.exe was not created' }
$exeMb = [math]::Round((Get-Item $Exe).Length / 1MB, 1)

# ---------- 3. Assemble runtime directory ----------
Write-Host '  [3/4] Assembling runtime files...' -ForegroundColor DarkGray
New-Item -ItemType Directory -Force $App | Out-Null
Copy-Item $Exe $App
Copy-Item 'topmost.ps1' $App
if (Test-Path 'CastFlowManager.exe') { Copy-Item 'CastFlowManager.exe' $App }
if (Test-Path 'app.ico') { Copy-Item 'app.ico' $App }
Copy-Item 'public' $App -Recurse
New-Item -ItemType Directory -Force (Join-Path $App 'media') | Out-Null

# ---------- 4. Summary ----------
$totalMb = [math]::Round((Get-ChildItem $App -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)

Write-Host '  [4/4] Package completed successfully' -ForegroundColor Green
Write-Host ''
Write-Host "  CastFlow.exe   $exeMb MB"
Write-Host "  Directory      $totalMb MB"
Write-Host "  Output path    $App"
Write-Host ''
Get-ChildItem $App | ForEach-Object {
  $kind = if ($_.PSIsContainer) { 'DIR ' } else { 'FILE' }
  Write-Host ("    {0,-16} {1}" -f $_.Name, $kind) -ForegroundColor DarkGray
}
Write-Host ''
