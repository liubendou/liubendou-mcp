# 六本豆mcp v2 · README-v2

> v2 = 0.1.0 全功能保留 + 记忆后端替换为 Hy-Memory 2.0（可切换可回退）+ 看板简化。
> 本文件为 v2 的安装、回滚、后端切换、数据迁移说明；工程见 `docs/plan.md`，变更与回滚逐条见 `CHANGELOG.md`。

## 1. 安装 / 运行

1. 产物目录：`v2\dist-portable\`（独立便携版，顶层 exe 为 `六本豆mcp-v2.exe`）。
2. 双击 `六本豆mcp-v2.exe` 即可运行；8765/8766 端口、隧道、MCP、全部 82 个工具与 0.1.0 行为一致（工具对照 `docs/tool-parity.md`）。
3. Hy-Memory sidecar（可选，见 §3）：首次自动创建 `venv-hy` 并安装 `hy-memory==2.0.5`（Windows Server 2022 已实测；2.0.4 兜底）。
4. 验证：`交接包\工具\verify.ps1` 五项检查（本产物已实测 6 通过 / 0 失败，存档 `docs/verify-p9.md`）。
5. **不要**把本目录覆盖到 `Desktop\本地AI遥控台-0.1.0-win-x64-便携版\`（旧版目录保持只读）。

## 2. 回滚

- 旧版 0.1.0 便携版目录**从未被改动**（P9 基线比对 95 文件一致），直接运行旧版 exe 即是完整回滚。
- 记忆后端默认就是 JSON（`data.json` 为唯一事实源），v2 的行为回滚 = 不启用 hymemory 后端（配置见 §3）。
- 逐项变更回滚方法见 `CHANGELOG.md` 每条目的「怎么回滚」。

## 3. 记忆后端切换（JSON ↔ Hy-Memory）

- 开关：`config.json` → `memoryBackend`：`json`（默认）/ `hymemory`。
- `hymemory` 需要本地 Python sidecar（`tools/hy-sidecar.ps1`，服务 `POST /api/v1/add|search`、`DELETE /api/v1/memories/{id}`，默认 MEMORY_MODE=lite）。
- LLM/embedding 密钥放 `hy-memory.env`（模板见该文件注释；**只走本机文件，不要写进聊天/UI**）。当前交付为 **lite 模式（仅 Embedding）**；无 embedding 端点时用 mock 向量（`tools/mock-embed-server.js`）做评估。
- **自动回退**：sidecar 不可用/超时 → 自动落回 JSON 内存，接口返回 `usedFallback:true`，**不抛错不中断业务**（已实测 kill 进程即回退）。

## 4. 数据迁移

- `node tools/migrate-memory.js`：data.json → Hy-Memory 导入；键映射存 `hy-keymap.json`（key→hy-memory id/updatedAt）；迁移前自动备份 `data.json.bak-p6-<时间戳>`。
- `node tools/export-memory.js`（`--merge` 可与 data.json 合并）：Hy-Memory → data.json 反向导出。
- 往返实测 25/25 `keyFieldsIdentical=true`（见 `docs/memory-eval.md`）。

## 5. 看板（已简化）

- 默认只显示：当前任务名（最新的进行中任务）+ 子步骤三态行（✓ 已完成灰色 / ⟳ 进行中（全文件唯一 @keyframes 旋转）/ ○ 未开始浅色）；无任务时显示「暂无任务」。
- 统计、任务列表、队伍、文件预占、动态等全部在默认折叠的「详情」里。
- 零外部 CDN/字体/脚本（离线可用）。

## 6. 文档索引

| 文件 | 内容 |
| --- | --- |
| `CHANGELOG.md` | 每步「改了什么/为什么/怎么回滚/验证」 |
| `docs/plan.md` | 计划与状态（已确认版） |
| `docs/tool-parity.md` | 82 工具名称对照（含 8 隐藏别名 + 11 coord） |
| `docs/spike-p4.md` | Hy-Memory Windows 可行性验证 |
| `docs/memory-eval.md` | 记忆评估：25 条真实交接记录、召回率、延迟、回退 |
| `docs/verify-p9.md` | dist-portable verify.ps1 验证存档 |

## 7. 已知未验证项

- **真实 embedding 端点**（配置项存在，密钥未提供）：语义召回率、真实向量下的检索质量未验证（现为 mock 向量基线，见 memory-eval）。
- Hy-Memory pro/ultra 模式（需 LLM 密钥，按约定「后续再说」）与 memory aging 未验证。
