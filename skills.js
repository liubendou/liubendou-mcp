"use strict";
var __importDefault = (this && this.__importDefault) ? __importDefault : function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const security_1 = require("./security");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
/** 内置技能的种子版本：升级时用它判断「是否还是我们发的旧版」 */
const SEED_VERSION = '2026.10.26-t19';
/** 旧版 bugfix-workflow 正文（含已不存在的工具名），用于识别并升级老安装 */
const LEGACY_BUGFIX = ['---',
    'name: bugfix-workflow',
    'description: 修复一个缺陷的标准流程：复现、定位、最小修改、验证、记录、提交、交接',
    '---',
    '# 修复缺陷的标准流程',
    '',
    '1. 用 project_context 了解项目目标与上次交接。若是陌生项目，先用 project_overview。',
    '2. 用 run_command 复现问题，记下命令和关键输出。',
    '3. 用 code_definition、search_content 定位相关代码，用 read_files 读取相关文件。',
    '4. 用 apply_patch 做最小改动，不顺手重构无关代码。',
    '5. 用 get_diagnostics 检查，再运行相关测试，只汇报真正运行过的结果。',
    '6. 非显而易见的坑，用 project_note 记为 gotcha；做出的取舍记为 decision。',
    '7. 用 git_diff 确认改动范围，用 git_commit 只提交相关文件。',
    '8. 用 project_checkpoint 写交接：完成了什么、下一步、风险。',
    '',
].join('\n');
const SEED_SKILLS = {
    'session-startup': ['---',
        'name: session-startup',
        'description: 接手一个新任务的开局流程：先摸清项目与现场，再挑一件事动手。适合每次开工第一步。',
        'seed: ' + SEED_VERSION,
        '---',
        '# 开局：先看清，再动手',
        '',
        '1. `project_context` —— 读当前项目目标与上次交接。',
        '2. `project_overview` —— 陌生项目必做：目录结构、依赖、文件类型分布。',
        '3. `task_status` —— 看有没有别人正在做的任务、有没有文件预占（预占中的文件别人也在等）。',
        '4. `report_progress` —— 一句话说明「我现在要做什么」，用户能在面板上实时看到。',
        '5. `search_content` / `code_references` —— 定位实现与影响面；`read_file` 读关键文件。',
        '6. **一次只挑一件事做**。做完立刻 `task_progress` / `task_complete` 写清证据。',
        '',
        '不要一上来就改代码：先花一句话说清「我理解的任务是什么」，再动手。',
        '',
    ].join('\n'),
    'bugfix-workflow': ['---',
        'name: bugfix-workflow',
        'description: 修复一个缺陷的标准流程：复现、定位、最小修改、验证、记录、交接。修 bug 时先读这个。',
        'seed: ' + SEED_VERSION,
        '---',
        '# 修复缺陷',
        '',
        '1. `project_context` + `report_progress`：先说清要修什么，再复现。',
        '2. `run_command` 复现，记下**命令与关键输出**——不要凭猜改代码。',
        '3. `code_definition` / `search_content` 定位；`read_file` 读相关文件。',
        '4. 最小改动：单点用 `edit_file`，多处用 `apply_patch`（先用 `edit_preview` 看 diff）。',
        '5. `get_diagnostics` 检查 + `run_tests` / `run_command` 跑相关测试。**只汇报真跑过的结果。**',
        '6. 踩坑与取舍用 `project_note` 记下；`git_diff` 确认改动范围，`git_commit` 只提交相关文件。',
        '7. `project_checkpoint` 交接：完成了什么、下一步、风险。',
        '',
    ].join('\n'),
    'feature-workflow': ['---',
        'name: feature-workflow',
        'description: 交付一个新功能的标准流程：先定验收口径（sprint contract），再一次做一个任务，生成与评估分离。接新需求时先读这个。',
        'seed: ' + SEED_VERSION,
        '---',
        '# 交付一个新功能',
        '',
        '1. `plan_create` 写清：目标、验收标准 `acceptance`、**验收方式 `verify`**、子步骤与依赖。',
        '2. `task_status` 认领**一个**任务（一次只做一个），`task_progress` 汇报。',
        '3. 动手前先和用户对齐「什么算 done」——这是 sprint contract，也是后面复核的标尺。',
        '4. 实现 → `get_diagnostics` / `run_tests` 自测 → **按用户视角验收**（像用户一样点一遍），别只看单测。',
        '5. 有验收项的任务：`task_accept` 逐项勾过，每项附 ≥10 字证据。',
        '6. 找**另一个** agent 用 `task_review` 复核通过后，再 `task_complete`；实现者不能自签。',
        '7. `project_checkpoint` 交接：做了什么、下一步、风险、未验证项。',
        '',
    ].join('\n'),
    'review-workflow': ['---',
        'name: review-workflow',
        'description: 独立复核别人的产出：按验收方式自己跑一遍，给结论并存档。收到「请复核」时读这个。',
        'seed: ' + SEED_VERSION,
        '---',
        '# 独立复核',
        '',
        '1. 先 `task_status` 找「待复核」的任务；没有就不接。',
        '2. 读任务的 `acceptance` / `acceptance_items` / `verify` 与已有证据。',
        '3. **按 `verify` 的方式自己跑一遍**（`run_tests` / `run_command` / 打开界面点一遍），不要只看结论。',
        '4. `task_review` 给 `verdict`（pass / 不通过）、`report`（结论）、`report_path`（存档路径）。',
        '5. 不通过就写清**缺什么、怎么复现**，不要只写「有问题」。',
        '6. 复核者不能复核自己的产出（由工具强制）。',
        '',
    ].join('\n'),
    'handoff-workflow': ['---',
        'name: handoff-workflow',
        'description: 长任务的交接与续跑：把结论写进文件而不是留在对话里，续跑先读交接再动手。任务跨越多轮或上下文快满时读这个。',
        'seed: ' + SEED_VERSION,
        '---',
        '# 长任务交接与续跑',
        '',
        '1. 状态写到上下文之外：`project_note` 记决策与坑，`project_checkpoint` 写交接。',
        '2. 交接四件套：**完成了什么 / 下一步 / 风险 / 未验证项**。',
        '3. 上下文快满时主动收敛：把结论落盘，不要继续堆在对话里。',
        '4. 续跑顺序：`project_context` → `task_status` → `skill_read`（相关技能）→ 再动手。',
        '5. 没验证过的，明确写「未验证」；不确定就说不确定，不要写成已完成。',
        '',
    ].join('\n'),
};
const sha = (s) => node_crypto_1.default.createHash('sha256').update(s, 'utf8').digest('hex');
/** 技能：dataDir/skills/<name>/SKILL.md，可附带参考文件 */
class SkillStore {
    dir;
    builtin = new Set();
    constructor(dataDir) {
        this.dir = node_path_1.default.join(dataDir, 'skills');
        node_fs_1.default.mkdirSync(this.dir, { recursive: true });
        this.builtin = new Set(Object.keys(SEED_SKILLS));
        this.seed();
    }
    /** 写入内置技能：缺失则补齐；还是旧版种子则升级；用户改过的一律不动 */
    seed() {
        for (const [name, body] of Object.entries(SEED_SKILLS)) {
            const file = node_path_1.default.join(this.dir, name, 'SKILL.md');
            if (!node_fs_1.default.existsSync(file)) {
                this.write(name, body);
                continue;
            }
            let cur = '';
            try { cur = node_fs_1.default.readFileSync(file, 'utf8'); } catch { continue; }
            const meta = this.meta(cur);
            const seeded = String(meta.seed || '').trim();
            if (seeded && seeded !== SEED_VERSION) { this.write(name, body); continue; } // 旧种子 → 升级
            if (!seeded && name === 'bugfix-workflow' && /project_overview|code_definition|read_files|git_commit/.test(cur)) {
                this.write(name, body); // 老安装里的历史种子（含已废弃工具名）→ 升级
            }
        }
    }
    write(name, body) {
        const d = node_path_1.default.join(this.dir, name);
        node_fs_1.default.mkdirSync(d, { recursive: true });
        node_fs_1.default.writeFileSync(node_path_1.default.join(d, 'SKILL.md'), body, 'utf8');
    }
    meta(text) {
        const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        const out = {};
        if (m) {
            for (const line of m[1].split(/\r?\n/)) {
                const i = line.indexOf(':');
                if (i > 0)
                    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
        }
        return out;
    }
    list() {
        const out = [];
        for (const e of node_fs_1.default.readdirSync(this.dir, { withFileTypes: true })) {
            if (!e.isDirectory())
                continue;
            const f = node_path_1.default.join(this.dir, e.name, 'SKILL.md');
            if (!node_fs_1.default.existsSync(f))
                continue;
            const meta = this.meta(node_fs_1.default.readFileSync(f, 'utf8'));
            out.push({
                name: e.name,
                description: meta.description ?? '（无描述）',
                files: this.files(e.name),
                builtin: this.builtin.has(e.name),
                seed: meta.seed || '',
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }
    files(name) {
        const base = node_path_1.default.join(this.dir, name);
        const out = [];
        const walk = (d) => {
            for (const e of node_fs_1.default.readdirSync(d, { withFileTypes: true })) {
                const full = node_path_1.default.join(d, e.name);
                if (e.isDirectory())
                    walk(full);
                else
                    out.push(node_path_1.default.relative(base, full).split(node_path_1.default.sep).join('/'));
            }
        };
        walk(base);
        return out.filter((f) => f !== 'SKILL.md');
    }
    read(name, file) {
        if (!NAME_RE.test(name))
            throw new security_1.ToolError('技能名只能包含小写字母、数字和连字符');
        const base = node_path_1.default.join(this.dir, name);
        const target = file ? node_path_1.default.resolve(base, file) : node_path_1.default.join(base, 'SKILL.md');
        if (!target.startsWith(base + node_path_1.default.sep) && target !== base)
            throw new security_1.ToolError('文件不在技能目录内');
        if (!node_fs_1.default.existsSync(target))
            throw new security_1.ToolError(`技能或文件不存在：${name}${file ? '/' + file : ''}`);
        return node_fs_1.default.readFileSync(target, 'utf8');
    }
    save(name, description, body) {
        if (!NAME_RE.test(name))
            throw new security_1.ToolError('技能名只能包含小写字母、数字和连字符（最长 50）');
        const desc = description.replace(/\r?\n/g, ' ').trim();
        if (!desc)
            throw new security_1.ToolError('description 不能为空，它用于让 AI 判断何时使用该技能');
        const text = ['---', `name: ${name}`, `description: ${desc}`, '---', body.trim(), ''].join('\n');
        this.write(name, text);
    }
}
exports.SkillStore = SkillStore;
exports.SEED_SKILLS = SEED_SKILLS;
exports.SEED_VERSION = SEED_VERSION;
