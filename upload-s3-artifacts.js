import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const S3_KEY = process.env.S3_KEY || '64LHGNGM66GNV0GOSXY4';
const S3_SECRET = process.env.S3_SECRET || 'E0airrFLcLaHt8qwCHaU1Qvo3R90e9qaAROqNg82';
const S3_BUCKET = process.env.S3_BUCKET || 'sa-chaos';
const S3_HOST = 'is3.cloudhost.id';
const S3_REGION = 'us-east-1';

function sign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

export async function uploadFileToS3(filePath, s3Key, contentType = 'application/octet-stream') {
  if (!fs.existsSync(filePath)) {
    console.error(`[S3 Upload Error] File not found: ${filePath}`);
    return false;
  }

  const data = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);

  const uri = `/${S3_BUCKET}/${s3Key}`;
  const sh = 'host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256';
  const ch = `host:${S3_HOST}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\nx-amz-meta-sha256:${hash}\n`;
  const cr = `PUT\n${uri}\n\n${ch}\n${sh}\n${hash}`;
  const sc = `${day}/${S3_REGION}/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${date}\n${sc}\n` + crypto.createHash('sha256').update(cr).digest('hex');
  
  const kDate = sign(`AWS4${S3_SECRET}`, day);
  const kRegion = sign(kDate, S3_REGION);
  const kService = sign(kRegion, 's3');
  const kSigning = sign(kService, 'aws4_request');
  const sig = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: S3_HOST,
      path: uri,
      method: 'PUT',
      headers: {
        'Authorization': `AWS4-HMAC-SHA256 Credential=${S3_KEY}/${sc}, SignedHeaders=${sh}, Signature=${sig}`,
        'x-amz-date': date,
        'x-amz-content-sha256': hash,
        'x-amz-meta-sha256': hash,
        'Content-Type': contentType,
        'Content-Length': data.length
      }
    }, (res) => {
      if (res.statusCode === 200) {
        console.log(`[S3 Upload OK] Successfully uploaded ${s3Key} (Size: ${data.length} bytes, SHA256: ${hash})`);
        resolve(true);
      } else {
        console.error(`[S3 Upload Fail] Status ${res.statusCode} for ${s3Key}`);
        reject(new Error(`S3 returned status ${res.statusCode}`));
      }
    });

    req.on('error', (err) => {
      console.error(`[S3 Upload Error] ${err.message}`);
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('=== Uploading AutoUpdater to CloudHost S3 ===');

  // 1. Upload AutoUpdater.exe
  let autoUpdaterPath = path.resolve('../AutoUpdater/build/AutoUpdater.exe');
  if (!fs.existsSync(autoUpdaterPath)) {
    autoUpdaterPath = path.resolve('../AutoUpdater/build/Test/AutoUpdater.exe');
  }
  if (fs.existsSync(autoUpdaterPath)) {
    console.log('\nUploading AutoUpdater.exe from:', autoUpdaterPath);
    await uploadFileToS3(autoUpdaterPath, 'AutoUpdater.exe', 'application/octet-stream');
  } else {
    console.warn('\nAutoUpdater.exe not found at:', autoUpdaterPath);
  }

  console.log('\n=== Upload finished! ===');
}

if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('upload-s3-artifacts.js'))) {
  main().catch(console.error);
}
