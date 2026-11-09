# Rencana Implementasi (Implementation Plan) — DecentraUpdate Public Alpha

Dokumen ini mencatat hasil audit baseline repository `SA-CHAOS` serta tahapan implementasi fitur `Updater with Peer-To-Peer System`.

---

## 1. Hasil Audit Repository (Phase 0 Baseline)

| Aspek | Temuan Aktual di Repository |
|---|---|
| Aplikasi Electron | `c:\SA-Chaos\SA-CHAOS-ELECTRON` (`sa-chaos-desktop` v1.0.62, ESM `"type": "module"`, Electron `^43.1.1`, Node.js `v26.4.0`) |
| UI Konfigurasi | `c:\SA-Chaos\SA-CHAOS-CONFIG` (Next.js 16 static export `output: 'export'` ke `../SA-CHAOS-ELECTRON/renderer`) |
| Paket Velopack | `velopack: ^0.0.89` (`Vfusion.exe` 0.0.89), diinisialisasi di `main/index.js` melalui `VelopackApp.build().run()` |
| S3 Updater Saat Ini | `main/server/updater.js` fungsi `runVelopackUpdater(currentVersion, appName, onProgress, onComplete)` menggunakan `https://updater.sa-chaos.my.id/velopack.php/` |
| Penyimpanan S3 | CloudHost S3 (`https://is3.cloudhost.id`, bucket `sa-chaos`, prefix `desktop/updates/`) melalui `deploy.bat` |
| Konfigurasi Lokal | `main/server/shared.js` mengenkripsi konfigurasi dengan AES-256-CBC ke `%APPDATA%\SA-CHAOS\data\config.json` (`GeneralConfig`) |
| Bridge IPC & HTTP | Renderer berkomunikasi lewat `main/preload.cjs` (`window.electronAPI`) + `main/ipc-handlers.js` serta Express server lokal port `9001` di `main/server/local-config.js` |
| Bundler / Build | `npm run prebuild:win` menjalankan `javascript-obfuscator ./main --output ./obfuscated-main` lalu `electron-builder` dan `vpk pack` |

---

## 2. Tahapan Pekerjaan

### Phase 1 — Dokumentasi Desain & Keamanan (`docs/`)
- `docs/PRD.md`: Spesifikasi produk lengkap.
- `docs/ARCHITECTURE.md`: Diagram arsitektur, sequence diagram S3 vs P2P + fallback, dan state machine.
- `docs/P2P_PROTOCOL.md` & `docs/PROTOCOL.md`: Kontrak `SignedP2PReleaseIndex` (RFC 8785 Canonical JSON + Ed25519) dan protokol wire `/decentraupdate/package/1.0.0` serta `/decentraupdate/peers/1.0.0`.
- `docs/SECURITY_THREAT_MODEL.md` & `docs/THREAT_MODEL.md`: Analisis ancaman keamanan dan mitigasi.
- `docs/VPS_UBUNTU_SEEDER.md`: Panduan setup daemon seeder dual-stack (`0.0.0.0` + `::`) di Ubuntu VPS dengan `systemd` non-root.
- `docs/PUBLISH_P2P_RELEASE.md`: Panduan workflow rilis dari laptop developer ke S3 dan VPS.

### Phase 2 — Modul Backend P2P Terisolasi (`main/server/p2p/`)
- `main/server/p2p/canonical-json.js`: Serialisasi deterministik sesuai RFC 8785 (JCS).
- `main/server/p2p/signed-release-index.js`: Pembuatan dan verifikasi `SignedP2PReleaseIndex` dengan Ed25519, key pinning, key rotation, anti-rollback (`sequence`), expiry check, dan validasi nama file/hash.
- `main/server/p2p/verified-cache.js`: Cache terverifikasi dengan staging `.part`, bitmap resume, verifikasi SHA-256 per-chunk & whole-file, atomic rename, kuota penyimpanan (`maxCacheBytes`), dan pencegahan path traversal/symlink.
- `main/server/p2p/p2p-node.js`: Node P2P dual-stack TCP (`[::]` IPv6 + `0.0.0.0` IPv4), identitas `PeerId` Ed25519 (`12D3KooW...`), enkripsi stream terotentikasi (X25519 ECDH + HKDF-SHA256 + AES-256-GCM) di atas `/multistream/1.0.0`, negosiasi protokol `/decentraupdate/package/1.0.0` dan `/decentraupdate/peers/1.0.0`, dialer *Happy Eyeballs* IPv6-first, Peer Exchange (PEX), persisted peer cache, serta rate limiter token-bucket untuk seeder.

### Phase 3 — Integrasi Velopack & Hybrid Orchestrator
- `main/server/p2p/velopack-bridge.js`:
  - `ExistingS3UpdaterAdapter`: Membungkus alur cek, download, dan apply S3 yang sudah ada tanpa mengubah perilaku default.
  - `VelopackLocalSourceAdapter`: Menyiapkan direktori feed lokal Velopack (`releases.win.json` khusus Full asset + `RELEASES` + file `.nupkg` terverifikasi) dan memanggil `UpdateManager` lokal.
- `main/server/p2p/hybrid-orchestrator.js`: Koordinator utama dengan state machine ketat, single-flight lock, telemetry lokal bebas IP mentah, serta kill switch instan.
- `main/server/updater.js`: Menghubungkan `runVelopackUpdater` ke `HybridUpdateOrchestrator` dengan pelindung `try/catch` yang selalu kembali ke S3 jika terjadi error tak terduga.
- `scripts/publish-p2p-release.js` & `vps-seeder/`: CLI penandatangan rilis P2P + opsional upload SCP ke VPS, serta daemon seeder Ubuntu VPS.

### Phase 4 — Integrasi UI Menu General Config (`SA-CHAOS-CONFIG` & `SA-CHAOS-ELECTRON`)
- Menambahkan field konfigurasi P2P (`p2pUpdaterEnabled`, `p2pUpdaterConsentAccepted`, `p2pSeedingEnabled`, `p2pMaxUploadKBps`, `p2pMaxCacheMB`, `p2pBootstrapMultiaddrs`) di `main/server/shared.js`.
- Menambahkan endpoint di `main/server/local-config.js` dan channel IPC di `main/ipc-handlers.js` + `main/preload.cjs`.
- Memperbarui `src/app/general-config/page.js` (V1) dan `src/app/v2/general-config/page.js` (V2) dengan label persis `Updater with Peer-To-Peer System`, ikon info `ⓘ`, modal `Tentang P2P Updater (Alpha)`, modal persetujuan pertama kali, toggle terpisah `Share downloaded updates with other users`, serta indikator status sumber download secara real-time.

### Phase 5 — Pengujian Menyeluruh & Laporan (`test/` & `docs/TEST_REPORT.md`)
- Menjalankan test otomatis (`node --test`) yang mencakup regresi S3, tanda tangan manifest, transfer IPv6 & IPv4, transfer langsung Peer A -> Peer B saat VPS mati, injeksi kegagalan/korupsi chunk, dan konsistensi konfigurasi.
