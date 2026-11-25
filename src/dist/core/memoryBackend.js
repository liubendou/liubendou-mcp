"use strict";
var __importDefault = (this && this.__importDefault) ? this.__importDefault : function (mod) { return (mod && mod.__esModule) ? mod : { "default": mod }; };

Object.defineProperty(exports, "__esModule", { value: true });
exports.HyMemoryBackend = exports.LocalMemoryBackend = exports.JsonMemoryBackend = exports.createMemoryBackend = void 0;
/**
 * 记忆后端适配层（六本豆mcp v2，P5 版；T26 起 local 后端升级为多通道混合检索）
 * 接口（与 DataStore 的 memory 语义一致，返回形状逐字节兼容 0.1.0）：
 *   get(key?) -> { [key]: { value, updatedAt } }；key 省略返回全部；无记忆返回 {}
 *   set(key, value) -> void
 *   delete(key) -> boolean（有删除为 true，无该 key 为 false）
 *   search(query, limit) -> [{key, value, updatedAt, score, ...}]（仅 local / hymemory 支持）
 *
 * 后端：
 *   JsonMemoryBackend  默认。直接读写 data.json，行为与 0.1.0 一致。
 *   HyMemoryBackend    已被 local 混合检索取代（见下），保留兼容：需要外部 embedding 服务。
 *   LocalMemoryBackend **零模型**记忆后端（推荐默认）：
 *                      纯本地计算，不需要 embedding 端点 / API key / Python sidecar / 联网。
 *
 * 设计依据（2026-10 检索调研，无模型场景的共识做法）：
 *   1) 纯向量检索在 agent 记忆上会失灵：精确标识（API key、端口、路径、命令）词面上才找得到，
 *      BM25 反而稳；向量分数还会随库增大而挤在一起，尾部精度持续下降。
 *   2) 多路召回要按**名次**融合而不是分数（分数尺度不可比）：Reciprocal Rank Fusion，
 *      score = Σ w_i / (k + rank_i)，k 常取 60。
 *   3) 伪相关反馈（RM3）能零成本扩查询：用首轮命中的高频词回灌查询再排一次，补上同义表达。
 *   4) 召回后要做重排（语义/新近/重要/频次多因子）与**低置信拒答门**：没把握就返回空，
 *      别硬凑一条错的出来。
 * 本实现把这四条都落进 local 后端，并额外加了一条纯本地的「键关联」通道：
 *   key 与正文的词共现图 —— 键名里出现过的词，可以牵出与之共现的其它记忆（联想召回）。
 *
 * 通道与融合：
 *   C1 BM25 词法通道   —— 精确标识 / 专有名词 / 中文二元组
 *   C2 RM3 扩展通道     —— 首轮命中词的伪相关反馈扩展后重排
 *   C3 键关联图通道    —— 键名与正文的词共现图，联想召回
 *   C4 时间通道         —— 新近度排序
 *   → 加权 RRF 融合（k=60）→ 四因子重排（词面覆盖 / 新近度 / 键名命中 / 术语密度）→ 置信门
 */
const node_fs_1 = __importDefault(require("node:fs"));
/* ────────────────────────── 分词 ────────────────────────── */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'at', 'by', 'be', 'this', 'that', 'i', 'you', 'we', '的', '了', '和', '是', '在', '我', '有', '就', '不', '也', '要', '吗', '吧', '把', '被', '给', '让', '从', '到', '上', '下', '个', '这', '那', '你', '他', '她', '们', '吗']);
/** 英文/数字按词，中文按「单字 + 二元组」——零模型，纯词法 */
function tokenize(text) {
    const s = String(text || '').toLowerCase();
    const out = [];
    for (const m of s.matchAll(/[a-z0-9_]+/g)) {
        const w = m[0];
        if (w.length > 1 && !STOP.has(w))
            out.push(w);
    }
    const cjk = s.replace(/[^一-鿿]+/g, ' ').split(/\s+/).filter(Boolean);
    for (const seg of cjk) {
        for (let i = 0; i < seg.length; i++) {
            const ch = seg[i];
            if (!STOP.has(ch))
                out.push(ch);
            if (i + 1 < seg.length) {
                const bg = seg.slice(i, i + 2);
                if (!STOP.has(bg))
                    out.push(bg);
            }
        }
    }
    return out;
}
exports.tokenize = tokenize;
/** 字符三元组（拼写容错，中文也适用） */
function trigrams(text) {
    const s = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
    const out = [];
    for (let i = 0; i + 3 <= s.length; i++)
        out.push(s.slice(i, i + 3));
    return out;
}
exports.trigrams = trigrams;
/* ────────────────────────── BM25 ────────────────────────── */
function bm25(docs, queryTokens, k1 = 1.2, b = 0.75) {
    const N = docs.length || 1;
    const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
    const df = new Map();
    for (const d of docs) {
        for (const t of new Set(d.tokens))
            df.set(t, (df.get(t) || 0) + 1);
    }
    const qSet = [...new Set(queryTokens)];
    const scores = [];
    for (const d of docs) {
        const tf = new Map();
        for (const t of d.tokens)
            tf.set(t, (tf.get(t) || 0) + 1);
        let s = 0;
        for (const t of qSet) {
            const f = tf.get(t) || 0;
            if (!f)
                continue;
            const cnt = df.get(t) || 0;
            const idf = Math.log(1 + (N - cnt + 0.5) / (cnt + 0.5));
            s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.tokens.length / avgLen)));
        }
        scores.push(s);
    }
    return scores;
}
exports.bm25 = bm25;
/* ───────────────────── 加权 RRF 融合 ───────────────────── */
function weightedRRF(rankings, weights, k = 60) {
    const fused = new Map();
    rankings.forEach((list, li) => {
        const w = weights[li] ?? 1;
        list.forEach((id, rank) => {
            fused.set(id, (fused.get(id) || 0) + w / (k + rank + 1));
        });
    });
    return fused;
}
exports.weightedRRF = weightedRRF;
/**
 * LocalMemoryBackend（零模型记忆后端）
 * 事实源仍是 data.json（键值、updatedAt 与 json 模式完全兼容），
 * 检索在本机算完，不需要任何模型 / 端点 / 密钥 / sidecar / 联网。
 */
class LocalMemoryBackend {
    constructor(store, opts) {
        this.name = 'local';
        this.usedFallback = false;
        this.store = store;
        this.k1 = 1.2;
        this.b = 0.75;
        this.rrfK = 60;
        this.halfLifeDays = Number((opts && opts.halfLifeDays)) || 30;
        /** 置信门：融合分低于此值直接判定「没有可靠答案」 */
        this.minScore = Number((opts && opts.minScore)) || 0.005;
        /** RM3 扩展取多少词 */
        this.rm3Terms = Number((opts && opts.rm3Terms)) || 8;
    }
    async get(key) {
        return this.store.getMemory(key);
    }
    async set(key, value) {
        this.store.setMemory(key, value);
    }
    async delete(key) {
        return this.store.deleteMemory(key);
    }
    /** 构建索引：正文分词 + 键名 + 三元组 */
    buildDocs(all) {
        const docs = [];
        for (const k of Object.keys(all || {})) {
            const entry = (all || {})[k] || {};
            const value = String(entry.value ?? '');
            const keyTokens = tokenize(k);
            const bodyTokens = tokenize(value);
            const tokens = [...keyTokens, ...bodyTokens];
            docs.push({
                key: k,
                value,
                updatedAt: String(entry.updatedAt || ''),
                tokens,
                keyTokens,
                bodyTokens,
                grams: trigrams(k + ' ' + value),
                len: tokens.length || 1,
            });
        }
        return docs;
    }
    /** C1：BM25 词法通道 */
    lexicalChannel(docs, qTokens) {
        const s = bm25(docs, qTokens, this.k1, this.b);
        return s.map((v, i) => ({ id: docs[i].key, score: v }));
    }
    /** C2：RM3 伪相关反馈扩展 —— 用首轮命���里的高频词回灌查询再排一次 */
    rm3Channel(docs, qTokens, firstPass) {
        const top = firstPass.filter((r) => r.score > 0).slice(0, 5);
        if (!top.length)
            return [];
        const byKey = new Map(docs.map((d) => [d.key, d]));
        const freq = new Map();
        for (const r of top) {
            const d = byKey.get(r.id);
            if (!d)
                continue;
            for (const t of new Set(d.tokens)) {
                if (qTokens.includes(t))
                    continue;
                freq.set(t, (freq.get(t) || 0) + 1);
            }
        }
        const expand = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.rm3Terms).map(([t]) => t);
        if (!expand.length)
            return [];
        const q2 = [...qTokens, ...expand, ...expand]; // 扩展词权重加倍
        const s = bm25(docs, q2, this.k1, this.b);
        return s.map((v, i) => ({ id: docs[i].key, score: v }));
    }
    /** C3：键关联图 —— key 与正文的词共现，命中查询词能牵出共现记忆 */
    assocChannel(docs, qTokens) {
        const qSet = new Set(qTokens);
        const co = new Map(); // term -> Set(key)
        for (const d of docs) {
            const terms = new Set([...d.keyTokens, ...d.bodyTokens]);
            for (const t of terms) {
                if (!co.has(t))
                    co.set(t, new Set());
                co.get(t).add(d.key);
            }
        }
        const hit = new Map();
        for (const t of qSet) {
            const keys = co.get(t);
            if (!keys)
                continue;
            for (const k of keys)
                hit.set(k, (hit.get(k) || 0) + 1);
        }
        if (!hit.size)
            return [];
        const max = Math.max(...hit.values());
        return [...hit.entries()].map(([id, v]) => ({ id, score: v / max }));
    }
    /** C4：时间通道 —— 新近度 */
    recencyChannel(docs) {
        const now = Date.now();
        return docs.map((d) => {
            const ageDays = d.updatedAt ? Math.max(0, (now - Date.parse(d.updatedAt)) / 86400000) : 9999;
            const score = 0.5 + 0.5 * Math.exp(-ageDays / this.halfLifeDays);
            return { id: d.key, score };
        });
    }
    /** 四因子重排：词面覆盖 / 新近度 / 键名命中 / 术语密度 */
    rerank(docs, hits, qTokens) {
        const byKey = new Map(docs.map((d) => [d.key, d]));
        const now = Date.now();
        const qSet = new Set(qTokens);
        return hits.map((h) => {
            const d = byKey.get(h.id);
            const tokens = d ? d.tokens : [];
            const covered = qSet.size ? [...qSet].filter((t) => tokens.includes(t)).length / qSet.size : 0;
            const keyHit = d ? [...qSet].filter((t) => d.keyTokens.includes(t)).length / (qSet.size || 1) : 0;
            const density = d ? Math.min(1, tokens.filter((t) => qSet.has(t)).length / Math.max(6, d.len * 0.25)) : 0;
            const ageDays = d && d.updatedAt ? Math.max(0, (now - Date.parse(d.updatedAt)) / 86400000) : 9999;
            const recency = 0.5 + 0.5 * Math.exp(-ageDays / this.halfLifeDays);
            const final = 0.40 * covered + 0.22 * recency + 0.22 * keyHit + 0.16 * density + 0.35 * h.fused;
            return { ...h, covered, keyHit, density, recency, final };
        }).sort((a, b) => b.final - a.final);
    }
    /** 本地混合检索 */
    async search(query, limit = 8) {
        const all = (await this.get()) || {};
        const qTokens = tokenize(query);
        if (!qTokens.length)
            return [];
        const docs = this.buildDocs(all);
        if (!docs.length)
            return [];
        // 相关性通道：词法 / RM3 扩展 / 键关联图
        const c1 = this.lexicalChannel(docs, qTokens);
        const c2 = this.rm3Channel(docs, qTokens, c1);
        const c3 = this.assocChannel(docs, qTokens);
        const top = (arr, n) => arr.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, n).map((r) => r.id);
        const lists = [top(c1, 20), top(c2, 20), top(c3, 20)];
        // 加权 RRF：词法最重，扩展次之，键关联作补充（时间不进召回，只做重排因子）
        const fused = weightedRRF(lists, [1.0, 0.6, 0.45], this.rrfK);
        if (!fused.size)
            return [];
        const hits = [...fused.entries()].map(([id, score]) => ({ id, fused: score }))
            .sort((a, b) => b.fused - a.fused).slice(0, 30);
        // 置信门一：必须命中至少一个「强词」（英文词 / 中文二元组）——单个汉字太噪，不算数
        const byKey = new Map(docs.map((d) => [d.key, d]));
        let strong = qTokens.filter((t) => t.length > 1);
        if (!strong.length)
            strong = qTokens;
        const matched = (d) => strong.some((t) => d && d.tokens.includes(t));
        const hits2 = hits.filter((h) => matched(byKey.get(h.id)));
        if (!hits2.length)
            return [];
        // 重排
        const ranked = this.rerank(docs, hits2, qTokens);
        // 置信门二：融合分不过线就判定没有可靠答案（宁可返回空，也不硬凑）
        const best = ranked[0];
        if (!best || best.fused < this.minScore)
            return [];
        return ranked.filter((r) => r.fused >= this.minScore * 0.6).slice(0, Math.max(1, Math.min(Number(limit) || 8, 50)))
            .map((r) => {
                const d = byKey.get(r.id);
                const ageDays = d && d.updatedAt ? Math.max(0, (Date.now() - Date.parse(d.updatedAt)) / 86400000) : 9999;
                return {
                    key: r.id,
                    value: d ? d.value : '',
                    updatedAt: d ? d.updatedAt : '',
                    score: Number(r.final.toFixed(4)),
                    fused: Number(r.fused.toFixed(6)),
                    channels: { lexical: lists[0].includes(r.id), rm3: lists[1].includes(r.id), assoc: lists[2].includes(r.id) },
                    ageDays: Number(ageDays.toFixed(2)),
                };
            });
    }
}
exports.LocalMemoryBackend = LocalMemoryBackend;
/**
 * 旧版 HyMemoryBackend（混元 2.0，双写 + sidecar 语义召回）
 * 保留是为了兼容已有部署；**不再作为推荐路径** —— 它需要 embedding 端点 + API key + Python sidecar，
 * 而 local 后端已用零模型混合检索覆盖了绝大多数使用场景。
 */
class HyMemoryBackend {
    constructor(store, opts) {
        this.name = 'hymemory';
        this.usedFallback = false;
        this.store = store;
        this.endpoint = (opts && opts.endpoint) || process.env.HY_MEMORY_SIDECAR_URL || 'http://127.0.0.1:' + (process.env.HY_MEMORY_SIDECAR_PORT || '19527');
        this.timeoutMs = (opts && opts.timeoutMs) || 8000;
        this.userId = (opts && opts.userId) || process.env.HY_MEMORY_USER_ID || 'liubenben';
        this.keymapPath = (opts && opts.keymapPath) || '';
        this.keymap = this.loadKeymap();
    }
    loadKeymap() {
        try {
            if (this.keymapPath) {
                const raw = (0, node_fs_1.readFileSync)(this.keymapPath, 'utf8');
                const j = JSON.parse(raw);
                if (j && typeof j === 'object') {
                    // 兼容旧形状 {key: "id"} → {key: {id, updatedAt}}
                    for (const k of Object.keys(j)) {
                        if (typeof j[k] === 'string')
                            j[k] = { id: j[k], updatedAt: '' };
                    }
                    return j;
                }
            }
        }
        catch { }
        return {};
    }
    saveKeymap() {
        try {
            if (this.keymapPath)
                (0, node_fs_1.writeFileSync)(this.keymapPath, JSON.stringify(this.keymap));
        }
        catch { }
    }
    async get(key) {
        return this.store.getMemory(key);
    }
    async set(key, value) {
        this.store.setMemory(key, value);
        try {
            const res = await fetch(this.endpoint + '/api/v1/add', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: String(value), user_id: this.userId, metadata: { key } }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (res.ok) {
                const j = await res.json().catch(() => null);
                if (j && j.memory_id) {
                    this.keymap[key] = { id: String(j.memory_id), updatedAt: new Date().toISOString() };
                    this.saveKeymap();
                    this.usedFallback = false;
                    return;
                }
            }
        }
        catch { }
        this.usedFallback = true;
    }
    async delete(key) {
        const mapped = this.keymap[key];
        if (mapped && mapped.id) {
            try {
                await fetch(this.endpoint + '/api/v1/memories/' + encodeURIComponent(mapped.id), {
                    method: 'DELETE',
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            }
            catch { }
            delete this.keymap[key];
            this.saveKeymap();
        }
        return this.store.deleteMemory(key);
    }
    async search(query, limit = 8) {
        try {
            const res = await fetch(this.endpoint + '/api/v1/search', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: String(query), user_ids: [this.userId], limit: Number(limit) || 8 }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (res.ok) {
                const j = await res.json().catch(() => null);
                const list = (j && j.memories && j.memories.normal) || [];
                this.usedFallback = false;
                return list.map((m) => ({
                    key: String((m.metadata && m.metadata.key) || m.id),
                    value: String(m.content || ''),
                    updatedAt: String(m.created_at || ''),
                    score: 1,
                }));
            }
        }
        catch { }
        this.usedFallback = true;
        return [];
    }
}
exports.HyMemoryBackend = HyMemoryBackend;
function createMemoryBackend(config, store, opts) {
    let mode = 'json';
    try {
        const c = config && typeof config.get === 'function' ? config.get() : {};
        mode = String((c && c.memoryBackend) || 'json').toLowerCase();
    }
    catch {
        mode = 'json';
    }
    if (mode === 'hymemory') {
        try {
            return new HyMemoryBackend(store, opts);
        }
        catch { }
    }
    if (mode === 'local') {
        try {
            return new LocalMemoryBackend(store, opts);
        }
        catch { }
    }
    return new JsonMemoryBackend(store);
}
exports.createMemoryBackend = createMemoryBackend;
class JsonMemoryBackend {
    constructor(store) {
        this.name = 'json';
        this.usedFallback = false;
        this.store = store;
    }
    async get(key) {
        return this.store.getMemory(key);
    }
    async set(key, value) {
        this.store.setMemory(key, value);
    }
    async delete(key) {
        return this.store.deleteMemory(key);
    }
}
exports.JsonMemoryBackend = JsonMemoryBackend;
