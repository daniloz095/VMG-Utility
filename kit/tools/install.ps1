<#
.SYNOPSIS
  One-shot build + deploy of an MGU/OAP app to the head unit over SSH.

.DESCRIPTION
  1. Runs kit/tools/build.py to pack apps/<AppId> into dist/<AppId>@<version>.mgu
     (requires Python 3 and Node.js on PATH; browserify is bootstrapped
     automatically by build.py).
  2. Connects to the HU as root over SSH using your private key, verifies the
     connection, unpacks the .mgu locally, pushes it to /var/opt/private/oap/<AppId>/
     and restarts oap-mainapp (supervisor respawns it in ~5-10 s).

.PARAMETER AppId
  Application folder name under apps/. Default: m_vitals_plus

.PARAMETER HostName
  IP or hostname of the head unit (e.g. 172.16.0.1 when connected via enet).

.PARAMETER KeyPath
  SSH private key path. Default: C:\Users\dmpol\.ssh\mgu_root_key

.PARAMETER SkipBuild
  Deploy the newest .mgu already present in dist/ without rebuilding.

.EXAMPLE
  .\kit\tools\install.ps1 -HostName 172.16.0.1

.EXAMPLE
  .\kit\tools\install.ps1 -HostName 172.16.0.1 -SkipBuild

.NOTES
  Requires OpenSSH client (ssh.exe / scp.exe) - Windows 10+ feature "OpenSSH Client".
#>
[CmdletBinding()]
param(
    [string]$AppId    = 'm_vitals_plus',
    [Parameter(Mandatory = $true)]
    [string]$HostName,
    [string]$KeyPath  = 'C:\Users\dmpol\.ssh\mgu_root_key',
    [string]$User     = 'root',
    [string]$RemoteBase = '/var/opt/private/oap',
    [switch]$SkipBuild,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

# --- paths ------------------------------------------------------------------
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent   # kit/tools -> repo root
$DistDir  = Join-Path $RepoRoot 'dist'
$BuildPy  = Join-Path $PSScriptRoot 'build.py'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg)       { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- tool checks --------------------------------------------------------------
foreach ($bin in 'ssh', 'scp') {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        Fail "$bin.exe not found. Install the Windows 'OpenSSH Client' feature."
    }
}
if (-not (Test-Path -LiteralPath $KeyPath)) {
    Fail "SSH key not found: $KeyPath"
}

$PythonExe = $null
foreach ($cand in 'python', 'python3', 'py') {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) {
        $PythonExe = $cmd.Source
        break
    }
}

# --- common ssh options -------------------------------------------------------
# -n : read host key DB non-interactively; BatchMode avoids password prompts
#      (the HU accepts our key only, a prompt would hang the script).
$SshCommon = @(
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-i', $KeyPath
)
$Target = "$User@$HostName"

# --- step 1: build ------------------------------------------------------------
if (-not $SkipBuild) {
    if (-not $PythonExe) { Fail 'Python 3 not found on PATH (needed for build.py). Use -SkipBuild to deploy an existing package.' }
    Write-Step "Building $AppId ..."
    & $PythonExe $BuildPy $AppId
    if ($LASTEXITCODE -ne 0) { Fail "build.py failed (exit $LASTEXITCODE)" }
}

# locate newest matching package
if (-not (Test-Path -LiteralPath $DistDir)) { Fail "dist/ not found. Build first (drop -SkipBuild)." }
$pkg = Get-ChildItem -LiteralPath $DistDir -Filter "$AppId@*.mgu" |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $pkg) { Fail "No $AppId@*.mgu in $DistDir. Run without -SkipBuild." }
Write-Step "Package: $($pkg.Name) ($([math]::Round($pkg.Length/1KB,1)) KB)"

# --- step 2: extract locally (tar.gz with app.json + javascript/app.js) --------
$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("mgu-deploy-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
    $Payload = Join-Path $Stage $AppId
    New-Item -ItemType Directory -Path $Payload | Out-Null
    Write-Step 'Unpacking .mgu ...'
    tar.exe -xzf $pkg.FullName -C $Payload
    if ($LASTEXITCODE -ne 0) { Fail "tar extraction failed (exit $LASTEXITCODE)" }
    if (-not (Test-Path (Join-Path $Payload 'app.json'))) { Fail 'package missing app.json' }
    if (-not (Test-Path (Join-Path $Payload 'javascript/app.js'))) { Fail 'package missing javascript/app.js' }

    # --- step 3: connectivity check -------------------------------------------
    Write-Step "Connecting to $Target ..."
    ssh @SshCommon -n $Target 'echo ok' 2>$null
    if ($LASTEXITCODE -ne 0) {
        Fail "Cannot SSH to $Target. Check ignition/power, IP ($HostName) and key ($KeyPath)."
    }

    # --- step 4: push ----------------------------------------------------------
    Write-Step "Installing to $RemoteBase/$AppId ..."
    ssh @SshCommon $Target "rm -rf $RemoteBase/$AppId && mkdir -p $RemoteBase/$AppId"
    if ($LASTEXITCODE -ne 0) { Fail 'remote mkdir failed' }

    scp @SshCommon -r $Payload "${Target}:$RemoteBase/"
    if ($LASTEXITCODE -ne 0) { Fail 'scp upload failed' }

    ssh @SshCommon $Target "chmod -R a+rX $RemoteBase/$AppId"
    if ($LASTEXITCODE -ne 0) { Fail 'remote chmod failed' }

    # --- step 5: restart mainapp ------------------------------------------------
    if (-not $NoRestart) {
        Write-Step 'Restarting oap-mainapp ...'
        ssh @SshCommon $Target 'killall oap-mainapp || true'
    }

    Write-Host ''
    Write-Step "DONE: $AppId ($($pkg.Name)) deployed to ${Target}:$RemoteBase/$AppId"
    Write-Host 'The app respawns in ~5-10 s. Open it from the OAP menu.' -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
