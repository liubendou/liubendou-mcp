$ErrorActionPreference = 'Stop'
$liteRoot = Split-Path $PSScriptRoot -Parent
$liteCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$liteStandard = Join-Path $liteRoot 'native/sdk/licensing/standard/lib/net461/Standard.Licensing.dll'
$liteCrypto = Join-Path $liteRoot 'native/sdk/licensing/bouncy/lib/net461/BouncyCastle.Cryptography.dll'
$liteTestRoot = Join-Path $env:USERPROFILE ('ops-tmp/lite-issuer-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $liteTestRoot | Out-Null
$liteTestExe = Join-Path $liteTestRoot 'IssuerTests.exe'
& $liteCompiler /nologo /target:exe /main:IssuerTests /platform:x64 /optimize+ /codepage:65001 "/out:$liteTestExe" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.Security.dll /r:System.Xml.dll "/r:$liteStandard" "/r:$liteCrypto" "/resource:$liteStandard,license.standard" "/resource:$liteCrypto,license.crypto" (Join-Path $liteRoot 'native/licensing/LicenseCommon.cs') (Join-Path $liteRoot 'native/licensing/LicenseIssuer.cs') (Join-Path $liteRoot 'native/licensing/IssuerHistory.cs') (Join-Path $liteRoot 'native/licensing/IssuerMac.cs') (Join-Path $liteRoot 'native/licensing/IssuerForm.cs') (Join-Path $liteRoot 'native/licensing/ClientLicense.cs') (Join-Path $liteRoot 'tests/license-issuer.test.cs')
if ($LASTEXITCODE -ne 0) { throw 'Offline issuer tests failed to compile.' }
& $liteTestExe $liteTestRoot (Join-Path $liteRoot 'output/licensing/LicenseIssuer.exe')
if ($LASTEXITCODE -ne 0) { throw "Offline issuer tests failed. Test directory: $liteTestRoot" }
Write-Output "Test directory: $liteTestRoot"
