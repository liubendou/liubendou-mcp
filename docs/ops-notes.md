# 远程运维规矩（ops-notes.md）

> 目的：让后续 AI/人工远程维护这台机器时不再踩 2026-10-25 那批坑、不再白等。适用范围：通过 MCP 端点远程操作本机。

## 一、已踩的坑 → 规矩（根治办法）

| # | 坑 | 现象 | 规矩 |
|---|---|---|---|
| 1 | .ps1 无 BOM 的 UTF-8 被 PowerShell 5.1 按 GBK 读 | 中文注释/字符串把引号解析搞崩，脚本秒死、无任何输出 | 写完 .ps1 **立刻转 UTF-8 带 BOM**；或脚本内全 ASCII，中文只放外部 .txt 由脚本读取 |
| 2 | run_command 内联中文 | 乱码→ParseError「意外的标记」 | 命令文本**纯 ASCII**；中文内容用 write_file 推文件，再用 ASCII 命令处理 |
| 3 | Start-Process 后台任务 | 下条命令一执行任务就被杀，静默失败 | 跨命令的长任务用 **schtasks 计划任务**（/run 触发）；短任务用新版 `job_start`/`job_poll` |
| 4 | 长轮询盯结果 | 用户等急、超时杀进程丢缓冲输出 | 单次短探测 + 进度文件（写 C:\Users\Administrator\xxx-progress.txt）；`python3 -u` 防缓冲；需要等就用 job_poll |
| 5 | MCP 会话闲置 404 | 调用报 404/无响应 | 会话缓存 sid，失败先 initialize 重连再重试一次 |
| 6 | 看板租约锁死在失效 agent | task_complete 拒绝「由 X 负责」 | 换手先 `agent_register` → 认领；锁住则 `task_block` 说明原因触发放行，再 claim |
| 7 | apply_patch 版本号过期 | STALE_FILE | 改前**当场 read_file 拿最新版本号**，不用记忆里的旧号 |
| 8 | 输出里带敏感串 | token/会话号可能进日志 | 截断输出；任何 URL/token/会话号不出现在报告与文档里（v2 已内置 run_command 输出自动脱敏） |
| 9 | 现场文件乱放 | 临时文件散落桌面/根目录，证据找不到 | 三条铁律：临时进 `ops-tmp`、证据进 `docs\runs\<taskid>-<日期>`、收工清场；用 `tools\runlog.ps1` 管理 |

## 二、传输/响应优化（减少“感觉慢”）

1. **合并命令**：一次 run_command 里用 `;` 串多条 PowerShell，别一条一来回。
2. **短探测**：查状态用单次 read_file/小命令，禁止多分钟 sleep 轮询。
3. **本机做重活**：打包、复制、asar 都在本机执行，不经过网络传输。
4. **隧道保活（建议在 ssh 客户端侧配置）**：`ServerAliveInterval=30`、`ExitOnForwardFailure=yes`，减少反向隧道重连造成的整段卡顿（本机 ssh -R 8765 是链路里最脆的一环）。
5. **长任务**：写好脚本 → schtasks/job_start 触发 → 进度文件回报，调用方即刻返回。

## 三、常用速查

- 停应用（窗口 × 只是缩托盘，打包/验证前必做）：`Stop-Process -Name '六本豆mcp' -Force`
- 端口自检：8765（MCP）/ 8766（本机 API）；`GET http://127.0.0.1:8766/api/status`
- 验证五项：`交接包\工具\verify.ps1`（结果参考 v2\docs\verify-p9.md）
- 打包：`v2\tools\build-v2.ps1`（目标已指向 v2\dist-portable，绝不碰 0.1.0 目录）
- 敏感规矩：token/会话号/密钥不落任何日志与文档（run_command 输出已自动脱敏，但 read_file 是故意读取，仍需自觉）。
- 现场管理：`tools\runlog.ps1`（Start/Add/Complete，自动归档 `docs\runs\<taskid>-<日期>\` 并清场 ops-tmp）。
