import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
async function main():Promise<void>{
  const task=process.argv[process.argv.indexOf('--task')+1];
  if(!task||!process.argv.includes('--task'))throw new Error('请在桌面客户端复制当前任务的 MCP 配置。');
  const dataDir=process.env.LBD_DATA_DIR||path.join(__dirname,'..','data');
  const connection=JSON.parse(fs.readFileSync(path.join(dataDir,'connection.json'),'utf8')) as {port:number;token:string};
  const client=new Client({name:'liubendou-local-proxy',version:'0.3.3'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${connection.port}/mcp/${task}`),{requestInit:{headers:{Authorization:'Bearer '+connection.token}}}));}
  catch{throw new Error('请先打开六本豆 Lite，并完成离线授权。');}
  const proxy=new Server({name:'liubendou-lite-mcp-server',version:'0.3.3'},{capabilities:{tools:{}},instructions:client.getInstructions()});
  proxy.setRequestHandler(ListToolsRequestSchema,async()=>client.listTools());
  proxy.setRequestHandler(CallToolRequestSchema,async request=>client.callTool(request.params));
  await proxy.connect(new StdioServerTransport());
  let closed=false;const close=async():Promise<void>=>{if(closed)return;closed=true;await client.close();await proxy.close();};
  process.stdin.on('end',()=>{void close();});process.on('SIGINT',()=>{void close();});
}
void main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'本机代理启动失败')+'\n');process.exitCode=1;});
