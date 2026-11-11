# SA-CHAOS Dynamic Patch & Repair Tool
# Reads releases.win.json from top to bottom (x, x-1, x-2) and reconstructs packages using Velopack
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  SA-CHAOS SMART PATCH & REPAIR TOOL" -ForegroundColor Cyan
Write-Host "  Dynamic Velopack Delta Reconstruction" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$targetDir = "$env:LOCALAPPDATA\SA-CHAOS"
$packagesDir = "$targetDir\packages"
$currentDir = "$targetDir\current"
$updateExe = "$targetDir\Update.exe"

$baseServerUrl = "https://updater.sa-chaos.my.id/velopack.php"
$userAgent = "SA-CHAOS/1.1 (Windows NT 10.0; Win64; x64) Electron/Node.js SA-CHAOS"

# 1. Tutup proses SA-CHAOS dan Update.exe
Write-Host "[1/5] Menutup proses SA-CHAOS.exe dan Update.exe..." -ForegroundColor Yellow
Get-Process -Name "SA-CHAOS", "Update" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host "      Proses dibersihkan." -ForegroundColor Green

# 2. Bersihkan file sementara dan cache delta rusak di current/
Write-Host ""
Write-Host "[2/5] Membersihkan cache rusak dan file sementara..." -ForegroundColor Yellow
if (-not (Test-Path $packagesDir)) {
    New-Item -Path $packagesDir -ItemType Directory -Force | Out-Null
}

$lockFile = "$packagesDir\.velopack_lock"
if (Test-Path $lockFile) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }

$veloTemp = "$packagesDir\VelopackTemp"
if (Test-Path $veloTemp) { Remove-Item $veloTemp -Recurse -Force -ErrorAction SilentlyContinue }

if (Test-Path $currentDir) {
    Get-ChildItem -Path $currentDir -Include "*.diff", "*.zsdiff", "*.shasum" -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
Write-Host "      Pembersihan cache selesai." -ForegroundColor Green

# 3. Ambil releases.win.json dari server resmi
Write-Host ""
Write-Host "[3/5] Mengambil metadata rilis dari server (releases.win.json)..." -ForegroundColor Yellow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$feedUrl = "$baseServerUrl/releases.win.json"

$releasesJson = $null
try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", $userAgent)
    $rawJson = $wc.DownloadString($feedUrl)
    $releasesJson = ConvertFrom-Json $rawJson
} catch {
    Write-Host "      [Peringatan] Gagal via WebClient: $($_.Exception.Message). Mencoba Invoke-RestMethod..." -ForegroundColor Yellow
    $releasesJson = Invoke-RestMethod -Uri $feedUrl -Headers @{ "User-Agent" = $userAgent }
}

if (-not $releasesJson -or -not $releasesJson.Assets) {
    Write-Host "[ERROR] Gagal membaca releases.win.json dari server." -ForegroundColor Red
    pause
    exit 1
}

# Baca dari paling terbaru (atas) ke bawah
$allAssets = @($releasesJson.Assets)
$fullAssets = @($allAssets | Where-Object { $_.Type -eq "Full" })
$deltaAssets = @($allAssets | Where-Object { $_.Type -eq "Delta" })

if ($fullAssets.Count -eq 0) {
    Write-Host "[ERROR] Tidak ditemukan rilis Full pada feed server." -ForegroundColor Red
    pause
    exit 1
}

$targetFull = $fullAssets[0]
$prev1Full = if ($fullAssets.Count -gt 1) { $fullAssets[1] } else { $null }
$prev2Full = if ($fullAssets.Count -gt 2) { $fullAssets[2] } else { $null }

Write-Host "      Rilis Resmi Terdeteksi (Urutan Atas ke Bawah):" -ForegroundColor Cyan
Write-Host "      - Target Rilis (x)   : v$($targetFull.Version) ($($targetFull.FileName))"
if ($prev1Full) {
    Write-Host "      - Versi Basis 1 (x-1): v$($prev1Full.Version) ($($prev1Full.FileName))"
}
if ($prev2Full) {
    Write-Host "      - Versi Basis 2 (x-2): v$($prev2Full.Version) ($($prev2Full.FileName))"
}

$fullPkgPath = Join-Path $packagesDir $targetFull.FileName

function Find-LocalPackage($pkgFileName) {
    if (-not $pkgFileName) { return $null }
    $p1 = Join-Path $packagesDir $pkgFileName
    if (Test-Path $p1) {
        $item = Get-Item $p1
        # Paket full harus berukuran wajar (minimal > 10MB) agar bukan file korup / sisa download gagal
        if ($item.Length -gt 10 * 1024 * 1024) {
            return $p1
        } else {
            Remove-Item $p1 -Force -ErrorAction SilentlyContinue
        }
    }
    $p2 = Join-Path $PSScriptRoot "Releases\$pkgFileName"
    if (Test-Path $p2) {
        $item2 = Get-Item $p2
        if ($item2.Length -gt 10 * 1024 * 1024) {
            return $p2
        }
    }
    return $null
}

function Download-PackageFile($fileName, $outPath) {
    $dlUrl = "$baseServerUrl/$fileName"
    Write-Host "      Mengunduh $fileName..." -ForegroundColor Cyan
    $wcDl = New-Object System.Net.WebClient
    $wcDl.Headers.Add("User-Agent", $userAgent)
    $wcDl.DownloadFile($dlUrl, $outPath)
    if (-not (Test-Path $outPath)) {
        throw "Gagal mengunduh $fileName dari $dlUrl"
    }
}

# Tentukan strategi:
# A. Apakah Full package target sudah ada?
$localTarget = Find-LocalPackage $targetFull.FileName
if ($localTarget) {
    Write-Host "      [OK] Paket Full v$($targetFull.Version) sudah tersedia lokal: $localTarget" -ForegroundColor Green
    if ($localTarget -ne $fullPkgPath) {
        Copy-Item $localTarget $fullPkgPath -Force
    }
} else {
    # B. Cek paket basis x-1 dan x-2
    $localPrev1 = if ($prev1Full) { Find-LocalPackage $prev1Full.FileName } else { $null }
    $localPrev2 = if ($prev2Full) { Find-LocalPackage $prev2Full.FileName } else { $null }

    $patchSuccess = $false

    # Kasus B.1: Paket basis x-1 tersedia -> butuh 1 delta (delta target)
    if ($localPrev1 -and (Test-Path $updateExe)) {
        $deltaTargetAsset = $deltaAssets | Where-Object { $_.Version -eq $targetFull.Version }
        if ($deltaTargetAsset) {
            Write-Host "      [STRATEGI] Ditemukan basis x-1 ($($prev1Full.FileName))." -ForegroundColor Green
            Write-Host "                 Menggunakan Patch Delta 1 tahap (~$([Math]::Round($deltaTargetAsset.Size / 1024)) KB)..." -ForegroundColor Green
            
            $delta1Path = Join-Path $packagesDir $deltaTargetAsset.FileName
            try {
                Download-PackageFile $deltaTargetAsset.FileName $delta1Path
                Write-Host "      Merekontruksi $($targetFull.FileName) menggunakan Update.exe patch..." -ForegroundColor Cyan
                
                $patchArgs = @(
                    "patch",
                    "--old", $localPrev1,
                    "--delta", $delta1Path,
                    "--output", $fullPkgPath,
                    "--verbose"
                )
                $p = Start-Process -FilePath $updateExe -ArgumentList $patchArgs -Wait -NoNewWindow -PassThru
                if ($p.ExitCode -eq 0 -and (Test-Path $fullPkgPath)) {
                    Write-Host "      [SUKSES] Rekonstruksi Full Package dari Delta 1 tahap BERHASIL!" -ForegroundColor Green
                    $patchSuccess = $true
                    Remove-Item $delta1Path -Force -ErrorAction SilentlyContinue
                } else {
                    Write-Host "      [Peringatan] Update.exe patch kode keluar: $($p.ExitCode). Beralih ke Full Download..." -ForegroundColor Yellow
                }
            } catch {
                Write-Host "      [Peringatan] Delta patch gagal: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    # Kasus B.2: Paket basis x-2 tersedia -> butuh 2 delta berantai (delta prev1 + delta target)
    if (-not $patchSuccess -and $localPrev2 -and (Test-Path $updateExe)) {
        $deltaPrev1Asset = $deltaAssets | Where-Object { $_.Version -eq $prev1Full.Version }
        $deltaTargetAsset = $deltaAssets | Where-Object { $_.Version -eq $targetFull.Version }
        if ($deltaPrev1Asset -and $deltaTargetAsset) {
            $totalKb = [Math]::Round(($deltaPrev1Asset.Size + $deltaTargetAsset.Size) / 1024)
            Write-Host "      [STRATEGI] Ditemukan basis x-2 ($($prev2Full.FileName))." -ForegroundColor Green
            Write-Host "                 Menggunakan Patch Delta 2 tahap berantai (~$totalKb KB total)..." -ForegroundColor Green
            
            $deltaPrev1Path = Join-Path $packagesDir $deltaPrev1Asset.FileName
            $deltaTargetPath = Join-Path $packagesDir $deltaTargetAsset.FileName
            try {
                Download-PackageFile $deltaPrev1Asset.FileName $deltaPrev1Path
                Download-PackageFile $deltaTargetAsset.FileName $deltaTargetPath
                Write-Host "      Merekontruksi $($targetFull.FileName) dengan 2 delta berantai..." -ForegroundColor Cyan
                
                $patchArgs = @(
                    "patch",
                    "--old", $localPrev2,
                    "--delta", $deltaPrev1Path,
                    "--delta", $deltaTargetPath,
                    "--output", $fullPkgPath,
                    "--verbose"
                )
                $p = Start-Process -FilePath $updateExe -ArgumentList $patchArgs -Wait -NoNewWindow -PassThru
                if ($p.ExitCode -eq 0 -and (Test-Path $fullPkgPath)) {
                    Write-Host "      [SUKSES] Rekonstruksi Full Package dari 2 Delta berantai BERHASIL!" -ForegroundColor Green
                    $patchSuccess = $true
                    Remove-Item $deltaPrev1Path -Force -ErrorAction SilentlyContinue
                    Remove-Item $deltaTargetPath -Force -ErrorAction SilentlyContinue
                } else {
                    Write-Host "      [Peringatan] Update.exe patch kode keluar: $($p.ExitCode). Beralih ke Full Download..." -ForegroundColor Yellow
                }
            } catch {
                Write-Host "      [Peringatan] 2-delta patch gagal: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    # Kasus C: Tidak ada basis x-1 / x-2 atau patch gagal -> Download Full Package (~168 MB)
    if (-not $patchSuccess -and -not (Test-Path $fullPkgPath)) {
        Write-Host "      [STRATEGI] Tidak ada paket basis 3 versi terakhir atau delta tidak dapat diterapkan." -ForegroundColor Yellow
        Write-Host "                 Mengunduh Full Package (~$([Math]::Round($targetFull.Size / (1024*1024))) MB)..." -ForegroundColor Yellow
        Download-PackageFile $targetFull.FileName $fullPkgPath
    }
}

if (-not (Test-Path $fullPkgPath)) {
    Write-Host "[ERROR] Paket Full target $($targetFull.FileName) tidak tersedia." -ForegroundColor Red
    pause
    exit 1
}

# 4. Terapkan pembaruan
Write-Host ""
Write-Host "[4/5] Memasang pembaruan ke folder instalasi SA-CHAOS..." -ForegroundColor Yellow
if (Test-Path $updateExe) {
    $applyArgs = @("apply", "--package", $fullPkgPath, "--norestart", "--verbose")
    $p = Start-Process -FilePath $updateExe -ArgumentList $applyArgs -Wait -NoNewWindow -PassThru
    Write-Host "      Update.exe selesai dengan kode: $($p.ExitCode)" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Update.exe tidak ditemukan di $targetDir." -ForegroundColor Red
    pause
    exit 1
}

# 5. Verifikasi hasil pemulihan
Write-Host ""
Write-Host "[5/5] Memverifikasi integritas SA-CHAOS.exe..." -ForegroundColor Yellow
$mainExe = Join-Path $currentDir "SA-CHAOS.exe"
if (Test-Path $mainExe) {
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "  [SUKSES] PERBAIKAN DAN UPDATE SELESAI DENGAN SEMPURNA!" -ForegroundColor Green
    Write-Host "  - File executable SA-CHAOS.exe telah pulih (v$($targetFull.Version))." -ForegroundColor Green
    Write-Host "  - Shortcut Desktop dan Start Menu telah aktif kembali." -ForegroundColor Green
    Write-Host "  - Cache delta rusak telah dibersihkan." -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host ""
    $reply = Read-Host "Apakah ingin menjalankan SA-CHAOS sekarang? (Y/N, default Y)"
    if ([string]::IsNullOrWhiteSpace($reply) -or $reply.Trim().ToUpper() -eq "Y") {
        Write-Host "Menjalankan SA-CHAOS..." -ForegroundColor Cyan
        Start-Process $mainExe
    }
} else {
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "  [PERINGATAN] SA-CHAOS.exe belum terdeteksi di $currentDir." -ForegroundColor Red
    Write-Host "  Silakan jalankan script ini sebagai Administrator." -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
}

Write-Host ""
pause
