# 六本豆mcp v2 · 源码交接说明（接手必读）

> **T27 更新（2026-10-28）**：产品版本 **0.3.1**；公网入口支持 SSH 失败自动切 Cloudflare 快速隧道（临时地址，面板「公网入口」可见）；六套回归 p11–p16 全绿。当前本机到自建服务器 `<your-server-ip>` 的 TCP 被目标 IP 级拦截（ICMP 正常），详见 `docs\runs\T27-2026-10-28\summary.md`。
> **T23 更新（2026-10-25）**：本目录**就是唯一工作区**了（旧的 `六本豆mcp-v2-源码\` 镜像已合并进来并删除）；
> `本地AI遥控台-0.1.0`（1.0）已卸载删除；旧的 `六本豆-lab\` / `六本豆\` / `六本豆-Setup-0.4.0.exe` 已清理（归档在 `docs\archive\六本豆-lab\`）；
> `venv-hy\` 已删（依赖清单见 `venv-hy-requirements-lock.txt`），对外分发改用桌面上的 `六本豆mcp-v2-安装包.exe`。
> 最新交接文档见 **`交接报告.md`**（本文件只讲目录结构与协议细节）。
> 写给下一个 AI：读完本文即可接手，无需翻聊天记录。配套文档随源码在 `docs\` 下。
> 状态快照：2026-10-28（T27），0.3.1 已发布，p11–p16 六套回归全绿；公网入口当前走 Cloudflare 兜底，SSH 根因待确认（见 `docs\runs\T27-2026-10-28\summary.md` 的「未验证 / 待办」）。
> 本文件夹是源码快照；**主工作区**在 `Desktop\六本豆mcp-v2\`（dist-portable 产物、venv-hy 在那边，未随源码复制）。

## 0. 一分钟现状

- 产品：六本豆mcp v2 = **0.3.1**（0.1.0 的 82 个内部工具名 0 删减，对外 `tools/list` = **69**，隐藏项按规矩不暴露）+ 本地零模型多路召回记忆 + 看板 + 协作机制（结构化验收项 / 独立复核 / sprint contract）+ 公网入口 SSH 失败自动切 Cloudflare 快速隧道。
- 产物：`Desktop\六本豆mcp-v2\dist-portable\`（`六本豆mcp-v2.exe` + `resources\app.asar`，桌面已放快捷方式）。
- 全部变更与回滚：`CHANGELOG.md`（P1–T27，每条含「改了什么/为什么/怎么回滚/验证」）。
- 记忆评估、打包验证全绿：`docs\memory-eval.md`、`docs\verify-latest.md`（p11–p16 六套回归全绿；0.3.1 实机 `/api/tunnel-check` 四项全过）。

## 1. 目录结构（本文件夹 = 源码 + 文档 + 脚本 + 测试）

| 路径 | 内容 |
| --- | --- |
| `src\dist\core\coord.js` | 协作/任务核心：plan/task/租约、`acceptance_items` 结构化验收项、`task_accept`、`task_review`（生成/评估分离）、`verify` 验收方式字段 |
| `src\dist\core\security.js` | 安全层：路径防护、危险命令 **A/B 分级**（A 类不可逆须 `confirm:"YES"` 或面板批准）、**非 ASCII 命令硬拒**、**输出脱敏** |
| `src\dist\core\tools.js` | 工具定义与调度（run_command/job_start 接防呆，输出脱敏，面板批准预授权） |
| `src\dist\core\memoryBackend.js` | 记忆后端：data.json 为事实源，HyMemory 双写，sidecar 挂→自动回退 JSON（`usedFallback:true` 不抛错） |
| `src\dist\core\hySidecar.js` | Hy-Memory Python sidecar 生命周期管理 |
| `src\dist\panel\index.html` | 控制面板：看板（当前任务+三态行+折叠「详情」+验收项 ✓/✗+复核状态），零外链 |
| `tools\` | `build-v2.ps1` 打包、`p9dance.ps1` 验证独舞、`hy-sidecar.ps1`、`migrate-memory.js`/`export-memory.js`、`eval-live.js`、`mock-embed-server.js`、`runlog.ps1` 现场管理 |
| `tests\` | `p11_coord_acceptance_test.js`（验收项/复核）、`p12_security_contract_test.js`（防呆/脱敏/verify 字段）——单测全绿是底线 |
| `docs\` | `plan.md` 总计划、`tool-parity.md` 82 工具对照、`memory-eval.md` 评估、`verify-p9.md` 验证存档、`ai-protocol.md` **作业协议**、`ops-notes.md` **运维规矩**、`proposal-v3-coordination.md` v3 提案（P1/P2/P4/P3/P5a 已实施）、`runs\` 证据归档 |

`hy-memory.env` 是环境配置模板（无真实密钥）。**密钥/token 永远不进聊天、日志、交接文档**。

## 2. 快速上手（照抄四步）

0. **先读** `docs\ai-protocol.md` 与 `docs\ops-notes.md`——不读必踩坑（乱码/后台任务被杀/长轮询/租约锁死都是踩过的）。
1. 单测：`node tests\p11_coord_acceptance_test.js`、`node tests\p12_security_contract_test.js`（必须双 ALL-PASS）。
2. 打包：`npx @electron/asar@3 pack src dist-portable\resources\app.asar`（或 `tools\build-v2.ps1`）。
3. 验证：以计划任务跑 `tools\p9dance.ps1`（verify 六项 + 0.1.0 目录基线比对，输出存档 `docs\verify-p9.md`）。
4. 记录：`CHANGELOG.md` 追加条目（四要素），证据归档 `docs\runs\<taskid>-<日期>\`（用 `tools\runlog.ps1`）。

## 3. 架构速览

- Electron 便携版；核心全部在 `src\dist\core\*.js`（CommonJS；`node --check` 可校验；改完必须重打包 app.asar 才生效）。
- **协作模型**（coord.js，状态存 coord.json）：
  - task = `{id, title, acceptance(文字), acceptance_items[{id,text,pass,evidence,by}], verify(验收方式), steps, review{by,verdict,report,reportPath}, status(todo/doing/done/blocked), owner, leaseUntil, ...}`
  - 带 `acceptance_items` 的任务收尾三步：`task_accept` 逐项勾过（各附 ≥10 字证据）→ **另一个 agent** `task_review` 复核 pass（实现者不能自签）→ `task_complete`（机器校验，缺一不可）。
  - `verify` 字段 = 开工前谈好的「怎么验」；缺了看板标「（缺验收方式）」。
- **记忆后端**：`config.json` → `memoryBackend`: `json`（默认）/ `hymemory`；hymemory 走本地 Python sidecar（`MEMORY_MODE=lite`，hy-memory==2.0.5）；sidecar 不可用自动回退 JSON 不崩。迁移 `tools\migrate-memory.js`（自动备份），导出 `tools\export-memory.js`。
- **安全**：A 类危险命令（递归删除/格式化/reg delete/强推等）必须 `confirm:"YES"` 或面板批准；B 类（Stop-Process 等）放行但提醒"×只是缩托盘"；run_command 非 ASCII 硬拒（`allow_non_ascii:true` 逃生口）；命令输出自动脱敏（token/私钥/mcp 路径/会话 id）。

## 4. 待办（按优先级）

1. **P5③ 工具收敛**（L，分批）：82 工具重叠审计 + 别名路由（老名 0 删减），见 `docs\proposal-v3-coordination.md` P5。
2. **外部协作服务同步**：实测该服务会**直接加载 `Desktop\六本豆mcp-v2\src\dist\core\` 的代码（改动即时生效，无需部署）**——改 core 既是改产品也是改运维环境，更要守发布纪律。若将来独立部署，同步这三个文件即可。
3. **真实 embedding 端点重测**：端点接入后跑 `tools\eval-live.js`，把语义召回补进 `docs\memory-eval.md`（当前为 mock 向量基线，D1 决策：只做 lite）。
4. **pro/ultra 模式与 memory aging**：等 LLM 密钥（用户说"后续再说"）。

## 5. 硬规矩（违反 = 任务失败）

- **只读区零改动**：`Desktop\六本豆mcp-交接\`、`Desktop\本地AI遥控台-0.1.0-win-x64-便携版\`、`Desktop\六本豆\`、`Desktop\六本豆-lab\`；服务器与 SSH 私钥不碰。
- 验证/打包前 `Stop-Process -Name '六本豆mcp' -Force`（窗口 × 只是缩托盘）；结束后恢复 0.1.0 运行。
- run_command 命令文本**纯 ASCII**；中文内容用 write_file 写文件再读；`.ps1` 必须 **UTF-8 带 BOM**（否则 PowerShell 按 GBK 读会秒崩）。**注意：write_file 覆盖 .ps1 会丢 BOM——每次推完 ps1 必须重转 BOM 并做 `[scriptblock]::Create` 语法校验**（此坑已踩两次）。
- token/会话号/密钥零输出（工具已脱敏，但 read_file 是故意读取，仍需自觉）。
- 现场三铁律：临时文件进 `ops-tmp`、证据进 `docs\runs\`、收工清场（`tools\runlog.ps1`）。
- 每处变更进 CHANGELOG（四要素）；**完成以验收项为准，不以自称准**。

## 6. 看板协作（多 AI 并行时）

`agent_register` 拿 agent_id → `task_status` 自动认领（租约 15 分钟）→ `task_progress` 汇报 → 收尾 `task_complete`（附证据）。换手/被打断先落进度文件再交接；租约被失效 agent 锁死时用 `task_block` 说明原因触发放行。

## 7. 用户偏好

简洁直接、少问多做、只在不可逆操作前暂停；**讨厌长轮询**（用短探测/进度文件/job_poll，别跑多分钟 sleep 循环）；报告用中文；未验证项显式标注；不要重复要确认。
