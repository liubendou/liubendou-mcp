"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** 待办与记忆，持久化到 data.json；收件箱/发件箱目录也在这里初始化 */
class DataStore {
    dataDir;
    data;
    file;
    constructor(dataDir) {
        this.dataDir = dataDir;
        node_fs_1.default.mkdirSync(node_path_1.default.join(dataDir, 'inbox'), { recursive: true });
        node_fs_1.default.mkdirSync(node_path_1.default.join(dataDir, 'outbox'), { recursive: true });
        this.file = node_path_1.default.join(dataDir, 'data.json');
        this.data = { todos: [], nextId: 1, memory: {}, plan: null };
        if (node_fs_1.default.existsSync(this.file)) {
            try {
                this.data = { ...this.data, ...JSON.parse(node_fs_1.default.readFileSync(this.file, 'utf8')) };
            }
            catch {
                /* 损坏时从空数据开始 */
            }
        }
    }
    /** 运行时进度（不持久化）：AI 通过 report_progress 上报，面板实时显示 */
    progress = null;
    getProgress() {
        return this.progress ? { ...this.progress } : null;
    }
    setProgress(text, percent) {
        this.progress = { text, percent, updatedAt: new Date().toISOString() };
        return { ...this.progress };
    }
    getPlan() {
        return this.data.plan ? structuredClone(this.data.plan) : null;
    }
    /** 整体替换计划（update_plan） */
    setPlan(title, steps) {
        this.data.plan = { title, steps: steps.map((s) => ({ ...s })), updatedAt: new Date().toISOString() };
        this.save();
        return structuredClone(this.data.plan);
    }
    /** 整体替换待办列表（set_todos），保留新编号 */
    setTodos(items) {
        const now = new Date().toISOString();
        this.data.todos = items.map((it) => ({
            id: this.data.nextId++,
            text: it.text,
            status: it.status ?? 'todo',
            updatedAt: now,
        }));
        this.save();
        return structuredClone(this.data.todos);
    }
    save() {
        const tmp = this.file + '.tmp';
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        node_fs_1.default.renameSync(tmp, this.file);
    }
    listTodos() {
        return structuredClone(this.data.todos);
    }
    addTodo(text) {
        const todo = { id: this.data.nextId++, text, status: 'todo', updatedAt: new Date().toISOString() };
        this.data.todos.push(todo);
        this.save();
        return todo;
    }
    updateTodo(id, patch) {
        const todo = this.data.todos.find((t) => t.id === id);
        if (!todo)
            throw new Error(`没有待办 #${id}`);
        if (patch.text !== undefined)
            todo.text = patch.text;
        if (patch.status !== undefined)
            todo.status = patch.status;
        todo.updatedAt = new Date().toISOString();
        this.save();
        return { ...todo };
    }
    deleteTodo(id) {
        const before = this.data.todos.length;
        this.data.todos = this.data.todos.filter((t) => t.id !== id);
        if (this.data.todos.length === before)
            throw new Error(`没有待办 #${id}`);
        this.save();
    }
    getMemory(key) {
        if (key === undefined)
            return structuredClone(this.data.memory);
        const e = this.data.memory[key];
        return e ? { [key]: { ...e } } : {};
    }
    setMemory(key, value) {
        this.data.memory[key] = { value, updatedAt: new Date().toISOString() };
        this.save();
    }
    deleteMemory(key) {
        if (!(key in this.data.memory))
            return false;
        delete this.data.memory[key];
        this.save();
        return true;
    }
}
exports.DataStore = DataStore;
