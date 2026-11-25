# CHANGELOG · 六本豆mcp v2

> 格式：日期 | 改了什么 | 为什么 | 怎么回滚

## 2026-10-25
- **改了什么**：新建 `v2\docs\plan.md`（分步计划 P1–P10、风险清单、工具清单基线、待决事项 D1–D5）与本 CHANGELOG。
- **为什么**：任务书第九节要求第一步先阅读交接资料并产出计划，经用户确认前不动代码。
- **怎么回滚**：删除 `Desktop\六本豆mcp-v2\` 整个目录即可（该目录为全新创建，未触碰任何既有目录）。

## 2026-10-25 · P1 工程骨架
- **改了什么**：新建 `v2\src\`（从交接包 `源码\` 复制 28 个文件，未改动内容）、`v2\tools\`（复制 build.ps1 / verify.ps1 等 11 个文件）。
- **为什么**：v2 需要在独立目录改造，交接包保持只读。
- **怎么回滚**：删除 `v2\src\` 与 `v2\tools\` 即可（均为复制件）。验证：23 个 .js 全部 `node --check` 通过（BAD=0）。

## 2026-10-25（P3）记忆后端适配层
- **改了什么**：新增 `src\dist\core\memoryBackend.js`（记忆后端适配层）：接口 get/set/delete；`JsonMemoryBackend`（默认，直接读写 data.json，行为与 0.1.0 一致）；`HyMemoryBackend`（双写：data.json 仍是 key-value 事实源，同时写入本地 hy-memory sidecar（`python -m hy_memory.server`）做语义召回，sidecar 不可用/超时自动回退 JSON 不抛错）；工厂 `createMemoryBackend(config, store, opts)`。另改 `src\dist\core\tools.js`（memory_get/set/delete 的 handler 由 `c.store.*` 改为 `await c.memory.*`，返回文案不变）、`src\dist\core\app.js`（ctx 新增 `memory` 字段）、`src\dist\core\config.js`（新增配置项 `memoryBackend: 'json'`，可选 json/hymemory，update() 校验）；新增 `tests\memory-parity.test.js`。
- **为什么**：为 P5 的 Hy-Memory 后端做隔离层，默认 json 后端行为与 0.1.0 逐字节一致；切换开关一次到位。
- **怎么回滚**：删除 `src\dist\core\memoryBackend.js` 与 `tests\memory-parity.test.js`，并把 tools.js / app.js / config.js 各自改动还原（tools.js 3 行、app.js 2 行、config.js 2 处）。
- **验证**：node --check ×4 通过；`tests\memory-parity.test.js` 17 项断言 ALL PASS（json 后端返回与 0.1.0 逐字节一致、别名 memory_context/memory_checkpoint 一致、hymemory 断连自动回退且数据落 store）。

## 2026-10-25（P4）Hy-Memory Windows 可行性 spike
- **改了什么**：新增 `docs\spike-p4.md`、`tests\smoke-p4-lite.py`；在 `v2\venv-hy` 安装 hy-memory==2.0.5（含 chromadb 1.5.9、kuzu 0.11.3）。
- **为什么**：验证风险 R1（原生依赖在 Windows 不可用则停止替换）。结论：安装/导入/lite 全链路/sidecar 启动全部通过，未触发停止条件；确认 P5 用官方 `python -m hy_memory.server` 作 sidecar，key→id 映射用 keymap 文件。
- **怎么回滚**：删除 `docs\spike-p4.md`、`tests\smoke-p4-lite.py` 与 `v2\venv-hy\`（venv 为独立目录，删除即回滚）。
- **验证**：INSTALL-DONE EXIT=0；冒烟 SMOKE-DONE fail=0（init 0.973s / add 2 条 / search 0.004s top1 命中 score 0.7455 / get-update-delete success）；`/healthz` 200。未验证项：真实 embedding 端点（本机无任何 LLM/embedding 配置），P7 补测。

## 2026-10-25（P5）Python sidecar + HyMemoryBackend + 自动回退
- **改了什么**：新增 `tools\hy-sidecar.ps1`（手动调试启动脚本，读 hy-memory.env）、`src\dist\core\hySidecar.js`（Node 生命周期：venv 探测/hy_memory 检查/env 加载/复用已有实例/healthz 等待/stop 只杀自己拉的进程，全程不抛错）、`tests\p5-sidecar.test.js`；重写 `src\dist\core\memoryBackend.js`（HyMemoryBackend v3：key→memory_id 映射存 hy-keymap.json（lite 下 list 不列 l1 层，实测见 spike-p4 §5）；add 返回 success!==true 即视为回退；双写 data.json 事实源）；`src\dist\core\app.js` 5 处接入（require hySidecar、createMemoryBackend 传 keymapPath、hySidecar 变量、start 时按需拉起、stop 时回收）。
- **为什么**：实现「两后端可切换；sidecar 挂掉自动回退 json 且不崩溃」的验收；sidecar 直接用 hy-memory 自带 server（不改 SDK）。
- **怎么回滚**：删除 hy-sidecar.ps1/hySidecar.js/p5-sidecar.test.js，memoryBackend.js 还原为 P3 版本（CHANGELOG P3 条目），app.js 还原 5 处。
- **验证**：node --check ×3 + py ast OK；memory-parity.test.js ALL PASS（17 断言）；p5-sidecar.test.js ALL PASS（19 断言）：假 sidecar 全路径（add/keymap/delete/失败回退/恢复/断连回退）+ 真 sidecar 生命周期（venv-hy python 拉起 /healthz 200、写入不崩、stop 后回退不崩）。TOTAL_BAD=0。未验证项：真实 embedding 端点（同 P4 遗留，待用户提供后 P7 补测）。

## 2026-10-25（P6）数据迁移与反向导出
- **改了什么**：新增 `tools\migrate-memory.js`（data.json memory 区→sidecar：只读原件、自动 data.json.bak-p6-<ts> 备份、key→{id,updatedAt} 写 hy-keymap.json、单条失败只计数、支持 --dry-run）、`tools\export-memory.js`（sidecar→memory 区反向导出，--merge 可合并回 data.json（先备份），支持回退）、`tests\p6-roundtrip.test.js`；`src\dist\core\memoryBackend.js` keymap 形状升级为 {id,updatedAt}（兼容旧字符串形状），保证迁移往返 key/value/updatedAt 逐字段一致。
- **为什么**：验收要求「迁移后关键字段一致；原 data.json 保留；可反向导出回退」。
- **怎么回滚**：删除两个 tools 脚本与 p6 测试；memoryBackend.js 还原为 P5 版（CHANGELOG P5 条目）；已产生的 .bak-p6-* 备份可直接还原 data.json。
- **验证**：p6-roundtrip.test.js ALL PASS（12 断言）：dry-run 不写不调、迁移 ok=5 fail=0、data.json 前后 sha256 一致、备份存在、keymap 5 条且 keys/updatedAt 一致、metadata.key 透传、反向导出后 memory 区与原始逐字节一致（JSON.stringify 全等）、单条失败只计数。全套复跑：memory-parity 17 + p5-sidecar 19 + p6-roundtrip 12 = TOTAL_BAD=0。

## 2026-10-25（P7）记忆评估
- **改了什么**：新增 `tests\eval-corpus.json`（25 条真实交接记录语料）、`tools\mock-embed-server.js`（OpenAI 兼容 mock embedding，评估专用）、`tools/eval-live.js`（全真链路评估器：写入/召回/往返/回退一键复现）、`docs/memory-eval.md`（含安装/成本/隐私说明）；`hySidecar.js` 与 `tools\hy-sidecar.ps1` 默认 `MEMORY_MODE=lite`（D1；实测 server 默认 pro 会找 LLM）；`migrate-memory.js` 增加单条耗时统计。
- **为什么**：验收要求 ≥20 条真实记录写入检索含召回与耗时、断连回退测试、安装/成本/隐私说明。
- **怎么回滚**：删除上述新增文件；hySidecar/ps1 去掉 MEMORY_MODE 两行；migrate-memory.js 去掉 elapsedMs。
- **验证**：写入 25/25（p50 125ms）；检索延迟 p50 10ms（全链路含向量化）；往返 25/25 key 字段逐字节一致；杀 sidecar 后 set/get/delete 全部正常不崩。召回率用 mock 向量基线 top1 28–36%（两次），**真实 embedding 端点补测列为未验证项**。

## 2026-10-25（P8）看板简化
- **改了什么**：`src\dist\panel\index.html` 看板页重做：默认主区只显示「当前任务名 + 子步骤三态行」（✓ 已完成灰色 / ⟳ 进行中（全文件唯一 @keyframes 旋转）/ ○ 未开始浅色）；无进行中任务显示「暂无任务」；统计、正在做什么、计划列表、队伍、文件预占、动态等全部收进默认折叠的「详情」（native details/summary）；当前任务取最新的进行中任务。
- **为什么**：验收要求看板只看当前任务与步骤、其余折叠、空态文案、无外部 CDN。
- **怎么回滚**：还原 index.html（CHANGELOG P1 版本对照；或 git/备份恢复看板区块四处改动）。
- **验证**：JS 语法 OK（new Function 编译通过）；@keyframes 规则 ×1；`<link>/<script src>/<img>/@import` ×0（3 处 http 字样均为界面展示文本，非加载资源）；「暂无任务」空态与折叠详情均已就位。


## 2026-10-25（P9）打包 dist-portable + verify.ps1 验证（未触碰 0.1.0 便携版）
- **改了什么**：产出 `v2\dist-portable\`（顶层 exe 更名 `六本豆mcp-v2.exe` = 188,784,128 B；`resources\app.asar` 由 `v2\src` 打包 = 366,909 B；Electron 运行时自 0.1.0 便携版目录只读复制，无 resources\app 目录残留）。新增 `tools\build-v2.ps1`（打包全流程）、`tools\pack-and-verify.ps1`、`tools\p9dance.ps1`（验证独舞）。
- **为什么**：交付要求 dist-portable 独立产物 + verify.ps1 验证存档，且不覆盖 0.1.0 便携版目录。
- **怎么回滚**：删 `v2\dist-portable\` 与 tools 下三个 ps1 即可；0.1.0 便携版本身零改动，直接继续用旧版即是回滚。
- **验证**：docs\verify-p9.md 存档：verify.ps1 **6 通过/0 失败**（端口 8765/8766、/api/status、/api/tunnel-check、MCP initialize 200、ssh -R 8765）；打包前基线比对 0.1.0 便携版目录 95 文件名称/大小/修改时间**完全一致（未被改动）**。验证流程严格 Stop-Process 后进行，结束后已恢复 0.1.0 运行。
- **踩坑记录**：.ps1 无 BOM UTF-8 被 Windows PowerShell 5.1 按 GBK 误读致脚本秒崩（无输出）——全部 .ps1 已转带 BOM UTF-8；Start-Process 后台任务不可靠（会被后续命令击杀），跨停应用的长任务改用计划任务 schtasks 执行。


## 2026-10-25（P10）docs/README-v2.md 与最终报告
- **改了什么**：新增 docs/README-v2.md（安装/回滚/后端切换/数据迁移/看板说明/文档索引/已知未验证项）。
- **为什么**：交付清单要求 README-v2 与最终报告。
- **怎么回滚**：删 docs/README-v2.md 即可，不影响代码。
- **验证**：内容与 CHANGELOG/plan/memory-eval/verify-p9 交叉一致；未验证项已显式列出（真实 embedding 端点、pro/ultra、memory aging）。


## 2026-10-25（增补）借鉴 Claude 工程能力分析：作业协议 + v3 提案
- **改了什么**：新增 docs/ai-protocol.md（AI 协作作业协议：接手流程、一次一事、验收项 JSON、生成/评估分离、汇报纪律、规矩消融）与 docs/proposal-v3-coordination.md（v3 协作机制增强提案 P1-P5，供决策未实施）；另新增 docs/ops-notes.md（远程运维规矩）。
- **为什么**：借鉴 Desktop《Claude工程能力与长程任务分析》可复制清单，让"完成可验证"、少踩重复坑；用户选定"作业协议+产品提案两个都要"。
- **怎么回滚**：删这三个 docs 文件即可，不影响任何代码与产物。
- **验证**：内容与既有 CHANGELOG/ops 实践一致；提案未动代码。


## 2026-10-25（P11）v3 协作机制 P1+P2 落地：验收项 + 独立复核（生成/评估分离）
- **改了什么**：`src\dist\core\coord.js`：①plan_create 任务支持 `acceptance_items` 结构化验收项（id/text/pass/evidence/by/at）；②新增 `task_accept`（逐项勾过，pass 须附≥10字证据）、`task_review`（独立复核 verdict/report/report_path，复核者≠owner 且≠勾项者）；③`task_complete` 对带验收项任务机器校验：未全过/缺证据/未复核通过一律拒绝；④board/task_status/dashboard 输出验收项与复核状态，PROMPT_VERSION→2026.10.26-r1。`src\dist\panel\index.html`：详情里渲染验收项 ✓/✗ 与复核状态（@keyframes 仍=1、外链=0）。新增 `tests\p11_coord_acceptance_test.js`。
- **为什么**：借鉴《Claude 工程能力与长程任务分析》可复制清单（用户拍板 P1+P2）：治"自称完成"与"自评偏乐观"。
- **怎么回滚**：还原 coord.js 与 index.html 至 CHANGELOG P1/P8 版本对照（或 git/备份），删 tests\p11_coord_acceptance_test.js；旧数据无 acceptance_items 字段行为不变（单测已覆盖）。
- **验证**：node --check 过；tests/p11_coord_acceptance_test.js **P11-ALL-PASS**（4 拒绝路径：未勾完 complete/短证据/缺复核/自签复核×2 全部按预期拒绝；通过路径与旧任务兼容路径绿）；重打包 app.asar=374,736 B 后 p9dance 复验 **verify 6 通过/0 失败，0.1.0 便携版目录 95 文件未被改动**（docs/verify-p9.md 更新存档）。


## 2026-10-25（P12）v3 协作机制 P4+P3+P5a 落地：现场标准化 + sprint contract + 工具防呆
- **改了什么**：
  - **P4 现场标准化**：新增 `docs\runs\`（证据归档 `<taskid>-<日期>\` + 索引 README + verify-latest.md 指针）、`tools\runlog.ps1`（Start/Add/Complete，自动归档+清场 ops-tmp）；ai-protocol 第 8 节/ops-notes 补三条铁律（临时进 ops-tmp、证据进 runs、收工清场）；存量 p9entry/p10entry 已清理。
  - **P3 sprint contract**：plan_create 任务新增 `verify`（验收方式一行）；task_status 认领时显示「验收方式」，缺省给提示；board 对缺 verify 未完成任务标「（缺验收方式）」；面板详情显示验收方式；PROMPT_VERSION→2026.10.26-r2。
  - **P5a 工具防呆**：`security.js` 危险分级 DANGEROUS_A（不可逆，需 confirm:"YES" 或面板批准）/DANGEROUS_B（可恢复，输出提醒：Stop-Process 提示缩托盘）；`assertAsciiCommand` 命令文本非 ASCII 硬拒（allow_non_ascii 逃生口）；`scrubSecrets` 对 run_command/command_output/job_poll 输出自动脱敏（私钥块/token 键值/mcp 路径 token/会话 id）；dispatch 面板批准后置 __approved 预授权。
- **为什么**：借鉴 Claude harness 可复制清单（用户拍板 P4→P3→P5①②）：治现场散乱、验收含糊、工具误伤。
- **怎么回滚**：还原 `src\dist\core\security.js`/`tools.js`/`coord.js`/`dist\panel\index.html` 至 P11 版本对照；删 `tools\runlog.ps1`、`docs\runs\`、`tests\p12_security_contract_test.js`；旧数据无 verify 字段行为不变（单测已覆盖）。
- **验证**：node --check 全过；`tests/p11_coord_acceptance_test.js` + `tests/p12_security_contract_test.js` **双 P11/P12-ALL-PASS**（p12 覆盖 A/B 分级、ASCII 硬拒、commandGate 拒绝/授权/提醒、脱敏、审批预授权、verify 字段显示与缺省提示、旧任务兼容）；app.asar 重打包 380,157 B 后 p9dance 复验 **verify 6 通过/0 失败，0.1.0 便携版目录 95 文件未被改动**（docs/verify-p9.md 更新，verify-latest.md 同步）。


## 2026-10-25（P12 增补）防呆误伤修复 + 交接包
- **改了什么**：①security.js A 类清单修正：`format` 只拦真格式化（`format c:` 等），不再误伤 `Format-Table/Format-List` 等 cmdlet；`Remove-Item -Recurse` 判定限制在同一语句内；p12 补 5 条回归断言。②p9dance.ps1 补回 UTF-8 BOM（write_file 覆盖会丢 BOM 导致 PowerShell 解析秒崩——第二次踩此坑，已把「write_file 推完 ps1 必须重转 BOM+ParseCheck」写进规矩）。③桌面新增 `六本豆mcp-v2-源码\` 交接包（src/docs/tools/tests/CHANGELOG/env 模板 + README-接手必读.md，79 文件约 720KB，不含 dist-portable/venv-hy）。④dist-portable 重打包复验全过。
- **为什么**：A 类清单过严误伤正常命令（Format-Table 被拦）；交接给下一个 AI 需要独立源码包与说明。
- **怎么回滚**：还原 security.js/p12 测试至 P12 正文版本；删桌面交接文件夹。
- **验证**：p12 回归（含 Format-Table 放行/format c: 拦截）ALL-PASS；p9dance 复验 verify 全过 + 0.1.0 目录未改动；交接包 79 文件核对。

## 2026-10-25（T19）MCP 审计修复三件套：预占守卫生效 + 原生退出码保真 + command_cancel 上架
- **改了什么**：
  - `src\dist\core\coord.js`：`guardWrite()` 去掉 `!input.agent_id` 早退分支——此前 write_file/edit_file/apply_patch/outbox_write 若未带 agent_id，整个预占冲突检查被跳过，「已预占文件仍可被他人覆盖」（P0）。改为缺省也检查（`conflictsFor(undefined, paths)` 命中即拒）；保留「带 agent_id 可写自己预占的路径、无人预占的路径照常放行」的语义；冲突提示追加「本次调用未带 agent_id，无法判断该路径是否是你本人预占」。
  - `src\dist\core\terminal.js`：Windows 结束标记由 `$?`（只能给 0/1）改为读 `$LASTEXITCODE`，执行前先 `$global:LASTEXITCODE = 0` 归零；PowerShell 自身失败仍回落为 1（P1）。
  - `src\dist\core\tools.js`：`write_file`/`edit_file`/`apply_patch` 的 inputSchema 增加 `agent_id`；`EXPOSED` 集合加入 `command_cancel`（此前工具可调用但不在 tools/list，AI 看不到它）。
  - 同步：live core 与源码快照两处 `src\dist\core\` 三个文件字节一致；`dist-portable\resources\app.asar` 已用 `npx @electron/asar@3 pack src` 重打包（380,176 B → 381,090 B，内含修复后 core）；新增回归测试 `tests\p13_mcpfix_regression_test.js`（13 项断言）。
- **为什么**：审计实测确认的三个缺陷——P0 预占可被绕过（多 AI 并行时互踩文件）、P1 原生命令退出码一律变 1（`cmd /c exit 5` 报 1，脚本/CI 判不准）、P1 `command_cancel` 未上架（run_command 的报错文案却让调用方去找 command_cancel）。
- **怎么回滚**：改前副本在 `docs\runs\T19-MCPFIX-2026-10-25\backup\`（`live-*.js`=改前 live、`snap-*.js`=改前快照、`app.asar.pre-T19`=改前 asar），按名覆盖回 `src\dist\core\` 与 `dist-portable\resources\app.asar` 即可；回滚后需重启服务进程才生效。
- **验证**：`node --check` 三个文件全过；`tests\p11_coord_acceptance_test.js` **P11-ALL-PASS**、`tests\p12_security_contract_test.js` **P12-ALL-PASS**、`tests\p13_mcpfix_regression_test.js` **13/13 VERIFY_ALL_PASS**（均以 `CORE_DIR` 指向 live core 运行）；新 asar 内 dist/core 三个文件哈希与改后源文件一致、其余 27 个文件未变（输出见 `docs\runs\T19-MCPFIX-2026-10-25\`）。
- **踩坑记录**：①`apply_patch` 的 `edits` 模式 old_text 必须字节级一致，手抄中文易错（文件里是「别的」不是「其他」），改为「node 读回原字节 → 本地改造 → 回填」；②`expected_versions` 必须是 `read_file` 返回的版本号；③首版把 `agent_id` 插到了 `obj({...})` 外面（成了工具对象属性而非 schema 属性），已修正为 schema 内最后一个属性。
- **未验证项**：换装后的 `app.asar` 未做运行时 verify（p9dance 需先停 0.1.0 服务，会中断当前 MCP 通道）；当前在跑的仍是 0.1.0 便携版（自带一份更早的 core 副本，与 v2 不是同一套代码），重启它不会加载本次修复，要生效需用 v2 产物（六本豆mcp-v2.exe）。

## 2026-10-25（T20）面板重做 + 内置 skill + 工具暴露面扩容（版本升 0.2.0）
- **改了什么**：
  1. **面板重做** `src\dist\panel\index.html`（39,840 B → 78,111 B）：深浅色设计令牌；侧边导航 + 粘性顶栏 + 全局搜索；**焦点卡**（任务标题 / 目标 / 进度环 / 正在做 / 下一步 / 步骤条 / 验收项 chips / 复核 / 阻塞 / 最近证据）——解决"一眼看不出是什么任务、到哪了"；6 项统计数字滚动入场；任务卡保留 `details` 展开态；右侧抽屉（队伍 / 文件预占 / 动态）；**新增技能页**（技能卡 + 内联 SKILL.md）；Toast 提示；快捷键 `1–9` `/` `R` `D` `?`；`prefers-reduced-motion` 降级；骨架屏 + 交错入场；**改为增量渲染**（原版每 2 s 全量 `innerHTML` 重绘 → 闪烁且 `<details>` 状态被清空）。工具页新增「AI 可见 / 不可见」徽标与 `toolVis` 过滤。零外链、零外部资源。
  2. **工具暴露面扩容** `src\dist\core\tools.js`：EXPOSED 29 → 66，新增 37 个**真实存在**的工具——`task_accept` / `task_review` / `task_claim`（生成与评估分离）、`report_progress`（面板进度来源）、`update_plan` / `todo_*` / `set_todos`、`skill_list` / `skill_read` / `skill_save`、`project_overview` / `project_memory_search`、`upload_file` / `download_file` / `inbox_*` / `outbox_*`、`git_status` / `git_diff` / `git_log` / `git_commit`、`edit_file` / `read_files` / `list_dir` / `read_image`、`web_search` / `web_fetch`、`get_diagnostics` / `code_definition` / `code_references`、`env_info`、`memory_get` / `memory_set`；`toolCatalog()` 增 `exposed` 标记。GUI 自动化类（`ui_*` / `screenshot` / `lsp`）与历史别名**继续隐藏**。
  3. **内置 skill** `src\dist\core\skills.js`（5,188 B → 11,798 B）：`session-startup` / `bugfix-workflow` / `feature-workflow` / `review-workflow` / `handoff-workflow` 五个，全部使用**真实 v2 工具名**；种子带 `seed:` 版本标记（`2026.10.26-t19`）——缺失则种出、旧种子则升级、**用户改过则永不覆盖**；旧版 `bugfix-workflow`（引用已废弃工具）按内容特征识别并自动升级。
  4. **技能接口** `src\dist\core\app.js`：新增 `GET /api/skills`（列表）与 `GET /api/skills?name=`（正文）。
  5. **版本** 0.1.0 → **0.2.0**（`src\dist\core\config.js` 的 `APP_VERSION` + `src\package.json`），避免与旧 0.1.0 便携版混淆。
  6. **新增** `tests\p14_ui_skills_test.js`（契约测试）、`docs\claude-harness-borrowing.md`（Claude 工程能力借鉴映射）、`tools\panel-preview.js`（隔离端口的界面预览器，不影响在跑的服务）。
- **为什么**：用户反馈"看板没法一眼看到是什么任务、到哪了""UI 太丑、太空、没有微互动、动画不高级""没有内置 skill"，并要求"一切以体验感和 AI 工作效率为首要目标"。根因分两层：①**面板层**信息密度低、且每 2 s 全量重绘导致闪烁与展开态丢失；②**工具层**——AI 根本调不到 `task_accept` / `report_progress` / `skill_*` / `git_*`，"生成—评估—交接"闭环是断的，所以再好看的看板也没有数据源。两者必须一起补，只改皮不改工具等于白改。
- **怎么回滚**：把 `src\dist\core\{skills.js,tools.js,app.js,config.js}` 与 `src\dist\panel\index.html` 还原到 T19 版本（改前副本在 `docs\runs\T19-MCPFIX-2026-10-25\backup\`），`src\package.json` 版本号改回 `0.1.0`，删除 `tests\p14_ui_skills_test.js`、`docs\claude-harness-borrowing.md`、`tools\panel-preview.js`，重打包 `app.asar` 即可；EXPOSED 退回 29 个不影响既有调用（只是 AI 少一批工具）；**用户技能目录 `%APPDATA%\LocalAIConsole\skills\<name>\SKILL.md` 是用户内容，回滚时不要删**；重启 v2 进程后生效。
- **验证**：`node --check` 五个核心文件全过；`tests\p14_ui_skills_test.js` **P14-ALL-PASS**（语法、EXPOSED ⊆ 真实工具、生成/评估/进度/skill 工具已上架、工具数 ≥ 60、`toolCatalog.exposed` 存在、GUI 类仍隐藏、5 个内置技能种出且带 builtin 标记、旧种子被升级、用户技能不被覆盖、面板脚本语法与**全部 `$('#id')` 均存在**、零外链）；live core 与源码快照两棵树 4 个改动文件**字节一致**；`app.asar` 重打包 424,038 B（sha256 `75C235F1…50F4`），解包后 6 个关键文件哈希与源文件一致、内含 `APP_VERSION 0.2.0`；另起隔离实例（端口 8799、独立数据目录）实测：`/api/status` 版本 `0.2.0`、面板含技能页/焦点卡/统计/搜索、技能 6 个（5 内置 + 1 用户）、看板 3 个计划 / 184 条动态 / 15 个 agent 有真实数据。
- **踩坑记录**：①内置 skill 的落盘路径是 `dataDir\skills\<name>\SKILL.md`（不是 `dataDir\<name>`），第一版测试写错目录导致"用户技能不被覆盖"假失败；②旧种子识别最初用"整篇正文 sha256 相等"，正文一改就失效，改为**内容特征**（含 `project_overview` / `code_definition` 等已废弃工具名）才稳；③面板顶栏原有 `#mode` 元素在重做时漏掉，JS 刷新时会空指针报错——由 p14 的"脚本引用的 id 必须存在"断言当场抓出并修复。
- **未验证项**：换装后的 `app.asar` 未做**运行时**端到端验证（p9dance 需先停 0.1.0 服务，会中断当前 MCP 通道）；当前在跑的仍是 0.1.0 便携版（自带更早的 core 副本），它不会加载本次改动——新界面请先用 `tools\panel-preview.js`（http://127.0.0.1:8799/）查看，或退出旧版后双击桌面 `六本豆mcp-v2.lnk` 启动 v2。

## 2026-10-25（T21）面板改回纯白冷白极简（按官方 frontend-design skill 重做）
- **改了什么**：
  1. **整体换基调**：深色玻璃拟态 → **纯白冷白极简**（画布 `#FFFFFF`、1px 发丝边框、几乎无阴影、唯一强调色 `#1F6FEB`）；清掉全部渐变、模糊与装饰性阴影，只留浮层（Toast / 帮助框）一处阴影。深色模式保留为可选（0.1.0 就有这功能，不删），但按同一套设计语言重做，不再是渐变玻璃。
  2. **按用户《微交互与动效设计 v0.1》重写动效**：时长 token `120 / 200 / 600 / 800ms`、缓动 snappy / default / soft、按压 `scale .97`、数字变化 520ms ease-out **不加弹跳**、进度环 600ms 单向增长不摆动、"正在做"用 6px **呼吸点**（全站唯一循环动画，仅在进行中渲染）、`prefers-reduced-motion` 降级且静态度**不丢信息**。**不采纳**：光斑、渐变流动、波纹、粒子、装饰性 glow。
  3. **落地即见任务**：概览页顶部直接放**焦点卡**（任务标题 / 目标 / 进度环 / 正在做什么 / 下一步 / 步骤条 / 验收项 / 复核 / 阻塞 / 最近进展），看板数据改为常驻刷新（不再只在看板页取）；概览下半区改双栏（当前进度·计划·待办 ｜ MCP 服务·公网入口），解决"太空"。
  4. **图标统一描边 SVG**（22 个，零字体字形、零外链）：侧栏 11 项 + 顶栏刷新/主题/审批 + 卡片标题 + 搜索放大镜 + Toast 对勾；头像由彩色渐变改为平涂淡色。
  5. **修掉三个真 bug**：① 重排概览页时正则切错闭合标签，残留一段含 **12 个重复 id** 的旧卡片（会静默取错元素）→ 整段重建 + p14 新增"无重复 id"断言；② 深色档主按钮白底白字不可读 → 引入 `--btn-bg / --btn-fg` 主题化按钮色；③ 搜索框 padding 被后置表单规则覆盖（同特异性）→ 提高选择器特异性。
  6. **p14 增强**：新增 6 条断言——纯白画布、无渐变/玻璃/模糊、动效 token 规范、无重复 id、概览页含焦点卡、图标统一 SVG。
  7. 新增 `docs\design\panel-v3-设计计划.md`（skill 的 计划 → 对照 brief 自检 → 实现 → 截图自评 全过程记录）。
- **为什么**：用户明确「我要我的纯白色不要改呀」「用 skill 设计别瞎设计」。上一版把默认主题做成深色 + 玻璃拟态 + 径向光晕，与用户桌面《教育教学Agent-微交互与动效设计-v0.1》已定的**基调 B 冷白极简**相反，也踩了用户红线（装饰性 glow 不采纳）。本次按 Anthropic 官方 `frontend-design` skill 重做：先定 Purpose / Tone / Constraints / Differentiation 与 token 系统，再对照 brief 自检（明确否决 7 项"AI 默认做法"），最后**截图自评**迭代（浅色 + 深色 × 概览/看板/技能）。
- **怎么回滚**：把 `src\dist\panel\index.html` 还原到 T20 版本后重打包即可回到 T20 观感（T20 asar 的 sha256 记录在 `docs\runs\T20-UI-SKILLS-2026-10-25\verification.txt`）；`tests\p14_ui_skills_test.js` 可去掉新增 6 条断言；本次**未改任何核心逻辑**（skills / tools / app 均未动），无需回滚其它文件。
- **验证**：p14 **P14-ALL-PASS**（含新增 6 条）、p11 **P11-ALL-PASS**、p12 **P12-ALL-PASS**、p13 **13/13 VERIFY_ALL_PASS**（均指向 live core）；live 树与源码快照树面板**字节一致**；`app.asar` 重打包 **422,418 B**（sha256 `ED7BEDE1…D0BDF`），解包后 6 个关键文件哈希与源文件一致；隔离实例（8799）用系统 Edge 截图人工复核浅色/深色两版，确认纯白、0 渐变、焦点卡在首屏、按钮可读、无重复 id 错位。
- **踩坑记录**：① 正则切 HTML 会把闭合标签切错 → 结构重排一律整段手写重建，并用"无重复 id"断言兜底；② CSS 同特异性下后置规则会覆盖前面的 padding → 提特异性；③ Windows 上 Playwright 未下载浏览器 → 改用 `channel="msedge"` 直接调系统 Edge（免下载）；④ base64 分块回传时终端会吞 `<<` 标记 → 改用"首行状态行、其余为载荷"切分。
- **未验证项**：换装后的 `app.asar` 未做运行时端到端验证（需先停 0.1.0 服务，会中断当前 MCP 通道）；新界面请先用 `tools\panel-preview.js`（http://127.0.0.1:8799/）查看，确认后再退出旧版启动 v2。

## 2026-10-25（T22）桌面 GUI 化 + 一键修复重写 + 看板任务编号 + Windows 安装包
- **改了什么**：
  1. **桌面 GUI（不再只是网页）** `src\dist\main.js`：BrowserWindow 改 `frame:false` 自绘标题栏 + `backgroundColor:#FFFFFF` + 1200×820 + `ready-to-show` 后显示；面板地址固定带 `?gui=1`；新增 `src\dist\preload.js`（contextBridge → `window.gui`）与 3 个 IPC：`gui:minimize` / `gui:maximize` / `gui:close`（关闭 = 隐藏到托盘，与原 X 行为一致）。
  2. **自绘标题栏** `src\dist\panel\index.html`：`#titlebar`（`.tb-mark/.tb-title/.tb-sub/.tb-btn` + 3 个内联 SVG 窗口按钮），`body.gui` 时显示；标题栏 `-webkit-app-region:drag`，按钮区 `no-drag`。
  3. **看板任务编号改成「1. 什么什么任务」**：任务卡标题改为 `<span class="idx">N.</span> 标题`，**原始任务号（T16 / t1- / 123456）只留在详情区「任务编号：」**；焦点卡不再外露 id；动态流新增 `humanize()` 把事件里的原始编号替换成任务标题。
  4. **一键修复逻辑重写** `src\dist\core\app.js`：新增 `probeLocalMcp()` 端口探针；`tunnelCheck` 由 2 步扩为 **4 步**（本机 MCP → 隧道进程 → 服务器入口 → 公网 MCP）；`tunnelRepair` 改为**按病因修**：本机端口不通→只重启 MCP 监听（`onRepairLocal`，不动面板进程）；隧道进程缺失→`onRepairTunnel`；服务器入口不通→`onRepairServer`（Caddy）；握手失败→**仅当该隧道是本应用自己的**（`result.owned`）才重建，否则提示改用「强制重建隧道」；新增 `POST /api/tunnel-rebuild` → `tunnelRebuild()`；`/api/status` 新增 `mcpUp`（面板不再硬写「MCP 服务 运行中」）。
  5. **隧道管理器** `src\dist\core\tunnel-manager.js`：新增 `restartOwn(port)`（只重建本应用自己的隧道，不动别人的 ssh）与 `rebuild(port)`（结束所有匹配的旧隧道进程再拉新的，需用户明确点击）。
  6. **面板修复交互**：一键修复按钮禁用 + 逐条显示 `repairLog` + 修复后自动重跑 `runTunnelCheck()`；新增「强制重建隧道」按钮 `#tcRebuild`。
  7. **Windows 安装包**：新增 `tools\build-installer.js` → 生成 `installer\Setup.exe`（295,524,352 B，payload 以 .NET 清单资源内嵌）与 `installer\Uninstall.exe`（12,800 B）。安装到 `%LOCALAPPDATA%\Programs\六本豆mcp-v2`，创建桌面 + 开始菜单快捷方式，写入 HKCU 卸载项（`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\LiuBenDouMcpV2`），**无需管理员权限**；旧版 `本地AI遥控台` 冗余目录不打包（省 281 MB）。
  8. **重打包** `app.asar` 433,789 B（sha256 `553D37E5C8E7F2AF25A48A1D23BE444B56CCCDEAC8E7E253F7E09B1CEDAB9171`）。
- **为什么**：用户明确「**我不要网页我要 GUI**」「**一键修复感觉逻辑有问题**」「**出 exe 安装包吧，就是打包好我去别的电脑能直接用**」「看板不要乱七八糟的编码，就是 123456 或者 t1- 这种，就 1. 什么什么任务多好**」。根因分三层：① 面板只是浏览器里的页面，没有桌面应用形态；② 旧 `tunnelRepair` 只按 `steps[0]/[1]` 猜病因、握手失败只等 3 轮就放弃、且 `start()` 会复用**别人的** ssh 进程，于是「修了等于没修」；面板还把 MCP 状态硬写成「运行中」；③ 任务卡直接外露原始任务号，看不出人话。
- **怎么回滚**：把 `src\dist\{main.js,preload.js}`、`src\dist\core\{app.js,tunnel-manager.js}`、`src\dist\panel\index.html` 还原到 T21/T20 版本（改前副本在 `docs\runs\T22-GUI-INSTALL-2026-10-25\backup\`），删除 `src\dist\preload.js`（T22 新增）、`installer\` 与 `tools\build-installer.js`，重打包 `app.asar`；桌面上的 `六本豆mcp-v2-安装包.exe` 直接删除即可（安装器只写 HKCU 自己的卸载项，不改系统配置，安装目录在 `%LOCALAPPDATA%\Programs\六本豆mcp-v2`）。
- **验证**：`node --check` 5 个改动文件全过；回归 `tests\p11_coord_acceptance_test.js` **P11-ALL-PASS**、`p12_security_contract_test.js` **P12-ALL-PASS**、`p13_mcpfix_regression_test.js` **13/13 VERIFY_ALL_PASS**、`p14_ui_skills_test.js` **P14-ALL-PASS**；`app.asar` 解包后 5 个关键文件与源文件 sha256 一致；GUI 实例真机跑通（隔离端口 8805/8806），面板 `?gui=1` 截图确认自绘标题栏与任务编号正常渲染；安装包端到端测试 **14/14 ALL_PASS**（安装目录、主程序 sha256 与源一致、app.asar / cloudflared / locales 齐全、无冗余目录、桌面 + 开始菜单快捷方式、HKCU 卸载项均在，卸载后目录/快捷方式/注册表项均清除）；安装后实例真机启动并能正常服务面板（`/api/status` 返回 `version 0.2.0` / `mcpUp true`）。
- **踩坑记录**：① 远端无 7z / NSIS / Inno / electron-builder → 改用系统自带 `csc.exe` 编译 WinForms 安装器，payload 以 **清单资源**（每文件一个资源）内嵌，避开了 ZIP 解包 API 依赖；② `csc.exe` 是 C# 5 编译器，中文必须写成 `\uXXXX` 转义（否则被当成 ANSI 码页缩进），另外 `Form1` 类必须用 `Program.APP` 实例访问常量（否则 CS0103）；③ `DirectoryInfo.Length` 不存在 → 删掉 `EstimatedSize`；④ winexe 用 PowerShell `&` 调用**不会等待**，必须 `Start-Process -Wait -PassThru` 才能取到退出码；⑤ 当前终端只有一个串行口，一个安装器进程卡住会把你锁在“终端正忙”，只能 `command_cancel` 抢回；⑥ `Uninstall.exe` 必须按可执行文件名自动判定卸载模式（否则无参数启动会弹出安装向导界面并永久卡住终端）。
- **未验证项**：① 本机端安装包已完整跑通（安装→运行→卸载→再安装），但**另一台物理机的首次启动未实测**（无法在本机模拟）；② Electron 窗口的**原生截图**未取到（`PrintWindow` 对 Chromium GPU 合成窗口只能拿到空图，`CopyFromScreen` 拿到的是其他窗口），界面验收改用**同一页面在 Playwright/Edge 下的渲染截图**（自绘标题栏、任务编号、修复按钮均正常），需用户自己在桌面上看一眼真实窗口；③ 一键修复的**真实故障注入**（确实杀掉隧道进程 / 停掉 Caddy / 占用本机 MCP 端口）未做，当前只验证了探针与修复路由。

## 2026-10-25（T23）卸载 1.0 + 清理旧残留 + 源码归一 + 交接报告
- **改了什么**：
  1. **卸载 1.0**：删除 `桌面\本地AI遥控台-0.1.0-win-x64-便携版\`（549.9 MB）、同名 zip（99.6 MB）、指向它的桌面快捷方式 `六本豆mcp.lnk`。
  2. **清理本项目旧残留**：`六本豆-lab\`（1249.4 MB，旧 lab 源码；README/research/src/tools/changes/shots 已归档进 `docs\archive\六本豆-lab\`）、`六本豆\`（303.8 MB，旧 app）、`六本豆-Setup-0.4.0.exe`（180.8 MB）、`六本豆mcp-v2-源码\`（源码镜像，内容已并入主树）。
  3. **主树瘦身**：`dist-portable\本地AI遥控台\`（268.0 MB，冗余嵌套副本）、`installer\Setup.exe` + `Uninstall.exe`（281.8 MB，桌面已有同字节安装包）、`venv-hy\`（637.8 MB；默认 `memoryBackend=json` 用不到，依赖清单存 `venv-hy-requirements-lock.txt`）、`tools\build-r*.log|err`、`p9-*.txt`。
  4. **新增交接报告** `交接报告.md`（现状 / 怎么用 / 目录结构 / 架构 / 版本史 / 验证状态 / 运维手册 / 待办 / 踩坑 / 接手第一课），桌面同内容副本 `六本豆mcp-v2-交接报告.md`；`README-接手必读.md` 顶部加 T23 状态横幅。
  5. **合计释放 3572.6 MB（≈3.49 GB）**；桌面只剩「六本豆mcp-v2\ 源码树」+「六本豆mcp-v2-安装包.exe」+ 一个已安装实例的快捷方式。
- **为什么**：用户反馈「好多版本是残留源码」，明确要求「把 1.0 卸载了、没用的都删了、现在版本源码放桌面就行、再写个交接报告」。
- **怎么回滚**：删除不可逆；可恢复部分已提前留底——旧 lab 的源码与文档在 `docs\archive\六本豆-lab\`，venv 依赖在 `venv-hy-requirements-lock.txt`；1.0 与旧 app 属历史产物，需要时重新获取旧版本即可。源码树本身没有破坏性改动（只删冗余构建产物），`CHANGELOG.md` 与 `docs\runs\T18…T22` 证据完整保留。
- **验证**：删除后确认已安装的 v2 实例仍在运行（`http://127.0.0.1:8766/api/status` 返回 200）；四套测试复跑全绿（`p11 P11-ALL-PASS` / `p12 P12-ALL-PASS` / `p13 13/13 VERIFY_ALL_PASS` / `p14 P14-ALL-PASS`）；主树体积 1440 MB → 294.5 MB；C 盘可用 142.9 GB；桌面残留核对：仅 `六本豆mcp-v2\`、`六本豆mcp-v2-安装包.exe`、`六本豆mcp-v2.lnk`、`六本豆mcp-v2-preview.lnk`（其余为其它项目）。
- **未验证项**：1.0 为便携版、无注册表安装项，其历史 Electron profile 未逐一核对清理；`%APPDATA%` 下旧 profile 保留，以免影响正在运行的 v2 实例。

## 2026-10-25（T24）看板按最近更新排序 + 计划筛选 + 把这轮工作登记进看板
- **改了什么**：
  1. **`src\dist\core\coord.js`**：`dashboard()` 之前只吐计划级 `updatedAt`，**任务级时间戳根本没传给面板**——这就是「看板看不到新任务」的根因之一。现在每个任务额外返回 `updatedAt`。
  2. **`src\dist\panel\index.html`**：
     - 任务清单改为**按最近更新倒序**（`updatedAt` 优先，状态作为次级排序），标题旁标注「· 按最近更新」；原来只按「状态 → 任务编号字符串」排，新任务会被旧任务整片压住。
     - 新增**计划筛选下拉**（全部计划 / 每个计划一个选项），可单独看某一个计划。
     - 任务卡新增「更新于 X 小时前」。
     - 焦点卡改为优先展示**最近更新的**进行中任务。
  3. **把 T19–T24 六项真实工作正式登记进看板**（`plan_create` + `task_complete` + 证据），看板计划进度 **24/24 全部完成**；证据均为实跑测试输出与文件校验。
- **为什么**：用户反馈「看板还是 1.0 刚出时做的测试任务，从 1.0 到现在根本看不到新任务」。查证后是两个独立原因：①**产品缺陷**——任务时间戳没传给面板，看板没有「按时间」这个维度，只能按状态+编号排，旧测试任务长期占着「进行中/待做」；②**流程缺口**——T19–T23 的活儿是直接干的，没有走 `plan_create`，所以看板里压根没有这些条目。
- **怎么回滚**：`src\dist\panel\index.html` 与 `src\dist\core\coord.js` 还原到 T23 版本（`docs\runs\T22-GUI-INSTALL-2026-10-25\backup\` 存有 T21/T20 副本，T23 的面板可用 git 外的 `CHANGELOG` 记录回退到 434,773 B 的 asar），重打包 `app.asar` 即可。看板里的 T19–T24 条目是数据，可直接忽略。
- **验证**：`node --check` 全部通过；`p11 P11-ALL-PASS` / `p12 P12-ALL-PASS` / `p13 13/13 VERIFY_ALL_PASS` / `p14 P14-ALL-PASS`；`app.asar` 重打包 **434,925 B，sha256 `341978B7163B00ACFEA7D66A4F5A99E80C652C9CB675BB3086D6646E1FC21D88`**；重新安装到运行中的实例并重启后，实机截图确认看板首屏即为 T19/T24/T23/T22/T21/T20 六条最新工作，卡片带「更新于 X 分钟前」，计划下拉含 4 个计划；安装包同步重建（295,525,376 B，sha256 `fcdca48e1c90fb9b9720834ce3b3ea06`）。
- **踩坑记录**：① `dashboard()` 不返回任务级 `updatedAt`，面板**根本没有「按时间排」的能力**——只看面板代码会误以为是排序写错了；② `write_file`/`edit_file` 覆盖远端文件必须带 `expected_version`；③ 重装并重启正在服务的实例时，MCP 会话会被打断（session not found），需重新 initialize 拿新 session；④ 「重打包 + 重建安装包」的脚本不能漏掉 `asar pack`，否则安装包里还是旧面板。
- **未验证项**：① 旧测试任务（r2-coord-test、立法追踪计划）仍保留在看板里——它们属于其它 agent 的历史任务，按规则不该由我代为关闭，现在靠「按最近更新排序」沉底；② 一键修复仍缺故障注入测试（见 T22 条目）。

## 2026-10-25（T25）Kali/Linux 版 + 新图标 + 零模型记忆后端
- **改了什么**：
  1. **新增 `src\dist\core\platform.js`（跨平台适配层）**：把散落的 Windows 专属调用收拢——ssh 可执行文件（Windows 用系统 OpenSSH，Linux 用 `/usr/bin/ssh`）、ssh 进程枚举（PowerShell CIM → `ps -eo pid,args`）、结束进程树（taskkill → SIGTERM→SIGKILL）、端口占用查询（`Get-NetTCPConnection` → `ss -ltnp` / `lsof`）、系统信息。
  2. **`config.js`**：数据目录在非 Windows 走 XDG（`~/.config/LocalAIConsole`，可用 `LAC_DATA_DIR` 覆盖）；`memoryBackend` 增加 `local` 选项并改为默认值。
  3. **`app.js` / `tunnel-manager.js` / `tools.js` / `desktop.js`**：改用 platform.js；桌面截图在 Linux 走 `scrot` → ImageMagick `import` → `gnome-screenshot`，窗口/键鼠操作走 `xdotool`（列窗口可用 `wmctrl`），Windows 行为保持不变。
  4. **`memoryBackend.js`：新增 `LocalMemoryBackend`（零模型后端）**——事实源仍是 `data.json`（键值与 `updatedAt` 和 json 模式完全兼容），额外在本地做 BM25 词法打分 + 时间衰减 + 键名精确命中加权；中英混合分词（中文按字+二元组）。**不需要 embedding 端点、不需要 API key、不需要 Python sidecar、不需要联网。** 同时新增 `memory_search` 工具。
  5. **图标换成用户提供的图**：`src\assets\icon.png`(1024) / `icon.ico`(16~256 共 7 尺寸) / `icon-512.png` / `icon-256.png`；Electron 主程序用 rcedit 换图标；WinForms 安装器编译加 `/win32icon`；面板 favicon 换成新图；Kali 版装 `icon-512` 并注册 .desktop 菜单项。
  6. **新增 Kali 交付物** `liubendou-mcp-v2-linux-x64.tar.gz`（自带便携 Node 20 运行时，约 97 MB）：`bin/install.sh`（装到 `~/.local/share`、建 `~/.local/bin` 启动器、装图标与桌面项、注册 systemd 用户服务）、`bin/uninstall.sh`、`systemd/liubendou-mcp.service`、`README-Kali.md`（中文，含跨平台差异表与排错）。
  7. `hySidecar.js`：Linux 下也会找 `venv-hy/bin/python`；`main.js`：非 Windows 用 `icon.png` 当窗口图标。
  8. `tools.js` 的 `EXPOSED` 白名单补上 `memory_search`——零模型后端要能被 AI 真正检索到才算落地（`memory_delete` 按原规矩仍不暴露）。
  8. `tests\p13_mcpfix_regression_test.js`：命令用例按平台切换（Windows 用 cmd/PowerShell，Linux 用 bash 语法），不再在 Linux 上误报。
- **为什么**：三件事——① 要一个 Kali 上能用的版本；② 现在的图标太丑，换成用户给的那张；③ 混元 2.0 要接 embedding 端点+密钥+Python sidecar 太重，想知道能不能不接模型。
- **怎么回滚**：`src\dist\core\platform.js` 删除即可（其余调用点同步还原）；`memoryBackend` 默认值改回 `'json'`；图标换回旧 `icon.ico` 后重新 `asar pack` + 重新编译安装器（`tools\build-installer.js` 去掉 `/win32icon` 即可）；Kali 交付物直接删 tar.gz 即可，不影响 Windows 版。
- **验证**：Linux 沙箱（真 Linux）内 `p11 P11-ALL-PASS` / `p12 P12-ALL-PASS` / `p13 VERIFY_ALL_PASS` / `p14 P14-ALL-PASS`；便携包 `bin/install.sh` 实装到隔离 HOME 后 `liubendou-mcp` 启动成功、面板 `/api/status` 200、mcpUp=true、数据落在 `~/.config/LocalAIConsole`；零模型后端单测：「kali linux 怎么启动」召回 kali 条目、「六本豆 项目 端口」召回 project、「5432 数据库」召回 db、无匹配返回空；Windows 侧四套回归同样全绿，`app.asar` 807,407 B sha256 `ab55034a8967b759283c243cb625f36e7e8c48b30b74302cdd2077e8534426dc`，`Setup.exe` 296,041,984 B sha256 `e6de64290bcfd9211bc8a6543b77d933`。
- **踩坑记录**：① `run_command` 的 command 里带 `\\` 会被 Python 字符串吃掉，Windows 路径要用 heredoc 写文件再上传；② 大文件（36 MB）走 cloudflared 快速隧道会 502（请求超时），要切片上传再合并；③ Electron 主程序图标必须用 rcedit 改 PE 资源，只换 `assets\icon.ico` 不影响任务栏/快捷方式图标；④ WinForms 安装器要加 `/win32icon` 才会用上自己的图标。
- **未验证项**：① Kali 真机未实测（手上没有 Kali 机器，验证是在 Linux 沙箱 + 隔离 HOME 里做的）；② Kali 版不含 Electron GUI，走浏览器面板（Windows GUI 保持原样）；③ Linux 下 `xdotool`/`scrot` 属于可选依赖，未安装时相关工具会给出明确中文提示而不是静默失败。

## [0.3.0] - 2026-10-26 · T26 零模型记忆引擎（接管混元2.0）+ 删任务/删计划 + 清掉立法追踪老计划

- **改了什么**：
  1. **记忆后端换血**：`src\dist\core\memoryBackend.js` 整文件替换为新的**零模型多路召回引擎**（替代一直没启用的混元 2.0 那条路径，local 引擎成为正式记忆实现）。结构：① **BM25 词法通道**（k1=1.2, b=0.75；中英混合分词：英文词 + 中文单字与二元组 + 停用词 + trigram）；② **RM3 伪相关反馈扩展通道**（取首轮 top5 的高频词回灌查询并加倍权重）；③ **键关联图通道**（key↔term 共现归一化，用来捞「同一个 key 下别的说法」）。三路候选 → **加权 RRF(k=60) 按名次融合**（权重 1.0 / 0.6 / 0.45，刻意**不按分数直接相加**，因为各路分数量纲不可比）→ **四因子重排**（词面覆盖 0.40 / 新近 0.22 / 键名命中 0.22 / 术语密度 0.16，另加 0.35×融合分）→ **双置信拒答门**（候选必须来自三路且至少命中 1 个「强词」（长度>1 的词或中文二元组，单字不算），融合分 < 0.005 直接返回空）。**时间只做重排因子、不进召回通道**（否则「量子纠缠 超导 拓扑」也会被时间通道灌进来）。
  2. **删任务 / 删计划**：`coord.js` 新增 `deleteTaskById()` / `deletePlanById()`（删除会清理指向它的 deps、写 `task-delete` / `plan-delete` 事件流、他人正在执行的任务需 `force=true`）；新增工具 **`task_delete`**（agent_id + task_id + reason + force）与 **`plan_delete`**（agent_id + reason + force），并加入 `COORD_TOOLS` 白名单与 `tools.js` 的 EXPOSED；`app.js` 新增 `POST /api/coord/task-delete` 与 `POST /api/coord/plan-delete`；面板任务卡标题行右侧加 **✕ 删除按钮**（`.tcdel`，hover 显形）、计划筛选下拉旁加 **🗑 删除按钮**（`#boardPlanDel`），事件委托 + confirm + toast。
  3. **清掉老计划**：用新的 `plan_delete` 工具删掉长期挂着的「119th Congress 联邦学生贷款立法追踪」计划（16 项任务，含 2 项 doing）与遗留的 `r2-coord-test` 并发测试计划（3 项）。`coord.json` 的 plans 由 3 → 1，只剩当前项目（六本豆mcp-v2，27 项任务全 done），看板不再被老计划占位；当前 T26 三项任务已登记进看板并按「1. 2. 3.」显示。
  4. **新测试**：`tests\p15_local_memory_delete_test.js`——记忆四问（面板端口→kali_start、sk-stg 前缀→api_key、5432→db_conn、面板端口号→kali_start）+ 无关查询必须返空 + 删任务 / 删计划行为 + 删不存在的任务必须报错 + 不误删同计划其它任务。
  5. **版本号** 0.2.0 → **0.3.0**。
- **为什么**：三件事——① 用户要求先去找更好的**「不用模型」记忆系统**并替换掉一直没启用的混元 2.0；调研结论是纯向量在 agent 记忆上会失灵（精确 ID / 路径 / 端口这类词法查询才找得到），正解是**多路召回 + 按名次融合（RRF）**，所以做成零模型的 BM25+RM3+键关联三路召回 + RRF + 重排 + 拒答门，而不是再接一个模型；② 用户要看板上能**删任务**；③ 用户抱怨「立法任务挂了好多天，别的任务都不显示」，要先把那条老计划清掉。
- **怎么回滚**：`src\dist\core\memoryBackend.js` 换回上一版文件（`local` 后端的旧实现）即可，键值格式与 json 模式完全兼容、不丢记忆；删除能力回滚 = 把 `coord.js` 里的 `deleteTaskById` / `deletePlanById` 与两个工具定义、`app.js` 的两个接口、`panel\index.html` 的按钮与事件处理一并去掉（其余功能不依赖它们）；老计划若要找回，`coord.json` 属于事件流留痕，事件里保留了 `plan-delete` 记录，可按事件复原。版本号回滚 = `src\package.json` 改回 `0.2.0` 后重新 `asar pack` 并重编安装器。
- **验证**：
  - Windows 实机：`node --check` 五个 JS + 面板 `<script>` 块全 OK；`tests\p11/p12/p13/p14/p15` **五套回归全绿**（P11-ALL-PASS / P12-ALL-PASS / p13 VERIFY_ALL_PASS / P14-ALL-PASS / P15-ALL-PASS，汇总 `ALL-SUITE-PASS`）。
  - 实机换包后：`tools/list` = **69** 个工具，含 `task_delete` / `plan_delete`（`memory_delete` 仍按原规矩隐藏）；`/api/status` mcpUp=true；`/api/tunnel-check` ok=true（8765 ✓、ssh 隧道进程 ✓、公网握手 ✓）；面板首页 HTML 含 `.tcdel` / `#boardPlanDel` / `data-del` / `task-delete` / `plan-delete`。
  - 记忆引擎实机：`memory_set` 后 `memory_search("kafka broker 地址")` → 命中 0.4392、`memory_search("sk-stg 前缀")` → 命中 0.7503、`memory_search("量子纠缠 超导 拓扑")` → **「没有匹配…的记忆」**（拒答门生效）；探针条目已从 `data.json` 清掉。
  - 删除能力实机：`plan_delete` 删掉立法追踪计划（返回「已删除计划，共移除 16 项任务」）与 r2 测试计划（3 项），随后 `coord.json` plans=1、看板只显示当前计划、27 项任务全 done；面板 Playwright 截图确认 27 个任务卡删除按钮 + 1 个计划删除按钮 + 计划下拉只剩「全部计划 / 六本豆mcp-v2」。
  - 打包：`app.asar` **828,467 B** sha256 `3d7d272a…`；`Setup.exe` **296,062,976 B** sha256 `59b656cd…`（桌面同名安装包一致）；Kali 包 `liubendou-mcp-v2-linux-x64.tar.gz` **36,689,867 B** sha256 `88f73889…`（远端桌面与沙箱同包，sha256 一致）。
- **踩坑记录**：① 多路召回里**时间通道绝不能进召回**——第一版把时间也做成一路，导致「量子纠缠 超导 拓扑」这类完全无关的查询也能召回；修法是候选只取 BM25/RM3/键关联三路有相关性证据的，并且必须命中至少一个强词（单字不算）。② SSE 解析要用「按行取 `data:` 整行 JSON.parse」，用正则 `data:\s*(\{.*?\})` 会被嵌套大括号截断，表现为 `tools/list` 计数为 0（假阴性）。③ `node --check` 直接校验面板 `<script>` 会报「await is only valid in async functions」——面板脚本是普通 script 且顶层有 await，**这是校验方式的问题不是语法错误**，要把脚本包进 `async function(){}` 再校验。④ 用 `replace()` 往函数体里插代码时，新内容必须把**函数头一起带上**，否则 `async function loadBoard() {` 被吃掉，后面整段 await 变成语法错误。⑤ MCP 应用重启后旧 session id 失效，报 `Session not found` → 重新 initialize 取新 session。
- **未验证项**：① 面板上**真手点删除**按钮的交互（按钮已通过 DOM 探测确认 27 个任务卡 + 1 个计划按钮都在、接口已实机验证），但截图是无头浏览器渲染，未人工点击确认弹窗与 toast 的观感；② 新记忆引擎在**数据量很大**（数万条记忆）时的延迟与召回质量未做压测，当前只在小样本与实机小库上验证；③ 混元 2.0（hymemory）那条旧路径的代码仍保留可切换，但本次未再验证它的 sidecar（它此前就没启用过）；④ Kali 包重建后仍**未在真 Kali 机器上实测**（同 T25 的限制）。

## [0.3.1] - 2026-10-28 · T27 公网入口失败修复（SSH 失败自动切 Cloudflare + 真就绪验证）

- **改了什么**：
  1. **SSH 不再假就绪**：`src\dist\core\tunnel-manager.js` 去掉「进程起来 2 秒即 ready」；改为每 1.5 秒探测公网入口，必须响应头出现本机 MCP 指纹 `access-control-expose-headers: mcp-session-id` 才标记 ready，最多等 18 秒。SSH 端口不可达（`freeRemotePort` 的 ConnectTimeout 判网络失败）时直接跳过 SSH，不再白等 21 秒 TCP 重试。
  2. **Cloudflare 快速隧道兜底**：SSH 退出 / 18 秒没回源 → 自动启动 `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate --protocol http2`，从累计输出解析 `https://*.trycloudflare.com`，回源验证通过后标记 ready；进程退出自动重连（最多 3 次，成功清零）；`stop()` / `stopSync()` 同时收掉自己起的 ssh 与 cloudflared，只动自己 spawn 的进程。状态新增 `mode` / `url` / `fallback`。
  3. **检测接口修 HTTPS**：`src\dist\core\app.js` 的 `/api/tunnel-check` 按 URL 协议选择 `http` / `https`（修掉 `Protocol "https:" not supported`）；入口检测把 502/503/504 判失败（反代后面没隧道）；隧道进程检测区分 SSH / Cloudflare；一键修复在 Cloudflare 模式下重建备用隧道而不是去检查服务器 Caddy；导出 `__tunnelProbes` 供回归测试。
  4. **面板**：`src\dist\panel\index.html` 公网地址标签随模式变化（Cloudflare 显示「临时地址，重启后会变」）；修复检测步骤标题取错字段（`s.name` → `s.label`）；强制重建确认文案补充兜底说明；隧道启动中显示「启动中」并每 4 秒自动重试（最多 15 次 / 60 秒），不再停在重启后第一次失败。
  5. **去重计划任务**：`MCP-ReverseTunnel` 已 `Disable-ScheduledTask`（State=Disabled，未删除，可一条命令恢复），避免和应用的隧道管理器抢 8765。
  6. **新测试**：`tests\p16_tunnel_fallback_test.js` 13 项——临时地址解析、反向隧道识别、cloudflared 可执行文件、回源指纹、普通 200/502 不算回源、HTTPS 不再报协议不支持、MCP 握手 200+session id、Cloudflare 进程存活探针、面板启动中自动重试。
  7. **版本 / 安装器**：0.3.0 → **0.3.1**；`tools\build-installer.js` 与 `installer\Installer.cs` 里陈旧的 `VER = "0.2.0"` 一并改为 `0.3.1`。
- **为什么**：用户报 0.3.0 公网入口「连接失败：超时 8000 ms」。实机诊断：本机到 `<your-server-ip>` 的 22/80/443/8765/65000 **全部 TCP 超时**，ICMP 正常；本机到 github.com:22、example.com:80 正常；8 个外部节点到 22/80 约 0.2 秒 → 是**目标 IP 的 TCP 被拦**（服务器按来源 IP 封禁或校园网/链路拦截，尚未区分），不是 0.3.0 单点 bug。但应用侧确实存在两个真问题：2 秒假就绪、检测接口不支持 https，于是补上兜底与真验证，保证 SSH 不通时仍有可用的公网入口。
- **怎么回滚**：`tunnel-manager.js` / `app.js` / `panel\index.html` 回退到 0.3.0 版本；`config.js` / `package.json` 版本改回 `0.3.0` 后重新 `asar pack` + 重编安装器。Cloudflare 兜底可在面板设置取消「自动开启公网隧道」即不启动；计划任务用 `Enable-ScheduledTask -TaskName 'MCP-ReverseTunnel'` 恢复（任务定义未动）。记忆与看板数据未改，无需迁移。
- **验证**：
  - 六套回归全绿：P11-ALL-PASS / P12-ALL-PASS / p13 `total=13 failed=0` + VERIFY_ALL_PASS / P14-ALL-PASS / P15-ALL-PASS / P16-ALL-PASS（13 项）。
  - 独立状态机实测：SSH 端口 5 秒内判超时 → 启动 cloudflared → 约 20 秒 `phase=ready, mode=cloudflare` → `stop()` 成功收掉 cloudflared。
  - 实机换包后：`/api/status` `version=0.3.1, mcpUp=true`；`/api/tunnel-check` **四项全过**（本机 MCP / Cloudflare 进程 / 公网入口回源 HTTP 404 / 公网 MCP 握手 HTTP 200 + session id）；新 asar 面板含 `publicModeLabel` / `s.label` / 「Cloudflare 快速隧道」/ 启动中自动重试；`tools/list` = **69**。
  - 启动期快照与自动刷新：应用 17:09:31 重启后，面板 17:09:40 仍显示「异常」是 9 秒时的启动中状态；17:11 后端已 `ok=true, mode=cloudflare`。19:56 再次重启后实机验证新面板（无头 Edge）：0–6 秒「待检测」，9 秒「启动中」，15 秒自动变「正常」，四项全过，未点击「重新检测」。
  - 打包：`app.asar` **845,690 B** sha256 `21BB3860959FBFC6FCEBDC302D54E7A5E60F38C666F951B503A2B1D57D59EF32`；`Setup.exe` **296,080,384 B** sha256 `D06A477A8303E29DFA108FEB119B5D57512AB6F5BD5248A3F004B5166EA4CC0B`（桌面同名安装包一致）。
- **踩坑记录**：① 「进程活着 = 隧道就绪」是错的——ssh.exe 可能卡在 TCP 连接或远端端口绑定失败；必须用公网回源指纹验证。② `/api/tunnel-check` 第一版只引了 `node:http`，遇到 Cloudflare 的 https 地址直接报 `Protocol "https:" not supported`；必须按协议选模块，p16 专门加了回归。③ cloudflared 的地址横幅可能被分块读到，解析要用**累计输出**而不是单个 chunk。④ `Stop-Process` 强杀应用不会走退出钩子，会留下 cloudflared 孤儿；正常退出走 `stop()`，本次已手工清理强杀留下的孤儿。⑤ 服务器 8765 的旧 sshd 会残留占用，重建前要 `fuser -k 8765/tcp`。⑥ 应用重启后面板的首次检测早于 Cloudflare 建立（约 20 秒），会停在「异常」；已改为启动中显示「启动中」+ 4 秒自动重试，而不是只跑一次。
- **未验证项**：① SSH 根因仍需手机热点测试或服务器侧 `fail2ban-client status sshd` / `csf -g <出口 IP>` / `ufw status` 确认；② 托盘「退出」未人工点击验证（路径已接线，`stop()` 单独实测会收子进程）；③ Cloudflare 快速隧道地址每次重启会变，未做固定域名/命名隧道（需 Cloudflare 账号与域名接入）；④ ready 之后无常驻健康轮询，运行中掉线靠面板「重新检测 / 一键修复」。

## [0.3.2] - 2026-10-31 · T28 AI 记忆三层机制（完成门禁 + 就近提醒 + 自动活动日志）

- **改了什么**：
  1. **完成门禁**：`coord.js taskComplete()` 新增 `CHECKPOINT_MISSING` 校验（放在证据/验收项/复核之后，旧错误语义不变）——该 agent 从未写过 project_checkpoint 且未传 `no_checkpoint_reason` 时拒绝收尾；`task_complete` schema 增加可选 `no_checkpoint_reason` 逃生参数（纯测试/无项目场景用）。
  2. **就近提醒**：`tools.js callTool()` 对 write_file / apply_patch / edit_file / git_commit 成功后按「未交接写计数」在返回值末尾追加提醒（`noteWriteAndHint`，每满 8 次一条）；`project_checkpoint` 盖章（`stampCheckpoint`，schema 新增可选 `agent_id`）时清零计数并记录事件。
  3. **自动活动日志**：`project_context` 末尾新增「最近活动（自动记录）」节（`journalText(15)`，取 coord 事件流最近 15 条）——模型全忘了，接手者也能看到最近谁改了什么。
  4. **测试**：p11 成功路径补逃生参数并新增 `complete-requires-checkpoint` 断言（/CHECKPOINT_MISSING/）；p12 两处成功路径补逃生参数。
  5. **版本**：0.3.1 → **0.3.2**（config.js / src/package.json / tools/build-installer.js / installer/Installer.cs）。
- **为什么**：用户指出模型经常在收尾时忘记写长期记忆/交接。靠提示词劝不可靠，改为机制：不写交接就收不了尾（门禁）+ 在上下文最末端就近提醒（recency 效应）+ 机器自动记活动（兜底，模型全忘了也不丢事实）。
- **怎么回滚**：`coord.js` / `tools.js` / `config.js` / `src/package.json` / `tests/p11` / `tests/p12` / `CHANGELOG.md` 回退到 0.3.1 版本后重新 `asar pack`。coord.json 新增字段（agents.lastCheckpointAt / writesSinceCheckpoint）为增量，旧代码忽略，无需数据迁移。
- **验证**：`node --check` ×3 OK；六套回归全绿（P11-ALL-PASS 含新断言 / P12-ALL-PASS / p13 total=13 failed=0 / P14-ALL-PASS / P15-ALL-PASS / P16-ALL-PASS）；证据归档 `docs/runs/T28-20261031/summary.md`。实机探测（部署前）确认运行实例不热加载 src/dist/core，须重打包 asar + 重启。
- **部署记录（2026-10-31）**：`npx @electron/asar@3 pack src` 出包 848,559 B，用 schtasks 一次性任务执行「停进程→换 asar→重启」（脱离应用进程树，防换包中途被杀）。**第一次部署换了 `Desktop\...\dist-portable\resources\app.asar` 但 `/api/status` 仍报 0.3.1**（日志 `ops-tmp\t28-deploy.log`）——根因见踩坑⑦；第二次同时替换安装版与便携版两份 asar 后 `/api/status` 报 **version=0.3.2**（日志 `ops-tmp\t28-deploy2.log`）。门禁活体测试通过：新探针 agent 的 task_complete 被拒（CHECKPOINT_MISSING）→ project_checkpoint（带 agent_id）盖章 → 再 task_complete 成功；就近提醒与盖章清零同层代码一并生效。部署后临时脚本与计划任务已清场（部署日志保留作证据）。
- **踩坑记录（本次新增）**：⑦ **这台机器有两份 app.asar**：安装版 `%LOCALAPPDATA%\Programs\六本豆mcp-v2\resources\app.asar`（实际运行加载的）与源码树 `Desktop\六本豆mcp-v2\dist-portable\resources\app.asar`（便携副本）。交接报告 §4-2 所述「外部协作服务直接加载 src\dist\core 即时生效」不适用于该 Electron 实例；**部署必须换安装版那份（稳妥起见两份都换）**，且换包后以 `/api/status` 的 version 字段为唯一生效判据。


## 2026-11-06（P17）本地 Agent 桥接器 + 原生对话工作台（与六本豆工作台深度联动）
- **改了什么**：
  - 新增 `src\dist\core\agentBridge.js`：提供 `/api/agent-bridge/status`、`/api/agent-bridge/handshake`、`/api/agent-bridge/exec`、`/api/agent-bridge/sync`、`/api/agent-bridge/command` 五个本机回环接口；内置 `buildHandshakePrompt` 工具协议生成器；执行本地工具时自动补齐缺省 `why`、自动为 `write_file`/`edit_file` 计算已有文件的 `expected_version`（sha256）、自动为 `run_command`/`job_start` 放行 `allow_non_ascii`。
  - 修改 `src\dist\core\app.js`：接入 `createAgentBridge`，并对 `/api/agent-bridge/*` 放行 `moz-extension://` 与 `chrome-extension://` 扩展来源及 `OPTIONS` 预检请求。
  - 修改 `src\dist\panel\index.html`：在纯白极简设计下新增「本地 Agent」页面（`page-agent`，支持 `?tab=agent` 直达），包含浏览器实例在线状态、对话消息流实时同步、指令输入框（`Ctrl+Enter` 发送、可选附带工具握手协议）、快捷指令以及本地工具自动执行记录面板。
  - 新增 `tests\p17_agent_bridge_test.js`：覆盖状态查询、握手协议生成、扩展跨域 `write_file`/`edit_file`/`read_file` 自动版本补齐执行、浏览器 `sync` 与桌面端 `command` 双向队列及面板 DOM 检查。
- **为什么**：让六本豆工作台的 Arena `/agent` 模型无需公网隧道即可通过本机 `127.0.0.1:8766` 直接读写电脑文件与执行命令，并配合工作台的「隐身模式（无浏览器窗）」实现原生本地 Agent 软件体验。
- **怎么回滚**：删除 `src\dist\core\agentBridge.js` 与 `tests\p17_agent_bridge_test.js`，还原 `src\dist\core\app.js` 与 `src\dist\panel\index.html`，重新执行 `npx @electron/asar@3 pack src dist-portable\resources\app.asar`。
- **验证**：`p11`–`p17` 全套测试 ALL PASS；`dist-portable\resources\app.asar` 与 `%LOCALAPPDATA%\Programs\六本豆mcp-v2\resources\app.asar` 已同步更新并实测 `http://127.0.0.1:8766/api/agent-bridge/status` 返回 `ok=true, toolCount=88`。


## 2026-11-07 · 按用户授权移除服务器旧报道系统

- **改了什么**：备份后移除 `/opt/lenen` 与 `lenen.service`，清理原站点对 8800 的代理；域名暂返回明确的 HTTP 503 停用提示。保留 Caddy、SSH、sing-box，尚未接入新 MCP。
- **为什么**：用户明确表示服务器旧应用已不再使用，可删除，后续为轻量 MCP 复用现有服务器。
- **怎么回滚**：本机 `Documents/ServerBackups/lenen-cleanup-20261107T115945Z-f558d5a5.tar.gz` 保存完整应用、数据、原启动单元与 Caddy 配置，SHA256 已核对。具体说明见证据文档。
- **验证**：服务器旧目录和单元已不存在，8800 无监听，保留服务 active；服务器本机及公网域名均返回预期停用响应。证据：`docs/runs/SERVER-CLEANUP-20261107/summary.md`。


## 2026-11-07 · 六本豆 Lite 0.2 桌面 GUI、多用户中转及按任务长期记忆

- **改了什么**：在 `lite/` 精简重写 Windows GUI 与 MCP 客户端，增加任务记忆、概况版本和执行日志；复制提示词采用用户给出的授权 + curl 格式。独立中转网关已部署到原服务器，支持一次性邀请码、独立设备身份、任务派生凭据、自动重连和设备撤销。生成约 39 MB 的纯净 Windows 分发包。
- **为什么**：用户需要云端 Agent 控制本机，同时给其他人安装后控制各自电脑；原版体积较大，单机环回地址无法完成云端调用。
- **怎么回滚**：退出 Lite，停止网关，恢复 `/root/Caddyfile.before-liubendou-gateway-20261107` 并校验 reload。旧版本地程序和数据仍保留；旧服务器应用另有本机完整备份。
- **验证**：严格类型编译通过，19 项 Node 检查全通过；从服务器以真实 curl 经公网实际完成本机文件、命令、记忆和概况调用；原生 GUI 响应正常，Windows 剪贴板确认是可用公网连接格式；分发包未带个人、设备或管理员凭据。物理多机及长期压测未做。证据：`docs/runs/LITE-20261107/summary.md`。

## 2026-11-07 · 独立离线授权工具

- **改了什么**：新增原生单文件 `lite六本豆授权工具.exe` 并放到桌面，支持设备申请、永久/限期签发、用户备注和许可证校验。签发资料保存在本机文档目录，程序集嵌入开源依赖和 MIT 许可。
- **为什么**：用户明确要求桌面上单独的小工具，授权离线处理，无需增加授权网关。
- **怎么回滚**：关闭并移除桌面工具和说明；保存签发资料备份。旧客户端和服务器不受影响。
- **验证**：37 项检查通过，包含实际单文件进程签发、客户端授权类互通、错误设备/到期/篡改拒绝和 GUI 布局。当前尚未将授权类接入 Lite 0.2 GUI，完整加密客户端未发布；两台物理机未验证。证据：`docs/runs/LITE-ISSUER-20261107/summary.md`。

## 2026-11-07 · Lite 0.3 离线授权、代码加密与 EXE 安装分发

- **改了什么**：将设备申请导出、许可证导入、设备绑定、永久/限期和续期入口接入客户端 GUI。后端及五个工具模块 AES-256-GCM 加密，原生入口 Obfuscar 混淆，使用签名清单和私有管道加载。生成约 26.5 MiB 的当前用户 EXE 安装包，带快捷方式和保留用户数据的卸载入口。
- **为什么**：用户要求分发成 EXE，让各自电脑安装客户端，配合独立授权工具离线签发；不增加在线授权网关。
- **怎么回滚**：卸载新客户端，使用保留的 0.2 包；用户数据与文档目录签发资料保留。未修改服务器部署配置。
- **验证**：Node 回归 19 项、签发/授权库 37 项、加密成品 24 项、安装卸载 18 项全部通过；从服务器用实际 curl 经公网完成加密客户端的文件、命令、记忆和概况操作。不同物理机、标准账户及长期压测未做。证据：`docs/runs/LITE-RELEASE-20261107/summary.md`。

## 2026-11-07 · 邀请码管理入口与许可证命名

- **改了什么**：本机新版客户端接入既有管理员配置，“接入与提示词”在本机激活前后均可生成分享邀请码。授权工具默认文件名为“用户备注_机器码.lic”，备注为空时只用机器码；切换申请清空备注，验签弹窗显示用户和机器码。
- **为什么**：用户找不到邀请码入口，且多人同时发来申请时需要容易区分许可证归属。
- **怎么回滚**：恢复本机页面备份、移除新增管理员配置并恢复旧授权工具；签发密钥保持原样。
- **验证**：遵照用户“不要再测试”的要求，本次未跑测试；仅编译并更新桌面工具和本机页面。分发安装包不包含管理员配置。记录：`docs/runs/LITE-OWNER-20261107/summary.md`。

## 2026-11-08 · 邀请码独立入口

- **改了什么**：本机客户端左侧栏增加“生成邀请码（管理员）”独立入口，按用户请求实际生成一个邀请码并保存到桌面文本。
- **为什么**：用户仍找不到接入页面内的按钮，需要直接入口和马上可用的码。
- **怎么回滚**：恢复 `ops-tmp/lite-invite-sidebar-before-20261108` 中的本机页面备份；保留原管理员配置。
- **验证**：不跑测试；本次正常生成请求成功，文件已写入桌面，码值未进入聊天或文档。


## 2026-11-08 · Lite 0.3.1 分发包提示词
- **改了什么**：连接默认模板加入用户指定的“Python urllib 请求会被拦截”；连接地址和任务交接仍动态生成。已保存的旧版原样默认模板随升级更新，自定义模板保留。版本号及分发使用说明同步为 0.3.1。
- **为什么**：用户提供新版“复制给 Agent”提示词，要求更新分发包，让 Agent 直接使用 curl 接入。
- **怎么回滚**：保留并使用桌面原 0.3.0 安装包；连接模板可手动移除新增句子。保留现有任务数据与授权资料。
- **构建与验证范围**：重建加密、签名、混淆产物及 EXE；按用户要求不运行测试、不安装试用、不连接样例 MCP。产物哈希与构建记录见 docs/runs/LITE-PROMPT-20261108。


## 2026-11-08 · Lite 0.3.2 按用户指令操作目录
- **改了什么**：文件、补丁、搜索与命令 cwd 允许工作区外路径，工作区作为默认起点；复制交接和 MCP 初始化共同说明用户当前指令优先、已有授权不重复确认。工具、界面与使用说明同步，session_info 提供本机用户目录。
- **为什么**：用户明确要求“文件放桌面等操作允许，以人为主，不写死目录边界”。
- **怎么回滚**：使用桌面保留的 0.3.1 安装包，保留任务数据与离线授权。源文件备份在 ops-tmp/lite-boundary-20261108。
- **构建与验证范围**：TypeScript 编译与加密、签名、混淆构建完成，生成 0.3.2 EXE 分发包。已有边界回归预期随新行为更新；按用户要求未运行测试、未安装或启动新产物。证据及哈希见 docs/runs/LITE-BOUNDARY-20261108。


## 2026-11-08 · Lite 0.3.3 复制粘贴离线签发
- **改了什么**：客户端增加复制申请和粘贴激活；签发器增加申请码识别、签发并复制、期限记忆、记录搜索、重新复制及设备续期。归档公开申请和许可证，保留原文件入口及签发密钥。更新桌面两个 EXE 与说明。
- **为什么**：用户同意简化多人离线授权流程，减少选择和传输文件的步骤。
- **怎么回滚**：使用保留的 0.3.2 安装包及 ops-tmp/lite-license-copy-20261108 中旧签发工具；保留任务、设备和签发资料。
- **构建与验证范围**：签发器、TypeScript、受保护客户端、混淆及 NSIS 构建完成。按用户要求不运行测试、不安装或启动新产物。产物哈希见 docs/runs/LITE-LICENSE-COPY-20261108/artifact.json。


## 2026-11-08 · Arena 视频下载浏览器扩展
- **改了什么**：新增桌面 Arena 视频下载助手，后台识别视频与附件，浏览器完成下载后由轻量本机组件保存到真实桌面，提供去重、记录与重试。交付文件夹和 ZIP，注册当前用户专用桌面保存组件。
- **为什么**：用户说明要下载 Arena 生成的视频，浏览器窗口隐藏，要求改用浏览器扩展并尽量直接保存桌面。
- **怎么回滚**：移除本扩展及核对过的当前用户 com.liubendou.arena_video NativeMessagingHosts 注册项，保留下载的视频。未改已有扩展或浏览器全局下载目录。
- **构建与验证范围**：扩展 JavaScript 与 C# 编译、打包完成；按要求未测试。浏览器扩展尚需首次手动加载，未声称已实际下载视频。记录见 docs/runs/ARENA-VIDEO-20261108。


## 2026-11-09 · 按用户要求回滚 Arena 插件
- **改了什么**：撤销新增 Arena 视频插件的三项 Native Messaging 注册，将其桌面目录、ZIP 和本机组件移出原位置到 ops-tmp/arena-plugin-rollback-20261109；停止界面预览。
- **为什么**：用户明确说明插件任务不属于本次工作，要求立即回滚。
- **怎么回滚**：此次为撤回误入范围的插件工作，不自动恢复；如将来再次需要，须有用户新的明确任务。保留六本豆客户端及离线签发流程更新。
- **核对范围**：三个注册项已撤销，桌面插件与安装组件原路径已不存在，0.3.3 安装包与授权工具仍在。自动审批拒绝删除后采用可恢复移动，没有绕过删除拦截。


## 2026-11-09 · Mac 原生客户端与云端双架构体验包
- **改了什么**：实现 Swift/WKWebView Mac 窗口、菜单栏、原生桥、钥匙串设备身份、离线激活和 Windows 本机签发器的 Mac 兼容格式；适配 Mac 路径和端口操作，生成加密构建资源及私有 GitHub 云端 DMG 工作流。
- **为什么**：用户没有 Mac，要求通过云端构建可分发的临时签名体验包，同时坚持 Windows 本机离线签发。
- **怎么回滚**：Windows 现有安装包及原签发器保留，通用版另存。源码及原签发工具备份在 ops-tmp/lite-macos-before-20261109；可停用云端工作流。签发私钥及用户数据不改变。
- **构建范围**：Windows 签发器与 TypeScript 编译完成，GitHub run 42568882326 的 arm64 与 x64 编译打包均成功。按用户要求不运行测试、不启动 Mac 应用、不做 Apple 公证；实际 Mac 行为未验收。证据见 docs/runs/LITE-MACOS-20261109。
