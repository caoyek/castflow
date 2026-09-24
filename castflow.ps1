<#
  CastFlow 本机菜单（控制台交互）

  为什么用 .ps1 而不是 .bat：
    cmd 读批处理是按文件自身编码来的。存成 UTF-8 的话中文会被当 GBK 解析，
    乱码字节里可能混进引号 / & / | 等元字符，直接把批处理语法拆散
    （表现为 "'epad.exe' 不是内部或外部命令" 这种半个命令的怪错）。
    PowerShell 脚本存 UTF-8 + BOM 就不存在这个问题。
    （原来那几个 .bat 入口已经删掉，菜单只留这一份。）

  ⚠ 本文件必须存成「UTF-8 带 BOM」：
    Windows PowerShell 5.1（系统自带那个）遇到没有 BOM 的 .ps1 会按系统
    ANSI(GBK) 解码，中文提示全变乱码，重音字节还可能被拆成元字符导致解析失败。
    改完这个文件请确认开头仍然是 EF BB BF 三个字节。

  交互约定（所有动作都在同一屏里完成）：
    0. 打开菜单就自动把服务拉起来（已在跑就跳过），不用先按 [1]；
    1. 选中动作后先把界面重画成「启动中… / 停止中…」，让人知道已经动手了；
    2. 动作跑完回到循环头再重画一次，状态、地址、内存随之刷新，不保留动作输出；
    3. 不往屏幕上刷日志、也不需要「按回车继续」—— 细节都按 [5] 去看日志；
    4. 每个动作都会往同目录的 castflow.log 追一条记录：屏幕上的提示下一帧就
       没了，翻旧账、对时间都靠这个文件。
    所以动作里不要用 Write-Host 往屏幕上堆东西，结果一行走 Set-Result。

  用法：  powershell -NoProfile -ExecutionPolicy Bypass -File castflow.ps1
          powershell -NoProfile -ExecutionPolicy Bypass -File castflow.ps1 -Port 8090
#>

param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
try { [Console]::Title = 'CastFlow 大屏投放控制台' } catch { }

# ---------------- 配置与路径 ----------------

$Cfg = $null
try { $Cfg = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
if ($Port -le 0) { $Port = if ($Cfg -and $Cfg.port) { [int]$Cfg.port } else { 8080 } }
$Api = "http://127.0.0.1:$Port"

$Exe = Join-Path $Root 'CastFlow.exe'
$Packaged = Test-Path $Exe
$MainJs = Join-Path $Root 'main.js'
$AutoLog = Join-Path $Root 'autostart.log'
$OutLog = Join-Path $Root 'server.out.log'
$ErrLog = Join-Path $Root 'server.err.log'

# 下一帧要显示的一行提示：动作结果、失败原因。用完即清，不占屏。
$script:hint = $null

# ---------------- 日志 ----------------

$MenuLog = Join-Path $Root 'castflow.log'

# 用 File.AppendAllText 而不是 Add-Content -Encoding UTF8：
# 后者在 PS 5.1 上每次追加都会再写一遍 BOM，文件越写越脏；
# 这个只在文件第一次创建时写 BOM，之后纯追加。
# 记事本能自己认出带 BOM 的 UTF-8，中文不会乱。
$Utf8Bom = New-Object System.Text.UTF8Encoding($true)

# 菜单自己干了什么、结果如何，都追加到这里。Write-Host 只画在屏幕上，
# 下一帧重画就没了 —— 要回头查只能靠这个文件。写不进去（只读目录）也不能挡住用。
function Write-Log([string]$Text) {
  try {
    $line = '[' + (Get-Date -Format 'yyyy/MM/dd HH:mm:ss') + '] ' + $Text + "`r`n"
    [System.IO.File]::AppendAllText($MenuLog, $line, $Utf8Bom)
  } catch { }
}

# 动作收尾的统一出口：屏幕上留一行提示，同时进日志
function Set-Result([string]$Action, [string]$Text) {
  $script:hint = $Text
  Write-Log "$Action → $Text"
}

# ---------------- 环境探测 ----------------

function Find-Node {
  # 打包版自带 Node，源码模式才需要去找系统里的
  if ($Packaged) { return $Exe }
  $cands = @(Join-Path $Root 'node\node.exe')
  if ($env:ProgramFiles) { $cands += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  foreach ($p in $cands) { if (Test-Path $p) { return $p } }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

# 注册表是 Windows 标准的应用查找位置，比猜目录可靠
function Find-Chrome {
  foreach ($k in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
    try { $p = (Get-ItemProperty $k -ErrorAction Stop).'(default)'; if ($p -and (Test-Path $p)) { return $p } } catch { }
  }
  $cands = @()
  if ($env:ProgramFiles) { $cands += Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe' }
  if (${env:ProgramFiles(x86)}) { $cands += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }
  if ($env:LOCALAPPDATA) { $cands += Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' }
  foreach ($p in $cands) { if (Test-Path $p) { return $p } }
  return $null
}

function Get-FileVer([string]$p) {
  if (-not $p -or -not (Test-Path $p)) { return $null }
  try { return (Get-Item $p).VersionInfo.ProductVersion } catch { return $null }
}

function Find-ChromeVer {
  foreach ($k in @('HKLM:\SOFTWARE\Google\Chrome\BLBeacon', 'HKCU:\SOFTWARE\Google\Chrome\BLBeacon')) {
    try { $v = (Get-ItemProperty $k -ErrorAction Stop).version; if ($v) { return $v } } catch { }
  }
  return '—'
}

$NodePath = Find-Node
$ChromePath = Find-Chrome
$NodeVer = Get-FileVer $NodePath
$ChromeVer = Find-ChromeVer

# ---------------- 状态 ----------------

# 端口占用情况。Get-NetTCPConnection 在老系统 / 精简系统上可能没有（NetTCPIP 模块
# 被裁掉了），所以退回 netstat —— 两个来源都拿不到就当没占用。
function Get-ListenInfo([int]$p) {
  $r = @{ listening = $false; pid = $null }
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { $r.listening = $true; $r.pid = [int]$c[0].OwningProcess }
    return $r
  } catch { }
  try {
    foreach ($line in (& netstat -ano 2>$null)) {
      if ($line -match "^\s*TCP\s+\S+:$p\s+\S+\s+LISTENING\s+(\d+)") {
        $r.listening = $true
        $r.pid = [int]$Matches[1]
        break
      }
    }
  } catch { }
  return $r
}

function Get-State {
  $r = @{
    alive = $false; online = $false
    pages = $null; heapMb = $null; chromeMb = $null; limit = $null; reloads = $null
    sysUsedMb = $null; sysTotalMb = $null
    pid = $null; base = $null; nodeVer = $null; portPid = $null
  }
  # 先看端口：服务挂了 / 卡死时，API 不会应答，但端口占用还能告诉我们有残留进程
  $r.portPid = (Get-ListenInfo $Port).pid

  try {
    $st = Invoke-RestMethod "$Api/api/status" -TimeoutSec 3
    $r.alive = $true
    $r.online = [bool]$st.online
    $r.pages = [int]$st.pageCount
    $r.heapMb = $st.heapMb
    $r.chromeMb = $st.chromeMb
    $r.limit = $st.memoryLimitMb
    $r.reloads = [int]$st.reloadCount
    $r.sysUsedMb = $st.sysUsedMb
    $r.sysTotalMb = $st.sysTotalMb

    try {
      $loc = Invoke-RestMethod "$Api/api/local" -TimeoutSec 3
      $r.pid = $loc.pid
      $r.base = $loc.base
      $r.nodeVer = $loc.node
    } catch { }

    # 不再问 /api/topmost：那个接口要在服务端起一次 PowerShell 去取窗口句柄，
    # 菜单每重画一帧就多一次进程开销；置顶已经从菜单里拿掉，读数也没人用。
  } catch { }
  return $r
}

function Test-AutoStart {
  # 极简系统上可能连 ScheduledTasks 模块都没有，不能让它把菜单打崩
  try { return $null -ne (Get-ScheduledTask -TaskName 'CastFlow' -ErrorAction SilentlyContinue) }
  catch { return $false }
}

# ---------------- 动作 ----------------

function Invoke-CastStart {
  if (-not $NodePath) { throw '找不到 node.exe，请确认 Node.js 已安装' }
  # autostart 会拉起 Chrome + 控制服务，然后自己退出，所以同步跑完就知道结果了。
  # 这里刻意不回显 node 的输出（它自己会写 autostart.log）：
  #   1) 界面要求原地刷新，日志刷屏会顶掉界面；
  #   2) PS 5.1 是按控制台代码页(GBK)解码原生命令 stdout 的，node 写的是 UTF-8，
  #      一旦回显就是「澶у睆鑷惎寮€濮」这种乱码，非回显不可时得先把控制台编码切成 UTF-8。
  # 必须先切到程序目录：Node 子进程的工作目录继承父进程，脚本路径另用绝对路径兜底。
  # 期间把 Stop 降级成 Continue —— 原生命令往 stderr 写一行就会触发 NativeCommandError。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $Root
  try {
    if ($Packaged) { & $Exe '--autostart' 2>&1 | Out-Null }
    else { & $NodePath $MainJs '--autostart' 2>&1 | Out-Null }
  } finally {
    Pop-Location
    $ErrorActionPreference = $prev
  }

  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    if ((Get-ListenInfo $Port).listening) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (Get-ListenInfo $Port).listening
}

# 「收掉占用端口的进程」这件事，本地和提权进程都要干，所以写成一段脚本文本共用。
# 用 taskkill /F /T 而不是 Stop-Process：子进程可能继承了监听句柄，只杀父进程端口
# 不会释放；而且每轮都把结果写出来，出问题能看清是谁、为什么没收掉。
# 注意脚本里不能用 $pid —— 那是 PowerShell 的自动变量（当前进程号），只读。
function Get-KillScript([int]$TargetPort) {
  return @"
`$ErrorActionPreference = 'Continue'
for (`$i = 1; `$i -le 3; `$i++) {
  `$c = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
  if (-not `$c) { Write-Output '端口已空闲'; return }
  `$target = `$c[0].OwningProcess
  `$name = (Get-Process -Id `$target -ErrorAction SilentlyContinue).ProcessName
  `$out = (& taskkill /F /T /PID `$target 2>&1 | Out-String).Trim()
  Start-Sleep -Milliseconds 700
  `$still = [bool](Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)
  Write-Output (('第 ' + `$i + ' 轮 kill PID ' + `$target + ' (' + `$name + ') → 仍在监听=' + `$still + '  | ' + `$out) -replace '\s+', ' ')
  if (-not `$still) { return }
}
"@
}

function Invoke-CastStop {
  # 1) 先让服务自己通过 CDP 关掉它拉起的 Chrome —— 不能 taskkill /IM chrome.exe，
  #    那会把用户自己开着的浏览器一起杀掉
  try { Invoke-RestMethod "$Api/api/chrome/stop" -Method Post -TimeoutSec 25 | Out-Null } catch { }

  # 2) 收掉占用端口的进程，每一轮的结果都进日志
  $code = Get-KillScript $Port
  $lines = @()
  try { $lines = @(& ([scriptblock]::Create($code))) } catch { $lines = @('本地执行异常：' + $_.Exception.Message) }
  foreach ($l in $lines) { Write-Log ('停止服务 → ' + [string]$l) }

  if (-not (Get-ListenInfo $Port).listening) { return $true }
  if (Test-Admin) { return $false }

  # 3) 还占着、而当前又不是管理员：多半是服务被提权进程拉起来的（比如管理员身份开的
  #    菜单、或测试时提权跑过），普通权限杀不动。和 [4] 一样弹一次 UAC，在提权进程里
  #    做同一件事 —— 脚本走 base64，不涉及引号转义。
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  try {
    $p = Start-Process -FilePath $ps -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64)
    Write-Log ('停止服务 → 已改用管理员权限收进程，提权进程退出码 ' + $p.ExitCode)
  } catch {
    Write-Log ('停止服务 → 提权失败：' + $_.Exception.Message)
  }

  return (-not (Get-ListenInfo $Port).listening)
}

# 只重启控制服务，不动大屏浏览器 —— 重启浏览器要十几秒，大屏会黑一下，
# 而改完配置、服务卡死这类场景根本不需要重开浏览器。
function Invoke-CastRestartService {
  $p = (Get-ListenInfo $Port).pid
  if ($p) {
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Get-ListenInfo $Port).listening) { Start-Sleep -Milliseconds 300 }
  }
  if ((Get-ListenInfo $Port).listening) { return $false }   # 端口没释放，硬起也是 EADDRINUSE

  # 直接起服务（不带 --autostart）：autostart 会顺手把大屏导航回 startUrl，
  # 正在投放的看板会被切走。代价是这两个日志每次重启会被重写，历史仍在 autostart.log。
  if ($Packaged) {
    Start-Process -FilePath $Exe -WorkingDirectory $Root -WindowStyle Hidden `
      -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  } else {
    if (-not $NodePath) { throw '找不到 node.exe，请确认 Node.js 已安装' }
    Start-Process -FilePath $NodePath -ArgumentList $MainJs -WorkingDirectory $Root -WindowStyle Hidden `
      -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  }

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if ((Get-ListenInfo $Port).listening) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# 注册 / 注销计划任务都要管理员权限。当前进程不是管理员就弹一次 UAC，
# 把同一段活交给提权进程去做 —— 脚本用 -EncodedCommand(base64) 递过去，
# 这样不必为了几层引号再搏斗一遍。
function Test-Admin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# 生成「注册 / 注销 CastFlow 计划任务」的完整脚本文本。
# 里面的变量在这一步就展开成字面量，提权进程拿到即可直接执行。
function Get-AutoStartScript([bool]$on) {
  if (-not $on) {
    return @"
`$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'CastFlow' -Confirm:`$false
"@
  }

  # 开机启动跑的是 --autostart（拉起 Chrome + 控制服务），但它是个控制台程序：
  # 登录时弹出的黑窗口正好糊在大屏中间，还会把大屏的焦点抢走。
  # 所以用 cmd 的 start /min 包一层 —— 窗口最小化到任务栏且不激活
  # （SW_SHOWMINNOACTIVE），大屏不受影响；想看着启动过程就点任务栏那个窗口。
  # start 的标题参数不能省：第一个带引号的参数会被它当成窗口标题。
  # 开机自启跑的是本机菜单脚本，而不是直接跑 --autostart：
  # 菜单一打开就自动起服务，于是登录后任务栏会留着一个最小化的菜单窗口 ——
  # 出问题可以点开看状态、翻日志，也不用再依赖 autostart 那一闪而过的黑窗口。
  # 必须带 -ExecutionPolicy Bypass：默认执行策略可能禁止跑脚本。
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $menuPs1 = Join-Path $Root 'castflow.ps1'
  $inner = '"' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $menuPs1 + '"'

  return @"
`$ErrorActionPreference = 'Stop'
# -AtLogOn 默认就是「当前用户 + 交互式」，和打包文档的要求一致：
# 不能用 SYSTEM，它在会话 0，拉起的 Chrome 在屏幕上根本看不见
`$a = New-ScheduledTaskAction -Execute '$env:ComSpec' -Argument '/c start "" /min $inner' -WorkingDirectory '$Root'
`$t = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'CastFlow' -Action `$a -Trigger `$t -Force | Out-Null
"@
}

function Set-AutoStart([bool]$on) {
  $code = Get-AutoStartScript $on

  if (Test-Admin) {
    Invoke-Expression $code
    # 回读一次：注册被静默拒绝的情况在这里暴露，比菜单显示错了强
    return (Test-AutoStart)
  }

  # 非管理员：弹一次 UAC（点「是」，或输入管理员账号密码），在提权进程里做同一件事
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  $p = Start-Process -FilePath $ps -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64)
  if ($p.ExitCode -ne 0) { throw "提权进程以退出码 $($p.ExitCode) 结束" }
  # 提权之后普通用户未必读得到任务，就不回读了，以提权进程的退出码为准
  return $true
}

# ---------------- 定时关机 ----------------

# 定时关机交给一个独立的计划任务，和开机自启的 CastFlow 分开 ——
# 取消关机不会碰到开机自启，卸载时也各自清理。
$ShutdownTask = 'CastFlowShutdown'
$ShutdownExe = Join-Path $env:SystemRoot 'System32\shutdown.exe'

# 读当前设置：'HH:mm' = 已设置；'' = 没设置（或读不到，非管理员时可能读不到）
function Get-ShutdownTime {
  try {
    $t = Get-ScheduledTask -TaskName $ShutdownTask -ErrorAction Stop
    $b = @($t.Triggers)[0].StartBoundary          # 形如 2026-09-24T20:30:00
    if ($b) { return ([datetime]$b).ToString('HH:mm') }
  } catch { }
  return ''
}

# 生成注册 / 取消定时关机的脚本文本。和开机自启同一套路：
# 管理员就在本进程跑，否则 base64 送进提权进程跑。
function Get-ShutdownScript([string]$At) {
  if (-not $At) {
    return @"
`$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName '$ShutdownTask' -Confirm:`$false
"@
  }

  return @"
`$ErrorActionPreference = 'Stop'
# /t 60：到点先弹 60 秒倒计时，机器边上的人还来得及存东西
`$a = New-ScheduledTaskAction -Execute '$ShutdownExe' -Argument '/s /t 60 /c "CastFlow 定时关机"'
`$t = New-ScheduledTaskTrigger -Daily -At '$At'
Register-ScheduledTask -TaskName '$ShutdownTask' -Action `$a -Trigger `$t -Force | Out-Null
"@
}

# 设置成 $At（'HH:mm'）；传空字符串 = 取消定时关机
function Set-ShutdownTime([string]$At) {
  $code = Get-ShutdownScript $At

  if (Test-Admin) {
    Invoke-Expression $code
    return (Get-ShutdownTime)
  }

  # 非管理员：弹一次 UAC，在提权进程里做同一件事
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  $p = Start-Process -FilePath $ps -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64)
  if ($p.ExitCode -ne 0) { throw "提权进程以退出码 $($p.ExitCode) 结束" }
  return $At
}

# ---------------- 渲染 ----------------

# $Busy 非空时把「服务」那一行画成进行中，先让界面反映出动作已经开始了
function Show-Header($s, $Busy, $Hint) {
  Clear-Host
  Write-Host ''
  Write-Host '   CastFlow · 大屏投放控制台' -ForegroundColor Cyan
  Write-Host '   ══════════════════════════════════════════════════' -ForegroundColor DarkGray
  Write-Host ''

  # ---- 服务 ----
  Write-Host '   服务        ' -NoNewline
  if ($Busy) {
    Write-Host "[$Busy]" -ForegroundColor Yellow -NoNewline
    Write-Host "   端口 $Port"
  } elseif ($s.alive) {
    Write-Host '[运行中]' -ForegroundColor Green -NoNewline
    $pidText = if ($s.pid) { "PID $($s.pid)" } else { '' }
    Write-Host "   $pidText   端口 $Port"
  } elseif ($s.portPid) {
    # 端口被占但 API 不应答：多半是卡死或残留进程，[2] 能收掉
    Write-Host '[无响应]' -ForegroundColor Yellow -NoNewline
    Write-Host "   PID $($s.portPid) 占着端口 $Port"
  } else {
    Write-Host '[未运行]' -ForegroundColor Red
  }

  # ---- 浏览器 ----
  Write-Host '   浏览器      ' -NoNewline
  if (-not $s.alive) {
    Write-Host '[未知]' -ForegroundColor DarkGray
  } elseif ($s.online) {
    Write-Host '[已连接]' -ForegroundColor Green -NoNewline
    Write-Host "   $($s.pages) 个标签页"
  } else {
    Write-Host '[未连接]' -ForegroundColor Yellow
  }

  # ---- 访问地址 ----
  Write-Host ''
  Write-Host '   访问地址    ' -NoNewline
  if ($s.base) { Write-Host $s.base -ForegroundColor Cyan }
  elseif ($Busy) { Write-Host '—' -ForegroundColor DarkGray }
  else { Write-Host '—（服务未运行）' -ForegroundColor DarkGray }

  # ---- 环境 ----
  Write-Host ''
  Write-Host '   ──────────────────────────────────────────────────' -ForegroundColor DarkGray
  Write-Host '   运行方式    ' -NoNewline
  Write-Host $(if ($Packaged) { '内置运行时（单文件 exe）' } else { '源码模式（需系统装有 Node）' })
  Write-Host "   Node        $(if ($s.nodeVer) { $s.nodeVer } elseif ($NodeVer) { $NodeVer } else { '—' })"
  if ($NodePath -and -not $Packaged) { Write-Host "               $NodePath" -ForegroundColor DarkGray }
  Write-Host "   Chrome      $ChromeVer"
  if ($ChromePath) { Write-Host "               $ChromePath" -ForegroundColor DarkGray }
  Write-Host "   程序目录    $Root"

  # ---- 内存 ----
  if ($s.alive) {
    $memPage = if ($null -ne $s.heapMb) { "$($s.heapMb) MB" } else { '—' }
    $memChrome = if ($null -ne $s.chromeMb) { "$($s.chromeMb) MB" } else { '—' }
    $memLimit = if ($null -ne $s.limit) { " / 阈值 $($s.limit) MB" } else { '' }
    Write-Host "   内存        页面 $memPage$memLimit · Chrome $memChrome"
    if ($null -ne $s.sysUsedMb -and $null -ne $s.sysTotalMb) {
      Write-Host "   系统内存    $([math]::Round($s.sysUsedMb / 1024, 1)) / $([math]::Round($s.sysTotalMb / 1024, 1)) GB"
    }
    if ($null -ne $s.reloads) { Write-Host "   看门狗      已重载 $($s.reloads) 次" }
  }
  Write-Host '   ──────────────────────────────────────────────────' -ForegroundColor DarkGray
  Write-Host ''

  # ---- 菜单 ----
  Write-Host '   [1] 启动服务          [2] 停止服务'
  Write-Host '   [3] 重启服务          [4] 开机自启：' -NoNewline
  $auto = if (Test-AutoStart) { '开' } else { '关' }
  Write-Host $auto -ForegroundColor $(if ($auto -eq '开') { 'Green' } else { 'DarkGray' })
  Write-Host '   [5] 查看日志          [6] 定时关机：' -NoNewline
  $off = Get-ShutdownTime
  Write-Host $(if ($off) { "每天 $off" } else { '关' }) -ForegroundColor $(if ($off) { 'Green' } else { 'DarkGray' })
  Write-Host '   [0] 退出'

  if ($Hint) {
    Write-Host ''
    Write-Host "   $Hint" -ForegroundColor Yellow
  }
  Write-Host ''
}

function Show-LogMenu {
  $items = @(
    @{ Key = '1'; Name = '操作日志'; File = $MenuLog },
    @{ Key = '2'; Name = '自启日志'; File = $AutoLog },
    @{ Key = '3'; Name = '服务输出'; File = $OutLog },
    @{ Key = '4'; Name = '服务错误'; File = $ErrLog }
  )
  $hint = $null
  while ($true) {
    Clear-Host
    Write-Host ''
    Write-Host '   CastFlow · 日志' -ForegroundColor Cyan
    Write-Host '   ══════════════════════════════════════════════════' -ForegroundColor DarkGray
    Write-Host ''
    foreach ($it in $items) {
      $size = if (Test-Path $it.File) { "$([math]::Round((Get-Item $it.File).Length / 1KB, 1)) KB" } else { '不存在' }
      Write-Host ("   [{0}] {1,-8} " -f $it.Key, $it.Name) -NoNewline
      Write-Host $it.File -NoNewline -ForegroundColor DarkGray
      Write-Host "   $size" -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '   [5] 打开程序目录      [0] 返回菜单'
    if ($hint) {
      Write-Host ''
      Write-Host "   $hint" -ForegroundColor Yellow
    }
    Write-Host ''
    $hint = $null

    $c = (Read-Host '   请选择').Trim()
    if ($c -eq '0') { return }
    elseif ($c -eq '5') { Start-Process explorer.exe $Root }
    else {
      $hit = $items | Where-Object { $_.Key -eq $c } | Select-Object -First 1
      if (-not $hit) { $hint = "没有这个选项：$c" }
      elseif (-not (Test-Path $hit.File)) { $hint = "还没有 $($hit.Name) 文件。" }
      # 日志是 node 写的 UTF-8，记事本能自己认出来，不用管编码
      else { Start-Process notepad.exe $hit.File }
    }
  }
}

# ---------------- 主循环 ----------------

Write-Log "打开本机菜单（端口 $Port，$(if ($Packaged) { '打包版' } else { '源码模式' })）"

# 打开菜单就等于要用它：服务没跑就先拉起来，不用用户再按一次 [1]。
# 走的是和 [1] 完全相同的那段逻辑（--autostart 本身幂等：端口已开就跳过）。
$s0 = Get-State
if ($s0.alive) {
  Write-Log '自动启动服务 → 跳过（已经在运行）'
} elseif ($s0.portPid) {
  # 端口被占但 API 不应答：多半是卡死或残留进程，别硬起（会 EADDRINUSE）
  $script:hint = "端口 $Port 被 PID $($s0.portPid) 占着但服务没应答，按 [2] 停掉它即可恢复"
  Write-Log "自动启动服务 → 跳过（端口 $Port 被 PID $($s0.portPid) 占用且无应答）"
} else {
  Show-Header $s0 '服务启动中…' $null
  try {
    if (Invoke-CastStart) {
      Write-Log "自动启动服务 → 成功（PID $((Get-ListenInfo $Port).pid)）"
    } else {
      $script:hint = '自动启动超时，按 [5] 看自启日志'
      Write-Log '自动启动服务 → 超时'
    }
  } catch {
    $script:hint = "自动启动失败：$($_.Exception.Message)"
    Write-Log "自动启动服务 → 失败：$($_.Exception.Message)"
  }
}

while ($true) {
  $s = Get-State
  Show-Header $s $null $script:hint
  $script:hint = $null

  $c = (Read-Host '   请选择').Trim()
  switch ($c) {
    '1' {
      if ($s.alive) {
        Set-Result '启动服务' '服务已经在运行了'
      } elseif ($s.portPid) {
        Set-Result '启动服务' "端口 $Port 被 PID $($s.portPid) 占着但服务没应答，先按 [2] 停掉它"
      } else {
        Show-Header $s '服务启动中…' $null
        try {
          if (Invoke-CastStart) { Set-Result '启动服务' "成功（PID $((Get-ListenInfo $Port).pid)）" }
          else { Set-Result '启动服务' '启动超时，按 [5] 看自启日志' }
        } catch { Set-Result '启动服务' "失败：$($_.Exception.Message)" }
      }
    }
    '2' {
      if (-not $s.alive -and -not $s.portPid) {
        Set-Result '停止服务' '服务本来就没在运行'
      } else {
        Show-Header $s '服务停止中…' $null
        try {
          if (Invoke-CastStop) { Set-Result '停止服务' '已停止（大屏浏览器也一起关了）' }
          else { Set-Result '停止服务' '没停掉，按 [5] 看操作日志（里面写了是谁占着、为什么没收掉）' }
        } catch { Set-Result '停止服务' "失败：$($_.Exception.Message)" }
      }
    }
    '3' {
      if (-not $s.alive -and -not $s.portPid) {
        Set-Result '重启服务' '服务没在运行，先按 [1] 启动服务'
      } else {
        Show-Header $s '服务重启中…' $null
        try {
          if (Invoke-CastRestartService) { Set-Result '重启服务' "成功（PID $((Get-ListenInfo $Port).pid)，浏览器没动）" }
          else { Set-Result '重启服务' '重启超时，按 [5] 看错误日志' }
        } catch { Set-Result '重启服务' "失败：$($_.Exception.Message)" }
      }
    }
    '4' {
      $want = -not (Test-AutoStart)
      try {
        if (-not (Test-Admin)) {
          # 提前说一声，免得用户以为蹦出来的 UAC 框是别的东西
          Show-Header $s $null '需要管理员权限，马上会弹出 UAC 确认框，点「是」即可'
        }
        $ok = Set-AutoStart $want
        if ($want -and -not $ok) { Set-Result '开机自启' '注册了任务但读不回来，请用管理员身份重开菜单再试' }
        elseif ($want) { Set-Result '开机自启' '已设为开机自动启动（登录时最小化启动，不挡大屏）' }
        else { Set-Result '开机自启' '已取消开机自动启动' }
      } catch { Set-Result '开机自启' "设置失败：$($_.Exception.Message)" }
    }
    '5' { Show-LogMenu }
    '6' {
      $cur = Get-ShutdownTime
      $show = if ($cur) { $cur } else { '未设置' }
      $ans = (Read-Host "   每天关机时间 HH:mm（当前 $show，直接回车 = 取消定时关机）").Trim()

      if ($ans -eq '') {
        if (-not $cur) {
          Set-Result '定时关机' '本来就没有设置'
        } else {
          try {
            Set-ShutdownTime ''
            Set-Result '定时关机' '已取消定时关机'
          } catch { Set-Result '定时关机' "取消失败：$($_.Exception.Message)" }
        }
      } elseif ($ans -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') {
        Set-Result '定时关机' "时间格式不对：「$ans」要写成 HH:mm，例如 20:30"
      } else {
        $at = $ans.PadLeft(5, '0')
        try {
          Set-ShutdownTime $at
          Set-Result '定时关机' "已设置每天 $at 关机（到点前 60 秒会弹倒计时）"
        } catch { Set-Result '定时关机' "设置失败：$($_.Exception.Message)" }
      }
    }
    '0' {
      Write-Log '退出菜单'
      exit 0
    }
    default { $script:hint = "没有这个选项：$c" }
  }
}
