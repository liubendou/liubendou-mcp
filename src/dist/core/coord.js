"use strict";
/**
 * 协调层：任务计划（plan / task）、任务租约、文件预占、AI 注册、看板数据。
 * 状态保存在数据目录的 coord.json（原子写：先写 .tmp 再 rename）。
 * 主进程是唯一写入方，所有操作同步执行，因此单进程内天然串行。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const security_1 = require("./security");

const PROMPT_VERSION = "2026.10.26-r2";
const TASK_LEASE_MS = 15 * 60 * 1000;
const RESERVE_DEFAULT_MS = 30 * 60 * 1000;
const EVENT_CAP = 2000;
const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "outbox_write"]);
/* ── 任务 / 计划删除（T26）──────────────────────────────────────────
 * 用途：清掉写错、过期、或者长期挂着没人管的老任务/老计划。
 * 规则：删除必须带原因并写进事件流（可追溯）；正在被**他人**执行的任务需要 force=true。
 */
function deleteTaskById(dir, taskId, reason, opts) {
    const plan = getPlan(dir);
    const id = String(taskId || "").trim();
    if (!id)
        return { ok: false, text: "task_id 不能为空" };
    const idx = plan.tasks.findIndex((t) => t.id === id);
    if (idx < 0)
        return { ok: false, text: "没有找到任务 " + id };
    const t = plan.tasks[idx];
    if (t.owner && opts && opts.ownerOnly && t.owner !== opts.ownerOnly && !(opts && opts.force)) {
        return { ok: false, text: "任务 " + id + " 正由 " + t.owner + " 执行中；如确需删除请传 force=true" };
    }
    plan.tasks.splice(idx, 1);
    for (const x of plan.tasks) {
        if (Array.isArray(x.deps))
            x.deps = x.deps.filter((d) => d !== id);
    }
    plan.updatedAt = iso(now());
    addEvent((opts && opts.agentId) || "panel", "task-delete", "删除任务 " + id + "（" + (t.title || "无标题") + "）" + (reason ? "；原因：" + reason : ""));
    save();
    return { ok: true, text: "已删除任务 " + id + "（" + (t.title || "无标题") + "），该计划剩余 " + plan.tasks.length + " 项" };
}
function deletePlanById(dir, reason, opts) {
    const key = projKey(dir);
    const plan = state.plans[key];
    if (!plan)
        return { ok: false, text: "这个项目下没有计划" };
    const n = plan.tasks.length;
    const doing = plan.tasks.filter((t) => t.status === "doing").map((t) => t.id);
    if (doing.length && opts && opts.ownerOnly && !(opts && opts.force)) {
        return { ok: false, text: "计划里还有进行中的任务（" + doing.join("、") + "）；如确需删除请传 force=true" };
    }
    delete state.plans[key];
    addEvent((opts && opts.agentId) || "panel", "plan-delete", "删除计划（" + n + " 项任务）" + (reason ? "；原因：" + reason : ""));
    save();
    return { ok: true, text: "已删除计划，共移除 " + n + " 项任务" };
}
exports.deleteTaskById = deleteTaskById;
exports.deletePlanById = deletePlanById;

const COORD_TOOLS = new Set(["agent_register", "plan_create", "task_status", "task_claim", "task_complete", "task_accept", "task_review", "task_block", "task_progress", "task_delete", "plan_delete", "board", "reserve_files", "release_files", "list_reservations", "session_info"]);

let stateFile = null;
let state = null;

function init(dataDir) {
  if (stateFile) return;
  stateFile = path.join(dataDir, "coord.json");
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    state = null;
  }
  if (!state || typeof state !== "object") state = {};
  state.agents = state.agents || {};
  state.plans = state.plans || {};
  state.reservations = state.reservations || [];
  state.events = state.events || [];
}
function save() {
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, stateFile);
}
function now() {
  return Date.now();
}
function iso(t) {
  return new Date(t).toISOString();
}
function newId(prefix) {
  return prefix + crypto.randomBytes(4).toString("hex");
}
function addEvent(agent, kind, text) {
  state.events.push({ t: iso(now()), agent: agent || "-", kind, text: String(text).slice(0, 500) });
  if (state.events.length > EVENT_CAP) state.events.splice(0, state.events.length - EVENT_CAP);
}
function projKey(dir) {
  return path.resolve(dir).toLowerCase();
}
function getPlan(dir) {
  const key = projKey(dir);
  if (!state.plans[key]) state.plans[key] = { dir: path.resolve(dir), goal: "", tasks: [], nextId: 1, updatedAt: iso(now()) };
  return state.plans[key];
}
/** 读取时把过期的任务租约释放回待办 */
function releaseExpired(plan) {
  for (const t of plan.tasks) {
    if (t.status === "doing" && t.leaseUntil && t.leaseUntil < now()) {
      addEvent(t.owner, "lease-expired", `任务 ${t.id} 租约过期，已释放`);
      t.status = "todo";
      t.owner = null;
      t.leaseUntil = null;
      plan.updatedAt = iso(now());
    }
  }
}
function touch(agentId) {
  if (agentId && state.agents[agentId]) state.agents[agentId].lastSeen = iso(now());
}
const SUMMARY_KEYS = ["path", "command", "query", "task_id", "reason", "name", "title", "text", "new_step", "step", "evidence"];
function briefInput(input) {
  const parts = [];
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    if (v !== undefined && v !== null && v !== "") parts.push(k === "evidence" ? "evidence=" + String(v).slice(0, 60) : String(v).slice(0, 140));
  }
  if (Array.isArray(input.paths)) parts.push(input.paths.slice(0, 3).join(", "));
  if (typeof input.patch === "string") {
    const m = input.patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
    if (m) parts.push(m[1]);
  }
  return parts.join(" · ").slice(0, 240);
}
/** 记录一次工具调用：更新该 AI 的「正在做什么」，并写入动态流 */
function recordActivity(agentId, name, input) {
  if (!agentId || !state.agents[agentId]) return;
  const a = state.agents[agentId];
  a.lastSeen = iso(now());
  if (COORD_TOOLS.has(name)) return; // 协调工具自己会写事件
  const summary = briefInput(input || {});
  a.current = { tool: name, summary, at: iso(now()) };
  addEvent(agentId, "tool", summary ? `${name}：${summary}` : name);
  save();
}
/** 写交接盖章：project_checkpoint 成功后调用，记录该 agent 最近交接时间并清零未交接写操作计数 */
function stampCheckpoint(agentId) {
  if (agentId && state.agents[agentId]) {
    state.agents[agentId].lastCheckpointAt = iso(now());
    state.agents[agentId].writesSinceCheckpoint = 0;
  }
  addEvent(agentId || "-", "checkpoint", "project_checkpoint 写交接");
  save();
}
/** 写类工具成功后调用：累计未交接写操作数，每满 8 次返回一条就近提醒 */
function noteWriteAndHint(agentId) {
  if (!agentId || !state.agents[agentId]) return "";
  const ag = state.agents[agentId];
  ag.writesSinceCheckpoint = (ag.writesSinceCheckpoint || 0) + 1;
  save();
  if (ag.writesSinceCheckpoint % 8 === 0) {
    return `\n\n⚠ 提醒：你（${agentId}）已连续 ${ag.writesSinceCheckpoint} 次文件写入未写交接。阶段完成时请调用 project_checkpoint 写交接（写入后计数清零）。`;
  }
  return "";
}
/** 事件流摘要（给 project_context 用）：最近 n 条可读活动 */
function journalText(n = 15) {
  const evs = (state.events || []).slice(-n);
  if (evs.length === 0) return "（暂无活动记录）";
  return evs.map((e) => `- ${e.t} [${e.agent}] ${e.kind}：${e.text}`).join("\n");
}
function requireAgent(agentId) {
  if (!agentId || !state.agents[agentId]) {
    throw new security_1.ToolError("agent_id 无效或未注册。请先调用 agent_register 获取 agent_id。");
  }
  return state.agents[agentId];
}
function depsDone(plan, t) {
  return (t.deps || []).every((d) => {
    const x = plan.tasks.find((y) => y.id === d);
    return x && x.status === "done";
  });
}
function isBlockedByDeps(plan, t) {
  return (t.deps || []).some((d) => {
    const x = plan.tasks.find((y) => y.id === d);
    return !x || x.status === "blocked";
  });
}

// ---------- 工具实现 ----------
function agentRegister(a) {
  const id = newId("ag_");
  state.agents[id] = {
    id,
    name: String(a.name || "AI"),
    role: String(a.role || "worker"),
    project: a.project ? path.resolve(String(a.project)) : "",
    registeredAt: iso(now()),
    lastSeen: iso(now()),
  };
  addEvent(id, "register", `${state.agents[id].name}（${state.agents[id].role}）已注册`);
  save();
  return `已注册，agent_id = ${id}\n之后每次调用任务、文件预占相关工具都要带上这个 agent_id。换 AI 接手时，新 AI 注册一个新 id 即可，计划和交接不会丢。`;
}

function planCreate(a) {
  const plan = getPlan(a.project);
  if (a.goal) plan.goal = String(a.goal);
  if (a.replace === true) {
    if (plan.tasks.some((t) => t.status === "doing")) {
      throw new security_1.ToolError("有任务正在执行中，不能整体替换计划。请先完成或释放这些任务。");
    }
    plan.tasks = [];
    plan.nextId = 1;
  }
  const idMap = {};
  const list = Array.isArray(a.tasks) ? a.tasks : [];
  for (const raw of list) {
    const id = "T" + plan.nextId++;
    idMap[String(raw.ref ?? id)] = id;
  }
  // 第二遍：把 deps 的 ref 或已有 id 映射为真实 id
  let k = plan.tasks.length;
  let nextBase = plan.nextId - list.length;
  for (const raw of list) {
    const id = "T" + (nextBase++);
    const deps = (Array.isArray(raw.deps) ? raw.deps : []).map((d) => idMap[String(d)] || String(d));
    plan.tasks.push({
      id,
      title: String(raw.title || "未命名任务"),
      acceptance: String(raw.acceptance || "（未写验收标准，请补充）"),
      acceptanceItems: (Array.isArray(raw.acceptance_items) ? raw.acceptance_items : [])
        .map((x, i) => ({
          id: String((x && x.id) || "a" + (i + 1)),
          text: String((x && (x.text || x.title)) || "").slice(0, 300),
          pass: false,
          evidence: "",
          by: "",
          at: "",
        }))
        .filter((x) => x.text),
      verify: String(raw.verify || "").slice(0, 300),
      deps,
      status: "todo",
      owner: null,
      leaseUntil: null,
      evidence: [],
      blocker: "",
      attempts: 0,
      steps: (Array.isArray(raw.steps) ? raw.steps : []).map((x) => ({ text: String(x), done: false })),
      notes: [],
      currentAction: "",
      review: null,
      updatedAt: iso(now()),
    });
    k++;
  }
  plan.updatedAt = iso(now());
  addEvent("-", "plan", `计划已创建/追加 ${list.length} 项：${plan.goal || "（无目标）"}`);
  save();
  return `计划已保存，共 ${plan.tasks.length} 项任务（新增 ${list.length} 项）。\n` + boardText(plan);
}

function stepsText(t) {
  const st = t.steps || [];
  if (st.length === 0) return "";
  return st.map((x, i) => `      ${x.done ? "[x]" : "[ ]"} ${i + 1}. ${x.text}`).join("\n");
}
function acceptanceText(t) {
  const items = t.acceptanceItems || [];
  if (items.length === 0) return "";
  const rv = t.review ? (t.review.verdict === "pass" ? "复核：通过" : "复核：未通过") : "复核：待做";
  const acc = items.map((x) => `${x.pass ? "[x]" : "[ ]"} ${x.id} ${x.text}`).join("；");
  return `      验收项：${acc}｜${rv}`;
}
function boardText(plan) {
  releaseExpired(plan);
  const lines = plan.tasks.map((t) => {
    const mark = { todo: "[ ]", doing: "[>]", done: "[x]", blocked: "[!]" }[t.status] || "[ ]";
    const dep = t.deps && t.deps.length ? `（依赖 ${t.deps.join(",")}）` : "";
    const who = t.owner ? ` 由 ${t.owner}` : "";
    const blk = t.status === "blocked" && t.blocker ? ` 阻塞原因：${t.blocker}` : "";
    const cur = t.status === "doing" && t.currentAction ? `\n      ↳ 正在：${t.currentAction}` : "";
    const sub = stepsText(t);
    const acc = acceptanceText(t);
    const noVerify = !t.verify && t.status !== "done" ? "（缺验收方式）" : "";
    return `${mark} ${t.id} ${t.title}${noVerify}${dep}${who}${blk}${cur}${sub ? "\n" + sub : ""}${acc ? "\n" + acc : ""}`;
  });
  const done = plan.tasks.filter((t) => t.status === "done").length;
  return `目标：${plan.goal || "（未设置）"}\n进度：${done}/${plan.tasks.length}\n` + (lines.join("\n") || "（暂无任务）");
}

function taskStatus(a) {
  const plan = getPlan(a.project);
  releaseExpired(plan);
  if (plan.tasks.length === 0) {
    return "没有计划。请先调用 plan_create 列出完整任务清单（每项带验收标准），再开始执行。";
  }
  const total = plan.tasks.length;
  const done = plan.tasks.filter((t) => t.status === "done").length;
  if (done === total) {
    return `全部完成（${done}/${total}）。可以结束，并用 project_checkpoint 写最终交接。\n\n` + boardText(plan);
  }
  // 优先：本 AI 自己正在做的任务
  const mine = a.agent_id ? plan.tasks.find((t) => t.status === "doing" && t.owner === a.agent_id) : null;
  let next = mine;
  if (!next) {
    next = plan.tasks.find((t) => t.status === "todo" && depsDone(plan, t));
  }
  if (!next) {
    const pendingBlocked = plan.tasks.filter((t) => t.status !== "done");
    return (
      "当前没有可执行的任务：剩余任务都在等待阻塞项或其他 AI 的租约。\n" +
      "不要结束：请等待几分钟后再次调用 task_status，或调用 task_block/人工确认解除阻塞。\n\n" +
      boardText(plan) +
      `\n\n未完成：${pendingBlocked.length} 项`
    );
  }
  if (a.agent_id && next.status === "todo") {
    // 自动认领（原子，因为是同步执行）
    requireAgent(a.agent_id);
    next.status = "doing";
    next.owner = a.agent_id;
    next.leaseUntil = iso(now() + TASK_LEASE_MS);
    next.attempts++;
    next.updatedAt = iso(now());
    plan.updatedAt = iso(now());
    addEvent(a.agent_id, "claim", `认领 ${next.id}：${next.title}`);
    save();
  }
  return (
    `【继续执行】进度 ${done}/${total}\n` +
    `当前任务：${next.id} ${next.title}\n` +
    `验收标准：${next.acceptance}\n` +
    `验收方式：${next.verify || "（未写——建议补 verify：怎么证明完成）"}\n` +
    (next.acceptanceItems && next.acceptanceItems.length
      ? `验收项：\n${next.acceptanceItems
          .map((x) => `      ${x.pass ? "[x]" : "[ ]"} ${x.id} ${x.text}${x.pass && x.evidence ? `（证据：${x.evidence.slice(0, 40)}）` : ""}`)
          .join("\n")}\n      复核：${next.review ? (next.review.verdict === "pass" ? "通过" : "未通过") : "待做（需另一 agent 调 task_review）"}\n`
      : "") +
    (next.owner ? `负责人：${next.owner}（租约到 ${next.leaseUntil}）\n` : "") +
    (next.steps && next.steps.length ? `子步骤：\n${stepsText(next)}\n` : "") +
    `\n开始每一步前调用 task_progress，用一句话说明正在做什么；完成子步骤时 step 传序号。\n` +
    `完成后调用 task_complete，附上证据（测试输出、文件路径或 commit 号）。有验收项的任务：先用 task_accept 逐项勾过（各附证据），再请另一个 agent 用 task_review 复核通过后才 task_complete（实现者不能自签）。无法完成就调用 task_block 写明原因，然后继续下一个任务。\n` +
    `在出现「全部完成」之前不要结束。\n\n` +
    boardText(plan)
  );
}

function taskClaim(a) {
  requireAgent(a.agent_id);
  const plan = getPlan(a.project);
  releaseExpired(plan);
  const t = plan.tasks.find((x) => x.id === a.task_id);
  if (!t) throw new security_1.ToolError(`找不到任务 ${a.task_id}`);
  if (t.status === "done") throw new security_1.ToolError(`${t.id} 已完成`);
  if (t.status === "doing" && t.owner !== a.agent_id) {
    return { ok: false, text: `${t.id} 已被 ${t.owner} 认领，未分配给你。` };
  }
  if (!depsDone(plan, t)) return { ok: false, text: `${t.id} 的依赖尚未全部完成：${t.deps.join(",")}` };
  t.status = "doing";
  t.owner = a.agent_id;
  t.leaseUntil = iso(now() + TASK_LEASE_MS);
  t.attempts++;
  t.updatedAt = iso(now());
  addEvent(a.agent_id, "claim", `认领 ${t.id}：${t.title}`);
  save();
  return { ok: true, text: `已认领 ${t.id}：${t.title}（租约 15 分钟，执行中调用 report_progress 可续期）` };
}

function taskComplete(a) {
  requireAgent(a.agent_id);
  const plan = getPlan(a.project);
  const t = plan.tasks.find((x) => x.id === a.task_id);
  if (!t) throw new security_1.ToolError(`找不到任务 ${a.task_id}`);
  if (t.owner && t.owner !== a.agent_id) throw new security_1.ToolError(`${t.id} 由 ${t.owner} 负责，你不能标记完成`);
  const ev = String(a.evidence || "").trim();
  if (ev.length < 10) throw new security_1.ToolError("必须提供证据（至少 10 个字：测试输出、文件路径或 commit 号），否则不能标记完成");
  const items = t.acceptanceItems || [];
  if (items.length) {
    const bad = items.filter((x) => !x.pass).map((x) => x.id);
    if (bad.length) throw new security_1.ToolError(`验收项未全过：${bad.join(", ")}。先用 task_accept 逐项勾过并附证据。`);
    const noEv = items.filter((x) => !String(x.evidence || "").trim()).map((x) => x.id);
    if (noEv.length) throw new security_1.ToolError(`验收项缺证据：${noEv.join(", ")}`);
    const rv = t.review;
    if (!rv || rv.verdict !== "pass") throw new security_1.ToolError("缺独立复核：请另一个 agent 用 task_review 复核通过后再收尾（生成/评估分离，实现者不能自签）");
  }
  if (!String(a.no_checkpoint_reason || "").trim() && !(state.agents[a.agent_id] && state.agents[a.agent_id].lastCheckpointAt)) {
    throw new security_1.ToolError(`CHECKPOINT_MISSING：${t.id} 收尾前需先写交接。请调用 project_checkpoint（带上 agent_id=${a.agent_id} 以便归属）写清「完成了什么/下一步/风险」后重试 task_complete；若本次确属不应写交接的场景，传 no_checkpoint_reason 说明原因。`);
  }
  t.status = "done";
  t.evidence.push({ t: iso(now()), by: a.agent_id, text: ev.slice(0, 2000) });
  t.owner = null;
  t.leaseUntil = null;
  t.updatedAt = iso(now());
  plan.updatedAt = iso(now());
  addEvent(a.agent_id, "done", `完成 ${t.id}：${t.title}`);
  save();
  return `已完成 ${t.id}。\n\n` + taskStatus({ project: a.project, agent_id: a.agent_id });
}

function taskAccept(a) {
  requireAgent(a.agent_id);
  const plan = getPlan(a.project);
  const t = plan.tasks.find((x) => x.id === a.task_id);
  if (!t) throw new security_1.ToolError(`找不到任务 ${a.task_id}`);
  if (t.status === "done") throw new security_1.ToolError(`${t.id} 已完成`);
  if (t.owner && t.owner !== a.agent_id) throw new security_1.ToolError(`${t.id} 由 ${t.owner} 负责，你不能勾它的验收项`);
  const items = t.acceptanceItems || [];
  if (items.length === 0) throw new security_1.ToolError(`${t.id} 没有结构化验收项（acceptance_items）；文字验收标准的任务直接用 task_complete 附证据`);
  const it = items.find((x) => x.id === String(a.item_id || ""));
  if (!it) throw new security_1.ToolError(`没有验收项 ${a.item_id}；可选：${items.map((x) => x.id).join(", ")}`);
  const pass = a.pass !== false;
  const ev = String(a.evidence || "").trim();
  if (pass && ev.length < 10) throw new security_1.ToolError("勾过验收项必须附证据（至少 10 个字：测试输出、文件路径或 commit 号）");
  it.pass = pass;
  it.evidence = pass ? ev.slice(0, 500) : "";
  it.by = a.agent_id;
  it.at = iso(now());
  t.updatedAt = iso(now());
  plan.updatedAt = iso(now());
  addEvent(a.agent_id, "accept", `${t.id} 验收项 ${it.id} ${pass ? "通过" : "取消通过"}：${it.text.slice(0, 60)}`);
  save();
  const left = items.filter((x) => !x.pass).map((x) => x.id);
  return `${t.id} 验收项 ${it.id} 已${pass ? "勾过" : "取消"}。剩余未过：${left.length ? left.join(", ") : "无，可请复核后收尾"}。`;
}

function taskReview(a) {
  requireAgent(a.agent_id);
  const plan = getPlan(a.project);
  const t = plan.tasks.find((x) => x.id === a.task_id);
  if (!t) throw new security_1.ToolError(`找不到任务 ${a.task_id}`);
  if (t.owner && t.owner === a.agent_id) throw new security_1.ToolError("实现者不能自签验收：请换一个 agent（重新 agent_register）来复核");
  const items = t.acceptanceItems || [];
  if (items.some((x) => x.pass && x.by === a.agent_id)) throw new security_1.ToolError("你勾过本任务的验收项，不能自己复核（生成/评估分离）");
  const verdict = a.verdict === "fail" ? "fail" : "pass";
  const report = String(a.report || "").trim();
  if (report.length < 10) throw new security_1.ToolError("复核报告至少 10 个字（怎么验的、结果如何）");
  t.review = {
    by: a.agent_id,
    verdict,
    report: report.slice(0, 2000),
    reportPath: String(a.report_path || "").slice(0, 300),
    at: iso(now()),
  };
  t.updatedAt = iso(now());
  plan.updatedAt = iso(now());
  addEvent(a.agent_id, "review", `${t.id} 复核${verdict === "pass" ? "通过" : "未通过"}：${report.slice(0, 80)}`);
  save();
  return `${t.id} 复核结果：${verdict === "pass" ? "通过" : "未通过"}。${verdict === "pass" ? "可调用 task_complete 收尾。" : "实现者继续修复，改完再请复核。"}`;
}

function taskBlock(a) {
  requireAgent(a.agent_id);
  const plan = getPlan(a.project);
  const t = plan.tasks.find((x) => x.id === a.task_id);
  if (!t) throw new security_1.ToolError(`找不到任务 ${a.task_id}`);
  t.status = "blocked";
  t.blocker = String(a.reason || "未说明");
  t.owner = null;
  t.leaseUntil = null;
  t.updatedAt = iso(now());
  addEvent(a.agent_id, "blocked", `${t.id} 阻塞：${t.blocker}`);
  save();
  return `已标记 ${t.id} 为阻塞，原因已记录。请继续下一个任务。\n\n` + taskStatus({ project: a.project, agent_id: a.agent_id });
}

function taskProgress(a) {
  requireAgent(a.agent_id);
  const plan = getPlan(a.project);
  releaseExpired(plan);
  const t = a.task_id
    ? plan.tasks.find((x) => x.id === a.task_id)
    : plan.tasks.find((x) => x.status === "doing" && x.owner === a.agent_id);
  if (!t) throw new security_1.ToolError("没有找到你正在执行的任务。请先 task_status 或 task_claim。");
  if (t.owner && t.owner !== a.agent_id) throw new security_1.ToolError(`${t.id} 由 ${t.owner} 负责`);
  t.steps = t.steps || [];
  t.notes = t.notes || [];
  if (a.text) {
    t.currentAction = String(a.text).slice(0, 300);
    t.notes.push({ t: iso(now()), text: t.currentAction });
    if (t.notes.length > 50) t.notes.splice(0, t.notes.length - 50);
    addEvent(a.agent_id, "progress", `${t.id}：${t.currentAction}`);
  }
  if (a.new_step) {
    t.steps.push({ text: String(a.new_step).slice(0, 200), done: false });
  }
  if (a.step) {
    const i = Number(a.step) - 1;
    if (!t.steps[i]) throw new security_1.ToolError(`没有第 ${a.step} 个子步骤`);
    t.steps[i].done = true;
    addEvent(a.agent_id, "progress", `${t.id} 子步骤 ${a.step} 完成：${t.steps[i].text}`);
  }
  t.updatedAt = iso(now());
  plan.updatedAt = iso(now());
  save();
  const done = t.steps.filter((x) => x.done).length;
  return `已记录。${t.id} 子步骤 ${done}/${t.steps.length}`;
}

function pruneReservations() {
  state.reservations = state.reservations.filter((r) => r.expiresAt > now());
}
function overlaps(p, q) {
  return p === q || p.startsWith(q + path.sep) || q.startsWith(p + path.sep);
}
function conflictsFor(agentId, paths) {
  pruneReservations();
  const out = [];
  for (const p of paths) {
    for (const r of state.reservations) {
      if (r.agent !== agentId && overlaps(p, r.path)) {
        out.push({ path: p, heldBy: r.agent, heldPath: r.path, expiresAt: r.expiresAt, reason: r.reason });
      }
    }
  }
  return out;
}
function reserveFiles(a, c) {
  requireAgent(a.agent_id);
  const root = c.cfg.get().workspaceRoots[0];
  const paths = (Array.isArray(a.paths) ? a.paths : [a.paths]).map((p) => normalizePath(root, p));
  const conflicts = conflictsFor(a.agent_id, paths);
  if (conflicts.length) {
    return {
      ok: false,
      text: "预占失败（全部不生效）：\n" + conflicts.map((x) => `- ${x.path} 被 ${x.heldBy} 占用（${x.reason || "无说明"}，到期 ${x.expiresAt ? iso(x.expiresAt) : "-"}）`).join("\n"),
    };
  }
  const ttl = Math.max(1, Number(a.ttl_minutes || 30)) * 60 * 1000;
  for (const p of paths) {
    state.reservations = state.reservations.filter((r) => !(r.agent === a.agent_id && r.path === p));
    state.reservations.push({ id: newId("rs_"), path: p, agent: a.agent_id, expiresAt: now() + ttl, reason: String(a.reason || "") });
  }
  addEvent(a.agent_id, "reserve", `预占 ${paths.length} 个路径：${a.reason || ""}`);
  save();
  return { ok: true, text: `已预占 ${paths.length} 个路径，${Math.round(ttl / 60000)} 分钟内其他 AI 不能写入。` };
}
function releaseFiles(a, c) {
  requireAgent(a.agent_id);
  const root = c.cfg.get().workspaceRoots[0];
  const only = a.paths ? (Array.isArray(a.paths) ? a.paths : [a.paths]).map((p) => normalizePath(root, p)) : null;
  const before = state.reservations.length;
  state.reservations = state.reservations.filter((r) => !(r.agent === a.agent_id && (!only || only.includes(r.path))));
  const n = before - state.reservations.length;
  addEvent(a.agent_id, "release", `释放 ${n} 个预占`);
  save();
  return `已释放 ${n} 个预占。`;
}
function listReservations() {
  pruneReservations();
  if (state.reservations.length === 0) return "当前没有文件预占。";
  return state.reservations.map((r) => `- ${r.path}  ←  ${r.agent}  到期 ${iso(r.expiresAt)}  ${r.reason || ""}`).join("\n");
}

function normalizePath(root, p) {
  const abs = path.isAbsolute(String(p)) ? path.resolve(String(p)) : path.resolve(root, String(p));
  return abs.toLowerCase();
}
/** 写类工具执行前检查：文件被别的 AI 预占则拒绝。
 *  agent_id 缺省时依然检查：目标路径被「任何人」预占就拒绝写入；
 *  未被任何人预占的路径仍放行（兼容旧用法）；带 agent_id 时可写自己预占的路径。 */
function guardWrite(name, input, c) {
  if (!stateFile) return;
  if (input && input.agent_id && state.agents[input.agent_id]) recordActivity(input.agent_id, name, input);
  if (!WRITE_TOOLS.has(name) || !input) return;
  const root = c.cfg.get().workspaceRoots[0];
  const targets = [];
  if (input.path) targets.push(input.path);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (e && e.path) targets.push(e.path);
  if (typeof input.patch === "string") {
    const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
    let m;
    while ((m = re.exec(input.patch))) targets.push(m[1].trim());
    const re2 = /^\+\+\+ (?:b\/)?(.+)$/gm;
    while ((m = re2.exec(input.patch))) if (m[1] !== "/dev/null") targets.push(m[1].trim());
  }
  const paths = targets.map((p) => normalizePath(root, p));
  const conflicts = conflictsFor(input.agent_id, paths);
  if (conflicts.length) {
    throw new security_1.ToolError(
      "文件被其他 AI 预占，已拒绝写入：\n" +
        conflicts.map((x) => `- ${x.path} 由 ${x.heldBy} 占用`).join("\n") +
        "\n请等待或选择其他文件；需要协调时可在事件里留言或调用 task_block。" + (input.agent_id ? "" : "\n（本次调用未带 agent_id，无法判断该路径是否是你本人预占）")
    );
  }
}

const gitQueue = { tail: Promise.resolve() };
function needsGitLock(name, input) {
  if (name.startsWith("git_")) return true;
  return name === "run_command" && /\bgit\b/i.test(String((input && input.command) || ""));
}
/** 返回一个 Promise，resolve 出 release 函数。git 写操作串行，避免 index.lock 冲突。 */
function acquireGitLock() {
  let release;
  const next = new Promise((r) => (release = r));
  const prev = gitQueue.tail;
  gitQueue.tail = prev.then(() => next);
  return prev.then(() => release);
}

/** 给计划工具的 project_context 用：返回计划摘要 */
function planSummary(dir) {
  if (!stateFile) return "（协调层未初始化）";
  const plan = state.plans[projKey(dir)];
  if (!plan || plan.tasks.length === 0) return "（没有计划。可用 plan_create 建立）";
  return boardText(plan);
}

function dashboard(cfg) {
  pruneReservations();
  const plans = Object.values(state.plans).map((p) => {
    releaseExpired(p);
    return {
      dir: p.dir,
      goal: p.goal,
      total: p.tasks.length,
      done: p.tasks.filter((t) => t.status === "done").length,
      doing: p.tasks.filter((t) => t.status === "doing").length,
      blocked: p.tasks.filter((t) => t.status === "blocked").length,
      updatedAt: p.updatedAt,
      tasks: p.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner,
        deps: t.deps,
        blocker: t.blocker,
        leaseUntil: t.leaseUntil,
        acceptance: t.acceptance,
        verify: t.verify || "",
        acceptanceItems: t.acceptanceItems || [],
        review: t.review || null,
        currentAction: t.currentAction || "",
        steps: t.steps || [],
        notes: (t.notes || []).slice(-5),
        lastEvidence: t.evidence.length ? t.evidence[t.evidence.length - 1].text : "",
        updatedAt: t.updatedAt || "",
      })),
    };
  });
  return {
    promptVersion: PROMPT_VERSION,
    agents: Object.values(state.agents).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || "")),
    plans,
    reservations: state.reservations.map((r) => ({ path: r.path, agent: r.agent, expiresAt: iso(r.expiresAt), reason: r.reason })),
    events: state.events.slice(-200).reverse(),
    workspaceRoots: cfg.workspaceRoots,
  };
}

function sessionInfo(c) {
  return [
    `提示词版本：${PROMPT_VERSION}`,
    `服务器时间：${new Date().toISOString()}`,
    `工作区：${c.cfg.get().workspaceRoots.join(", ")}`,
    "如果你看到这段内容，说明 MCP 服务的提示词已生效。请把提示词版本号告诉用户。",
  ].join("\n");
}

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const text = (s) => ({ type: "text", text: s });
const AGENT_ID = str("你的 agent_id（agent_register 返回）");
const PROJECT = str("项目目录（可选，默认工作区根目录）");

/** 注册给 tools.js 的工具定义。handler(a, c) 与其他工具保持一致。 */
function makeTools() {
  const root = (c) => c.cfg.get().workspaceRoots[0];
  const dirOf = (c, a) => (a.project ? String(a.project) : root(c));
  return [
    {
      name: "session_info",
      description: "返回当前提示词版本号、服务器时间和工作区。用于确认 MCP 提示词是否生效：收到后请把版本号告诉用户。",
      inputSchema: obj({}),
      handler: async (_a, c) => sessionInfo(c),
    },
    {
      name: "agent_register",
      description: "注册一个 AI 身份，返回 agent_id。多个 AI 同时工作时，每个 AI 都要先注册，之后的任务和预占操作都带上 agent_id。",
      inputSchema: obj({ name: str("这个 AI 的名字，例如 Claude-1"), role: str("角色：planner / implementer / reviewer / verifier / worker"), project: PROJECT }, ["name"]),
      handler: async (a, c) => {
        init(c.dataDir);
        return agentRegister(a);
      },
    },
    {
      name: "plan_create",
      description: "建立完整任务清单（一次性列出全部任务，每项写清验收标准）。之后用 task_status 逐个执行，直到全部完成才结束。replace=true 会整体替换（有进行中任务时拒绝）。",
      inputSchema: obj(
        {
          project: PROJECT,
          goal: str("项目总目标"),
          tasks: {
            type: "array",
            description: "任务列表",
            items: obj({ ref: str("可选，本次计划内的临时名，用于 deps"), title: str("任务标题"), acceptance: str("验收标准，可验证"), acceptance_items: { type: "array", description: "结构化验收项（可选）：逐项由 task_accept 勾过并附证据，经 task_review 独立复核通过后才能 task_complete", items: obj({ id: str("可选，如 a1"), text: str("验收项描述，可验证") }, ["text"]) }, verify: str("验收方式：怎么证明完成（跑什么命令/看什么文件/走什么用户路径），一行"), steps: { type: "array", items: { type: "string" }, description: "子步骤清单（按顺序），例如 读取代码 / 修改 login.js / 运行测试" }, deps: { type: "array", items: { type: "string" }, description: "依赖的 ref 或已有任务 id" } }, ["title", "acceptance"]),
          },
          replace: bool("是否整体替换已有计划，默认 false（追加）"),
        },
        ["tasks"]
      ),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        return planCreate(a);
      },
    },
    {
      name: "task_status",
      description: "获取下一步要做什么。返回「继续执行」（附当前任务和验收标准）、「全部完成」或「无可执行任务」。只要没有出现「全部完成」，就不要结束。传 agent_id 时会自动认领下一项。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID }),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        touch(a.agent_id);
        return taskStatus(a);
      },
    },
    {
      name: "task_claim",
      description: "认领指定任务（一般不需要，task_status 会自动认领）。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, task_id: str("任务 id，如 T3") }, ["agent_id", "task_id"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        const r = taskClaim(a);
        if (!r.ok) throw new security_1.ToolError(r.text);
        return r.text;
      },
    },
    {
      name: "task_complete",
      description: "标记任务完成。必须附证据（测试输出、文件路径或 commit 号），没有证据会被拒绝。完成后会返回下一步。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, task_id: str("任务 id"), evidence: str("完成证据"), no_checkpoint_reason: str("仅当本次不应写交接时填：说明为什么跳过 project_checkpoint（如纯测试任务）") }, ["agent_id", "task_id", "evidence"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        return taskComplete(a);
      },
    },
    {
      name: "task_accept",
      description: "勾过/取消验收项（pass=true 时必须附至少 10 个字的证据）。带 acceptance_items 的任务要逐项勾过才能 task_complete。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, task_id: str("任务 id，如 T3"), item_id: str("验收项 id，如 a1"), pass: bool("true 勾过（默认），false 取消勾过"), evidence: str("证据：测试输出/文件路径/commit 号") }, ["agent_id", "task_id", "item_id"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        return taskAccept(a);
      },
    },
    {
      name: "task_review",
      description: "独立复核（生成/评估分离）：按用户路径验证后给出 pass/fail 与复核报告（可存 docs/verify-<task>.md 并填 report_path）。实现者不能自签：复核者不能是任务 owner，也不能是勾过验收项的人。带验收项的任务须复核通过才能 task_complete。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, task_id: str("任务 id"), verdict: str("pass 或 fail"), report: str("复核报告：怎么验的、结果如何"), report_path: str("复核存档路径（可选），如 docs/verify-T12.md") }, ["agent_id", "task_id", "verdict", "report"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        return taskReview(a);
      },
    },
    {
      name: "task_block",
      description: "把任务标记为阻塞并写明原因。阻塞不代表整体停止：标记后继续下一个任务，最后把阻塞项汇总给用户。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, task_id: str("任务 id"), reason: str("阻塞原因（需要用户做什么）") }, ["agent_id", "task_id", "reason"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        return taskBlock(a);
      },
    },
    {
      name: "task_progress",
      description: "汇报当前正在做什么（一句话）。每开始一个子步骤前调用；完成子步骤时传 step 序号；发现需要新增的子步骤用 new_step。看板会实时显示这些内容。",
      inputSchema: obj({ agent_id: AGENT_ID, project: PROJECT, text: str("正在做什么，一句话"), step: num("刚完成的子步骤序号（从 1 开始）"), new_step: str("新增的子步骤"), task_id: str("任务 id（可选，默认你正在执行的任务）") }, ["agent_id"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        return taskProgress(a);
      },
    },
    {
      name: "task_delete",
      description: "删除一个任务（写错的、已过期的、或别人遗留的老任务）。删除会写进事件流；正在被他人执行的任务需要 force=true。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, task_id: str("任务 id"), reason: str("删除原因（会记进事件流）"), force: bool("强制删除他人正在执行的任务") }, ["agent_id", "task_id"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        requireAgent(a.agent_id);
        const r = deleteTaskById(a.project, a.task_id, a.reason, { agentId: a.agent_id, ownerOnly: a.agent_id, force: !!a.force });
        if (!r.ok)
            throw new security_1.ToolError(r.text);
        return r.text;
      },
    },
    {
      name: "plan_delete",
      description: "删除整个计划（含全部任务）。用于清理长期挂着的老计划；计划里还有进行中的任务时需要 force=true。",
      inputSchema: obj({ project: PROJECT, agent_id: AGENT_ID, reason: str("删除原因（会记进事件流）"), force: bool("强制删除含进行中任务的计划") }, ["agent_id"]),
      handler: async (a, c) => {
        init(c.dataDir);
        a.project = dirOf(c, a);
        requireAgent(a.agent_id);
        const r = deletePlanById(a.project, a.reason, { agentId: a.agent_id, ownerOnly: a.agent_id, force: !!a.force });
        if (!r.ok)
            throw new security_1.ToolError(r.text);
        return r.text;
      },
    },
    {
      name: "board",
      description: "查看当前计划看板（进度、每项任务的状态与负责人）。",
      inputSchema: obj({ project: PROJECT }),
      handler: async (a, c) => {
        init(c.dataDir);
        const plan = getPlan(dirOf(c, a));
        return plan.tasks.length ? boardText(plan) : "（没有计划）";
      },
    },
    {
      name: "reserve_files",
      description: "预占要修改的文件或目录（全部成功或全部失败）。别的 AI 占用时会返回冲突，写入类工具也会被拒绝。用完调用 release_files。",
      inputSchema: obj({ agent_id: AGENT_ID, paths: { type: "array", items: { type: "string" }, description: "文件或目录路径" }, ttl_minutes: num("租约分钟数，默认 30"), reason: str("为什么要改这些文件") }, ["agent_id", "paths"]),
      handler: async (a, c) => {
        init(c.dataDir);
        const r = reserveFiles(a, c);
        if (!r.ok) throw new security_1.ToolError(r.text);
        return r.text;
      },
    },
    {
      name: "release_files",
      description: "释放本 AI 的文件预占。不传 paths 则全部释放。",
      inputSchema: obj({ agent_id: AGENT_ID, paths: { type: "array", items: { type: "string" } } }, ["agent_id"]),
      handler: async (a, c) => {
        init(c.dataDir);
        return releaseFiles(a, c);
      },
    },
    {
      name: "list_reservations",
      description: "查看当前所有文件预占，知道谁在改什么。",
      inputSchema: obj({}),
      handler: async (_a, c) => {
        init(c.dataDir);
        return listReservations();
      },
    },
  ];
}

module.exports = {
  PROMPT_VERSION,
  init,
  makeTools,
  guardWrite,
  needsGitLock,
  acquireGitLock,
  planSummary,
  dashboard,
  stampCheckpoint,
  noteWriteAndHint,
  journalText,
};