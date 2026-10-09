<div align="center">

# 📺 CastFlow

**专为展厅、企业看板、商场大屏打造的轻量级局域网投屏与无人值守守护系统**

*Lightweight Big-Screen Kiosk & Digital Signage Controller powered by Chrome DevTools Protocol (CDP)*

<p align="center">
  <a href="https://github.com/caoyek/castflow/actions/workflows/build.yml"><img src="https://github.com/caoyek/castflow/actions/workflows/build.yml/badge.svg" alt="Build Status"></a>
  <a href="https://github.com/caoyek/castflow/releases"><img src="https://img.shields.io/github/v/release/caoyek/castflow?style=for-the-badge&color=orange" alt="Release"></a>
  <a href="https://github.com/caoyek/castflow/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18.0-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://www.google.com/chrome/"><img src="https://img.shields.io/badge/Chrome-CDP%20Ready-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome CDP"></a>
  <a href="https://github.com/caoyek/castflow"><img src="https://img.shields.io/badge/Platform-Windows%20x64-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Platform"></a>
</p>

[核心特性](#-核心特性) • [解决痛点](#-解决痛点) • [快速开始](#-快速开始) • [打包构建](#-打包构建) • [配置说明](#-配置说明)

</div>

---

## 💡 解决痛点

在企业大屏与展厅看板日常运维中，传统方案常常面临以下挑战：

| 常见问题 | 传统表现 | 🚀 CastFlow 应对方案 |
| :--- | :--- | :--- |
| **长期运行内存泄露** | BI 看板或动效运行数天后崩溃白屏 | **内存看门狗**：巡检 V8 JS 堆内存，超阈值平滑自动重载 |
| **浏览器意外关闭** | Windows 升级或误触关闭，屏幕陷入桌面 | **自动拉起守护**：秒级探测 Chrome 存活，异常退出自动恢复展示 |
| **异常恢复弹窗** | 强制关机或杀进程后，重启必弹“是否恢复”气泡 | **优雅退出机制**：通过 CDP 安全退出，并注入防恢复启动参数 |
| **系统弹窗遮挡** | 杀毒软件或系统更新弹窗抢占前台焦点 | **硬件级置顶**：Win32 API `SetWindowPos` 强制锁定最顶层 |
| **远程盲投无反馈** | 远程推送后无法确认大屏实际显示效果 | **实时画面回传**：Web 控制台监看大屏渲染画面并支持截图 |
| **依赖繁杂体积庞大** | 依赖动辄数百兆 Puppeteer 或 Electron | **超轻量自研**：生产环境仅 1 个依赖（`ws`），单 EXE 绿色打包 |

---

## ✨ 核心特性

- 📱 **暗黑 Web 控制台**：单页 SPA 响应式设计，局域网内任意手机、电脑浏览器直接远程管理。
- 🖥️ **画面回传与监看**：实时预览大屏渲染画面，支持一键截图、平滑刷新、页面缩放（50%~500%）与全屏控制。
- 🕒 **高精度分时段排期**：支持 24 小时分时段播放（网页看板 / 视频 / 图片 / 黑屏待机），具备时间冲突智能拦截、多设备隔离预留与跨时段毫秒级无缝衔接。
- 🔄 **定时轮播**：同一时段内多个页面按设定时长循环切换（如每 5 分钟换一个看板），支持标签页常驻无白屏切换，重启后自动回到当前应播页。
- 🎬 **多媒体内容库**：支持多类型看板推送、拖拽上传图片轮播，以及支持 HTTP 206 断点续传的大码率视频流畅播放。
- 🛡️ **工业级看门狗守护**：
  - **内存监控**：堆内存超限自动重载，避免页面卡死；
  - **崩溃自愈**：浏览器异常退出后 30 秒内自动拉回原网址并全屏；
  - **定时维护**：支持设定每日闲时（如凌晨 04:00）自动重启浏览器彻底释放显存。
- 🔒 **Win32 窗口置顶**：硬件级前台锁定，彻底屏蔽弹窗与通知干扰。
- 🛠️ **原生桌面管理工具**：内置科技暗黑风格 `CastFlowManager.exe`，托盘常驻守护，开机自启、服务启停一键搞定。

---

## 🚀 快速开始

### 方式一：安装包 / 绿色便携版（推荐）

1. 从 [Releases](https://github.com/caoyek/castflow/releases) 页面下载最新安装程序 `CastFlow-Setup-x.x.x.exe` 或便携压缩包。
2. 安装后程序会自动启动大屏，并自动配置好防火墙与防休眠策略。
3. 打开浏览器即可远程管理：
   - **本机**：`http://127.0.0.1:18089`
   - **局域网**：`http://<大屏IP>:18089`（控制台右上角显示当前局域网地址）

### 方式二：从源码启动

运行环境：**Google Chrome** 与 **Node.js (>= 18)**。

```bash
# 1. 克隆代码
git clone https://github.com/caoyek/castflow.git
cd castflow

# 2. 安装依赖
npm install

# 3. 启动服务（默认端口 18089）
npm start

# 或以开机自启全屏模式运行
npm run autostart
```

### 方式三：桌面管理面板 (GUI)

运行根目录下 `CastFlowManager.exe` 即可使用桌面管理面板（支持最小化至任务栏托盘）：
- 服务状态实时显示与一键启停 / 重启；
- 设置开机启动默认页；
- 一键开关开机自启、定时关机与日志查看。

---

## 📦 打包构建

### 1. 本地打包

```powershell
# 打包 Node 22 运行时至 dist/CastFlow/ 绿色便携目录
powershell -ExecutionPolicy Bypass -File build.ps1

# 编译 Inno Setup 安装包（需安装 Inno Setup 6）
iscc installer.iss
```

### 2. GitHub Actions 云端自动构建

无需本地配置编译环境：
- **手动触发**：在 GitHub 仓库 **Actions** -> **Build Windows Installer** 点击 **Run workflow**，自动编译并生成安装包与便携包 Artifacts；
- **版本发布**：推送 Git Tag（如 `v1.0.3`），云端自动编译并发布 GitHub Release。

---

## ⚙️ 配置说明

### `config.json`（核心服务配置）

```json
{
  "target": "127.0.0.1:9222",
  "port": 18089,
  "publicBase": "auto",
  "settleMs": 1500,
  "memoryLimitMb": 400,
  "memoryCheckSec": 60,
  "chromeProfile": "chrome-profile",
  "chromeExtraArgs": ["--start-fullscreen"],
  "startUrl": "about:blank"
}
```

| 字段 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `target` | Chrome CDP 通信地址与端口 | `127.0.0.1:9222` |
| `port` | 控制台 HTTP 监听端口 | `18089` |
| `publicBase` | 对外访问基础 URL，`auto` 自动识别物理网卡 IP | `auto` |
| `settleMs` | 页面切换渲染稳定等待延时（毫秒） | `1500` |
| `memoryLimitMb`| JS 堆内存超限阈值（MB） | `400` |
| `memoryCheckSec`| 看门狗巡检周期（秒） | `60` |
| `chromeProfile`| 独立浏览器数据目录，与系统 Chrome 数据彻底隔离 | `chrome-profile` |
| `startUrl` | 首次启动默认打开的初始网址 | `about:blank` |

### `settings.json`（大屏运行参数）

支持在 Web 控制台「设置」中直接修改并即时生效：
- `deviceName`：大屏终端名称；
- `autoRestart` / `restartTime`：闲时定时重启维护；
- `memoryWatchdog` / `memoryLimitMb`：内存看门狗开关及限额；
- `autoRestore`：异常退出自动拉起与状态恢复；
- `autoRefresh` / `refreshInterval`：页面定时静默刷新。

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 协议开源，允许免费商用与二次开发。欢迎提交 Issue 与 PR 交流！
