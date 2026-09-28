'use strict';

/**
 * 大屏开机自启总入口
 *
 *   1) 拉起 Chrome（带 CDP 远程调试参数），并直接显示 config.json 的 startUrl
 *   2) 拉起 Node 控制服务 server.js
 *
 * 幂等：重复执行安全。端口没开才启动，已开就跳过。
 * 端口与 Chrome 路径统一从 config.json 读取，保持单一数据源。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const chromeCtl = require('./chrome-ctl');
const P = require('./paths');
const CFG = require('./config');

const ROOT = P.APP_ROOT;
const LOG_FILE = path.join(ROOT, 'autostart.log');

// ---------- 配置 ----------

// 默认值统一在 config.js 里，避免和 server.js 各存一份、改一处漏一处

// config.target 形如 "127.0.0.1:9222"，取后半段作为 CDP 端口
function cdpPortOf(target) {
  const m = /:(\d+)\s*$/.exec(String(target || ''));
  return m ? Number(m[1]) : 9222;
}

// Chrome 装在哪儿、带什么参数，统一由 chrome-ctl 决定
// （自启和控制台「启动」按钮必须拉起完全一样的 Chrome）

// ---------- 工具 ----------

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\r\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    /* 日志写不进去也不能挡住启动 */
  }
  process.stdout.write(line);
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

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 脱离父进程独立运行：父进程退出后子进程继续活着
function spawnDetached(file, args, opts = {}) {
  const child = spawn(file, args, { detached: true, ...opts });
  child.unref();
  return child;
}

function appendFd(file) {
  return fs.openSync(file, 'a');
}

// Chrome 已经开着，但没在显示目标链接 —— 走 CDP 把它补上
async function ensureUrlViaCdp(target, url) {
  try {
    const { BigScreen } = require('./cdp');
    const screen = new BigScreen(target, { settleMs: 300 });
    try {
      const pages = await screen.pages();
      if (pages.some((p) => p.url === url)) {
        log('大屏已经在显示该链接，跳过');
        return true;
      }
      log('Chrome 已在运行但未显示该链接，用 CDP 打开');
      await screen.openOrSwitch(url);
      return true;
    } finally {
      screen.close();
    }
  } catch (err) {
    log(`CDP 打开链接失败：${err && err.message ? err.message : err}`);
    return false;
  }
}

// 把大屏窗口切到全屏。走窗口级全屏（Browser.setWindowBounds），不是页面的
// HTML5 全屏 —— 后者一导航就掉。和网页控制台那个「全屏」按钮是同一条路，
// 保证两条入口表现一致。
async function ensureFullscreen(target, attempts = 5) {
  const { BigScreen } = require('./cdp');

  // 第一次一般就成；失败基本是 Chrome 刚起来、窗口还没就绪，所以留几次重试
  // （最多约 5 秒）。它跑在自启流程最后，重试不会拖慢控制服务。
  for (let i = 1; i <= attempts; i++) {
    const screen = new BigScreen(target, { settleMs: 300 });
    try {
      const r = await screen.show(true);
      log(`大屏已切到全屏（窗口 ${r.windowId}，第 ${i} 次尝试）`);
      return true;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (i === attempts) {
        log(`设置全屏失败（不影响启动，可在控制台点「全屏」）：${msg}`);
        return false;
      }
      log(`全屏第 ${i} 次没成功（${msg}），1.2 秒后重试`);
      await new Promise((r2) => setTimeout(r2, 1200));
    } finally {
      screen.close();
    }
  }
  return false;
}

// ---------- 主流程 ----------

(async () => {
  const config = CFG.load();
  const cdpPort = cdpPortOf(config.target);
  const httpPort = Number(config.port) || 8080;
  const chromePath = chromeCtl.resolveChrome(config.chromePath);
  const startUrl = String(config.startUrl || '').trim() || 'about:blank';

  log('===== 大屏自启开始 =====');

  // ---- 1. Chrome ----
  log(`目标链接 ${startUrl}`);
  if (await portOpen(cdpPort)) {
    log(`Chrome 调试端口 ${cdpPort} 已在监听`);
    await ensureUrlViaCdp(config.target, startUrl);
  } else if (!chromePath) {
    log('错误：未检测到 Chrome 或 Edge 浏览器，请先安装 Google Chrome');
  } else {
    const isEdge = /msedge/i.test(chromePath);
    log(`启动大屏浏览器（${isEdge ? 'Microsoft Edge 备选' : 'Google Chrome'}，CDP 端口 ${cdpPort}）`);
    chromeCtl.startChrome(chromePath, config, cdpPort);
    const ok = await waitPort(cdpPort, 30000);
    log(ok ? '浏览器调试端口就绪' : '警告：等待浏览器调试端口超时，控制端可能暂时连不上');
  }

  // ---- 2. Node 控制服务 ----
  if (await portOpen(httpPort)) {
    log(`控制服务端口 ${httpPort} 已在监听，跳过启动`);
  } else {
    log('启动控制服务');
    // 打包后 process.execPath 就是本 exe，不带参数再起一个即跑服务；
    // 源码模式下必须显式给入口文件，否则开出来的是 node 的 REPL。
    const serverArgs = process.pkg ? [] : [path.join(__dirname, 'main.js')];
    spawnDetached(process.execPath, serverArgs, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', appendFd(path.join(ROOT, 'server.out.log')), appendFd(path.join(ROOT, 'server.err.log'))],
    });
    const ok = await waitPort(httpPort, 15000);
    log(ok ? '控制服务就绪' : '警告：控制服务启动超时');
  }

  // ---- 3. 打印访问地址 ----
  // 服务是被 detached 拉起来的，它的 stdout 进了 server.out.log 而不是这个控制台，
  // 所以地址得由自启流程自己问一次再打出来。
  // 问 /api/local 而不是自己算：服务那边知道该挑哪张网卡（要排掉虚拟网卡和代理 TUN）。
  let lanAddr = null;
  try {
    const r = await fetch(`http://127.0.0.1:${httpPort}/api/local`);
    if (r.ok) lanAddr = (await r.json()).base;
  } catch { /* 拿不到就只打回环地址 */ }

  log('────────────────────────────────────────');
  if (lanAddr) log(`控制台地址  ${lanAddr}`);
  log(`本机设置    http://127.0.0.1:${httpPort}`);
  log('────────────────────────────────────────');

  // ---- 4. 全屏 ----
  // 放在最后：全屏是锦上添花，失败或重试都不该拖慢控制服务起来。
  // --start-fullscreen 只在 Chrome 启动那一刻生效，「Chrome 已经在跑」
  // （服务重启、手动开过）时不会补上，所以这里用 CDP 再兜一次。
  await ensureFullscreen(config.target);

  log('===== 大屏自启结束 =====');
  process.exit(0);
})().catch((err) => {
  log(`自启失败：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
