"use strict";
// P3 验证：json 后端下 memory_* 行为与 0.1.0 一致；hymemory 断连自动回退不抛错
const path = require('path');
const fs = require('fs');
const os = require('os');
const store_1 = require(path.resolve(__dirname, '../src/dist/core/store'));
const memoryBackend_1 = require(path.resolve(__dirname, '../src/dist/core/memoryBackend'));
const tools_1 = require(path.resolve(__dirname, '../src/dist/core/tools'));

let failed = 0;
function unwrap(r) {
    return (r && Array.isArray(r.content) && r.content[0] && typeof r.content[0].text === 'string') ? r.content[0].text : r;
}
function check(name, actual, expected) {
    const a = unwrap(actual);
    const ok = (expected instanceof RegExp) ? expected.test(a) : (a === expected);
    if (ok) console.log('OK  ' + name);
    else {
        failed++;
        console.log('BAD ' + name + ' | actual=' + JSON.stringify(a) + ' | expected=' + (expected instanceof RegExp ? String(expected) : JSON.stringify(expected)));
    }
}
function checkEq(name, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) console.log('OK  ' + name);
    else {
        failed++;
        console.log('BAD ' + name + ' | actual=' + JSON.stringify(actual) + ' | expected=' + JSON.stringify(expected));
    }
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3test-'));
    const store = new store_1.DataStore(dir);
    const cfg = { get: () => ({ disabledTools: [], memoryBackend: 'json' }) };
    const cfgHm = { get: () => ({ disabledTools: [], memoryBackend: 'hymemory' }) };
    const memory = (0, memoryBackend_1.createMemoryBackend)(cfg, store);
    const ctx = { cfg, store, memory, cmds: {}, term: {}, approvals: {}, log: { info: () => {}, warn: () => {}, error: () => {}, add: () => {} }, dataDir: dir, projects: { list: () => [] }, skills: {} };
    const call = (n, a) => (0, tools_1.callTool)(n, a, ctx);

    check('backend.name= json', memory.name, 'json');
    check('memory_set', await call('memory_set', { key: 'p3key', value: 'p3value' }), '已保存记忆：p3key');
    check('memory_checkpoint alias', await call('memory_checkpoint', { key: 'k2', value: 'v2' }), '已保存记忆：k2');
    const raw = store.getMemory();
    check('updatedAt ISO fmt', /^\d{4}-\d{2}-\d{2}T/.test(raw.k2.updatedAt), true);
    check('memory_get key', await call('memory_get', { key: 'p3key' }), /^## p3key（更新于 .+）\np3value$/);
    check('memory_get all', await call('memory_get', {}), /^## p3key（更新于 .+）\np3value\n\n## k2（更新于 .+）\nv2$/);
    check('memory_context alias', await call('memory_context', { key: 'p3key' }), /^## p3key（更新于 .+）\np3value$/);
    check('memory_delete yes', await call('memory_delete', { key: 'p3key' }), '已删除记忆：p3key');
    check('memory_delete no', await call('memory_delete', { key: 'p3key' }), '没有该记忆');
    check('memory_delete k2', await call('memory_delete', { key: 'k2' }), '已删除记忆：k2');
    check('memory_get empty', await call('memory_get', {}), '没有记忆');

    // hymemory 后端：sidecar 不可达时自动回退 JSON，不抛错
    const mem2 = (0, memoryBackend_1.createMemoryBackend)(cfgHm, store, { endpoint: 'http://127.0.0.1:1', timeoutMs: 400 });
    check('hm name', mem2.name, 'hymemory');
    const ctx2 = Object.assign({}, ctx, { memory: mem2 });
    const c2 = (n, a) => (0, tools_1.callTool)(n, a, ctx2);
    check('hm fallback set', await c2('memory_set', { key: 'fb', value: '1' }), '已保存记忆：fb');
    check('hm fallback get', await c2('memory_get', { key: 'fb' }), /^## fb（更新于 .+）\n1$/);
    checkEq('hm usedFallback', mem2.usedFallback, true);
    check('hm fallback delete', await c2('memory_delete', { key: 'fb' }), '已删除记忆：fb');
    checkEq('store empty after all', Object.keys(store.getMemory()), []);

    console.log(failed === 0 ? 'ALL PASS' : 'FAILED=' + failed);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('EXC ' + (e && e.stack ? e.stack : e)); process.exit(1); });
