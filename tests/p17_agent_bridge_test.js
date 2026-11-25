"use strict";
/**
 * P17 回归测试：本地 Agent 桥接器 (arena-mcp-bridge <-> 六本豆mcp-v2 /api/agent-bridge/*)
 * 运行：node tests/p17_agent_bridge_test.js
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const assert = require("node:assert");

const coreDir = process.env.CORE_DIR || path.join(__dirname, "..", "src", "dist", "core");
const { createCore } = require(path.join(coreDir, "app.js"));

function reqJson(port, method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {
      "X-Panel": "1",
      ...extraHeaders,
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p17-bridge-"));
  const mcpPort = 18765;
  const panelPort = 18766;
  const core = createCore({ dataDir: tmp });
  core.config.update({
    port: mcpPort,
    panelPort: panelPort,
    workspaceRoots: [tmp],
    approvalMode: "never",
  });
  await core.start();

  try {
    // 1. status 接口检查
    const st0 = await reqJson(panelPort, "GET", "/api/agent-bridge/status");
    assert.strictEqual(st0.status, 200);
    assert.strictEqual(st0.json.ok, true);
    assert.strictEqual(st0.json.workspace, tmp);
    assert.ok(st0.json.toolCount >= 50, "应暴露至少 50 个启用工具");

    // 2. handshake 协议生成检查
    const hs = await reqJson(panelPort, "POST", "/api/agent-bridge/handshake", {});
    assert.strictEqual(hs.status, 200);
    assert.strictEqual(hs.json.ok, true);
    assert.ok(hs.json.prompt.includes("```mcp-call"), "握手提示词必须包含 mcp-call 协议块说明");
    assert.ok(hs.json.prompt.includes("read_file") && hs.json.prompt.includes("write_file"));

    // 3. Firefox 扩展 Origin (moz-extension://) 跨域与工具自动执行测试
    const extHeaders = { Origin: "moz-extension://99aabbcc-1122-3344-5566-77889900aabb" };
    const w1 = await reqJson(
      panelPort,
      "POST",
      "/api/agent-bridge/exec",
      { name: "write_file", arguments: { path: "hello.txt", content: "第一版内容\n第二行\n" } },
      extHeaders
    );
    assert.strictEqual(w1.status, 200);
    assert.strictEqual(w1.json.ok, true, "新建文件应成功: " + JSON.stringify(w1.json));
    assert.strictEqual(w1.headers["access-control-allow-origin"], extHeaders.Origin);

    // 覆盖已有文件（不传 expected_version 和 why，桥接器应自动补齐 sha256 与 why）
    const w2 = await reqJson(
      panelPort,
      "POST",
      "/api/agent-bridge/exec",
      { name: "write_file", arguments: { path: "hello.txt", content: "覆盖后的内容\n第二行\n" } },
      extHeaders
    );
    assert.strictEqual(w2.status, 200);
    assert.strictEqual(w2.json.ok, true, "未传 expected_version 覆盖文件应由桥接器自动补齐版本并成功");

    // edit_file 测试
    const ed = await reqJson(
      panelPort,
      "POST",
      "/api/agent-bridge/exec",
      { name: "edit_file", arguments: { path: "hello.txt", old_text: "覆盖后的内容", new_text: "修改后的首行" } },
      extHeaders
    );
    assert.strictEqual(ed.status, 200);
    assert.strictEqual(ed.json.ok, true);

    // read_file 验证内容
    const rf = await reqJson(
      panelPort,
      "POST",
      "/api/agent-bridge/exec",
      { name: "read_file", arguments: { path: "hello.txt" } },
      extHeaders
    );
    assert.strictEqual(rf.status, 200);
    assert.strictEqual(rf.json.ok, true);
    assert.ok(rf.json.output.includes("修改后的首行"), "read_file 应读回修改后的内容");

    // 4. 浏览器实例 sync 与桌面端 command 双向队列验证
    const sync1 = await reqJson(
      panelPort,
      "POST",
      "/api/agent-bridge/sync",
      {
        clientId: "amb_test1",
        tabId: 42,
        url: "https://arena.ai/agent",
        title: "Arena Agent",
        busy: false,
        stepCount: 1,
        maxSteps: 12,
        messages: [{ role: "user", text: "你好" }, { role: "assistant", text: "你好！请指示任务。" }],
      },
      extHeaders
    );
    assert.strictEqual(sync1.status, 200);
    assert.strictEqual(sync1.json.ok, true);
    assert.strictEqual(sync1.json.sessionId, "amb_test1:42");
    assert.strictEqual(sync1.json.commands.length, 0);

    // 桌面端下发带握手协议的任务指令
    const cmdRes = await reqJson(panelPort, "POST", "/api/agent-bridge/command", {
      sessionId: "amb_test1:42",
      action: "send_prompt",
      text: "请读取 hello.txt",
      withHandshake: true,
    });
    assert.strictEqual(cmdRes.status, 200);
    assert.strictEqual(cmdRes.json.ok, true);
    assert.strictEqual(cmdRes.json.queued, 1);

    // 浏览器下一次 sync 应取走该指令
    const sync2 = await reqJson(
      panelPort,
      "POST",
      "/api/agent-bridge/sync",
      { clientId: "amb_test1", tabId: 42, url: "https://arena.ai/agent", title: "Arena Agent", busy: false },
      extHeaders
    );
    assert.strictEqual(sync2.status, 200);
    assert.strictEqual(sync2.json.commands.length, 1);
    assert.strictEqual(sync2.json.commands[0].type, "send_prompt");
    assert.ok(sync2.json.commands[0].text.includes("请读取 hello.txt"));
    assert.ok(sync2.json.commands[0].text.includes("```mcp-call"));

    // 5. 面板 HTML 包含本地 Agent 页面
    const htmlRes = await reqJson(panelPort, "GET", "/?tab=agent");
    assert.strictEqual(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes('id="page-agent"') && htmlRes.text.includes("loadAgentBridge"));

    console.log("p17_agent_bridge_test: ALL PASSED");
  } finally {
    await core.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
})();

