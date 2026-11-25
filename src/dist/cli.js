"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// 无界面入口：用于在没有 Electron 的环境（如调试、服务器）中单独运行核心服务
const app_1 = require("./core/app");
const config_1 = require("./core/config");
const core = (0, app_1.createCore)({ dataDir: (0, config_1.defaultDataDir)() });
core
    .start()
    .then(() => {
    const c = core.config.get();
    console.log(`MCP 地址：http://127.0.0.1:${c.port}/mcp/${c.token}`);
    console.log(`控制面板：http://127.0.0.1:${c.panelPort}/`);
})
    .catch((e) => {
    console.error(e);
    process.exit(1);
});
process.on('SIGINT', () => {
    void core.stop().finally(() => process.exit(0));
});
