#!/usr/bin/env node
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const S3_KEY = process.env.S3_KEY || '64LHGNGM66GNV0GOSXY4';
const S3_SECRET = process.env.S3_SECRET || 'E0airrFLcLaHt8qwCHaU1Qvo3R90e9qaAROqNg82';
const S3_BUCKET = process.env.S3_BUCKET || 'sa-chaos';
const S3_HOST = 'is3.cloudhost.id';
const S3_REGION = 'us-east-1';

function sign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function downloadS3(key, destPath) {
  return new Promise((resolve, reject) => {
    const uri = `/${S3_BUCKET}/${key}`;
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const hash = crypto.createHash('sha256').update('').digest('hex');
    const sh = 'host;x-amz-content-sha256;x-amz-date';
    const ch = `host:${S3_HOST}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n`;
    const cr = `GET\n${uri}\n\n${ch}\n${sh}\n${hash}`;
    const sc = `${day}/${S3_REGION}/s3/aws4_request`;
    const sts = `AWS4-HMAC-SHA256\n${date}\n${sc}\n` + crypto.createHash('sha256').update(cr).digest('hex');
    const sig = crypto.createHmac('sha256', sign(sign(sign(sign(`AWS4${S3_SECRET}`, day), S3_REGION), 's3'), 'aws4_request')).update(sts).digest('hex');

    const req = https.request(
      {
        hostname: S3_HOST,
        path: uri,
        method: 'GET',
        headers: {
          Authorization: `AWS4-HMAC-SHA256 Credential=${S3_KEY}/${sc}, SignedHeaders=${sh}, Signature=${sig}`,
          'x-amz-date': date,
          'x-amz-content-sha256': hash
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download ${key}: HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('=== [VPS SYNC] Updating DecentraUpdate Seeder to v1.0.66 (Full + Delta) ===');
  
  // 1. Update daemon scripts
  console.log('[1/4] Updating P2P seeder core scripts in /opt/decentraupdate/...');
  await downloadS3('desktop/updates/vps/signed-release-index.js', '/opt/decentraupdate/main/server/p2p/signed-release-index.js');
  await downloadS3('desktop/updates/vps/seeder-daemon.js', '/opt/decentraupdate/vps-seeder/seeder-daemon.js');
  console.log('  -> Scripts updated successfully.');

  // 2. Prepare releases directory
  const relDir = '/var/lib/decentraupdate/releases';
  if (!fs.existsSync(relDir)) fs.mkdirSync(relDir, { recursive: true });

  // 3. Download release artifacts (Full + Delta + Signed Sidecar)
  console.log('[2/4] Downloading release artifacts from S3...');
  console.log('  -> Downloading SA-CHAOS-1.0.66-full.nupkg (~169 MB)...');
  await downloadS3('desktop/updates/SA-CHAOS-1.0.66-full.nupkg', path.join(relDir, 'SA-CHAOS-1.0.66-full.nupkg'));

  console.log('  -> Downloading SA-CHAOS-1.0.66-delta.nupkg (~791 KB)...');
  await downloadS3('desktop/updates/SA-CHAOS-1.0.66-delta.nupkg', path.join(relDir, 'SA-CHAOS-1.0.66-delta.nupkg'));

  console.log('  -> Downloading p2p-index.win.json...');
  await downloadS3('desktop/updates/p2p-index.win.json', path.join(relDir, 'p2p-index.win.json'));

  console.log('  -> Downloading p2p-index.win.sig...');
  await downloadS3('desktop/updates/p2p-index.win.sig', path.join(relDir, 'p2p-index.win.sig'));

  // 4. Verify hashes
  console.log('[3/4] Verifying SHA-256 hashes against signed release index...');
  const index = JSON.parse(fs.readFileSync(path.join(relDir, 'p2p-index.win.json'), 'utf8'));
  for (const asset of index.assets) {
    const fp = path.join(relDir, asset.filename);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').toLowerCase();
    if (hash !== asset.sha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${hash}`);
    }
    console.log(`  -> Verified ${asset.filename} (${asset.type}): OK`);
  }

  // 5. Restart systemd service
  console.log('[4/4] Restarting decentraupdate-seeder.service...');
  execSync('systemctl restart decentraupdate-seeder.service', { stdio: 'inherit' });
  console.log('\n=== Service restarted successfully! Current status: ===\n');
  execSync('journalctl -u decentraupdate-seeder.service -n 15 --no-pager', { stdio: 'inherit' });
}

main().catch((err) => {
  console.error('\n[ERROR] VPS Sync failed:', err.message);
  process.exit(1);
});
