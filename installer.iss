; CastFlow 安装包脚本（Inno Setup 6）
;
; 编译：  iscc installer.iss
; 前提：  先跑过 build.ps1，dist\CastFlow\ 已存在
; 产物：  dist\CastFlow-Setup-<版本>.exe
;
; 安装器要干的事，按重要性排：
;   1. 提权            —— 开防火墙规则必须要管理员
;   2. 检查 Chrome     —— 没有就提示，这是唯一的前置依赖
;   3. 开防火墙        —— 否则别的机器访问不到控制台
;   4. 注册计划任务    —— 登录时启动，必须是交互式身份（SYSTEM 在会话 0 里看不到桌面）
;   5. 关睡眠          —— 不关的话大屏会自己黑掉，用户会当成故障
;   6. 桌面快捷方式    —— 两个：打开控制台 / 重启服务
;   7. 启动并打开设置页

#define AppName "CastFlow"
#define AppVersion "1.0.0"
#define AppExe "CastFlow.exe"
#define WebPort "8080"

[Setup]
AppId={{8F3A5C21-4B7E-4D92-A6C1-3E5D7B9F0A24}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=COSCIA
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 必须提权：防火墙规则和计划任务都要管理员
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName} 大屏投放控制台
; 装完不要自动重启，这个程序不需要
RestartIfNeededByRun=no

[Languages]
Name: "cn"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "开机自动启动（推荐）"; GroupDescription: "启动选项："
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "启动选项："

[Files]
; 整个运行时目录：CastFlow.exe + public\ + topmost.ps1 + castflow.ps1
Source: "dist\{#AppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; 数据目录：只在不存在时放一份空的，升级时不会覆盖用户数据
Source: "dist\{#AppName}\media\*"; DestDir: "{app}\media"; Flags: onlyifdoesntexist skipifsourcedoesntexist

[Dirs]
; 程序目录本身也要可写：config.json / settings.json / bookmarks.json 都写在 exe 旁边
; （paths.js 里 APP_ROOT = exe 所在目录）。不放开的话首次运行就写不进配置。
Name: "{app}"; Permissions: users-modify
Name: "{app}\media"; Permissions: users-modify
Name: "{app}\chrome-profile"; Permissions: users-modify

[Icons]
; 两个入口：网页控制台（日常投放用）和本机菜单（服务挂了也能用，能启停服务）
; 本机菜单是 .ps1：快捷方式要指 powershell.exe 而不是脚本本身，因为默认执行策略
; 可能禁止跑脚本，得显式带 -ExecutionPolicy Bypass；powershell 路径写绝对，别指望 PATH。
Name: "{autodesktop}\{#AppName} 控制台"; Filename: "http://127.0.0.1:{#WebPort}"; Tasks: desktopicon
Name: "{autodesktop}\{#AppName} 本机菜单"; Filename: "{win}\System32\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\castflow.ps1"""; WorkingDirectory: "{app}"; Tasks: desktopicon
Name: "{group}\{#AppName} 控制台"; Filename: "http://127.0.0.1:{#WebPort}"
Name: "{group}\{#AppName} 本机菜单"; Filename: "{win}\System32\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\castflow.ps1"""; WorkingDirectory: "{app}"

[Run]
; ---- 防火墙：只放行控制台端口 ----
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""{#AppName} 控制台"""; Flags: runhidden; StatusMsg: "配置防火墙…"
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""{#AppName} 控制台"" dir=in action=allow protocol=TCP localport={#WebPort}"; Flags: runhidden

; ---- 关睡眠：不是可选项，Windows 默认 15 分钟息屏、30 分钟睡眠 ----
Filename: "powercfg"; Parameters: "/change monitor-timeout-ac 0"; Flags: runhidden
Filename: "powercfg"; Parameters: "/change standby-timeout-ac 0"; Flags: runhidden
Filename: "powercfg"; Parameters: "/change hibernate-timeout-ac 0"; Flags: runhidden

; ---- 计划任务：登录时启动服务 ----
; 注意：不能用 SYSTEM。SYSTEM 在会话 0，它启动的 GUI 程序在屏幕上根本看不见，
; Chrome 起来了但大屏是黑的，而且不报任何错。
;
; 用 Register-ScheduledTask 而不是 schtasks：schtasks 的 /tr 参数要嵌一层引号
; （路径带空格），套进 Inno Setup 的 "" 转义后是三层引号，几乎必错。
; cmdlet 的参数用单引号包住，一层就够。
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName '{#AppName}' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; StatusMsg: "配置开机自启…"
; 开机自启跑的是本机菜单脚本 castflow.ps1（它一打开就自动起服务），
; 并且用 cmd 的 start /min 包一层：窗口最小化到任务栏，不盖住大屏、不抢焦点，
; 而且这个窗口会一直留着 —— 出问题可以点开看状态和日志。
; 那串 [char]34 就是双引号 —— start 要求「带引号的路径」前面必须有个标题参数，
; 而 Inno 的 "" 转义和 powershell -Command 的引号解析叠在一起极易出错（见 PACKAGING.md），
; 用 [char]34 拼出来就不用去数到底有几层引号。
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$a=New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c start ' + [char]34 + [char]34 + ' /min ' + [char]34 + '{sys}\WindowsPowerShell\v1.0\powershell.exe' + [char]34 + ' -NoProfile -ExecutionPolicy Bypass -File ' + [char]34 + '{app}\castflow.ps1' + [char]34) -WorkingDirectory '{app}'; $t=New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName '{#AppName}' -Action $a -Trigger $t -Force | Out-Null"""; Flags: runhidden; Tasks: autostart

; ---- 启动 ----
Filename: "{app}\{#AppExe}"; Parameters: "--autostart"; Flags: nowait runhidden postinstall skipifsilent; StatusMsg: "启动服务…"

[UninstallRun]
; 卸载时收拾干净：停进程、删任务、删防火墙规则
; 先让服务通过 CDP 关掉它自己拉起的大屏 Chrome —— 不能用 taskkill /IM chrome.exe，
; 那会把用户自己开着的 Chrome 一起杀掉。
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""try{Invoke-RestMethod 'http://127.0.0.1:{#WebPort}/api/chrome/stop' -Method Post -TimeoutSec 25}catch{}"""; Flags: runhidden; RunOnceId: "stopchrome"
Filename: "taskkill"; Parameters: "/F /IM {#AppExe}"; Flags: runhidden; RunOnceId: "killapp"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName '{#AppName}' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "deltask"
; 定时关机的任务也一起清掉（用户设过才会有）
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName '{#AppName}Shutdown' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "delofftask"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""{#AppName} 控制台"""; Flags: runhidden; RunOnceId: "delrule"

[Code]
// 安装前检查 Chrome —— 这是唯一的前置依赖
function ChromeFound(): Boolean;
var
  Paths: array[0..2] of String;
  I: Integer;
begin
  Paths[0] := ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe');
  Paths[1] := ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe');
  Paths[2] := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  Result := False;
  for I := 0 to 2 do
    if FileExists(Paths[I]) then Result := True;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not ChromeFound() then
  begin
    if MsgBox('没有检测到 Google Chrome。' + #13#10 + #13#10 +
              'CastFlow 需要 Chrome 才能把内容显示到大屏上，请先安装 Chrome。' + #13#10 + #13#10 +
              '仍要继续安装吗？（装完再补装 Chrome 也可以）',
              mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrCode: Integer;
begin
  // 装完自动打开本机设置页 —— 用户不需要知道本机 IP，走 localhost 就行
  if CurStep = ssPostInstall then
  begin
    Sleep(2500);  // 等服务起来
    ShellExec('open', 'http://127.0.0.1:{#WebPort}/', '', '', SW_SHOWNORMAL, ewNoWait, ErrCode);
  end;
end;
