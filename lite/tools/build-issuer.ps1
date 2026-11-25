$ErrorActionPreference = 'Stop'
$liteRoot = Split-Path $PSScriptRoot -Parent
$liteCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$liteStandard = Join-Path $liteRoot 'native/sdk/licensing/standard/lib/net461/Standard.Licensing.dll'
$liteCrypto = Join-Path $liteRoot 'native/sdk/licensing/bouncy/lib/net461/BouncyCastle.Cryptography.dll'
$liteOutput = Join-Path $liteRoot 'output/licensing'
New-Item -ItemType Directory -Force -Path $liteOutput | Out-Null
$liteIssuer = Join-Path $liteOutput 'LicenseIssuer.exe'
$liteStandardNotice = Join-Path $liteRoot 'native/sdk/licensing/standard/LICENSE'
$liteCryptoNotice = Join-Path $liteRoot 'native/sdk/licensing/bouncy/LICENSE.md'
& $liteCompiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$liteIssuer" "/win32icon:$(Join-Path $liteRoot '../src/assets/icon.ico')" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Security.dll /r:System.Xml.dll "/r:$liteStandard" "/r:$liteCrypto" "/resource:$liteStandard,license.standard" "/resource:$liteCrypto,license.crypto" "/resource:$liteStandardNotice,license.notice.standard" "/resource:$liteCryptoNotice,license.notice.crypto" (Join-Path $liteRoot 'native/licensing/LicenseCommon.cs') (Join-Path $liteRoot 'native/licensing/LicenseIssuer.cs') (Join-Path $liteRoot 'native/licensing/IssuerHistory.cs') (Join-Path $liteRoot 'native/licensing/IssuerMac.cs') (Join-Path $liteRoot 'native/licensing/IssuerForm.cs')
if ($LASTEXITCODE -ne 0) { throw 'Offline issuer build failed.' }
Get-Item -LiteralPath $liteIssuer | Select-Object Name,Length
