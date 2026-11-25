$ErrorActionPreference = 'Stop'
$liteRoot = Split-Path $PSScriptRoot -Parent
$liteSdk = Join-Path $liteRoot 'native/sdk/webview2'
$liteCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $liteCompiler)) { throw '.NET Framework C# compiler is required.' }
$liteCore = Join-Path $liteSdk 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$liteForms = Join-Path $liteSdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path -LiteralPath $liteCore)) { throw 'Download Microsoft.Web.WebView2 1.0.4314.35 to native/sdk/webview2 first.' }
Copy-Item -LiteralPath $liteCore -Destination $liteRoot
Copy-Item -LiteralPath $liteForms -Destination $liteRoot
Copy-Item -LiteralPath (Join-Path $liteSdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $liteRoot
$liteExe = Join-Path $liteRoot 'LiubendouLite.exe'
$liteIcon = Join-Path (Split-Path $liteRoot -Parent) 'src/assets/icon.ico'
$liteSource = Join-Path $liteRoot 'native/Desktop.cs'
& $liteCompiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$liteExe" "/win32icon:$liteIcon" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll "/r:$liteCore" "/r:$liteForms" $liteSource
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
Get-Item -LiteralPath $liteExe | Select-Object Name,Length
