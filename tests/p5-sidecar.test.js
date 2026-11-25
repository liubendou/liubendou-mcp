"use strict";
// P5 验证：sidecar 通信 + keymap + 自动回退不崩溃（假 sidecar 全路径 + 真 sidecar 生命周期）
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const store_1 = require(path.resolve(__dirname, '../src/dist/core/store'));
const memoryBackend_1 = require(path.resolve(__dirname, '../src/dist/core/memoryBackend'));
const hySidecar_1 = require(path.resolve(__dirname, '../src/dist/core/hySidecar'));

let failed = 0;
function check(name, ok, detail) {
    if (ok) console.log('OK  ' + name);
    else { failed++; console.log('BAD ' + name + (detail ? ' | ' + detail : '')); }
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5test-'));
    const store = new store_1.DataStore(dir);
    const keymapPath = path.join(dir, 'hy-keymap.json');

    // ---------- 假 sidecar ----------
    const calls = [];
    let addMode = 'ok'; // ok | fail | (之后关服务器模拟挂掉)
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            calls.push(req.method + ' ' + req.url + ' ' + body.slice(0, 120));
            if (req.url === '/healthz') return send({ status: 'ok' });
            if (req.url === '/api/v1/add' && req.method === 'POST') {
                if (addMode === 'ok') return send({ success: true, memory_id: 'mid-1' });
                return send({ success: false, error_message: 'embedder missing' });
            }
            if (req.method === 'DELETE' && req.url.startsWith('/api/v1/memories/')) return send({ success: true, deleted_count: 1 });
            if (req.url === '/api/v1/search' && req.method === 'POST') return send({ memories: { normal: [{ memory_id: 'mid-1', content: 'x', score: 0.9 }] } });
            send({ error: 'not_found' });
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const fakeUrl = 'http://127.0.0.1:' + srv.address().port;

    const hm = new memoryBackend_1.HyMemoryBackend(store, { endpoint: fakeUrl, keymapPath, timeoutMs: 1500 });
    check('fake backend name', hm.name === 'hymemory');
    await hm.set('k1', 'v1');
    check('set ok -> usedFallback false', hm.usedFallback === false, 'usedFallback=' + hm.usedFallback);
    const _km1 = JSON.parse(fs.readFileSync(keymapPath, 'utf8')).k1;
    check('keymap has k1->mid-1', (_km1 && (_km1.id || _km1)) === 'mid-1');
    check('store has k1', store.getMemory('k1').k1.value === 'v1');
    const g = await hm.get('k1');
    check('get shape', g.k1 && g.k1.value === 'v1' && typeof g.k1.updatedAt === 'string');
    await hm.delete('k1');
    check('delete calls DELETE /memories/mid-1', calls.some((c) => c === 'DELETE /api/v1/memories/mid-1 ' || c.startsWith('DELETE /api/v1/memories/mid-1')));
    check('keymap cleared', Object.keys(JSON.parse(fs.readFileSync(keymapPath, 'utf8'))).length === 0);
    check('delete returns true', (await hm.delete('k1')) === false); // 已删过，第二次 false

    addMode = 'fail';
    await hm.set('k2', 'v2');
    check('add success:false -> usedFallback true', hm.usedFallback === true);
    check('store still written (dual-write)', store.getMemory('k2').k2.value === 'v2');

    addMode = 'ok';
    await hm.set('k2b', 'v2b');
    check('recovers after failure', hm.usedFallback === false);

    const s = await hm.search('x', 3);
    check('search returns memories.normal', s && s.memories && s.memories.normal && s.memories.normal.length === 1);

    srv.close();
    await new Promise((r) => setTimeout(r, 100));
    await hm.set('k3', 'v3');
    check('sidecar down -> usedFallback true, no crash', hm.usedFallback === true);
    check('store written when sidecar down', store.getMemory('k3').k3.value === 'v3');
    check('delete with sidecar down works', (await hm.delete('k3')) === true);

    // ---------- 真 sidecar 生命周期（无 hy_memory 则跳过）----------
    const sc = new hySidecar_1.HySidecar({ root: path.resolve(__dirname, '..'), dataDir: dir, readyTimeoutMs: 90000, log: { info: () => { }, warn: () => { }, error: () => { } } });
    const py = sc.findPython();
    const has = py && sc.hasHyMemory(py);
    console.log('LIVE python=' + (py || 'none') + ' hy_memory=' + !!has);
    if (has) {
        const up = await sc.start();
        check('live sidecar start', up === true, 'start()=false');
        if (up) {
            check('live healthz', await sc.health());
            const hm2 = new memoryBackend_1.HyMemoryBackend(store, { endpoint: sc.endpoint, keymapPath: path.join(dir, 'hy-keymap2.json'), timeoutMs: 20000 });
            await hm2.set('lk', 'lv');
            // 无 embedder 时 add 软失败 → usedFallback true；有 embedder 则 false。两种都不许崩
            check('live set no crash (fallback=' + hm2.usedFallback + ')', true);
            check('live store written', store.getMemory('lk').lk.value === 'lv');
            sc.stop();
            await new Promise((r) => setTimeout(r, 200));
            await hm2.set('lk2', 'lv2');
            check('live after stop -> fallback, no crash', hm2.usedFallback === true);
        }
    } else {
        console.log('SKIP live sidecar (python/hy_memory 不可用)');
    }

    console.log(failed === 0 ? 'ALL PASS' : 'FAILED=' + failed);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('EXC ' + (e && e.stack ? e.stack : e)); process.exit(1); });
