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

// 检查某个 HH:mm 是否在 [start, end) 范围内，支持跨午夜（如 22:00 到 08:00）
function isTimeInRange(nowTime, start, end) {
  if (!start || !end) return false;
  if (start === end) return true; // 全天
  if (start < end) {
    return nowTime >= start && nowTime < end;
  }
  // 跨午夜
  return nowTime >= start || nowTime < end;
}

function getCurrentTimeStr() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// 获取当前命中的规则
function getActiveRule(schedule, nowTime) {
  if (!schedule || !schedule.enabled || !Array.isArray(schedule.rules)) return null;
  const time = nowTime || getCurrentTimeStr();
  for (const rule of schedule.rules) {
    if (rule.enabled !== false && isTimeInRange(time, rule.timeStart, rule.timeEnd)) {
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
    return `${publicBase}/media/${encodeURIComponent(target)}`;
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

  const nowTime = getCurrentTimeStr();
  const matchedRule = getActiveRule(schedule, nowTime);

  // 如果没有匹配到任何时段
  if (!matchedRule) {
    currentActiveRuleId = null;
    return;
  }

  // 如果命中规则发生了变化（即跨过了时段边界）
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
  const nowTime = getCurrentTimeStr();
  const matchedRule = getActiveRule(schedule, nowTime);
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
  const nowTime = getCurrentTimeStr();
  const activeRule = getActiveRule(schedule, nowTime);
  return {
    enabled: schedule.enabled,
    rules: schedule.rules,
    nowTime,
    activeRuleId: activeRule ? activeRule.id : null,
    isManualOverride,
  };
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
};
