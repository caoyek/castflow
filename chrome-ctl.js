'use strict';

/**
 * Chrome 进程控制
 *
 * 关键点：只认「监听 CDP 端口」的那个 Chrome 实例，不会误伤用户自己开的其它 Chrome。
 *   - 找实例：netstat 里查监听 CDP 端口的 PID
 *   - 关实例：taskkill 该 PID（浏览器主进程一死，整棵渲染进程树跟着退）
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const CFG = require('./config');

// 系统盘不一定是 C:，从环境变量取
const PS_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

// 启动参数集中在这里，保证「开机自启」和「控制台点启动」拉起的是同一个 Chrome
function buildChromeArgs(config, cdpPort) {
  return [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*',
    `--user-data-dir=${CFG.chromeProfileDir(config)}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 上次是被强杀（停电 / taskkill）的话，profile 会留「异常退出」标记，
    // 启动时弹「Chrome 未正确关闭，要恢复页面吗」。这个开关把那个气泡压掉。
    '--hide-crash-restore-bubble',
    ...(Array.isArray(config.chromeExtraArgs) ? config.chromeExtraArgs : []),
    String(config.startUrl || 'about:blank'),
  ];
}

// Chrome 写在注册表里的安装路径。这是 Windows 标准的应用查找位置，
// 比猜目录可靠 —— 用户把 Chrome 装到非默认位置时只有它能找到。
function chromeFromRegistry() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const key of keys) {
    try {
      const out = require('child_process').execFileSync(
        'reg', ['query', key, '/ve'],
        { windowsHide: true, timeout: 8000, encoding: 'utf8' }
      );
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
      if (m && fs.existsSync(m[1].trim())) return m[1].trim();
    } catch { /* 这个键不存在就试下一个 */ }
  }
  return null;
}

// Chrome 装在哪儿完全自适应：注册表 → 三个常见位置。
// 查过一次就缓存，省得每次调 API 都去读注册表。
let chromeCache;

function resolveChrome(configured) {
  if (configured && fs.existsSync(configured)) return configured;   // config 里指定了就用它
  if (chromeCache !== undefined) return chromeCache;

  chromeCache = chromeFromRegistry()
    || [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ].find((p) => fs.existsSync(p))
    || null;

  return chromeCache;
}

// 脱离父进程独立运行：控制端重启不会把 Chrome 一起带走
function launchChrome(chromePath, args) {
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// 上次被强杀（停电 / taskkill）时 Chrome 会在 profile 里留下 exit_type=Crashed，
// 下次启动就弹「Chrome 未正确关闭，要恢复页面吗」。
// 实测：Chrome 启动时只读这个值、不会自己改回来，所以拉起之前手动清成 Normal 即可。
// （清成 Normal 后启动，Chrome 全程保持 Normal，气泡不再出现。）
function clearCrashFlag(profileDir) {
  const prefPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const j = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    const prof = (j.profile = j.profile || {});
    if (prof.exit_type === 'Normal' && prof.exited_cleanly === true) return false;
    prof.exit_type = 'Normal';
    prof.exited_cleanly = true;
    fs.writeFileSync(prefPath, JSON.stringify(j));
    return true;
  } catch {
    // 首次启动还没有 Preferences，或者文件坏了 —— 都别动，Chrome 会自己建
    return false;
  }
}

// 拉起大屏 Chrome 的统一入口：先清崩溃标记，再带参数启动
function startChrome(chromePath, config, cdpPort) {
  clearCrashFlag(CFG.chromeProfileDir(config));
  return launchChrome(chromePath, buildChromeArgs(config, cdpPort));
}

function findPidOnPort(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = re.exec(line);
        if (m) return resolve(Number(m[1]));
      }
      resolve(null);
    });
  });
}

function killPid(pid) {
  return new Promise((resolve) => {
    // taskkill 找不到进程时也返回非 0，这里不区分，调用方靠端口是否释放来判断
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
  });
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(800);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// want=true 等端口起来，want=false 等端口释放
async function waitPort(port, timeoutMs, want = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen(port)) === want) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// 置顶：node 原生做不到，走 PowerShell 调 user32 的 SetWindowPos。
// PID 由调用方用 findPidOnPort 查好传进来 —— 不让 PowerShell 自己去跑 netstat，
// 因为子进程里的 PATH 未必能解析到 netstat。
function runTopmost(scriptPath, targetPid, action) {
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action, '-TargetPid', String(targetPid)],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const m = /TOPMOST=(\d)/.exec(out);
        if (m) return resolve({ ok: true, topmost: m[1] === '1', detail: null });
        const detail = out || String(stderr || '').trim() || (err && err.message) || '置顶脚本无输出';
        resolve({ ok: false, topmost: null, detail });
      }
    );
  });
}

// 整个 Chrome 进程树的内存（各进程工作集之和）。
//
// 为什么需要它：页面的 JS 堆（Runtime.getHeapUsage）看不到图片解码、GPU 显存、
// 其它标签页 —— 那些都在渲染进程的原生内存里。JS 堆可能只有几十 MB，
// 而 Chrome 整体已经吃了一两个 GB。
//
// 从监听 CDP 端口的那个 PID 往下走进程树，所以不会把用户自己开的 Chrome 算进来。
function chromeTreeMemory(rootPid) {
  const script = [
    `$root = ${Number(rootPid)}`,
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize',
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    '[void]$ids.Add($root)',
    'do {',
    '  $added = $false',
    '  foreach ($p in $all) {',
    '    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {',
    '      [void]$ids.Add([int]$p.ProcessId); $added = $true',
    '    }',
    '  }',
    '} while ($added)',
    '$sum = 0; $n = 0',
    'foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $sum += $p.WorkingSetSize; $n++ } }',
    'Write-Output "$sum $n"',
  ].join("\n");

  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const m = /(\d+)\s+(\d+)/.exec(String(stdout || ''));
        resolve(err || !m ? null : { bytes: Number(m[1]), processes: Number(m[2]) });
      }
    );
  });
}

module.exports = {
  PS_EXE,
  buildChromeArgs,
  chromeTreeMemory,
  resolveChrome,
  launchChrome,
  startChrome,
  clearCrashFlag,
  findPidOnPort,
  killPid,
  portOpen,
  waitPort,
  runTopmost,
};
