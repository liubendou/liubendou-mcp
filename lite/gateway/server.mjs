import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const reply = (res, status, value) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
};
async function read(req, max=5*1024*1024) {
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>max)throw new Error('PAYLOAD_TOO_LARGE');chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export function createGateway(options={}) {
  const dataDir=options.dataDir||process.env.GATEWAY_DATA_DIR||path.join(path.dirname(fileURLToPath(import.meta.url)),'data');
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const stateFile=path.join(dataDir,'state.json'),adminFile=path.join(dataDir,'admin-key');
  let state;
  if(fs.existsSync(stateFile))state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  else { const admin=secret();fs.writeFileSync(adminFile,admin,{mode:0o600});state={adminHash:hash(admin),devices:{},invites:{}}; }
  const save=()=>{const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,stateFile);};save();
  const sessions=new Map(),pending=new Map();
  const maxDevices=options.maxDevices??128,maxPending=options.maxPending??32,perDevice=options.perDevice??4;
  const origin=()=>options.publicOrigin||process.env.GATEWAY_PUBLIC_ORIGIN||`http://127.0.0.1:${server.address().port}`;
  const authorized=req=>hash(String(req.headers.authorization||'').replace(/^Bearer /,''))===state.adminHash;
  const failDevice=(deviceId,status=503)=>{
    for(const [id,item]of pending)if(item.deviceId===deviceId){clearTimeout(item.timer);reply(item.res,status,{error:'DEVICE_OFFLINE',message:'这台电脑当前未连接，请让电脑主人打开客户端。'});pending.delete(id);}
  };
  const server=http.createServer((req,res)=>{void(async()=>{
    const url=new URL(req.url,'http://gateway.local');
    if(url.pathname==='/'||url.pathname==='/health'){
      if(req.method!=='GET'){reply(res,405,{error:'METHOD_NOT_ALLOWED'});return;}
      reply(res,200,{service:'liubendou-relay-gateway',version:'0.2.0',status:'ready'});return;
    }
    if(url.pathname.startsWith('/gateway/')&&req.headers.origin){reply(res,403,{error:'BROWSER_ORIGIN_NOT_ALLOWED'});return;}
    if(url.pathname==='/gateway/enroll'&&req.method==='POST'){
      const input=JSON.parse(await read(req,4096));const key=hash(String(input.invite||''));const invite=state.invites[key];
      if(!invite||invite.used||invite.expires<Date.now()){reply(res,403,{error:'INVITE_INVALID',message:'邀请码无效、已使用或已过期。'});return;}
      const deviceId=crypto.randomUUID();const deviceSecret=secret();
      state.devices[deviceId]={name:String(input.name||'我的电脑').slice(0,80),secretHash:hash(deviceSecret),createdAt:new Date().toISOString(),revoked:false};
      invite.used=true;save();
      reply(res,201,{deviceId,deviceSecret,server:origin(),publicBase:origin()+'/d/'+deviceId});return;
    }
    if(url.pathname==='/gateway/invites'&&req.method==='POST'){
      if(!authorized(req)){reply(res,401,{error:'ADMIN_AUTH_REQUIRED'});return;}
      const input=JSON.parse(await read(req,4096));const count=Math.min(20,Math.max(1,Math.floor(Number(input.count)||1)));
      const duration=Math.min(168,Math.max(1,Number(input.hours)||24));const codes=[];
      for(const [key,item]of Object.entries(state.invites))if(item.expires<Date.now()||item.used)delete state.invites[key];
      for(let i=0;i<count;i++){const value=secret();const expires=Date.now()+duration*3600000;state.invites[hash(value)]={expires,used:false};codes.push({code:'lbd1.'+Buffer.from(JSON.stringify({server:origin(),invite:value})).toString('base64url'),expiresAt:new Date(expires).toISOString()});}
      save();reply(res,201,{codes});return;
    }
    if(url.pathname==='/gateway/devices'&&req.method==='GET'){
      if(!authorized(req)){reply(res,401,{error:'ADMIN_AUTH_REQUIRED'});return;}
      reply(res,200,{devices:Object.entries(state.devices).map(([id,device])=>({id,name:device.name,createdAt:device.createdAt,revoked:device.revoked,online:sessions.has(id)}))});return;
    }
    const revoke=url.pathname.match(/^\/gateway\/devices\/([\w-]+)\/revoke$/);
    if(revoke&&req.method==='POST'){
      if(!authorized(req)){reply(res,401,{error:'ADMIN_AUTH_REQUIRED'});return;}
      const device=state.devices[revoke[1]];if(!device){reply(res,404,{error:'DEVICE_NOT_FOUND'});return;}
      device.revoked=true;save();sessions.get(revoke[1])?.close(4003,'Device revoked');failDevice(revoke[1]);reply(res,200,{revoked:true});return;
    }
    const target=url.pathname.match(/^\/d\/([\w-]+)(\/mcp\/[\w-]+(?:\/[\w-]+)?)$/);
    if(!target){reply(res,404,{error:'NOT_FOUND'});return;}
    if(req.method!=='POST'){reply(res,405,{error:'POST_REQUIRED'});return;}
    const deviceId=target[1],device=state.devices[deviceId];
    if(!device||device.revoked){reply(res,404,{error:'DEVICE_NOT_FOUND'});return;}
    const socket=sessions.get(deviceId);
    if(!socket||socket.readyState!==WebSocket.OPEN){reply(res,503,{error:'DEVICE_OFFLINE',message:'这台电脑当前未连接，请让电脑主人打开客户端。'});return;}
    if(pending.size>=maxPending||socket.bufferedAmount>8*1024*1024||[...pending.values()].filter(p=>p.deviceId===deviceId).length>=perDevice){reply(res,429,{error:'TOO_MANY_REQUESTS',message:'并发调用已满，请稍后重试。'});return;}
    // Reserve the slot before reading the body; a slow upload cannot bypass limits.
    const id=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(id);reply(res,504,{error:'DEVICE_TIMEOUT'});},options.requestTimeout??45000);
    pending.set(id,{deviceId,res,timer});
    res.on('close',()=>{const item=pending.get(id);if(item){clearTimeout(item.timer);pending.delete(id);}});
    try {
      const raw=await read(req);
      if(!pending.has(id))return;
      const headers={};for(const key of ['accept','content-type','authorization','mcp-protocol-version','mcp-session-id'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];
      socket.send(JSON.stringify({type:'request',id,path:target[2],method:'POST',headers,body:raw}),error=>{if(error){clearTimeout(timer);pending.delete(id);reply(res,503,{error:'DEVICE_DISCONNECTED'});}});
    }catch(error){clearTimeout(timer);pending.delete(id);throw error;}
  })().catch(error=>{reply(res,error.message==='PAYLOAD_TOO_LARGE'?413:400,{error:error.message==='PAYLOAD_TOO_LARGE'?'PAYLOAD_TOO_LARGE':'INVALID_REQUEST'});});});
  server.requestTimeout=60000;server.headersTimeout=15000;
  const wss=new WebSocketServer({noServer:true,maxPayload:6*1024*1024,perMessageDeflate:false,handleProtocols:protocols=>protocols.has('lbd-v1')?'lbd-v1':false});
  server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url,'http://gateway.local');const id=url.searchParams.get('device');
    const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'')||String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim()).find(s=>s.startsWith('key.'))?.slice(4)||'';
    const device=state.devices[id];
    if(url.pathname!=='/gateway/connect'||!device||device.revoked||hash(supplied)!==device.secretHash){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
    if(!sessions.has(id)&&sessions.size>=maxDevices){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      const previous=sessions.get(id);if(previous)previous.close(4001,'Another instance connected');
      sessions.set(id,ws);ws.alive=true;ws.on('pong',()=>{ws.alive=true;});
      ws.on('error',()=>{});
      ws.on('message',data=>{
        try {
          const message=JSON.parse(data.toString());if(message.type!=='response')return;
          const item=pending.get(message.id);if(!item||item.deviceId!==id)return;
          clearTimeout(item.timer);pending.delete(message.id);
          if(!Number.isInteger(message.status)||message.status<100||message.status>599){reply(item.res,502,{error:'INVALID_DEVICE_RESPONSE'});return;}
          const headers={'cache-control':'no-store'};
          for(const key of ['content-type','mcp-session-id','mcp-protocol-version'])if(typeof message.headers?.[key]==='string'&&!/[\r\n]/.test(message.headers[key]))headers[key]=message.headers[key];
          if(!item.res.destroyed&&!item.res.writableEnded){item.res.writeHead(message.status,headers);item.res.end(String(message.body||''));}
        } catch { ws.close(1008,'Invalid relay message'); }
      });
      ws.on('close',()=>{if(sessions.get(id)===ws){sessions.delete(id);failDevice(id);}});
      ws.send(JSON.stringify({type:'ready',deviceId:id}));
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of sessions.values()){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},options.heartbeatInterval??25000);
  heartbeat.unref();
  return {server,sessions,pending,state,adminKey:()=>fs.readFileSync(adminFile,'utf8'),close:async()=>{
    clearInterval(heartbeat);for(const [id,ws]of sessions){failDevice(id);ws.terminate();}sessions.clear();
    await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});
  }};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const gateway=createGateway();
  gateway.server.listen(Number(process.env.GATEWAY_PORT||8878),'127.0.0.1',()=>process.stdout.write('Liubendou relay gateway ready\n'));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await gateway.close();};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}
