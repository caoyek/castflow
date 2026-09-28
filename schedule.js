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
      name: '上午看板',
      timeStart: '09:00',
      timeEnd: '12:00',
      type: 'web',
      target: 'http://127.0.0.1:18089',
      enabled: true,
    },
    {
      id: 'rule_default_2',
      name: '午间视频',
      timeStart: '12:00',
      timeEnd: '14:00',
      type: 'video',
      target: '',
      enabled: true,
    },
    {
      id: 'rule_default_3',
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
    return {
      enabled: !!data.enabled,
      rules: Array.isArray(data.rules) ? data.rules : [],
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

function saveSchedule(schedule) {
  const clean = {
    enabled: !!schedule.enabled,
    rules: Array.isArray(schedule.rules) ? schedule.rules : [],
  };
  fs.writeFileSync(P.SCHEDULE_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

// 计算某个时刻处于当天的绝对毫秒数: 0 ~ 86,399,999 ms
function getDayMs(date = new Date()) {
  return ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 + date.getMilliseconds();
}

// 时段字符串解析为当天的毫秒起始点
// 起始时间为 0 秒 0 毫秒: (sH * 60 + sM) * 60 * 1000
function parseTimeToDayMs(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const s = parts[2] || 0;
  return ((h * 60 + m) * 60 + s) * 1000;
}

// 检查当前时刻是否在 [start, end) 范围内，支持跨午夜（如 22:00 到 08:00）
// 模式 A：起始时间为 0 秒 000 毫秒；结束时间为最后一毫秒 (endBoundaryMs - 1 毫秒)
function isTimeInRangeMs(nowOrMs, startStr, endStr) {
  if (!startStr || !endStr) return false;
  if (startStr === endStr) return true; // 全天 24 小时生效

  const currentMs = typeof nowOrMs === 'number'
    ? nowOrMs
    : getDayMs(nowOrMs instanceof Date ? nowOrMs : new Date());

  const startMs = parseTimeToDayMs(startStr);       // 0秒 0毫秒起
  const endBoundaryMs = parseTimeToDayMs(endStr);   // 结束时刻分界点

  if (startMs < endBoundaryMs) {
    // 正常同日时段：[startMs, endBoundaryMs)
    // 最后一毫秒为 endBoundaryMs - 1 ms（如 12:00:00 前的 11:59:59.999）
    return currentMs >= startMs && currentMs < endBoundaryMs;
  }

  // 跨午夜时段（例如 22:00 到 08:00）：
  // [startMs, 86400000) 或 [0, endBoundaryMs)
  return currentMs >= startMs || currentMs < endBoundaryMs;
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

async function executeRule(rule, screen, publicBase) {
  if (!rule || !screen) return;
  const url = resolveRuleUrl(rule, publicBase);
  try {
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
  if (!chromeOnline) return;
  const schedule = loadSchedule();
  if (!schedule.enabled) {
    currentActiveRuleId = null;
    return;
  }

  const now = new Date();
  const matchedRule = getActiveRule(schedule, now);

  // 如果没有匹配到任何时段
  if (!matchedRule) {
    currentActiveRuleId = null;
    return;
  }

  // 如果命中规则发生了变化（即跨过了时段边界，毫秒级无缝衔接）
  if (matchedRule.id !== currentActiveRuleId) {
    currentActiveRuleId = matchedRule.id;
    isManualOverride = false;
    await executeRule(matchedRule, screen, publicBase);
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
    saveSchedule(schedule);
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
  return {
    enabled: schedule.enabled,
    rules: schedule.rules,
    nowTime: getCurrentTimeStr(),
    activeRuleId: activeRule ? activeRule.id : null,
    isManualOverride,
  };
}

// 切换排期总开关（开启时立即生效匹配时段，关闭时立刻暂停调度）
async function toggleSchedule(enabled, screen, publicBase) {
  const schedule = loadSchedule();
  schedule.enabled = enabled !== undefined ? !!enabled : !schedule.enabled;
  saveSchedule(schedule);
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
};
