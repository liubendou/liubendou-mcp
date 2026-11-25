'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),version='0.3.3';
const stage=path.join(root,'release',`LiubendouLite-${version}-win-x64-licensed`);
const output=path.join(root,'output','protected');
const authority=process.env.LBD_AUTHORITY_DIR||path.join(process.env.USERPROFILE,'Documents','LiubendouLite-LicenseAuthority');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
function run(exe,args,cwd=root){const result=spawnSync(exe,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});if(result.status!==0)throw new Error(path.basename(exe)+' failed: '+(result.stderr||result.stdout||result.error||result.status));if(result.stdout.trim())process.stdout.write(result.stdout);}
function copy(source,target){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
async function main(){
  const keys=JSON.parse(fs.readFileSync(path.join(authority,'authority.private.json'),'utf8'));
  if(keys.product!=='liubendou-lite'||keys.epoch!=='lbd-core-v1')throw new Error('Wrong signing authority');
  if(fs.existsSync(path.join(stage,'data'))||fs.existsSync(path.join(stage,'dist/index.js')))throw new Error('Release folder contains user data or an unprotected backend');
  fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(stage,'dist'),{recursive:true});fs.mkdirSync(path.join(stage,'secure'),{recursive:true});
  const bundle=await esbuild.build({entryPoints:[path.join(root,'src/protected-entry.ts')],bundle:true,platform:'node',target:'node24',format:'cjs',packages:'external',minify:true,write:false,metafile:true,sourcemap:false,
    define:{__LBD_PROTECTED_BUILD__:'true'},plugins:[{name:'include-owned-modules',setup(build){
      build.onLoad({filter:/[\\/]src[\\/](app|tools)\.ts$/},async args=>{
        let source=fs.readFileSync(args.path,'utf8');
        if(args.path.endsWith('tools.ts'))source=source.replace("const require = createRequire(import.meta.url);",'');
        source=source.replaceAll('import.meta.url','require("node:url").pathToFileURL(__filename).href');
        return {contents:source,loader:'ts',resolveDir:path.dirname(args.path)};
      });
    }}]});
  const inputs=Object.keys(bundle.metafile.inputs).map(file=>file.replaceAll('\\','/'));
  for(const name of ['security','commands','fileOps','patch','devtools'])if(!inputs.some(file=>file.endsWith('/legacy/'+name+'.js')||file==='legacy/'+name+'.js'))throw new Error('Own module missing from encrypted bundle: '+name);
  const plain=bundle.outputFiles[0].contents,key=Buffer.from(keys.contentKey,'base64'),nonce=crypto.randomBytes(12);
  if(key.length!==32)throw new Error('Invalid content-key size');
  const encrypt=crypto.createCipheriv('aes-256-gcm',key,nonce);
  let cipher;try{cipher=Buffer.concat([encrypt.update(plain),encrypt.final()]);}finally{key.fill(0);}
  fs.writeFileSync(path.join(stage,'secure/core.bin'),cipher);
  copy(path.join(root,'native/licensing/bootstrap.cjs'),path.join(stage,'dist/bootstrap.cjs'));
  await esbuild.build({entryPoints:[path.join(root,'src/proxy-entry.ts')],outfile:path.join(stage,'dist/proxy.cjs'),bundle:true,platform:'node',target:'node24',format:'cjs',packages:'external',minify:true,sourcemap:false});
  const manifest={format:'LBD-AES-256-GCM-v1',product:keys.product,epoch:keys.epoch,version,cipher:'core.bin',nonce:nonce.toString('base64'),tag:encrypt.getAuthTag().toString('base64'),cipherSha256:hash(cipher),plainSha256:hash(plain),bootstrapSha256:hash(fs.readFileSync(path.join(stage,'dist/bootstrap.cjs'))),proxySha256:hash(fs.readFileSync(path.join(stage,'dist/proxy.cjs')))};
  plain.fill(0);
  fs.writeFileSync(path.join(stage,'secure/manifest.json'),JSON.stringify(manifest,null,2));
  run(path.join(root,'output/licensing/LicenseIssuer.exe'),['--sign-build',path.join(stage,'secure/manifest.json'),path.join(stage,'secure/build.lic')]);
  for(const folder of ['public','example-workspace'])fs.cpSync(path.join(root,folder),path.join(stage,folder),{recursive:true});
  const original=JSON.parse(fs.readFileSync(path.join(root,'legacy/prompts.json'),'utf8'));
  fs.mkdirSync(path.join(stage,'legacy'),{recursive:true});fs.writeFileSync(path.join(stage,'legacy/prompts.json'),JSON.stringify({defaultPrompt:original.defaultPrompt,bridgePrompt:'',promptMain:'',customInstructions:'',promptProject:{},workspaceRoots:[]},null,2));
  const previous=path.join(root,'release/LiubendouLite-0.2.0-win-x64');
  fs.cpSync(path.join(previous,'node_modules'),path.join(stage,'node_modules'),{recursive:true});
  copy(path.join(previous,'runtime/node.exe'),path.join(stage,'runtime/node.exe'));
  for(const file of ['NODE-LICENSE.txt','WEBVIEW2-LICENSE.txt'])if(fs.existsSync(path.join(previous,file)))copy(path.join(previous,file),path.join(stage,file));
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'liubendou-lite',version,private:true,description:'六本豆 Lite · 离线授权版'}));
  fs.writeFileSync(path.join(stage,'启动.cmd'),'@echo off\r\nstart "" "%~dp0LiubendouLite.exe"\r\n');
  fs.writeFileSync(path.join(stage,'停止.cmd'),'@echo off\r\n"%~dp0LiubendouLite.exe" --exit\r\n');
  fs.writeFileSync(path.join(stage,'install-id.txt'),'liubendou-lite-offline-v1\r\n');
  copy(path.join(root,'发行使用说明.txt'),path.join(stage,'使用说明.txt'));
  const sdk=path.join(root,'native/sdk');
  for(const [source,name] of [['webview2/lib/net462/Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Core.dll'],['webview2/lib/net462/Microsoft.Web.WebView2.WinForms.dll','Microsoft.Web.WebView2.WinForms.dll'],['webview2/runtimes/win-x64/native/WebView2Loader.dll','WebView2Loader.dll'],['licensing/standard/lib/net461/Standard.Licensing.dll','Standard.Licensing.dll'],['licensing/bouncy/lib/net461/BouncyCastle.Cryptography.dll','BouncyCastle.Cryptography.dll'],['licensing/standard/LICENSE','STANDARD-LICENSING-LICENSE.txt'],['licensing/bouncy/LICENSE.md','BOUNCYCASTLE-LICENSE.txt']])copy(path.join(sdk,source),path.join(stage,name));
  const generated=path.join(output,'LicenseProduct.g.cs');
  fs.writeFileSync(generated,'internal static class LicenseProduct { internal const string PublicKey = '+JSON.stringify(keys.publicKey)+'; }\n');
  const csc='C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
  const reference=['System','System.Core','System.Drawing','System.Windows.Forms','System.Net.Http','System.Web.Extensions','System.Security','System.Xml'].map(name=>'/r:'+name+'.dll');
  for(const name of ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','Standard.Licensing.dll','BouncyCastle.Cryptography.dll'])reference.push('/r:'+path.join(stage,name));
  const nativeExe=path.join(output,'LiubendouLite.exe');
  run(csc,['/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001','/define:LICENSED','/out:'+nativeExe,'/win32icon:'+path.resolve(root,'../src/assets/icon.ico'),...reference,path.join(root,'native/Desktop.cs'),path.join(root,'native/licensing/ClientLicense.cs'),path.join(root,'native/licensing/LicenseCommon.cs'),generated]);
  const obfuscated=path.join(output,'obfuscated');fs.mkdirSync(obfuscated,{recursive:true});
  const config=path.join(output,'obfuscar.xml');
  fs.writeFileSync(config,'<Obfuscator><Var name="InPath" value="'+xml(output)+'"/><Var name="OutPath" value="'+xml(obfuscated)+'"/><Var name="KeepPublicApi" value="true"/><Var name="HidePrivateApi" value="true"/><Var name="HideStrings" value="true"/><Var name="RenameProperties" value="false"/><AssemblySearchPath path="'+xml(stage)+'"/><Module file="'+xml(nativeExe)+'"/></Obfuscator>');
  run(path.join(sdk,'licensing/obfuscar/tools/Obfuscar.Console.exe'),[config],output);
  copy(path.join(obfuscated,'LiubendouLite.exe'),path.join(stage,'LiubendouLite.exe'));
  const summary={version,folder:stage,encryptedCoreBytes:cipher.length,ownModulesEncrypted:5,obfuscatedNative:true,privateAuthorityIncluded:false};
  fs.writeFileSync(path.join(output,'build-summary.json'),JSON.stringify(summary,null,2));process.stdout.write(JSON.stringify(summary)+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
