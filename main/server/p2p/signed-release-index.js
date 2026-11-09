import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { canonicalizeJson, canonicalizeJsonBuffer } from './canonical-json.js';

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
export const MAX_ALLOWED_PACKAGE_SIZE = 1024 * 1024 * 1024; // 1 GiB upper bound
export const ALLOWED_FILENAME_REGEX = /^[A-Za-z0-9._-]+-(full|delta)\.nupkg$/;
export const HEX_SHA256_REGEX = /^[a-fA-F0-9]{64}$/;

/**
 * Pinned Publisher Ed25519 Public Keys (SPKI PEM).
 * Supports key rotation via signingKeyId lookup.
 * Note: Private keys NEVER exist in client code or on the VPS.
 */
export const DEFAULT_TRUSTED_PUBLISHER_KEYS = Object.freeze({
  'publisher-2026': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoQpReILU0533jgiNlreMpBebnbM+LaqdfzaBIkZPCw8=
-----END PUBLIC KEY-----`
});

export function isValidPackageFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 180) {
    return false;
  }
  if (path.basename(filename) !== filename) {
    return false;
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    return false;
  }
  return ALLOWED_FILENAME_REGEX.test(filename);
}

export function compareSemverOrSequence(verA, verB) {
  const cleanA = String(verA || '').trim().replace(/^v/i, '');
  const cleanB = String(verB || '').trim().replace(/^v/i, '');
  const partsA = cleanA.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const partsB = cleanB.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const a = partsA[i] ?? 0;
    const b = partsB[i] ?? 0;
    if (typeof a === 'number' && typeof b === 'number') {
      if (a > b) return 1;
      if (a < b) return -1;
    } else {
      const sA = String(a);
      const sB = String(b);
      if (sA > sB) return 1;
      if (sA < sB) return -1;
    }
  }
  return 0;
}

export function versionToSequence(versionStr) {
  const parts = String(versionStr || '0.0.0')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  return major * 1000000 + minor * 1000 + patch;
}

export function generatePublisherKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export async function computeFileHashesAndChunks(filePath, chunkSize = DEFAULT_CHUNK_SIZE) {
  const stat = await fs.promises.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Target package must be a regular file (symlinks prohibited)');
  }
  const wholeSha256 = crypto.createHash('sha256');
  const wholeSha1 = crypto.createHash('sha1');
  const chunkSha256 = [];

  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(chunkSize, stat.size - offset);
      const { bytesRead } = await fd.read(buf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      const slice = buf.subarray(0, bytesRead);
      wholeSha256.update(slice);
      wholeSha1.update(slice);
      chunkSha256.push(crypto.createHash('sha256').update(slice).digest('hex').toLowerCase());
      offset += bytesRead;
    }
  } finally {
    await fd.close();
  }

  return {
    size: stat.size,
    sha256: wholeSha256.digest('hex').toLowerCase(),
    sha1: wholeSha1.digest('hex').toUpperCase(),
    chunkSize,
    chunkSha256
  };
}

export async function createSignedP2PReleaseIndex({
  packagePath,
  deltaPackagePath = null,
  packages = null,
  appId = 'SA-CHAOS',
  platform = 'win',
  arch = 'x64',
  channel = 'win',
  version,
  sequence,
  issuedAt = new Date().toISOString(),
  expiresInDays = 14,
  expiresAt,
  chunkSize = DEFAULT_CHUNK_SIZE,
  signingKeyId = 'publisher-2026',
  privateKeyPem
}) {
  const assetEntries = [];

  const addPackage = async (filePath, type) => {
    const fn = path.basename(filePath);
    if (!isValidPackageFilename(fn)) {
      throw new Error(`Invalid package filename for P2P release index: ${fn}`);
    }
    const hashes = await computeFileHashesAndChunks(filePath, chunkSize);
    assetEntries.push({
      filename: fn,
      type,
      size: hashes.size,
      sha1: hashes.sha1,
      sha256: hashes.sha256,
      chunkSize: hashes.chunkSize,
      chunkSha256: hashes.chunkSha256
    });
  };

  if (Array.isArray(packages) && packages.length > 0) {
    for (const pkg of packages) {
      const p = pkg.path || pkg.filePath;
      const t = pkg.type || (p.includes('-delta.') ? 'Delta' : 'Full');
      await addPackage(p, t);
    }
  } else {
    if (!packagePath) {
      throw new Error('createSignedP2PReleaseIndex requires packagePath (or packages)');
    }
    await addPackage(packagePath, 'Full');
    if (deltaPackagePath) {
      await addPackage(deltaPackagePath, 'Delta');
    }
  }

  const issuedDate = new Date(issuedAt);
  const expiryDate = expiresAt
    ? new Date(expiresAt)
    : new Date(issuedDate.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

  const indexPayload = {
    schemaVersion: 1,
    appId,
    platform,
    arch,
    channel,
    version: String(version),
    sequence: typeof sequence === 'number' ? sequence : versionToSequence(version),
    issuedAt: issuedDate.toISOString(),
    expiresAt: expiryDate.toISOString(),
    assets: assetEntries,
    signingKeyId
  };

  const canonicalBytes = canonicalizeJsonBuffer(indexPayload);
  const signatureBytes = crypto.sign(null, canonicalBytes, privateKeyPem);
  const signatureBase64 = signatureBytes.toString('base64');

  return {
    index: indexPayload,
    canonicalJson: canonicalizeJson(indexPayload),
    signature: signatureBase64,
    signatureFileContent: JSON.stringify(
      {
        schemaVersion: 1,
        signingKeyId,
        algorithm: 'Ed25519',
        canonicalization: 'RFC8785-JCS',
        signature: signatureBase64
      },
      null,
      2
    )
  };
}

export function extractSignatureBase64(sigInput) {
  if (!sigInput) {
    throw new Error('Missing signature input');
  }
  if (typeof sigInput === 'object' && typeof sigInput.signature === 'string') {
    return sigInput.signature.trim();
  }
  const raw = String(sigInput).trim();
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (typeof parsed.signature !== 'string' || !parsed.signature.trim()) {
      throw new Error('Invalid JSON signature sidecar: missing signature field');
    }
    return parsed.signature.trim();
  }
  return raw;
}

/**
 * Validates a SignedP2PReleaseIndex against:
 * 1. Ed25519 cryptographic signature over RFC 8785 canonical JSON using pinned publisher keys.
 * 2. Structural schema, filename allowlist, chunk hash count, size limits.
 * 3. Expiry window and anti-rollback sequence/version state.
 * 4. Exact match with the authoritative S3 release metadata (version, size, SHA-256, filename).
 */
export function verifySignedP2PReleaseIndex({
  indexInput,
  signatureInput,
  expectedAppId = 'SA-CHAOS',
  expectedPlatform = 'win',
  expectedArch = 'x64',
  expectedChannel = 'win',
  authoritativeS3Release = null,
  authoritativeS3DeltaRelease = null,
  minSequence = 0,
  minVersion = null,
  trustedKeys = DEFAULT_TRUSTED_PUBLISHER_KEYS,
  now = new Date()
}) {
  let indexObj = indexInput;
  if (typeof indexInput === 'string') {
    indexObj = JSON.parse(indexInput);
  }
  if (!indexObj || typeof indexObj !== 'object' || Array.isArray(indexObj)) {
    throw new Error('Invalid P2P release index: must be a JSON object');
  }

  if (indexObj.schemaVersion !== 1) {
    throw new Error(`Unsupported P2P release index schemaVersion: ${indexObj.schemaVersion}`);
  }

  const signingKeyId = indexObj.signingKeyId;
  if (typeof signingKeyId !== 'string' || !signingKeyId.trim()) {
    throw new Error('Missing signingKeyId in P2P release index');
  }

  const publicKeyPem = trustedKeys[signingKeyId];
  if (!publicKeyPem) {
    throw new Error(`Untrusted or unknown signingKeyId: ${signingKeyId}`);
  }

  const sigBase64 = extractSignatureBase64(signatureInput);
  const sigBuf = Buffer.from(sigBase64, 'base64');
  if (sigBuf.length !== 64) {
    throw new Error(`Invalid Ed25519 signature length: expected 64 bytes, got ${sigBuf.length}`);
  }

  const canonicalBytes = canonicalizeJsonBuffer(indexObj);
  const isSignatureValid = crypto.verify(null, canonicalBytes, publicKeyPem, sigBuf);
  if (!isSignatureValid) {
    throw new Error('Ed25519 signature verification failed for P2P release index');
  }

  // Identity & channel checks
  const normalizedExpectedAppId = String(expectedAppId).toLowerCase();
  const normalizedActualAppId = String(indexObj.appId || '').toLowerCase();
  if (
    normalizedActualAppId !== normalizedExpectedAppId &&
    !(normalizedExpectedAppId === 'sa-chaos' && normalizedActualAppId === 'com.sachaos.desktop')
  ) {
    throw new Error(`appId mismatch: expected ${expectedAppId}, got ${indexObj.appId}`);
  }
  if (indexObj.platform !== expectedPlatform) {
    throw new Error(`platform mismatch: expected ${expectedPlatform}, got ${indexObj.platform}`);
  }
  if (indexObj.arch !== expectedArch) {
    throw new Error(`arch mismatch: expected ${expectedArch}, got ${indexObj.arch}`);
  }
  if (indexObj.channel !== expectedChannel) {
    throw new Error(`channel mismatch: expected ${expectedChannel}, got ${indexObj.channel}`);
  }

  if (typeof indexObj.version !== 'string' || !/^\d+\.\d+\.\d+/.test(indexObj.version)) {
    throw new Error(`Invalid version format in P2P release index: ${indexObj.version}`);
  }

  if (!Number.isInteger(indexObj.sequence) || indexObj.sequence < 0) {
    throw new Error(`Invalid sequence number in P2P release index: ${indexObj.sequence}`);
  }

  // Anti-rollback checks
  if (indexObj.sequence < minSequence) {
    throw new Error(`Rollback rejected: index sequence ${indexObj.sequence} < minimum seen sequence ${minSequence}`);
  }
  if (minVersion && compareSemverOrSequence(indexObj.version, minVersion) < 0) {
    throw new Error(`Version rollback rejected: index version ${indexObj.version} < minimum version ${minVersion}`);
  }

  // Timestamp & Expiration validation
  const issuedMs = Date.parse(indexObj.issuedAt);
  const expiresMs = Date.parse(indexObj.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const clockSkewAllowanceMs = 5 * 60 * 1000; // 5 minutes

  if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs)) {
    throw new Error('Invalid issuedAt or expiresAt timestamp in P2P release index');
  }
  if (expiresMs <= issuedMs) {
    throw new Error('Invalid P2P release index: expiresAt must be after issuedAt');
  }
  if (nowMs + clockSkewAllowanceMs < issuedMs) {
    throw new Error(`P2P release index issuedAt is in the future: ${indexObj.issuedAt}`);
  }
  if (nowMs > expiresMs) {
    throw new Error(`P2P release index has expired at ${indexObj.expiresAt}`);
  }

  // Asset validation (Full and optional Delta)
  if (!Array.isArray(indexObj.assets) || indexObj.assets.length === 0) {
    throw new Error('P2P release index contains no assets');
  }

  const validateAssetEntry = (assetItem) => {
    if (!assetItem || typeof assetItem !== 'object') {
      throw new Error('Invalid asset entry: must be an object');
    }
    if (!isValidPackageFilename(assetItem.filename)) {
      throw new Error(`Rejected unsafe or non-allowlisted asset filename: ${assetItem.filename}`);
    }
    if (!Number.isInteger(assetItem.size) || assetItem.size <= 0 || assetItem.size > MAX_ALLOWED_PACKAGE_SIZE) {
      throw new Error(`Invalid asset size: ${assetItem.size}`);
    }
    if (typeof assetItem.sha256 !== 'string' || !HEX_SHA256_REGEX.test(assetItem.sha256)) {
      throw new Error('Invalid asset sha256 digest format');
    }
    if (!Number.isInteger(assetItem.chunkSize) || assetItem.chunkSize < 64 * 1024 || assetItem.chunkSize > 16 * 1024 * 1024) {
      throw new Error(`Invalid chunkSize: ${assetItem.chunkSize}`);
    }
    const expectedChunkCount = Math.ceil(assetItem.size / assetItem.chunkSize);
    if (!Array.isArray(assetItem.chunkSha256) || assetItem.chunkSha256.length !== expectedChunkCount) {
      throw new Error(
        `Invalid chunkSha256 count for ${assetItem.filename}: expected ${expectedChunkCount}, got ${
          Array.isArray(assetItem.chunkSha256) ? assetItem.chunkSha256.length : 'non-array'
        }`
      );
    }
    for (let i = 0; i < assetItem.chunkSha256.length; i++) {
      if (typeof assetItem.chunkSha256[i] !== 'string' || !HEX_SHA256_REGEX.test(assetItem.chunkSha256[i])) {
        throw new Error(`Invalid chunkSha256 format for ${assetItem.filename} at chunk ${i}`);
      }
    }
  };

  for (const a of indexObj.assets) {
    validateAssetEntry(a);
  }

  const fullAssets = indexObj.assets.filter((a) => a && a.type === 'Full');
  if (fullAssets.length !== 1) {
    throw new Error(`Expected exactly 1 Full asset in P2P release index, found ${fullAssets.length}`);
  }
  const fullAsset = fullAssets[0];

  const deltaAssets = indexObj.assets.filter((a) => a && a.type === 'Delta');
  if (deltaAssets.length > 1) {
    throw new Error(`Expected at most 1 Delta asset in P2P release index, found ${deltaAssets.length}`);
  }
  const deltaAsset = deltaAssets.length === 1 ? deltaAssets[0] : null;

  // Authoritative S3 Cross-Check (Mandatory when S3 metadata is provided)
  if (authoritativeS3Release) {
    const s3Version = authoritativeS3Release.Version || authoritativeS3Release.version;
    const s3FileName = authoritativeS3Release.FileName || authoritativeS3Release.filename;
    const s3Size = authoritativeS3Release.Size ?? authoritativeS3Release.size;
    const s3Sha256 = authoritativeS3Release.SHA256 || authoritativeS3Release.sha256;

    if (s3Version && String(s3Version) !== indexObj.version) {
      throw new Error(`S3 version mismatch: S3 selected ${s3Version}, P2P index has ${indexObj.version}`);
    }
    if (s3FileName && String(s3FileName) !== fullAsset.filename) {
      throw new Error(`S3 filename mismatch: S3 expects ${s3FileName}, P2P index has ${fullAsset.filename}`);
    }
    if (typeof s3Size === 'number' && s3Size > 0 && s3Size !== fullAsset.size) {
      throw new Error(`S3 size mismatch: S3 expects ${s3Size}, P2P index has ${fullAsset.size}`);
    }
    if (s3Sha256 && String(s3Sha256).toLowerCase() !== fullAsset.sha256.toLowerCase()) {
      throw new Error(`S3 SHA-256 mismatch: S3 expects ${s3Sha256}, P2P index has ${fullAsset.sha256}`);
    }
  }

  if (authoritativeS3DeltaRelease && deltaAsset) {
    const s3DeltaFileName = authoritativeS3DeltaRelease.FileName || authoritativeS3DeltaRelease.filename;
    const s3DeltaSize = authoritativeS3DeltaRelease.Size ?? authoritativeS3DeltaRelease.size;
    const s3DeltaSha256 = authoritativeS3DeltaRelease.SHA256 || authoritativeS3DeltaRelease.sha256;

    if (s3DeltaFileName && String(s3DeltaFileName) !== deltaAsset.filename) {
      throw new Error(`S3 delta filename mismatch: S3 expects ${s3DeltaFileName}, P2P index has ${deltaAsset.filename}`);
    }
    if (typeof s3DeltaSize === 'number' && s3DeltaSize > 0 && s3DeltaSize !== deltaAsset.size) {
      throw new Error(`S3 delta size mismatch: S3 expects ${s3DeltaSize}, P2P index has ${deltaAsset.size}`);
    }
    if (s3DeltaSha256 && String(s3DeltaSha256).toLowerCase() !== deltaAsset.sha256.toLowerCase()) {
      throw new Error(`S3 delta SHA-256 mismatch: S3 expects ${s3DeltaSha256}, P2P index has ${deltaAsset.sha256}`);
    }
  }

  const normalizeAsset = (a) => ({
    ...a,
    sha256: a.sha256.toLowerCase(),
    chunkSha256: a.chunkSha256.map((h) => h.toLowerCase())
  });

  return {
    valid: true,
    index: indexObj,
    assets: indexObj.assets.map(normalizeAsset),
    fullAsset: normalizeAsset(fullAsset),
    deltaAsset: deltaAsset ? normalizeAsset(deltaAsset) : null
  };
}
