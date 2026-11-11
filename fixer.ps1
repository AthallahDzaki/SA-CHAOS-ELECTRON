<#
.SYNOPSIS
    SA-CHAOS Bootstrap & Integrity Verifier
    Core Script URL: https://is3.cloudhost.id/sa-chaos/fixer-script.ps1
#>

[CmdletBinding()]
param(
    [string]$BaseS3Url = "https://is3.cloudhost.id/sa-chaos",
    [string]$TargetVer = "latest"
)

$ErrorActionPreference = "Stop"
$global:ProgressPreference = 'SilentlyContinue'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

$cb = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$headers = @{
    "User-Agent"    = "SA-CHAOS-Verifier/1.1 (Windows NT 10.0; Win64; x64)"
    "Cache-Control" = "no-cache, no-store, must-revalidate"
    "Pragma"        = "no-cache"
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   SA-CHAOS SECURITY BOOTSTRAP & INTEGRITY VERIFIER     " -ForegroundColor Yellow
Write-Host "========================================================`n" -ForegroundColor Cyan

# Endpoint fixer-script & checksum di root bucket S3
$scriptUrl = "$BaseS3Url/fixer-script.ps1?_cb=$cb"
$hashUrl   = "$BaseS3Url/fixer-script.ps1.sha256?_cb=$cb"

$tempFile = Join-Path $env:TEMP "sa_chaos_fixer_$cb.ps1"

try {
    Write-Host "[1/3] Mengambil signature SHA-256 resmi dari S3..." -ForegroundColor Gray
    $rawHashResponse = Invoke-RestMethod -Uri $hashUrl -Headers $headers -UseBasicParsing
    
    if ($rawHashResponse -match "([A-Fa-f0-9]{64})") {
        $expectedHash = $Matches[1].ToUpper()
    } else {
        throw "Format file fixer-script.ps1.sha256 tidak valid."
    }

    Write-Host "[2/3] Mengunduh core repair script..." -ForegroundColor Gray
    Invoke-WebRequest -Uri $scriptUrl -OutFile $tempFile -Headers $headers -UseBasicParsing

    Write-Host "[3/3] Memverifikasi integritas payload..." -ForegroundColor Gray
    $actualHash = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash.ToUpper()

    if ($actualHash -ne $expectedHash) {
        Write-Host "`n[FATAL] CHECKSUM MISMATCH!" -ForegroundColor Red
        Write-Host "Expected : $expectedHash" -ForegroundColor Red
        Write-Host "Actual   : $actualHash" -ForegroundColor Red
        Write-Host "Payload berpotensi korup atau dimodifikasi oleh pihak ketiga. Dibatalkan!`n" -ForegroundColor Red
        exit 1
    }

    Write-Host "       [OK] Signature valid ($actualHash). Menjalankan script...`n" -ForegroundColor Green

    # Eksekusi core script dengan parameter target version
    & $tempFile -TargetVer $TargetVer

} catch {
    Write-Host "`n[ERROR] Gagal memuat bootstrap: $_" -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path $tempFile) {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }
}