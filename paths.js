'use strict';

/**
 * 运行时路径解析 —— 兼容 pkg 打包和源码运行两种模式
 *
 * pkg 打包后 __dirname 指向虚拟 snapshot（/snapshot/...），不能读写。
 * 所有运行时文件（config/bookmarks/settings/media/public/topmost.ps1）
 * 必须放在 EXE 同级目录。
 *
 * 源码运行时 __dirname 就是项目根目录，行为不变。
 */

const path = require('path');
const fs = require('fs');

// pkg 打包后 process.pkg 存在；源码运行时不存在
const isPackaged = !!process.pkg;

// 运行时根目录：打包后是 EXE 所在目录，源码运行时是 __dirname
const APP_ROOT = isPackaged
  ? path.dirname(process.execPath)
  : __dirname;

const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const MEDIA_DIR = path.join(APP_ROOT, 'media');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
const BOOKMARKS_FILE = path.join(APP_ROOT, 'bookmarks.json');
const SETTINGS_FILE = path.join(APP_ROOT, 'settings.json');
const SCHEDULE_FILE = path.join(APP_ROOT, 'schedule.json');
const TOPMOST_PS = path.join(APP_ROOT, 'topmost.ps1');

module.exports = {
  isPackaged,
  APP_ROOT,
  PUBLIC_DIR,
  MEDIA_DIR,
  CONFIG_FILE,
  BOOKMARKS_FILE,
  SETTINGS_FILE,
  SCHEDULE_FILE,
  TOPMOST_PS,
};
