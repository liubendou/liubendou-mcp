using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using Standard.Licensing;

// This class is supplied by the protected client build in production.
internal static class LicenseProduct { internal static string PublicKey; }

internal static class IssuerTests
{
    private static int passed;
    private static string root;
    private static void Check(bool condition,string name)
    {
        if(!condition)throw new Exception("FAIL: "+name);
        passed++;Console.WriteLine("PASS: "+name);
    }
    private static void Reject(Action action,string name)
    {
        bool rejected=false;try{action();}catch{rejected=true;}Check(rejected,name);
    }
    [STAThread]
    private static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve+=delegate(object sender,ResolveEventArgs e){
            string name=new AssemblyName(e.Name).Name;
            string resource=name=="Standard.Licensing"?"license.standard":name=="BouncyCastle.Cryptography"?"license.crypto":null;
            if(resource==null)return null;
            using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            using(MemoryStream buffer=new MemoryStream()){stream.CopyTo(buffer);return Assembly.Load(buffer.ToArray());}
        };
        try{return Run(args);}catch(Exception error){Console.Error.WriteLine(error.ToString());return 1;}
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args)
    {
        root=Path.GetFullPath(args[0]);Directory.CreateDirectory(root);
        Authority authority=new Authority(Path.Combine(root,"test-authority"));authority.Initialize();
        string keyHash=LicenseCommon.Sha(File.ReadAllBytes(authority.KeyFile));authority.Initialize();
        Check(keyHash==LicenseCommon.Sha(File.ReadAllBytes(authority.KeyFile)),"reopening preserves authority keys");
        var keys=LicenseCommon.ObjectFile(authority.KeyFile);LicenseProduct.PublicKey=LicenseCommon.Field(keys,"publicKey");
        LocalLicense client=new LocalLicense(root,Path.Combine(root,"client-one"));
        string request=Path.Combine(root,"device.lbdreq");client.ExportRequest(request);
        Check(!File.ReadAllText(request).Contains("privateKey")&&!File.ReadAllText(request).Contains("<D>"),"device request contains public information only");
        var requestData=authority.Request(request);Check(LicenseCommon.Field(requestData,"machineId")==client.MachineId,"issuer accepts real device request");
        Directory.CreateDirectory(Path.Combine(root,"secure"));
        string cipher=Path.Combine(root,"secure","core.bin");File.WriteAllBytes(cipher,new byte[]{1,2,3,4});
        string manifest=Path.Combine(root,"secure","manifest.json");
        LicenseCommon.SaveJson(manifest,new{product=LicenseCommon.Product,epoch=LicenseCommon.Epoch,format="LBD-AES-256-GCM-v1",cipher="core.bin",cipherSha256=LicenseCommon.Sha(File.ReadAllBytes(cipher))});
        authority.SignBuild(manifest,Path.Combine(root,"secure","build.lic"));
        string forever=Path.Combine(root,"permanent.lic");authority.Issue(request,forever,0,"测试用户");
        License license=LicenseCommon.Load(forever);
        Check(license.VerifySignature(LicenseProduct.PublicKey)&&license.AdditionalAttributes.Get("permanent")=="true","permanent licence signature verifies");
        Check(authority.Verify(forever,request).Contains("永久"),"issuer verifies its output");
        LicenseUnlock unlock=client.Validate(forever,DateTime.UtcNow,false);
        Check(Convert.ToBase64String(unlock.Key)==LicenseCommon.Field(keys,"contentKey"),"client unwraps AES content key with device private key");unlock.Clear();
        client.Import(forever);unlock=client.Current();Check(unlock.Permanent,"client imports and reopens offline licence");unlock.Clear();
        Check(!Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(root,"client-one","license-identity.bin"))).Contains("privateKey"),"device identity stored under Windows DPAPI");
        string monthly=Path.Combine(root,"monthly.lic");DateTime before=DateTime.UtcNow;authority.Issue(request,monthly,30,"30 天");
        license=LicenseCommon.Load(monthly);DateTime expires=DateTime.Parse(license.AdditionalAttributes.Get("expiresUtc"),null,System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
        Check(expires>=before.AddDays(30).AddSeconds(-1)&&expires<=DateTime.UtcNow.AddDays(30).AddSeconds(1),"30 days includes the full duration from signing time");
        unlock=client.Validate(monthly,before.AddDays(29),false);Check(!unlock.Permanent,"limited licence accepted before expiry");unlock.Clear();
        Reject(delegate{client.Validate(monthly,before.AddDays(31),false);},"expired licence rejected");
        Reject(delegate{client.Validate(monthly,before.AddDays(-1),false);},"clock rollback rejected");
        LocalLicense other=new LocalLicense(root,Path.Combine(root,"client-two"));
        Reject(delegate{other.Validate(forever,DateTime.UtcNow,false);},"licence rejected by another device identity");
        string otherRequest=Path.Combine(root,"other.lbdreq");other.ExportRequest(otherRequest);
        Reject(delegate{authority.Verify(forever,otherRequest);},"issuer reports request and licence mismatch");
        string changed=Path.Combine(root,"tampered.lic");File.WriteAllText(changed,File.ReadAllText(forever).Replace(client.MachineId,new String('a',64)),new UTF8Encoding(false));
        Reject(delegate{client.Validate(changed,DateTime.UtcNow,false);},"client rejects a modified signed licence");
        Reject(delegate{authority.Verify(changed,request);},"issuer rejects a modified signed licence");
        string originalHash=LicenseCommon.Sha(File.ReadAllBytes(forever));
        Reject(delegate{authority.Issue(request,forever,30,"");},"existing licence is never overwritten");
        Check(originalHash==LicenseCommon.Sha(File.ReadAllBytes(forever)),"failed overwrite preserves signed output");
        Reject(delegate{authority.Issue(request,Path.Combine(root,"bad-days.lic"),-1,"");},"negative duration rejected");
        Reject(delegate{authority.Issue(request,Path.Combine(root,"bad-days.lic"),36501,"");},"excessive duration rejected");
        string badRequest=Path.Combine(root,"invalid.lbdreq");
        var altered=new Dictionary<string,object>(requestData);altered["vendorFingerprint"]=new String('a',64);LicenseCommon.SaveJson(badRequest,altered);
        Reject(delegate{authority.Request(badRequest);},"another vendor request rejected");
        altered=new Dictionary<string,object>(requestData);altered["machineId"]=new String('x',64);LicenseCommon.SaveJson(badRequest,altered);
        Reject(delegate{authority.Request(badRequest);},"malformed machine code rejected");
        altered=new Dictionary<string,object>(requestData);using(RSACng weak=new RSACng(1024))altered["publicKey"]=weak.ToXmlString(false);LicenseCommon.SaveJson(badRequest,altered);
        Reject(delegate{authority.Request(badRequest);},"weak device key rejected");
        File.WriteAllText(badRequest,new String('x',65537));Reject(delegate{authority.Request(badRequest);},"oversized request rejected");
        string dtd=Path.Combine(root,"dtd.lic");File.WriteAllText(dtd,"<!DOCTYPE License [<!ENTITY test SYSTEM 'file:///test'>]><License>&test;</License>");
        Reject(delegate{authority.Verify(dtd,null);},"licence XML DTD is rejected");
        File.AppendAllText(manifest," ");Reject(delegate{client.Validate(forever,DateTime.UtcNow,false);},"altered build manifest rejected");
        File.WriteAllText(manifest,File.ReadAllText(manifest).TrimEnd());authority.SignBuild(manifest,Path.Combine(root,"secure","build.lic"));
        File.WriteAllBytes(cipher,new byte[]{9,9,9});Reject(delegate{client.Validate(forever,DateTime.UtcNow,false);},"altered protected payload rejected");
        if(args.Length>1)
        {
            string standaloneOutput=Path.Combine(root,"standalone.lic");
            ProcessStartInfo start=new ProcessStartInfo(args[1],"--issue \""+request+"\" \""+standaloneOutput+"\" 90");
            start.UseShellExecute=false;start.CreateNoWindow=true;start.EnvironmentVariables["LBD_AUTHORITY_DIR"]=authority.DirectoryPath;
            using(Process process=Process.Start(start)){Check(process.WaitForExit(10000)&&process.ExitCode==0,"single-file desktop issuer runs without external crypto DLLs");}
            Check(authority.Verify(standaloneOutput,request).Contains("有限期"),"standalone issuer output verifies against the device request");
        }
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        using(IssuerForm form=new IssuerForm(authority))
        {
            form.Show();Application.DoEvents();
            Button issue=(Button)form.Controls.Find("Issue",true)[0];
            Check(!issue.Enabled,"GUI disables signing until a valid request is selected");
            form.SelectRequest(request);Check(issue.Enabled,"GUI accepts a device request");
            ComboBox duration=(ComboBox)form.Controls.Find("Duration",true)[0];
            NumericUpDown days=(NumericUpDown)form.Controls.Find("Days",true)[0];
            duration.SelectedIndex=4;days.Value=7;Application.DoEvents();
            Check(days.Enabled&&form.Controls.Find("Expiration",true)[0].Text.Contains(DateTime.Now.AddDays(7).ToString("yyyy-MM-dd")),"GUI custom expiry preview updates");
            duration.SelectedIndex=0;Application.DoEvents();
            Check(!days.Enabled&&form.Controls.Find("Expiration",true)[0].Text.Contains("永久"),"GUI permanent choice disables custom days");
            Control bottom=form.Controls.Find("Keys",true)[0];Rectangle bounds=form.RectangleToClient(bottom.RectangleToScreen(bottom.ClientRectangle));
            using(Bitmap screenshot=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(screenshot,new Rectangle(Point.Empty,screenshot.Size));screenshot.Save(Path.Combine(root,"issuer-window.png"));}
            Check(form.ClientRectangle.Contains(bounds)&&issue.Visible,"GUI action buttons and footer fit the window");
            form.Size=form.MinimumSize;form.Controls.Find("Feedback",true)[0].Text="签发成功 · 六本豆-测试.lic\r\n签名有效 · 有限期授权\r\n到期时间：2026-12-07 12:00:00";Application.DoEvents();
            bounds=form.RectangleToClient(bottom.RectangleToScreen(bottom.ClientRectangle));
            Check(form.ClientRectangle.Contains(bounds),"GUI footer remains accessible after signing at minimum window size");
            Reject(delegate{form.SelectRequest(badRequest);},"GUI rejects invalid replacement request");
            Check(!issue.Enabled&&form.Controls.Find("RequestPath",true)[0].Text=="","GUI clears previous request after failed replacement");
            form.Close();
        }
        LicenseCommon.SaveJson(Path.Combine(root,"results.json"),new{passed=passed,failed=0,networkRequired=false,utc=DateTime.UtcNow.ToString("o")});
        Console.WriteLine("RESULT: "+passed+" passed, 0 failed.");return 0;
    }
}
