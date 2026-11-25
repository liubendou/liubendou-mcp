'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),directory=path.resolve(process.argv[2]||'');
if(!directory.startsWith(path.join(process.env.USERPROFILE,'ops-tmp')+path.sep)||!fs.existsSync(path.join(directory,'data/offline.lic')))throw new Error('Specify an existing isolated licensed-client test directory');
const executable=path.join(root,'release/LiubendouLite-0.3.0-win-x64-licensed/LiubendouLite.exe');
const admin=JSON.parse(fs.readFileSync(path.join(root,'data/gateway-admin.json'),'utf8'));
const env={...process.env,LBD_DATA_DIR:path.join(directory,'data'),LBD_PORT:'18777'},base='http://127.0.0.1:18777';
let gui,device;
const pause=()=>new Promise(resolve=>setTimeout(resolve,200));
async function until(check){const start=Date.now();while(!(await check())){if(Date.now()-start>30000)throw new Error('Licensed cloud check timed out');await pause();}}
async function api(route,method='GET',value){const response=await fetch(base+route,{method,headers:{'content-type':'application/json','x-lbd-panel':'1'},body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Local API failed: '+response.status);return response.json();}
async function owner(route,value){const response=await fetch(admin.server.replace(/\/$/,'')+route,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+admin.adminKey},body:JSON.stringify(value),signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Gateway management failed: '+response.status);return response.json();}
async function main(){
  gui=spawn(executable,[],{env,stdio:'ignore',windowsHide:false});
  await until(async()=>{try{return (await api('/api/status')).license?.licensed;}catch{return false;}});
  const invitation=await owner('/gateway/invites',{count:1});
  await api('/api/relay/activate','POST',{code:invitation.codes[0].code,name:'Lite 0.3 加密客户端发布验收'});
  const relay=JSON.parse(fs.readFileSync(path.join(directory,'data/relay.json'),'utf8'));device=relay.deviceId;
  await until(async()=>!!(await api('/api/status')).relay.publicMcpUp);
  const workspace=path.join(directory,'cloud-workspace');fs.mkdirSync(workspace,{recursive:true});
  const task=await api('/api/tasks','POST',{title:'加密分发包公网验收',goal:'从真实服务器以 curl 验证云端控制',workspace});
  const connection=await api('/api/tasks/'+task.id+'/connection');const address=connection.http.mcpServers.liubendou_lite.url;
  const program=fs.readFileSync(path.join(root,'tools/cloud-check.py'),'utf8'),quoted="'"+program.replaceAll("'","'\\''")+"'";
  const args=['-i',path.join(process.env.USERPROFILE,'.ssh/id_ed25519_hk'),'-o','IPQoS=none','-o','ConnectTimeout=10','-o','BatchMode=yes','-o','ConnectionAttempts=1','-o','StrictHostKeyChecking=yes','root@<your-server-ip>','python3 -c '+quoted];
  const marker='LBD_LICENSED_CLOUD_'+crypto.randomUUID();
  const result=await new Promise((resolve,reject)=>{const child=spawn('ssh',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',()=>{});child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(new Error('Remote curl verification failed: '+(stdout.trim()||'SSH/network failure; private address omitted')));try{resolve(JSON.parse(stdout.trim()));}catch{reject(new Error('Remote curl returned an unexpected result'));}});child.stdin.end(JSON.stringify({url:address,marker}));});
  if(!result.ok||result.serverInfo.version!=='0.3.0'||fs.readFileSync(path.join(workspace,'cloud-proof.txt'),'utf8')!==marker)throw new Error('Remote proof did not match the licensed client');
  fs.writeFileSync(path.join(directory,'cloud-result.json'),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;}).finally(async()=>{
  try{if(device)await owner('/gateway/devices/'+device+'/revoke',{});}catch{process.stderr.write('Test-device revocation needs retry.\n');process.exitCode=1;}
  if(gui){spawnSync(executable,['--exit'],{env,windowsHide:true,timeout:15000});await until(()=>gui.exitCode!==null).catch(()=>gui.kill());}
});
