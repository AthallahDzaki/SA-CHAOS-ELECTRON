import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const s3Client = new S3Client({
  endpoint: "https://is3.cloudhost.id",
  region: "us-east-1",
  credentials: {
    accessKeyId: "64LHGNGM66GNV0GOSXY4",
    secretAccessKey: "E0airrFLcLaHt8qwCHaU1Qvo3R90e9qaAROqNg82",
  },
  forcePathStyle: true,
});

const BUCKET_NAME = "sa-chaos";

const changelogData = {
  appName: "SA-CHAOS Desktop",
  latestVersion: "1.0.49",
  updatedAt: new Date().toISOString(),
  releases: [
    {
      version: "1.0.49",
      date: "2026-09-07",
      title: {
        id: "Versi 1.0.49 (Paling Baru)",
        en: "Version 1.0.49 (Latest)",
      },
      changes: {
        id: [
          "[FITUR] Durasi Kustom Per Efek: Mengatur durasi khusus untuk setiap efek secara individual (override durasi global) langsung di General Settings.",
          "[FITUR] Pengaturan Combo Delay: Pengaturan jeda waktu (delay ms) antar efek dalam combo chain di General Settings.",
          "[UI] Manajemen Durasi Efek: Pilihan efek interaktif, preset durasi cepat (5s - 90s), serta tabel pencarian, edit, dan hapus konfigurasi durasi efek.",
          "[OPTIMASI] Resolusi Durasi Cerdas: Eksekusi efek di game mod secara dinamis mendeteksi durasi kustom dengan toleransi prefix ID dan fallback otomatis ke durasi global.",
        ],
        en: [
          "[FEATURE] Per-Effect Custom Duration: Configure individual duration for each effect (overriding global duration) directly in General Settings.",
          "[FEATURE] Combo Delay Setting: Adjustable delay interval (ms) between combo chain effects in General Settings.",
          "[UI] Effect Duration Management UI: Interactive effect picker, quick duration presets (5s - 90s), with searchable, editable, and removable duration table.",
          "[OPTIMIZATION] Smart Duration Resolution: In-game effect execution dynamically applies custom duration with ID prefix tolerance and automatic global fallback.",
        ],
      },
    },
    {
      version: "1.0.48",
      date: "2026-08-17",
      title: {
        id: "Versi 1.0.48",
        en: "Version 1.0.48",
      },
      changes: {
        id: [
          "[FITUR] Safe Fallback Cache System: Konfigurasi dan eksekusi efek tetap berjalan lancar menggunakan cache lokal device saat GitHub offline / down.",
          "[STABILITAS] Safeguard rekonsiliasi efek agar tidak menghapus konfigurasi gift/goal/saweria saat koneksi GitHub terputus.",
          "[UI] Indikator status sumber efek real-time di UI (Device Cache vs GitHub Online).",
          "[OPTIMASI] Fallback dynamic effect payload builder di TikTok & Goal Webhook.",
        ],
        en: [
          "[FEATURE] Safe Device Cache Fallback: Seamless effect configuration & execution from local device cache when GitHub is offline / down.",
          "[STABILITY] Reconciliation safeguard preventing configuration wipes during network disruptions.",
          "[UI] Real-time effect source status badges (Device Cache Active vs GitHub Online).",
          "[OPTIMIZATION] Dynamic fallback effect payload builder for TikTok & Goal Webhooks.",
        ],
      },
    },
    {
      version: "1.0.47",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.47",
        en: "Version 1.0.47",
      },
      changes: {
        id: [
          "[UI] Pemisahan fase status 'Downloading Package' dan 'Applying Binary Patch' pada splash screen.",
          "[OPTIMASI] Transparansi progress patching file biner secara lokal.",
        ],
        en: [
          "[UI] Distinct multi-phase status labels for delta download and binary patching stages.",
          "[OPTIMIZATION] Transparent local binary reconstruction progress on splash screen.",
        ],
      },
    },
    {
      version: "1.0.46",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.46",
        en: "Version 1.0.46",
      },
      changes: {
        id: [
          "[UI] Perbaikan teks judul Catatan Rilis & Riwayat Pembaruan.",
          "[UI] Badge versi terkini disinkronkan otomatis.",
        ],
        en: [
          "[UI] Fixed release notes & changelog title rendering in i18n dictionary.",
          "[UI] Synchronized dynamic latest version badge.",
        ],
      },
    },
    {
      version: "1.0.45",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.45",
        en: "Version 1.0.45",
      },
      changes: {
        id: [
          "[PERBAIKAN] Kestabilan restart updater.",
          "[PRIVASI] Menyembunyikan log port WebSocket internal.",
          "[FITUR] Tombol Clear pada System Logger.",
        ],
        en: [
          "[FIX] Updater restart reliability.",
          "[PRIVACY] Silenced internal WebSocket port logs.",
          "[FEATURE] System Logger clear functionality.",
        ],
      },
    },
    {
      version: "1.0.42",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.42",
        en: "Version 1.0.42",
      },
      changes: {
        id: [
          "[BARU] Integrasi Delta Update pada client updater.",
          "[PERBAIKAN] Penyesuaian pemanggilan nama file nupkg ke Velopack.",
        ],
        en: [
          "[NEW] Delta update client-side support.",
          "[FIX] Accurate nupkg package naming dispatch to Velopack engine.",
        ],
      },
    },
    {
      version: "1.0.41",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.41",
        en: "Version 1.0.41",
      },
      changes: {
        id: [
          "[BARU] 16 Pilihan Model & Desain OBS Overlay (Compact, Modern, Slider UP, Cyberpunk Neon, Horizontal Ticker, Pill Badges).",
          "[BARU] Splash updater bahasa Inggris terstandarisasi.",
          "[BARU] Kartu dan tombol modal Changelog di Dashboard utama.",
        ],
        en: [
          "[NEW] 16 OBS Overlay Models & Layouts (Compact, Modern, Slider UP, Cyberpunk Neon, Horizontal Ticker, Pill Badges).",
          "[NEW] Standardized English splash updater messages.",
          "[NEW] Dashboard Changelog card and modal popup.",
        ],
      },
    },
    {
      version: "1.0.40",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.40",
        en: "Version 1.0.40",
      },
      changes: {
        id: [
          "[BARU] Indikator progress download (MB/KB) dan persentase (%) real-time di splash screen.",
        ],
        en: [
          "[NEW] Real-time downloaded data progress counter (MB/KB) and percentage (%) on splash screen.",
        ],
      },
    },
    {
      version: "1.0.39",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.39",
        en: "Version 1.0.39",
      },
      changes: {
        id: [
          "[DESAIN] Tipografi Montserrat & Poppins ExtraBold 800 modern.",
          "[DESAIN] Smooth vector stroke outline tanpa artefak garis bergerigi.",
          "[LAYOUT] Susunan 2 Kolom Stream compact side-by-side.",
        ],
        en: [
          "[DESIGN] Modern Montserrat & Poppins ExtraBold 800 typography.",
          "[DESIGN] Smooth vector-like text stroke eliminating clipping artifacts.",
          "[LAYOUT] Compact side-by-side 2-column stream layout.",
        ],
      },
    },
    {
      version: "1.0.38",
      date: "2026-08-15",
      title: {
        id: "Versi 1.0.38",
        en: "Version 1.0.38",
      },
      changes: {
        id: [
          "[BARU] Custom Overlay Label untuk mengganti teks nama efek di OBS.",
          "[BARU] Efek 'Tanpa Efek (Hanya Overlay)' untuk gift kustom tanpa memicu efek game GTA SA.",
          "[BARU] OBS Overlay Model Selector di halaman Gift Config.",
        ],
        en: [
          "[NEW] Custom Overlay Label to override effect names in OBS.",
          "[NEW] 'No Effect (Overlay Only)' option for overlay-only gifts without triggering game effects.",
          "[NEW] OBS Overlay Model Selector in Gift Config.",
        ],
      },
    },
  ],
};

async function uploadFile(key, content, contentType) {
  console.log(`[S3 Upload] Uploading ${key}...`);
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    ContentType: contentType,
  });

  await s3Client.send(command);
  console.log(`[S3 Upload] Successfully uploaded: ${key}`);
}

async function main() {
  try {
    // 1. Sync latestVersion from version.txt or package.json
    const versionTxtPath = path.join(__dirname, "version.txt");
    const activeVersion = fs.existsSync(versionTxtPath)
      ? fs.readFileSync(versionTxtPath, "utf8").trim()
      : JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

    let payload = changelogData;

    // If Releases/changelog.json exists locally, use it as primary source
    const releasesDir = path.join(__dirname, "Releases");
    const changelogJsonPath = path.join(releasesDir, "changelog.json");
    if (fs.existsSync(changelogJsonPath)) {
      try {
        const fileContent = JSON.parse(fs.readFileSync(changelogJsonPath, "utf8"));
        if (fileContent.releases && fileContent.releases.length > 0) {
          payload = fileContent;
        }
      } catch (err) {
        console.warn("[S3 Upload] Failed parsing Releases/changelog.json, using script data.");
      }
    }

    if (activeVersion) {
      payload.latestVersion = activeVersion;
    }
    payload.updatedAt = new Date().toISOString();

    const jsonStr = JSON.stringify(payload, null, 2);

    // Save locally to Releases folder as well
    if (fs.existsSync(releasesDir)) {
      fs.writeFileSync(changelogJsonPath, jsonStr);
    }

    // Upload to multiple S3 paths for redundancy & direct access
    await uploadFile("desktop/updates/changelog.json", jsonStr, "application/json");
    await uploadFile("desktop/changelog.json", jsonStr, "application/json");

    console.log("\n[S3 Upload] All changelog assets uploaded to S3 successfully!\n");
  } catch (error) {
    console.error("[S3 Upload] Failed to upload changelog to S3:", error);
    process.exit(1);
  }
}

main();
