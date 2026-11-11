import { uploadFileToS3 } from './upload-s3-artifacts.js';
import fs from 'fs';

const channel = process.argv[2] && process.argv[2].toLowerCase() === 'beta' ? 'beta' : 'win';

async function upload() {
  const folder = channel === 'beta' ? 'Beta' : 'Releases';
  let localFile = `${folder}/releases.${channel}.json`;
  if (!fs.existsSync(localFile) && channel === 'beta') {
    localFile = `Releases/releases.${channel}.json`;
  }
  const remoteKey = `desktop/updates/releases.${channel}.json`;
  console.log(`Uploading ${localFile} ke CloudHost S3 (${remoteKey})...`);
  try {
    const success = await uploadFileToS3(localFile, remoteKey, 'application/json');
    if (success) {
      console.log(`\n[BERHASIL] releases.${channel}.json berhasil diperbarui di S3!`);
    }
  } catch (err) {
    console.error('\n[GAGAL] Error saat mengunggah:', err.message);
  }
}

upload();
