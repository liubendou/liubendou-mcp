'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const stage=path.join(root,'release/LiubendouLite-0.3.0-win-x64-licensed');
const directory=fs.mkdtempSync(path.join(process.env.USERPROFILE,'ops-tmp','lite-protected-'));
const data=path.join(directory,'data'),workspace=path.join(directory,'workspace');fs.mkdirSync(workspace,{recursive:true});
const executable=path.join(stage,'LiubendouLite.exe'),port=18777,base='http://127.0.0.1:'+port;
const env={...process.env,LBD_DATA_DIR:data,LBD_PORT:String(port)};
let passed=0,gui,client,proxy;
function check(value,name){assert.ok(value,name);passed++;process.stdout.write('PASS: '+name+'\n');}
function cli(args,expect=true,environment=env){const child=spawnSync(executable,args,{env:environment,encoding:'utf8',windowsHide:true,timeout:15000});if(expect)assert.equal(child.status,0,child.stderr||'native command failed');else assert.notEqual(child.status,0,'command unexpectedly accepted');return child;}
async function until(condition,timeout=20000){const start=Date.now();while(!(await condition())){if(Date.now()-start>timeout)throw new Error('Timed out waiting for packaged client');await new Promise(resolve=>setTimeout(resolve,150));}}
async function api(route,method='GET',value){const response=await fetch(base+route,{method,headers:{'content-type':'application/json','x-lbd-panel':'1'},body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(3000)});assert.equal(response.status,200+(method==='POST'&&route==='/api/tasks'?1:0));return response.json();}
const text=result=>result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
async function launch(){const ready=path.join(data,'native-ready.json');if(fs.existsSync(ready))fs.unlinkSync(ready);gui=spawn(executable,['--self-check'],{env,windowsHide:false,stdio:'ignore'});await until(async()=>{try{return (await api('/api/status')).license?.licensed;}catch{return false;}});await until(()=>fs.existsSync(ready));}
async function closeGui(){if(!gui)return;spawnSync(executable,['--exit'],{env,windowsHide:true,timeout:15000});await until(()=>gui.exitCode!==null,10000);gui=null;}
async function main(){
  check(!fs.existsSync(path.join(stage,'data'))&&!fs.existsSync(path.join(stage,'src'))&&!fs.existsSync(path.join(stage,'dist/index.js')),'distribution has no personal data or plaintext backend');
  check(!fs.readdirSync(path.join(stage,'legacy')).some(name=>name.endsWith('.js')),'all owned legacy tools are inside the encrypted payload');
  check(!fs.existsSync(path.join(stage,'LicenseIssuer.exe'))&&!fs.existsSync(path.join(stage,'authority.private.json')),'issuer and signing keys are excluded');
  cli(['--check-license'],false);check(true,'native client refuses to unlock without a licence');
  const request=path.join(directory,'device.lbdreq');cli(['--export-request',request]);check(fs.existsSync(request),'obfuscated client exports a real device request');
  const licence=path.join(directory,'device.lic');
  const issuer=spawnSync(path.join(root,'output/licensing/LicenseIssuer.exe'),['--issue',request,licence,'30'],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(issuer.status,0,issuer.stderr);cli(['--import-license',licence]);cli(['--check-license']);check(true,'desktop issuer signs and packaged client imports and validates the licence');
  const bad=path.join(directory,'tampered.lic'),requestData=JSON.parse(fs.readFileSync(request,'utf8'));
  fs.writeFileSync(bad,fs.readFileSync(licence,'utf8').replace(requestData.machineId,'a'.repeat(64)));cli(['--import-license',bad],false);check(true,'obfuscated client rejects a modified licence');
  const otherEnv={...env,LBD_DATA_DIR:path.join(directory,'other-device')};cli(['--import-license',licence],false,otherEnv);check(true,'packaged client rejects the licence for another device identity');
  const rejected=spawnSync(path.join(stage,'runtime/node.exe'),[path.join(stage,'dist/bootstrap.cjs')],{input:JSON.stringify({key:Buffer.alloc(32).toString('base64'),permit:'a'.repeat(44),expiresUtc:new Date(Date.now()+60000).toISOString()})+'\n',env:{...env,LBD_DATA_DIR:path.join(directory,'bad-key')},encoding:'utf8',windowsHide:true,timeout:10000});
  check(rejected.status!==0&&!fs.existsSync(path.join(directory,'bad-key','memory.sqlite')),'encrypted backend rejects an incorrect content key');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  await launch();let status=await api('/api/status');check(status.version==='0.3.0'&&status.license.licensed&&status.license.desktop_match===false,'licensed encrypted backend starts and does not expose the desktop permit');
  const native=JSON.parse(fs.readFileSync(path.join(data,'native-ready.json'),'utf8'));check(native.ready&&native.window_handle>0&&native.backend_pid===status.pid,'packaged native WebView2 window is ready');
  const a=await api('/api/tasks','POST',{title:'安装包验收甲',goal:'验证完整授权版',workspace});
  const b=await api('/api/tasks','POST',{title:'安装包验收乙',goal:'验证任务隔离',workspace});
  const connection=JSON.parse(fs.readFileSync(path.join(data,'connection.json'),'utf8'));
  client=new Client({name:'protected-release-check',version:'1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp/'+a.id),{requestInit:{headers:{Authorization:'Bearer '+connection.token}}}));
  check((await client.listTools()).tools.length===44,'real MCP handshake exposes 44 tools after offline activation');
  const written=await client.callTool({name:'write_file',arguments:{path:'proof.txt',content:'LICENSED_CORE_OK',why:'验证安装包中的加密工具'}});assert.equal(written.isError,false);
  check(fs.readFileSync(path.join(workspace,'proof.txt'),'utf8')==='LICENSED_CORE_OK','encrypted legacy file module writes a real file');
  const read=await client.callTool({name:'read_file',arguments:{path:'proof.txt'}});check(text(read).includes('LICENSED_CORE_OK'),'encrypted legacy file module reads the file');
  const command=await client.callTool({name:'run_command',arguments:{command:'Write-Output LICENSED_COMMAND_OK',why:'验证命令工具'}});assert.equal(command.isError,false);
  const job=JSON.parse(text(command));let output=job;
  if(job.id)output=JSON.parse(text(await client.callTool({name:'job_poll',arguments:{id:job.id,wait_ms:3000}})));
  check(JSON.stringify(output).includes('LICENSED_COMMAND_OK'),'encrypted command module runs a real local command');
  await client.callTool({name:'memory_set',arguments:{key:'授权版验收',value:'甲任务保存的长期记忆'}});
  await api('/api/tasks/'+b.id+'/memories','POST',{key:'授权版验收',value:'乙任务独立记忆'});
  const context=await api('/api/tasks/'+a.id);check(JSON.stringify(context).includes('甲任务保存')&&!JSON.stringify(context).includes('乙任务独立'),'task memories stay isolated in the licensed build');
  const overview=await client.callTool({name:'project_checkpoint',arguments:{summary:'授权版已完成实际工具和任务记忆验收',next:'发布安装包',expected_revision:context.task.revision}});check(overview.isError===false,'per-task summary updates with revision checking');
  const prompt=await api('/api/tasks/'+a.id+'/prompt');check(prompt.text.startsWith('这是我自己运营的 MCP 服务')&&prompt.text.includes('使用 curl 按 MCP Streamable HTTP 流程操作')&&prompt.text.includes('授权版已完成'),'original authorization prompt format and task handoff are retained');
  const config=await api('/api/tasks/'+a.id+'/connection');check(config.stdio.mcpServers.liubendou_lite.args.includes(path.join(stage,'dist/proxy.cjs')),'MCP configuration uses the licensed-service stdio proxy');
  proxy=new Client({name:'protected-stdio-check',version:'1.0'});await proxy.connect(new StdioClientTransport({command:process.execPath,args:[path.join(stage,'dist/proxy.cjs'),'--task',a.id],env}));
  check((await proxy.listTools()).tools.length===44,'real stdio proxy connects to the licensed desktop service');await proxy.close();proxy=null;
  await client.close();client=null;await closeGui();
  check(await fetch(base+'/api/status',{signal:AbortSignal.timeout(1000)}).then(()=>false,()=>true),'desktop exit stops its encrypted backend');
  await launch();check(JSON.stringify(await api('/api/tasks/'+a.id)).includes('甲任务保存的长期记忆'),'licence and long-term memory survive a full desktop restart');
  await closeGui();
  const loader=path.join(stage,'dist/bootstrap.cjs'),original=fs.readFileSync(loader);try{fs.appendFileSync(loader,'\n// tampered');cli(['--check-license'],false);check(true,'signed build manifest rejects a changed bootstrap');}finally{fs.writeFileSync(loader,original);}
  const core=path.join(stage,'secure/core.bin'),coreOriginal=fs.readFileSync(core);try{const changed=Buffer.from(coreOriginal);changed[0]^=1;fs.writeFileSync(core,changed);cli(['--check-license'],false);check(true,'signed build manifest rejects changed encrypted code');}finally{fs.writeFileSync(core,coreOriginal);}
  const summary={passed,failed:0,testDirectory:directory,licensedClient:true,encryptedBackend:true,obfuscatedNative:true,utc:new Date().toISOString()};
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(summary,null,2));process.stdout.write('RESULT: '+JSON.stringify(summary)+'\n');
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;}).finally(async()=>{try{await proxy?.close();await client?.close();await closeGui();}catch{if(gui)gui.kill();}});
