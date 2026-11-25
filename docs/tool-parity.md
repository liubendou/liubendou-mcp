# v2 工具对照表（tool-parity.md）

> 生成：2026-10-25。基线：交接包 `源码\dist\core\tools.js` 实测提取（63 个工具定义 + 8 个隐藏别名），另加 coord.js 的 11 个协调层工具。
> 状态含义：**不变** = 名称/参数/返回结构与 0.1.0 完全一致；**换后端** = 接口不变，底层记忆实现改为后端适配层（默认 JSON，行为一致）；**别名** = 隐藏别名，仍可调用。

## 一、主工具（63 个）

| # | 工具名 | 参数 | v2 状态 | 备注 |
|---|---|---|---|---|
| 1 | `read_file` | path | 不变 |  |
| 2 | `write_file` | path | 不变 |  |
| 3 | `edit_file` | path | 不变 |  |
| 4 | `find_files` | pattern | 不变 |  |
| 5 | `search_content` | pattern | 不变 |  |
| 6 | `run_command` | command | 不变 |  |
| 7 | `command_output` | id | 不变 |  |
| 8 | `run_tests` | cwd | 不变 |  |
| 9 | `wait_for_http` | port | 不变 |  |
| 10 | `port_status` | port | 不变 |  |
| 11 | `kill_port` | port | 不变 |  |
| 12 | `edit_preview` | path | 不变 |  |
| 13 | `worktree_create` | task | 不变 |  |
| 14 | `worktree_remove` | task | 不变 |  |
| 15 | `job_start` | command | 不变 |  |
| 16 | `job_poll` | job_id | 不变 |  |
| 17 | `command_cancel` | id | 不变 |  |
| 18 | `todo_list` | （无） | 不变 |  |
| 19 | `todo_add` | text | 不变 |  |
| 20 | `todo_update` | id | 不变 |  |
| 21 | `todo_delete` | id | 不变 |  |
| 22 | `set_todos` | items, text | 不变 |  |
| 23 | `update_plan` | title | 不变 |  |
| 24 | `report_progress` | text | 不变 |  |
| 25 | `memory_get` | key | 换后端 | 记忆后端适配层（JsonMemoryBackend 默认） |
| 26 | `memory_set` | key | 换后端 | 记忆后端适配层（JsonMemoryBackend 默认） |
| 27 | `memory_delete` | key | 换后端 | 记忆后端适配层（JsonMemoryBackend 默认） |
| 28 | `read_image` | path | 不变 |  |
| 29 | `inbox_list` | （无） | 不变 |  |
| 30 | `inbox_read` | name | 不变 |  |
| 31 | `outbox_write` | name | 不变 |  |
| 32 | `outbox_list` | （无） | 不变 |  |
| 33 | `read_files` | （无） | 不变 |  |
| 34 | `get_diagnostics` | path | 不变 |  |
| 35 | `git_status` | cwd | 不变 |  |
| 36 | `git_diff` | path | 不变 |  |
| 37 | `git_log` | n | 不变 |  |
| 38 | `git_commit` | message | 不变 |  |
| 39 | `code_definition` | name | 不变 |  |
| 40 | `code_references` | name | 不变 |  |
| 41 | `project_overview` | path | 不变 |  |
| 42 | `project_context` | path | 不变 |  |
| 43 | `project_checkpoint` | path | 不变 |  |
| 44 | `project_note` | path | 不变 |  |
| 45 | `project_memory_search` | query | 不变 |  |
| 46 | `skill_list` | （无） | 不变 |  |
| 47 | `skill_read` | name | 不变 |  |
| 48 | `skill_save` | name | 不变 |  |
| 49 | `web_fetch` | url | 不变 |  |
| 50 | `web_search` | query | 不变 |  |
| 51 | `web_download` | url | 不变 |  |
| 52 | `screenshot` | x | 不变 |  |
| 53 | `ui_list_windows` | （无） | 不变 |  |
| 54 | `ui_focus` | title | 不变 |  |
| 55 | `ui_click` | x | 不变 |  |
| 56 | `ui_type` | text | 不变 |  |
| 57 | `ui_key` | keys | 不变 |  |
| 58 | `env_info` | （无） | 不变 |  |
| 59 | `list_dir` | path | 不变 |  |
| 60 | `lsp` | name | 不变 |  |
| 61 | `upload_file` | filename | 不变 |  |
| 62 | `download_file` | path | 不变 |  |

| 63 | `apply_patch` | patch, edits, expected_versions, why | 不变 | 修改文件首选；支持精确替换与 unified diff |

## 二、隐藏别名（8 个，不出现在 tools/list，但仍可调用）

| 别名 | 指向 | v2 状态 |
|---|---|---|
| `search_files` | `search_content` | 不变 |
| `get_command_output` | `command_output` | 不变 |
| `cancel_command` | `command_cancel` | 不变 |
| `list_skills` | `skill_list` | 不变 |
| `use_skill` | `skill_read` | 不变 |
| `save_skill` | `skill_save` | 不变 |
| `memory_context` | `memory_get` | 换后端（同 memory_get） |
| `memory_checkpoint` | `memory_set` | 换后端（同 memory_set） |

## 三、协调层工具（coord.js，11 个）

| 工具名 | v2 状态 | 备注 |
|---|---|---|
| `agent_register` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `plan_create` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `task_status` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `task_claim` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `task_complete` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `task_block` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `task_progress` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `board` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `reserve_files` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `release_files` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `list_reservations` | 不变 | 多 AI 协调 / 文件预占 / git 串行锁 |
| `session_info` | 不变 | 提示词版本确认 |

## 四、汇总

- 主工具 63（含 `apply_patch`，其描述为多行拼接，生成脚本初版漏掉已补）+ 隐藏别名 8 + 协调层 11 = **82 个名称**，v2 全部保留，**0 个删除**。
- 参数与返回结构全部保持兼容；仅 memory_* 系列（含 2 个别名）底层换为后端适配层，默认 JSON 后端下行为与 0.1.0 一致。
- 验收方式：v2 启动后 `tools/list` 数量与名称同上逐项比对；memory_* 用同组键值做前后返回对照。