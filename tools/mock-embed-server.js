"use strict";
/**
 * Mock embedding 服务（六本豆mcp v2 · P7 评估用）
 * OpenAI 兼容 POST /v1/embeddings：{model, input: string|string[]} → {data:[{embedding,index}]}
 * 确定性哈希向量（64 维），仅用于评估/测试的链路打通，不代表真实语义质量。
 * 用法：node tools/mock-embed-server.js [port]   （打印实际端口）
 */
const http = require('node:http');

const DIMS = 256;
function h32(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
}
function vec(text) {
    const v = new Array(DIMS).fill(0);
    const s = String(text);
    for (const ch of s)
        v[h32(ch) % DIMS] += 1;
    for (let i = 0; i + 1 < s.length; i++)
        v[h32(s[i] + s[i + 1]) % DIMS] += 2;
    let n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
}

function createMockEmbedServer() {
    return http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (code, o) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(o));
            };
            if (req.method === 'GET' && req.url === '/healthz')
                return send(200, { status: 'ok' });
            if (req.method === 'POST' && req.url.replace(/\/$/, '').endsWith('/embeddings')) {
                let input = [];
                try {
                    const b = JSON.parse(body || '{}');
                    input = Array.isArray(b.input) ? b.input : [b.input || ''];
                }
                catch {
                    return send(400, { error: 'invalid json' });
                }
                return send(200, {
                    object: 'list',
                    data: input.map((t, index) => ({ object: 'embedding', embedding: vec(t), index })),
                    model: 'mock-256',
                    usage: { prompt_tokens: 0, total_tokens: 0 },
                });
            }
            send(404, { error: 'not_found' });
        });
    });
}

module.exports = { createMockEmbedServer, vec, DIMS };

if (require.main === module) {
    const port = Number(process.argv[2] || 0);
    const srv = createMockEmbedServer();
    srv.listen(port, '127.0.0.1', () => {
        console.log('MOCK-EMBED-READY http://127.0.0.1:' + srv.address().port + '/v1');
    });
}
