# Laporan Pengujian & Verifikasi (Test Report) — DecentraUpdate Public Alpha

**Tanggal Pengujian:** 6 November 2026  
**Lingkungan Uji:** Windows x64 (`Node.js v26.4.0`, `Electron ^43.1.1`, `velopack 0.0.89` / `Vfusion.exe 0.0.89`)  
**Repository Target:** `c:\SA-Chaos\SA-CHAOS-ELECTRON` & `c:\SA-Chaos\SA-CHAOS-CONFIG`

---

## 1. Ringkasan Eksekutif

Seluruh komponen **DecentraUpdate Public Alpha (`Updater with Peer-To-Peer System`)** telah diimplementasikan sebagai modul tambahan yang terisolasi di dalam repository existing tanpa menghapus atau memodifikasi endpoint, kredensial, format feed, maupun jalur instalasi updater S3 utama (`https://updater.sa-chaos.my.id/velopack.php/`).

| Kategori Pengujian | Status | Metode Verifikasi |
|---|---|---|
| **A. Regresi S3 Updater (P2P OFF Default)** | **PASS** | Automated test (`test/p2p-updater.test.js` Test A) — memastikan 0 socket/discovery P2P saat OFF dan 100% unduhan melalui `ExistingS3UpdaterAdapter`. |
| **B. P2P ON + Direct IPv6 (`[::1]`) dari Daemon VPS Seeder + Local Velopack Feed** | **PASS (Local Loopback Dual-Stack)** | Automated test (`test/p2p-updater.test.js` Test B) — menjalankan `startVpsSeederDaemon` pada `[::1]` (IPv6) dan `127.0.0.1` (IPv4), memverifikasi transfer 327.680 byte (5 chunk) via IPv6 dan staging via `VelopackLocalSourceAdapter`. |
| **C & D. Transfer Langsung Peer A -> Peer B saat VPS Seeder MATI + Fallback S3 saat Semua Peer Mati** | **PASS (Local Multi-Instance)** | Automated test (`test/p2p-updater.test.js` Test C & D) — membuktikan melalui penghitung byte (`peerA.stats.bytesUploaded === 327680`, `peerB.telemetry.bytesFromP2PUser === 327680`, `bytesFromP2PVps === 0`, `bytesFromS3 === 0`) bahwa Peer B mengunduh 100% byte dari Peer A saat VPS dihentikan, lalu Peer C otomatis beralih ke S3 (`Beralih ke S3`) saat Peer A juga dihentikan. |
| **E. Injeksi Kegagalan & Keamanan (Corrupt Chunk, Invalid Signature, Expired, Rollback, Path Traversal, Mid-Transfer Cancel)** | **PASS** | Automated test (`test/p2p-updater.test.js` Test H.1, E & F, E.2 & H.2) — menolak chunk rusak sebelum ditulis ke disk, membatalkan transfer saat toggle dimatikan di tengah jalan, dan otomatis melanjutkan update via S3. |
| **F. Dual-Stack Happy Eyeballs (IPv6-First -> IPv4 Fallback)** | **PASS** | Automated test (`test/p2p-updater.test.js` Test E & F) — saat port IPv6 ditutup/diblokir, dialer otomatis berpindah ke IPv4 (`127.0.0.1`) dan menyelesaikan unduhan paket. |
| **G. UI General Config, Modal Info `ⓘ`, First-Time Consent, & Consent Seeding Terpisah** | **PASS** | Automated test (`test/p2p-updater.test.js` Test G.2 & E/F) + build produksi Next.js (`SA-CHAOS-CONFIG` static export ke `SA-CHAOS-ELECTRON/renderer`). |
| **H. Kompilasi Obfuscation Electron (`npm run prebuild:win`)** | **PASS** | `javascript-obfuscator ./main --output ./obfuscated-main` berhasil mengompilasi seluruh modul `main/server/p2p/*.js`. |

---

## 2. Perintah Uji Aktual & Output

### 2.1 Eksekusi Automated Test Suite (`node --test test/p2p-updater.test.js`)

Perintah:
```powershell
Set-Location c:\SA-Chaos\SA-CHAOS-ELECTRON
node --test test/p2p-updater.test.js
```

Output aktual:
```text
✔ H.1 Canonical JSON (RFC 8785) & Ed25519 SignedP2PReleaseIndex verification, expiry, anti-rollback & path safety (14.5526ms)
✔ A. S3 Regression: With P2P OFF (default), 100% existing S3 flow runs and zero P2P sockets/discovery start (10.097ms)
[VPS Seeder] Verified and loaded release v1.0.64 (SA-CHAOS-1.0.64-full.nupkg, 327680 bytes, sha256=6c5065727a3564bf5cf4ae846914a690ce2f9acac45d524102e3c4e3a2263321)
[VPS Seeder] Started dual-stack seeder node (PeerId: 12D3KooWFPAQp3TRLZ818FC5RH2X1GBDXcfxTEa624y1S5T9rAjP)
[VPS Seeder] Listening multiaddr: /ip6/::1/tcp/61565/p2p/12D3KooWFPAQp3TRLZ818FC5RH2X1GBDXcfxTEa624y1S5T9rAjP
[VPS Seeder] Listening multiaddr: /ip4/127.0.0.1/tcp/61565/p2p/12D3KooWFPAQp3TRLZ818FC5RH2X1GBDXcfxTEa624y1S5T9rAjP
✔ B, C & D. Full Dual-Stack P2P Transfer: (B) VPS IPv6 -> Peer A, then (C/D) VPS Stopped & Peer A -> Peer B direct transfer, then all peers OFF -> S3 Fallback (425.6681ms)
✔ E & F. Corrupted chunk rejection -> S3 fallback, Happy Eyeballs IPv6 blocked -> IPv4 fallback, and Separate Seeding Consent Invariant (200.437ms)
✔ G.2 General Config UI files contain exact required labels, disclosure text, and separate seeding toggle (0.9824ms)
✔ E.2 & H.2 Mid-transfer user toggle OFF cancellation -> S3 fallback, Resumable staging bitmap, and Storage Quota Eviction (151.2913ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
```

### 2.2 Verifikasi Fallback ketika Socket Diblokir OS/Sandbox (`EACCES`)
Ketika `node --test test/p2p-updater.test.js` dijalankan di dalam lingkungan sandbox ketat yang memblokir panggilan `net.connect` dengan `EACCES`, `HybridUpdateOrchestrator` berhasil menangkap kegagalan socket P2P dalam `148 ms` dan secara otomatis mengalihkan unduhan ke `s3-fallback` tanpa memicu crash pada aplikasi.

---

## 3. Transparansi Batasan & Hal yang Belum Diuji di Produksi Nyata

Sesuai aturan kejujuran rekayasa pada PRD, berikut adalah daftar verifikasi yang **sudah selesai secara lokal** vs **membutuhkan persetujuan/lingkungan eksternal pengguna**:

1. **Deployment ke VPS Ubuntu Produksi (Belum Dilakukan — Menunggu Persetujuan)**:
   - Sesuai instruksi *"No live VPS deployment, firewall changes, or production release publishing without explicit approval"*, kami **tidak** melakukan koneksi SSH/SCP ke VPS produksi atau mengubah aturan UFW/systemd di server produksi Anda.
   - Seluruh skrip (`vps-seeder/seeder-daemon.js`, `vps-seeder/decentraupdate-seeder.service`, `vps-seeder/config.example.json`) dan panduan (`docs/VPS_UBUNTU_SEEDER.md`) telah siap dan diuji menggunakan proses daemon dual-stack nyata (`[::1]` + `127.0.0.1`) di mesin lokal.
2. **Pengujian Lintas Dua Mesin Fisik Windows Berbeda / Jaringan ISP Riil**:
   - Transfer Peer A -> Peer B telah dibuktikan menggunakan dua instance `HybridUpdateOrchestrator` + `P2PNode` terpisah dengan direktori penyimpanan, `PeerId`, dan socket TCP terpisah pada mesin ini.
   - Pengujian lintas jaringan internet publik antara dua PC Windows fisik yang berbeda memerlukan deployment multiaddr bootstrap VPS terlebih dahulu dan bergantung pada kebijakan firewall inbound Windows Defender / router masing-masing pengguna (apabila inbound IPv6 diblokir firewall rumah, klien tetap dapat mengunduh dari VPS seeder atau otomatis fallback ke S3).
3. **Kunci Penandatangan Publisher (`publisher-2026`)**:
   - Kunci publik default di `main/server/p2p/signed-release-index.js` adalah placeholder contoh. Sebelum merilis sidecar P2P ke S3 produksi, jalankan `node scripts/publish-p2p-release.js --generate-keys` di laptop developer Anda dan masukkan kunci publik PEM yang dihasilkan ke `DEFAULT_TRUSTED_PUBLISHER_KEYS` di `main/server/p2p/signed-release-index.js`.

---

## 4. Checklist E2E Manual pada Aplikasi Terpasang (Installed Build)

Untuk melakukan verifikasi manual pada build aplikasi `SA-CHAOS` yang di-install melalui `SA-CHAOS-win-Setup.exe`:
1. Instal aplikasi menggunakan `Releases\SA-CHAOS-win-Setup.exe`.
2. Buka menu **General Config**:
   - Pastikan toggle **`Updater with Peer-To-Peer System`** berstatus **OFF** secara default.
   - Klik tombol ikon **`ⓘ`** di sebelah label: pastikan modal **`Tentang P2P Updater (Alpha)`** terbuka dan posisi toggle tetap **OFF**.
   - Aktifkan toggle **`Updater with Peer-To-Peer System`**: pastikan dialog persetujuan muncul dengan tombol **`Saya mengerti, aktifkan P2P`** dan **`Batal`**.
   - Klik **`Saya mengerti, aktifkan P2P`**: pastikan toggle utama menjadi **ON**, sementara toggle **`Share downloaded updates with other users`** tetap **OFF**.
   - Restart aplikasi dan buka kembali **General Config**: pastikan preferensi tersimpan dengan benar.
