<#
.SYNOPSIS
  Install an MGU/OAP app onto the head unit over SSH.

.DESCRIPTION
  By default this downloads the prebuilt package from the project's GitHub
  Releases and installs it, so the laptop only needs Windows + the OpenSSH
  client (no Python/Node/SDK).

    (default)  download the newest <AppId>@<version>.mgu from GitHub Releases
    -Build     build from source on this machine (needs Python 3 + Node.js
               and a local clone of this repository)
    -Local     use a package already present in dist/ (no download / no build)

  After obtaining the package the script connects to the head unit as root,
  unpacks the .mgu, copies it to /var/opt/private/oap/<AppId>/ and restarts
  oap-mainapp (supervisor respawns it in ~5-10 s).

.PARAMETER AppId
  Application folder name under apps/. Default: m_vitals_plus

.PARAMETER HostName
  IP or hostname of the head unit (e.g. 172.16.0.1 when connected via enet).

.PARAMETER KeyPath
  SSH private key path. Default: <user profile>\.ssh\mgu_root_key

.PARAMETER User
  SSH user. Default: root

.PARAMETER RemoteBase
  Apps directory on the head unit. Default: /var/opt/private/oap

.PARAMETER Repo
  GitHub owner/repo to download the release from. Default: daniloz095/VMG-Utility

.PARAMETER Local
  Use a package already present in dist/ instead of downloading/building.

.PARAMETER SkipBuild
  Alias of -Local (kept for backwards compatibility).

.PARAMETER Build
  Build from source on this machine (requires a local clone + Python 3 + Node.js).

.PARAMETER NoRestart
  Do not restart oap-mainapp after installing.

.EXAMPLE
  # one-liner (no repo checkout needed):
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/VMG-Utility/main/kit/tools/install.ps1))) -HostName 172.16.0.1

.EXAMPLE
  # from a clone of the repo:
  .\kit\tools\install.ps1 -HostName 172.16.0.1

.EXAMPLE
  # use a local package without downloading/building:
  .\kit\tools\install.ps1 -HostName 172.16.0.1 -Local

.EXAMPLE
  # build from source on this machine:
  .\kit\tools\install.ps1 -HostName 172.16.0.1 -Build

.NOTES
  Requires OpenSSH client (ssh.exe / scp.exe) - Windows 10+ feature "OpenSSH Client".
#>
[CmdletBinding()]
param(
    [string]$AppId     = 'm_vitals_plus',
    [string]$HostName,
    [string]$KeyPath   = (Join-Path $env:USERPROFILE '.ssh\mgu_root_key'),
    [string]$EnrollDir,
    [string]$User      = 'root',
    [string]$RemoteBase = '/var/opt/private/oap',
    [string]$Repo      = 'daniloz095/VMG-Utility',
    [switch]$Local,
    [switch]$SkipBuild,
    [switch]$Build,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'

# GitHub requires TLS 1.2+; older PowerShell defaults may negotiate TLS 1.0/1.1.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg)       { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

function Get-SshEnrollment {
    param([string]$EnrollDir)
    # The idrive7-8-ssh-root / ssh_enable tool saves an enrollment record
    # (connect.txt with the MGU IP + ssh command) next to the private key
    # (id_rsa) under ...\data\enrollments\<VIN>\. Find it and return {IP, Key}.
    $conn = $null
    if ($EnrollDir) {
        if (Test-Path -LiteralPath $EnrollDir -PathType Leaf) { $conn = Get-Item -LiteralPath $EnrollDir }
        elseif (Test-Path -LiteralPath $EnrollDir -PathType Container) {
            $conn = Get-ChildItem -LiteralPath $EnrollDir -Recurse -Filter 'connect.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
        }
    } else {
        $roots = @(
            (Join-Path $env:USERPROFILE 'Downloads'),
            (Join-Path $env:USERPROFILE 'Desktop'),
            (Join-Path $env:USERPROFILE 'Documents'),
            (Join-Path $env:USERPROFILE 'OneDrive\Downloads'),
            (Join-Path $env:USERPROFILE 'OneDrive\Desktop')
        )
        foreach ($r in $roots) {
            if (-not (Test-Path -LiteralPath $r)) { continue }
            $conn = Get-ChildItem -LiteralPath $r -Recurse -Filter 'connect.txt' -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -match 'enroll' } |
                    Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($conn) { break }
        }
    }
    if (-not $conn) { return $null }
    $txt = Get-Content -LiteralPath $conn.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $txt) { return $null }
    $ip = $null; $key = $null
    if ($txt -match 'root@([0-9.]+)') { $ip = $Matches[1] }
    if (-not $ip -and $txt -match '(?:MGU\s+IP|IP)\s*[:=]\s*([0-9.]+)') { $ip = $Matches[1] }
    if ($txt -match '-i\s+"([^"]+)"') { $key = $Matches[1] }
    if (-not $key -and $txt -match '-i\s+([^\s"]+)') { $key = $Matches[1] }
    if (-not $key) {
        $c = Get-ChildItem -LiteralPath (Split-Path -Parent $conn.FullName) -Filter 'id_rsa' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { $key = $c.FullName }
    }
    if ($ip -or $key) { return [pscustomobject]@{ IP = $ip; Key = $key } }
    return $null
}

function Get-LatestReleasePackage {
    param([string]$Repo, [string]$AppId)
    $api = "https://api.github.com/repos/$Repo/releases/latest"
    Write-Step "Looking up the latest release of $Repo ..."
    $headers = @{ 'User-Agent' = 'mgu-install'; 'Accept' = 'application/vnd.github+json' }
    try {
        $rel = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30 -ErrorAction Stop
    } catch {
        Fail "Cannot reach GitHub ($api). Check the internet connection. ($($_.Exception.Message))"
    }
    if (-not $rel -or -not $rel.assets) { Fail "No release found in $Repo." }
    $asset = $rel.assets | Where-Object { $_.name -like "$AppId@*.mgu" } | Select-Object -First 1
    if (-not $asset) { Fail "The latest release of $Repo has no $AppId@*.mgu asset." }
    $out = Join-Path $env:TEMP $asset.name
    Write-Step "Downloading $($asset.name) ($([math]::Round($asset.size / 1KB, 1)) KB) ..."
    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $out -TimeoutSec 120 -ErrorAction Stop
    } catch {
        Fail "Download failed ($($asset.name)). Check the internet connection. ($($_.Exception.Message))"
    }
    return $out
}

# Auto-detect the MGU IP / SSH key from the idrive7-8-ssh-root / ssh_enable
# enrollment (connect.txt + id_rsa) when not provided or the default key is missing.
if ((-not $HostName) -or (-not (Test-Path -LiteralPath $KeyPath))) {
    $enroll = Get-SshEnrollment -EnrollDir $EnrollDir
    if ($enroll) {
        if (-not $HostName -and $enroll.IP) { $HostName = $enroll.IP; Write-Step "Auto-detected HU IP: $HostName" }
        if ((-not (Test-Path -LiteralPath $KeyPath)) -and $enroll.Key) { $KeyPath = $enroll.Key; Write-Step "Auto-detected SSH key: $KeyPath" }
    }
}
if (-not $HostName) { Fail 'HostName is required (the head unit IP, e.g. -HostName 169.254.x.x — the Gateway shown by idrive7-8-ssh-root).' }

# --- tool checks -------------------------------------------------------------
foreach ($bin in 'ssh', 'scp', 'tar') {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        Fail "$bin.exe not found. Install the Windows 'OpenSSH Client' feature (ssh/scp); tar ships with Windows 10+."
    }
}
if (-not (Test-Path -LiteralPath $KeyPath)) { Fail "SSH key not found: $KeyPath" }

# --- common ssh options --------------------------------------------------------
$SshCommon = @(
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-i', $KeyPath
)
$Target = "$User@$HostName"

# scp on OpenSSH >= 9.0 defaults to the SFTP protocol, which the HU's embedded
# sshd may not provide. Force the legacy scp protocol when the client supports
# -O (added in OpenSSH 8.7; the SFTP default arrived in 9.0). Note: Windows
# scp has no -V, so read the version from ssh (they ship together).
$ScpLegacy = @()
$sshVer = (& ssh -V 2>&1 | Out-String)
if ($sshVer -match 'OpenSSH[^\d]*(\d+)\.(\d+)') {
    if ([int]$Matches[1] -ge 9) { $ScpLegacy = @('-O') }
}

# --- resolve the package --------------------------------------------------------
$UseLocal = ($Local -or $SkipBuild)
$PkgPath = $null

if ($Build) {
    if (-not $PSScriptRoot) { Fail '-Build needs a local clone of the repo (not available in the one-liner).' }
    $RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $BuildPy  = Join-Path $PSScriptRoot 'build.py'
    if (-not (Test-Path -LiteralPath $BuildPy)) { Fail "build.py not found next to install.ps1 ($BuildPy)." }
    $PythonExe = $null
    foreach ($cand in 'python', 'python3', 'py') {
        $cmd = Get-Command $cand -ErrorAction SilentlyContinue
        if ($cmd) { $PythonExe = $cmd.Source; break }
    }
    if (-not $PythonExe) { Fail 'Python 3 not found on PATH (needed for build.py).' }
    Write-Step "Building $AppId from source ..."
    & $PythonExe $BuildPy $AppId
    if ($LASTEXITCODE -ne 0) { Fail "build.py failed (exit $LASTEXITCODE)" }
    $DistDir = Join-Path $RepoRoot 'dist'
    $pkg = Get-ChildItem -LiteralPath $DistDir -Filter "$AppId@*.mgu" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $pkg) { Fail "build.py produced no $AppId@*.mgu in $DistDir." }
    $PkgPath = $pkg.FullName
}
elseif ($UseLocal) {
    if (-not $PSScriptRoot) { Fail '-Local needs a local clone of the repo (not available in the one-liner).' }
    $RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $DistDir  = Join-Path $RepoRoot 'dist'
    $pkg = Get-ChildItem -LiteralPath $DistDir -Filter "$AppId@*.mgu" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $pkg) { Fail "No $AppId@*.mgu in $DistDir. Run with -Build or drop -Local to download." }
    $PkgPath = $pkg.FullName
}
else {
    $PkgPath = Get-LatestReleasePackage -Repo $Repo -AppId $AppId
}

Write-Step "Package: $(Split-Path $PkgPath -Leaf) ($([math]::Round((Get-Item -LiteralPath $PkgPath).Length / 1KB, 1)) KB)"

# --- extract + deploy ------------------------------------------------------------
$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("mgu-deploy-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
    $Payload = Join-Path $Stage 'pkg'
    New-Item -ItemType Directory -Path $Payload | Out-Null
    Write-Step 'Unpacking .mgu ...'
    tar.exe -xzf $PkgPath -C $Payload
    if ($LASTEXITCODE -ne 0) { Fail 'tar extraction failed.' }
    if (-not (Test-Path (Join-Path $Payload 'app.json'))) { Fail 'package missing app.json' }
    if (-not (Test-Path (Join-Path $Payload 'javascript/app.js'))) { Fail 'package missing javascript/app.js' }

    Write-Step "Connecting to $Target ..."
    ssh @SshCommon -n $Target 'echo ok' 2>$null
    if ($LASTEXITCODE -ne 0) {
        Fail "Cannot SSH to $Target. Check ignition/power, IP ($HostName) and key ($KeyPath)."
    }

    Write-Step "Installing to $RemoteBase/$AppId ..."
    ssh @SshCommon $Target "mkdir -p $RemoteBase && rm -rf $RemoteBase/$AppId"
    if ($LASTEXITCODE -ne 0) { Fail 'remote mkdir/rm failed' }

    scp @SshCommon @ScpLegacy -q -r $Payload "${Target}:$RemoteBase/$AppId"
    if ($LASTEXITCODE -ne 0) { Fail 'scp upload failed' }

    ssh @SshCommon $Target "chmod -R a+rX $RemoteBase/$AppId"
    if ($LASTEXITCODE -ne 0) { Fail 'remote chmod failed' }

    if (-not $NoRestart) {
        Write-Step 'Restarting oap-mainapp ...'
        ssh @SshCommon $Target 'killall oap-mainapp || true' 2>$null
    }

    Write-Host ''
    Write-Step "DONE: $AppId ($(Split-Path $PkgPath -Leaf)) deployed to ${Target}:$RemoteBase/$AppId"
    Write-Host 'The app respawns in ~5-10 s. Open it from the OAP menu.' -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
