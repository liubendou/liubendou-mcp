$ErrorActionPreference = 'Stop'
$liteRoot = Split-Path $PSScriptRoot -Parent
$liteDirectory = Join-Path $env:USERPROFILE ('ops-tmp/lite-install-test-' + [Guid]::NewGuid().ToString('N'))
$liteInstalled = Join-Path $liteDirectory 'installed'
$liteData = Join-Path $liteDirectory 'data'
$liteExe = Join-Path $liteInstalled 'LiubendouLite.exe'
$liteDesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) '六本豆 Lite.lnk'
$liteMenu = Join-Path ([Environment]::GetFolderPath('Programs')) '六本豆 Lite'
$liteRegistry = 'HKCU:\Software\LiubendouLite'
$liteUninstallRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LiubendouLite'
if ((Test-Path -LiteralPath $liteDesktopLink) -or (Test-Path -LiteralPath $liteMenu) -or (Test-Path -LiteralPath $liteRegistry) -or (Test-Path -LiteralPath $liteUninstallRegistry)) { throw 'An existing installed client was found. The isolated installer test will not overwrite its shortcuts or registration.' }
New-Item -ItemType Directory -Path $liteDirectory,$liteData -Force | Out-Null
$liteCompiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$liteProbe = Join-Path $liteDirectory 'WindowProbe.exe'
& $liteCompiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$liteProbe" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll (Join-Path $liteRoot 'tests/window-probe.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native window probe compilation failed.' }
$script:litePassed = 0
function Assert-Lite([bool]$condition,[string]$name) { if (!$condition) { throw $name }; $script:litePassed++; Write-Output ('PASS: '+$name) }
function Wait-Lite([scriptblock]$condition) { $liteDeadline=[DateTime]::UtcNow.AddSeconds(15); while (!( & $condition )) { if ([DateTime]::UtcNow -gt $liteDeadline) { throw 'Installer verification timed out.' }; Start-Sleep -Milliseconds 100 } }
$litePreviousData = $env:LBD_DATA_DIR
$litePreviousPort = $env:LBD_PORT
$liteWindow = $null
try {
    $liteSetup=Start-Process -FilePath (Join-Path $liteRoot 'release/LiubendouLite-Setup-0.3.0.exe') -ArgumentList '/S',('/D='+$liteInstalled) -WindowStyle Hidden -Wait -PassThru
    Assert-Lite ($liteSetup.ExitCode -eq 0 -and (Test-Path -LiteralPath $liteExe)) 'EXE installer completes in current-user installation mode'
    $liteStage=Join-Path $liteRoot 'release/LiubendouLite-0.3.0-win-x64-licensed'
    foreach ($liteFile in @('LiubendouLite.exe','secure/core.bin','secure/build.lic','secure/manifest.json','dist/bootstrap.cjs','dist/proxy.cjs','runtime/node.exe')) {
        Assert-Lite ((Get-FileHash -LiteralPath (Join-Path $liteInstalled $liteFile)).Hash -eq (Get-FileHash -LiteralPath (Join-Path $liteStage $liteFile)).Hash) ('Installed file hash matches: '+$liteFile)
    }
    Assert-Lite ((Test-Path -LiteralPath $liteDesktopLink) -and (Test-Path -LiteralPath (Join-Path $liteMenu '六本豆 Lite.lnk'))) 'Installer creates desktop and Start menu shortcuts'
    Assert-Lite ((Get-ItemProperty -LiteralPath $liteUninstallRegistry).DisplayVersion -eq '0.3.0') 'Installer registers the current-user uninstall entry'
    $env:LBD_DATA_DIR=$liteData
    $env:LBD_PORT='18780'
    $liteWindow=Start-Process -FilePath $liteExe -PassThru -WindowStyle Normal
    Wait-Lite { $liteWindow.Refresh(); $liteWindow.MainWindowHandle -ne [IntPtr]::Zero }
    $liteWindowInfo=Join-Path $liteDirectory 'license-window.json'
    & $liteProbe $liteWindow.Id $liteWindowInfo (Join-Path $liteDirectory 'license-window.png')
    if ($LASTEXITCODE -ne 0) { throw 'Native window inspection failed.' }
    $liteInspection=Get-Content -LiteralPath $liteWindowInfo -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-Lite ($liteInspection.title -eq '六本豆 Lite · 离线授权') 'First launch displays the offline activation window'
    Assert-Lite ($liteInspection.export_visible -and $liteInspection.import_visible -and $liteInspection.buttons_fit) 'Request export and licence import buttons are visible and fit the window'
    $null=$liteWindow.CloseMainWindow()
    if (!$liteWindow.WaitForExit(5000)) { throw 'The first-run activation window did not close.' }
    $liteWindow=$null
    Assert-Lite (!(Test-Path -LiteralPath (Join-Path $liteData 'memory.sqlite'))) 'An unlicensed first launch never starts the tool backend'
    $liteRequest=Join-Path $liteDirectory 'installed-device.lbdreq'
    $liteExport=Start-Process -FilePath $liteExe -ArgumentList '--export-request',$liteRequest -WindowStyle Hidden -Wait -PassThru
    Assert-Lite ($liteExport.ExitCode -eq 0 -and (Test-Path -LiteralPath $liteRequest)) 'Installed client exports a device request'
    $liteLicence=Join-Path $liteDirectory 'installed-device.lic'
    $liteIssue=Start-Process -FilePath (Join-Path $liteRoot 'output/licensing/LicenseIssuer.exe') -ArgumentList '--issue',$liteRequest,$liteLicence,'7' -WindowStyle Hidden -Wait -PassThru
    if ($liteIssue.ExitCode -ne 0) { throw 'Signing the installed-device licence failed.' }
    $liteImport=Start-Process -FilePath $liteExe -ArgumentList '--import-license',$liteLicence -WindowStyle Hidden -Wait -PassThru
    Assert-Lite ($liteImport.ExitCode -eq 0) 'Installed client imports the desktop-issued offline licence'
    $liteSentinel=Join-Path $liteInstalled 'user-extra-keep.txt'
    [IO.File]::WriteAllText($liteSentinel,'KEEP_UNKNOWN_FILE')
    $liteUninstall=Start-Process -FilePath (Join-Path $liteInstalled 'Uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    Wait-Lite { !(Test-Path -LiteralPath $liteExe) -and !(Test-Path -LiteralPath $liteUninstallRegistry) }
    Assert-Lite (!(Test-Path -LiteralPath $liteDesktopLink) -and !(Test-Path -LiteralPath $liteMenu)) 'Uninstaller removes program shortcuts and registration'
    Assert-Lite ((Test-Path -LiteralPath (Join-Path $liteData 'offline.lic')) -and (Test-Path -LiteralPath (Join-Path $liteData 'license-identity.bin'))) 'Uninstaller preserves local licence and device data'
    Assert-Lite ([IO.File]::ReadAllText($liteSentinel) -eq 'KEEP_UNKNOWN_FILE') 'Uninstaller preserves unknown files instead of recursively deleting the installation folder'
    @{passed=$script:litePassed;failed=0;testDirectory=$liteDirectory;utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $liteDirectory 'results.json') -Encoding utf8
    Write-Output ('RESULT: '+$script:litePassed+' passed, 0 failed. '+$liteDirectory)
}
finally {
    if ($liteWindow -and !$liteWindow.HasExited) { $null=$liteWindow.CloseMainWindow() }
    $env:LBD_DATA_DIR=$litePreviousData
    $env:LBD_PORT=$litePreviousPort
}
