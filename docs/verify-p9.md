# P9 verify.ps1 结果存档（docs/verify-p9.md）

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
