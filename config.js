'use strict';

/**
 * 配置加载 —— 全自适应，不留硬编码
 *
 * 之前 server.js 和 autostart.js 各存了一份默认值，改一处漏一处。
 * 现在统一在这里，两边都从这里取。
 *
 * 三条「自适应」规则：
 *   1. publicBase 填 'auto' → 启动时探测本机 IPv4（排掉虚拟网卡）
 *   2. chromePath 留空     → 交给 chrome-ctl 从注册表和各安装位置找
 *   3. chromeProfile 相对路径 → 按程序目录解析，整个目录能搬走
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');

const DEFAULTS = {
  target: '127.0.0.1:9222',        // 本机回环 + Chrome 标准调试端口
  port: 18089,
  settleMs: 1500,
  memoryLimitMb: 400,
  memoryCheckSec: 60,
  publicBase: 'auto',
  chromePath: '',                   // 空 = 自动查找
  chromeProfile: 'chrome-profile',  // 相对 = 程序目录下
  // 大屏默认全屏：--start-fullscreen 让窗口一起来就是全屏，不露任务栏和边框。
  // 它只在 Chrome 启动那一刻生效，所以「Chrome 已经在跑」的情况由 autostart 用 CDP 兜一次。
  chromeExtraArgs: ['--start-fullscreen', '--autoplay-policy=no-user-gesture-required'],
  startUrl: 'about:blank',
};

// 注意先去掉开头的 BOM：用 PowerShell 的 Set-Content -Encoding UTF8、或记事本选
// 「UTF-8 带 BOM」存过的文件，JSON.parse 会直接抛错，整份配置就被当成「损坏」
// 而静默退回默认值 —— 用户会看到「改完再打开，设置全没了」这种怪事。
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// 首次运行（或配置损坏）时写出默认值再返回，避免新机器上启动即崩
function load() {
  try {
    return { ...DEFAULTS, ...readJson(P.CONFIG_FILE) };
  } catch {
    try { fs.writeFileSync(P.CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2)); } catch { /* 只读目录也不能挡住启动 */ }
    return { ...DEFAULTS };
  }
}

/**
 * 本机对外 IPv4。
 *
 * 要排掉虚拟网卡：Hyper-V / VMware / VirtualBox / VPN / 代理软件的 TUN
 * （Clash 那类会把 198.18.x.x 挂上来），还有蓝牙和个人热点。
 * 优先物理网卡，找不到再退而求其次。
 */
function lanIPv4() {
  const skip = /virtual|vmware|virtualbox|hyper-?v|vethernet|loopback|tap|tun|tailscale|zerotier|docker|wsl|meta|bluetooth|蓝牙/i;
  const prefer = /ethernet|以太网|wi-?fi|wlan|无线/i;

  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || ni.address.startsWith('169.254.')) continue;
      found.push({ name, address: ni.address });
    }
  }

  const pick = found.find((x) => prefer.test(x.name) && !skip.test(x.name))
    ?? found.find((x) => !skip.test(x.name))
    ?? found[0];

  return pick ? pick.address : '127.0.0.1';
}

// 'auto' → 探测；其它值原样用（去掉末尾斜杠）
function publicBase(cfg) {
  const b = String(cfg.publicBase || '').trim();
  if (b && b !== 'auto') return b.replace(/\/+$/, '');
  return `http://${lanIPv4()}:${cfg.port}`;
}

// 相对路径按程序目录解析，这样整个安装目录能整体搬走而不失效
function chromeProfileDir(cfg) {
  const p = String(cfg.chromeProfile || 'chrome-profile');
  return path.isAbsolute(p) ? p : path.join(P.APP_ROOT, p);
}

module.exports = { DEFAULTS, load, lanIPv4, publicBase, chromeProfileDir };
