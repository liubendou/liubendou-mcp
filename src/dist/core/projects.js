"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
/**
 * 项目记忆：每个项目一个 JSON 文件（按项目绝对路径的哈希命名）。
 * 用来跨会话接力：目标、交接记录、决策与坑点。
 */
class ProjectStore {
    dir;
    constructor(dataDir) {
        this.dir = node_path_1.default.join(dataDir, 'projects');
        node_fs_1.default.mkdirSync(this.dir, { recursive: true });
    }
    fileFor(projectPath) {
        const key = node_crypto_1.default.createHash('sha1').update(node_path_1.default.resolve(projectPath)).digest('hex');
        return node_path_1.default.join(this.dir, key + '.json');
    }
    load(projectPath) {
        const f = this.fileFor(projectPath);
        if (node_fs_1.default.existsSync(f)) {
            try {
                return JSON.parse(node_fs_1.default.readFileSync(f, 'utf8'));
            }
            catch {
                /* 损坏时当作新项目处理 */
            }
        }
        return {
            path: node_path_1.default.resolve(projectPath),
            goal: '',
            status: 'active',
            updatedAt: new Date().toISOString(),
            nextId: 1,
            handoffs: [],
            notes: [],
        };
    }
    update(projectPath, fn) {
        const m = this.load(projectPath);
        fn(m);
        m.updatedAt = new Date().toISOString();
        const f = this.fileFor(projectPath);
        const tmp = f + '.tmp';
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
        node_fs_1.default.renameSync(tmp, f);
        return m;
    }
    /** 关键词搜索：每个词都要出现（不区分大小写） */
    search(projectPath, query) {
        const m = this.load(projectPath);
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0)
            return [];
        const hits = [];
        const check = (kind, time, text) => {
            const low = text.toLowerCase();
            if (words.every((w) => low.includes(w)))
                hits.push({ kind, time, text });
        };
        for (const h of m.handoffs)
            check('交接', h.time, `${h.summary} | 下一步：${h.next} | 风险：${h.risks}`);
        for (const n of m.notes)
            check(n.kind, n.time, n.text);
        return hits;
    }
}
exports.ProjectStore = ProjectStore;
