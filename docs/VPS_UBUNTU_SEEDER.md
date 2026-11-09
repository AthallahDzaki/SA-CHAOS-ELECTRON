# Panduan Deployment & Operasional Ubuntu VPS Seeder (`vps-seeder/`)

Dokumen ini menjelaskan cara menyiapkan, menguji konektivitas dual-stack (IPv4 publik + Global IPv6), mengamankan firewall, dan menjalankan daemon seeder permanen di VPS Ubuntu menggunakan `systemd` non-root.

> **PERINGATAN OPERASIONAL:** Jangan membuka port admin/RPC ke publik dan jangan menyalin kunci privat penandatangan (`publisher-private.pem`) ke VPS. VPS hanya memerlukan kunci publik publisher untuk memverifikasi paket sebelum melakukan seeding.

---

## 1. Prasyarat Infrastruktur VPS Ubuntu

- **OS**: Ubuntu 22.04 LTS / 24.04 LTS x64
- **Runtime**: Node.js >= 20.x LTS (atau >= 22.x)
- **Jaringan**:
  - 1x Alamat IPv4 Publik (contoh ilustrasi: `203.0.113.10`)
  - 1x Alamat Global IPv6 (contoh ilustrasi: `2001:db8::10`)
- **Port TCP Default Seeder**: `4001` (dapat diubah di `/etc/decentraupdate/config.json`)

---

## 2. Verifikasi Konektivitas Dual-Stack (IPv4 & IPv6)

Jalankan perintah berikut di VPS Ubuntu untuk memastikan antarmuka jaringan memiliki alamat global IPv6 dan IPv4:

```bash
# Cek alamat IPv4 dan Global IPv6 (scope global)
ip -4 addr show scope global
ip -6 addr show scope global

# Uji routing outbound IPv6 dan IPv4
ping -6 -c 3 ipv6.google.com
ping -4 -c 3 1.1.1.1
```

Daemon `vps-seeder/seeder-daemon.js` secara eksplisit membuka **dua listener socket terpisah**:
1. Listener IPv6 pada `::` dengan opsi `ipv6Only: true` (agar tidak bergantung pada perilaku `net.ipv6.bindv6only` kernel Linux).
2. Listener IPv4 pada `0.0.0.0`.

Dengan demikian, kedua stack dijamin aktif dan terikat secara eksplisit.

---

## 3. Instalasi User Non-Root & Direktori Seeder

Jalankan di VPS Ubuntu sebagai administrator (`sudo`):

```bash
# 1. Buat user & group sistem tanpa akses shell login
sudo useradd --system --no-create-home --shell /usr/sbin/nologin decentraupdate

# 2. Buat struktur direktori
sudo mkdir -p /opt/decentraupdate/vps-seeder
sudo mkdir -p /opt/decentraupdate/main/server/p2p
sudo mkdir -p /etc/decentraupdate
sudo mkdir -p /var/lib/decentraupdate/releases
sudo mkdir -p /var/lib/decentraupdate/state

# 3. Salin file kode dari repository (jalankan dari laptop developer via scp)
# scp vps-seeder/seeder-daemon.js user@vps:/tmp/
# scp main/server/p2p/*.js user@vps:/tmp/p2p/

# 4. Atur kepemilikan dan izin direktori (releases read-only bagi daemon)
sudo chown -R root:decentraupdate /opt/decentraupdate /etc/decentraupdate
sudo chmod -R 750 /opt/decentraupdate /etc/decentraupdate

# Direktori state milik decentraupdate, direktori releases dapat ditulis oleh user deploy SSH dan dibaca oleh decentraupdate
sudo chown -R decentraupdate:decentraupdate /var/lib/decentraupdate/state
sudo chown -R $USER:decentraupdate /var/lib/decentraupdate/releases
sudo chmod 750 /var/lib/decentraupdate/releases
```

---

## 4. Konfigurasi `/etc/decentraupdate/config.json`

Salin `vps-seeder/config.example.json` ke `/etc/decentraupdate/config.json` dan sesuaikan `publicIpv6` serta `publicIpv4` dengan IP asli VPS Anda:

```json
{
  "listenPort": 4001,
  "bindIpv6": "::",
  "bindIpv4": "0.0.0.0",
  "publicIpv6": "<GANTI_DENGAN_IPV6_GLOBAL_VPS>",
  "publicIpv4": "<GANTI_DENGAN_IPV4_PUBLIK_VPS>",
  "releasesDir": "/var/lib/decentraupdate/releases",
  "stateDir": "/var/lib/decentraupdate/state",
  "maxConcurrentPeers": 32,
  "maxUploadKBps": 20480,
  "appId": "SA-CHAOS",
  "channel": "win"
}
```

---

## 5. Konfigurasi Firewall (UFW / nftables) — Hanya dengan Persetujuan Admin

Pastikan hanya port TCP seeder (mis. `4001/tcp`) yang dibuka untuk IPv4 dan IPv6:

```bash
# Periksa apakah UFW mengaktifkan dukungan IPv6 (IPV6=yes)
grep -i "^IPV6=" /etc/default/ufw

# Izinkan port TCP 4001 pada IPv4 dan IPv6
sudo ufw allow 4001/tcp comment 'DecentraUpdate P2P Seeder Dual-Stack'
sudo ufw status verbose
```

---

## 6. Instalasi & Menjalankan `systemd` Service

Salin file unit `vps-seeder/decentraupdate-seeder.service` ke `/etc/systemd/system/decentraupdate-seeder.service`:

```bash
sudo cp /opt/decentraupdate/vps-seeder/decentraupdate-seeder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable decentraupdate-seeder.service
sudo systemctl start decentraupdate-seeder.service
```

### Verifikasi Status, Multiaddr & Socket Listener
```bash
# Cek status service dan log multiaddr (mencetak PeerId dan multiaddr /ip6/ serta /ip4/)
sudo systemctl status decentraupdate-seeder.service
sudo journalctl -u decentraupdate-seeder.service -n 50 --no-pager

# Pastikan kedua socket TCP 0.0.0.0:4001 dan [::]:4001 berstatus LISTEN
sudo ss -tlnp | grep 4001
```

Catat dua baris multiaddr yang tercetak pada log startup:
- `/ip6/<IPV6_VPS>/tcp/4001/p2p/12D3KooW...`
- `/ip4/<IPV4_VPS>/tcp/4001/p2p/12D3KooW...`

Masukkan kedua multiaddr tersebut ke dalam konfigurasi `p2pBootstrapMultiaddrs` di aplikasi atau variabel environment saat rilis.

---

## 7. Prosedur Rollback / Menonaktifkan Seeder VPS

Apabila ditemukan kendala pada jaringan P2P atau VPS seeder perlu dimatikan segera:

```bash
# Hentikan dan nonaktifkan service seeder
sudo systemctl stop decentraupdate-seeder.service
sudo systemctl disable decentraupdate-seeder.service

# Tutup kembali aturan firewall jika diperlukan
sudo ufw delete allow 4001/tcp
```

**Dampak terhadap pengguna**: **Nol downtime update.** Seluruh klien Electron yang mengaktifkan P2P akan otomatis mendeteksi bahwa seeder tidak dapat dihubungi dalam batas waktu singkat (6–8 detik) dan langsung mengunduh update dari endpoint S3 standar (`https://updater.sa-chaos.my.id/velopack.php/`).
