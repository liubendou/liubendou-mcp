# 六本豆mcp v2 · 分步计划（plan.md）

> 状态：**等待用户确认后才开始改代码**。本文件随每一步更新状态（`[ ]` 待办 / `[~]` 进行中 / `[x]` 完成 / `[!]` 阻塞）。
> 更新时间：2026-10-25。任务来源：v2 开发任务书（记忆系统替换为腾讯混元 Hy-Memory 2.0）。

---

## 0. 结论摘要（先看这段）

- 资料已读完：交接包 README、docs/01/02/03/05/06/07、源码 `dist/core/tools.js`（63 个工具定义 + 8 个隐藏别名）、`store.js`、`config.js`、`工具/build.ps1`、`工具/verify.ps1`，以及 Hy-Memory 官方 GitHub / 官网 / PyPI。
- 现状要点：
  - 记忆存储在 `%APPDATA%\LocalAIConsole\data.json`（`store.js` 的 `{todos, nextId, memory, plan}`）；本次侦察时 **data.json 尚未生成**（memory 为空，首次写入才会落盘）。config.json 在 `%APPDATA%\LocalAIConsole\config.json`（注意：任务书写的 `%APPDATA%\六本豆mcp\config.json` 与实际不符，`六本豆mcp` 目录是 Electron 的缓存目录，真正的配置/数据在 `LocalAIConsole` 目录）。
  - 记忆现有工具：`memory_get` / `memory_set` / `memory_delete`（+ 隐藏别名 `memory_context`、`memory_checkpoint`），全部走 `store.getMemory/setMemory/deleteMemory`，是键值对模型。
  - 环境：Windows 10，Python 3.12.10、Node v24.22.0 已装；`hy-memory` **未安装**。
  - Hy-Memory：PyPI 最新版 **2.0.5**（任务书说各来源版本号不一致，安装前以 PyPI 为准；官方 README 示例写 2.0.4，PyPI 页面显示 2.0.5，**计划锁定安装时 `pip install hy-memory==2.0.5` 并在 memory-eval.md 记录实测版本**）。SDK 入口 `HyMemoryClient`，需 LLM + Embedding 两组 OpenAI 兼容接口（`MEMORY_LLM_*` / `MEMORY_EMBEDDER_*` 环境变量）。
- 总体策略：**v2 = 0.1.0 全量功能 + 记忆后端适配层（默认 JSON，可切 Hy-Memory）+ 看板简化**。Hy-Memory 在 Windows 装不上或跑不起来就停止替换、保留 JSON 后端，写明原因，不硬改 SDK。

---

## 1. 分步计划

### P1 · 建 v2 工程骨架 `[ ]`
- 从 `交接\源码\` 完整复制到 `Desktop\六本豆mcp-v2\src\`（只读参考不动）。
- 建 `CHANGELOG.md`、`docs\` 目录。
- 验收：复制后 `node --check` 通过（tools/app/main/coord 等），CHANGELOG 首条记录本次复制。

### P2 · 工具对照表 `docs\tool-parity.md` `[ ]`
- 从 `dist\core\tools.js` 提取全部工具名（含 8 个隐藏别名），写成对照表：工具名 / 参数 / 返回结构 / v2 状态（保留-不变、保留-记忆换后端、说明）。
- 现有 63 个工具 + 8 别名（清单见 §4）逐项核对，缺的必须写原因。
- 验收：对照表覆盖 100%，每个工具有状态标注。

### P3 · 记忆后端适配层（不动行为） `[ ]`
- 新建 `dist/core/memoryBackend.js`：接口 `get(key?) / set(key,value) / delete(key) / list() / search(query) / exportAll() / importAll(data)`。
- `JsonMemoryBackend`：包装现有 `store.getMemory/setMemory/deleteMemory`，行为完全一致（含 `updatedAt` 字段格式）。
- `memory_get/set/delete` 三个工具改走适配层；配置开关 `memoryBackend: 'json' | 'hymemory'`（`config.js` 白名单追加，默认 `json`，已有 config.json 不被覆盖，新字段缺失时按 json 处理）。
- 验收：默认 json 下，`memory_get/set/delete` 的返回格式与 0.1.0 逐字节一致（用同一组键值做前后对照）。

### P4 · Hy-Memory 可行性 spike（先于正式开发） `[ ]`
- 在 Windows 上 `pip install hy-memory==2.0.5`（装在独立 venv：`%APPDATA%\LocalAIConsole\hy-venv\`，不污染系统 Python）。
- 写最小脚本：`HyMemoryClient(mode="lite")` add + search 冒烟（lite 模式零 LLM 开销，只要 Embedding；若 Embedding 也不可用则退化验证安装与 import）。
- **若安装/运行失败：停止 P5–P7 的替换工作，保留 JSON 后端，在 `memory-eval.md` 写明失败原因，不修改 SDK 源码。**
- 验收：记录安装日志、实测版本号、冒烟输出。

### P5 · Python sidecar + HyMemoryBackend `[ ]`（依赖 P4 成功）
- `sidecar/hy_memory_sidecar.py`：只监听 127.0.0.1，端口由 Node 启动时指定（随机端口），HTTP JSON 通信（POST /memory/*）。
- Node 侧 `dist/core/hySidecar.js`：spawn Python、健康检查、超时（默认 15s）、崩溃自动重启（指数退避，最多 5 次/分钟）、退出时收尸。
- `HyMemoryBackend` 实现适配层接口，转发 sidecar；sidecar 不可用/超时/断网 → 自动回退 `JsonMemoryBackend` 并在返回中标注 `[fallback: json]`，不崩溃。
- LLM/Embedding 用环境变量 `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` / `MEMORY_EMBEDDER_*`；密钥只存本机配置/环境，**不进代码、不进日志**。
- 验收：切换开关两种后端都能读写；杀掉 Python 进程后自动回退且 MCP 不崩。

### P6 · 数据迁移脚本 `[ ]`
- `工具\migrate-memory.ps1`（或 .py）：`data.json` 的 `memory` → Hy-Memory 写入（逐条带 key 元数据）；原 `data.json` **保留不删**，另存 `data.json.bak-<时间戳>`。
- 反向导出：`export-memory.ps1` 把 Hy-Memory 内容导回 JSON 结构，保证可回退到 0.1.0。
- 验收：迁移后 `memory_get` 返回的关键字段（key/value/updatedAt 语义）一致；导出后能被 JsonMemoryBackend 直接读。

### P7 · 记忆评估 `docs\memory-eval.md` `[ ]`（依赖 P5/P6）
- 用真实交接记录 ≥20 条做写入与检索测试（来源：projects 目录下的项目记录、coord.json 的交接记录、以及交接包 docs 的条目化摘录；逐条记录召回结果与耗时）。
- 断网/LLM 不可用回退测试。
- 文档包含：Windows 安装步骤、成本估算（每次写入 token 数）、隐私说明（哪些内容会发给外部模型）。
- 验收：20 条每条有召回记录 + 耗时表；回退测试通过。

### P8 · 看板简化 `[ ]`
- 只改 `panel\index.html` 看板区块（数据仍来自现有协调层 `/api/coord`，不新增接口）：
  1. 默认只显示**一个当前任务**（标题即任务名）+ 步骤行；不显示队伍/预占/事件流。
  2. 每步一行三态：✓ 已完成（灰）/ ⟳ 进行中（转圈动画）/ ○ 待办（浅色）。
  3. 唯一动画：CSS `@keyframes` 旋转圆环；无进度条/粒子/渐变。
  4. 队伍、预占、事件流、更新记录 → 「详情」按钮折叠，默认收起。
  5. 无进行中任务显示「暂无任务」。
  6. 不引用任何外部 CDN（离线可用）。
- 验收：断网打开面板显示正常；详情可展开收起；三态与协调层数据一致。

### P9 · 打包与验证 `[x]`
- 复制 `工具\build.ps1` / `verify.ps1` 到 v2 并改目标路径：产物打包到 `v2\dist-portable\`（**不覆盖**现有便携版目录）。
- **运行验证前必须 `Stop-Process -Name '六本豆mcp' -Force`**（点 × 只是缩托盘）。
- `node --check` 全部改动文件；`verify.ps1` 全过；工具对照抽测。
- 验收：verify 输出存档到 `docs\verify-<日期>.md`；便携版目录存在且旧目录未被改动（比对时间戳）。

### P10 · 文档与交接 `[x]`
- `docs\README-v2.md`：安装、回退 0.1.0、切换记忆后端、迁移数据。
- `CHANGELOG.md` 每条含：改了什么、为什么、怎么回滚。
- 最终报告（中文）：完成项/未完成项/测试结果/文件路径，未验证的明确标注。

---

## 2. 硬性约束（全程有效）

1. 只读：`Desktop\六本豆mcp-交接\`、`Desktop\本地AI遥控台-0.1.0-win-x64-便携版\`、`Desktop\六本豆\`、`Desktop\六本豆-lab\`。所有改动只发生在 `Desktop\六本豆mcp-v2\`（及 v2 自己的 `%APPDATA%` 数据、独立 venv）。
2. 服务器 `<your-server-ip>:443`（sing-box）**绝不动**；SSH 私钥 `id_ed25519_hk` 不删不改。
3. 公网 token、会话 ID、私钥内容不进日志/提示词/界面/代码/文档。
4. 每次改动写 `v2\CHANGELOG.md`（什么/为什么/怎么回滚）。
5. 验证前 `Stop-Process -Name '六本豆mcp' -Force`。
6. Hy-Memory 无法在 Windows 安装/运行 → **停止替换，保留 JSON，写原因，不改 SDK 源码**。

---

## 3. 风险清单

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| R1 | hy-memory 2.0.5 未在 Windows 验证过（ChromaDB/Kuzu 原生依赖、long path、权限） | 高 | P4 spike 先行；失败即停替换，JSON 后端兜底 |
| R2 | LLM/Embedding 接口与密钥未提供，pro 模式无法评测 | 高 | 需用户决定接口（见 §5-D1）；lite 模式可先评 Embedding 检索 |
| R3 | sidecar 进程生命周期（僵尸进程、杀软拦截 python 监听） | 中 | 只绑 127.0.0.1 随机端口；自动重启+超时；退出收尸 |
| R4 | 版本号各来源不一致（2.0.2/2.0.3/2.0.4/2.0.5） | 中 | 以 PyPI 页面为准锁 2.0.5，实测记录进 memory-eval.md |
| R5 | 现有 config.json 位于 `%APPDATA%\LocalAIConsole\`（任务书写的是 `六本豆mcp\`，不一致） | 中 | 按代码实际位置走；README-v2 写清楚；不覆盖已有配置 |
| R6 | 记忆语义差异：JSON 是纯键值对，Hy-Memory 是分层/双层记忆+向量检索 | 高 | 适配层做语义映射（key→metadata 保留），`memory_get(key)` 精确读保持兼容；`memory_get` 不带 key 的「返回全部」在 hymemory 后端用 list_memories 映射 |
| R7 | 打包脚本目标路径写死为 0.1.0 便携版 | 中 | P9 复制脚本改路径，绝不覆盖旧目录；打包前后比对旧目录时间戳 |
| R8 | 中文文件名/编码（build.ps1 需 BOM、run_command 通道中文乱码） | 中 | 脚本带 UTF-8 BOM；命令行避免中文路径字面量，用通配/对象管道 |

---

## 4. 现有工具清单基线（P2 对照表的依据）

从 `dist\core\tools.js` 提取（63 个定义 + 8 个隐藏别名）：

- **文件**：read_file, write_file, edit_file, edit_preview, apply_patch, read_files, find_files, search_content, list_dir, read_image, upload_file, download_file
- **命令**：run_command, command_output, command_cancel, job_start, job_poll, run_tests, wait_for_http, port_status, kill_port
- **待办/计划**：todo_list, todo_add, todo_update, todo_delete, set_todos, update_plan, report_progress
- **记忆**：memory_get, memory_set, memory_delete
- **Git**：git_status, git_diff, git_log, git_commit
- **代码理解**：code_definition, code_references, get_diagnostics, lsp
- **项目**：project_overview, project_context, project_checkpoint, project_note, project_memory_search
- **技能**：skill_list, skill_read, skill_save
- **网络**：web_fetch, web_search, web_download
- **桌面**：screenshot, ui_list_windows, ui_focus, ui_click, ui_type, ui_key
- **收发**：inbox_list, inbox_read, outbox_write, outbox_list
- **其他**：env_info, worktree_create, worktree_remove
- **隐藏别名（8）**：search_files→search_content, get_command_output→command_output, cancel_command→command_cancel, list_skills→skill_list, use_skill→skill_read, save_skill→skill_save, memory_context→memory_get, memory_checkpoint→memory_set
- **协调层（coord.js 注册，07 记录）**：agent_register, plan_create, task_status, task_claim, task_complete, task_block, board, reserve_files, release_files, list_reservations, session_info（11 个）

> 注意：任务书第四节提到 `project_overview`、`memory_checkpoint` 等；`memory_checkpoint` 是隐藏别名（同 memory_set），P2 表里会单独标注。工具总数口径 = 63 定义 + 8 别名 + 11 协调层 = **82 个名字**（tools/list 可见 74，隐藏 8）。

---

## 5. 需要用户决定的事项

| # | 事项 | 说明 | 默认建议 |
|---|---|---|---|
| D1 | **LLM / Embedding 接口用哪家** | Hy-Memory pro/ultra 模式要 LLM；lite 模式只要 Embedding。需要 base_url / model / api_key（只存本机） | 请提供；或先只做 lite 模式验收（纯向量检索） |
| D2 | 记忆验收的 20 条真实交接记录来源 | data.json 目前没有 memory 数据；候选：projects 下的项目记录、coord.json 交接、交接包文档摘录 | 用「交接包 docs + coord.json」条目化后当测试语料，写完可删测试数据 |
| D3 | Hy-Memory 版本锁定 | PyPI 显示 2.0.5，README 示例 2.0.4 | 锁 2.0.5（以 PyPI 为准），失败再试 2.0.4 并记录 |
| D4 | 看板「当前任务」取哪一个 | 协调层可能有多任务；默认取「进行中（claimed/in-progress）最新一个」，无则取计划第一项未完成 | 按默认 |
| D5 | v2 打包产物 exe 名 | exe 名改不了（除非重编外壳）；v2 便携版仍叫「六本豆mcp.exe」还是「六本豆mcp-v2.exe」（直接改名即可） | 建议改名 v2，避免与 0.1.0 进程混淆 |

---

## 6. 状态记录

| 步骤 | 状态 | 备注 |
|---|---|---|
| P0 资料研读 | [x] | 2026-10-25 完成：README、docs 01/02/03/05/06/07、tools.js/store.js/config.js、build.ps1/verify.ps1、Hy-Memory GitHub/官网/PyPI |
| P1 骨架 | [x] | 2026-10-25 完成：src 28 文件 + tools 11 文件从交接包复制，node --check BAD=0 |
| P2 工具对照表 | [x] | 2026-10-25 完成：docs/tool-parity.md（82 名称，全部保留，0 删除） |
| P3 适配层 | [x] | 2026-10-25 完成：memoryBackend.js + tools/app/config 接入；tests/memory-parity.test.js 17 断言 ALL PASS |
| P4 Hy spike | [x] | 2026-10-25 完成：venv-hy 安装 hy-memory==2.0.5（chromadb/kuzu Win 轮子 OK）；lite 冒烟 fail=0；server /healthz 200；详见 docs/spike-p4.md |
| P5 sidecar | [x] | 2026-10-25 完成：hy-sidecar.ps1 + hySidecar.js + HyMemoryBackend v3（keymap/success 判定）+ app 生命周期接入；测试 36 断言 ALL PASS（含真 sidecar 拉起/挂掉回退） |
| P6 迁移 | [x] | 2026-10-25 完成：migrate-memory.js + export-memory.js + keymap {id,updatedAt}；往返 12 断言 ALL PASS（关键字段一致/原件不动/可回退） |
| P7 评估 | [x] | 2026-10-25 完成：25 条真实语料；写入 25/25（p50 125ms）；检索 p50 10ms；往返逐字节一致；断连回退不崩；docs/memory-eval.md（含安装/成本/隐私） |
| P8 看板 | [x] | 2026-10-25 完成：单任务+三态（✓灰/⟳唯一动画/○浅）+折叠「详情」+暂无任务空态；零外部资源 |
| P9 打包验证 | [x] | 2026-10-25 完成：dist-portable 产物就绪（六本豆mcp-v2.exe + app.asar 366,909 B）；verify.ps1 6 通过/0 失败存档 docs/verify-p9.md；0.1.0 便携版目录 95 文件未被改动 |
| P10 文档 | [x] | 2026-10-25 完成：docs/README-v2.md（安装/回滚/后端切换/迁移）+ CHANGELOG P10 条目 + 最终中文报告（未验证项已标注） |

**下一步：等用户对 §5 的 D1–D5 表态后，从 P1 开始执行。**