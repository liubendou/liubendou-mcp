"use strict";
/** P3+P5 单测：verify 验收方式字段（coord）+ 危险分级/防呆/脱敏（security）。
 *  运行：node tests/p12_security_contract_test.js */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");

const coreDir = process.env.CORE_DIR || path.join(__dirname, "..", "src", "dist", "core");
const sec = require(path.join(coreDir, "security.js"));
const coord = require(path.join(coreDir, "coord.js"));

// ---------- P5：security 纯函数 ----------
assert.strictEqual(sec.classifyCommand("Get-Process | Out-String"), "");
assert.strictEqual(sec.classifyCommand("Remove-Item x.txt -Force"), "B");
assert.strictEqual(sec.classifyCommand("Remove-Item foo -Recurse -Force"), "A");
assert.strictEqual(sec.classifyCommand("del /s /q C:\\temp"), "A");
assert.strictEqual(sec.classifyCommand("Stop-Process -Name app -Force"), "B");
assert.strictEqual(sec.classifyCommand("schtasks /delete /tn X /f"), "A");
assert.strictEqual(sec.classifyCommand("git push --force origin main"), "A");
assert.strictEqual(sec.classifyCommand("Format-Table -AutoSize | Out-String"), "");
assert.strictEqual(sec.classifyCommand("Get-ChildItem | Format-List"), "");
assert.strictEqual(sec.classifyCommand("format c: /fs:ntfs"), "A");
assert.strictEqual(sec.classifyCommand("Remove-Item x.txt -Force"), "B");
assert.strictEqual(sec.classifyCommand("Remove-Item foo; Get-ChildItem -Raw"), "B");
console.log("  [ok] classify A/B/C");

assert.throws(() => sec.assertAsciiCommand("echo 中文"), /非 ASCII/);
sec.assertAsciiCommand("echo hello");
sec.assertAsciiCommand("echo 中文", true);
console.log("  [ok] ascii gate + escape");

assert.throws(() => sec.commandGate("Remove-Item foo -Recurse", undefined, false), /A类危险命令/);
assert.ok(sec.commandGate("Remove-Item foo -Recurse", "YES", false).note.includes("授权"));
assert.ok(sec.commandGate("Remove-Item foo -Recurse", undefined, true).note.includes("授权"));
const b = sec.commandGate("Stop-Process -Name x", undefined, false);
assert.ok(b.note.includes("缩托盘"));
assert.strictEqual(sec.commandGate("Get-Process", undefined, false).note, "");
console.log("  [ok] commandGate reject/authorize/reminder");

const s1 = sec.scrubSecrets('status {"token":"abc123SECRET","mcpUrl":"http://127.0.0.1:8765/mcp/GTH6OUl_zf-pEGVSpKxl2pJq58"}');
assert.ok(!s1.includes("abc123SECRET") && !s1.includes("GTH6OUl"), s1);
assert.ok(s1.includes("***"));
const pemHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const pemFooter = ["-----END", "PRIVATE", "KEY-----"].join(" ");
const s2 = sec.scrubSecrets(pemHeader + "\nMIIEvQ\n" + pemFooter);
assert.ok(s2.includes("REDACTED") && !s2.includes("MIIEvQ"));
const s3 = sec.scrubSecrets("mcp-session-id: 8949b7e6-1111-2222-3333-444455556666");
assert.ok(!s3.includes("8949b7e6"), s3);
console.log("  [ok] scrubSecrets");

const na = sec.needsApproval("ask", "run_command", { command: "Remove-Item foo -Recurse", confirm: "YES" });
assert.strictEqual(na.need, false);
const nb = sec.needsApproval("ask", "run_command", { command: "Remove-Item foo -Recurse" });
assert.strictEqual(nb.need, true);
console.log("  [ok] needsApproval preauth bypass");

// ---------- P3：coord verify 字段 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p12-coord-"));
coord.init(tmp);
const c = { dataDir: tmp, cfg: { get: () => ({ workspaceRoots: [tmp] }) } };
const tools = Object.fromEntries(coord.makeTools().map((t) => [t.name, t]));
const call = (name, args) => tools[name].handler(args, c);

(async () => {
  const reg = String(await call("agent_register", { name: "p12-impl", role: "implementer" }));
  const A = reg.match(/ag_[0-9a-zA-Z]+/)[0];
  await call("plan_create", {
    goal: "p12",
    tasks: [
      { title: "with verify", acceptance: "must pass", verify: "run tests/p12 and check output", steps: ["s1"] },
      { title: "no verify here", acceptance: "legacy style", steps: [] },
    ],
  });
  const st = String(await call("task_status", { project: tmp, agent_id: A }));
  assert.ok(st.includes("验收方式：run tests/p12 and check output"), "task_status shows verify");
  const board = String(await call("board", {}));
  assert.ok(board.includes("（缺验收方式）") && !board.includes("with verify（缺验收方式）"), "board marks missing verify only");
  const t1 = st.match(/当前任务：(T\d+)/)[1];
  const t2 = board.match(/(T\d+) no verify here/)[1];
  await call("task_complete", { agent_id: A, task_id: t1, evidence: "verify field task complete works fine", no_checkpoint_reason: "p12 契约测试" });
  const st2 = String(await call("task_status", { project: tmp, agent_id: A }));
  assert.ok(st2.includes("验收方式：（未写"), "missing verify hinted on claim");
  console.log("  [ok] verify field display + hint, T1 =", t1, "T2 =", t2);
  await call("task_complete", { agent_id: A, task_id: t2, evidence: "legacy task direct complete still works", no_checkpoint_reason: "p12 契约测试" });
  console.log("P12-ALL-PASS");
})().catch((e) => {
  console.error("P12-FAIL:", (e && e.stack) || e);
  process.exit(1);
});
