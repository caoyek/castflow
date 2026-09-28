<#
  CastFlow 打包脚本

  用法：  powershell -ExecutionPolicy Bypass -File build.ps1

  产物：  dist\CastFlow\        可直接运行的目录（拷到目标机器即可用）
          dist\CastFlow.exe    单独的可执行文件

  为什么产物是一个目录而不是单文件：
    public\ 里的前端要用 fs.createReadStream 带 Range 偏移读（视频拖进度条依赖它），
    走 pkg 的只读快照不稳妥；topmost.ps1 也要能被外部进程执行。
    所以 exe 内置 Node 运行时和全部 .js，静态资源与脚本外置。
#>

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

$Dist = Join-Path $Root 'dist'
$App = Join-Path $Dist 'CastFlow'
$Exe = Join-Path $Dist 'CastFlow.exe'
$Target = 'node22-win-x64'

Write-Host ''
Write-Host '  CastFlow 打包' -ForegroundColor Cyan
Write-Host '  ─────────────────────────────' -ForegroundColor DarkGray

# ---------- 1. 依赖 ----------
if (Test-Path 'node_modules\ws') {
  Write-Host '  [1/4] 依赖已就绪' -ForegroundColor DarkGray
} else {
  Write-Host '  [1/4] 安装依赖…' -ForegroundColor DarkGray
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
}

# ---------- 2. 打包 exe ----------
Write-Host "  [2/4] 打包 $Target …" -ForegroundColor DarkGray
if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
New-Item -ItemType Directory -Force $Dist | Out-Null

# 用 @yao-pkg/pkg 而不是 vercel/pkg —— 后者仓库已归档，只支持到 Node 18
npx --yes @yao-pkg/pkg . --targets $Target --output $Exe
if (-not (Test-Path $Exe)) { throw '打包失败：没有生成 CastFlow.exe' }
$exeMb = [math]::Round((Get-Item $Exe).Length / 1MB, 1)

# ---------- 3. 拼运行时目录 ----------
Write-Host '  [3/4] 拼装运行时文件…' -ForegroundColor DarkGray
New-Item -ItemType Directory -Force $App | Out-Null
Copy-Item $Exe $App
Copy-Item 'topmost.ps1' $App
if (Test-Path 'CastFlowManager.exe') { Copy-Item 'CastFlowManager.exe' $App }
if (Test-Path 'app.ico') { Copy-Item 'app.ico' $App }
Copy-Item 'public' $App -Recurse
New-Item -ItemType Directory -Force (Join-Path $App 'media') | Out-Null

# ---------- 4. 汇总 ----------
$totalMb = [math]::Round((Get-ChildItem $App -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)

Write-Host '  [4/4] 完成' -ForegroundColor Green
Write-Host ''
Write-Host "  CastFlow.exe   $exeMb MB"
Write-Host "  整个目录       $totalMb MB"
Write-Host "  产物位置       $App"
Write-Host ''
Get-ChildItem $App | ForEach-Object {
  $kind = if ($_.PSIsContainer) { '目录' } else { '文件' }
  Write-Host ("    {0,-16} {1}" -f $_.Name, $kind) -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  下一步：把 dist\CastFlow 拷到目标机器，跑 CastFlow.exe --autostart' -ForegroundColor DarkGray
Write-Host ''
