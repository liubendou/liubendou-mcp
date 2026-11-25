# 借鉴 Claude 的工程能力：六本豆 v2 落地映射

> 来源：`桌面\Claude工程能力与长程任务分析.md`（2026-10-25 读）
> 目标：把 Claude「让模型能连续干完一件事」的做法，落成**六本豆自己的机制**，而不是抄界面。
> 状态：本次（T20-UI-SKILLS）已落地 8 项，4 项列为后续待办。

## 0. Claude 的核心回路（提炼成 4 步）

1. **初始化**：确认工作目录 → 读进度/笔记 → 跑一次基线 → **只挑一个 feature**
2. **编码**：一次只做一个 feature，小步改，改完立刻验证
3. **验证**：独立 evaluator 真点真跑，按硬阈值判定，而不是执行者自己宣布「做完了」
4. **交接**：提交代码 + 写进度文件 + 写交接说明，让下一棒能无缝接上

## 1. 逐条借鉴映射

| # | Claude 做法 | 六本豆原来的问题 | 本次落地（T20） | 状态 |
|---|---|---|---|---|
| 1 | 工具集**少而清晰** | AI 根本调不到 `task_accept`/`report_progress`/`skill_*`/`git_*`，"生成—评估"闭环是断的 | EXPOSED 29 → 66，新增 37 个**真实存在**的工具；`toolCatalog` 增 `exposed` 标记；面板工具页显示「AI 可见 / 不可见」+ 过滤 | ✅ 已落地 |
| 2 | 生成与评估**分离** | 只有执行者自己说"做完了"，没有独立评估口 | 暴露 `task_accept`（生成）/ `task_review`（评估，附验收阈值）/ `task_claim`（认领） | ✅ 已落地 |
| 3 | 进度可观测 | 面板只有零散日志，看不出「是什么任务、到哪了」 | 新增 `report_progress`；新面板**焦点卡**：任务标题 / 目标 / 进度环 / 正在做 / 下一步 / 步骤条 / 验收项 chips / 阻塞 / 最近证据 | ✅ 已落地 |
| 4 | 结构化计划 | 计划散在对话里，过期就丢 | 暴露 `update_plan` / `todo_list` / `todo_add` / `todo_update` / `todo_delete` / `set_todos`；面板保留并可视化「规划步骤」 | ✅ 已落地 |
| 5 | 上下文压缩策略 | 长会话全靠模型自觉 | 内置 skill 约定压缩时**必须保留**：架构决策 / 未解 bug / 最近 5 个文件；配套 `project_memory_search`、`memory_get/set` | ✅ 已落地 |
| 6 | 绝对路径 + poka-yoke | 一致性护栏本来就有 | 保留 `resolveInRoots` / `guardWrite`（路径级 sha256 预占）/ `applyExactEdits` 原子改写；**不为了"多"而暴露 GUI 自动化类工具** | ✅ 已落地 |
| 7 | 独立 evaluator + 硬阈值 | 没有回归基线，改坏看不出来 | `tests\p11_coord_acceptance_test.js` / `p12_security_contract_test.js` / `p13_mcpfix_regression_test.js` / **新增 `p14_ui_skills_test.js`** 作为硬阈值 | ✅ 已落地 |
| 8 | 内置流程（initializer / coding） | AI 每次开工都从零摸索 | **5 个内置 skill**：`session-startup` / `bugfix-workflow` / `feature-workflow` / `review-workflow` / `handoff-workflow`；用**真实 v2 工具名**；升级安全、绝不覆盖用户内容 | ✅ 已落地 |
| 9 | 长程记忆与结构化笔记 | 记忆只有 json backend 的 get/set | skill 约定「结论落记忆、进展落进度、下次开工先读」；`project_overview` / `project_memory_search` 暴露 | ◐ 部分 |
| 10 | 评测驱动（SWE-bench / Terminal-Bench / OSWorld） | 没有外部评测基线 | 先用 p11–p14 契约测试当本地基线（ALL-PASS 才允许打包） | ◐ 部分 |
| 11 | sprint 合同（"done" 的定义） | 没有统一验收口径 | 面板焦点卡带「验收项」chips；`task_review` 走显式验收阈值 | ◐ 部分 |
| 12 | 子代理并行 | MCP 支持多 agent，但缺统一认领纪律 | `task_claim` + 既有路径级预占锁（sha256），避免两个 agent 写同一文件 | ◐ 部分 |

## 2. 五个内置 skill 与 Claude 回路的对应

| 内置 skill | 对应 Claude 环节 | 关键约束（写进 SKILL.md） |
|---|---|---|
| `session-startup` | 初始化 | 先 `pwd` → 读进度 → 跑基线 → **只挑一个任务**；禁止一次开多活 |
| `bugfix-workflow` | 编码（缺陷） | 复现 → 定位（`code_definition`/`code_references`）→ 最小改 → 验证 → 记录 → 提交 |
| `feature-workflow` | 编码（新功能） | 先写验收项再动手；一次一个 feature；不动既有测试 |
| `review-workflow` | 独立评估 | 以 `task_review` + 硬阈值判定，不接受"我觉得好了" |
| `handoff-workflow` | 交接 | 写清：做了什么 / 还剩什么 / 踩过的坑 / 下一步可直接执行的命令 |

内置 skill 的落盘方式：`dataDir\skills\<name>\SKILL.md`（frontmatter + 正文）。
种子里带 `seed:` 版本标记 → 只在「缺失」或「旧种子」时覆盖，**用户改过的技能永远不动**。

## 3. 本次明确**没有**借鉴的（避免过度工程）

- **不自研 agent 调度器**：Claude 的编排能力由 Anthropic 侧提供；六本豆只做「工具面 + 契约 + 面板」，自己再造一层调度只会多一个失败面。
- **不引入向量检索**：当前知识量级下，关键词检索 + 结构化笔记足够；先把 skill 约定写清楚。
- **不引入多智能体编排引擎**：已有 MCP 多 agent + 路径级预占锁，再叠一层会放大冲突面。
- **不把 UI 做成"炫技"**：动效服务于「一眼看清是什么任务、到哪了」，不做无意义动画。

## 4. 后续待办（按优先级）

- **P1** 记忆评估闭环：`docs\memory-eval.md` 已有基础，待补「结论是否被真正引用」度量。
- **P1** sprint 合同模板化：把「done 的定义」做成可复用的验收清单，落到 `feature-workflow` 与面板验收项。
- **P2** 面板验收项与 `task_review` 阈值联动（点验收项 → 直接触发评估）。
- **P2** 焦点卡「最近证据」直接嵌入评测链接（p11–p14 报告）。

## 5. 相关文件

- 内置技能实现：`src\dist\core\skills.js`
- 工具暴露面：`src\dist\core\tools.js`（`EXPOSED` / `toolCatalog().exposed`）
- 技能接口：`GET /api/skills`（`src\dist\core\app.js`）
- 新面板：`src\dist\panel\index.html`
- 契约测试：`tests\p14_ui_skills_test.js`
- 原始分析：`桌面\Claude工程能力与长程任务分析.md`
- 微交互设计参考：`桌面\教育教学Agent-微交互与动效设计-v0.1.md`
