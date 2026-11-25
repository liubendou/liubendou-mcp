"use strict";
/**
 * 记忆反向导出脚本（六本豆mcp v2 · P6）：Hy-Memory sidecar → data.json 形状的 memory 区。
 * - 数据源：hy-keymap.json（key→{id,updatedAt}）+ sidecar GET /api/v1/memories/{id} 的 content
 * - 产出：{key:{value,updatedAt}} 的 JSON 文件（默认 <data-dir>\\memory-export.json）
 * - 回退用法：把导出的 memory 区块合并回 data.json 的 memory 字段（或用 --merge 直接合并，
 *   合并前自动备份 data.json.bak-p6export-<ts>），随后把配置 memoryBackend 改回 json 即完成回退。
 * 用法：node tools/export-memory.js [--data-dir DIR] [--endpoint URL] [-o OUT] [--merge]
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadKeymap, rpc, endpointDefault } = require('./migrate-memory');

async function exportRaw(opts) {
    const dataDir = opts.dataDir;
    const endpoint = opts.endpoint || endpointDefault();
    const timeoutMs = opts.timeoutMs || 15000;
    const keymapPath = path.join(dataDir, 'hy-keymap.json');
    const keymap = loadKeymap(keymapPath);
    const out = { memory: {}, items: [], fail: 0 };
    for (const key of Object.keys(keymap)) {
        const entry = keymap[key];
        const item = { key, id: entry.id };
        try {
            const r = await rpc(endpoint, 'GET', '/api/v1/memories/' + encodeURIComponent(entry.id), undefined, timeoutMs);
            const value = r && (r.content !== undefined ? r.content : (r.value !== undefined ? r.value : ''));
            out.memory[key] = { value: String(value), updatedAt: entry.updatedAt || '' };
            item.status = 'ok';
        }
        catch (e) {
            item.status = 'fail';
            item.error = String(e && e.message ? e.message : e);
            out.fail++;
        }
        out.items.push(item);
    }
    return out;
}

module.exports = { exportRaw };

if (require.main === module) {
    (async () => {
        const argv = process.argv.slice(2);
        const get = (name, def) => {
            const i = argv.indexOf(name);
            return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
        };
        const dataDir = get('--data-dir', path.join(process.env.APPDATA || '', 'LocalAIConsole'));
        const endpoint = get('--endpoint', endpointDefault());
        const result = await exportRaw({ dataDir, endpoint });
        const outPath = get('-o', path.join(dataDir, 'memory-export.json'));
        fs.writeFileSync(outPath, JSON.stringify(result.memory, null, 2));
        console.log(JSON.stringify({ outPath, exported: Object.keys(result.memory).length, fail: result.fail, items: result.items }, null, 2));
        if (argv.includes('--merge') && Object.keys(result.memory).length > 0) {
            const dataPath = path.join(dataDir, 'data.json');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(dataPath, dataPath + '.bak-p6export-' + ts);
            const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
            raw.memory = Object.assign({}, raw.memory, result.memory);
            fs.writeFileSync(dataPath, JSON.stringify(raw, null, 2));
            console.log('MERGED into ' + dataPath);
        }
        process.exit(result.fail > 0 ? 2 : 0);
    })().catch((e) => { console.error('EXPORT-ERROR ' + (e && e.stack ? e.stack : e)); process.exit(1); });
}
