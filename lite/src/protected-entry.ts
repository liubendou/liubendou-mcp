import {createApp} from './app.js';
import {assertLicense} from './licensing.js';
assertLicense();
const app=createApp();let stopping=false;
const shutdown=async():Promise<void>=>{if(stopping)return;stopping=true;await app.close();};
(globalThis as unknown as {__LBD_STOP__:()=>Promise<void>}).__LBD_STOP__=shutdown;
app.server.on('error',error=>{process.stderr.write(`启动失败：${error.message}\n`);process.exit(1);});
app.server.listen(app.connection.port,'127.0.0.1',()=>process.stdout.write('六本豆 Lite 离线授权服务已启动。\n'));
process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
