'use strict';

/**
 * 大屏分时段排期调度器 (Time-Slot Schedule)
 * 
 * 核心功能：
 * 1. 规则持久化于 schedule.json（受覆盖安装保护）
 * 2. 毫秒级时间比对，跨午夜时段自适应识别
 * 3. 时段跨越点自动驱动大屏无缝切换（网页/视频/图片/待机）
 * 4. 支持手动临时插播与一键恢复排期
 */

const fs = require('fs');
const path = require('path');
const P = require('./paths');

const DEFAULT_SCHEDULE = {
  enabled: false,
  rules: [
    {
      id: 'rule_default_1',
      deviceId: 'default',
      name: '上午看板',
      timeStart: '09:00',
      timeEnd: '12:00',
      type: 'web',
      target: 'http://127.0.0.1:18089',
      enabled: true,
    },
    {
      id: 'rule_default_2',
      deviceId: 'default',
      name: '午间视频',
      timeStart: '12:00',
      timeEnd: '14:00',
      type: 'video',
      target: '',
      enabled: true,
    },
    {
      id: 'rule_default_3',
      deviceId: 'default',
      name: '下午展播',
      timeStart: '14:00',
      timeEnd: '18:00',
      type: 'image',
      target: '',
      enabled: true,
    },
  ],
};

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadSchedule() {
  const data = readJsonSafe(P.SCHEDULE_FILE);
  if (data && typeof data === 'object') {
    const rawRules = Array.isArray(data.rules) ? data.rules : [];
    return {
      enabled: !!data.enabled,
      rules: rawRules.map((r) => ({ ...r, deviceId: r.deviceId || 'default' })),
    };
  }
  // 初次启动或文件不存在时写出默认配置
  try {
    fs.writeFileSync(P.SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULE, null, 2), 'utf8');
  } catch {
    /* 忽略只读目录 */
  }
  return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
}

// 将时间段拆解为一天内的 1 个或 2 个 [startMs, endMs] 闭区间（毫秒级，支持跨午夜）
function getTimeIntervals(timeStart, timeEnd) {
  const s = parseTimeToDayMs(timeStart);
  const e = parseTimeToDayEndMs(timeEnd);
  if (s <= e) {
    return [[s, e]];
  }
  // 跨午夜：[s, 86399999] 和 [0, e]
  return [
    [s, 86399999],
    [0, e],
  ];
}

// 判断两个时间段在毫秒级闭区间上是否重叠
function isTimeOverlap(startA, endA, startB, endB) {
  if (!startA || !endA || !startB || !endB) return false;
  if (startA === endA || startB === endB) return true; // 全天时段必定与其他时段重叠

  const intervalsA = getTimeIntervals(startA, endA);
  const intervalsB = getTimeIntervals(startB, endB);

  for (const [sA, eA] of intervalsA) {
    for (const [sB, eB] of intervalsB) {
      if (Math.max(sA, sB) <= Math.min(eA, eB)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 判断两条排期规则是否属于同一个设备范围（预留多设备支持）
 * - 规则可以带有 deviceId 字段，如 'device_A', 'device_B', 'all' 等，未指定时默认为 'default'
 * - 规则带有 deviceId 时：
 *   1. 若任一规则为 'all'（代表作用于所有设备），则与任意设备均产生作用域交集
 *   2. 若两个规则的 deviceId 相同，则属于同一设备
 *   3. 若两个规则的 deviceId 不同且均不为 'all'，则属于不同设备，互不冲突，绝不拦截！
 */
function isSameDeviceScope(ruleA, ruleB) {
  const devA = (ruleA && ruleA.deviceId ? String(ruleA.deviceId).trim() : 'default');
  const devB = (ruleB && ruleB.deviceId ? String(ruleB.deviceId).trim() : 'default');
  if (devA === 'all' || devB === 'all') return true;
  return devA === devB;
}

/**
 * 检查某条规则 targetRule 是否与已有规则列表 existingRules 中的某条规则产生冲突
 * @param {Object} targetRule 待检查的新建/编辑规则
 * @param {Array} existingRules 已有规则数组
 * @returns {Object|null} 如果有冲突，返回发生冲突的那条规则对象；无冲突返回 null
 */
function findRuleConflict(targetRule, existingRules) {
  if (!targetRule || !Array.isArray(existingRules)) return null;
  if (targetRule.enabled === false) return null;

  for (const other of existingRules) {
    if (other.id && targetRule.id && other.id === targetRule.id) continue;
    if (other.enabled === false) continue;
    if (!isSameDeviceScope(targetRule, other)) continue;
    if (isTimeOverlap(targetRule.timeStart, targetRule.timeEnd, other.timeStart, other.timeEnd)) {
      return other;
    }
  }
  return null;
}

/**
 * 校验规则列表自身是否存在冲突（同一设备内启用的规则互相重叠）
 */
function validateScheduleRules(rules) {
  if (!Array.isArray(rules)) return { valid: true };
  for (let i = 0; i < rules.length; i++) {
    const r1 = rules[i];
    if (r1.enabled === false) continue;
    for (let j = i + 1; j < rules.length; j++) {
      const r2 = rules[j];
      if (r2.enabled === false) continue;
      if (!isSameDeviceScope(r1, r2)) continue;
      if (isTimeOverlap(r1.timeStart, r1.timeEnd, r2.timeStart, r2.timeEnd)) {
        const name1 = r1.name || '时段';
        const name2 = r2.name || '时段';
        return {
          valid: false,
          error: `时段冲突：【${name1} (${r1.timeStart}-${r1.timeEnd})】与【${name2} (${r2.timeStart}-${r2.timeEnd})】时间重叠`,
          ruleA: r1,
          ruleB: r2,
        };
      }
    }
  }
  return { valid: true };
}

function saveSchedule(schedule, options = {}) {
  const cleanRules = (Array.isArray(schedule.rules) ? schedule.rules : []).map((r) => ({
    ...r,
    deviceId: r.deviceId || 'default',
  }));

  // 轮播规则：规范化播放列表与切换模式
  for (const r of cleanRules) {
    if (r.type !== 'carousel') continue;
    r.items = (Array.isArray(r.items) ? r.items : [])
      .map((it) => ({
        type: it && it.type,
        target: String((it && it.target) || '').trim(),
        name: String((it && it.name) || '').trim(),
        durationSec: Math.max(CAROUSEL_MIN_SEC, Math.round(Number(it && it.durationSec) || CAROUSEL_DEFAULT_SEC)),
      }))
      .filter((it) => CAROUSEL_TYPES.includes(it.type) && it.target);
    r.switchMode = r.switchMode === 'navigate' ? 'navigate' : 'tab';
    r.target = '';
    if (!options.skipValidation && r.enabled !== false && !r.items.length) {
      return { ok: false, error: `轮播时段【${r.name || `${r.timeStart}-${r.timeEnd}`}】至少需要添加一个有效页面` };
    }
  }

  // 如果不跳过冲突校验，则检查启用的规则之间是否有冲突
  if (!options.skipValidation) {
    const check = validateScheduleRules(cleanRules);
    if (!check.valid) {
      return { ok: false, error: check.error, ruleA: check.ruleA, ruleB: check.ruleB };
    }
  }

  const clean = {
    enabled: !!schedule.enabled,
    rules: cleanRules,
  };
  fs.writeFileSync(P.SCHEDULE_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return { ok: true, schedule: clean };
}

// 计算某个时刻处于当天的绝对毫秒数: 0 ~ 86,399,999 ms
function getDayMs(date = new Date()) {
  return ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 + date.getMilliseconds();
}

// 时段字符串解析为当天的毫秒起始点（从 00 秒 000 毫秒开始）
// 例如 "14:00" -> 14:00:00.000
function parseTimeToDayMs(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const s = parts.length > 2 ? (parts[2] || 0) : 0;
  return ((h * 60 + m) * 60 + s) * 1000;
}

// 时段字符串解析为当天的毫秒结束点（包含截止时间最后一毫秒 999ms）
// 例如输入 "18:10"，包含整整 18:10 分这一分钟，直到 18:10:59.999 最后一毫秒
function parseTimeToDayEndMs(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 86399999;
  const parts = timeStr.trim().split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  if (parts.length > 2) {
    const s = parts[2] || 0;
    return ((h * 60 + m) * 60 + s) * 1000 + 999;
  }
  // 未指定秒时，默认覆盖到该分钟最后一秒最后一毫秒 59秒 999毫秒
  return ((h * 60 + m) * 60 + 59) * 1000 + 999;
}

// 检查当前时刻是否在 [startMs, endMs] 闭区间范围内，支持跨午夜（如 22:00 到 08:00）
// 起始时间为 0 秒 000 毫秒；结束时间为当前分钟的最后一毫秒 59 秒 999 毫秒
function isTimeInRangeMs(nowOrMs, startStr, endStr) {
  if (!startStr || !endStr) return false;
  if (startStr === endStr) return true; // 全天 24 小时生效

  const currentMs = typeof nowOrMs === 'number'
    ? nowOrMs
    : getDayMs(nowOrMs instanceof Date ? nowOrMs : new Date());

  const startMs = parseTimeToDayMs(startStr);       // 0秒 000毫秒起
  const endMs = parseTimeToDayEndMs(endStr);        // 59秒 999毫秒止

  if (startMs <= endMs) {
    // 正常同日时段：[startMs, endMs]，包含整个结束分钟最后一毫秒
    return currentMs >= startMs && currentMs <= endMs;
  }

  // 跨午夜时段（例如 22:00 到 08:00）：
  // [startMs, 86399999] 或 [0, endMs]
  return currentMs >= startMs || currentMs <= endMs;
}

function isTimeInRange(nowTime, start, end) {
  if (nowTime instanceof Date || typeof nowTime === 'number') {
    return isTimeInRangeMs(nowTime, start, end);
  }
  if (typeof nowTime === 'string') {
    return isTimeInRangeMs(parseTimeToDayMs(nowTime), start, end);
  }
  return isTimeInRangeMs(getDayMs(), start, end);
}

function getCurrentTimeStr() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// 获取当前命中的规则（毫秒精度匹配）
function getActiveRule(schedule, nowTimeOrDate) {
  if (!schedule || !schedule.enabled || !Array.isArray(schedule.rules)) return null;
  const nowMs = typeof nowTimeOrDate === 'number'
    ? nowTimeOrDate
    : (nowTimeOrDate instanceof Date
      ? getDayMs(nowTimeOrDate)
      : (typeof nowTimeOrDate === 'string' ? parseTimeToDayMs(nowTimeOrDate) : getDayMs()));

  for (const rule of schedule.rules) {
    if (rule.enabled !== false && isTimeInRangeMs(nowMs, rule.timeStart, rule.timeEnd)) {
      return rule;
    }
  }
  return null;
}

// 将规则转为大屏可访问的完整 URL
function resolveRuleUrl(rule, publicBase) {
  if (!rule || !rule.type) return 'about:blank';
  const target = (rule.target || '').trim();

  if (rule.type === 'standby') {
    return 'about:blank';
  }

  if (rule.type === 'web') {
    return target || 'about:blank';
  }

  if (rule.type === 'video') {
    if (!target) return 'about:blank';
    if (/^https?:\/\//i.test(target)) return target;
    return `${publicBase}/view/video/${encodeURIComponent(target)}`;
  }

  if (rule.type === 'image') {
    if (!target) return 'about:blank';
    if (/^https?:\/\//i.test(target)) return target;
    return `${publicBase}/view/image/${encodeURIComponent(target)}`;
  }

  return target || 'about:blank';
}

// 调度器状态管理
let currentActiveRuleId = null;
let isManualOverride = false; // 是否处于用户手动临时投屏打断状态
let currentCarouselKey = null; // 当前轮播位置：`${ruleId}#${index}`
let tickBusy = false;          // 切换可能耗时超过 1 秒（等页面加载），防止心跳重入
const carouselTabs = new Map(); // 标签页模式：`${ruleId}|${url}` → 常驻标签页 targetId

// ---- 轮播（carousel）----
const CAROUSEL_TYPES = ['web', 'image', 'video'];
const CAROUSEL_MIN_SEC = 5;
const CAROUSEL_DEFAULT_SEC = 300;

function getCarouselItems(rule) {
  if (!rule || rule.type !== 'carousel' || !Array.isArray(rule.items)) return [];
  return rule.items.filter((it) => it && CAROUSEL_TYPES.includes(it.type) && String(it.target || '').trim());
}

function itemDurationMs(item) {
  const sec = Math.max(CAROUSEL_MIN_SEC, Number(item.durationSec) || CAROUSEL_DEFAULT_SEC);
  return sec * 1000;
}

// 按时钟推算轮播位置：由「距时段起点的时长」直接算出当前页，
// 不依赖计数器，服务重启或 Chrome 被拉起后也能回到此刻本该显示的那一页
function getCarouselPosition(rule, now = new Date()) {
  const items = getCarouselItems(rule);
  if (!items.length) return null;
  const nowMs = typeof now === 'number' ? now : getDayMs(now);
  const startMs = parseTimeToDayMs(rule.timeStart);
  const elapsed = (nowMs - startMs + 86400000) % 86400000; // 跨午夜时段同样成立
  const durations = items.map(itemDurationMs);
  const cycle = durations.reduce((a, b) => a + b, 0);
  let t = elapsed % cycle;
  for (let i = 0; i < items.length; i++) {
    if (t < durations[i]) {
      return { index: i, item: items[i], total: items.length, remainMs: durations[i] - t };
    }
    t -= durations[i];
  }
  return { index: 0, item: items[0], total: items.length, remainMs: durations[0] };
}

// 显示轮播中的某一页
// - tab 模式：每页常驻一个标签页，切换只是提到前台，无白屏、看板数据保持实时
// - navigate 模式：同一标签页内重新加载，省内存但每次切换都要重新渲染
async function showCarouselItem(rule, pos, screen, publicBase) {
  const url = resolveRuleUrl(pos.item, publicBase);
  if (rule.switchMode === 'navigate') {
    await screen.navigate(url);
    return;
  }
  const key = `${rule.id}|${url}`;
  const tabId = carouselTabs.get(key);
  if (tabId) {
    try {
      await screen.switchTab(tabId);
      return;
    } catch {
      carouselTabs.delete(key); // 标签页被关或 Chrome 重启过，重新打开
    }
  }
  const r = await screen.openOrSwitch(url);
  if (r && r.targetId) carouselTabs.set(key, r.targetId);
}

async function executeRule(rule, screen, publicBase, now = new Date()) {
  if (!rule || !screen) return;
  try {
    if (rule.type === 'carousel') {
      const pos = getCarouselPosition(rule, now);
      if (!pos) {
        currentCarouselKey = null;
        await screen.navigate('about:blank');
        return;
      }
      // 先记位置再切：切换失败时不会每秒重试刷屏，等下一页到点再切
      currentCarouselKey = `${rule.id}#${pos.index}`;
      await showCarouselItem(rule, pos, screen, publicBase);
      console.log(`[排期调度] 轮播 ${rule.timeStart}-${rule.timeEnd} 第 ${pos.index + 1}/${pos.total} 页: ${pos.item.name || pos.item.target}`);
      return;
    }

    const url = resolveRuleUrl(rule, publicBase);
    if (rule.type === 'web' && url !== 'about:blank') {
      await screen.openOrSwitch(url);
    } else {
      await screen.navigate(url);
    }
    console.log(`[排期调度] 已切换至时段: ${rule.timeStart}-${rule.timeEnd} (${rule.name || rule.type})`);
  } catch (err) {
    console.warn(`[排期调度] 切换失败: ${err.message}`);
  }
}

// 供定时心跳调用的单次检查
async function checkScheduleTick(screen, publicBase, chromeOnline) {
  if (!chromeOnline || tickBusy) return;
  tickBusy = true;
  try {
    const schedule = loadSchedule();
    if (!schedule.enabled) {
      currentActiveRuleId = null;
      currentCarouselKey = null;
      return;
    }

    const now = new Date();
    const matchedRule = getActiveRule(schedule, now);

    // 如果没有匹配到任何时段
    if (!matchedRule) {
      currentActiveRuleId = null;
      currentCarouselKey = null;
      return;
    }

    // 如果命中规则发生了变化（即跨过了时段边界，毫秒级无缝衔接）
    if (matchedRule.id !== currentActiveRuleId) {
      currentActiveRuleId = matchedRule.id;
      currentCarouselKey = null;
      isManualOverride = false;
      await executeRule(matchedRule, screen, publicBase, now);
      return;
    }

    // 同一时段内：轮播到点切到下一页（手动插播期间暂停，点「恢复排期」后继续）
    if (matchedRule.type === 'carousel' && !isManualOverride) {
      const pos = getCarouselPosition(matchedRule, now);
      const key = pos ? `${matchedRule.id}#${pos.index}` : null;
      if (key && key !== currentCarouselKey) {
        await executeRule(matchedRule, screen, publicBase, now);
      }
    }
  } finally {
    tickBusy = false;
  }
}

// 用户手动插播投屏时，通知调度器记录
function markManualOverride() {
  isManualOverride = true;
}

// 用户在控制台点击“立即恢复排期”
async function resumeSchedule(screen, publicBase) {
  const schedule = loadSchedule();
  if (!schedule.enabled) {
    schedule.enabled = true;
    saveSchedule(schedule, { skipValidation: true });
  }
  isManualOverride = false;
  const now = new Date();
  const matchedRule = getActiveRule(schedule, now);
  if (matchedRule) {
    currentActiveRuleId = matchedRule.id;
    await executeRule(matchedRule, screen, publicBase);
    return { ok: true, resumed: true, rule: matchedRule };
  }
  return { ok: true, resumed: false, message: '当前时刻无匹配的排期时段' };
}

// 立即测试单条规则
async function testRule(rule, screen, publicBase) {
  markManualOverride();
  await executeRule(rule, screen, publicBase);
  return { ok: true };
}

function getStatus() {
  const schedule = loadSchedule();
  const now = new Date();
  const activeRule = getActiveRule(schedule, now);
  const pos = activeRule && activeRule.type === 'carousel' ? getCarouselPosition(activeRule, now) : null;
  return {
    enabled: schedule.enabled,
    rules: schedule.rules,
    nowTime: getCurrentTimeStr(),
    activeRuleId: activeRule ? activeRule.id : null,
    isManualOverride,
    carousel: pos
      ? {
          index: pos.index,
          total: pos.total,
          name: pos.item.name || pos.item.target,
          remainSec: Math.ceil(pos.remainMs / 1000),
        }
      : null,
  };
}

// 切换排期总开关（开启时立即生效匹配时段，关闭时立刻暂停调度）
async function toggleSchedule(enabled, screen, publicBase) {
  const schedule = loadSchedule();
  schedule.enabled = enabled !== undefined ? !!enabled : !schedule.enabled;
  saveSchedule(schedule, { skipValidation: true });
  isManualOverride = false;

  if (schedule.enabled && screen) {
    const now = new Date();
    const matchedRule = getActiveRule(schedule, now);
    if (matchedRule) {
      currentActiveRuleId = matchedRule.id;
      await executeRule(matchedRule, screen, publicBase);
    } else {
      currentActiveRuleId = null;
    }
  } else {
    currentActiveRuleId = null;
  }

  return getStatus();
}

module.exports = {
  loadSchedule,
  saveSchedule,
  getActiveRule,
  resolveRuleUrl,
  checkScheduleTick,
  markManualOverride,
  resumeSchedule,
  testRule,
  getStatus,
  toggleSchedule,
  isTimeInRange,
  isTimeInRangeMs,
  getDayMs,
  parseTimeToDayMs,
  parseTimeToDayEndMs,
  getTimeIntervals,
  isTimeOverlap,
  isSameDeviceScope,
  findRuleConflict,
  validateScheduleRules,
  getCarouselPosition,
};
