# 从 CHANGELOG.md 中提取指定版本的章节，作为 GitHub Release 的标题与说明
# 用法：extract-release-notes.ps1 -Tag v1.0.4 [-ChangelogPath CHANGELOG.md] [-OutFile release-notes.md]
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$ChangelogPath = 'CHANGELOG.md',
  [string]$OutFile = 'release-notes.md'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $ChangelogPath)) {
  throw "未找到 $ChangelogPath"
}

$lines = [System.IO.File]::ReadAllLines((Resolve-Path $ChangelogPath).Path, [System.Text.Encoding]::UTF8)

# 匹配 "## v1.0.4" 开头、后接空白 / 冒号 / 行尾的标题行，避免 v1.0.4 误匹配 v1.0.40
$pattern = '^##\s+' + [regex]::Escape($Tag) + '(?=\s|：|:|$)'
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match $pattern) { $start = $i; break }
}
if ($start -lt 0) {
  throw "CHANGELOG.md 中未找到 $Tag 的章节，请先在 CHANGELOG.md 顶部补写 '## $Tag：版本标题' 后再发版"
}

# 章节结束于下一个二级标题（### 等更低级标题不算）
$end = $lines.Count
for ($i = $start + 1; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^##\s') { $end = $i; break }
}
if ($end - $start -le 1) {
  throw "CHANGELOG.md 中 $Tag 章节内容为空"
}

$title = ($lines[$start] -replace '^##\s+', '').Trim()
$body = ($lines[($start + 1)..($end - 1)] -join "`n").Trim()
if (-not $body) {
  throw "CHANGELOG.md 中 $Tag 章节内容为空"
}

[System.IO.File]::WriteAllText($OutFile, $body + "`n", $utf8NoBom)

# 在 GitHub Actions 中输出标题供后续步骤使用
if ($env:GITHUB_OUTPUT) {
  [System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, "title=$title`n", $utf8NoBom)
}

Write-Host "已提取 $Tag 更新说明：$title"
