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
;   7. 完成页可选：启动大屏服务 / 打开桌面控制台（安装前会先停掉运行中的旧版本）

#define AppName "CastFlow"
#define AppVersion "1.0.4"
#define AppExe "CastFlow.exe"
#define WebPort "18089"

[Setup]
AppId={{8F3A5C21-4B7E-4D92-A6C1-3E5D7B9F0A24}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=CastFlow
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
; 整个运行时目录：CastFlow.exe + CastFlowManager.exe + public\ + topmost.ps1
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
; 两个入口：网页控制台（日常远程投放用）和桌面控制台程序（GUI 管理面板，带托盘常驻守护）
Name: "{autodesktop}\{#AppName} Web 控制台"; Filename: "http://127.0.0.1:{#WebPort}"; Tasks: desktopicon
Name: "{autodesktop}\{#AppName} 控制台"; Filename: "{app}\CastFlowManager.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon
Name: "{group}\{#AppName} Web 控制台"; Filename: "http://127.0.0.1:{#WebPort}"
Name: "{group}\{#AppName} 控制台"; Filename: "{app}\CastFlowManager.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"

[Run]
; ---- 防火墙：只放行控制台端口 ----
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""{#AppName} 控制台"""; Flags: runhidden; StatusMsg: "配置防火墙…"
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""{#AppName} 控制台"" dir=in action=allow protocol=TCP localport={#WebPort}"; Flags: runhidden

; ---- 关睡眠：不是可选项，Windows 默认 15 分钟息屏、30 分钟睡眠 ----
Filename: "powercfg"; Parameters: "/change monitor-timeout-ac 0"; Flags: runhidden
Filename: "powercfg"; Parameters: "/change standby-timeout-ac 0"; Flags: runhidden
Filename: "powercfg"; Parameters: "/change hibernate-timeout-ac 0"; Flags: runhidden

; ---- 计划任务：登录时启动服务 ----
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName '{#AppName}' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; StatusMsg: "配置开机自启…"
; 开机自启：静默拉起 CastFlow.exe --autostart（自动带出 Chrome 大屏并运行后台控制服务）
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$a=New-ScheduledTaskAction -Execute '{app}\{#AppExe}' -Argument '--autostart' -WorkingDirectory '{app}'; $t=New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName '{#AppName}' -Action $a -Trigger $t -Force | Out-Null"""; Flags: runhidden; Tasks: autostart

; ---- 启动（安装完成页的勾选项，点「完成」后才执行）----
Filename: "{app}\{#AppExe}"; Parameters: "--autostart"; WorkingDir: "{app}"; Description: "启动大屏服务"; Flags: nowait runhidden postinstall skipifsilent
Filename: "{app}\CastFlowManager.exe"; WorkingDir: "{app}"; Description: "打开 CastFlow 控制台"; Flags: nowait postinstall skipifsilent

; ---- 在线更新（管理器以 /SILENT /CFUPDATE=1 调起）：装完自动重启 ----
; 必须 runasoriginaluser：安装器是管理员权限，直接拉起会让服务和大屏 Chrome 也跑在提权身份下
Filename: "{app}\{#AppExe}"; Parameters: "--autostart"; WorkingDir: "{app}"; Flags: nowait runhidden runasoriginaluser; Check: IsUpdateStartService; StatusMsg: "重启服务…"
Filename: "{app}\CastFlowManager.exe"; WorkingDir: "{app}"; Flags: nowait runasoriginaluser; Check: IsSilentUpdate

[UninstallRun]
; 卸载时收拾干净：停进程、删任务、删防火墙规则
; 先让服务通过 CDP 关掉它自己拉起的大屏 Chrome —— 不能用 taskkill /IM chrome.exe，
; 那会把用户自己开着的 Chrome 一起杀掉。
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Invoke-RestMethod 'http://127.0.0.1:{#WebPort}/api/chrome/stop' -Method Post -TimeoutSec 5 -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "stopchrome"
Filename: "taskkill"; Parameters: "/F /IM {#AppExe}"; Flags: runhidden; RunOnceId: "killapp"
Filename: "taskkill"; Parameters: "/F /IM CastFlowManager.exe"; Flags: runhidden; RunOnceId: "killmgr"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName '{#AppName}' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "deltask"
; 定时关机的任务也一起清掉（用户设过才会有）
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName '{#AppName}Shutdown' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "delofftask"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""{#AppName} 控制台"""; Flags: runhidden; RunOnceId: "delrule"

[Code]
// ---- 在线更新模式 ----
// 管理器调起参数：/SILENT /SUPPRESSMSGBOXES /NORESTART /CFUPDATE=1 /CFSTARTSERVICE=0|1
function IsSilentUpdate(): Boolean;
begin
  Result := WizardSilent() and (ExpandConstant('{param:CFUPDATE|0}') = '1');
end;

// 升级前服务在运行才重新拉起，保持升级前后状态一致
function IsUpdateStartService(): Boolean;
begin
  Result := IsSilentUpdate() and (ExpandConstant('{param:CFSTARTSERVICE|1}') = '1');
end;

// 停掉正在运行的服务、控制台和大屏 Chrome，否则 CastFlow.exe / CastFlowManager.exe 被占用无法覆盖
procedure StopRunningApp();
var
  ResultCode: Integer;
begin
  // 先让服务通过 CDP 关掉它自己拉起的大屏 Chrome（不能 taskkill chrome.exe，会误杀用户自己的 Chrome）
  // 服务没运行时连接会被立即拒绝，不会拖慢全新安装
  Exec('powershell.exe',
       '-NoProfile -Command "try { Invoke-RestMethod ''http://127.0.0.1:{#WebPort}/api/chrome/stop'' -Method Post -TimeoutSec 3 | Out-Null } catch {}"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM CastFlowManager.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM {#AppExe}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 等进程彻底退出、文件句柄释放
  Sleep(1000);
end;

// 安装 / 升级开始前执行（在检测文件占用之前），返回空字符串表示继续安装
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  I: Integer;
begin
  Result := '';

  // 在线更新：先给管理器最多 20 秒自己优雅退出（它会先停服务和大屏 Chrome）
  if IsSilentUpdate() then
  begin
    I := 0;
    while CheckForMutexes('CastFlowManager_SingleInstance_Mutex_Global') and (I < 40) do
    begin
      Sleep(500);
      I := I + 1;
    end;
  end;

  // 手动安装和在线更新都兜底停一次，避免“服务没停就装不上”
  StopRunningApp();
end;

// 安装前检查 Chrome 与 Edge
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

function EdgeFound(): Boolean;
var
  Paths: array[0..2] of String;
  I: Integer;
begin
  Paths[0] := ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe');
  Paths[1] := ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe');
  Paths[2] := ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe');
  Result := False;
  for I := 0 to 2 do
    if FileExists(Paths[I]) then Result := True;
end;

function InitializeSetup(): Boolean;
var
  ErrCode: Integer;
begin
  Result := True;
  // 静默安装（含在线更新）不弹任何窗口，避免卡住无人值守的大屏
  if WizardSilent() then Exit;
  if not ChromeFound() then
  begin
    if EdgeFound() then
    begin
      MsgBox('系统未检测到 Google Chrome，但已检测到 Microsoft Edge。' + #13#10 + #13#10 +
             'CastFlow 将自动使用 Edge 作为备选大屏渲染引擎。' + #13#10 +
             '安装完成后可直接正常使用；若需更佳大屏兼容性，也可随后安装 Google Chrome。',
             mbInformation, MB_OK);
    end
    else
    begin
      if MsgBox('没有检测到 Google Chrome 或 Microsoft Edge 浏览器。' + #13#10 + #13#10 +
                'CastFlow 大屏展示依赖 Chrome 渲染大屏并进行远程控制。' + #13#10 + #13#10 +
                '是否立即前往 Google Chrome 官网下载安装？' + #13#10 +
                '（点击“是”将打开官网下载，稍后仍可继续安装）',
                mbConfirmation, MB_YESNO) = IDYES then
      begin
        ShellExec('open', 'https://www.google.cn/chrome/', '', '', SW_SHOWNORMAL, ewNoWait, ErrCode);
      end;
    end;
  end;
end;

// 注：不再在安装结束时自动打开 http://127.0.0.1 网页。ssPostInstall 早于完成页的「启动大屏服务」，
// 那时服务还没起来，页面必然打不开；改为由完成页勾选「打开 CastFlow 控制台」。
