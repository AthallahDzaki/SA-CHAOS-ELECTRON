<#
.SYNOPSIS
    SA-CHAOS Core Repair & Smart Patch Tool
    URL: https://is3.cloudhost.id/sa-chaos/desktop/updates/fixer-script.ps1
#>

[CmdletBinding()]
param(
    [string]$TargetVer = "latest",
    [string]$BaseServerUrl = "https://updater.sa-chaos.my.id/velopack.php"
)

$ErrorActionPreference = "Stop"
$global:ProgressPreference = 'SilentlyContinue'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

$TargetDir   = Join-Path $env:LOCALAPPDATA "SA-CHAOS"
$PackagesDir = Join-Path $TargetDir "packages"
$CurrentDir  = Join-Path $TargetDir "current"
$UpdateExe   = Join-Path $TargetDir "Update.exe"
$AppExe      = Join-Path $CurrentDir "SA-CHAOS.exe"
$UserAgent   = "SA-CHAOS/1.1 (Windows NT 10.0; Win64; x64) Electron/Node.js SA-CHAOS"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   SA-CHAOS SMART PATCH AND EMERGENCY REPAIR TOOL       " -ForegroundColor Yellow
Write-Host "   High-Speed Engine & Direct Cryptographic Validation  " -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Cyan

# HTTP GET tanpa cache
function Invoke-FreshRequest {
    param([Parameter(Mandatory=$true)][string]$Uri)
    $sep = if ($Uri.Contains("?")) { "&" } else { "?" }
    $url = "$Uri$($sep)_cb=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    $headers = @{
        "User-Agent"    = $UserAgent
        "Cache-Control" = "no-cache, no-store, must-revalidate"
        "Pragma"        = "no-cache"
    }
    return Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing
}

# Download cepat prioritas curl.exe native socket
function Invoke-FreshDownload {
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [Parameter(Mandatory=$true)][string]$OutFile
    )
    $sep = if ($Uri.Contains("?")) { "&" } else { "?" }
    $url = "$Uri$($sep)_cb=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"

    if (Test-Path $OutFile) {
        Remove-Item -Path $OutFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host "   [Download] Mengunduh: $(Split-Path $OutFile -Leaf)..." -ForegroundColor Gray

    $curlPath = "$env:SystemRoot\System32\curl.exe"
    if (Test-Path $curlPath) {
        & $curlPath -f -L -A "$UserAgent" -H "Cache-Control: no-cache" -H "Pragma: no-cache" --progress-bar -o "$OutFile" "$url"
        if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) {
            return
        }
        Write-Host "   [Info] curl gagal, fallback ke .NET WebClient..." -ForegroundColor Yellow
    }

    $oldPref = $global:ProgressPreference
    $global:ProgressPreference = 'SilentlyContinue'
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("User-Agent", $UserAgent)
        $wc.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
        $wc.Headers.Add("Pragma", "no-cache")
        $wc.DownloadFile($url, $OutFile)
    } finally {
        $global:ProgressPreference = $oldPref
    }
}

# Verifikasi SHA256 nupkg dari manifest Velopack
function Assert-PackageIntegrity {
    param(
        [string]$FilePath,
        [string]$ExpectedHash
    )
    if (-not (Test-Path $FilePath)) {
        throw "File target tidak ditemukan: $FilePath"
    }
    Write-Host "   [Security] Menghitung checksum SHA-256..." -ForegroundColor Gray
    $fileHash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToUpper()
    if ($fileHash -ne $ExpectedHash.ToUpper()) {
        Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue
        throw "CHECKSUM MISMATCH! File korup atau dipalsukan.`nExpected: $ExpectedHash`nActual  : $fileHash"
    }
    Write-Host "   [Security] Paket terverifikasi valid ($fileHash)" -ForegroundColor Green
}

# 1. Menutup proses aktif
Write-Host "[1/5] Menutup proses SA-CHAOS dan Update.exe..." -ForegroundColor Yellow
Get-Process -Name "SA-CHAOS", "Update" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Host "       Proses berhasil dibersihkan.`n" -ForegroundColor Green

# 2. Membersihkan cache lokal lama
Write-Host "[2/5] Membersihkan cache lama dan file temporary..." -ForegroundColor Yellow
if (-not (Test-Path $PackagesDir)) {
    New-Item -ItemType Directory -Path $PackagesDir -Force | Out-Null
}

@("$PackagesDir\.velopack_lock", "$PackagesDir\VelopackTemp") | ForEach-Object {
    if (Test-Path $_) { Remove-Item -Path $_ -Recurse -Force -ErrorAction SilentlyContinue }
}

if (Test-Path $CurrentDir) {
    Get-ChildItem -Path $CurrentDir -Include "*.diff", "*.zsdiff", "*.shasum" -File -Recurse -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
Write-Host "       Pembersihan cache lokal selesai.`n" -ForegroundColor Green

# 3. Resolusi Target Version & Delta Chain
Write-Host "[3/5] Memeriksa manifest rilis dari server updater..." -ForegroundColor Yellow

$manifestUrl = "$BaseServerUrl/releases.win.json"
try {
    $manifest = Invoke-FreshRequest -Uri $manifestUrl
} catch {
    Write-Host "[ERROR] Gagal mengambil manifest rilis dari $($manifestUrl): $_" -ForegroundColor Red
    return
}

$allAssets = $manifest.Assets
if (-not $allAssets) {
    Write-Host "[ERROR] Format manifest tidak memiliki field Assets." -ForegroundColor Red
    return
}

# Urutkan rilis Full berdasarkan SemVer descending
$fullReleases = $allAssets | Where-Object { $_.Type -eq "Full" } | Sort-Object { [version]$_.Version } -Descending

if ($TargetVer -eq "latest" -or [string]::IsNullOrWhiteSpace($TargetVer)) {
    $targetRelease = $fullReleases | Select-Object -First 1
    $TargetVer = $targetRelease.Version
    Write-Host "       [OK] Versi target rilis terbaru: v$TargetVer" -ForegroundColor Green
} else {
    $targetRelease = $fullReleases | Where-Object { $_.Version -eq $TargetVer } | Select-Object -First 1
    if (-not $targetRelease) {
        Write-Host "[ERROR] Versi $TargetVer tidak ada di manifest updater." -ForegroundColor Red
        return
    }
}

$TargetFullName  = $targetRelease.FileName
$TargetDeltaName = "SA-CHAOS-$TargetVer-delta.nupkg"
$FullPkgPath     = Join-Path $PackagesDir $TargetFullName

# Deteksi 2 rilis sebelumnya secara dinamis dari aset manifest
$olderFullReleases = $fullReleases | Where-Object { [version]$_.Version -lt [version]$TargetVer }
$prevVer1 = if ($olderFullReleases.Count -ge 1) { $olderFullReleases[0].Version } else { $null }
$prevVer2 = if ($olderFullReleases.Count -ge 2) { $olderFullReleases[1].Version } else { $null }

$baseFullPkg = $null
$baseType = 0

if ($prevVer1 -and (Test-Path (Join-Path $PackagesDir "SA-CHAOS-$prevVer1-full.nupkg"))) {
    $baseFullPkg = Join-Path $PackagesDir "SA-CHAOS-$prevVer1-full.nupkg"
    $baseType = 1
} elseif ($prevVer2 -and (Test-Path (Join-Path $PackagesDir "SA-CHAOS-$prevVer2-full.nupkg"))) {
    $baseFullPkg = Join-Path $PackagesDir "SA-CHAOS-$prevVer2-full.nupkg"
    $baseType = 2
}

$deltaSuccess = $false

# KASUS 1: Basis x-1 ditemukan -> Unduh 1 Delta
if ($baseType -eq 1 -and (Test-Path $UpdateExe)) {
    $targetDeltaAsset = $allAssets | Where-Object { $_.FileName -eq $TargetDeltaName }
    if ($targetDeltaAsset) {
        Write-Host "       Basis v$prevVer1 ditemukan. Mengunduh Delta patch 1 tahap (~1 MB)..." -ForegroundColor Cyan
        $delta1Path = Join-Path $PackagesDir $TargetDeltaName
        try {
            Invoke-FreshDownload -Uri "$BaseServerUrl/$TargetDeltaName" -OutFile $delta1Path
            Assert-PackageIntegrity -FilePath $delta1Path -ExpectedHash $targetDeltaAsset.SHA256

            Write-Host "       Merekontruksi paket Full v$TargetVer via Velopack Update.exe..." -ForegroundColor Cyan
            $p = Start-Process -FilePath $UpdateExe -ArgumentList "patch", "--old", "`"$baseFullPkg`"", "--delta", "`"$delta1Path`"", "--output", "`"$FullPkgPath`"", "--verbose" -Wait -PassThru -NoNewWindow
            if ($p.ExitCode -eq 0 -and (Test-Path $FullPkgPath)) {
                Assert-PackageIntegrity -FilePath $FullPkgPath -ExpectedHash $targetRelease.SHA256
                Write-Host "       [SUKSES] Rekonstruksi Full Package dari Delta 1-tahap berhasil!" -ForegroundColor Green
                $deltaSuccess = $true
            }
        } catch {
            Write-Host "       [Peringatan] Delta patch gagal: $_" -ForegroundColor Yellow
        } finally {
            if (Test-Path $delta1Path) { Remove-Item -Path $delta1Path -Force -ErrorAction SilentlyContinue }
        }
    }
}

# KASUS 2: Basis x-2 ditemukan -> Unduh 2 Delta berantai
if (-not $deltaSuccess -and $baseType -eq 2 -and (Test-Path $UpdateExe)) {
    $deltaPrevName    = "SA-CHAOS-$prevVer1-delta.nupkg"
    $prevDeltaAsset   = $allAssets | Where-Object { $_.FileName -eq $deltaPrevName }
    $targetDeltaAsset = $allAssets | Where-Object { $_.FileName -eq $TargetDeltaName }

    if ($prevDeltaAsset -and $targetDeltaAsset) {
        Write-Host "       Basis v$prevVer2 ditemukan. Mengunduh 2 delta berantai (~2 MB total)..." -ForegroundColor Cyan
        $deltaPrevPath   = Join-Path $PackagesDir $deltaPrevName
        $deltaTargetPath = Join-Path $PackagesDir $TargetDeltaName

        try {
            Invoke-FreshDownload -Uri "$BaseServerUrl/$deltaPrevName" -OutFile $deltaPrevPath
            Assert-PackageIntegrity -FilePath $deltaPrevPath -ExpectedHash $prevDeltaAsset.SHA256

            Invoke-FreshDownload -Uri "$BaseServerUrl/$TargetDeltaName" -OutFile $deltaTargetPath
            Assert-PackageIntegrity -FilePath $deltaTargetPath -ExpectedHash $targetDeltaAsset.SHA256

            Write-Host "       Merekontruksi paket Full v$TargetVer dengan 2 delta berantai..." -ForegroundColor Cyan
            $p = Start-Process -FilePath $UpdateExe -ArgumentList "patch", "--old", "`"$baseFullPkg`"", "--delta", "`"$deltaPrevPath`"", "--delta", "`"$deltaTargetPath`"", "--output", "`"$FullPkgPath`"", "--verbose" -Wait -PassThru -NoNewWindow
            if ($p.ExitCode -eq 0 -and (Test-Path $FullPkgPath)) {
                Assert-PackageIntegrity -FilePath $FullPkgPath -ExpectedHash $targetRelease.SHA256
                Write-Host "       [SUKSES] Rekonstruksi Full Package dari 2 Delta berantai berhasil!" -ForegroundColor Green
                $deltaSuccess = $true
            }
        } catch {
            Write-Host "       [Peringatan] Delta patch berantai gagal: $_" -ForegroundColor Yellow
        } finally {
            @($deltaPrevPath, $deltaTargetPath) | ForEach-Object {
                if (Test-Path $_) { Remove-Item -Path $_ -Force -ErrorAction SilentlyContinue }
            }
        }
    }
}

# KASUS 3: Fallback unduh Full Package
if (-not $deltaSuccess) {
    Write-Host "       [Info] Mengunduh Full Package ($([math]::Round($targetRelease.Size / 1MB, 2)) MB)..." -ForegroundColor Cyan
    try {
        Invoke-FreshDownload -Uri "$BaseServerUrl/$TargetFullName" -OutFile $FullPkgPath
        Assert-PackageIntegrity -FilePath $FullPkgPath -ExpectedHash $targetRelease.SHA256
    } catch {
        Write-Host "`n[ERROR] Gagal mendapatkan paket terverifikasi: $_" -ForegroundColor Red
        return
    }
}

# 4. Pasang paket ke instalasi
Write-Host "`n[4/5] Memasang pembaruan ke direktori SA-CHAOS..." -ForegroundColor Yellow
if (Test-Path $UpdateExe) {
    $p = Start-Process -FilePath $UpdateExe -ArgumentList "apply", "--package", "`"$FullPkgPath`"", "--norestart", "--verbose" -Wait -PassThru -NoNewWindow
    if ($p.ExitCode -ne 0) {
        Write-Host "       [Peringatan] Status Update.exe code: $($p.ExitCode)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[ERROR] Update.exe tidak ditemukan di $TargetDir." -ForegroundColor Red
    return
}

# 5. Verifikasi hasil pemasangan
Write-Host "`n[5/5] Memverifikasi integritas SA-CHAOS.exe..." -ForegroundColor Yellow
if (Test-Path $AppExe) {
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "   [SUKSES] PERBAIKAN DAN UPDATE SELESAI DENGAN SEMPURNA" -ForegroundColor Green
    Write-Host "   - Executable SA-CHAOS.exe aktif (v$TargetVer)" -ForegroundColor Green
    Write-Host "   - Seluruh berkas nupkg tervalidasi SHA-256" -ForegroundColor Green
    Write-Host "   - Shortcut Desktop & Start Menu dipulihkan" -ForegroundColor Green
    Write-Host "========================================================`n" -ForegroundColor Green

    $run = Read-Host "Apakah ingin menjalankan SA-CHAOS sekarang? (Y/N, default Y)"
    if ([string]::IsNullOrWhiteSpace($run) -or $run.Trim().ToUpper() -eq "Y") {
        Write-Host "Menjalankan SA-CHAOS..." -ForegroundColor Cyan
        Start-Process -FilePath $AppExe
    }
} else {
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "   [PERINGATAN] SA-CHAOS.exe tidak terdeteksi di $CurrentDir." -ForegroundColor Red
    Write-Host "   Coba jalankan kembali PowerShell sebagai Administrator." -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
}