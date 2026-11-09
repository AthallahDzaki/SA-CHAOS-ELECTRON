import { uploadFileToS3 } from './upload-s3-artifacts.js';

async function upload() {
  console.log('Uploading Releases/releases.win.json ke CloudHost S3 (desktop/updates/releases.win.json)...');
  try {
    const success = await uploadFileToS3('Releases/releases.win.json', 'desktop/updates/releases.win.json', 'application/json');
    if (success) {
      console.log('\n[BERHASIL] releases.win.json berhasil diperbarui di S3!');
    }
  } catch (err) {
    console.error('\n[GAGAL] Error saat mengunggah:', err.message);
  }
}

upload();
