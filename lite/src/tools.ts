import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Store, contextText, redact } from './store.js';
import {assertLicense} from './licensing.js';
import { USER_CONTROL_INSTRUCTIONS } from './prompt.js';

const require = createRequire(import.meta.url);
interface Job {
  id: string; status: string; exitCode: number | null; output: string;
  endedAt: number | null; done: Promise<void>; child: {pid?: number};
}
interface Commands {
  start(command: string, cwd: string): Job;
  get(id: string): Job | undefined;
  cancel(id: string): Job;
  runForeground(command: string, cwd: string, timeoutMs: number): Promise<Job>;
  list(): Job[];
}
const { CommandManager } = require('../legacy/commands.js') as {CommandManager: new () => Commands};
const security = require('../legacy/security.js') as {
  resolveInRoots(roots: string[], p: string, base?: string, outside?: boolean): string;
  commandGate(command: string, confirm?: string, approved?: boolean): void;
};
const files = require('../legacy/fileOps.js') as {
  readTextFile(p: string): {text: string;version: string}; sha256(s: string | Buffer): string;
  findFiles(base: string, pattern: string, limit: number): string[];
  searchContent(base: string, pattern: string, opts: {caseInsensitive?: boolean;limit?: number;fileGlob?: string}): unknown;
};
const patches = require('../legacy/patch.js') as {applyPatchText(roots: string[], patch: string, versions: Record<string,string>, outside?: boolean): unknown;parsePatch(p: string): {path: string;moveTo?: string}[]};
const devtools = require('../legacy/devtools.js') as {shellQuote(s: string): string;projectOverview(root: string, dir: string): string};
const text = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const str = (): z.ZodString => z.string().min(1).max(1000000);
const optionalPath = z.string().max(4096).optional().describe('省略或相对路径以任务工作区为起点；可用绝对路径访问用户指定的其他位置。');
const why = z.string().min(1).max(500).describe('用一句话说明操作理由');
const commandConfirmation = z.literal('YES').optional().describe('操作需要确认且用户已明确授权时填 YES，无需重复询问用户。');
const agentId = z.string().optional();
const checkpointShape = {
  summary: z.string().min(1).max(12000).describe('当前任务的语义概括，说明完成了什么与重要结论'),
  next: z.string().max(6000).optional(), risks: z.string().max(6000).optional(),
  expected_revision: z.number().int().nonnegative().describe('project_context 返回的当前修订号；防止覆盖新活动'),
  status: z.enum(['active','paused','done']).optional(), goal: z.string().max(12000).optional(),
  path: optionalPath, agent_id: agentId
};
type ToolSchema = z.ZodObject<z.ZodRawShape>;
interface Definition {
  name: string; title: string; description: string; schema: ToolSchema;
  readOnly: boolean; meaningful: boolean;
  handler: (id: string, input: Record<string, unknown>) => Promise<unknown> | unknown;
}
interface PlanStep {
  id: string; ref: string; title: string; acceptance: string; verify: string;
  steps: string[]; completed_steps: number[]; deps: string[];
  status: 'todo'|'doing'|'done'|'blocked'; evidence: string; owner?: string; reason?: string;
}
interface Plan { title: string; steps: PlanStep[] }

export class ToolEngine {
  readonly definitions = new Map<string, Definition>();
  readonly commands = new CommandManager();
  readonly jobTasks = new Map<string,string>();
  constructor(readonly store: Store) { this.registerTools(); }
  private add<S extends z.ZodRawShape>(name: string, title: string, description: string, shape: S, readOnly: boolean, meaningful: boolean, handler: (id: string, input: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown): void {
    this.definitions.set(name, {name,title,description,schema:z.object(shape).strict(),readOnly,meaningful,handler:handler as Definition['handler']});
  }
  private resolve(id: string, input = '.'): string { return security.resolveInRoots([this.store.task(id).workspace], input, undefined, true); }
  private guardWrite(id: string, file: string, agent?: string): void {
    const rows = this.store.db.prepare('SELECT * FROM reservations WHERE expires>?').all(Date.now());
    const f = process.platform==='win32'?file.toLowerCase():file;
    for (const row of rows) {
      const reserved = process.platform==='win32'?String(row.path).toLowerCase():String(row.path);
      if ((f === reserved || f.startsWith(reserved + path.sep) || reserved.startsWith(f + path.sep)) && (row.task_id !== id || row.agent_id !== agent)) throw new Error('文件已被另一位 Agent 预占，稍后重试或释放预占。');
    }
  }
  private jobResult(job: Job): object {
    return {id:job.id,status:job.status,exit_code:job.exitCode,output:redact(job.output.slice(-24000)),has_more:job.output.length>24000};
  }
  private startJob(id: string, command: string, cwd?: string, confirm?: string): Job {
    security.commandGate(command, confirm);
    const job = this.commands.start(command, this.resolve(id, cwd));
    this.jobTasks.set(job.id, id);
    this.store.record(id, 'command_started', true, `已启动后台命令 ${job.id}（尚未完成）`, true);
    void job.done.then(() => this.store.record(id, 'command_finished', job.status === 'exited' && job.exitCode === 0, `命令 ${job.id} · ${job.status} · 退出码 ${job.exitCode}\n${job.output.slice(-1800)}`, true));
    return job;
  }
  private getJob(id: string, jobId: string): Job {
    const job = this.commands.get(jobId);
    if (!job || this.jobTasks.get(jobId) !== id) throw new Error('此任务没有该后台命令；服务重启后的命令结果请查看执行记录。');
    return job;
  }
  private planStatus(id: string, agent?: string): object {
    const plan=this.store.state<Plan>(id,'plan',{title:'',steps:[]});
    const done=new Set(plan.steps.filter(s=>s.status==='done').map(s=>s.id));
    let next=plan.steps.find(s=>s.status==='doing'&&(!s.owner||s.owner===agent));
    if(!next)next=plan.steps.find(s=>s.status==='todo'&&s.deps.every(d=>done.has(d)));
    if(next&&agent){next.status='doing';next.owner=agent;this.store.setState(id,'plan',plan);}
    return {message:plan.steps.length&&plan.steps.every(s=>s.status==='done')?'全部完成':next?'继续执行':'无可执行任务',current:next||null,blocked:plan.steps.filter(s=>s.status==='blocked'),plan};
  }
  async call(id: string, name: string, input: unknown): Promise<CallToolResult> {
    try {
      assertLicense();
      this.store.task(id);
      const def = this.definitions.get(name);
      if (!def) throw new Error(`没有工具 ${name}，请先读取 tools/list。`);
      const args = def.schema.parse(input ?? {}) as Record<string,unknown>;
      const out = await def.handler(id, args);
      const body = redact(text(out));
      if (!['memory_set','memory_delete','project_checkpoint','memory_checkpoint','task_checkpoint'].includes(name)) {
        const label = typeof args.path === 'string' ? args.path : typeof args.query === 'string' ? args.query : '';
        this.store.record(id, name, true, `${label ? label + '\n' : ''}${body.slice(0, 1600)}`, def.meaningful);
      }
      return {content:[{type:'text',text:body.length > 25000 ? body.slice(0,25000) + '\n[已截断；请缩小范围或分页读取]' : body}],isError:false};
    } catch (error) {
      const message = error instanceof z.ZodError ? `参数不正确：${error.issues.map(i => i.path.join('.') + ' ' + i.message).join('；')}` : error instanceof Error ? error.message : String(error);
      try { this.store.record(id, name, false, message); } catch { /* Unknown task cannot own an event. */ }
      return {content:[{type:'text',text:redact(message)}],isError:true};
    }
  }
  server(id: string): McpServer {
    this.store.task(id);
    const prompts = this.store.prompts(); const task = this.store.task(id);
    const head = prompts.promptProject[task.workspace] || prompts.promptMain || prompts.defaultPrompt;
    const server = new McpServer({name:'liubendou-lite-mcp-server',version:'0.3.3'}, {instructions:[head,prompts.customInstructions,USER_CONTROL_INSTRUCTIONS].filter(Boolean).join('\n\n')});
    for (const def of this.definitions.values()) {
      server.registerTool(def.name,{title:def.title,description:def.description,inputSchema:def.schema,
        annotations:{readOnlyHint:def.readOnly,destructiveHint:!def.readOnly,idempotentHint:def.readOnly,openWorldHint:!def.readOnly}},
        async args => this.call(id, def.name, args));
    }
    return server;
  }
  private alias(name: string, target: string): void {
    const def = this.definitions.get(target)!;
    this.definitions.set(name, {...def,name});
  }
  private registerTools(): void {
    this.add('session_info','查看会话信息','确认提示词版本、当前任务和工作区。',{ },true,false,id=>{
      const task=this.store.task(id);const prompts=this.store.prompts();
      return {version:'lite-0.3.3',prompt_fingerprint:createHash('sha256').update(JSON.stringify(prompts)).digest('hex').slice(0,12),task_id:id,workspace:task.workspace,user_home:os.homedir(),platform:process.platform,path_policy:'user-directed',time:new Date().toISOString()};
    });
    this.add('project_context','读取任务概况','接手时先读取本任务概况、关键记忆、最近活动和修订号。此连接始终绑定一个任务。',{path:optionalPath},true,false,id=>contextText(this.store.context(id)));
    this.add('project_checkpoint','更新任务概况','提交本任务的语义概括、下一步与阻塞。先读取 project_context，携带 expected_revision。历史版本保留。',checkpointShape,false,false,(id,a)=>this.store.checkpoint(id,a));
    this.alias('task_checkpoint','project_checkpoint');
    this.add('project_note','保存决定或坑点','向当前任务保存一条决定、坑点、约定或笔记。',{path:optionalPath,kind:z.enum(['decision','gotcha','convention','note']),text:str(),key:z.string().optional()},false,false,(id,a)=>this.store.saveMemory(id,{key:a.key||`${a.kind}-${randomUUID().slice(0,8)}`,value:a.text,kind:a.kind}));
    this.add('memory_set','保存长期记忆','按键保存本任务的长期记忆，更新同名记忆时保留历史版本。',{key:z.string().min(1).max(200),value:str(),kind:z.enum(['note','decision','gotcha','convention','requirement']).optional(),pinned:z.boolean().optional(),expected_version:z.number().int().nonnegative().optional()},false,false,(id,a)=>this.store.saveMemory(id,a));
    this.add('memory_get','读取长期记忆','读取本任务的一条记忆或分页读取，绝不会返回其他任务的记忆。',{key:z.string().optional(),limit:z.number().int().min(1).max(100).default(30),offset:z.number().int().nonnegative().default(0)},true,false,(id,a)=>a.key ? this.store.memory(id,a.key) || '没有该记忆' : {items:this.store.memories(id,a.limit,a.offset),offset:a.offset,limit:a.limit,total:this.store.context(id).memory_count});
    this.add('memory_search','检索长期记忆','用中英文关键词检索本任务记忆，返回匹配片段；无关查询返回空。',{query:z.string().min(1).max(300),limit:z.number().int().min(1).max(30).default(8),path:optionalPath},true,false,(id,a)=>this.store.search(id,a.query,a.limit));
    this.alias('project_memory_search','memory_search');
    this.alias('memory_context','memory_get'); this.alias('memory_checkpoint','memory_set');
    this.add('memory_delete','移除当前记忆','移除本任务的一条当前记忆，历史版本保留。',{key:z.string().min(1).max(200)},false,false,(id,a)=>({removed:this.store.deleteMemory(id,a.key)}));
    this.add('list_dir','查看目录','查看用户指定的目录。相对路径以任务工作区为起点，可使用工作区外的绝对路径。',{path:optionalPath},true,false,(id,a)=>fs.readdirSync(this.resolve(id,a.path),{withFileTypes:true}).slice(0,300).map(e=>({name:e.name,type:e.isDirectory()?'directory':e.isFile()?'file':'link'})));
    this.add('read_file','读取文件','读取用户指定的文本文件和 SHA256 版本号；修改前先读取版本。支持工作区外路径。',{path:str(),start_line:z.number().int().min(1).default(1),end_line:z.number().int().min(1).optional()},true,false,(id,a)=>{
      const result = files.readTextFile(this.resolve(id,a.path)); const lines=result.text.split(/\r?\n/);
      const end=Math.min(a.end_line??a.start_line+299,lines.length);
      return {path:a.path,version:result.version,total_lines:lines.length,start_line:a.start_line,end_line:end,content:lines.slice(a.start_line-1,end).map((l,i)=>`${a.start_line+i}: ${l}`).join('\n')};
    });
    this.add('write_file','写入文件','按用户指令新建文件，或携带 expected_version 覆盖已有文件。支持桌面等工作区外路径。',{path:str(),content:z.string().max(4000000),expected_version:z.string().optional(),why,agent_id:agentId},false,true,(id,a)=>{
      const file=this.resolve(id,a.path); this.guardWrite(id,file,a.agent_id);
      if(fs.existsSync(file) && (!a.expected_version || files.sha256(fs.readFileSync(file))!==a.expected_version)) throw new Error('STALE_FILE：覆盖已有文件前请 read_file 获取当前 expected_version。');
      fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,a.content,'utf8');
      return {path:a.path,bytes:Buffer.byteLength(a.content),version:files.sha256(a.content),result:'已写入'};
    });
    this.add('edit_file','精确修改文件','替换唯一匹配的原文；建议提供 expected_version 防止覆盖并发修改。',{path:str(),old_text:str(),new_text:z.string().max(4000000),expected_version:z.string().optional(),why,agent_id:agentId},false,true,(id,a)=>{
      const file=this.resolve(id,a.path); this.guardWrite(id,file,a.agent_id);const result=files.readTextFile(file);
      if(a.expected_version && a.expected_version!==result.version) throw new Error('STALE_FILE：文件已变化，请重新读取。');
      const old=result.text.includes('\r\n')?a.old_text.replace(/\r?\n/g,'\r\n'):a.old_text;
      const replacement=result.text.includes('\r\n')?a.new_text.replace(/\r?\n/g,'\r\n'):a.new_text;
      if(result.text.split(old).length!==2) throw new Error('old_text 必须在文件中恰好出现一次，请增加上下文。');
      const content=result.text.replace(old,replacement);fs.writeFileSync(file,content,'utf8');return {path:a.path,result:'已修改',version:files.sha256(content)};
    });
    this.add('edit_preview','预览修改','查看精确替换的前后文本，不写入文件。',{path:str(),old_text:str(),new_text:z.string(),why:z.string().optional()},true,false,(id,a)=>{const result=files.readTextFile(this.resolve(id,a.path));return {version:result.version,matches:result.text.split(a.old_text).length-1,before:a.old_text,after:a.new_text};});
    this.add('apply_patch','应用补丁','按用户指令应用多文件补丁；支持工作区外路径，可用 expected_versions 校验已有文件。',{patch:str(),expected_versions:z.record(z.string(),z.string()).optional(),why,agent_id:agentId},false,true,(id,a)=>{
      for(const op of patches.parsePatch(a.patch)){this.guardWrite(id,this.resolve(id,op.path),a.agent_id);if(op.moveTo)this.guardWrite(id,this.resolve(id,op.moveTo),a.agent_id);}
      return patches.applyPatchText([this.store.task(id).workspace],a.patch,a.expected_versions||{},true);
    });
    this.add('find_files','查找文件','按通配符在指定目录查找文件名。',{pattern:str(),path:optionalPath,limit:z.number().int().min(1).max(500).default(100)},true,false,(id,a)=>files.findFiles(this.resolve(id,a.path),a.pattern,a.limit));
    this.add('search_content','搜索文件内容','在指定目录的文本文件中按正则搜索，限制返回数量。',{pattern:z.string().min(1).max(300),path:optionalPath,case_insensitive:z.boolean().default(true),max_matches:z.number().int().min(1).max(200).default(50)},true,false,(id,a)=>files.searchContent(this.resolve(id,a.path),a.pattern,{caseInsensitive:a.case_insensitive,limit:a.max_matches}));
    this.add('project_overview','查看项目结构','查看指定目录的结构和 README 摘要。',{path:optionalPath},true,false,(id,a)=>devtools.projectOverview(this.store.task(id).workspace,this.resolve(id,a.path)));
    this.add('run_command','执行命令','在用户指定目录启动本地命令，cwd 省略时使用任务工作区。最多等待 1 秒；仍在运行则用 command_output 获取结果。命令具有本机用户权限。',{command:z.string().min(1).max(12000),cwd:optionalPath,why,confirm:commandConfirmation,allow_non_ascii:z.boolean().optional()},false,false,async(id,a)=>{
      const job=this.startJob(id,a.command,a.cwd,a.confirm);
      let timer:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([job.done,new Promise<void>(r=>{timer=setTimeout(r,1000);})]);clearTimeout(timer);
      return this.jobResult(job);
    });
    this.add('job_start','启动后台命令','在用户指定目录启动构建等长命令，立即返回命令 ID。用 job_poll 查看结果。',{command:z.string().min(1).max(12000),cwd:optionalPath,why,confirm:commandConfirmation,allow_non_ascii:z.boolean().optional()},false,false,(id,a)=>this.jobResult(this.startJob(id,a.command,a.cwd,a.confirm)));
    this.add('command_output','读取命令结果','读取本任务的后台命令状态和输出。',{id:str(),offset:z.number().int().nonnegative().default(0),wait_ms:z.number().int().min(0).max(3000).default(0)},true,false,async(id,a)=>{
      const job=this.getJob(id,a.id);
      if(a.wait_ms && job.endedAt===null){let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([job.done,new Promise<void>(r=>{timer=setTimeout(r,a.wait_ms);})]);clearTimeout(timer);}
      return {...this.jobResult(job),output:redact(job.output.slice(a.offset,a.offset+24000)),next_offset:Math.min(job.output.length,a.offset+24000)};
    });
    this.alias('job_poll','command_output');
    this.add('command_cancel','取消后台命令','结束本任务启动的命令及其子进程。',{id:str(),why},false,false,(id,a)=>{this.getJob(id,a.id);return this.jobResult(this.commands.cancel(a.id));});
    this.add('run_tests','运行项目测试','运行指定测试命令，默认 npm test；返回真实退出码或后台命令 ID。',{command:z.string().max(12000).default('npm test'),cwd:optionalPath,why:z.string().default('运行项目测试')},false,false,(id,a)=>this.jobResult(this.startJob(id,a.command,a.cwd)));
    for(const [name,args] of [['git_status','status --short --branch'],['git_diff','--no-pager diff'],['git_log','--no-pager log --oneline -15']] as const){
      this.add(name,name,'读取指定目录的 Git 信息。',{cwd:optionalPath},true,false,async(id,a)=>{const job=await this.commands.runForeground('git '+args,this.resolve(id,a.cwd),5000);if(job.exitCode!==0)throw new Error(redact(job.output));return redact(job.output);});
    }
    this.add('agent_register','登记 Agent','为当前任务登记一个 Agent 身份，用于文件预占。',{name:z.string().max(100).optional(),role:z.string().max(100).optional(),project:optionalPath},false,false,(id,a)=>{const agent={agent_id:randomUUID(),name:a.name||'Agent',role:a.role||'',task_id:id};this.store.setState(id,`agent:${agent.agent_id}`,agent);return agent;});
    this.add('reserve_files','预占文件','为 Agent 预占文件，防止其他会话同时写入。',{agent_id:str(),paths:z.array(str()).min(1).max(100),ttl_minutes:z.number().int().min(1).max(120).default(15),reason:z.string().optional()},false,false,(id,a)=>this.store.transaction(()=>{
      if(!this.store.state(id,`agent:${a.agent_id}`,null))throw new Error('请先 agent_register 登记 Agent。');
      const paths=a.paths.map(p=>this.resolve(id,p));for(const file of paths)this.guardWrite(id,file,a.agent_id);
      for(const file of paths)this.store.db.prepare('INSERT INTO reservations VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET task_id=excluded.task_id,agent_id=excluded.agent_id,expires=excluded.expires').run(file,id,a.agent_id,Date.now()+a.ttl_minutes*60000);
      return {reserved:a.paths,expires_in_minutes:a.ttl_minutes};
    }));
    this.add('release_files','释放文件预占','释放当前 Agent 在本任务的文件预占。',{agent_id:str(),paths:z.array(str()).optional()},false,false,(id,a)=>{if(a.paths){for(const p of a.paths)this.store.db.prepare('DELETE FROM reservations WHERE task_id=? AND agent_id=? AND path=?').run(id,a.agent_id,this.resolve(id,p));}else this.store.db.prepare('DELETE FROM reservations WHERE task_id=? AND agent_id=?').run(id,a.agent_id);return '已释放文件预占';});
    this.add('plan_create','记录任务步骤','为本任务保存带验收标准、子步骤和依赖关系的计划；默认追加，replace=true 替换未执行的计划。',{
      title:z.string().optional(),goal:z.string().optional(),project:optionalPath,agent_id:agentId,replace:z.boolean().default(false),steps:z.array(z.string()).optional(),
      tasks:z.array(z.object({ref:z.string().optional(),title:str(),acceptance:z.string().optional(),verify:z.string().optional(),steps:z.array(z.string()).optional(),deps:z.array(z.string()).optional()}).strict()).optional()
    },false,true,(id,a)=>{
      const existing=this.store.state<Plan>(id,'plan',{title:'',steps:[]});
      if(a.replace&&existing.steps.some(s=>s.status==='doing'))throw new Error('还有执行中的步骤，不能整体替换计划。');
      const base=a.replace?[]:existing.steps;
      const inputs=a.tasks||a.steps?.map(title=>({title}))||[];if(!inputs.length)throw new Error('请提供非空 tasks 或 steps。');
      const additions:PlanStep[]=inputs.map((step,index)=>({id:'T'+(base.length+index+1),ref:'ref' in step&&typeof step.ref==='string'?step.ref:'T'+(base.length+index+1),title:step.title,acceptance:'acceptance' in step&&typeof step.acceptance==='string'?step.acceptance:'',verify:'verify' in step&&typeof step.verify==='string'?step.verify:'',steps:'steps' in step&&Array.isArray(step.steps)?step.steps:[],completed_steps:[],deps:'deps' in step&&Array.isArray(step.deps)?step.deps:[],status:'todo',evidence:''}));
      const refs=new Map([...base,...additions].flatMap(s=>[[s.ref,s.id],[s.id,s.id]]));
      for(const step of additions){step.deps=step.deps.map(dep=>{const found=refs.get(dep);if(!found)throw new Error(`依赖 ${dep} 不存在。`);return found;});}
      const all=[...base,...additions];const visited=new Set<string>(),visiting=new Set<string>();
      const visit=(step:PlanStep):void=>{if(visiting.has(step.id))throw new Error('步骤依赖形成循环，请调整 deps。');if(visited.has(step.id))return;visiting.add(step.id);for(const dep of step.deps)visit(all.find(s=>s.id===dep)!);visiting.delete(step.id);visited.add(step.id);};all.forEach(visit);
      const plan={title:a.title||a.goal||existing.title||this.store.task(id).title,steps:all};this.store.setState(id,'plan',plan);return plan;
    });
    this.add('task_status','查看任务步骤','读取下一项可执行步骤；传 agent_id 时认领该步骤，全部结束时返回「全部完成」。',{agent_id:agentId,project:optionalPath},false,false,(id,a)=>this.planStatus(id,a.agent_id));
    this.add('task_progress','记录进度','记录步骤进度；step 表示刚完成的子步骤序号，new_step 用于追加子步骤。',{task_id:z.string().optional(),text:z.string().optional(),message:z.string().optional(),agent_id:agentId,project:optionalPath,step:z.number().int().positive().optional(),new_step:z.string().optional()},false,true,(id,a)=>{
      const plan=this.store.state<Plan>(id,'plan',{title:'',steps:[]});const step=plan.steps.find(s=>a.task_id?s.id===a.task_id:s.status==='doing'&&s.owner===a.agent_id);
      if(a.step||a.new_step){if(!step)throw new Error('没有找到正在执行的步骤，请先 task_status。');if(a.step){if(a.step>step.steps.length)throw new Error('子步骤序号超出计划。');if(!step.completed_steps.includes(a.step))step.completed_steps.push(a.step);}if(a.new_step)step.steps.push(a.new_step);this.store.setState(id,'plan',plan);}
      this.store.setState(id,'progress',a.text||a.message||'执行中');return {progress:a.text||a.message||'执行中',current:step||null};
    });
    this.add('task_complete','完成一个步骤','附上证据完成指定步骤；结束前需先 project_checkpoint 留下任务概况。',{task_id:str(),evidence:z.string().min(10),agent_id:agentId,project:optionalPath,no_checkpoint_reason:z.string().optional()},false,true,(id,a)=>{
      if(!this.store.overview(id))throw new Error('请先 project_checkpoint 保存任务概况和交接。');
      const plan=this.store.state<Plan>(id,'plan',{title:'',steps:[]});const step=plan.steps.find(s=>s.id===a.task_id);if(!step)throw new Error('找不到该步骤，请先 task_status。');
      if(step.owner&&step.owner!==a.agent_id)throw new Error('该步骤由另一位 Agent 执行。');
      if(step.deps.some(dep=>plan.steps.find(s=>s.id===dep)?.status!=='done'))throw new Error('依赖步骤尚未完成。');
      step.status='done';step.evidence=a.evidence;this.store.setState(id,'plan',plan);return this.planStatus(id,a.agent_id);
    });
    this.add('task_block','记录步骤阻塞','把指定步骤标记为阻塞，保存原因并返回其他可执行步骤。',{task_id:str(),reason:str(),agent_id:agentId,project:optionalPath},false,true,(id,a)=>{const plan=this.store.state<Plan>(id,'plan',{title:'',steps:[]});const step=plan.steps.find(s=>s.id===a.task_id);if(!step)throw new Error('找不到该步骤。');if(step.owner&&step.owner!==a.agent_id)throw new Error('该步骤由另一位 Agent 执行。');step.status='blocked';step.reason=a.reason;this.store.setState(id,'plan',plan);return this.planStatus(id,a.agent_id);});
    this.add('worktree_create','创建 Git 工作树','在用户指定的位置创建一个独立 Git 工作树，支持工作区外路径。',{path:str(),branch:str(),why},false,true,async(id,a)=>{const dir=this.resolve(id,a.path);this.guardWrite(id,dir);const job=await this.commands.runForeground(`git worktree add -b ${devtools.shellQuote(a.branch)} ${devtools.shellQuote(dir)}`,this.store.task(id).workspace,10000);if(job.exitCode!==0)throw new Error(job.output);return job.output;});
    this.add('worktree_remove','移除 Git 工作树','移除指定的干净 Git 工作树；支持工作区外路径，Git 会拒绝包含未提交修改的工作树。',{path:str(),why},false,true,async(id,a)=>{const dir=this.resolve(id,a.path);this.guardWrite(id,dir);if(dir===this.store.task(id).workspace)throw new Error('不能移除主工作区。');const job=await this.commands.runForeground(`git worktree remove ${devtools.shellQuote(dir)}`,this.store.task(id).workspace,10000);if(job.exitCode!==0)throw new Error(job.output);return job.output||'已移除工作树';});
    this.add('wait_for_http','探测本地服务','单次探测本地 HTTP 服务，最多 3 秒；尚未就绪时返回状态，避免长轮询。',{url:str()},true,false,async(_id,a)=>{const url=new URL(a.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('此工具只探测本机服务。');try{const response=await fetch(url,{signal:AbortSignal.timeout(3000),redirect:'error'});return {ready:response.ok,status:response.status};}catch{return {ready:false};}});
    this.add('port_status','查看端口','查看本机端口占用进程。',{port:z.number().int().min(1).max(65535)},true,false,async(id,a)=>{const command=process.platform==='win32'?`Get-NetTCPConnection -LocalPort ${a.port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State,OwningProcess | ConvertTo-Json`:`lsof -n -iTCP:${a.port}`;const job=await this.commands.runForeground(command,this.store.task(id).workspace,5000);return job.output||'没有查到端口占用';});
    this.add('kill_port','结束端口进程','结束占用指定端口的进程；必须 confirm="YES" 明示授权。',{port:z.number().int().min(1).max(65535),confirm:z.literal('YES').describe('用户已明确授权结束指定端口进程时填 YES，无需重复询问。'),why},false,true,async(id,a)=>{if(a.port===Number(process.env.LBD_PORT||8777))throw new Error('不能结束当前服务端口。');const command=process.platform==='win32'?`Get-NetTCPConnection -LocalPort ${a.port} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction Stop }`:process.platform==='darwin'?`lsof -nP -t -iTCP:${a.port} -sTCP:LISTEN | sort -u | while IFS= read -r target_pid; do if [ "$target_pid" != "${process.pid}" ]; then kill -TERM "$target_pid"; fi; done`:`fuser -k ${a.port}/tcp`;const job=await this.commands.runForeground(command,this.store.task(id).workspace,5000);if(job.exitCode!==0)throw new Error(job.output);return '已结束指定端口的监听进程';});
    this.add('report_progress','报告进度','保存当前任务的进度说明。',{text:str(),percent:z.number().min(0).max(100).optional()},false,true,(id,a)=>{this.store.setState(id,'progress',a);return a;});
  }
  async close(): Promise<void> {
    const running=this.commands.list().filter(j=>j.endedAt===null);
    for(const job of running)this.commands.cancel(job.id);
    await Promise.all(running.map(j=>j.done));
  }
}
