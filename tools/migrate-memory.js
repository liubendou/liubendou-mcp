"use strict";
/**
 * 记忆迁移脚本（六本豆mcp v2 · P6）：data.json 的 memory 区 → Hy-Memory sidecar。
 * - 只读 data.json，绝不改写原文件；迁移前自动复制 data.json.bak-p6-<ts> 备份
 * - 每条 {key:{value,updatedAt}} 调 sidecar POST /api/v1/add（text=value, metadata={key}）
 * - key→{id,updatedAt} 映射写入 hy-keymap.json（updatedAt 用原值，保证往返一致）
 * - 任何单条失败只计数不中断；整脚本不修改任何既有文件（除新建 keymap/备份）
 * 用法：node tools/migrate-memory.js [--data-dir DIR] [--endpoint URL] [--user-id U] [--dry-run]
 *   --data-dir 默认 %APPDATA%\LocalAIConsole
 *   --endpoint 默认 http://127.0.0.1:19527
 */
const fs = require('node:fs');
const path = require('node:path');

function endpointDefault() {
    return process.env.HY_MEMORY_SIDECAR_URL || 'http://127.0.0.1:' + (process.env.HY_MEMORY_SIDECAR_PORT || '19527');
}

function loadKeymap(keymapPath) {
    try {
        const j = JSON.parse(fs.readFileSync(keymapPath, 'utf8'));
        if (j && typeof j === 'object') {
            for (const k of Object.keys(j)) {
                if (typeof j[k] === 'string')
                    j[k] = { id: j[k], updatedAt: '' };
            }
            return j;
        }
    }
    catch { }
    return {};
}

async function rpc(endpoint, method, p, body, timeoutMs) {
    const r = await fetch(endpoint + p, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 8000),
    });
    if (!r.ok)
        throw new Error('sidecar HTTP ' + r.status);
    return await r.json();
}

async function migrateRaw(opts) {
    const dataDir = opts.dataDir;
    const endpoint = opts.endpoint || endpointDefault();
    const userId = opts.userId || process.env.HY_MEMORY_USER_ID || 'liubenben';
    const timeoutMs = opts.timeoutMs || 15000;
    const dryRun = !!opts.dryRun;
    const dataPath = path.join(dataDir, 'data.json');
    const keymapPath = path.join(dataDir, 'hy-keymap.json');
    const report = { dataPath, endpoint, dryRun, total: 0, ok: 0, fail: 0, items: [], backup: '' };

    const rawText = fs.readFileSync(dataPath, 'utf8');
    const raw = JSON.parse(rawText);
    const mem = raw.memory || {};
    const keys = Object.keys(mem);
    report.total = keys.length;

    // 备份（只复制，不改原件）
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = dataPath + '.bak-p6-' + ts;
    if (!dryRun) {
        fs.copyFileSync(dataPath, bak);
        report.backup = bak;
    }

    const keymap = loadKeymap(keymapPath);
    for (const key of keys) {
        const entry = mem[key] || {};
        const value = String(entry.value === undefined ? '' : entry.value);
        const item = { key, updatedAt: entry.updatedAt || '' };
        if (dryRun) {
            item.status = 'dry-run';
            report.ok++;
            report.items.push(item);
            continue;
        }
        const t0 = Date.now();
        try {
            const r = await rpc(endpoint, 'POST', '/api/v1/add', {
                text: value,
                user_id: userId,
                metadata: { key },
            }, timeoutMs);
            item.elapsedMs = Date.now() - t0;
            if (!r || r.success !== true || !r.memory_id)
                throw new Error((r && (r.error_message || r.error)) || 'add 未确认成功');
            keymap[key] = { id: String(r.memory_id), updatedAt: entry.updatedAt || '' };
            item.status = 'ok';
            item.memory_id = String(r.memory_id);
            report.ok++;
        }
        catch (e) {
            item.elapsedMs = Date.now() - t0;
            item.status = 'fail';
            item.error = String(e && e.message ? e.message : e);
            report.fail++;
        }
        report.items.push(item);
    }
    if (!dryRun)
        fs.writeFileSync(keymapPath, JSON.stringify(keymap));
    // 证明原文件未动：返回前后 sha 由调用方/测试校验，这里只读不写
    return report;
}

module.exports = { migrateRaw, loadKeymap, rpc, endpointDefault };

if (require.main === module) {
    (async () => {
        const argv = process.argv.slice(2);
        const get = (name, def) => {
            const i = argv.indexOf(name);
            return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
        };
        const dataDir = get('--data-dir', path.join(process.env.APPDATA || '', 'LocalAIConsole'));
        const report = await migrateRaw({
            dataDir,
            endpoint: get('--endpoint', endpointDefault()),
            userId: get('--user-id', ''),
            dryRun: argv.includes('--dry-run'),
        });
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.fail > 0 ? 2 : 0);
    })().catch((e) => { console.error('MIGRATE-ERROR ' + (e && e.stack ? e.stack : e)); process.exit(1); });
}
