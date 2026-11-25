# 提案：v3 协作机制增强（借鉴 Claude harness 方法论）

> 状态：P1、P2 已于 2026-10-25 实施（coord.js + 面板 + 单测，见 CHANGELOG P11）；P3-P5 供决策，未实施。来源：《Claude 工程能力与长程任务分析》可复制清单 → 映射到六本豆mcp 的协作/看板能力。
> 原则：先做「让完成可验证」的（1、2），再做锦上添花的（3-5）。

## P1 任务验收项（acceptance items）进任务模型 【建议先做，M】

- **改什么**：任务对象增加 `acceptance: [{id, text, pass, evidence}]`；`task_complete` 校验全部 `pass=true` 且 `evidence` 非空，否则拒绝；`task_status` 输出每项 ✓/✗。
- **落在哪**：协作服务的任务模型 + API（task_complete/task_status 参数）；app 看板「详情」里显示验收项三态。
- **为什么**：治"AI 自称完成"。今天 task_complete 只有一段 evidence 文本，无法机器校验。
- **草案**：
  - `task_complete {agent_id, project, task_id, evidence}` → 增加 `acceptance_results: [{id, pass, evidence}]`，服务端与任务定义比对。
  - 创建任务时（plan/task 创建接口）可选带 `acceptance` 数组；老任务无验收项时维持现状。
- **风险**：老数据兼容（无 acceptance 字段=跳过校验）；验收项文案由谁定（建议：创建者/用户定，执行 AI 不可改）。

## P2 生成/评估分离：独立验收通道 【建议先做，M】

- **改什么**：任务完成前增加"复核"环节——另一 agent（或同 agent 换会话）按用户路径跑验证（如 verify.ps1、真开界面），产出 `docs/verify-<task>.md` 存档后才准勾验收项。
- **落在哪**：作业协议（已在 `docs/ai-protocol.md` 落地）+ 协作服务可选 `task_review` 状态位；产品侧可延伸为「验收助手」agent 角色。
- **为什么**：自评系统性偏乐观；P9 的 verify 独立存档已证明这个模式好用。
- **风险**：小任务全走复核会慢——按风险分级（涉及产物/删除/验证的任务必复核，文档类抽查）。

## P3 Sprint contract：开工前先谈"什么算 done" 【S】

- **改什么**：任务创建时强制填写「完成定义」= 验收项 + 测试方式（P1 的子集）；认领时展示给执行 AI。
- **落在哪**：协作服务任务创建校验 + 看板展示。
- **风险**：过重的模板会让人懒得建任务——保持两行内。

## P4 进度文件/检查点标准化 【S】

- **改什么**：统一 `<task>-progress.txt` / `p9-done.txt` 这类现场文件的命名与落位（`C:\Users\Administrator\` ASCII 临时 → 归档进 `v2\docs\`），配合现有 task_progress。
- **落在哪**：约定 + ops-notes/ai-protocol 文档；可选在 app 加「现场文件归档」小工具。
- **风险**：无，纯约定成本。

## P5 工具防呆与收敛（poka-yoke） 【L，长期】

- **改什么**：82 工具做一次"少而清晰"评审（是否有重叠/该合并的参数）；参数自解释、统一绝对路径；危险操作（stop/delete/覆盖）强制二次确认参数。
- **落在哪**：app 工具层 + 文档；配合 tool-parity 表迭代。
- **风险**：动工具面=兼容性大事，需保留隐藏别名（参照 P2 工具对照表的 0 删减纪律），排期另议。

## 建议实施顺序

1. **P1 + P2**（让"完成可验证、验收不自签"先成立）→ 2. P3/P4（低成本顺手）→ 3. P5 随大版本评估。
每一项实施时按惯例记 CHANGELOG（改了什么/为什么/怎么回滚/验证），验收项预先写好再动手。
