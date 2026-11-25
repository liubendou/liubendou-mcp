"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTunnelState = setTunnelState;
exports.getTunnelState = getTunnelState;
/**
 * 自管隧道的共享状态：
 * 主进程的 tunnel-manager 负责写入，app.js 的 /api/tunnel-check 负责读取。
 * 放在独立模块里，避免两个模块互相 require 造成循环依赖。
 *
 * phase 取值：
 *   idle      尚未开始
 *   starting  ssh 反向隧道已启动，正在确认公网入口
 *   ready     已拿到公网地址（url 一定有值）
 *   exited    子进程自己退出了
 *   error     启动失败
 *   disabled 设置里关闭了自动隧道
 *   stopped  随应用退出主动收掉了
 */
const state = {
    phase: 'idle',
    url: null,
    pid: null,
    owned: false,
    detail: '隧道尚未启动',
    updatedAt: Date.now(),
};
/** 合并式更新状态；返回更新后的快照 */
function setTunnelState(patch) {
    Object.assign(state, patch, { updatedAt: Date.now() });
    return { ...state };
}
/** 只读快照，调用方改不坏内部状态 */
function getTunnelState() {
    return { ...state };
}
