"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.htmlToText = htmlToText;
exports.pageTitle = pageTitle;
exports.webFetch = webFetch;
exports.webSearch = webSearch;
exports.parseSearchHtml = parseSearchHtml;
exports.webDownload = webDownload;
const security_1 = require("./security");
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAIConsole/0.1';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
/** 把 HTML 粗略转为可读文本（去脚本样式、保留段落换行、解码实体） */
function htmlToText(html) {
    let s = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    return s
        .split('\n')
        .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
        .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
        .join('\n')
        .trim();
}
function pageTitle(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}
async function get(url) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        throw new security_1.ToolError(`网址无效：${url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
        throw new security_1.ToolError('只支持 http 与 https 网址');
    try {
        return await fetch(u, {
            headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
        });
    }
    catch (e) {
        throw new security_1.ToolError(`请求失败：${e instanceof Error ? e.message : String(e)}`);
    }
}
async function webFetch(url, maxChars) {
    const r = await get(url);
    if (!r.ok)
        throw new security_1.ToolError(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') ?? '';
    const raw = await r.text();
    const isHtml = /html/i.test(type) || /<html|<body/i.test(raw.slice(0, 2000));
    const body = isHtml ? htmlToText(raw) : raw;
    const title = isHtml ? pageTitle(raw) : '';
    const clipped = body.length > maxChars ? body.slice(0, maxChars) + `\n…（已截断，共 ${body.length} 字符）` : body;
    return `网址：${r.url}\n标题：${title || '—'}\n类型：${type || '未知'}\n\n${clipped}`;
}
/** 通过 DuckDuckGo 的 HTML 页面搜索（无需 API Key；页面结构变化或被拦截时可能解析不到结果） */
async function webSearch(query, count) {
    const r = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query));
    if (!r.ok)
        throw new security_1.ToolError(`搜索失败：HTTP ${r.status}`);
    return parseSearchHtml(await r.text(), count);
}
/** 解析 DuckDuckGo HTML 结果页（拆出来便于用样本测试） */
function parseSearchHtml(html, count) {
    const hits = [];
    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [];
    let sm;
    while ((sm = snipRe.exec(html)))
        snippets.push(htmlToText(sm[1]).replace(/\n+/g, ' '));
    let m;
    let i = 0;
    while ((m = linkRe.exec(html)) && hits.length < count) {
        let href = decodeEntities(m[1]);
        if (href.startsWith('//'))
            href = 'https:' + href;
        try {
            const real = new URL(href).searchParams.get('uddg');
            if (real)
                href = real;
        }
        catch {
            /* 保留原始地址 */
        }
        hits.push({ title: htmlToText(m[2]).replace(/\n+/g, ' '), url: href, snippet: snippets[i] ?? '' });
        i++;
    }
    return hits;
}
async function webDownload(url, maxBytes) {
    const r = await get(url);
    if (!r.ok)
        throw new security_1.ToolError(`HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > maxBytes)
        throw new security_1.ToolError(`文件过大（${len} 字节），上限 ${maxBytes} 字节`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes)
        throw new security_1.ToolError('文件过大');
    let name = 'download';
    try {
        const last = decodeURIComponent(new URL(r.url).pathname.split('/').filter(Boolean).pop() ?? '');
        if (last)
            name = last;
    }
    catch {
        /* 使用默认名 */
    }
    return { buf, name };
}
