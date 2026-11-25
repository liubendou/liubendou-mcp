# 记忆系统评估（Hy-Memory 2.0 · lite 模式）· docs/memory-eval.md

- 日期：2026-10-25 · 任务 T8（P7） · 结论：**链路、延迟、回退、往返全部达标；召回准确率受 embedding 端点限制，留待真实端点补测（见「未验证项」）**

## 一、评估设置

| 项 | 值 |
|---|---|
| 语料 | `tests/eval-corpus.json`：**25 条真实交接记录**（来源：交接包 docs 01-架构与链路 / 02-源码改造 / 03-打包部署 / 05-踩坑清单 / 06-任务书 / 07-改造记录，每条含 key、正文、自然语言查询） |
| 引擎 | hy-memory 2.0.5（venv：`v2\venv-hy`），`python -m hy_memory.server`，`MEMORY_MODE=lite`（D1：只用 Embedding，不调 LLM） |
| 存储 | 本地 chroma（向量）+ sqlite（缓存/历史），数据目录随测试临时目录 |
| embedding | **mock 服务**（`tools/mock-embed-server.js`，OpenAI 兼容 /v1/embeddings，确定性哈希向量，256 维）——原因见「未验证项」 |
| 评估器 | `tools/eval-live.js`（写入→25 查询召回→反向导出比对→杀 sidecar 回退），一键可复现 |

## 二、写入（25 条迁移写入）

| 指标 | 结果 |
|---|---|
| 成功 | **25/25**（fail=0） |
| 总耗时 | 5925 ms（含 jieba 分词首次加载 ~2.9s） |
| 单条耗时 | p50 **125 ms**，p95 141 ms（首条 2875 ms 为一次性初始化） |

## 三、召回准确率与延迟（25 个自然语言查询，top-5）

| 基线（dummy 向量） | top1 | top3 | 未进 top5 | 检索延迟 p50 / p95 / max |
|---|---|---|---|---|
| A：字节直方图（64 维） | 9/25（36%） | 12/25（48%） | 10 | **11 / 12 / 16 ms** |
| B：字符 n-gram 哈希（256 维） | 7/25（28%） | 8/25（32%） | 17 | **10 / 12 / 15 ms** |

- 检索延迟含「查询向量化（mock HTTP）+ chroma 检索 + 排序」全链路，**p50 约 10 ms**，非常快。
- 失败查询集中在术语/长文本（如「改应用名要改哪几个文件」「协调状态存在哪个文件」）：dummy 向量不含真实语义，无法区分相近主题；两次不同 dummy 的波动（top1 28–36%）本身就是 embedding 质量主导召回的证据。
- **真实语义召回率必须用真实 embedding 端点补测**（见「未验证项」），补测脚本无需改动，填好 `hy-memory.env` 后把 `eval-live.js` 里 mock 换掉即可。

## 四、迁移往返一致性

| 检查 | 结果 |
|---|---|
| 反向导出 25 条 | 25/25（fail=0） |
| key/value/updatedAt 与原始 memory 区 | **逐字节一致**（JSON 全等，keyFieldsIdentical=true） |
| 原 data.json | 未被改写（迁移只读 + 时间戳备份；p6 测试另有 sha256 前后一致断言） |
| 自动化 | `tests/p6-roundtrip.test.js` 12 断言 ALL PASS |

## 五、断连/回退测试（sidecar 挂掉不崩溃）

真 sidecar（venv python）运行中直接 kill 后：

| 操作 | 结果 |
|---|---|
| memory_set | 成功，`usedFallback=true`（数据落 data.json） |
| memory_get | 成功（26 条含原有记录，格式与 0.1.0 一致） |
| memory_delete | 成功返回 true |
| 崩溃 | **无** |

自动化覆盖：`tests/p5-sidecar.test.js` 19 断言（含 add 未确认成功→回退、断连→回退、恢复→续写）+ `tests/memory-parity.test.js` 17 断言（json 后端与 0.1.0 逐字节一致），ALL PASS。

## 六、安装说明

1. `python -m venv v2\venv-hy` → `venv-hy\Scripts\python.exe -m pip install hy-memory==2.0.5`（Windows 有官方轮子：chromadb 1.5.9、kuzu 0.11.3，实测 INSTALL OK）
2. 可选 `v2\hy-memory.env` 填 embedding 端点（KEY=VALUE）：
   `MEMORY_EMBEDDER_API_KEY=...`、`MEMORY_EMBEDDER_BASE_URL=...`、`MEMORY_EMBEDDER_MODEL=...`、`MEMORY_EMBEDDING_DIMS=...`
3. 应用配置 `memoryBackend: "hymemory"` 后重启，sidecar 由 `hySidecar.js` 自动拉起（默认 `MEMORY_MODE=lite`）；无 python/hy_memory/端点故障时自动回退 json，不崩。

## 七、成本说明

- **LLM 成本：0**（lite 模式不调 LLM，符合 D1）。
- **embedding 成本**：仅写入 1 次/条 + 查询 1 次/条的向量化调用；25 条评估共 50 次调用级。按常见 embedding 价格（如 text-embedding-3-small 约 $0.02/1M tokens）日常使用每月通常 < ¥1；用本地/内网 embeddings 端点则为 0。
- **本地存储成本**：chroma/sqlite 落盘，25 条约数 MB 以内；无云存储费。

## 八、隐私说明

- 记忆正文与向量**全部存本机**（data.json + hy-memory 数据目录），sidecar 只监听 127.0.0.1。
- 联网外发仅限：把文本发往**用户配置的 embedding 端点**做向量化（lite 模式下无任何 LLM 外发）；若用本地/内网端点则无外发。
- `hy-memory.env` 含密钥，勿提交/外传；评估用的 mock 端点无密钥。
- 迁移备份 `data.json.bak-p6-*` 与导出 `memory-export.json` 含记忆明文，留在本机数据目录。

## 九、未验证项（最终报告同步标注）

1. **真实 embedding 端点下的召回准确率**：本机现无任何 LLM/embedding 配置（%APPDATA%\LocalAIConsole\config.json 无相关字段），评估用 mock 向量测的是链路与延迟，语义召回率（预计显著高于 28–36%）**待用户提供 embedding 端点后补测**（与 D1 一致：LLM 抽取「后续再说」，Embedding 本就要用）。
2. **pro/ultra 模式**（LLM 抽取/归并）按 D1 未测。
3. 长期运行的记忆老化/演化（evolve）未测。
