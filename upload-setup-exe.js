import { uploadFileToS3 } from './upload-s3-artifacts.js';
import path from 'path';
import fs from 'fs';

async function run() {
  const setupPath = path.resolve('Releases/SA-CHAOS-win-Setup.exe');
  if (!fs.existsSync(setupPath)) {
    console.error('File Releases/SA-CHAOS-win-Setup.exe tidak ditemukan!');
    return;
  }
  console.log(`Mengunggah ${setupPath} (${(fs.statSync(setupPath).size / 1024 / 1024).toFixed(1)} MB) ke S3...`);
  try {
    const ok = await uploadFileToS3(setupPath, 'desktop/updates/SA-CHAOS-win-Setup.exe', 'application/vnd.microsoft.portable-executable');
    if (ok) {
      console.log('\n[BERHASIL] SA-CHAOS-win-Setup.exe berhasil diunggah ke S3 desktop/updates/SA-CHAOS-win-Setup.exe!');
    }
  } catch (err) {
    console.error('\n[GAGAL] Error saat mengunggah:', err.message);
  }
}

run();
