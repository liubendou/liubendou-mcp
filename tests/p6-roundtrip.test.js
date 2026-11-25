"use strict";
// P6 往返验证：migrate（data.json→sidecar）+ export（sidecar→memory 区）后关键字段一致；原 data.json 不被动
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { migrateRaw } = require(path.resolve(__dirname, '../tools/migrate-memory'));
const { exportRaw } = require(path.resolve(__dirname, '../tools/export-memory'));

let failed = 0;
function check(name, ok, detail) {
    if (ok) console.log('OK  ' + name);
    else { failed++; console.log('BAD ' + name + (detail ? ' | ' + detail : '')); }
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6test-'));
    const dataPath = path.join(dir, 'data.json');
    const mem = {
        '端口': { value: '443 是 sing-box，不能动', updatedAt: '2026-10-25T08:00:00.000Z' },
        'build': { value: 'build.ps1 产物复制到便携版目录', updatedAt: '2026-10-25T09:30:00.000Z' },
        'k3': { value: 'v3', updatedAt: '2026-10-25T10:00:00.000Z' },
        'k4': { value: '多行\n值 test', updatedAt: '2026-10-25T11:00:00.000Z' },
        'k5': { value: '', updatedAt: '2026-10-25T12:00:00.000Z' },
    };
    fs.writeFileSync(dataPath, JSON.stringify({ todos: [{ id: 1, text: 'keep-me', status: 'todo', updatedAt: 'x' }], nextId: 2, memory: mem, plan: { title: 'p', steps: [], updatedAt: 'y' } }, null, 2));
    const shaBefore = sha(dataPath);

    // 假 sidecar：add 记录 metadata；GET 回 content
    const texts = {};
    let n = 0;
    const addCalls = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.url === '/api/v1/add' && req.method === 'POST') {
                const b = JSON.parse(body);
                addCalls.push(b);
                if (b.text === 'FAILME') return send({ success: false, error_message: 'nope' });
                n++;
                const id = 'm-' + n;
                texts[id] = b.text;
                return send({ success: true, memory_id: id });
            }
            const m = req.url.match(/^\/api\/v1\/memories\/([^/]+)$/);
            if (m && req.method === 'GET') {
                if (!(m[1] in texts)) { res.writeHead(404); return res.end('{"error":"not_found"}'); }
                return send({ memory_id: m[1], content: texts[m[1]] });
            }
            if (m && req.method === 'DELETE') return send({ success: true, deleted_count: 1 });
            send({ error: 'not_found' });
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const endpoint = 'http://127.0.0.1:' + srv.address().port;

    // dry-run：不写 keymap 不调 add
    const dry = await migrateRaw({ dataDir: dir, endpoint, dryRun: true });
    check('dry-run total=5 ok=5', dry.total === 5 && dry.ok === 5 && addCalls.length === 0, JSON.stringify({ t: dry.total, o: dry.ok, c: addCalls.length }));
    check('dry-run no keymap', !fs.existsSync(path.join(dir, 'hy-keymap.json')));

    // 真迁移
    const rep = await migrateRaw({ dataDir: dir, endpoint });
    check('migrate ok=5 fail=0', rep.ok === 5 && rep.fail === 0, JSON.stringify({ o: rep.ok, f: rep.fail, items: rep.items }));
    check('data.json untouched', sha(dataPath) === shaBefore);
    check('backup created', !!rep.backup && fs.existsSync(rep.backup));
    const km = JSON.parse(fs.readFileSync(path.join(dir, 'hy-keymap.json'), 'utf8'));
    check('keymap 5 entries', Object.keys(km).length === 5);
    check('keymap keys match', JSON.stringify(Object.keys(km).sort()) === JSON.stringify(Object.keys(mem).sort()));
    check('updatedAt preserved', km['端口'] && km['端口'].updatedAt === '2026-10-25T08:00:00.000Z' && km['k5'].updatedAt === '2026-10-25T12:00:00.000Z');
    check('metadata.key passed', addCalls.some((c) => c.metadata && c.metadata.key === '端口' && c.text === '443 是 sing-box，不能动'));

    // 反向导出
    const exp = await exportRaw({ dataDir: dir, endpoint });
    check('export fail=0', exp.fail === 0);
    check('roundtrip key fields identical', JSON.stringify(exp.memory) === JSON.stringify(mem),
        'got=' + JSON.stringify(exp.memory).slice(0, 200));

    // 失败路径：单条 add 失败只计数
    mem['bad'] = { value: 'FAILME', updatedAt: 'z' };
    fs.writeFileSync(dataPath, JSON.stringify({ todos: [], nextId: 1, memory: mem, plan: null }));
    const rep2 = await migrateRaw({ dataDir: dir, endpoint });
    check('partial fail counted', rep2.fail === 1 && rep2.ok === 5, JSON.stringify({ o: rep2.ok, f: rep2.fail }));

    srv.close();
    console.log(failed === 0 ? 'ALL PASS' : 'FAILED=' + failed);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('EXC ' + (e && e.stack ? e.stack : e)); process.exit(1); });
