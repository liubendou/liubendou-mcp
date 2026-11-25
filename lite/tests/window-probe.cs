using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
internal static class WindowProbe
{
    private delegate bool ChildCallback(IntPtr window,IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct Rect {public int Left,Top,Right,Bottom;}
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent,ChildCallback callback,IntPtr parameter);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window,StringBuilder text,int length);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window,IntPtr target,int flags);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    private static int Main(string[] args)
    {
        SetProcessDPIAware();Process process=Process.GetProcessById(Int32.Parse(args[0]));IntPtr window=process.MainWindowHandle;if(window==IntPtr.Zero)return 1;
        Rect outer;GetWindowRect(window,out outer);List<object> buttons=new List<object>();bool export=false,import=false,fit=true;
        EnumChildWindows(window,delegate(IntPtr child,IntPtr parameter){StringBuilder text=new StringBuilder(256),kind=new StringBuilder(256);GetWindowText(child,text,256);GetClassName(child,kind,256);
            if(kind.ToString().ToUpperInvariant().Contains("BUTTON")&&IsWindowVisible(child)){Rect bounds;GetWindowRect(child,out bounds);string caption=text.ToString();bool inside=bounds.Left>=outer.Left&&bounds.Top>=outer.Top&&bounds.Right<=outer.Right&&bounds.Bottom<=outer.Bottom;buttons.Add(new{caption=caption,visible=true,inside=inside});if(caption.Contains("导出授权申请"))export=true;if(caption.Contains("导入许可证"))import=true;fit=fit&&inside;}return true;},IntPtr.Zero);
        using(Bitmap bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))using(Graphics graphics=Graphics.FromImage(bitmap)){IntPtr target=graphics.GetHdc();try{PrintWindow(window,target,0);}finally{graphics.ReleaseHdc(target);}bitmap.Save(args[2]);}
        File.WriteAllText(args[1],new JavaScriptSerializer().Serialize(new{title=process.MainWindowTitle,export_visible=export,import_visible=import,buttons_fit=fit,buttons=buttons}),new UTF8Encoding(false));return 0;
    }
}
