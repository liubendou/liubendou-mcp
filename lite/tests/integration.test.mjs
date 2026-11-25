import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp, agentPrompt } from '../dist/app.js';
import { Store } from '../dist/store.js';
import { CONNECTION_TEMPLATE } from '../dist/prompt.js';
import { taskToken } from '../dist/credentials.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.resolve(process.env.USERPROFILE || process.env.HOME || root, 'ops-tmp');
fs.mkdirSync(tempRoot, {recursive:true});
const testDir = fs.mkdtempSync(path.join(tempRoot, 'lbd-lite-'));
const workspace = path.join(testDir, 'workspace');fs.mkdirSync(workspace);
const dataDir=path.join(testDir,'data');

test('本地 MCP、任务记忆及交接的完整流程', async t => {
  let app=createApp({dataDir,port:0,seed:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.connection.port}`;
  const request=async(route,method='GET',data,headers={})=>{
    const res=await fetch(base+route,{method,headers:{'content-type':'application/json','x-lbd-panel':'1',...headers},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:res.status,data:await res.json()};
  };
  const a=(await request('/api/tasks','POST',{title:'任务甲',goal:'只保存甲的要求',workspace})).data;
  const b=(await request('/api/tasks','POST',{title:'任务乙',goal:'只保存乙的要求',workspace})).data;
  let client;
  const readText = result => result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  try {
    await t.test('真实 MCP 握手及工具发现',async()=>{
      client=new Client({name:'integration-client',version:'1.0.0'});
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${a.id}`),{requestInit:{headers:{Authorization:'Bearer '+app.connection.token}}}));
      const listed=await client.listTools();
      assert.ok(listed.tools.some(tool=>tool.name==='project_context'));
      assert.ok(listed.tools.some(tool=>tool.name==='project_checkpoint'));
      assert.ok(listed.tools.every(tool=>tool.annotations&&tool.inputSchema));
      assert.match(readText(await client.callTool({name:'project_context',arguments:{}})),/任务甲/);
    });
    await t.test('同一目录的两个任务也不会串记忆',async()=>{
      await client.callTool({name:'memory_set',arguments:{key:'数据库端口',value:'甲使用 5432 端口',kind:'decision'}});
      await request(`/api/tasks/${b.id}/memories`,'POST',{key:'数据库端口',value:'乙使用 3306 端口',kind:'decision'});
      const result=readText(await client.callTool({name:'memory_search',arguments:{query:'数据库 端口'}}));
      assert.match(result,/5432/);assert.doesNotMatch(result,/3306/);
      const unrelated=await client.callTool({name:'memory_search',arguments:{query:'量子纠缠超导拓扑'}});
      assert.deepEqual(JSON.parse(readText(unrelated)),[]);
    });
    await t.test('记忆更新保留历史，并拒绝过期版本',async()=>{
      const prev=app.store.memory(a.id,'数据库端口');
      await client.callTool({name:'memory_set',arguments:{key:'数据库端口',value:'甲改用 6432 端口',expected_version:prev.version}});
      const stale=await client.callTool({name:'memory_set',arguments:{key:'数据库端口',value:'错误覆盖',expected_version:prev.version}});
      assert.equal(stale.isError,true);assert.match(readText(stale),/STALE_MEMORY/);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE task_id=?').get(a.id).n,2);
    });
    await t.test('概况拒绝遗漏新活动，按修订号保存来源与历史',async()=>{
      const revision=app.store.task(a.id).revision;
      app.store.saveMemory(a.id,{key:'需求',value:'需要一键复制提示词',kind:'requirement'});
      const stale=await request(`/api/tasks/${a.id}/checkpoint`,'POST',{summary:'旧概况',expected_revision:revision});
      assert.equal(stale.status,400);assert.match(stale.data.error,/STALE_CONTEXT/);
      const current=app.store.task(a.id).revision;
      const first=await client.callTool({name:'project_checkpoint',arguments:{summary:'甲已改用 6432 端口，并要求复制提示词。',next:'继续实现复制按钮',expected_revision:current}});
      assert.notEqual(first.isError,true);assert.equal(app.store.context(a.id).pending,0);
      const second=await request(`/api/tasks/${a.id}/checkpoint`,'POST',{summary:'完成交接概括',next:'交给下一位 Agent',expected_revision:current});assert.equal(second.status,200);
      const history=(await request(`/api/tasks/${a.id}/history`)).data;assert.equal(history.length,2);assert.ok(JSON.parse(history[0].source_ids).memories.length>=2);
    });
    await t.test('授权连接模板原文、当前任务内容及预览脱敏',async()=>{
      const original=app.store.prompts();
      const result=(await request(`/api/tasks/${a.id}/prompt`)).data;
      const copied=result.text;
      assert.ok(copied.startsWith(CONNECTION_TEMPLATE.replace('{{MCP_URL}}',`${base}/mcp/${taskToken(app.connection.token,a.id)}/${a.id}`)));
      assert.match(copied,/使用 curl 按 MCP Streamable HTTP 流程操作/);
      assert.match(copied,/任务甲/);assert.match(copied,/6432/);assert.doesNotMatch(copied,/3306/);
      assert.ok(copied.includes(taskToken(app.connection.token,a.id)));assert.ok(!copied.includes(app.connection.token));assert.ok(!result.preview.includes(taskToken(app.connection.token,a.id)));assert.equal(copied,agentPrompt(app.store,a.id,app.connection));
      app.store.savePrompts(original);
    });
    await t.test('文件真实读写与防止覆盖并发修改',async()=>{
      const written=await client.callTool({name:'write_file',arguments:{path:'hello.txt',content:'first',why:'验证写入'}});assert.notEqual(written.isError,true);
      const read=JSON.parse(readText(await client.callTool({name:'read_file',arguments:{path:'hello.txt'}})));assert.match(read.content,/first/);
      const stale=await client.callTool({name:'write_file',arguments:{path:'hello.txt',content:'bad',expected_version:'wrong',why:'验证版本锁'}});assert.equal(stale.isError,true);
      await client.callTool({name:'edit_file',arguments:{path:'hello.txt',old_text:'first',new_text:'second',expected_version:read.version,why:'验证修改'}});
      assert.equal(fs.readFileSync(path.join(workspace,'hello.txt'),'utf8'),'second');
      const outside=await client.callTool({name:'write_file',arguments:{path:'../outside.txt',content:'user-directed output',why:'按用户要求保存到工作区外'}});assert.equal(outside.isError,false);assert.equal(fs.readFileSync(path.join(testDir,'outside.txt'),'utf8'),'user-directed output');
      const absolute=path.join(testDir,'outside-patch.txt');
      const patched=await client.callTool({name:'apply_patch',arguments:{patch:'*** Begin Patch\n*** Add File: '+absolute+'\n+user-directed patch\n*** End Patch',why:'按用户要求在工作区外应用补丁'}});assert.equal(patched.isError,false);assert.equal(fs.readFileSync(absolute,'utf8'),'user-directed patch\n');
    });
    await t.test('后台命令按任务隔离，退出失败不会记成成功',async()=>{
      const job=JSON.parse(readText(await client.callTool({name:'job_start',arguments:{command:'Write-Output LBD_TEST_OUTPUT; exit 7',why:'验证真实退出码'}})));
      const other=await request(`/api/tasks/${b.id}/call`,'POST',{name:'command_output',arguments:{id:job.id}});assert.equal(other.data.isError,true);
      const completed=JSON.parse(readText(await client.callTool({name:'job_poll',arguments:{id:job.id,wait_ms:3000}})));
      assert.equal(completed.exit_code,7);assert.match(completed.output,/LBD_TEST_OUTPUT/);
      const event=app.store.events(a.id,30).find(e=>e.tool==='command_finished');assert.equal(event.ok,0);
      assert.ok(app.store.context(a.id).pending>0);
    });
    await t.test('保留旧提示词所需的计划、子步骤和阻塞接口',async()=>{
      const info=await client.callTool({name:'session_info',arguments:{}});assert.equal(info.isError,false);
      const agent=JSON.parse(readText(await client.callTool({name:'agent_register',arguments:{name:'旧提示词兼容检查',role:'worker'}})));
      const plan=await client.callTool({name:'plan_create',arguments:{goal:'验证旧流程',tasks:[{ref:'first',title:'检查文件',acceptance:'能读取文件',steps:['读取文件','检查结果']},{ref:'second',title:'后续步骤',acceptance:'保存结果',deps:['first']}]}});
      assert.equal(plan.isError,false);
      const claimed=JSON.parse(readText(await client.callTool({name:'task_status',arguments:{agent_id:agent.agent_id}})));assert.equal(claimed.current.id,'T1');
      const progress=await client.callTool({name:'task_progress',arguments:{agent_id:agent.agent_id,task_id:'T1',step:1,text:'已读取文件'}});assert.equal(progress.isError,false);
      const done=await client.callTool({name:'task_complete',arguments:{agent_id:agent.agent_id,task_id:'T1',evidence:'已经实际读取并确认示例文件内容'}});assert.equal(done.isError,false);
      const next=JSON.parse(readText(await client.callTool({name:'task_status',arguments:{agent_id:agent.agent_id}})));assert.equal(next.current.id,'T2');
      const blocked=await client.callTool({name:'task_block',arguments:{agent_id:agent.agent_id,task_id:'T2',reason:'记录一个真实的待确认事项'}});assert.equal(blocked.isError,false);assert.equal(JSON.parse(readText(blocked)).blocked.length,1);
    });
    await t.test('复制地址可按原提示词用真实 curl 完成初始化到工具调用',async()=>{
      const execute=promisify(execFile);
      const address=`${base}/mcp/${taskToken(app.connection.token,a.id)}/${a.id}`;
      async function curl(payload,headers={}) {
        const args=['--silent','--show-error','--noproxy','127.0.0.1','--max-time','5','--dump-header','-','-X','POST','-H','Content-Type: application/json','-H','Accept: application/json, text/event-stream'];
        for(const [key,value] of Object.entries(headers))args.push('-H',key+': '+value);
        args.push('--data-binary',JSON.stringify(payload),address);
        let stdout;
        try{stdout=(await execute(process.platform==='win32'?'curl.exe':'curl',args,{encoding:'utf8',windowsHide:true})).stdout;}
        catch{throw new Error('curl 调用失败（地址凭据不输出）；请检查本地网络和 curl 是否存在。');}
        const boundary=stdout.indexOf('\r\n\r\n');const responseHeaders=stdout.slice(0,boundary);const raw=stdout.slice(boundary+4).trim();
        const status=Number(responseHeaders.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
        const values=raw.startsWith('data:')?raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5).trim())):raw?[JSON.parse(raw)]:[];
        return {status,headers:responseHeaders,result:values.at(-1)};
      }
      const init=await curl({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ai-client',version:'1.0'}}});
      assert.equal(init.status,200);const negotiated=init.result.result.protocolVersion;assert.equal(negotiated,'2025-03-26');
      const headers={'mcp-protocol-version':negotiated};const session=init.headers.match(/^mcp-session-id:\s*(.+)$/im)?.[1]?.trim();if(session)headers['mcp-session-id']=session;
      const initialized=await curl({jsonrpc:'2.0',method:'notifications/initialized'},headers);assert.ok([202,204].includes(initialized.status));
      const tools=await curl({jsonrpc:'2.0',id:2,method:'tools/list'},headers);assert.ok(tools.result.result.tools.some(tool=>tool.name==='memory_set'));
      const called=await curl({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'memory_set',arguments:{key:'curl验收',value:'已通过真实curl执行工具'}}},headers);
      assert.equal(called.result.result.isError,false);assert.equal(app.store.memory(a.id,'curl验收').value,'已通过真实curl执行工具');
    });
    await t.test('非法跨来源请求、缺少凭据和无面板标记均拒绝',async()=>{
      const csrf=await request('/api/tasks','POST',{title:'bad',workspace},{Origin:'https://example.com'});assert.equal(csrf.status,403);
      const missing=await fetch(base+'/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(missing.status,403);
      const auth=await fetch(`${base}/mcp/${a.id}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(auth.status,401);
      const invalid=await request(`/api/tasks/${a.id}/call`,'POST',{name:'write_file',arguments:{path:'bad.txt',content:'missing why'}});assert.equal(invalid.data.isError,true);
    });
    await t.test('stdio 客户端通过本机代理使用同一个任务',async()=>{
      const stdioClient=new Client({name:'stdio-test',version:'1.0.0'});
      const transport=new StdioClientTransport({command:process.execPath,args:['--disable-warning=ExperimentalWarning',path.join(root,'dist/index.js'),'--stdio','--task',b.id],env:{...process.env,LBD_DATA_DIR:dataDir},stderr:'pipe'});
      try{await stdioClient.connect(transport);const output=readText(await stdioClient.callTool({name:'memory_get',arguments:{key:'数据库端口'}}));assert.match(output,/3306/);assert.doesNotMatch(output,/6432/);}finally{await stdioClient.close();}
    });
    await t.test('归档、导出与重启后记忆恢复',async()=>{
      const exported=(await request(`/api/tasks/${a.id}/export`)).data;assert.equal(exported.task.id,a.id);assert.ok(exported.memory_versions.length>=2);
      await request(`/api/tasks/${b.id}`,'PATCH',{status:'archived'});
      assert.equal((await request('/api/tasks')).data.length,1);assert.equal((await request('/api/tasks?archived=1')).data.length,2);
      await client.close();client=null;const prompts=app.store.prompts();await app.close();app=null;
      const reopened=new Store(dataDir,prompts);try{assert.equal(reopened.memory(a.id,'数据库端口').value,'甲改用 6432 端口');assert.equal(reopened.task(b.id).status,'archived');assert.ok(reopened.overview(a.id));}finally{reopened.close();}
    });
  } finally {
    if(client)await client.close();if(app)await app.close();
    const resolved=path.resolve(testDir);assert.ok(resolved.startsWith(path.resolve(tempRoot)+path.sep)&&path.basename(resolved).startsWith('lbd-lite-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
