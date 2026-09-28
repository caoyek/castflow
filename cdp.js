'use strict';

const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome 的原生缩放档位，和设置里那串完全一致
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// 一条 CDP 连接：命令应答 + 事件订阅
class Conn {
  constructor(ws, timeout) {
    this.ws = ws;
    this.timeout = timeout;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on('message', (buf) => this.#onMessage(buf));
    // 没有 error 监听器时 ws 会抛出未捕获异常，直接崩掉整个进程
    ws.on('error', () => {});
    ws.on('close', () => this.#failAll(new Error('CDP 连接已断开')));
  }

  #failAll(err) {
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.pending.clear();
  }

  static open(url, timeout) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const fail = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP 连接超时: ${url}`));
      }, timeout);
      ws.once('open', () => { clearTimeout(fail); resolve(new Conn(ws, timeout)); });
      ws.once('error', (err) => { clearTimeout(fail); reject(err); });
    });
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  #onMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }

    if (msg.id !== undefined) {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
      return;
    }

    const handlers = this.listeners.get(msg.method);
    if (handlers) for (const h of [...handlers]) h(msg.params);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 发一条不需要回应的命令。Browser.close 就是这种：浏览器会直接退出，
  // 根本不回响应，用 send() 只会白等一个超时。
  sendNoReply(method, params = {}) {
    try {
      this.ws.send(JSON.stringify({ id: ++this.seq, method, params }));
    } catch {
      /* 连接已经断了，忽略 */
    }
  }

  // 等一个事件；超时返回 null 而不是抛错（页面可能永远不触发 load）
  once(method, ms) {
    return new Promise((resolve) => {
      const handler = (params) => {
        clearTimeout(timer);
        this.listeners.get(method).delete(handler);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.listeners.get(method)?.delete(handler);
        resolve(null);
      }, ms);
      if (!this.listeners.has(method)) this.listeners.set(method, new Set());
      this.listeners.get(method).add(handler);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* 已经断了 */ }
  }
}

class BigScreen {
  constructor(host, opts = {}) {
    this.host = host;
    this.timeout = opts.timeout ?? 15000;
    this.settleMs = opts.settleMs ?? 1500;
    this.targetId = null;
    this.page = null;
    this.browser = null;
    this.zoom = 1;
    this.baseDpr = null;
  }

  async #json(path) {
    const res = await fetch(`http://${this.host}${path}`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async pages() {
    const all = await this.#json('/json/list');
    // Chrome 会把 Omnibox 弹窗之类的内部 UI 也列进来，那些 type 不是 page，导航会报错
    return all.filter((t) => t.type === 'page');
  }

  // /json/list 不告诉你哪个标签在前台，只能连上去问 document.visibilityState：
  // 后台标签是 hidden，前台那个是 visible。顺序查，命中即停。
  async #visibleTargetId(pages) {
    for (const p of pages) {
      try {
        const conn = await Conn.open(p.webSocketDebuggerUrl, 3000);
        const { result } = await conn.send('Runtime.evaluate', {
          expression: 'document.visibilityState',
          returnByValue: true,
        });
        conn.close();
        if (result.value === 'visible') return p.id;
      } catch { /* 这个标签问不到就跳过 */ }
    }
    return null;
  }

  async #pickTarget() {
    const pages = await this.pages();
    if (pages.length === 0) throw new Error('大屏机上没有可用的标签页');
    // 优先复用上次选中的，避免在多个标签间乱跳
    let target = pages.find((p) => p.id === this.targetId);
    if (!target) {
      // 首次接管时挑真正在前台的那个，/json/list 的先后顺序没有保证
      const visibleId = await this.#visibleTargetId(pages);
      target = pages.find((p) => p.id === visibleId) ?? pages[0];
    }
    this.targetId = target.id;
    return target;
  }

  async tabs() {
    const pages = await this.pages();
    const activeId = await this.#visibleTargetId(pages);
    return pages.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      active: p.id === activeId,
    }));
  }

  // 切标签用 Page.bringToFront。窗口全屏是 Browser.setWindowBounds 设的（窗口级），
  // 不是页面的 HTML5 全屏，所以切标签不会把全屏踢掉。
  async switchTab(targetId) {
    const pages = await this.pages();
    const target = pages.find((p) => p.id === targetId);
    if (!target) throw new Error('找不到该标签页');

    const conn = await Conn.open(target.webSocketDebuggerUrl, this.timeout);
    await conn.send('Page.bringToFront');
    this.page?.close();
    this.page = conn;
    this.targetId = targetId;

    // 缩放按域名存，新标签的域名未必有同样的档位，补一次保持一致
    if (this.zoom !== 1) await this.#stepTo(conn, ZOOM_STEPS.indexOf(this.zoom));

    return { targetId, title: target.title, url: target.url };
  }

  // 新开标签页并切过去。新标签会直接激活并切到前台
  async openTab(url) {
    const conn = await this.#browserConn();
    const { targetId } = await conn.send('Target.createTarget', { url, newWindow: false });
    await conn.send('Target.activateTarget', { targetId }).catch(() => {});
    await sleep(300); // 等它出现在 /json/list 里

    // 显式激活并切到该新标签页
    return this.switchTab(targetId);
  }

  // 收藏夹点击用：已经开着就切过去（省一次加载），否则新开一个
  async openOrSwitch(url) {
    const pages = await this.pages();
    const existing = pages.find((p) => p.url === url);
    if (existing) return this.switchTab(existing.id);
    await this.openTab(url);
    return { targetId: this.targetId, title: null, url };
  }

  async closeTab(targetId) {
    const pages = await this.pages();
    const target = pages.find((p) => p.id === targetId);
    if (!target) throw new Error('找不到该标签页');
    // 关掉最后一个标签 Chrome 会连窗口一起关，之后就再也连不上了，只能去机器跟前重启
    if (pages.length <= 1) throw new Error('这是最后一个标签页，关掉大屏就空了');

    const conn = await this.#browserConn();
    await conn.send('Target.closeTarget', { targetId });

    // 关掉的正好是当前操作对象，就重新挑一个，否则后续投放会打到已经消失的 target 上
    if (this.targetId === targetId) {
      this.page?.close();
      this.page = null;
      this.targetId = null;
      await this.#pickTarget();
    }
    return { targetId, title: target.title };
  }

  // 页面级连接：导航、截图
  async #pageConn() {
    if (this.page?.isOpen) return this.page;
    const target = await this.#pickTarget();
    this.page = await Conn.open(target.webSocketDebuggerUrl, this.timeout);
    // 缩放 override 挂在 CDP 会话上，断线重连后新会话是干净的。
    // 不补回来的话，控制台显示 150% 而大屏实际是 100%，且不会报错。
    if (this.zoom !== 1) {
      await this.#stepTo(this.page, ZOOM_STEPS.indexOf(this.zoom));
    }
    return this.page;
  }

  // 浏览器级连接：Browser 域只在这个 endpoint 上暴露，页面级连接调不到
  async #browserConn() {
    if (this.browser?.isOpen) return this.browser;
    const { webSocketDebuggerUrl } = await this.#json('/json/version');
    this.browser = await Conn.open(webSocketDebuggerUrl, this.timeout);
    return this.browser;
  }

  // ---------- 对外能力 ----------

  async navigate(url) {
    const conn = await this.#pageConn();
    await conn.send('Page.enable');
    const loaded = conn.once('Page.loadEventFired', this.timeout);
    const res = await conn.send('Page.navigate', { url });
    if (res.errorText) throw new Error(`导航失败: ${res.errorText}`);
    await loaded;
    // 缩放靠 CDP 会话维持，连接断过再重连就丢了。导航后补一次，
    // 免得投放完大屏莫名其妙回到 100%。
    if (this.zoom !== 1) await this.#stepTo(conn, ZOOM_STEPS.indexOf(this.zoom));
    // load 事件早于实际渲染完成，BI 类页面尤其明显，留一点沉降时间再截图
    await new Promise((r) => setTimeout(r, this.settleMs));
    return res;
  }

  // CDP 协议里没有任何设置浏览器缩放的命令：Emulation 那两个（setPageScaleFactor、
  // setDeviceMetricsOverride）分别是捏合缩放和视口模拟，Chrome 自己的缩放百分比纹丝不动。
  // 唯一的路是模拟 Ctrl+加号/减号。实测必须用 rawKeyDown，keyDown 触发不了浏览器级快捷键。
  async #pressKey(conn, vk, code, key) {
    const ev = {
      modifiers: 2, // Ctrl
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      code,
      key,
    };
    await conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
    await sleep(120);
  }

  async #dpr(conn) {
    const { result } = await conn.send('Runtime.evaluate', {
      expression: 'devicePixelRatio',
      returnByValue: true,
    });
    return result.value;
  }

  // dpr = 系统显示缩放 × 浏览器缩放，除以 100% 时的 dpr 就还原出当前档位。
  // 这样读的是真实状态，用户手动按过 Ctrl+加号也能正确识别，不依赖本地缓存。
  async #currentIdx(conn) {
    if (this.baseDpr === null) {
      // Ctrl+0 归零后读到的才是基准。只在首次（或控制端重启后）付这一次代价
      await this.#pressKey(conn, 48, 'Digit0', '0');
      this.baseDpr = await this.#dpr(conn);
    }
    const raw = (await this.#dpr(conn)) / this.baseDpr;
    let best = 0;
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      if (Math.abs(ZOOM_STEPS[i] - raw) < Math.abs(ZOOM_STEPS[best] - raw)) best = i;
    }
    return best;
  }

  async #stepTo(conn, targetIdx) {
    await conn.send('Page.bringToFront'); // 快捷键要求页面有焦点
    let i = await this.#currentIdx(conn);
    const dir = targetIdx > i ? 1 : -1;
    const key = dir > 0
      ? { vk: 187, code: 'Equal', key: '+' }  // VK_OEM_PLUS
      : { vk: 189, code: 'Minus', key: '-' }; // VK_OEM_MINUS
    for (; i !== targetIdx; i += dir) {
      await this.#pressKey(conn, key.vk, key.code, key.key);
    }
  }

  async setZoom(zoom) {
    const targetIdx = ZOOM_STEPS.indexOf(zoom);
    if (targetIdx < 0) throw new Error(`不支持的缩放档位: ${zoom}`);
    const conn = await this.#pageConn();
    await this.#stepTo(conn, targetIdx);
    this.zoom = zoom;
    return { zoom };
  }

  async screenshot() {
    const conn = await this.#pageConn();
    const res = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    return res.data;
  }

  // 强制大屏显示：激活标签页 + 窗口全屏。用窗口级全屏而非 JS requestFullscreen，
  // 因为后者一导航就掉出全屏，而我们的工作流就是不断导航。
  async show(fullscreen = true) {
    const target = await this.#pickTarget();
    const page = await this.#pageConn();
    await page.send('Page.bringToFront');

    const conn = await this.#browserConn();
    const { windowId } = await conn.send('Browser.getWindowForTarget', { targetId: target.id });
    await conn.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: fullscreen ? 'fullscreen' : 'normal' },
    });
    return { windowId, fullscreen };
  }

  async heapUsed() {
    const conn = await this.#pageConn();
    const { usedSize } = await conn.send('Runtime.getHeapUsage');
    return usedSize;
  }

  // 优雅关闭整个浏览器。走 CDP 让 Chrome 自己走正常退出流程，
  // profile 才会被标成「正常退出」，下次启动就不弹「恢复页面」。
  // 强杀（taskkill）做不到这点，所以控制台的「关闭/重启」优先用这里。
  async closeBrowser() {
    const conn = await this.#browserConn();
    conn.sendNoReply('Browser.close');
  }

  // 重载而不是重启浏览器：重启后 CDP 端点就没了，控制端再也拉不起来它，
  // 必须在大屏机上另装看门狗才行。重载不动窗口，全屏和缩放都保住（实测过）。
  // ignoreCache 走强制刷新（等同 Shift+F5），代价是资源全部重新下载，加载更慢。
  async reload() {
    const conn = await this.#pageConn();
    await conn.send('Page.enable');
    const loaded = conn.once('Page.loadEventFired', this.timeout);
    await conn.send('Page.reload', { ignoreCache: true });
    await loaded;
    await sleep(this.settleMs);
  }

  async status() {
    const pages = await this.pages();
    const cur = pages.find((p) => p.id === this.targetId) ?? pages[0] ?? null;

    let fullscreen = null;
    try {
      const conn = await this.#browserConn();
      const { bounds } = await conn.send('Browser.getWindowForTarget', { targetId: cur?.id });
      fullscreen = bounds?.windowState === 'fullscreen';
    } catch { /* 拿不到全屏状态不影响主要信息 */ }

    return {
      targetId: cur?.id ?? null,
      url: cur?.url ?? null,
      title: cur?.title ?? null,
      pageCount: pages.length,
      fullscreen,
      zoom: this.zoom,
    };
  }

  close() {
    this.page?.close();
    this.browser?.close();
    this.page = this.browser = null;
  }
}

module.exports = { BigScreen, ZOOM_STEPS };
