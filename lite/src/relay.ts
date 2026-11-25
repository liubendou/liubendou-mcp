import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Connection } from './app.js';
import { taskToken } from './credentials.js';

interface RelayConfig { server:string;deviceId:string;deviceSecret:string;publicBase:string;name:string }
export interface RelayStatus {
  configured:boolean;connected:boolean;publicMcpUp:boolean;publicBase:string;deviceName:string;
  attempts:number;message:string;lastChecked:string|null;canInvite:boolean;
}
const safeServer=(value:string):string=>{
  const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/')throw new Error('邀请码中的服务器地址不正确。');
  return url.origin;
};
export class Relay {
  private config:RelayConfig|null=null;
  private socket:WebSocket|null=null;
  private retry:ReturnType<typeof setTimeout>|undefined;
  private monitor:ReturnType<typeof setInterval>|undefined;
  private stopped=false;private epoch=0;private checking=false;
  private value:RelayStatus={configured:false,connected:false,publicMcpUp:false,publicBase:'',deviceName:'',attempts:0,message:'尚未激活云端连接',lastChecked:null,canInvite:false};
  constructor(private dataDir:string,private connection:Connection,private store:Store){
    const filename=path.join(dataDir,'relay.json');
    if(fs.existsSync(filename)){
      const input=z.object({server:z.string(),deviceId:z.string().uuid(),deviceSecret:z.string().min(32),publicBase:z.string(),name:z.string()}).parse(JSON.parse(fs.readFileSync(filename,'utf8')));
      this.config={...input,server:safeServer(input.server)};this.connection.publicBase=input.publicBase;
      Object.assign(this.value,{configured:true,publicBase:input.publicBase,deviceName:input.name,message:'等待连接中转服务器'});
    }
  }
  status():RelayStatus {return {...this.value,canInvite:fs.existsSync(path.join(this.dataDir,'gateway-admin.json'))};}
  start():void {this.stopped=false;if(this.config)this.connect();this.monitor=setInterval(()=>{void this.check();},30000);this.monitor.unref();}
  async activate(code:string,name:string):Promise<RelayStatus>{
    if(!code.startsWith('lbd1.'))throw new Error('请粘贴管理员提供的完整邀请码。');
    const decoded=z.object({server:z.string(),invite:z.string().min(32)}).strict().parse(JSON.parse(Buffer.from(code.slice(5),'base64url').toString('utf8')));
    const server=safeServer(decoded.server);
    const response=await fetch(server+'/gateway/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite:decoded.invite,name}),signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(response.status===403?'邀请码已过期或已使用，请换一个邀请码。':'无法激活，请检查服务器连接。');
    const credentials=z.object({deviceId:z.string().uuid(),deviceSecret:z.string().min(32),publicBase:z.string().url()}).passthrough().parse(await response.json());
    if(credentials.publicBase!==server+'/d/'+credentials.deviceId)throw new Error('服务器返回的设备地址不匹配。');
    this.epoch++;clearTimeout(this.retry);const old=this.socket;this.socket=null;old?.terminate();
    this.config={server,deviceId:credentials.deviceId,deviceSecret:credentials.deviceSecret,publicBase:credentials.publicBase,name};
    fs.writeFileSync(path.join(this.dataDir,'relay.json'),JSON.stringify(this.config,null,2),{mode:0o600});
    this.connection.publicBase=credentials.publicBase;
    Object.assign(this.value,{configured:true,connected:false,publicMcpUp:false,publicBase:credentials.publicBase,deviceName:name,attempts:0,message:'设备已激活，正在连接服务器'});
    this.stopped=false;this.connect();return this.status();
  }
  reconnect():RelayStatus{
    if(!this.config)throw new Error('请先使用邀请码激活这台电脑。');
    this.epoch++;clearTimeout(this.retry);const old=this.socket;this.socket=null;old?.terminate();this.stopped=false;this.value.attempts=0;this.connect();return this.status();
  }
  private connect():void {
    if(this.stopped||!this.config)return;
    const generation=++this.epoch,config=this.config;
    const url=new URL(config.server+'/gateway/connect');url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('device',config.deviceId);
    this.value.connected=false;this.value.publicMcpUp=false;this.value.message='正在连接中转服务器';
    const ws=new WebSocket(url,['lbd-v1'],{headers:{Authorization:'Bearer '+config.deviceSecret},handshakeTimeout:10000,perMessageDeflate:false,maxPayload:6*1024*1024});this.socket=ws;
    ws.on('open',()=>{if(generation!==this.epoch)return;Object.assign(this.value,{connected:true,attempts:0,message:'通道已连接，正在验证公网 MCP'});void this.check();});
    ws.on('message',raw=>{
      if(generation!==this.epoch)return;
      try{const input=JSON.parse(raw.toString()) as Record<string,unknown>;if(input.type==='request')void this.forward(ws,input);}catch{ws.close(1008,'Invalid message');}
    });
    ws.on('error',error=>{if(generation===this.epoch)this.value.message='连接失败：'+error.message.replaceAll(config.deviceSecret,'[已隐藏]');});
    ws.on('close',code=>{
      if(generation!==this.epoch||this.stopped)return;
      this.value.connected=false;this.value.publicMcpUp=false;
      if(code===4001||code===4003){this.value.message=code===4003?'设备授权已撤销，请联系管理员。':'另一份客户端正在使用同一设备身份，请检查是否复制了数据目录。';return;}
      const attempt=++this.value.attempts;const delay=Math.min(15000,500*2**Math.min(attempt-1,5));
      this.value.message=`连接中断，${Math.ceil(delay/1000)} 秒后重连`;
      this.retry=setTimeout(()=>this.connect(),delay);
    });
  }
  private async forward(ws:WebSocket,input:Record<string,unknown>):Promise<void>{
    const schema=z.object({type:z.literal('request'),id:z.string().uuid(),method:z.literal('POST'),path:z.string().regex(/^\/mcp\/[\w-]+(?:\/[\w-]+)?$/),headers:z.record(z.string(),z.string()),body:z.string().max(5*1024*1024)}).strict();
    const parsed=schema.safeParse(input);if(!parsed.success){ws.close(1008,'Invalid request');return;}
    const request=parsed.data;let result:{status:number;headers:Record<string,string>;body:string};
    try {
      const headers:Record<string,string>={};for(const key of ['accept','content-type','authorization','mcp-protocol-version','mcp-session-id'])if(request.headers[key])headers[key]=request.headers[key];
      const response=await fetch(`http://127.0.0.1:${this.connection.port}`+request.path,{method:'POST',headers,body:request.body,signal:AbortSignal.timeout(40000),redirect:'error'});
      const body=await response.text();const responseHeaders:Record<string,string>={};
      for(const key of ['content-type','mcp-session-id','mcp-protocol-version']){const value=response.headers.get(key);if(value)responseHeaders[key]=value;}
      result=body.length>5*1024*1024?{status:502,headers:{'content-type':'application/json'},body:'{"error":"RESPONSE_TOO_LARGE"}'}:{status:response.status,headers:responseHeaders,body};
    }catch{result={status:502,headers:{'content-type':'application/json'},body:'{"error":"LOCAL_SERVICE_UNAVAILABLE"}'};}
    if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',id:request.id,...result}));
  }
  async check():Promise<RelayStatus>{
    if(this.checking||!this.config||!this.value.connected)return this.status();
    const task=this.store.listTasks()[0];if(!task)return this.status();
    this.checking=true;const generation=this.epoch;
    try {
      const address=this.config.publicBase+'/mcp/'+taskToken(this.connection.token,task.id)+'/'+task.id;
      const response=await fetch(address,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'relay-health',version:'0.2.0'}}}),signal:AbortSignal.timeout(8000)});
      const value=await response.json() as {result?:{serverInfo?:{name?:string}}};
      if(generation===this.epoch){this.value.publicMcpUp=response.ok&&value.result?.serverInfo?.name==='liubendou-lite-mcp-server';this.value.message=this.value.publicMcpUp?'云端 MCP 已就绪':'通道已连接，但公网 MCP 握手未通过';}
    }catch{if(generation===this.epoch){this.value.publicMcpUp=false;this.value.message='通道已连接，公网验证暂未通过';}}
    finally{this.checking=false;this.value.lastChecked=new Date().toISOString();}
    return this.status();
  }
  async invites(count=1):Promise<unknown>{
    const file=path.join(this.dataDir,'gateway-admin.json');if(!fs.existsSync(file))throw new Error('当前电脑没有生成邀请码的管理权限。');
    const input=z.object({server:z.string(),adminKey:z.string().min(32)}).parse(JSON.parse(fs.readFileSync(file,'utf8')));
    const response=await fetch(safeServer(input.server)+'/gateway/invites',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+input.adminKey},body:JSON.stringify({count,hours:24}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('生成邀请码失败，请检查管理员凭据或服务器状态。');return response.json();
  }
  async close():Promise<void>{this.stopped=true;this.epoch++;clearTimeout(this.retry);clearInterval(this.monitor);this.socket?.terminate();this.socket=null;this.value.connected=false;this.value.publicMcpUp=false;}
}
