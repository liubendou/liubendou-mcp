'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),stage=path.join(root,'release/LiubendouLite-0.3.3-win-x64-licensed');
const output=path.join(root,'release/LiubendouLite-Setup-0.3.3.exe');
const uninstaller=path.join(root,'output/protected/uninstall-files.nsh');
const files=[],directories=[];
function walk(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){const full=path.join(directory,item.name);if(item.isSymbolicLink())throw new Error('Distribution symlinks are not allowed');if(item.isDirectory()){directories.push(path.relative(stage,full));walk(full);}else files.push(path.relative(stage,full));}}
walk(stage);
for(const name of files){const relative=name.replaceAll('\\','/');if(relative==='authority.private.json'||relative.startsWith('data/')||relative.startsWith('src/')||relative.endsWith('.lbdreq')||relative.endsWith('offline.lic')||relative.includes('LicenseIssuer')||relative==='dist/index.js'||relative.startsWith('native/'))throw new Error('Unexpected private or source artifact: '+relative);}
const escape=value=>value.replaceAll('$','$$').replaceAll('"','$\\"');
fs.writeFileSync(uninstaller,'\uFEFF'+files.map(file=>'Delete "$INSTDIR\\'+escape(file)+'"').concat(directories.sort((a,b)=>b.split(path.sep).length-a.split(path.sep).length).map(directory=>'RMDir "$INSTDIR\\'+escape(directory)+'"')).join('\r\n'));
const script=path.join(root,'output/protected/installer.nsi');fs.writeFileSync(script,'\uFEFF'+fs.readFileSync(path.join(root,'native/installer.nsi'),'utf8').replace(/^\uFEFF/,''));
const result=spawnSync('C:/Program Files (x86)/NSIS/makensis.exe',['/V2','/DCLIENT_DIR='+stage,'/DSETUP_OUT='+output,'/DUNINSTALL_FILES='+uninstaller,'/DAPP_ICON='+path.resolve(root,'../src/assets/icon.ico'),script],{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
if(result.status!==0)throw new Error('EXE installer build failed');
process.stdout.write(JSON.stringify({installer:output,bytes:fs.statSync(output).size,files:files.length,privateAuthorityIncluded:false})+'\n');
