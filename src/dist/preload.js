"use strict";
/** 预加载脚本：把窗口控制（最小化/最大化/关闭）安全地暴露给渲染进程 */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gui', {
    isGui: true,
    minimize: () => ipcRenderer.send('gui:minimize'),
    maximize: () => ipcRenderer.send('gui:maximize'),
    close: () => ipcRenderer.send('gui:close'),
});
