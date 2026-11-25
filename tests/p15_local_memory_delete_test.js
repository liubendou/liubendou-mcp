"use strict";
/**
 * T26 回归：零模型记忆引擎（多通道召回 + 加权 RRF + 置信门）与 任务/计划 删除。
 * 运行：node tests/p15_local_memory_delete_test.js
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");

const coreDir = process.env.CORE_DIR || path.join(__dirname, "..", "src", "dist", "core");
const coord = require(path.join(coreDir, "coord.js"));
const mb = require(path.join(coreDir, "memoryBackend.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p15-"));
coord.init(tmp);
const c = { dataDir: tmp, cfg: { get: () => ({ workspaceRoots: [tmp] }) } };
const tools = Object.fromEntries(coord.makeTools().map((t) => [t.name, t]));
const call = (name, args) => tools[name].handler(args, c);

function mockStore() {
  const m = new Map();
  return {
    getMemory(k) {
      if (k === undefined) { const o = {}; for (const [a, b] of m) o[a] = { value: b.value, updatedAt: b.updatedAt }; return o; }
      const v = m.get(k);
      return v ? { value: v.value, updatedAt: v.updatedAt } : {};
    },
    setMemory(k, v) { m.set(k, { value: String(v), updatedAt: new Date().toISOString() }); },
    deleteMemory(k) { return m.delete(k); },
  };
}

(async () => {
  /* ── 1. 零模型记忆引擎 ── */
  const be = new mb.LocalMemoryBackend(mockStore(), {});
  await be.set("kali_start", "启动命令 liubendou-mcp，面板 http://127.0.0.1:8766/，MCP 端口 8765");
  await be.set("api_key", "staging 的 key 前缀是 sk-stg-0041");
  await be.set("db_conn", "生产数据库 10.0.0.5:5432，密码在 vault");
  await be.set("old_note", "2020 年的旧会议纪要，跟现在无关");

  const h1 = await be.search("面板端口", 3);
  assert.ok(h1.length && h1[0].key === "kali_start", "「面板端口」应命中 kali_start，实际 " + JSON.stringify(h1.map((x) => x.key)));
  const h2 = await be.search("sk-stg 前缀", 3);
  assert.ok(h2.length && h2[0].key === "api_key", "「sk-stg 前缀」应命中 api_key");
  const h3 = await be.search("5432 数据库", 3);
  assert.ok(h3.length && h3[0].key === "db_conn", "「5432 数据库」应命中 db_conn");
  const none = await be.search("量子纠缠 超导 拓扑", 3);
  assert.strictEqual(none.length, 0, "无关查询必须返回空（置信门），实际 " + JSON.stringify(none.map((x) => x.key)));
  // 通道元数据：至少命中词法通道
  assert.ok(h1[0].channels && h1[0].channels.lexical === true, "命中项应带通道标记");
  // 键值格式与 json 模式一致
  const all = await be.get();
  assert.ok(all.kali_start && all.kali_start.value && all.kali_start.updatedAt, "get 返回格式应与 json 模式一致");

  /* ── 2. task_delete ── */
  const reg = String(await call("agent_register", { name: "impl", role: "implementer" }));
  const A = reg.match(/ag_[0-9a-zA-Z]+/)[0];
  await call("plan_create", {
    agent_id: A, project: tmp, goal: "删除功能验证",
    tasks: [{ title: "要删掉的任务", acceptance: "验证删除" }, { title: "保留的任务", acceptance: "验证保留" }],
  });
  const before = String(await call("board", { project: tmp }));
  assert.ok(/要删掉的任务/.test(before), "建计划后看板应有该任务");
  const del = String(await call("task_delete", { agent_id: A, project: tmp, task_id: "T1", reason: "T26 测试删除" }));
  assert.ok(/已删除任务 T1/.test(del), "task_delete 应返回删除结果，实际 " + del);
  const after = String(await call("board", { project: tmp }));
  assert.ok(!/要删掉的任务/.test(after), "删除后看板不应再有该任务");
  assert.ok(/保留的任务/.test(after), "其它任务不应被误删");
  // 删不存在的任务要报错
  let threw = false;
  try { await call("task_delete", { agent_id: A, project: tmp, task_id: "T999", reason: "x" }); } catch (e) { threw = true; }
  assert.ok(threw, "删除不存在的任务应抛错");

  /* ── 3. plan_delete ── */
  const pd = String(await call("plan_delete", { agent_id: A, project: tmp, reason: "T26 测试删计划" }));
  assert.ok(/已删除计划/.test(pd), "plan_delete 应返回删除结果，实际 " + pd);
  const gone = String(await call("board", { project: tmp }));
  assert.ok(!/保留的任务/.test(gone), "计划删除后看板应为空");

  console.log("P15-ALL-PASS");
})().catch((e) => { console.error("P15-FAIL", (e && e.stack) || e); process.exit(1); });
