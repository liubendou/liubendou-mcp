const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dataDir = process.env.LBD_DATA_DIR || path.join(root, 'data');
async function main() {
  const connectionFile = path.join(dataDir,'connection.json');
  if(!fs.existsSync(connectionFile)){process.stdout.write('Liubendou Lite is not running.\n');return;}
  const {port}=JSON.parse(fs.readFileSync(connectionFile,'utf8'));
  const base=`http://127.0.0.1:${Number(port)}`;
  const status=await fetch(base+'/api/status',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  if(status.service!=='liubendou-lite')throw new Error('The port belongs to another application; nothing was stopped.');
  const result=await fetch(base+'/api/shutdown',{method:'POST',headers:{'x-lbd-panel':'1'},signal:AbortSignal.timeout(5000)});
  if(!result.ok)throw new Error('Unable to stop the local service.');
  process.stdout.write('Liubendou Lite stopped. Task memory is saved.\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
