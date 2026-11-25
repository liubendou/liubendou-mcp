# P4 · Hy-Memory Windows 可行性 spike 记录

- 日期：2026-10-25（欧洲/阿姆斯特丹）
- 任务：T5（P4 spike），验收=记录安装结果与冒烟输出；失败则停止替换并写原因
- 结论：**可行，继续替换（未触发停止条件）**

## 环境

- Windows 10（10.0.26100）x64，Python 3.12.10（venv：`v2\venv-hy`）
- 锁定 `hy-memory==2.0.5`（D3；2.0.4 为备选，本次未用到）

## 1. 安装结果（验证风险 R1：原生依赖）

```
pip install hy-memory==2.0.5  → INSTALL-DONE EXIT=0
PY 3.12.10 ... [MSC v.1943 64 bit (AMD64)]
CHROMADB 1.5.9
KUZU 0.11.3
HYMEMORY-IMPORT-OK
```

- `chromadb-1.5.9-cp39-abi3-win_amd64.whl`、`kuzu-0.11.3-cp312-cp312-win_amd64.whl` 官方 Windows 轮子直接可用，无需编译
- 全部依赖（jieba/langdetect 由 sdist 构建）安装、导入无报错

## 2. lite 模式冒烟（D1：Embedding only，不用 LLM）

注入式 dummy 哈希向量 embedder（不依赖网络），`HyMemoryClient(mode='lite')`：

```
client init OK 0.973s（VectorStore=chroma collection=agent_memories_64，Cache=sqlite，Writer&Reader ready mode=lite）
add OK 0.631s len=30
add OK 0.014s len=27
search OK 0.004s
search result head: memories.normal[0] = {'content': '交接说明：服务端口 443 是 sing-box，绝对不能动', 'score': 0.7455, ...}
list OK 0.003s
```

- 查询「服务端口 443 能不能动」→ top1 命中正确条目（score 0.7455）
- `get(memory_id)` / `update` / `delete` 均返回 `success: true`（delete 返回 `deleted_count: 1`）

## 3. 无 embedder 时的行为（自动回退依据）

- `HyMemoryClient(mode='lite')` 初始化**不报错**（懒加载 embedder）
- `add()` **不抛异常**，但内部日志 `Missing credentials ... OPENAI_API_KEY`，写入失败被吞掉，数据不落库
- ⇒ P5 的 HyMemoryBackend 必须检查 `add` 返回的 `success`/`error_code` 判定回退；双写架构（data.json 为事实源）下 JSON 侧数据不受影响（tests/memory-parity.test.js 的 fallback 断言 ALL PASS）

## 4. sidecar server（P5 直接使用，不自写 Python 服务）

- `python -m hy_memory.server --port 19527`（hy-memory 2.0.5 自带 stdlib server）在 Windows 正常启动
- `GET /healthz → 200 {"status": "ok"}`；无 embedder 凭据也能启动（客户端懒初始化），写入请求软失败

## 5. 对 P5 设计的修正（实测结论）

1. `list_memories(user_id=...)` 只返回 `vdb` 层，lite 下 `l1_raw` 记录不在其中 ⇒ **key→memory_id 映射改用本地 keymap 文件**（`hy-keymap.json`，随 MEMORY_DATA_DIR 存放），不依赖 list
2. `add()` 成功返回 `{success:true, memory_id, elapsed_ms, ...}`；写入后必须校验 `success===true`，否则 `usedFallback=true`
3. `search(query, user_ids=[...], limit=)` 返回 `memories.normal[]`（memory_id/content/score）——P7 评估的召回接口
4. `get/update/delete` 以 memory_id 为键；`search` 不可按 metadata 精确过滤（冒烟中未见 custom 透出），keymap 方案不依赖它

## 6. 遗留事项（未验证项，最终报告将标注）

- **真实 embedding 端点未配置**：本机 `%APPDATA%\LocalAIConsole\config.json` 无任何 LLM/embedding 字段。lite 模式默认走 OpenAI 兼容 embeddings API（环境变量 `MEMORY_EMBEDDER_API_KEY` / `MEMORY_EMBEDDER_BASE_URL` / `MEMORY_EMBEDDER_MODEL`，或 `OPENAI_API_KEY`）。本次冒烟用注入式 dummy 向量验证链路；**P7 评估的「真实召回准确率」需用户提供 embedding 端点后补测**（与 D1 一致：LLM 抽取不用，Embedding 用）
- 若最终仍无 embedding 端点：hymemory 后端会在写入时自动回退 JSON（不崩），但语义召回能力无法生效——评估文档将如实记录此状态
