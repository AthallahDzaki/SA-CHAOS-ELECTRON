# PRODUCT REQUIREMENTS DOCUMENT (PRD) — DECENTRAUPDATE
## Public Alpha: Hybrid S3 + IPv6-First P2P Update Delivery untuk Electron + Velopack Node.js

**Versi Dokumen:** 2.0 — 6 November 2026  
**Fase produk:** Public Alpha / opt-in experiment  
**Target Aplikasi:** `SA-CHAOS` Desktop (`c:\SA-Chaos\SA-CHAOS-ELECTRON` & `c:\SA-Chaos\SA-CHAOS-CONFIG`)  
**Prioritas absolut:** Updater S3 yang sudah dipakai aplikasi (`https://updater.sa-chaos.my.id/velopack.php/` di atas bucket CloudHost S3 `sa-chaos`, prefix `desktop/updates/`) **HARUS tetap berfungsi persis seperti sebelumnya**. P2P adalah jalur download tambahan, bukan migrasi dan bukan pengganti S3.

---

## Metadata & Asumsi Implementasi

| Field | Nilai |
|---|---|
| Nama fitur | `Updater with Peer-To-Peer System` |
| Fase | Public Alpha, opt-in; tidak mengganti updater bawaan |
| Platform utama | Windows x64 Electron (`^43.1.1`) installed build dengan `velopack` (`^0.0.89`) |
| Sumber versi resmi | Feed Velopack dari endpoint S3 yang sudah digunakan (`releases.win.json`) |
| Delivery dasar | S3 via updater Velopack existing (`ExistingS3UpdaterAdapter`) |
| Delivery eksperimen | Dual-stack TCP P2P (`js-libp2p` compatible multistream `/decentraupdate/package/1.0.0`), IPv6-first / IPv4 fallback |
| Bootstrap/seeder pertama | VPS Ubuntu milik developer, dengan public IPv4 + global IPv6 |
| Distribusi awal | Laptop Windows -> S3 existing (tetap) + VPS opsional via SSH/SCP |
| Default download P2P | OFF (`p2pUpdaterEnabled = false`) |
| Default seeding pengguna | OFF (`p2pSeedingEnabled = false`), consent terpisah |
| Otoritas keamanan rilis | Publisher signing key (Ed25519 untuk signed P2P sidecar `p2p-index.win.json` + `p2p-index.win.sig`), bukan identitas peer |
| Keputusan migrasi Full P2P | Di luar ruang lingkup PRD dan memerlukan persetujuan baru |

---

## Aturan Non-Negotiable

1. **P2P OFF -> updater S3 existing berjalan normal**, tetap melakukan check/download/install dan menerima rilis berikutnya tanpa membuka socket, discovery, atau seeding P2P.
2. **P2P ON -> check versi tetap dari metadata update resmi di S3; coba transfer paket lewat peer tidak tepercaya yang menyajikan konten terverifikasi secara kriptografis; jika gagal/timeout/tidak ada peer -> fallback otomatis ke S3.**
3. **P2P tidak boleh memblokir, menunda tanpa batas, atau merusak updater S3.** Jika subsystem P2P crash, startup, check, download, dan instalasi S3 tetap bekerja.
4. **Seeding/upload pengguna adalah consent terpisah (default OFF)**. Opt-in P2P download tidak mengaktifkan sharing otomatis.
5. Paket **harus diverifikasi** berdasarkan metadata publisher (Ed25519 signature di atas canonical JSON RFC 8785) dan hash resmi (SHA-256 per-chunk dan whole-file) sebelum diserahkan ke Velopack atau dibagikan ulang.
6. Tidak ada endpoint S3, kredensial cloud, kode updater lama, atau data aplikasi yang boleh dihapus/diganti.
