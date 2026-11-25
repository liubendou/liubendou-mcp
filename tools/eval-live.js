"use strict";
/**
 * P7 记忆评估（全真链路）：mock-embedding + hy_memory.server（lite）+ 迁移/召回/往返/回退
 * 产出 JSON 汇总：写入耗时、召回准确率（top1/top3）与延迟（p50/p95/max）、往返一致性、断连回退。
 * 语料：tests/eval-corpus.json（≥20 条真实交接记录）。
 * 用法：node tools/eval-live.js   （需要 v2\venv-hy；无 hy_memory 时输出 {"skipped":true}）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createMockEmbedServer } = require('./mock-embed-server');
const { migrateRaw } = require('./migrate-memory');
const { exportRaw } = require('./export-memory');

function pct(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
async function waitHealth(url, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(1500) });
            if (r.ok) return true;
        }
        catch { }
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}

(async () => {
    const root = path.resolve(__dirname, '..');
    const py = path.join(root, 'venv-hy', 'Scripts', 'python.exe');
    const summary = { skipped: false, write: null, recall: null, roundtrip: null, fallback: null };
    if (!fs.existsSync(py)) {
        summary.skipped = true;
        summary.reason = 'venv-hy python not found';
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    const corpus = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'eval-corpus.json'), 'utf8'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-eval-'));
    const mem = {};
    for (const rec of corpus)
        mem[rec.key] = { value: rec.value, updatedAt: '2026-10-25T08:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ todos: [], nextId: 1, memory: mem, plan: null }, null, 2));

    // 1) mock embedding
    const embedSrv = createMockEmbedServer();
    await new Promise((r) => embedSrv.listen(0, '127.0.0.1', r));
    const embedUrl = 'http://127.0.0.1:' + embedSrv.address().port + '/v1';

    // 2) 真 sidecar（lite + mock embedder）
    const port = 19528;
    const env = Object.assign({}, process.env, {
        MEMORY_MODE: 'lite',
        MEMORY_DATA_DIR: path.join(dir, 'hy-memory'),
        MEMORY_EMBEDDING_DIMS: '256',
        MEMORY_EMBEDDER_PROVIDER: 'openai',
        MEMORY_EMBEDDER_API_KEY: 'mock-key',
        MEMORY_EMBEDDER_BASE_URL: embedUrl,
        MEMORY_EMBEDDER_MODEL: 'mock-256',
        PYTHONUTF8: '1',
    });
    const proc = spawn(py, ['-m', 'hy_memory.server', '--port', String(port), '--host', '127.0.0.1'], { env, stdio: 'ignore', windowsHide: true });
    const endpoint = 'http://127.0.0.1:' + port;
    try {
        const up = await waitHealth(endpoint, 60000);
        if (!up) throw new Error('sidecar 未就绪');

        // 3) 写入（迁移）25 条
        const tW = Date.now();
        const rep = await migrateRaw({ dataDir: dir, endpoint, timeoutMs: 30000 });
        const writeTotal = Date.now() - tW;
        summary.write = {
            total: rep.total, ok: rep.ok, fail: rep.fail,
            totalMs: writeTotal,
            perItemMs: rep.items.map((i) => i.elapsedMs || 0),
            perItemP50: pct(rep.items.map((i) => i.elapsedMs || 0), 0.5),
            perItemP95: pct(rep.items.map((i) => i.elapsedMs || 0), 0.95),
        };

        // 4) 召回：25 个查询
        const lat = [];
        let top1 = 0, top3 = 0, miss = 0;
        const details = [];
        for (const rec of corpus) {
            const t0 = Date.now();
            const r = await fetch(endpoint + '/api/v1/search', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: rec.query, user_ids: ['liubenben'], limit: 5 }),
                signal: AbortSignal.timeout(30000),
            });
            const j = await r.json();
            lat.push(Date.now() - t0);
            const hits = (j && j.memories && j.memories.normal) || [];
            const rank = hits.findIndex((h) => h.content === rec.value);
            if (rank === 0) top1++;
            if (rank >= 0 && rank < 3) top3++;
            if (rank < 0) miss++;
            details.push({ key: rec.key, rank: rank < 0 ? null : rank + 1, score: rank >= 0 ? hits[rank].score : (hits[0] ? hits[0].score : null) });
        }
        summary.recall = {
            queries: corpus.length,
            top1, top3, miss,
            top1Rate: top1 / corpus.length,
            top3Rate: top3 / corpus.length,
            latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat) },
            details,
        };

        // 5) 往返：sidecar → export → 与原始 memory 逐字节比
        const exp = await exportRaw({ dataDir: dir, endpoint, timeoutMs: 30000 });
        summary.roundtrip = {
            exported: Object.keys(exp.memory).length, fail: exp.fail,
            keyFieldsIdentical: JSON.stringify(exp.memory) === JSON.stringify(mem),
        };

        // 6) 断连回退：杀掉 sidecar 后 memory 操作全部走 JSON，不崩
        proc.kill();
        await new Promise((r) => setTimeout(r, 500));
        const store = new (require(path.join(root, 'src', 'dist', 'core', 'store')).DataStore)(dir);
        const { HyMemoryBackend } = require(path.join(root, 'src', 'dist', 'core', 'memoryBackend'));
        const hm = new HyMemoryBackend(store, { endpoint, keymapPath: path.join(dir, 'hy-keymap.json'), timeoutMs: 1500 });
        const ops = {};
        try {
            await hm.set('fb-key', 'fb-val');
            ops.setOk = true;
        }
        catch (e) { ops.setOk = false; ops.setErr = String(e); }
        const g = await hm.get('fb-key');
        ops.getOk = !!(g['fb-key'] && g['fb-key'].value === 'fb-val');
        ops.getExisting = Object.keys(await hm.get()).length;
        ops.deleted = (await hm.delete('fb-key')) === true;
        ops.usedFallbackAfterSet = hm.usedFallback === true;
        ops.noCrash = true;
        summary.fallback = ops;
    }
    finally {
        try { proc.kill(); } catch { }
        embedSrv.close();
    }
    console.log(JSON.stringify(summary, null, 2));
})().catch((e) => {
    console.log(JSON.stringify({ skipped: false, error: String(e && e.stack ? e.stack : e) }, null, 2));
    process.exit(1);
});
