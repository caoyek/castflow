# CastFlow 原生管理器编译脚本
# 使用 Windows 自带的 csc.exe 编译，零额外依赖

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

$Csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $Csc)) {
    $Csc = (Get-Command csc.exe -ErrorAction SilentlyContinue).Source
}
if (-not $Csc) {
    throw "未找到 C# 编译器 csc.exe"
}

$Output = Join-Path $Root "CastFlowManager.exe"
$Source = Join-Path $Root "Program.cs"

$Refs = @(
    "PresentationCore.dll",
    "PresentationFramework.dll",
    "WindowsBase.dll",
    "System.Xaml.dll",
    "System.dll",
    "System.Core.dll",
    "System.Net.Http.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll"
)

$RefArgs = $Refs | ForEach-Object { "/r:$_" }

$WpfDir = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF"
$NetDir = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"

$IconFile = Join-Path $Root "app.ico"
$IconArg = if (Test-Path $IconFile) { "/win32icon:$IconFile" } else { "" }

Write-Host "正在使用系统 C# 编译器构建 CastFlowManager.exe ..." -ForegroundColor Cyan

& $Csc /target:winexe /optimize+ $IconArg "/lib:$WpfDir,$NetDir" "/out:$Output" $RefArgs $Source

if ($LASTEXITCODE -eq 0 -and (Test-Path $Output)) {
    $sizeKb = [math]::Round((Get-Item $Output).Length / 1KB, 1)
    Write-Host "构建成功！产物：$Output ($sizeKb KB)" -ForegroundColor Green
} else {
    throw "构建失败，退出码: $LASTEXITCODE"
}
