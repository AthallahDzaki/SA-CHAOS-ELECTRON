# Spesifikasi Protokol P2P & Signed Release Index (`SignedP2PReleaseIndex`)

Dokumen ini mendefinisikan format metadata terotorisasi publisher (`SignedP2PReleaseIndex`), aturan kanonisasi dan tanda tangan Ed25519, serta protokol jaringan P2P (`/decentraupdate/package/1.0.0` dan `/decentraupdate/peers/1.0.0`).

---

## 1. Format `SignedP2PReleaseIndex` (`p2p-index.win.json`)

File sidecar `p2p-index.win.json` dan tanda tangannya `p2p-index.win.sig` dipublikasikan ke lokasi S3 yang sama dengan `releases.win.json` (`https://updater.sa-chaos.my.id/velopack.php/p2p-index.win.json`) tanpa mengubah sedikit pun struktur `releases.win.json`.

### Contoh Skema JSON
```json
{
  "schemaVersion": 1,
  "appId": "SA-CHAOS",
  "platform": "win",
  "arch": "x64",
  "channel": "win",
  "version": "1.0.62",
  "sequence": 10062,
  "issuedAt": "2026-11-06T12:00:00Z",
  "expiresAt": "2026-11-20T12:00:00Z",
  "assets": [
    {
      "filename": "SA-CHAOS-1.0.62-full.nupkg",
      "type": "Full",
      "size": 169100129,
      "sha1": "08F895C48747CB9BC6D372AAE1C9D2E5D711FAA0",
      "sha256": "ee488daf3ea7630a1df05b381160bd8a7a64d3d0037422c729bca5e478ecd275",
      "chunkSize": 4194304,
      "chunkSha256": [
        "a1b2c3d4...",
        "e5f6a7b8..."
      ]
    }
  ],
  "signingKeyId": "publisher-2026"
}
```

### Aturan Kanonisasi & Penandatanganan (RFC 8785 + Ed25519)
1. **Canonical JSON (RFC 8785 / JCS)**:
   - Sebelum ditandatangani atau diverifikasi, objek JSON diserialisasi secara deterministik: seluruh key objek diurutkan secara leksikografis UTF-16 code unit, tanpa spasi/newline tambahan, dan string/angka diformat sesuai standar ECMAScript JSON.
2. **Tanda Tangan Ed25519**:
   - Byte UTF-8 dari Canonical JSON ditandatangani menggunakan algoritma `Ed25519` (`crypto.sign(null, Buffer.from(canonicalJson, 'utf8'), privateKey)`).
   - File `p2p-index.win.sig` menyimpan signature dalam format Base64 (atau JSON `{ "signingKeyId": "publisher-2026", "signature": "<base64>" }`).
3. **Verifikasi Ketat di Klien & Seeder**:
   - `signingKeyId` harus ada dalam peta `TRUSTED_PUBLISHER_KEYS` yang di-pin di aplikasi (mendukung rotasi kunci).
   - `schemaVersion === 1`, `appId === "SA-CHAOS"`, `platform === "win"`, `arch === "x64"`, `channel === "win"`.
   - `version` harus **sama persis** dengan versi `targetFullRelease.Version` yang dipilih oleh `UpdateManager` dari `releases.win.json` S3.
   - `sequence` harus `>= highestSeenSequence` yang disimpan secara lokal (anti-rollback).
   - Waktu saat ini harus berada di antara `issuedAt` (dengan toleransi clock skew 5 menit) dan `expiresAt`.
   - `filename` harus lolos regex basename ketat `/^[A-Za-z0-9._-]+-full\.nupkg$/` (tanpa `/`, `\`, `..`, atau karakter kontrol).
   - `size` dan `sha256` (case-insensitive hex 64 karakter) harus **identik** dengan `Size` dan `SHA256` pada `releases.win.json` S3.
   - Jumlah elemen `chunkSha256` harus sama dengan `Math.ceil(size / chunkSize)`.

---

## 2. Identitas Peer & Multiaddr Dual-Stack

Setiap node P2P (baik VPS seeder maupun klien Electron) memiliki pasangan kunci identitas Ed25519 yang dikodekan sebagai libp2p `PeerId` standar (`12D3KooW...`, Base58btc atas protobuf/multihash kunci publik Ed25519 32-byte).

Format alamat yang diiklankan dan didukung:
- **IPv6**: `/ip6/<alamat-ipv6>/tcp/<port>/p2p/<PeerId>`
- **IPv4**: `/ip4/<alamat-ipv4>/tcp/<port>/p2p/<PeerId>`

Dialer klien menggunakan algoritma **Happy Eyeballs (IPv6-First)**:
1. Mengelompokkan alamat per peer dengan memprioritaskan alamat `/ip6/...` di urutan pertama dan `/ip4/...` sebagai cadangan.
2. Memulai koneksi ke alamat IPv6 terlebih dahulu; jika dalam `2500 ms` belum tersambung (atau langsung gagal karena jaringan lokal tidak memiliki rute IPv6), segera mencoba alamat IPv4 tanpa menunggu batas timeout penuh.

---

## 3. Lapisan Keamanan Transport & Multistream

Seluruh komunikasi TCP antar-peer berjalan di atas kanal terenkripsi dan terotentikasi:
1. **Handshake Multistream (`/multistream/1.0.0`)**:
   - Memastikan kompatibilitas negosiasi protokol berbasis panjang baris (`varint` / newline-delimited protocol ID).
2. **Enkripsi & Otentikasi Peer (`Noise-inspired X25519 + Ed25519 + AES-256-GCM`)**:
   - Kedua pihak mempertukarkan ephemeral public key `X25519` yang ditandatangani oleh kunci identitas `Ed25519` masing-masing.
   - Klien memverifikasi bahwa kunci publik Ed25519 cocok dengan `PeerId` yang dituju (jika `PeerId` ditentukan pada multiaddr) dan memverifikasi tanda tangan atas kunci ephemeral X25519.
   - Shared secret X25519 diturunkan menggunakan `HKDF-SHA256` menjadi kunci sesi arah-kirim dan arah-terima `AES-256-GCM` dengan penghitung nonce 96-bit monotonik (mencegah replay dan penyadapan paket di jaringan).

---

## 4. Protokol Transfer Paket (`/decentraupdate/package/1.0.0`)

Protokol ini **tidak pernah menerima path file bebas**. Peer hanya boleh meminta chunk berdasarkan `version`, `filename` basename terizinkan, `sha256` paket, dan `chunkIndex`.

### 4.1 Pesan Request `HAVE_MANIFEST` (Cek Ketersediaan Paket)
```json
{
  "op": "HAVE_PACKAGE",
  "appId": "SA-CHAOS",
  "channel": "win",
  "version": "1.0.62",
  "filename": "SA-CHAOS-1.0.62-full.nupkg",
  "sha256": "ee488daf3ea7630a1df05b381160bd8a7a64d3d0037422c729bca5e478ecd275"
}
```
**Response**:
```json
{
  "ok": true,
  "role": "vps-seeder",
  "version": "1.0.62",
  "size": 169100129,
  "chunkSize": 4194304,
  "totalChunks": 41
}
```
*(Catatan: `role` bernilai `"vps-seeder"` untuk daemon VPS Ubuntu atau `"user-peer"` untuk sesama pengguna Windows, digunakan bersama pencocokan multiaddr bootstrap untuk menampilkan label status sumber yang akurat di UI).*

### 4.2 Pesan Request `GET_CHUNK` (Unduh Chunk Spesifik)
```json
{
  "op": "GET_CHUNK",
  "version": "1.0.62",
  "filename": "SA-CHAOS-1.0.62-full.nupkg",
  "sha256": "ee488daf3ea7630a1df05b381160bd8a7a64d3d0037422c729bca5e478ecd275",
  "chunkIndex": 0,
  "maxBytes": 4194304
}
```
**Response Header + Binary Payload**:
- Frame 1 (JSON Metadata):
  ```json
  {
    "ok": true,
    "chunkIndex": 0,
    "byteLength": 4194304,
    "chunkSha256": "a1b2c3d4..."
  }
  ```
- Frame 2 (Binary Chunk Bytes): Byte mentah chunk sepanjang `byteLength`.

**Verifikasi di Penerima**:
1. Pastikan `byteLength <= chunkSize` dan sesuai ekspektasi ukuran chunk ke-`chunkIndex`.
2. Hitung `SHA-256(chunkBytes)` dan bandingkan langsung dengan `signedIndex.assets[0].chunkSha256[chunkIndex]` (bukan hanya percaya klaim peer).
3. Jika cocok, tulis ke offset `chunkIndex * chunkSize` pada file `.part` di `staging/` dan perbarui `.bitmap.json`.
4. Jika tidak cocok, tolak chunk, putuskan koneksi dari peer tersebut, catat metrik `verificationFailures`, dan beralih ke peer berikutnya atau fallback ke S3.

---

## 5. Protokol Peer Exchange (`/decentraupdate/peers/1.0.0`)

Digunakan agar klien dapat menemukan peer pengguna lain yang memiliki paket terverifikasi (sehingga ketika VPS seeder dimatikan pada masa mendatang atau sedang sibuk, Peer B tetap dapat mengunduh langsung dari Peer A).

### Request
```json
{
  "op": "EXCHANGE_PEERS",
  "version": "1.0.62",
  "sha256": "ee488daf3ea7630a1df05b381160bd8a7a64d3d0037422c729bca5e478ecd275",
  "announceMultiaddrs": [
    "/ip6/2001:db8::25/tcp/51234/p2p/12D3KooW..."
  ],
  "seeding": true
}
```
*(Klien hanya mengirimkan `announceMultiaddrs` dengan `seeding: true` apabila pengguna secara eksplisit mengaktifkan toggle `Share downloaded updates with other users`).*

### Response
```json
{
  "ok": true,
  "peers": [
    {
      "peerId": "12D3KooW...",
      "multiaddrs": [
        "/ip6/2001:db8::25/tcp/51234/p2p/12D3KooW...",
        "/ip4/198.51.100.25/tcp/51234/p2p/12D3KooW..."
      ],
      "role": "user-peer"
    }
  ]
}
```
Daftar peer yang valid disimpan secara lokal dengan batas jumlah maksimum (maksimal 32 peer) di `p2p-peers.json` agar tetap dapat dihubungi meskipun VPS bootstrap sedang offline.
