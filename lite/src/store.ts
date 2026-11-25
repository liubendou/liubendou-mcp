import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_TEMPLATE } from './prompt.js';

export interface Task {
  id: string; title: string; goal: string; workspace: string; status: string;
  revision: number; created_at: string; updated_at: string; demo: number;
}
export interface Memory {
  id: number; task_id: string; key: string; value: string; kind: string;
  pinned: number; version: number; updated_at: string;
}
export interface Event {
  id: number; task_id: string; tool: string; ok: number; detail: string;
  created_at: string; meaningful: number;
}
export interface Overview {
  id: number; task_id: string; summary: string; next: string; risks: string;
  covered_revision: number; source_ids: string; created_at: string;
}
export interface PromptSettings {
  defaultPrompt: string; bridgePrompt: string; promptMain: string;
  customInstructions: string; promptProject: Record<string, string>; workspaceRoots: string[]; connectionTemplate?: string;
}
export interface Context {
  task: Task; memories: Memory[]; overview: Overview | null;
  events: Event[]; pending: number; memory_count: number;
}
const now = (): string => new Date().toISOString();
export const redact = (text: string): string => text
  .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[已隐藏凭据]')
  .replace(/((?:api[_-]?key|password|passwd|token|secret|authorization)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;"'}]+/gi, '$1[已隐藏]')
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[已隐藏私钥]');

function terms(text: string): string[] {
  const normalized = text.toLowerCase();
  const result: string[] = [...(normalized.match(/[a-z0-9_./:-]{2,}/g) || [])];
  for (const segment of normalized.match(/[\u4e00-\u9fff]+/g) || []) {
    if (segment.length === 1) result.push(segment);
    for (let i = 0; i < segment.length - 1; i++) result.push(segment.slice(i, i + 2));
  }
  return [...new Set(result)];
}

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly dataDir: string, legacy: PromptSettings) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'memory.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,workspace TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',revision INTEGER NOT NULL DEFAULT 0,demo INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),key TEXT NOT NULL,value TEXT NOT NULL,kind TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,UNIQUE(task_id,key));
      CREATE TABLE IF NOT EXISTS memory_versions(id INTEGER PRIMARY KEY,memory_id INTEGER NOT NULL,task_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),tool TEXT NOT NULL,ok INTEGER NOT NULL,detail TEXT NOT NULL,meaningful INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overviews(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),summary TEXT NOT NULL,next TEXT NOT NULL,risks TEXT NOT NULL,covered_revision INTEGER NOT NULL,source_ids TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(task_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(task_id,key));
      CREATE TABLE IF NOT EXISTS reservations(path TEXT PRIMARY KEY,task_id TEXT NOT NULL,agent_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_overviews_task ON overviews(task_id,id DESC);`);
    if (!this.db.prepare('SELECT key FROM settings WHERE key=?').get('prompts')) this.savePrompts(legacy);
    const prompts = this.prompts();
    const previousDefault = CONNECTION_TEMPLATE.replace(' Python urllib 请求会被拦截', '');
    if (prompts.connectionTemplate?.replace(/\r\n/g, '\n').trim() === previousDefault) {
      prompts.connectionTemplate = CONNECTION_TEMPLATE;
      this.savePrompts(prompts);
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prompts(): PromptSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('prompts');
    return JSON.parse(String(row?.value)) as PromptSettings;
  }
  savePrompts(value: PromptSettings): void {
    this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('prompts', JSON.stringify(value));
  }
  listTasks(includeArchived = false): Task[] {
    return this.db.prepare(`SELECT * FROM tasks ${includeArchived ? '' : "WHERE status!='archived'"} ORDER BY updated_at DESC`).all() as unknown as Task[];
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('找不到任务，请从任务列表复制正确的任务 ID。');
    return row as unknown as Task;
  }
  createTask(input: {title: string;goal: string;workspace: string;demo?: boolean}): Task {
    const workspace = fs.realpathSync(path.resolve(input.workspace));
    if (!fs.statSync(workspace).isDirectory()) throw new Error('工作区必须是一个已存在的文件夹。');
    const id = randomUUID(); const time = now();
    this.db.prepare('INSERT INTO tasks(id,title,goal,workspace,demo,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, input.title.trim(), input.goal, workspace, input.demo ? 1 : 0, time, time);
    return this.task(id);
  }
  updateTask(id: string, values: {title?: string;goal?: string;status?: string}): Task {
    const task = this.task(id);
    this.db.prepare('UPDATE tasks SET title=?,goal=?,status=?,revision=revision+1,updated_at=? WHERE id=?').run(values.title ?? task.title, values.goal ?? task.goal, values.status ?? task.status, now(), id);
    return this.task(id);
  }
  record(id: string, tool: string, ok: boolean, detail: string, meaningful = false): number {
    const result = this.db.prepare('INSERT INTO events(task_id,tool,ok,detail,meaningful,created_at) VALUES(?,?,?,?,?,?)').run(id, tool, ok ? 1 : 0, redact(detail).slice(0, 3000), meaningful ? 1 : 0, now());
    if (meaningful) this.db.prepare('UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?').run(now(), id);
    return Number(result.lastInsertRowid);
  }
  memories(id: string, limit = 50, offset = 0): Memory[] {
    this.task(id);
    return this.db.prepare('SELECT * FROM memories WHERE task_id=? ORDER BY pinned DESC,updated_at DESC LIMIT ? OFFSET ?').all(id, limit, offset) as unknown as Memory[];
  }
  memory(id: string, key: string): Memory | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE task_id=? AND key=?').get(id, key) as unknown as Memory | undefined;
  }
  saveMemory(id: string, input: {key: string;value: string;kind?: string;pinned?: boolean;expected_version?: number}): Memory {
    this.task(id);
    return this.transaction(() => {
      const prev = this.memory(id, input.key);
      if (input.expected_version !== undefined && (prev?.version ?? 0) !== input.expected_version) throw new Error('STALE_MEMORY：记忆已变化，请重新读取后再保存。');
      const value = redact(input.value);
      this.db.prepare(`INSERT INTO memories(task_id,key,value,kind,pinned,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,kind=excluded.kind,pinned=excluded.pinned,version=memories.version+1,updated_at=excluded.updated_at`).run(id, input.key, value, input.kind ?? prev?.kind ?? 'note', input.pinned === undefined ? prev?.pinned ?? 0 : Number(input.pinned), now());
      const memory = this.memory(id, input.key)!;
      this.db.prepare('INSERT INTO memory_versions(memory_id,task_id,key,value,version,created_at) VALUES(?,?,?,?,?,?)').run(memory.id, id, memory.key, memory.value, memory.version, now());
      this.record(id, 'memory_set', true, `保存${memory.kind}「${memory.key}」 · 第 ${memory.version} 版`, true);
      return memory;
    });
  }
  deleteMemory(id: string, key: string): boolean {
    this.task(id);
    return this.transaction(() => {
      const changed = Number(this.db.prepare('DELETE FROM memories WHERE task_id=? AND key=?').run(id, key).changes) > 0;
      if (changed) this.record(id, 'memory_delete', true, `移除当前记忆「${key}」，历史版本保留`, true);
      return changed;
    });
  }
  search(id: string, query: string, limit = 8): (Memory & {score: number})[] {
    this.task(id);
    const queryTerms = terms(query);
    if (!queryTerms.length) return [];
    const docs = this.db.prepare('SELECT * FROM memories WHERE task_id=?').all(id) as unknown as Memory[];
    const tokenized = docs.map(doc => terms(`${doc.key} ${doc.value}`));
    const avgLen = tokenized.reduce((sum, ts) => sum + ts.length, 0) / (docs.length || 1) || 1;
    return docs.map((doc, index) => {
      const tokens = tokenized[index]; let score = 0;
      for (const term of queryTerms) {
        if (!tokens.includes(term)) continue;
        const df = tokenized.reduce((n, ts) => n + Number(ts.includes(term)), 0);
        score += Math.log(1 + (docs.length - df + .5) / (df + .5)) * 2.2 / (1 + 1.2 * (.25 + .75 * tokens.length / avgLen));
        if (doc.key.toLowerCase().includes(term)) score += 1.5;
      }
      return { ...doc, score: Math.round(score * 10000) / 10000 };
    }).filter(doc => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  events(id: string, limit = 40, before?: number): Event[] {
    this.task(id);
    return this.db.prepare('SELECT * FROM events WHERE task_id=? AND id<? ORDER BY id DESC LIMIT ?').all(id, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as Event[];
  }
  overview(id: string): Overview | null {
    return this.db.prepare('SELECT * FROM overviews WHERE task_id=? ORDER BY id DESC LIMIT 1').get(id) as unknown as Overview ?? null;
  }
  checkpoint(id: string, input: {summary: string;next?: string;risks?: string;expected_revision: number;status?: string;goal?: string}): Overview {
    return this.transaction(() => {
      const task = this.task(id);
      if (task.revision !== input.expected_revision) throw new Error('STALE_CONTEXT：概括期间出现了新活动，请重新读取概况再提交，避免遗漏。');
      if (input.status || input.goal !== undefined) this.updateTask(id, {status: input.status, goal: input.goal});
      const revision = this.task(id).revision;
      const sources = { memories: this.memories(id, 100).map(m => ({id:m.id, version:m.version})), events: this.events(id, 30).map(e => e.id) };
      this.db.prepare('INSERT INTO overviews(task_id,summary,next,risks,covered_revision,source_ids,created_at) VALUES(?,?,?,?,?,?,?)').run(id, redact(input.summary), redact(input.next || ''), redact(input.risks || ''), revision, JSON.stringify(sources), now());
      this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), id);
      this.record(id, 'project_checkpoint', true, '已更新任务概况与交接');
      return this.overview(id)!;
    });
  }
  context(id: string): Context {
    const task = this.task(id); const overview = this.overview(id);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE task_id=?').get(id);
    return {task, overview, memories: this.memories(id, 20), events: this.events(id, 15), pending: task.revision - (overview?.covered_revision ?? 0), memory_count: Number(count?.n ?? 0)};
  }
  state<T>(id: string, key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM state WHERE task_id=? AND key=?').get(id, key);
    return row ? JSON.parse(String(row.value)) as T : fallback;
  }
  setState(id: string, key: string, value: unknown): void {
    this.db.prepare('INSERT INTO state VALUES(?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value').run(id, key, JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}

export function contextText(context: Context): string {
  const {task, overview, memories, events, pending} = context;
  return [`# ${task.title}`, `任务 ID：${task.id}`, `工作区：${task.workspace}`, `目标：${task.goal || '尚未填写'}`, `状态：${task.status}；当前修订号：${task.revision}`,
    '', '## 任务概况', overview?.summary || '尚未提交语义概括。以下为已保存的任务事实。',
    `下一步：${overview?.next || '尚未记录'}`, `阻塞与风险：${overview?.risks || '尚未记录'}`,
    pending ? `概况之后有 ${pending} 项关键变化，请结合以下记忆与活动继续。` : '概况已覆盖当前关键记录。',
    '', '## 关键记忆', ...memories.slice(0, 10).map(m => `- [${m.kind}] ${m.key}：${m.value.slice(0, 600)}`),
    '', '## 最近活动（工具执行事实）', ...events.slice(0, 8).map(e => `- ${e.ok ? '成功' : '失败'} · ${e.tool}：${e.detail.slice(0, 240)}`)
  ].join('\n');
}
