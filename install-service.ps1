<#
.SYNOPSIS
  Installs NetTraffic-Monitor as a Windows service (LocalSystem, automatic start at boot, restart on failure).
.DESCRIPTION
  The service runs as SYSTEM, so everything it executes must be writable by administrators only.
  The code is therefore copied to "C:\Program Files\NetTraffic-Monitor" (data and config.json live there too) and
  Python must be an all-users install. Re-run the script to deploy code changes from this folder.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-service.ps1
  powershell -ExecutionPolicy Bypass -File install-service.ps1 -Uninstall
#>
param(
    [string]$Python,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Name = 'NetTraffic-Monitor'
$Root = $PSScriptRoot
$Dest = Join-Path $env:ProgramFiles 'NetTraffic-Monitor'

# Elevate: creating services and the kernel ETW trace both need administrator rights.
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"")
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch]) { if ($kv.Value) { $argList += "-$($kv.Key)" } }
        else { $argList += "-$($kv.Key)", "`"$($kv.Value)`"" }
    }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
    exit
}

function Remove-AppService($svcName = $Name) {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if (-not $svc) { return $false }
    if ($svc.Status -ne 'Stopped') {
        Write-Host "Stopping $svcName ..."
        Stop-Service -Name $svcName -Force
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    & sc.exe delete $svcName | Out-Null
    # Deletion completes once no handle to the service is open; wait for it.
    for ($i = 0; $i -lt 20 -and (Get-Service -Name $svcName -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    return $true
}

# Names of non-admin principals that could modify $path (and so inject code that runs as SYSTEM).
# shortcut: checks the folder itself, not every file below it; enough for standard installs, which inherit.
function Get-UnsafeWriters($path) {
    $trusted = 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0',  # SYSTEM, Administrators, CREATOR OWNER
               'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'  # TrustedInstaller
    # WriteData, AppendData, WriteEA, DeleteChild, WriteAttributes, Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL/WRITE
    $writeMask = 0x500D0156
    $acl = Get-Acl $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $bad = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
        Where-Object { $_.AccessControlType -eq 'Allow' -and ([int64]$_.FileSystemRights -band $writeMask) -and
                       $trusted -notcontains $_.IdentityReference.Value } |
        ForEach-Object { $_.IdentityReference.Translate([Security.Principal.NTAccount]).Value })
    if ($trusted -notcontains $owner) { $bad += "owner $($acl.Owner)" }
    $bad | Select-Object -Unique
}

if ($Uninstall) {
    if (Remove-AppService) { Write-Host "$Name service removed. $Dest (data, config) is kept." }
    else { Write-Host "$Name service is not installed." }
    exit
}

# Resolve the real python.exe (not the WindowsApps store stub); LocalSystem has no user PATH.
if (-not $Python) {
    $cmd = Get-Command python.exe, py.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
    if (-not $cmd) { throw 'Python not found. Pass -Python C:\path\to\python.exe' }
    $Python = (& $cmd.Source -c 'import sys; print(sys.executable)').Trim()
}
if (-not (Test-Path $Python)) { throw "Python not found at $Python" }
& $Python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) { throw "NetTraffic-Monitor needs Python 3.10+ ($Python)" }
$unsafe = Get-UnsafeWriters (Split-Path $Python)
if ($unsafe) {
    throw ("$Python is writable by: $($unsafe -join ', '). Anyone with that access could run code as SYSTEM.`n" +
           "Install Python for all users (e.g. winget install Python.Python.3.12 --scope machine) and pass -Python 'C:\Program Files\Python312\python.exe'.")
}

if (Remove-AppService) { Write-Host "Removed existing $Name service." }
# Upgrade from the old name NetMon: drop its service, take over its config and data (the .db is renamed on start).
$OldDest = Join-Path $env:ProgramFiles 'NetMon'
if (Remove-AppService 'NetMon') { Write-Host "Removed old NetMon service." }
if ((Test-Path $OldDest) -and -not (Test-Path $Dest)) {
    New-Item -ItemType Directory -Force "$Dest\data" | Out-Null
    Copy-Item "$OldDest\config.json" $Dest -ErrorAction SilentlyContinue
    Copy-Item "$OldDest\data\netmon.db*" "$Dest\data\" -ErrorAction SilentlyContinue
    Write-Host "Copied config and database from $OldDest (delete that folder once everything works)"
}

# Deploy into Program Files: inherits SYSTEM/Administrators full control, Users read-only.
New-Item -ItemType Directory -Force "$Dest\data" | Out-Null
& robocopy.exe "$Root\nettraffic_monitor" "$Dest\nettraffic_monitor" /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the code to $Dest failed (robocopy $LASTEXITCODE)" }
Copy-Item "$Root\service.py" $Dest -Force
if (-not (Test-Path "$Dest\config.json")) { Copy-Item "$Root\config.json" $Dest }
# First install: take over the existing history (a running console NetTraffic-Monitor must be closed first).
if (-not (Test-Path "$Dest\data\*.db") -and (Test-Path "$Root\data\*.db")) {
    Copy-Item "$Root\data\*.db*" "$Dest\data\"
    Write-Host "Copied existing database to $Dest\data"
}
& icacls.exe "$Dest" /reset /T /C /Q | Out-Null  # drop any explicit ACEs; only the protected inherited ones remain
$unsafe = Get-UnsafeWriters $Dest
if ($unsafe) { throw "$Dest is writable by: $($unsafe -join ', '). Fix its permissions and re-run." }

# -I: isolated mode, ignores PYTHON* environment variables and the user site-packages.
$binPath = "`"$Python`" -I `"$Dest\service.py`""
New-Service -Name $Name -BinaryPathName $binPath -DisplayName 'NetTraffic-Monitor' `
    -Description 'Per-process network monitor (ETW kernel network trace). Dashboard on 127.0.0.1.' `
    -StartupType Automatic | Out-Null

# LocalSystem: required for the kernel network ETW session and for resolving paths of all processes.
& sc.exe config $Name obj= LocalSystem | Out-Null
# Restart after 5 s on the first two failures, after 60 s afterwards; reset the counter daily.
& sc.exe failure $Name reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
& sc.exe failureflag $Name 1 | Out-Null

Start-Service -Name $Name
$Port = 8765
$cfg = Get-Content -Raw "$Dest\config.json" | ConvertFrom-Json
if ($cfg.port) { $Port = [int]$cfg.port }
$url = "http://127.0.0.1:$Port/"
for ($i = 0; $i -lt 20; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
Get-Service -Name $Name | Format-Table -AutoSize Name, Status, StartType
if ($ok) { Write-Host "NetTraffic-Monitor service is running: $url  (config: $Dest\config.json)" -ForegroundColor Green }
else { Write-Warning "Service started but the dashboard does not answer yet. See $Dest\data\service.log" }
