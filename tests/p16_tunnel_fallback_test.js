"use strict";
/**
 * P16：隧道启停契约
 * 1) Cloudflare 快速隧道地址解析；
 * 2) "是不是本方案的反向隧道"判定；
 * 3) cloudflared 可执行文件能被找到；
 * 4) 公网回源探测只认本机 MCP 的响应头指纹（防"Caddy 502 也算通"）。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const tm = require('../src/dist/core/tunnel-manager.js');
const probes = require('../src/dist/core/app.js').__tunnelProbes;

let pass = 0;
let fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  [ok] ' + name); }
    catch (e) { fail++; console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function ta(name, fn) {
    try { await fn(); pass++; console.log('  [ok] ' + name); }
    catch (e) { fail++; console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

async function withServer(handler, fn) {
    const srv = http.createServer(handler);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try { await fn(srv.address().port); }
    finally { await new Promise((r) => srv.close(r)); }
}

(async () => {
    t('解析 trycloudflare 临时地址', () => {
        const line = '|  https://supplement-changing-fax-obligation.trycloudflare.com  |';
        assert.equal(tm._test.parseQuickTunnelUrl(line), 'https://supplement-changing-fax-obligation.trycloudflare.com');
    });
    t('没有地址时返回 null', () => {
        assert.equal(tm._test.parseQuickTunnelUrl('Registered tunnel connection'), null);
    });
    t('识别本方案的反向隧道', () => {
        assert.equal(tm._test.isOurTunnel('ssh -i key -N -R 8765:127.0.0.1:8765 root@<your-server-ip>'), true);
    });
    t('不会把别的端口/主机当成本方案', () => {
        assert.equal(tm._test.isOurTunnel('ssh -R 9000:127.0.0.1:9000 root@1.2.3.4'), false);
        assert.equal(tm._test.isOurTunnel('ssh -R 8765:127.0.0.1:8765 root@1.2.3.4'), false);
    });
    t('能找到 cloudflared', () => {
        const p = tm._test.cloudflaredBinary();
        if (process.platform === 'win32') {
            assert.ok(p && fs.existsSync(p), 'cloudflared 不存在：' + p);
        }
    });
    await ta('回源成功 = 带 mcp-session-id 指纹', async () => {
        await withServer((req, res) => {
            res.writeHead(404, { 'access-control-expose-headers': 'mcp-session-id' });
            res.end('not found');
        }, async (port) => {
            const r = await tm._test.probePublic('http://127.0.0.1:' + port, 3000);
            assert.equal(r.ok, true, r.detail);
        });
    });
    await ta('普通 200 页面不算回源（防 502/占位页误报）', async () => {
        await withServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<h1>hello</h1>');
        }, async (port) => {
            const r = await tm._test.probePublic('http://127.0.0.1:' + port, 3000);
            assert.equal(r.ok, false, r.detail);
        });
    });

    await ta('HTTPS 入口不再报 Protocol 不支持', async () => {
        const r = await probes.probeServerEntry('https://127.0.0.1:1', 1500);
        assert.ok(!/Protocol "https:" not supported/i.test(r.detail), r.detail);
    });
    await ta('HTTPS 公网 MCP 探测同样支持', async () => {
        const r = await probes.probePublicMcp('dummy', 1500, 'https://127.0.0.1:1');
        assert.ok(!/Protocol "https:" not supported/i.test(r.detail), r.detail);
    });
    await ta('公网入口 502 判失败（反代后面没隧道）', async () => {
        await withServer((req, res) => {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end('bad gateway');
        }, async (port) => {
            const r = await probes.probeServerEntry('http://127.0.0.1:' + port, 3000);
            assert.equal(r.ok, false, r.detail);
        });
    });
    await ta('公网 MCP 握手成功 = 200 + session id', async () => {
        await withServer((req, res) => {
            req.resume();
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sid-test' });
            res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
        }, async (port) => {
            const r = await probes.probePublicMcp('token', 3000, 'http://127.0.0.1:' + port);
            assert.equal(r.ok, true, r.detail);
        });
    });
    await ta('Cloudflare 进程探针：活着通过、死了失败', async () => {
        const alive = await probes.probeTunnelProcess({ mode: 'cloudflare', pid: process.pid });
        assert.equal(alive.ok, true, alive.detail);
        const dead = await probes.probeTunnelProcess({ mode: 'cloudflare', pid: 999999 });
        assert.equal(dead.ok, false, dead.detail);
    });
    t('面板在隧道启动中会自动重试（不再停在首次失败）', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dist', 'panel', 'index.html'), 'utf8');
        assert.ok(html.includes('tunnelCheckRetries'), '缺少重试计数');
        assert.ok(html.includes('setTimeout(runTunnelCheck, 4000)'), '缺少 4 秒重试');
        assert.ok(html.includes("'启动中'"), '缺少启动中状态');
    });

    console.log(fail ? 'P16-FAIL ' + fail : 'P16-ALL-PASS');
    process.exit(fail ? 1 : 0);
})();
