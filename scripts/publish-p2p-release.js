#!/usr/bin/env node
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_CHUNK_SIZE,
  createSignedP2PReleaseIndex,
  generatePublisherKeyPair,
  verifySignedP2PReleaseIndex
} from '../main/server/p2p/signed-release-index.js';
import { uploadFileToS3 } from '../upload-s3-artifacts.js';

function parseArgs(argv) {
  const args = {
    channel: 'win',
    releasesDir: path.resolve(process.cwd(), 'Releases'),
    privateKeyPath:
      process.env.P2P_PUBLISHER_PRIVATE_KEY_PATH ||
      path.join(os.homedir(), '.sa-chaos-keys', 'publisher-ed25519-private.pem'),
    publicKeyPath:
      process.env.P2P_PUBLISHER_PUBLIC_KEY_PATH ||
      path.join(os.homedir(), '.sa-chaos-keys', 'publisher-ed25519-public.pem'),
    keyId: process.env.P2P_SIGNING_KEY_ID || 'publisher-2026',
    version: null,
    generateKeys: false,
    keyDir: path.join(os.homedir(), '.sa-chaos-keys'),
    uploadS3: false,
    s3Prefix: 'desktop/updates/',
    vpsHost: process.env.P2P_VPS_HOST || null,
    vpsSshKey: process.env.P2P_VPS_SSH_KEY || null,
    vpsReleasesDir: process.env.P2P_VPS_RELEASES_DIR || '/var/lib/decentraupdate/releases',
    nonFatal: false
  };

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--generate-keys') args.generateKeys = true;
    else if ((token === '--channel' || token === '-c') && argv[i + 1]) args.channel = argv[++i];
    else if (token === '--key-dir' && argv[i + 1]) args.keyDir = path.resolve(argv[++i]);
    else if (token === '--releases-dir' && argv[i + 1]) args.releasesDir = path.resolve(argv[++i]);
    else if (token === '--private-key' && argv[i + 1]) args.privateKeyPath = path.resolve(argv[++i]);
    else if (token === '--public-key' && argv[i + 1]) args.publicKeyPath = path.resolve(argv[++i]);
    else if (token === '--key-id' && argv[i + 1]) args.keyId = argv[++i];
    else if (token === '--version' && argv[i + 1]) args.version = argv[++i];
    else if (token === '--upload-s3') args.uploadS3 = true;
    else if (token === '--vps-host' && argv[i + 1]) args.vpsHost = argv[++i];
    else if (token === '--vps-ssh-key' && argv[i + 1]) args.vpsSshKey = path.resolve(argv[++i]);
    else if (token === '--vps-releases-dir' && argv[i + 1]) args.vpsReleasesDir = argv[++i];
    else if (token === '--non-fatal') args.nonFatal = true;
  }
  return args;
}

async function run() {
  const args = parseArgs(process.argv);

  if (args.generateKeys) {
    if (!fs.existsSync(args.keyDir)) {
      fs.mkdirSync(args.keyDir, { recursive: true });
    }
    const privFile = path.join(args.keyDir, 'publisher-ed25519-private.pem');
    const pubFile = path.join(args.keyDir, 'publisher-ed25519-public.pem');
    if (fs.existsSync(privFile)) {
      console.log(`[P2P Keygen] Keypair already exists at ${privFile}`);
      return;
    }
    const { publicKeyPem, privateKeyPem } = generatePublisherKeyPair();
    fs.writeFileSync(privFile, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(pubFile, publicKeyPem, { encoding: 'utf8', mode: 0o644 });
    console.log(`[P2P Keygen] Generated Ed25519 keypair (${args.keyId}):`);
    console.log(`  Private Key (DO NOT SHARE / DO NOT COMMIT): ${privFile}`);
    console.log(`  Public Key (Pin in client & VPS):           ${pubFile}`);
    console.log('\nPublic Key PEM:\n' + publicKeyPem);
    return;
  }

  const releasesJsonName = `releases.${args.channel}.json`;
  const releasesJsonPath = path.join(args.releasesDir, releasesJsonName);
  if (!fs.existsSync(releasesJsonPath)) {
    throw new Error(`${releasesJsonName} not found at ${releasesJsonPath}`);
  }

  if (!fs.existsSync(args.privateKeyPath)) {
    console.warn(
      `[P2P Publish] Skipping P2P sidecar signing because publisher private key was not found at ${args.privateKeyPath}.`
    );
    console.warn(
      `[P2P Publish] Official S3 release remains completely unaffected. Run with --generate-keys to initialize a signing key.`
    );
    return;
  }

  const privateKeyPem = fs.readFileSync(args.privateKeyPath, 'utf8');
  const releasesData = JSON.parse(fs.readFileSync(releasesJsonPath, 'utf8'));
  const assets = Array.isArray(releasesData.Assets) ? releasesData.Assets : [];
  const fullAssets = assets.filter((a) => String(a.Type).toLowerCase() === 'full');
  const deltaAssets = assets.filter((a) => String(a.Type).toLowerCase() === 'delta');

  if (fullAssets.length === 0) {
    throw new Error(`No Full package asset found in ${releasesJsonName}`);
  }

  const targetAsset = args.version
    ? fullAssets.find((a) => String(a.Version) === String(args.version))
    : fullAssets[0];

  if (!targetAsset) {
    throw new Error(`No Full package asset matching version ${args.version} in ${releasesJsonName}`);
  }

  const targetDeltaAsset = deltaAssets.find(
    (a) => String(a.Version) === String(targetAsset.Version)
  );

  const packagePath = path.join(args.releasesDir, targetAsset.FileName);
  if (!fs.existsSync(packagePath)) {
    throw new Error(`Package file ${targetAsset.FileName} not found at ${packagePath}`);
  }

  let deltaPackagePath = null;
  if (targetDeltaAsset) {
    const candidateDelta = path.join(args.releasesDir, targetDeltaAsset.FileName);
    if (fs.existsSync(candidateDelta)) {
      deltaPackagePath = candidateDelta;
      console.log(`[P2P Publish] Found companion Delta package: ${targetDeltaAsset.FileName}`);
    }
  }

  console.log(`[P2P Publish] Creating deterministic SignedP2PReleaseIndex for ${targetAsset.FileName} (v${targetAsset.Version})${deltaPackagePath ? ' + Delta' : ''}...`);
  const signed = await createSignedP2PReleaseIndex({
    packagePath,
    deltaPackagePath,
    appId: targetAsset.PackageId || 'SA-CHAOS',
    platform: 'win',
    arch: 'x64',
    channel: args.channel,
    version: targetAsset.Version,
    chunkSize: DEFAULT_CHUNK_SIZE,
    signingKeyId: args.keyId,
    privateKeyPem
  });

  // Self-verify against the official S3 releases.<channel>.json entry before writing
  if (fs.existsSync(args.publicKeyPath)) {
    const pubPem = fs.readFileSync(args.publicKeyPath, 'utf8');
    verifySignedP2PReleaseIndex({
      indexInput: signed.index,
      signatureInput: signed.signatureFileContent,
      expectedAppId: targetAsset.PackageId || 'SA-CHAOS',
      authoritativeS3Release: targetAsset,
      authoritativeS3DeltaRelease: targetDeltaAsset || null,
      trustedKeys: { [args.keyId]: pubPem }
    });
  }

  const indexFileName = `p2p-index.${args.channel}.json`;
  const sigFileName = `p2p-index.${args.channel}.sig`;
  const indexOutPath = path.join(args.releasesDir, indexFileName);
  const sigOutPath = path.join(args.releasesDir, sigFileName);

  fs.writeFileSync(indexOutPath, JSON.stringify(signed.index, null, 2), 'utf8');
  fs.writeFileSync(sigOutPath, signed.signatureFileContent, 'utf8');

  console.log(`[P2P Publish] Wrote signed sidecar files:`);
  console.log(`  - ${indexOutPath} (SHA256: ${signed.index.assets[0].sha256})`);
  console.log(`  - ${sigOutPath} (Key ID: ${args.keyId})`);

  // Optional Step 1: Upload sidecar files to S3 alongside releases.<channel>.json
  if (args.uploadS3) {
    try {
      const prefix = args.s3Prefix.endsWith('/') ? args.s3Prefix : `${args.s3Prefix}/`;
      await uploadFileToS3(indexOutPath, `${prefix}${indexFileName}`, 'application/json');
      await uploadFileToS3(sigOutPath, `${prefix}${sigFileName}`, 'application/json');
      console.log(`[P2P Publish] Uploaded ${indexFileName} and ${sigFileName} to S3 (${prefix})`);
    } catch (s3Err) {
      console.warn(`[P2P Publish Warning] Failed to upload P2P sidecar to S3 (core release is unaffected): ${s3Err.message}`);
      if (!args.nonFatal) throw s3Err;
    }
  }

  // Optional Step 2: Upload package & sidecars to Ubuntu VPS via SCP, verify SHA-256 remotely, and reload systemd service
  if (args.vpsHost) {
    try {
      console.log(`[P2P Publish] Uploading ${targetAsset.FileName} and sidecar to VPS (${args.vpsHost})...`);

      let sshHost = args.vpsHost;
      let scpTargetHost = args.vpsHost;

      // Correctly format IPv6 multi-colon addresses for SCP: user@[2406:...]:/path
      if (args.vpsHost.includes(':') && !args.vpsHost.includes('[')) {
        if (args.vpsHost.includes('@')) {
          const atIdx = args.vpsHost.indexOf('@');
          const userPart = args.vpsHost.slice(0, atIdx);
          const rawHost = args.vpsHost.slice(atIdx + 1);
          scpTargetHost = `${userPart}@[${rawHost}]`;
        } else {
          scpTargetHost = `[${args.vpsHost}]`;
        }
      }

      const sshArgsBase = ['-o', 'StrictHostKeyChecking=no', '-6'];
      const scpArgsBase = ['-o', 'StrictHostKeyChecking=no', '-6'];
      if (args.vpsSshKey) {
        sshArgsBase.push('-i', args.vpsSshKey);
        scpArgsBase.push('-i', args.vpsSshKey);
      }

      const remoteTmpDir = `/tmp/decentraupdate-upload-${Date.now()}`;
      const mkdirRes = spawnSync('ssh', [...sshArgsBase, sshHost, `mkdir -p ${remoteTmpDir}`], {
        encoding: 'utf8'
      });
      if (mkdirRes.status !== 0) {
        throw new Error(`SSH mkdir failed: ${mkdirRes.stderr || mkdirRes.stdout}`);
      }

      const scpFiles = [packagePath];
      if (deltaPackagePath) scpFiles.push(deltaPackagePath);
      scpFiles.push(indexOutPath, sigOutPath);
      const scpRes = spawnSync(
        'scp',
        [...scpArgsBase, ...scpFiles, `${scpTargetHost}:${remoteTmpDir}/`],
        { encoding: 'utf8', stdio: 'inherit' }
      );
      if (scpRes.status !== 0) {
        throw new Error('SCP upload to VPS failed');
      }

      const fullAssetMeta = signed.index.assets.find(a => a.type === 'Full');
      const deltaAssetMeta = signed.index.assets.find(a => a.type === 'Delta');
      const expectedSha256 = fullAssetMeta.sha256.toLowerCase();

      const verifySteps = [
        'set -x',
        `ACTUAL_HASH=$(sha256sum "${remoteTmpDir}/${fullAssetMeta.filename}" | awk '{print tolower($1)}')`,
        `echo "[Remote Check] Full Expected: ${expectedSha256}"`,
        `echo "[Remote Check] Full Actual  : $ACTUAL_HASH"`,
        `if [ "$ACTUAL_HASH" != "${expectedSha256}" ]; then echo "Full hash mismatch on VPS: $ACTUAL_HASH != ${expectedSha256}" >&2; rm -rf "${remoteTmpDir}"; exit 1; fi`,
        `sudo mv -vf "${remoteTmpDir}/${fullAssetMeta.filename}" "${args.vpsReleasesDir}/${fullAssetMeta.filename}"`
      ];

      if (deltaAssetMeta) {
        const expectedDeltaSha256 = deltaAssetMeta.sha256.toLowerCase();
        verifySteps.push(
          `DELTA_HASH=$(sha256sum "${remoteTmpDir}/${deltaAssetMeta.filename}" | awk '{print tolower($1)}')`,
          `echo "[Remote Check] Delta Expected: ${expectedDeltaSha256}"`,
          `echo "[Remote Check] Delta Actual  : $DELTA_HASH"`,
          `if [ "$DELTA_HASH" != "${expectedDeltaSha256}" ]; then echo "Delta hash mismatch on VPS: $DELTA_HASH != ${expectedDeltaSha256}" >&2; sudo rm -rf "${remoteTmpDir}"; exit 1; fi`,
          `sudo mv -vf "${remoteTmpDir}/${deltaAssetMeta.filename}" "${args.vpsReleasesDir}/${deltaAssetMeta.filename}"`
        );
      }

      verifySteps.push(
        `sudo mv -vf "${remoteTmpDir}/${indexFileName}" "${args.vpsReleasesDir}/${indexFileName}"`,
        `sudo mv -vf "${remoteTmpDir}/${sigFileName}" "${args.vpsReleasesDir}/${sigFileName}"`,
        `sudo chown -R decentraupdate:decentraupdate "${args.vpsReleasesDir}" 2>/dev/null || true`,
        `sudo rm -rf "${remoteTmpDir}"`,
        `sudo -n systemctl restart decentraupdate-seeder.service 2>/dev/null || sudo -n systemctl reload-or-restart decentraupdate-seeder.service 2>/dev/null || pkill -HUP -f seeder-daemon.js 2>/dev/null || true`
      );

      const verifyCmd = verifySteps.join(' && ');

      const verifyRes = spawnSync('ssh', [...sshArgsBase, sshHost, verifyCmd], {
        encoding: 'utf8'
      });

      if (verifyRes.status !== 0) {
        const errorDetail = (verifyRes.stderr || '') + (verifyRes.stdout || '') || `Exit code ${verifyRes.status}`;
        throw new Error(`Remote VPS verification/commit failed:\n${errorDetail.trim()}`);
      }

      console.log(`[P2P Publish] VPS package verified (SHA-256 matched) and seeder reloaded.`);
    } catch (vpsErr) {
      console.warn(
        `[P2P Publish Warning] Optional VPS upload failed (${vpsErr.message}). S3 release remains 100% operational.`
      );
      if (!args.nonFatal) throw vpsErr;
    }
  }
}

run().catch((err) => {
  const nonFatal = process.argv.includes('--non-fatal');
  if (nonFatal) {
    console.warn(`[P2P Publish Warning] Non-fatal P2P step skipped: ${err.message}`);
    process.exit(0);
  }
  console.error(`[P2P Publish Error] ${err.message}`);
  process.exit(1);
});
