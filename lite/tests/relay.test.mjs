import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../dist/app.js';
import { taskToken } from '../dist/credentials.js';
import { createGateway } from '../gateway/server.mjs';

const tempRoot=path.resolve(process.env.USERPROFILE||process.env.HOME,'ops-tmp');fs.mkdirSync(tempRoot,{recursive:true});
test('多台电脑的中转、隔离、重连和授权',async t=>{
  const directory=fs.mkdtempSync(path.join(tempRoot,'lbd-relay-'));
  const gateway=createGateway({dataDir:path.join(directory,'gateway'),heartbeatInterval:1000});
  await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+gateway.server.address().port;
  const apps=[];
  const wait=async condition=>{const started=Date.now();while(!condition()){if(Date.now()-started>8000)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,25));}};
  const rpc=async(url,name,args={})=>{
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name,arguments:args}})});
    return {status:response.status,body:await response.json()};
  };
  try {
    const invites=await fetch(origin+'/gateway/invites',{method:'POST',headers:{Authorization:'Bearer '+gateway.adminKey(),'content-type':'application/json'},body:'{"count":2}'}).then(r=>r.json());
    for(let i=0;i<2;i++){
      const workspace=path.join(directory,'computer-'+i);fs.mkdirSync(workspace);
      const app=createApp({dataDir:path.join(directory,'client-'+i),port:0,seed:false});apps.push(app);
      const task=app.store.createTask({title:'相同任务名称',goal:'隔离验收',workspace});app.testTask=task;
      await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
      await app.relay.activate(invites.codes[i].code,'电脑 '+i);
    }
    await wait(()=>gateway.sessions.size===2&&apps.every(app=>app.relay.status().publicMcpUp));
    const addresses=apps.map(app=>app.connection.publicBase+'/mcp/'+taskToken(app.connection.token,app.testTask.id)+'/'+app.testTask.id);
    await t.test('两台电脑同时在线，调用只落到目标电脑',async()=>{
      for(let i=0;i<2;i++){
        const written=await rpc(addresses[i],'memory_set',{key:'所属电脑',value:'computer-'+i});assert.equal(written.body.result.isError,false);
        const file=await rpc(addresses[i],'write_file',{path:'remote.txt',content:'computer-'+i,why:'验证多设备真实写入'});assert.equal(file.body.result.isError,false);
      }
      for(let i=0;i<2;i++){assert.equal(apps[i].store.memory(apps[i].testTask.id,'所属电脑').value,'computer-'+i);assert.equal(fs.readFileSync(path.join(apps[i].testTask.workspace,'remote.txt'),'utf8'),'computer-'+i);}
    });
    await t.test('修改电脑或任务 ID 不能沿用另一条链接的凭据',async()=>{
      const swapped=apps[1].connection.publicBase+'/mcp/'+taskToken(apps[0].connection.token,apps[0].testTask.id)+'/'+apps[1].testTask.id;
      assert.equal((await rpc(swapped,'memory_get')).status,401);
      const another=apps[0].store.createTask({title:'同电脑另一任务',goal:'隔离',workspace:apps[0].testTask.workspace});
      const taskSwapped=apps[0].connection.publicBase+'/mcp/'+taskToken(apps[0].connection.token,apps[0].testTask.id)+'/'+another.id;
      assert.equal((await rpc(taskSwapped,'memory_get')).status,401);
    });
    await t.test('邀请码只能使用一次，管理接口需要独立权限',async()=>{
      await assert.rejects(()=>apps[0].relay.activate(invites.codes[0].code,'不应成功'),/已过期或已使用/);
      assert.equal((await fetch(origin+'/gateway/devices')).status,401);
      assert.equal((await fetch(origin+'/d/'+apps[0].relay.status().publicBase.split('/').at(-1)+'/api/tasks')).status,404);
    });
    await t.test('掉线自动重连，原公网链接恢复使用',async()=>{
      const id=apps[0].relay.status().publicBase.split('/').at(-1);const old=gateway.sessions.get(id);old.terminate();
      await wait(()=>gateway.sessions.get(id)&&gateway.sessions.get(id)!==old&&apps[0].relay.status().publicMcpUp);
      assert.equal((await rpc(addresses[0],'memory_get',{key:'所属电脑'})).body.result.isError,false);
    });
    await t.test('离线明确报错，撤销设备只影响该电脑',async()=>{
      const id=apps[0].relay.status().publicBase.split('/').at(-1);
      const revoke=await fetch(origin+'/gateway/devices/'+id+'/revoke',{method:'POST',headers:{Authorization:'Bearer '+gateway.adminKey()}});assert.equal(revoke.status,200);
      await wait(()=>!apps[0].relay.status().connected);
      assert.equal((await rpc(addresses[0],'memory_get')).status,404);
      assert.equal((await rpc(addresses[1],'memory_get',{key:'所属电脑'})).body.result.isError,false);
      await apps[1].relay.close();await wait(()=>gateway.sessions.size===0);
      assert.equal((await rpc(addresses[1],'memory_get')).status,503);
    });
  }finally{
    for(const app of apps)await app.close();await gateway.close();
    const resolved=path.resolve(directory);assert.ok(resolved.startsWith(tempRoot+path.sep)&&path.basename(resolved).startsWith('lbd-relay-'));fs.rmSync(resolved,{recursive:true,force:true});
  }
});
