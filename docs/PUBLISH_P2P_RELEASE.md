# Panduan Publikasi Rilis Hybrid (Laptop Developer -> S3 Resmi + Sidecar P2P + VPS Seeder)

Dokumen ini menjelaskan langkah demi langkah untuk membangun paket update `SA-CHAOS` di laptop developer Windows, mempublikasikan rilis utama ke CloudHost S3 seperti biasa, lalu secara opsional menandatangani sidecar `SignedP2PReleaseIndex` dan mengunggah paket ke VPS Ubuntu seeder.

> **PRINSIP UTAMA:** Publikasi ke S3 adalah jalur wajib utama. Langkah penandatanganan sidecar P2P dan upload SCP ke VPS bersifat **opsional dan non-blocking**: apabila VPS sedang mati atau upload SCP gagal, rilis S3 tetap sukses dan seluruh pengguna tetap mendapatkan update.

---

## 1. Persiapan Kunci Penandatangan Ed25519 (Satu Kali di Laptop Developer)

Jangan pernah menyimpan kunci privat di dalam repository git atau menyalinnya ke VPS/klien. Simpan kunci privat di luar repo, misalnya di `%USERPROFILE%\.sa-chaos-keys\publisher-ed25519-private.pem`.

Untuk membuat pasangan kunci Ed25519 baru menggunakan CLI yang telah disediakan:

```powershell
cd c:\SA-Chaos\SA-CHAOS-ELECTRON
node scripts/publish-p2p-release.js --generate-keys --key-dir "$env:USERPROFILE\.sa-chaos-keys" --key-id "publisher-2026"
```

Perintah tersebut akan menghasilkan:
1. `%USERPROFILE%\.sa-chaos-keys\publisher-ed25519-private.pem` (**RAHASIA — JANGAN DI-COMMIT / JANGAN DIKIRIM KE VPS**)
2. `%USERPROFILE%\.sa-chaos-keys\publisher-ed25519-public.pem` (Kunci publik yang di-pin di `main/server/p2p/signed-release-index.js` dan disalin ke VPS).

---

## 2. Alur Build & Deploy Standar + P2P Sidecar

### Langkah 1: Build & Pack Velopack (`build.bat`)
Proses build tidak berubah sama sekali. Paket `.nupkg` yang digunakan oleh S3 dan P2P adalah **file yang sama persis** (byte-identical):

```powershell
cd c:\SA-Chaos\SA-CHAOS-ELECTRON
.\build.bat
```
Hasil build tersimpan di `c:\SA-Chaos\SA-CHAOS-ELECTRON\Releases\`:
- `releases.win.json`
- `RELEASES`
- `SA-CHAOS-<version>-full.nupkg`
- `SA-CHAOS-<version>-delta.nupkg`
- `SA-CHAOS-win-Setup.exe`

### Langkah 2: Buat & Tandatangani Sidecar P2P (`p2p-index.win.json` & `p2p-index.win.sig`)
Jalankan `scripts/publish-p2p-release.js` untuk membaca `Releases/releases.win.json`, menghitung SHA-256 per-chunk (`4 MiB`) dan whole-file atas `SA-CHAOS-<version>-full.nupkg`, lalu menghasilkan sidecar deterministik (RFC 8785) yang ditandatangani Ed25519:

```powershell
node scripts/publish-p2p-release.js `
  --releases-dir ./Releases `
  --private-key "$env:USERPROFILE\.sa-chaos-keys\publisher-ed25519-private.pem" `
  --key-id "publisher-2026"
```

File yang dihasilkan di dalam `./Releases`:
- `Releases/p2p-index.win.json`
- `Releases/p2p-index.win.sig`

*(File `releases.win.json` dan `*-full.nupkg` sama sekali tidak dimodifikasi).*

### Langkah 3: Publikasi ke S3 + Opsional Upload ke VPS (`deploy.bat`)
`deploy.bat` tetap menjalankan `aws s3 cp Releases/ s3://sa-chaos/desktop/updates/ --recursive` ke `https://is3.cloudhost.id` seperti sebelumnya, lalu memanggil `scripts/publish-p2p-release.js` dalam mode non-fatal (jika langkah P2P dilewati atau gagal, `deploy.bat` tetap keluar dengan sukses selama upload S3 berhasil).

Untuk mengunggah sidecar ke S3 dan sekaligus menyalin paket ke VPS Ubuntu via SSH/SCP + verifikasi SHA-256 jarak jauh + reload service seeder:

```powershell
node scripts/publish-p2p-release.js `
  --releases-dir ./Releases `
  --private-key "$env:USERPROFILE\.sa-chaos-keys\publisher-ed25519-private.pem" `
  --key-id "publisher-2026" `
  --upload-s3 `
  --vps-host "decentra@<ALAMAT_IP_ATAU_DOMAIN_VPS>" `
  --vps-ssh-key "$env:USERPROFILE\.ssh\id_ed25519" `
  --vps-releases-dir "/var/lib/decentraupdate/releases"
```

Apa yang dilakukan opsi `--vps-host`:
1. Mengunggah `SA-CHAOS-<version>-full.nupkg`, `p2p-index.win.json`, dan `p2p-index.win.sig` ke direktori staging sementara di VPS via `scp`.
2. Menjalankan `sha256sum` di VPS via `ssh` dan memastikan digest SHA-256 di VPS sama persis dengan digest lokal.
3. Memindahkan file secara atomik ke `/var/lib/decentraupdate/releases/`.
4. Meminta daemon seeder memuat ulang indeks rilis (`systemctl reload-or-restart decentraupdate-seeder.service` atau sinyal `SIGHUP`).
5. Apabila koneksi SSH/SCP gagal, skrip mencetak `[P2P Publish Warning]` dan keluar dengan kode `0` agar tidak pernah menggagalkan rilis S3.
