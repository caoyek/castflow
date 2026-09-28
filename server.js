'use strict';

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BigScreen, ZOOM_STEPS } = require('./cdp');
const chromeCtl = require('./chrome-ctl');
const P = require('./paths');
const CFG = require('./config');
const scheduleMgr = require('./schedule');

const ROOT = P.APP_ROOT;
const PUBLIC_DIR = P.PUBLIC_DIR;
const MEDIA_DIR = P.MEDIA_DIR;
const BOOKMARKS_FILE = P.BOOKMARKS_FILE;
const SETTINGS_FILE = P.SETTINGS_FILE;

const config = CFG.load();
const PUBLIC_BASE = CFG.publicBase(config);

const screen = new BigScreen(config.target, { settleMs: config.settleMs });

// CDP 端口从 target 解析，和 autostart.js / chrome-ctl 保持同一个来源
const CDP_PORT = Number((/:(\d+)\s*$/.exec(config.target) || [])[1]) || 9222;
const TOPMOST_PS = P.TOPMOST_PS;

// 内存看门狗状态
let heapMb = null;      // 页面的 JS 堆，看门狗按它判断要不要重载
let chromeMb = null;    // 整个 Chrome 进程树，只用于展示，不参与判断
let lastReloadAt = 0;
let reloadCount = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const typeOf = (f) => MIME[path.extname(f).toLowerCase()] ?? null;

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function readBinary(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('文件超过 100MB'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 带 Range 的静态文件服务 —— 视频拖动进度条依赖它
function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: '文件不存在' });
    const type = typeOf(filePath) ?? 'application/octet-stream';
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function listMedia() {
  if (!fs.existsSync(MEDIA_DIR)) return [];
  return fs.readdirSync(MEDIA_DIR)
    .filter((f) => typeOf(f))
    .map((f) => {
      const st = fs.statSync(path.join(MEDIA_DIR, f));
      return {
        name: f,
        size: st.size,
        kind: typeOf(f).startsWith('video') ? 'video' : 'image',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 收藏夹存在项目目录下，重启服务不丢
function loadBookmarks() {
  try {
    // 去掉可能存在的 BOM，否则 JSON.parse 抛错、整份收藏夹被当成「坏了」
    const list = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // 文件不存在或坏了都当空处理
  }
}

function saveBookmarks(list) {
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(list, null, 2));
}

// 设备浏览器设置 —— 存 settings.json，可从控制台修改
function loadSettings() {
  const defaults = {
    deviceName: '大屏设备',
    autoRestart: true,
    restartInterval: 'day',   // 'day' | 'week'
    restartTime: '04:00',
    memoryLimitMb: config.memoryLimitMb,
    memoryWatchdog: true,
    autoRestore: true,
    autoRefresh: false,
    refreshInterval: 30,       // 分钟
  };
  try {
    // 去掉可能存在的 BOM，否则 JSON.parse 抛错、设置被当成「坏了」退回默认值
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...defaults, ...s };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// 媒体目录里的文件名可能带特殊字符，拼 URL 时统一编码
function mediaPath(name) {
  const p = path.normalize(path.join(MEDIA_DIR, name));
  // 必须严格在目录内部：拼上分隔符才能把「目录本身」也挡掉
  return p.startsWith(MEDIA_DIR + path.sep) ? p : null;
}

// 关掉大屏 Chrome。优先走 CDP 的 Browser.close 让它自己正常退出 ——
// 只有这样 profile 才会被标成「正常退出」，下次启动不弹「恢复页面」。
// CDP 连不上（页面卡死之类）才退化成 taskkill 强杀，那时靠启动参数
// --hide-crash-restore-bubble 压掉气泡。
async function stopChromeProcess() {
  const pid = await chromeCtl.findPidOnPort(CDP_PORT);
  if (pid === null) return { already: true, gone: true, pid: null };

  let gone = false;
  try {
    await screen.closeBrowser();
    gone = await chromeCtl.waitPort(CDP_PORT, 8000, false);
  } catch { /* CDP 不可用，直接走强杀 */ }

  if (!gone) {
    await chromeCtl.killPid(pid);
    gone = await chromeCtl.waitPort(CDP_PORT, 12000, false);
  }
  screen.close(); // 连接已经随浏览器一起没了，清掉缓存
  return { already: false, gone, pid };
}

// ---------------------------------------------------------------
// 浏览器重启 / 自动恢复的公共动作
//
// 「定期重启」和「异常退出自动恢复」都要「按同一套参数把大屏浏览器拉起来」，
// 所以把动作和状态集中在这里，别在两处各写一遍。
// ---------------------------------------------------------------

// 控制台点过「关闭」之后就不再自动恢复 —— 那是用户的明确意图
let restoreBlocked = false;
// 重启过程中浏览器会短暂消失，这期间自动恢复要闭嘴，否则会把自家重启当故障插一脚
let restoreBlockUntil = 0;
// 只在「曾经见到浏览器在跑」之后才自动恢复：单独起个服务不该自己开浏览器
let chromeSeen = false;
// 记着大屏当前显示的页面，掉线后才能回到同一页（而不是回到 config.startUrl）
let lastUrl = null;
let lastRestoreAt = 0;
const RESTORE_COOLDOWN_MS = 3 * 60 * 1000;

function launchChrome(url) {
  const chromePath = chromeCtl.resolveChrome(config.chromePath);
  if (!chromePath) throw new Error('找不到 Chrome，请检查 config.json 的 chromePath');
  chromeCtl.startChrome(chromePath, { ...config, startUrl: url || config.startUrl }, CDP_PORT);
  return chromePath;
}

// 顺手记下当前页面；连不上就沿用上一次记的
async function rememberUrl() {
  try {
    const st = await screen.status();
    if (st.url && st.url !== 'about:blank') lastUrl = st.url;
  } catch { /* 连不上无所谓，沿用上次记的 */ }
  return lastUrl || config.startUrl;
}

async function restartChrome(url) {
  restoreBlockUntil = Date.now() + 2 * 60 * 1000;
  const r = await stopChromeProcess();
  if (!r.already && !r.gone) throw new Error(`旧的 Chrome 没退掉（PID ${r.pid}），先手动关一下`);
  launchChrome(url);
  if (!(await chromeCtl.waitPort(CDP_PORT, 30000))) {
    throw new Error('Chrome 重启超时：30 秒内调试端口未就绪');
  }
  await screen.show(true).catch(() => {});   // 大屏默认全屏
  chromeSeen = true;
  return chromeCtl.findPidOnPort(CDP_PORT);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/') {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }

    if (pathname === '/api/status') {
      const watch = {
        heapMb,
        chromeMb,
        // 整机内存每次现读，比缓存准
        sysUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
        sysTotalMb: Math.round(os.totalmem() / 1048576),
        reloadCount,
        memoryLimitMb: config.memoryLimitMb,
      };
      try {
        return json(res, 200, { online: true, ...(await screen.status()), ...watch });
      } catch (err) {
        return json(res, 200, { online: false, error: err.message, ...watch });
      }
    }

    // 本机信息：本机设置页和局域网地址要用
    if (pathname === '/api/local') {
      return json(res, 200, {
        base: PUBLIC_BASE,
        ip: CFG.lanIPv4(),
        pid: process.pid,               // 界面直接拿这个，省掉一次很慢的 CIM 查询
        port: config.port,
        appRoot: P.APP_ROOT,
        packaged: P.isPackaged,
        node: process.version,          // 打包后这是内置运行时的版本
        chromeProfile: CFG.chromeProfileDir(config),
      });
    }

    // 纯文本状态，给批处理脚本读。
    // batch 解析 JSON 要绕一大圈，key=value 用 for /f "delims==" 一行就取到了。
    if (pathname === '/api/status.txt') {
      let st = null;
      try { st = await screen.status(); } catch { /* 浏览器没起来也要能报服务状态 */ }
      const out = [
        'service=1',
        'pid=' + process.pid,
        'base=' + PUBLIC_BASE,
        'port=' + config.port,
        'browser=' + (st ? '1' : '0'),
        'tabs=' + (st ? st.pageCount : 0),
        'node=' + process.version,
        'heapMb=' + (heapMb ?? ''),
        'chromeMb=' + (chromeMb ?? ''),
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out.join('\n') + '\n');
    }

    if (pathname === '/api/reload' && req.method === 'POST') {
      await screen.reload();
      lastReloadAt = Date.now();
      reloadCount++;
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/media') {
      return json(res, 200, listMedia());
    }

    if (pathname === '/api/shot') {
      const data = await screen.screenshot();
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(Buffer.from(data, 'base64'));
    }

    if (pathname === '/api/push' && req.method === 'POST') {
      const { url: target, mode } = await readBody(req);
      if (typeof target !== 'string' || !target.trim()) {
        return json(res, 400, { error: '缺少 url' });
      }
      scheduleMgr.markManualOverride();
      const url = target.trim();
      const started = Date.now();
      // mode=new 走左侧加号新建标签页：必定新开标签并切过去
      // mode=tab 走收藏夹那套：已开着就切过去，否则新开标签
      // mode 为空（大屏上方地址栏投放）：在当前活动标签页直接跳转
      if (mode === 'new') await screen.openTab(url);
      else if (mode === 'tab') await screen.openOrSwitch(url);
      else await screen.navigate(url);
      return json(res, 200, { ok: true, url, ms: Date.now() - started });
    }

    if (pathname === '/api/bookmarks' && req.method === 'GET') {
      return json(res, 200, loadBookmarks());
    }

    if (pathname === '/api/bookmarks' && req.method === 'POST') {
      const { name, url } = await readBody(req);
      if (typeof url !== 'string' || !url.trim()) return json(res, 400, { error: '缺少 url' });
      const u = url.trim();
      const list = loadBookmarks();
      if (list.some((b) => b.url === u)) return json(res, 400, { error: '这个地址已经收藏过了' });
      list.push({ name: (typeof name === 'string' ? name.trim() : '') || u, url: u });
      saveBookmarks(list);
      return json(res, 200, { ok: true, list });
    }

    if (pathname === '/api/bookmarks/delete' && req.method === 'POST') {
      const { url } = await readBody(req);
      const list = loadBookmarks().filter((b) => b.url !== url);
      saveBookmarks(list);
      return json(res, 200, { ok: true, list });
    }

    if (pathname === '/api/fullscreen' && req.method === 'POST') {
      const { on } = await readBody(req);
      return json(res, 200, { ok: true, ...(await screen.show(on !== false)) });
    }

    if (pathname === '/api/zoom' && req.method === 'POST') {
      const { zoom } = await readBody(req);
      const z = Number(zoom);
      if (!ZOOM_STEPS.includes(z)) {
        return json(res, 400, { error: `zoom 只能是这些档位之一: ${ZOOM_STEPS.join(', ')}` });
      }
      return json(res, 200, { ok: true, ...(await screen.setZoom(z)) });
    }

    // ---- Chrome 进程控制 ----
    // 只认监听 CDP 端口的那个实例，用户自己开的 Chrome 不受影响
    if (pathname === '/api/chrome' && req.method === 'GET') {
      const pid = await chromeCtl.findPidOnPort(CDP_PORT);
      return json(res, 200, { running: pid !== null, pid });
    }

    if (pathname === '/api/chrome/start' && req.method === 'POST') {
      const running = await chromeCtl.findPidOnPort(CDP_PORT);
      if (running !== null) return json(res, 200, { ok: true, running: true, pid: running, already: true });

      try {
        launchChrome();
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
      if (!(await chromeCtl.waitPort(CDP_PORT, 30000))) {
        return json(res, 500, { error: 'Chrome 启动超时：30 秒内调试端口未就绪' });
      }
      // 显式开过之后，自动恢复重新生效
      restoreBlocked = false;
      chromeSeen = true;
      // 大屏默认全屏，和开机自启保持一致（失败也不影响启动结果）
      await screen.show(true).catch(() => {});
      return json(res, 200, { ok: true, running: true, pid: await chromeCtl.findPidOnPort(CDP_PORT) });
    }

    if (pathname === '/api/chrome/stop' && req.method === 'POST') {
      const r = await stopChromeProcess();
      // 显式点过「关闭」：告诉自动恢复别把它拉回来
      restoreBlocked = true;
      if (r.already) return json(res, 200, { ok: true, running: false, already: true });
      if (!r.gone) return json(res, 500, { error: `Chrome 没能在规定时间内退出（PID ${r.pid}）` });
      return json(res, 200, { ok: true, running: false });
    }

    if (pathname === '/api/chrome/restart' && req.method === 'POST') {
      try {
        // 重启后回到当前正在显示的页面，而不是回到 config.startUrl
        const pid = await restartChrome(await rememberUrl());
        restoreBlocked = false;
        return json(res, 200, { ok: true, running: true, pid });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // ---- 置顶（node 原生做不到，走 PowerShell 调 user32）----
    // PID 由 node 从 CDP 端口查出来再交给脚本，避免 PowerShell 里 PATH 解析不到 netstat
    if (pathname === '/api/topmost' && req.method === 'GET') {
      const pid = await chromeCtl.findPidOnPort(CDP_PORT);
      if (pid === null) return json(res, 200, { topmost: null, error: 'Chrome 未运行' });
      const r = await chromeCtl.runTopmost(TOPMOST_PS, pid, 'status');
      if (!r.ok) return json(res, 200, { topmost: null, error: r.detail });
      return json(res, 200, { topmost: r.topmost });
    }

    if (pathname === '/api/topmost' && req.method === 'POST') {
      const { on } = await readBody(req);
      const pid = await chromeCtl.findPidOnPort(CDP_PORT);
      if (pid === null) return json(res, 500, { error: 'Chrome 未运行，无法置顶' });
      const r = await chromeCtl.runTopmost(TOPMOST_PS, pid, on === false ? 'off' : 'on');
      if (!r.ok) return json(res, 500, { error: '置顶失败：' + r.detail });
      return json(res, 200, { ok: true, topmost: r.topmost });
    }

    if (pathname === '/api/tabs') {
      return json(res, 200, await screen.tabs());
    }

    if (pathname === '/api/tab' && req.method === 'POST') {
      const { targetId } = await readBody(req);
      if (typeof targetId !== 'string' || !targetId) {
        return json(res, 400, { error: '缺少 targetId' });
      }
      return json(res, 200, { ok: true, ...(await screen.switchTab(targetId)) });
    }

    if (pathname === '/api/tab/close' && req.method === 'POST') {
      const { targetId } = await readBody(req);
      if (typeof targetId !== 'string' || !targetId) {
        return json(res, 400, { error: '缺少 targetId' });
      }
      return json(res, 200, { ok: true, ...(await screen.closeTab(targetId)) });
    }

    // 拖拽上传：文件走原始二进制体，文件名放 X-Filename（已 URL 编码）
    if (pathname === '/api/upload' && req.method === 'POST') {
      const rawName = req.headers['x-filename'];
      if (!rawName) return json(res, 400, { error: '缺少 X-Filename' });

      let name;
      try { name = decodeURIComponent(rawName); } catch { name = rawName; }
      // 只取文件名部分，挡掉 ../ 穿越；顺带清掉 Windows 下的非法字符
      name = path.basename(name).replace(/[\\/:*?"<>|]/g, '_');
      const type = typeOf(name);
      if (!type) return json(res, 400, { error: '不支持的文件类型' });

      const buf = await readBinary(req);
      await fs.promises.writeFile(path.join(MEDIA_DIR, name), buf);

      const base = PUBLIC_BASE;
      const url = type.startsWith('video')
        ? `${base}/media/${encodeURIComponent(name)}`
        : `${base}/view/image/${encodeURIComponent(name)}`;
      return json(res, 200, { ok: true, name, bytes: buf.length, url });
    }

    if (pathname === '/api/media/delete' && req.method === 'POST') {
      const { name } = await readBody(req);
      if (typeof name !== 'string' || !name) return json(res, 400, { error: '缺少 name' });
      const file = mediaPath(name); // 里面已经挡了 ../ 穿越
      if (!file) return json(res, 403, { error: '路径非法' });
      try {
        await fs.promises.unlink(file);
      } catch (err) {
        return json(res, err.code === 'ENOENT' ? 404 : 500, {
          error: err.code === 'ENOENT' ? '文件不存在' : err.message,
        });
      }
      return json(res, 200, { ok: true, name });
    }

    // ---- 设备浏览器设置 ----
    if (pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, loadSettings());
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const s = loadSettings();
      // 只允许这些字段被更新
      for (const k of ['deviceName', 'autoRestart', 'restartInterval', 'restartTime',
        'memoryLimitMb', 'memoryWatchdog', 'autoRestore', 'autoRefresh', 'refreshInterval']) {
        if (k in body) s[k] = body[k];
      }
      saveSettings(s);
      // 如果内存阈值变了，同步到运行时 config，看门狗立刻生效
      if (typeof s.memoryLimitMb === 'number') config.memoryLimitMb = s.memoryLimitMb;
      if (typeof s.autoRefresh === 'boolean' && s.autoRefresh && typeof s.refreshInterval === 'number') {
        config._refreshIntervalMin = s.refreshInterval;
      }
      return json(res, 200, { ok: true, settings: s });
    }

    // ---- 分时段排期设置与调度 ----
    if (pathname === '/api/schedule' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...scheduleMgr.getStatus() });
    }

    if (pathname === '/api/schedule' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = scheduleMgr.saveSchedule(body);
      return json(res, 200, { ok: true, ...scheduleMgr.getStatus(), schedule: saved });
    }

    if (pathname === '/api/schedule/toggle' && req.method === 'POST') {
      const { enabled } = await readBody(req);
      const s = scheduleMgr.loadSchedule();
      s.enabled = enabled !== undefined ? !!enabled : !s.enabled;
      scheduleMgr.saveSchedule(s);
      return json(res, 200, { ok: true, ...scheduleMgr.getStatus() });
    }

    if (pathname === '/api/schedule/resume' && req.method === 'POST') {
      const r = await scheduleMgr.resumeSchedule(screen, PUBLIC_BASE);
      return json(res, 200, { ...r, ...scheduleMgr.getStatus() });
    }

    if (pathname === '/api/schedule/test' && req.method === 'POST') {
      const { rule } = await readBody(req);
      if (!rule) return json(res, 400, { error: '缺少 rule' });
      await scheduleMgr.testRule(rule, screen, PUBLIC_BASE);
      return json(res, 200, { ok: true });
    }

    // 图片展示页：同一个 HTML，靠前端解析路径里的文件名
    if (pathname.startsWith('/view/image/')) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'image.html'));
    }

    if (pathname.startsWith('/media/')) {
      const file = mediaPath(pathname.slice('/media/'.length));
      if (!file) return json(res, 403, { error: '路径非法' });
      return serveFile(req, res, file);
    }

    // 兜底 public 静态资源服务（logo.png、favicon.png、favicon.ico 等）
    const publicPath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (publicPath.startsWith(path.normalize(PUBLIC_DIR)) && fs.existsSync(publicPath)) {
      try {
        if (fs.statSync(publicPath).isFile()) {
          return serveFile(req, res, publicPath);
        }
      } catch { }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// 看门狗：BI 类大屏页面挂久了内存会涨，超过阈值就重载页面。
// 用重载而不是重启浏览器 —— 重启后 CDP 端点就没了，控制端再也拉不起来它。
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

setInterval(async () => {
  // Chrome 整体内存只用于展示，所以放在看门狗开关之前算 —— 关掉看门狗也要能看到读数
  try {
    const pid = await chromeCtl.findPidOnPort(CDP_PORT);
    const m = pid === null ? null : await chromeCtl.chromeTreeMemory(pid);
    chromeMb = m ? Math.round(m.bytes / 1048576) : null;
  } catch {
    chromeMb = null;
  }

  try {
    const s = loadSettings();
    if (!s.memoryWatchdog) return;  // 内存看门狗被关了就不查
    const used = await screen.heapUsed();
    heapMb = Math.round(used / 1024 / 1024);
    if (used <= config.memoryLimitMb * 1024 * 1024) return;
    // 冷却期：万一是页面一加载就超阈值，没有它会变成无休止重载
    if (Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) return;

    console.log(`[看门狗] 内存 ${heapMb}MB 超过 ${config.memoryLimitMb}MB，重载页面`);
    await screen.reload();
    lastReloadAt = Date.now();
    reloadCount++;
    heapMb = Math.round((await screen.heapUsed()) / 1024 / 1024);
    console.log(`[看门狗] 重载完成，内存降到 ${heapMb}MB`);
  } catch {
    // 大屏机离线之类的，跳过这轮
  }
}, config.memoryCheckSec * 1000);

// 定时自动刷新：如果设置里开了，每隔 N 分钟重载一次页面，避免 BI 看板数据停滞
let lastAutoRefreshAt = 0;
setInterval(async () => {
  try {
    const s = loadSettings();
    if (!s.autoRefresh || !s.refreshInterval) return;
    const intervalMs = s.refreshInterval * 60 * 1000;
    if (Date.now() - lastAutoRefreshAt < intervalMs) return;
    // 只在 Chrome 在线时刷新
    const pid = await chromeCtl.findPidOnPort(CDP_PORT);
    if (pid === null) return;
    await screen.reload();
    lastAutoRefreshAt = Date.now();
    console.log(`[自动刷新] 标签页已刷新（每 ${s.refreshInterval} 分钟）`);
  } catch {
    // 离线跳过
  }
}, config.memoryCheckSec * 1000);

// ---- 定期重启浏览器 ----
// 到点把浏览器整个关掉再拉起来（回到掉线前那个页面），用来清掉长时间运行攒下的内存。
// 界面上只有「每天 / 每周」两个选项，没有单独的星期，所以「每周」约定成每周一。
let lastRestartKey = '';

setInterval(async () => {
  try {
    const s = loadSettings();
    if (!s.autoRestart || !s.restartTime) return;

    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.restartTime).trim());
    if (!m) return;
    const now = new Date();
    if (now.getHours() !== Number(m[1]) || now.getMinutes() !== Number(m[2])) return;
    if (s.restartInterval === 'week' && now.getDay() !== 1) return;

    // 同一个「日期 + 时刻」只触发一次（30 秒扫一次，这一分钟内会命中两回）
    const key = `${now.toDateString()} ${m[1]}:${m[2]}`;
    if (key === lastRestartKey) return;
    lastRestartKey = key;

    console.log(`[定期重启] 到点（${s.restartInterval === 'week' ? '每周一' : '每天'} ${s.restartTime}），重启大屏浏览器`);
    await restartChrome(await rememberUrl());
    console.log('[定期重启] 完成');
  } catch (err) {
    console.log(`[定期重启] 失败：${err.message}`);
  }
}, 30 * 1000);

// ---- 异常退出自动恢复 ----
// 大屏浏览器掉了（崩了 / 被误关）就按同一套参数拉回来，并回到掉线前那个页面。
// 控制台显式点过「关闭」、或者本来就没起来过，都不主动开。
setInterval(async () => {
  try {
    const s = loadSettings();
    if (!s.autoRestore || restoreBlocked || Date.now() < restoreBlockUntil) return;

    const pid = await chromeCtl.findPidOnPort(CDP_PORT);
    if (pid !== null) {
      chromeSeen = true;
      await rememberUrl();       // 在的时候顺手记下当前页面
      return;
    }
    if (!chromeSeen) return;     // 本来就没起来过，不主动开
    if (Date.now() - lastRestoreAt < RESTORE_COOLDOWN_MS) return;
    lastRestoreAt = Date.now();

    const url = lastUrl || config.startUrl;
    console.log(`[自动恢复] 浏览器不在了，按 ${url} 拉回来`);
    launchChrome(url);
    if (await chromeCtl.waitPort(CDP_PORT, 30000)) {
      await screen.show(true).catch(() => {});
      console.log('[自动恢复] 已恢复并全屏');
    } else {
      console.log('[自动恢复] 拉起超时，下一轮还会再试');
    }
  } catch (err) {
    console.log(`[自动恢复] 失败：${err.message}`);
  }
}, 30 * 1000);

// ---- 分时段排期调度巡检 ----
// 每 15 秒检查一次时间段跨越点，自动驱动大屏无缝切换内容
setInterval(async () => {
  try {
    const pid = await chromeCtl.findPidOnPort(CDP_PORT);
    if (pid !== null) {
      await scheduleMgr.checkScheduleTick(screen, PUBLIC_BASE, true);
    }
  } catch (err) {
    // 巡检异常跳过
  }
}, 15 * 1000);

// ---- 启动 ----
server.on('error', (err) => {
  console.error('[Server Error]', err);
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`控制台   ${PUBLIC_BASE}`);
  console.log(`本机设置 http://127.0.0.1:${config.port}`);
  console.log(`大屏机   ${config.target}`);
  console.log(`数据目录 ${P.APP_ROOT}`);
});
