declare const __LBD_PROTECTED_BUILD__: boolean;
interface Grant { assert():void; permit:string; expiresUtc:string; permanent:boolean }
function grant():Grant|undefined{return (globalThis as unknown as {__LBD_GRANT__?:Grant}).__LBD_GRANT__;}
export function assertLicense():void{
  if(typeof __LBD_PROTECTED_BUILD__!=='undefined'&&__LBD_PROTECTED_BUILD__){
    const active=grant();if(!active)throw new Error('请通过六本豆 Lite 桌面客户端验证离线授权。');active.assert();
  }
}
export function licenseStatus(desktopHeader?:string|string[]):object|null{
  const active=grant();return active?{licensed:true,expiresUtc:active.expiresUtc,permanent:active.permanent,desktop_match:desktopHeader===active.permit}:null;
}
