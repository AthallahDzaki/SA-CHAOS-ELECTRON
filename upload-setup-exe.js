import { uploadFileToS3 } from './upload-s3-artifacts.js';
import path from 'path';
import fs from 'fs';

const channel = process.argv[2] && process.argv[2].toLowerCase() === 'beta' ? 'beta' : 'win';

async function run() {
  const folder = channel === 'beta' ? 'Beta' : 'Releases';
  const setupName = channel === 'beta' ? 'SA-CHAOS-beta-Setup.exe' : 'SA-CHAOS-win-Setup.exe';
  let setupPath = path.resolve(`${folder}/${setupName}`);
  if (!fs.existsSync(setupPath) && channel === 'beta') {
    const alt1 = path.resolve(`Releases/${setupName}`);
    const alt2 = path.resolve(`${folder}/SA-CHAOS-Setup.exe`);
    if (fs.existsSync(alt1)) setupPath = alt1;
    else if (fs.existsSync(alt2)) setupPath = alt2;
  }
  if (!fs.existsSync(setupPath)) {
    console.error(`File ${setupPath} tidak ditemukan!`);
    return;
  }
  console.log(`Mengunggah ${setupPath} (${(fs.statSync(setupPath).size / 1024 / 1024).toFixed(1)} MB) ke S3 (Channel: ${channel})...`);
  try {
    const ok = await uploadFileToS3(setupPath, `desktop/updates/${setupName}`, 'application/vnd.microsoft.portable-executable');
    if (ok) {
      console.log(`\n[BERHASIL] ${setupName} berhasil diunggah ke S3 desktop/updates/${setupName}!`);
    }
  } catch (err) {
    console.error('\n[GAGAL] Error saat mengunggah:', err.message);
  }
}

run();
