# 最新验证存档（T27 · 2026-10-28 · 0.3.1）

- 产物：`app.asar` **845,690 B** sha256 `21BB3860959FBFC6FCEBDC302D54E7A5E60F38C666F951B503A2B1D57D59EF32`；`Setup.exe` **296,080,384 B** sha256 `D06A477A8303E29DFA108FEB119B5D57512AB6F5BD5248A3F004B5166EA4CC0B`（桌面安装包一致）。
- 实机：`/api/status` `version=0.3.1, mcpUp=true`；`/api/tunnel-check` **ok=true**（`mode=cloudflare`，本机 MCP / Cloudflare 进程 / 公网入口回源 / 公网 MCP 握手四项全过，HTTP 200 + session id）。
- 回归：p11–p16 六套全绿（p13 `total=13 failed=0`；p16 13 项）。
- 启动期：应用重启后 Cloudflare 约 15–20 秒就绪；新面板实机（无头 Edge）0–6s「待检测」、9s「启动中」、15s 自动变「正常」，四项全过，无需点击「重新检测」。
- 公网入口：当前为 Cloudflare 快速隧道（临时地址，每次重启会变，见面板「公网入口」）；本机到 `<your-server-ip>` 的 TCP 被目标 IP 级拦截（ICMP 正常）。
- 证据目录：`docs\runs\T27-2026-10-28\`（network / tests / tunnel-check / hashes）。

---

# P9 verify.ps1 结果存档（历史）

- 时间：2026-10-26 03:18:45
- 产物：v2\dist-portable\（exe=六本豆mcp-v2.exe，resources\app.asar 由 v2\src 打包，380157 字节（P12 重打包））
- 运行时来源：0.1.0 便携版目录（只读复制；本次核验其未被改动）
- 测试实例：dist-portable\六本豆mcp-v2.exe（验证后已停止并恢复 0.1.0）

## verify.ps1 五项检查输出

```
=== 1. 端口 ===
  [PASS] 端口 8765 在监听
  [PASS] 端口 8766 在监听
=== 2. 应用状态 ===
  [PASS] /api/status 可访问
       version=0.1.0
=== 3. 公网隧道 ===
  [PASS] /api/tunnel-check 全部 ok
       隧道进程: ssh.exe 反向隧道正在运行（进程号 41108，-R 8765 → http://leenzhuanjieben.shop）
       服务器入口: 自建服务器入口已响应 HTTP 404（根路径返回 404 属正常）
       公网 MCP: 公网 MCP 握手成功（HTTP 200，会话 140868b9…）
=== 4. MCP 端点 ===
       HTTP 200, session=cbfabe49-2f10-4058-b28c-289a0c0984e2
  [PASS] 本地 MCP initialize 200
=== 5. SSH 反向隧道 ===
  [PASS] 存在 -R 8765 的 ssh 进程

结果: 6 通过 / 0 失败
```

verify 退出码：0（全过）

## 0.1.0 便携版目录未改动核验

- 文件数：95 -> 95
- 名称/大小/修改时间全量比对：**完全一致（未被改动）**

## 说明

- 打包/验证前已 Stop-Process 关闭应用（窗口 × 只会缩托盘）。
- 附基线明细 p9-baseline-before.txt / p9-baseline-after.txt（同目录）。
