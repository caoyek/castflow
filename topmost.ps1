# ============================================================
#  daping: set / read "always on top" for the big-screen Chrome
#
#  Chrome and CDP have no always-on-top capability, so we set
#  the WS_EX_TOPMOST extended style directly via user32.
#
#  The caller (chrome-ctl.js) resolves the Chrome PID from the
#  CDP port and passes it in, so this script never has to run
#  netstat or depend on PATH.
#
#  Output (stdout, parsed by chrome-ctl.js):
#     TOPMOST=1 | TOPMOST=0 | NO_PID | NO_WINDOW | ERROR: ...
# ============================================================
param(
  [ValidateSet('on', 'off', 'toggle', 'status')][string]$Action = 'status',
  [int]$TargetPid = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Daping -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
'@

try {
  if ($TargetPid -le 0) { Write-Output 'NO_PID'; exit 1 }

  $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 1 }
  $h = $proc.MainWindowHandle

  $GWL_EXSTYLE   = -20
  $WS_EX_TOPMOST = 0x00000008
  $HWND_TOPMOST   = [IntPtr](-1)
  $HWND_NOTOPMOST = [IntPtr](-2)
  $SWP_NOSIZE     = 0x0001
  $SWP_NOMOVE     = 0x0002
  $SWP_NOACTIVATE = 0x0010
  $SWP_SHOWWINDOW = 0x0040
  $FLAGS = $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW

  $cur = [bool]([Daping.Win]::GetWindowLong($h, $GWL_EXSTYLE) -band $WS_EX_TOPMOST)

  switch ($Action) {
    'on'     { $want = $true }
    'off'    { $want = $false }
    'toggle' { $want = -not $cur }
    default  { $want = $cur }
  }

  if ($want -ne $cur) {
    $after = if ($want) { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
    [void][Daping.Win]::SetWindowPos($h, $after, 0, 0, 0, 0, $FLAGS)
    Start-Sleep -Milliseconds 150
    $cur = [bool]([Daping.Win]::GetWindowLong($h, $GWL_EXSTYLE) -band $WS_EX_TOPMOST)
  }

  Write-Output ("TOPMOST=" + [int]$cur)
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
  exit 1
}
