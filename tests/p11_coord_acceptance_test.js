"use strict";
/** P1/P2 单测：验收项（acceptance_items + task_accept）与独立复核（task_review，生成/评估分离）。
 *  运行：node tests/p11_coord_acceptance_test.js */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");

const coreDir = process.env.CORE_DIR || path.join(__dirname, "..", "src", "dist", "core");
const coord = require(path.join(coreDir, "coord.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p11-coord-"));
coord.init(tmp);
const c = { dataDir: tmp, cfg: { get: () => ({ workspaceRoots: [tmp] }) } };
const tools = Object.fromEntries(coord.makeTools().map((t) => [t.name, t]));
const call = (name, args) => tools[name].handler(args, c);
const mustFail = async (name, args, re, tag) => {
  try {
    await call(name, args);
    throw new Error("EXPECTED-REJECT-BUT-PASSED " + tag);
  } catch (e) {
    assert.ok(re.test(String((e && e.message) || e)), tag + ": unexpected error: " + ((e && e.message) || e));
    console.log("  [reject-ok]", tag);
  }
};

(async () => {
  const regA = String(await call("agent_register", { name: "impl-1", role: "implementer" }));
  const regB = String(await call("agent_register", { name: "rev-1", role: "reviewer" }));
  const A = regA.match(/ag_[0-9a-zA-Z]+/)[0];
  const B = regB.match(/ag_[0-9a-zA-Z]+/)[0];
  console.log("agents:", A, B);

  const planText = String(await call("plan_create", {
    goal: "p11 test",
    tasks: [
      { title: "带验收项", acceptance: "两项都要过", acceptance_items: [{ id: "a1", text: "第一项验证" }, { id: "a2", text: "第二项验证" }], steps: ["zuo"] },
      { title: "旧式任务", acceptance: "文字验收", steps: [] },
    ],
  }));
  const T1 = planText.match(/T\d+/)[0];
  console.log("T1 =", T1);

  await mustFail("task_complete", { agent_id: A, task_id: T1, evidence: "这是足够长的证据文本内容" }, /验收项未全过/, "complete-before-accepts");
  await mustFail("task_accept", { agent_id: A, task_id: T1, item_id: "a1", evidence: "duan" }, /10/, "short-evidence");
  console.log("  [ok]", String(await call("task_accept", { agent_id: A, task_id: T1, item_id: "a1", evidence: "单测输出 PASS #1 见 tests/p11" })));
  await mustFail("task_complete", { agent_id: A, task_id: T1, evidence: "这是足够长的证据文本内容" }, /a2/, "complete-with-one-left");
  console.log("  [ok]", String(await call("task_accept", { agent_id: A, task_id: T1, item_id: "a2", evidence: "单测输出 PASS #2 见 tests/p11" })));
  await mustFail("task_complete", { agent_id: A, task_id: T1, evidence: "这是足够长的证据文本内容" }, /review|fu he/, "complete-without-review");
  await call("task_claim", { agent_id: A, task_id: T1 });
  await mustFail("task_review", { agent_id: A, task_id: T1, verdict: "pass", report: "自己复核自己不该被允许" }, /不能自签/, "self-review-while-owner");
  await call("task_block", { agent_id: A, task_id: T1, reason: "测试释放 owner" });
  await mustFail("task_review", { agent_id: A, task_id: T1, verdict: "pass", report: "我勾的项自己复核不允许" }, /勾过|不能自己复核/, "ticker-self-review-after-block");
  await call("task_claim", { agent_id: A, task_id: T1 });
  console.log("  [ok]", String(await call("task_review", { agent_id: B, task_id: T1, verdict: "pass", report: "按用户路径验证两项均有佐证", report_path: "docs/verify-T1.md" })));
  console.log("  [ok]", String(await call("task_complete", { agent_id: A, task_id: T1, evidence: "全部单测通过 tests/p11_coord_acceptance_test.js", no_checkpoint_reason: "p11 契约测试，无真实项目交接可写" })));

  const board = String(await call("board", {}));
  const m = board.match(/(T\d+) 旧式任务/) || board.match(/\[.\] (T\d+)/);
  const T2 = m[1];
  console.log("T2 =", T2);
  await mustFail("task_complete", { agent_id: A, task_id: T2, evidence: "旧任务直接完成行为不变验证" }, /CHECKPOINT_MISSING/, "complete-requires-checkpoint");
  console.log("  [ok]", String(await call("task_complete", { agent_id: A, task_id: T2, evidence: "旧任务直接完成行为不变验证", no_checkpoint_reason: "p11 契约测试，无真实项目交接可写" })));
  console.log("P11-ALL-PASS");
})().catch((e) => {
  console.error("P11-FAIL:", (e && e.stack) || e);
  process.exit(1);
});
