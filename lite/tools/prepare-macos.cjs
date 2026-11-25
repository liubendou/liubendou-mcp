'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),stage=path.join(root,'macos-build'),payload=path.join(stage,'payload/lite');
function copy(source,target){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(){
  const keys=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'Documents/LiubendouLite-LicenseAuthority/authority.private.json'),'utf8'));
  if(keys.product!=='liubendou-lite'||keys.epoch!=='lbd-core-v1')throw new Error('Incorrect local signing authority');
  for(const forbidden of ['data','authority.private.json','offline.lic'])if(fs.existsSync(path.join(stage,forbidden)))throw new Error('Private data in build folder');
  fs.mkdirSync(path.join(payload,'dist'),{recursive:true});fs.mkdirSync(path.join(payload,'secure'),{recursive:true});
  const bundle=await esbuild.build({entryPoints:[path.join(root,'src/protected-entry.ts')],bundle:true,platform:'node',target:'node24',format:'cjs',packages:'external',minify:true,write:false,metafile:true,sourcemap:false,define:{__LBD_PROTECTED_BUILD__:'true'},plugins:[{name:'owned-modules',setup(build){build.onLoad({filter:/[\\/]src[\\/](app|tools)\.ts$/},args=>{let source=fs.readFileSync(args.path,'utf8');if(args.path.endsWith('tools.ts'))source=source.replace('const require = createRequire(import.meta.url);','');source=source.replaceAll('import.meta.url','require("node:url").pathToFileURL(__filename).href');return {contents:source,loader:'ts',resolveDir:path.dirname(args.path)};});}}]});
  for(const file of ['security','commands','fileOps','patch','devtools'])if(!Object.keys(bundle.metafile.inputs).some(name=>name.replaceAll('\\','/').endsWith('legacy/'+file+'.js')))throw new Error('Own module missing from encryption: '+file);
  const plain=bundle.outputFiles[0].contents,key=Buffer.from(keys.contentKey,'base64'),nonce=crypto.randomBytes(12);if(key.length!==32)throw new Error('Invalid local content key');
  const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);let encrypted;try{encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);}finally{key.fill(0);}
  fs.writeFileSync(path.join(payload,'secure/core.bin'),encrypted);
  copy(path.join(root,'native/licensing/bootstrap.cjs'),path.join(payload,'dist/bootstrap.cjs'));
  await esbuild.build({entryPoints:[path.join(root,'src/proxy-entry.ts')],outfile:path.join(payload,'dist/proxy.cjs'),bundle:true,platform:'node',target:'node24',format:'cjs',packages:'external',minify:true,sourcemap:false});
  const manifest={format:'LBD-AES-256-GCM-v1',product:keys.product,epoch:keys.epoch,version:'0.3.3',platform:'macos',cipher:'core.bin',nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),cipherSha256:hash(encrypted),plainSha256:hash(plain),bootstrapSha256:hash(fs.readFileSync(path.join(payload,'dist/bootstrap.cjs'))),proxySha256:hash(fs.readFileSync(path.join(payload,'dist/proxy.cjs')))};
  plain.fill(0);fs.writeFileSync(path.join(payload,'secure/manifest.json'),JSON.stringify(manifest,null,2));
  const signed=spawnSync(path.join(root,'output/licensing/LicenseIssuer.exe'),['--sign-mac-build',path.join(payload,'secure/manifest.json'),path.join(payload,'secure/build.json')],{encoding:'utf8',windowsHide:true});
  if(signed.status!==0)throw new Error('Local Mac build signing failed: '+(signed.stderr||signed.stdout));
  for(const directory of ['public','example-workspace'])fs.cpSync(path.join(root,directory),path.join(payload,directory),{recursive:true});
  const legacy=JSON.parse(fs.readFileSync(path.join(root,'legacy/prompts.json'),'utf8'));fs.mkdirSync(path.join(payload,'legacy'),{recursive:true});fs.writeFileSync(path.join(payload,'legacy/prompts.json'),JSON.stringify({defaultPrompt:legacy.defaultPrompt.replace('一台 Windows 电脑','一台 macOS 电脑'),bridgePrompt:'',promptMain:'',customInstructions:'',promptProject:{},workspaceRoots:[]},null,2));
  fs.cpSync(path.join(root,'native/macos/Sources'),path.join(stage,'Sources'),{recursive:true});
  fs.writeFileSync(path.join(stage,'Sources/LicenseProduct.g.swift'),'enum LicenseProduct { static let publicKey = '+JSON.stringify(keys.publicKey)+' }\n');
  for(const file of ['Info.plist','node-entitlements.plist'])copy(path.join(root,'native/macos',file),path.join(stage,file));
  copy(path.join(root,'tools/build-macos.sh'),path.join(stage,'Scripts/build-macos.sh'));
  copy(path.join(root,'native/macos/macos-preview.yml'),path.join(stage,'.github/workflows/macos-preview.yml'));
  copy(path.join(root,'native/macos/使用说明.txt'),path.join(stage,'使用说明.txt'));
  copy(path.join(root,'native/macos/README.md'),path.join(stage,'README.md'));
  for(const file of ['package.json','package-lock.json'])copy(path.join(root,file),path.join(stage,file));
  const nodeLicense=path.join(root,'release/LiubendouLite-0.2.0-win-x64/NODE-LICENSE.txt');if(fs.existsSync(nodeLicense))copy(nodeLicense,path.join(payload,'NODE-LICENSE.txt'));
  fs.writeFileSync(path.join(stage,'.gitignore'),'node_modules/\nout/\n.DS_Store\n');
  fs.writeFileSync(path.join(stage,'.gitattributes'),'* text=auto eol=lf\npayload/lite/dist/** -text\npayload/lite/secure/** -text\n*.bin binary\n');
  const entries=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name==='.git'||entry.name==='node_modules'||entry.name==='out')continue;const full=path.join(dir,entry.name),rel=path.relative(stage,full).replaceAll('\\','/');if(entry.isSymbolicLink())throw new Error('Unexpected build symlink');if(entry.isDirectory())walk(full);else{if(/(?:authority\.private\.json|gateway-admin\.json|relay\.json|license-identity|offline\.lic|\.lbdreq$|LicenseIssuer\.exe|(?:^|\/)data\/)/i.test(rel))throw new Error('Unexpected private file: '+rel);entries.push(rel);}}}walk(stage);
  fs.writeFileSync(path.join(root,'output/protected/macos-build-summary.json'),JSON.stringify({version:'0.3.3-mac-preview.1',folder:stage,encryptedCoreBytes:encrypted.length,files:entries.length,privateSigningMaterialIncluded:false,testsRun:false},null,2));
  process.stdout.write(JSON.stringify({folder:stage,encryptedCoreBytes:encrypted.length,files:entries.length,privateSigningMaterialIncluded:false})+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
