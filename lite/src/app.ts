import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, contextText, redact, type PromptSettings } from './store.js';
import { ToolEngine } from './tools.js';
import { CONNECTION_TEMPLATE, USER_CONTROL_INSTRUCTIONS } from './prompt.js';
import { taskToken } from './credentials.js';
import { Relay } from './relay.js';
import {assertLicense,licenseStatus} from './licensing.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export interface Connection { port: number; token: string; publicBase?:string }
function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size=0; const chunks:Buffer[]=[];
  for await (const chunk of req) {
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);size+=buffer.length;
    if(size>5*1024*1024)throw new Error('请求内容超过 5 MB，请分段提交。');chunks.push(buffer);
  }
  const raw=Buffer.concat(chunks).toString('utf8');return raw?JSON.parse(raw):{};
}
function authenticated(req: IncomingMessage, token: string): boolean {
  const received=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
  return received.length===expected.length&&timingSafeEqual(received,expected);
}
export function agentPrompt(store: Store, taskId: string, connection: Connection): string {
  const context=store.context(taskId);const prompts=store.prompts();
  const address=`${connection.publicBase||'http://127.0.0.1:'+connection.port}/mcp/${taskToken(connection.token,taskId)}/${taskId}`;
  const head=(prompts.connectionTemplate||CONNECTION_TEMPLATE).replaceAll('{{MCP_URL}}',address);
  return [head,USER_CONTROL_INSTRUCTIONS,'---\n以下为本次任务的交接资料：',contextText(context),
    connection.publicBase?'\n这个地址绑定当前电脑及当前任务。成功连接后先调用 project_context，读取最新记忆。':'\n尚未激活公网连接，当前地址仅供本机使用。请先在 GUI 中激活云端连接。',
    '阶段结束时请调用 project_checkpoint，提交任务概括、下一步和风险，并携带 project_context 返回的 expected_revision（当前修订号）。',
  ].filter(Boolean).join('\n\n');
}
export function createApp(options:{dataDir?:string;port?:number;seed?:boolean}={}): {server:http.Server;store:Store;engine:ToolEngine;connection:Connection;relay:Relay;close:()=>Promise<void>} {
  const dataDir=options.dataDir||process.env.LBD_DATA_DIR||path.join(root,'data');
  const legacy=JSON.parse(fs.readFileSync(path.join(root,'legacy/prompts.json'),'utf8')) as PromptSettings;
  const store=new Store(dataDir,legacy);const engine=new ToolEngine(store);
  const port=options.port??Number(process.env.LBD_PORT||8777);
  const connectionFile=path.join(dataDir,'connection.json');let saved:Partial<Connection>={};
  if(fs.existsSync(connectionFile))saved=JSON.parse(fs.readFileSync(connectionFile,'utf8')) as Partial<Connection>;
  const connection:Connection={port,token:saved.token||randomBytes(32).toString('hex')};
  const relay=new Relay(dataDir,connection,store);
  if(options.seed!==false&&store.listTasks(true).length===0){
    const demoDir=process.env.LBD_DEFAULT_WORKSPACE||path.join(root,'example-workspace');fs.mkdirSync(demoDir,{recursive:true});
    const task=store.createTask({title:'体验一下任务记忆',goal:'试着保存一条记忆、更新任务概况，再复制给 Agent，体验下一次如何接着做。',workspace:demoDir,demo:true});
    store.saveMemory(task.id,{key:'使用方式',value:'这是一个示例任务。可以直接体验，也可以点击左侧「新建任务」开始自己的工作。',kind:'note',pinned:true});
    store.saveMemory(task.id,{key:'任务约定',value:'每个任务分别保存记忆。工具执行结果自动留下记录，关键决定可以单独保存。',kind:'convention'});
    store.checkpoint(task.id,{summary:'已为这个示例任务准备好两条长期记忆。你可以编辑概况、添加记忆，或在工具页读取示例文件。所有操作只保存在本机。',next:'添加一条自己的记忆，然后点击右上角「复制给 Agent」。',risks:'示例内容仅用于体验，不代表你的实际项目进度。',expected_revision:store.task(task.id).revision});
  }
  const taskInput=z.object({title:z.string().trim().min(1).max(100),goal:z.string().max(12000).default(''),workspace:z.string().min(1).max(4096)}).strict();
  const memoryInput=z.object({key:z.string().trim().min(1).max(200),value:z.string().min(1).max(20000),kind:z.enum(['note','decision','gotcha','convention','requirement']).default('note'),pinned:z.boolean().optional(),expected_version:z.number().int().nonnegative().optional()}).strict();
  const checkpointInput=z.object({summary:z.string().min(1).max(12000),next:z.string().max(6000).optional(),risks:z.string().max(6000).optional(),expected_revision:z.number().int().nonnegative(),status:z.enum(['active','paused','done']).optional(),goal:z.string().max(12000).optional()}).strict();
  const promptsInput=z.object({promptMain:z.string().max(100000).optional(),customInstructions:z.string().max(100000).optional(),projectPrompt:z.string().max(100000).optional(),workspace:z.string().max(4096),connectionTemplate:z.string().min(1).max(100000).optional()}).strict();
  const server=http.createServer((req,res)=>{void (async()=>{
    assertLicense();
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host=req.headers.host||'';
    if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)){json(res,403,{error:'仅接受本机访问。'});return;}
    const origin=req.headers.origin;
    if(origin&&origin!==`http://${host}`){json(res,403,{error:'不允许跨来源访问。'});return;}
    const url=new URL(req.url||'/',`http://${host}`); const route=url.pathname;
    const mcp=route.match(/^\/mcp\/([\w-]+)(?:\/([\w-]+))?$/);
    if(mcp){
      const taskId=mcp[2]||mcp[1];
      const provided=mcp[2]?Buffer.from(mcp[1]):Buffer.alloc(0);const expected=Buffer.from(taskToken(connection.token,taskId));
      const urlAuthorized=provided.length===expected.length&&timingSafeEqual(provided,expected);
      if(!urlAuthorized&&!authenticated(req,connection.token)){json(res,401,{error:'请使用复制提示词中的完整地址，或 MCP 配置中的本机凭据。'});return;}
      if(req.method!=='POST'){json(res,405,{error:'此端点使用无会话 Streamable HTTP POST。'});return;}
      const instance=engine.server(taskId);const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{void transport.close();void instance.close();});
      await instance.connect(transport);await transport.handleRequest(req,res,await body(req));return;
    }
    if(route.startsWith('/api/')&&req.method!=='GET'&&req.headers['x-lbd-panel']!=='1') {json(res,403,{error:'请从本机面板操作。'});return;}
    if(route==='/api/status') {json(res,200,{ok:true,service:'liubendou-lite',version:'0.3.3',license:licenseStatus(req.headers['x-lbd-desktop']),port:connection.port,pid:process.pid,uptime:Math.floor(process.uptime()),memory_mb:Math.round(process.memoryUsage().rss/1048576),task_count:store.listTasks().length,tool_count:engine.definitions.size,default_workspace:process.env.LBD_DEFAULT_WORKSPACE||path.join(root,'example-workspace'),relay:relay.status()});return;}
    if(route==='/api/relay/activate'&&req.method==='POST'){const input=z.object({code:z.string().min(1).max(4000),name:z.string().min(1).max(80)}).strict().parse(await body(req));json(res,200,await relay.activate(input.code,input.name));return;}
    if(route==='/api/relay/reconnect'&&req.method==='POST'){json(res,200,relay.reconnect());return;}
    if(route==='/api/relay/check'&&req.method==='POST'){json(res,200,await relay.check());return;}
    if(route==='/api/relay/invites'&&req.method==='POST'){const input=z.object({count:z.number().int().min(1).max(20).default(1)}).strict().parse(await body(req));json(res,200,await relay.invites(input.count));return;}
    if(route==='/api/shutdown'&&req.method==='POST') {json(res,200,{stopping:true});setImmediate(()=>{void close();});return;}
    if(route==='/api/tasks'&&req.method==='GET'){json(res,200,store.listTasks(url.searchParams.get('archived')==='1'));return;}
    if(route==='/api/tasks'&&req.method==='POST'){const task=store.createTask(taskInput.parse(await body(req)));json(res,201,task);return;}
    if(route==='/api/prompts'&&req.method==='GET'){
      const p=store.prompts();json(res,200,{promptMain:p.promptMain,customInstructions:p.customInstructions,promptProject:p.promptProject,defaultPrompt:p.defaultPrompt,connectionTemplate:p.connectionTemplate||CONNECTION_TEMPLATE});return;
    }
    if(route==='/api/prompts'&&req.method==='POST'){
      const input=promptsInput.parse(await body(req));const prompts=store.prompts();
      if(input.promptMain!==undefined)prompts.promptMain=input.promptMain;
      if(input.customInstructions!==undefined)prompts.customInstructions=input.customInstructions;
      if(input.projectPrompt!==undefined){if(input.projectPrompt)prompts.promptProject[input.workspace]=input.projectPrompt;else delete prompts.promptProject[input.workspace];}
      if(input.connectionTemplate!==undefined){if(!input.connectionTemplate.includes('{{MCP_URL}}'))throw new Error('模板中请保留 {{MCP_URL}}，复制时才能填入正确地址。');prompts.connectionTemplate=input.connectionTemplate;}
      store.savePrompts(prompts);json(res,200,{saved:true});return;
    }
    const taskRoute=route.match(/^\/api\/tasks\/([\w-]+)(?:\/(.*))?$/);
    if(taskRoute){
      const id=taskRoute[1],action=taskRoute[2]||'';store.task(id);
      if(!action&&req.method==='GET'){json(res,200,store.context(id));return;}
      if(!action&&req.method==='PATCH'){
        const input=z.object({title:z.string().trim().min(1).max(100).optional(),goal:z.string().max(12000).optional(),status:z.enum(['active','paused','done','archived']).optional()}).strict().parse(await body(req));json(res,200,store.updateTask(id,input));return;
      }
      if(action==='memories'&&req.method==='GET'){
        const query=url.searchParams.get('q');const offset=z.coerce.number().int().nonnegative().parse(url.searchParams.get('offset')||0);
        json(res,200,query?store.search(id,query,30):store.memories(id,50,offset));return;
      }
      if(action==='memories'&&req.method==='POST'){json(res,200,store.saveMemory(id,memoryInput.parse(await body(req))));return;}
      if(action==='memory-delete'&&req.method==='POST'){const input=z.object({key:z.string().min(1)}).strict().parse(await body(req));json(res,200,{removed:store.deleteMemory(id,input.key)});return;}
      if(action==='checkpoint'&&req.method==='POST'){json(res,200,store.checkpoint(id,checkpointInput.parse(await body(req))));return;}
      if(action==='history'&&req.method==='GET'){
        json(res,200,store.db.prepare('SELECT * FROM overviews WHERE task_id=? ORDER BY id DESC LIMIT 30').all(id));return;
      }
      if(action==='events'&&req.method==='GET'){
        const before=url.searchParams.get('before');json(res,200,store.events(id,40,before?z.coerce.number().int().positive().parse(before):undefined));return;
      }
      if(action==='prompt'&&req.method==='GET'){
        const full=agentPrompt(store,id,connection);json(res,200,{text:full,preview:full.replaceAll(taskToken(connection.token,id),'[连接凭据]')});return;
      }
      if(action==='connection'&&req.method==='GET'){
        const publicUrl=`${connection.publicBase||'http://127.0.0.1:'+connection.port}/mcp/${taskToken(connection.token,id)}/${id}`;
        const entry=licenseStatus()?path.join(root,'dist/proxy.cjs'):path.join(root,'dist/index.js');
        json(res,200,{url:publicUrl.replace(taskToken(connection.token,id),'[连接凭据]'),public:!!connection.publicBase,http:{mcpServers:{liubendou_lite:{url:publicUrl}}},stdio:{mcpServers:{liubendou_lite:{command:process.execPath,args:['--disable-warning=ExperimentalWarning',entry,'--stdio','--task',id],env:{LBD_DATA_DIR:dataDir}}}}});return;
      }
      if(action==='export'&&req.method==='GET'){
        res.setHeader('content-disposition',`attachment; filename="liubendou-task-${id}.json"`);
        json(res,200,{exported_at:new Date().toISOString(),task:store.task(id),memories:store.db.prepare('SELECT * FROM memories WHERE task_id=?').all(id),memory_versions:store.db.prepare('SELECT * FROM memory_versions WHERE task_id=?').all(id),overviews:store.db.prepare('SELECT * FROM overviews WHERE task_id=?').all(id),events:store.db.prepare('SELECT * FROM events WHERE task_id=?').all(id)});return;
      }
      if(action==='tools'&&req.method==='GET'){json(res,200,[...engine.definitions.values()].map(d=>({name:d.name,title:d.title,description:d.description,schema:z.toJSONSchema(d.schema),readOnly:d.readOnly})));return;}
      if(action==='call'&&req.method==='POST'){
        const input=z.object({name:z.string().min(1).max(100),arguments:z.record(z.string(),z.unknown()).default({})}).strict().parse(await body(req));json(res,200,await engine.call(id,input.name,input.arguments));return;
      }
    }
    const assets:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml']};
    if(req.method==='GET'&&assets[route]){const [file,mime]=assets[route];res.writeHead(200,{'content-type':mime,'cache-control':'no-cache'});res.end(fs.readFileSync(path.join(root,'public',file)));return;}
    json(res,404,{error:'找不到这个页面或接口。'});
  })().catch(error=>{
    if(res.headersSent){res.end();return;}
    const message=error instanceof z.ZodError?error.issues.map(i=>i.path.join('.')+' '+i.message).join('；'):error instanceof Error?error.message:String(error);
    json(res,message.includes('找不到任务')?404:400,{error:redact(message).replaceAll(connection.token,'[连接凭据]')});
  });});
  server.on('listening',()=>{
    const address=server.address();if(address&&typeof address==='object')connection.port=address.port;
    fs.writeFileSync(connectionFile,JSON.stringify(connection,null,2),'utf8');relay.start();
  });
  async function close():Promise<void> {await relay.close();await engine.close();await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});store.close();}
  return {server,store,engine,connection,relay,close};
}
