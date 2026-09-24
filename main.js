'use strict';

/**
 * 统一入口
 *
 * pkg 打包出来一个 exe 只能有一个入口，而这里需要跑两个不同的东西
 * （开机自启流程 / 控制服务）。用参数区分，避免打两个 exe。
 *
 *   CastFlow.exe                跑控制服务
 *   CastFlow.exe --autostart    跑自启流程（拉起 Chrome + 控制服务）
 *
 * 源码模式下等价于：
 *   node main.js
 *   node main.js --autostart
 */

if (process.argv.includes('--autostart')) require('./autostart.js');
else require('./server.js');
