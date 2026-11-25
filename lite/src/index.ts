import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp, root, type Connection } from './app.js';

if(process.argv.includes('--help')){
  process.stdout.write('Liubendou Lite\n  node dist/index.js              Local panel + MCP on 127.0.0.1:8777\n  node dist/index.js --stdio --task TASK_ID   MCP stdio proxy\nEnvironment: LBD_PORT, LBD_DATA_DIR\n');
}else if(process.argv.includes('--stdio')){
  const task=process.argv[process.argv.indexOf('--task')+1];
  if(!task||task==='--stdio')throw new Error('请先在面板复制当前任务的 MCP 配置。');
  const dataDir=process.env.LBD_DATA_DIR||path.join(root,'data');
  const connection=JSON.parse(fs.readFileSync(path.join(dataDir,'connection.json'),'utf8')) as Connection;
  const client=new Client({name:'liubendou-local-proxy',version:'0.1.0'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${connection.port}/mcp/${task}`),{requestInit:{headers:{Authorization:'Bearer '+connection.token}}}));}
  catch{throw new Error('六本豆 Lite 尚未启动。请先双击「启动.cmd」，再重新连接 MCP。');}
  const proxy=new Server({name:'liubendou-lite-mcp-server',version:'0.1.0'},{capabilities:{tools:{}},instructions:client.getInstructions()});
  proxy.setRequestHandler(ListToolsRequestSchema,async()=>client.listTools());
  proxy.setRequestHandler(CallToolRequestSchema,async request=>client.callTool(request.params));
  await proxy.connect(new StdioServerTransport());
  let closed=false;const shutdown=async():Promise<void>=>{if(closed)return;closed=true;await client.close();await proxy.close();};
  process.stdin.on('end',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
}else{
  const app=createApp();let stopping=false;
  app.server.on('error',error=>{process.stderr.write(`启动失败：${error.message}\n`);app.store.close();process.exitCode=1;});
  app.server.listen(app.connection.port,'127.0.0.1',()=>{
    process.stdout.write(`六本豆 Lite 已启动：http://127.0.0.1:${app.connection.port}\n`);
  });
  const shutdown=async():Promise<void>=>{if(stopping)return;stopping=true;await app.close();};
  process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
}
