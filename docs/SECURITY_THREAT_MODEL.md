# Model Ancaman Keamanan & Privasi (Security Threat Model) — DecentraUpdate

Dokumen ini menganalisis permukaan serangan (attack surface), ancaman keamanan, privasi pengguna, serta kontrol mitigasi yang diimplementasikan pada sistem hybrid S3 + P2P updater di `SA-CHAOS`.

---

## 1. Asumsi Kepercayaan (Trust Assumptions)

| Entitas | Status Kepercayaan | Penjelasan |
|---|---|---|
| **Kunci Privat Publisher (Ed25519)** | **Trusted (Offline/Developer Laptop)** | Hanya berada di laptop developer / environment rilis; tidak pernah disertakan di kode klien Electron maupun VPS. |
| **Endpoint S3 Resmi (`updater.sa-chaos.my.id`)** | **Authoritative untuk Versi Rilis** | Diakses melalui HTTPS untuk memeriksa `releases.win.json` dan mengunduh fallback standar. |
| **Peer Pengguna Lain (Windows Peers)** | **Untrusted** | Dapat mengirim byte palsu, korup, lambat, atau mencoba memalsukan versi. |
| **VPS Ubuntu Seeder** | **Untrusted untuk Integritas Paket** | Meskipun dikelola developer, klien tetap memverifikasi Ed25519 signature dan SHA-256 setiap chunk dan file utuh yang diterima dari VPS. |
| **Electron Renderer Process** | **Restricted** | Berjalan dengan `contextIsolation: true` dan `nodeIntegration: false`; hanya dapat memanggil kanal IPC tervalidasi. |

---

## 2. Matriks Ancaman & Mitigasi (STRIDE)

### 2.1 Pemalsuan Paket / Malicious Peer (Tampering & Spoofing)
- **Ancaman**: Peer jahat mengirimkan file `.nupkg` berisi malware atau byte yang dimodifikasi.
- **Mitigasi**:
  1. Klien hanya menerima daftar hash dari `SignedP2PReleaseIndex` yang ditandatangani Ed25519 oleh publisher key yang di-pin di klien (`main/server/p2p/signed-release-index.js`).
  2. `sha256` dan `size` pada sidecar wajib cocok 100% dengan `targetFullRelease.SHA256` dan `Size` dari `releases.win.json` S3 resmi.
  3. Setiap chunk (`4 MiB`) diverifikasi terhadap `chunkSha256[i]` sebelum ditulis ke disk.
  4. Setelah seluruh chunk selesai, file utuh dihitung ulang SHA-256-nya sebelum dipindahkan secara atomik ke `verified/` dan diserahkan ke `VelopackLocalSourceAdapter`.

### 2.2 Serangan Rollback & Replay Manifest (Replay / Downgrade Attack)
- **Ancaman**: Penyerang menyajikan `p2p-index.win.json` versi lama yang memiliki kerentanan.
- **Mitigasi**:
  1. Pemilihan versi target **selalu** berasal dari `releases.win.json` di S3 resmi. Sidecar P2P yang memiliki `version` berbeda dari target S3 langsung ditolak.
  2. Field `sequence` monotonik diperiksa terhadap nilai tertinggi yang pernah tercatat di state lokal (`p2p-state.json`).
  3. Field `expiresAt` membatasi masa berlaku sidecar; manifest kedaluwarsa otomatis ditolak dan memicu fallback ke S3.

### 2.3 Path Traversal, Symlink, & Arbitrary File Read/Write
- **Ancaman**: Manifest atau request P2P menyertakan nama file seperti `../../Windows/System32/evil.dll` atau mencoba membaca file sistem dari seeder.
- **Mitigasi**:
  1. Validasi regex ketat `/^[A-Za-z0-9._-]+-full\.nupkg$/` dan `path.basename(filename) === filename`.
  2. `VerifiedCache` memeriksa `fs.lstatSync` untuk menolak symbolic link / junction point.
  3. Protokol `/decentraupdate/package/1.0.0` hanya melayani paket yang terdaftar di dalam `VerifiedCache` allowlist berdasarkan pencocokan `(version, filename, sha256)`, bukan membaca path file dari request.

### 2.4 Denial of Service (DoS), Slowloris, & Memory/Disk Exhaustion
- **Ancaman**: Peer menahan koneksi terbuka tanpa mengirim data (stalling), mengirim chunk berukuran raksasa (memory bomb), atau memenuhi disk pengguna.
- **Mitigasi**:
  1. **Memory Bound**: Ukuran frame maksimum pada protokol dibatasi ketat (`maxChunkSize = 8 MiB`, default chunk `4 MiB`). Frame yang melebihi batas langsung diputus sebelum dialokasikan.
  2. **Timeouts & Speed Floor**: `connectTimeoutMs (8s)`, `firstByteTimeoutMs (10s)`, `idleTimeoutMs (20s)`, dan batas kecepatan minimum (`64 KB/s`); jika melanggar, koneksi P2P dibatalkan dan langsung beralih ke S3.
  3. **Storage Quota**: `VerifiedCache` menerapkan batas kuota (`p2pMaxCacheMB`, default `600 MB`), memeriksa ruang kosong disk, dan membersihkan rilis lama secara otomatis (LRU).
  4. **Upload Rate Limit & Connection Cap**: Seeder membatasi jumlah koneksi peer simultan (`maxConcurrentPeers = 8`) dan kecepatan unggah menggunakan algoritma token-bucket (`p2pMaxUploadKBps`, default `2048 KB/s`).

### 2.5 Privasi Pengguna, Eksposur IP, & Consent Terpisah
- **Ancaman**: Pengguna tidak menyadari bahwa koneksi P2P mengekspos alamat IP publik ke peer lain atau menggunakan bandwidth upload tanpa izin.
- **Mitigasi**:
  1. **Default OFF**: `p2pUpdaterEnabled = false` dan `p2pSeedingEnabled = false` secara default pada seluruh instalasi baru maupun lama.
  2. **Disclosure & Consent Eksplisit**: Saat pertama kali mengaktifkan P2P, pengguna wajib menyetujui dialog informasi yang menjelaskan eksposur IP publik, penggunaan jaringan, dan fallback S3.
  3. **Seeding Consent Terpisah**: Mengaktifkan download P2P **tidak pernah** mengaktifkan seeding (`Share downloaded updates with other users`). Seeding membutuhkan toggle kedua yang terpisah dan langsung berhenti saat aplikasi ditutup atau saat toggle utama dimatikan.
  4. **Redaksi Log**: Log aplikasi dan metrik telemetry lokal (`p2p-telemetry.json`) menyamarkan alamat IP peer secara default (mis. `2001:db8::*` atau `203.0.113.*`) dan tidak pernah mencatat kredensial/secret.

### 2.6 Keamanan Electron IPC & Renderer
- **Ancaman**: Skrip di renderer mencoba memanggil API jaringan internal atau mengubah konfigurasi secara tidak sah.
- **Mitigasi**:
  1. `main/index.js` menjaga `contextIsolation: true` dan `nodeIntegration: false`.
  2. `main/preload.cjs` hanya mengekspos fungsi spesifik (`getP2PConfig`, `setP2PConfig`, `getP2PStatus`, `cancelP2PDownload`) dengan validasi tipe payload ketat di `main/ipc-handlers.js` dan `main/server/local-config.js`.
