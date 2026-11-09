import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isValidPackageFilename, computeFileHashesAndChunks } from './signed-release-index.js';

export const DEFAULT_MAX_CACHE_BYTES = 600 * 1024 * 1024; // 600 MiB default cache cap

export class VerifiedCache {
  constructor({ cacheDir, maxCacheBytes = DEFAULT_MAX_CACHE_BYTES } = {}) {
    if (!cacheDir) {
      throw new Error('VerifiedCache requires a cacheDir');
    }
    this.cacheDir = path.resolve(cacheDir);
    this.stagingDir = path.join(this.cacheDir, 'staging');
    this.verifiedDir = path.join(this.cacheDir, 'verified');
    this.stateDir = path.join(this.cacheDir, 'state');
    this.maxCacheBytes = Number(maxCacheBytes) > 0 ? Number(maxCacheBytes) : DEFAULT_MAX_CACHE_BYTES;
    this.authorizedPackages = new Map(); // key: `${version}:${sha256}` -> metadata
    this._ensureDirsSync();
    this._loadAuthorizedCatalogSync();
  }

  _ensureDirsSync() {
    for (const dir of [this.cacheDir, this.stagingDir, this.verifiedDir, this.stateDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      } else {
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink()) {
          throw new Error(`Security violation: cache directory is a symbolic link: ${dir}`);
        }
      }
    }
  }

  _catalogFilePath() {
    return path.join(this.stateDir, 'verified-catalog.json');
  }

  _loadAuthorizedCatalogSync() {
    const file = this._catalogFilePath();
    if (!fs.existsSync(file)) return;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw.packages)) {
        for (const item of raw.packages) {
          if (item && item.version && item.sha256 && isValidPackageFilename(item.filename)) {
            const verifiedPath = this._safeJoin(this.verifiedDir, item.filename);
            if (fs.existsSync(verifiedPath) && !fs.lstatSync(verifiedPath).isSymbolicLink()) {
              const key = `${item.version}:${item.sha256.toLowerCase()}`;
              this.authorizedPackages.set(key, {
                ...item,
                sha256: item.sha256.toLowerCase(),
                verifiedPath
              });
            }
          }
        }
      }
    } catch {
      // Ignore corrupt catalog file; will be rebuilt on verification
    }
  }

  _saveAuthorizedCatalogSync() {
    const file = this._catalogFilePath();
    const packages = Array.from(this.authorizedPackages.values()).map((entry) => ({
      appId: entry.appId || 'SA-CHAOS',
      channel: entry.channel || 'win',
      version: entry.version,
      filename: entry.filename,
      size: entry.size,
      sha256: entry.sha256,
      sha1: entry.sha1 || '',
      chunkSize: entry.chunkSize,
      chunkSha256: entry.chunkSha256,
      verifiedAt: entry.verifiedAt || new Date().toISOString()
    }));
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ packages }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  _safeJoin(baseDir, filename) {
    if (!isValidPackageFilename(filename)) {
      throw new Error(`Rejected unsafe package filename: ${filename}`);
    }
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(baseDir, filename);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Path traversal rejected: ${filename}`);
    }
    return resolvedTarget;
  }

  _assertNotSymlinkIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Security violation: symbolic link detected at ${targetPath}`);
      }
    }
  }

  setMaxCacheBytes(bytes) {
    if (Number.isFinite(bytes) && bytes > 0) {
      this.maxCacheBytes = bytes;
    }
  }

  getCacheUsageBytes() {
    let total = 0;
    for (const dir of [this.stagingDir, this.verifiedDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        try {
          const st = fs.lstatSync(p);
          if (st.isFile() && !st.isSymbolicLink()) {
            total += st.size;
          }
        } catch {
          // ignore
        }
      }
    }
    return total;
  }

  /**
   * Enforces maxCacheBytes by pruning older staging/verified files while preserving
   * the currently active filename if specified.
   */
  enforceQuota(requiredBytes = 0, preserveFilename = null) {
    if (requiredBytes > this.maxCacheBytes) {
      throw new Error(
        `Package size (${requiredBytes} bytes) exceeds maximum cache quota (${this.maxCacheBytes} bytes)`
      );
    }

    const collectEntries = (dir, isStaging) => {
      if (!fs.existsSync(dir)) return [];
      const list = [];
      for (const name of fs.readdirSync(dir)) {
        if (preserveFilename && name.startsWith(preserveFilename)) continue;
        const fullPath = path.join(dir, name);
        try {
          const st = fs.lstatSync(fullPath);
          if (st.isFile() && !st.isSymbolicLink()) {
            list.push({ name, fullPath, size: st.size, mtimeMs: st.mtimeMs, isStaging });
          }
        } catch {
          // ignore
        }
      }
      return list;
    };

    let currentUsage = this.getCacheUsageBytes();
    if (currentUsage + requiredBytes <= this.maxCacheBytes) {
      return;
    }

    // Evict staging files first, then oldest verified packages
    const candidates = [
      ...collectEntries(this.stagingDir, true),
      ...collectEntries(this.verifiedDir, false)
    ].sort((a, b) => {
      if (a.isStaging !== b.isStaging) return a.isStaging ? -1 : 1;
      return a.mtimeMs - b.mtimeMs;
    });

    for (const item of candidates) {
      if (currentUsage + requiredBytes <= this.maxCacheBytes) break;
      try {
        fs.unlinkSync(item.fullPath);
        currentUsage -= item.size;
        if (!item.isStaging) {
          for (const [key, meta] of this.authorizedPackages.entries()) {
            if (meta.filename === item.name) {
              this.authorizedPackages.delete(key);
            }
          }
        }
      } catch {
        // ignore deletion error
      }
    }
    this._saveAuthorizedCatalogSync();
  }

  /**
   * Checks if the verified package already exists on disk and passes full SHA-256 check.
   */
  async getVerifiedPackageIfPresent(version, assetMeta) {
    const filename = assetMeta.filename;
    const expectedSha256 = String(assetMeta.sha256).toLowerCase();
    const expectedSize = Number(assetMeta.size);
    const verifiedPath = this._safeJoin(this.verifiedDir, filename);
    this._assertNotSymlinkIfExists(verifiedPath);

    if (!fs.existsSync(verifiedPath)) {
      return null;
    }

    const stat = await fs.promises.lstat(verifiedPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedSize) {
      return null;
    }

    const hashes = await computeFileHashesAndChunks(verifiedPath, assetMeta.chunkSize);
    if (hashes.sha256 !== expectedSha256) {
      try {
        await fs.promises.unlink(verifiedPath);
      } catch {
        // ignore
      }
      return null;
    }

    const record = {
      appId: 'SA-CHAOS',
      channel: 'win',
      version: String(version),
      filename,
      size: hashes.size,
      sha256: hashes.sha256,
      sha1: hashes.sha1,
      chunkSize: assetMeta.chunkSize,
      chunkSha256: hashes.chunkSha256,
      verifiedPath,
      verifiedAt: new Date().toISOString()
    };
    this.authorizedPackages.set(`${version}:${expectedSha256}`, record);
    this._saveAuthorizedCatalogSync();
    return record;
  }

  /**
   * Initializes or resumes a staging session for a package described by SignedP2PReleaseIndex.
   */
  async openStagingSession(version, assetMeta) {
    this._ensureDirsSync();
    const filename = assetMeta.filename;
    const expectedSha256 = String(assetMeta.sha256).toLowerCase();
    const expectedSize = Number(assetMeta.size);
    const chunkSize = Number(assetMeta.chunkSize);
    const chunkSha256 = assetMeta.chunkSha256.map((h) => String(h).toLowerCase());
    const totalChunks = chunkSha256.length;

    const partPath = path.join(this.stagingDir, `${filename}.part`);
    const bitmapPath = path.join(this.stagingDir, `${filename}.bitmap.json`);
    this._assertNotSymlinkIfExists(partPath);
    this._assertNotSymlinkIfExists(bitmapPath);

    this.enforceQuota(expectedSize, filename);

    let completedChunks = new Array(totalChunks).fill(false);

    if (fs.existsSync(partPath) && fs.existsSync(bitmapPath)) {
      try {
        const saved = JSON.parse(await fs.promises.readFile(bitmapPath, 'utf8'));
        const partStat = await fs.promises.lstat(partPath);
        if (
          !partStat.isSymbolicLink() &&
          saved.sha256 === expectedSha256 &&
          saved.size === expectedSize &&
          saved.chunkSize === chunkSize &&
          Array.isArray(saved.completedChunks) &&
          saved.completedChunks.length === totalChunks
        ) {
          // Re-verify existing completed chunks on disk before trusting resume state
          const fd = await fs.promises.open(partPath, 'r');
          try {
            for (let i = 0; i < totalChunks; i++) {
              if (!saved.completedChunks[i]) continue;
              const offset = i * chunkSize;
              const expectedChunkLen = Math.min(chunkSize, expectedSize - offset);
              if (offset + expectedChunkLen > partStat.size) {
                completedChunks[i] = false;
                continue;
              }
              const buf = Buffer.allocUnsafe(expectedChunkLen);
              const { bytesRead } = await fd.read(buf, 0, expectedChunkLen, offset);
              if (bytesRead === expectedChunkLen) {
                const actualHash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
                completedChunks[i] = actualHash === chunkSha256[i];
              }
            }
          } finally {
            await fd.close();
          }
        }
      } catch {
        completedChunks = new Array(totalChunks).fill(false);
      }
    }

    if (!fs.existsSync(partPath)) {
      const fd = await fs.promises.open(partPath, 'w');
      await fd.close();
    }

    const saveBitmap = async () => {
      const tmp = `${bitmapPath}.tmp.${process.pid}`;
      await fs.promises.writeFile(
        tmp,
        JSON.stringify({
          version: String(version),
          filename,
          sha256: expectedSha256,
          size: expectedSize,
          chunkSize,
          completedChunks
        }),
        'utf8'
      );
      await fs.promises.rename(tmp, bitmapPath);
    };

    await saveBitmap();

    return {
      version: String(version),
      filename,
      expectedSha256,
      expectedSize,
      chunkSize,
      chunkSha256,
      totalChunks,
      completedChunks,
      partPath,
      bitmapPath,
      getMissingChunkIndices() {
        const missing = [];
        for (let i = 0; i < totalChunks; i++) {
          if (!completedChunks[i]) missing.push(i);
        }
        return missing;
      },
      getCompletedByteCount() {
        let bytes = 0;
        for (let i = 0; i < totalChunks; i++) {
          if (completedChunks[i]) {
            const offset = i * chunkSize;
            bytes += Math.min(chunkSize, expectedSize - offset);
          }
        }
        return bytes;
      },
      writeVerifiedChunk: async (chunkIndex, chunkBuffer) => {
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
          throw new Error(`Out-of-range chunkIndex: ${chunkIndex}`);
        }
        const offset = chunkIndex * chunkSize;
        const expectedLen = Math.min(chunkSize, expectedSize - offset);
        if (!Buffer.isBuffer(chunkBuffer) || chunkBuffer.length !== expectedLen) {
          throw new Error(
            `Chunk ${chunkIndex} size mismatch: expected ${expectedLen} bytes, received ${
              chunkBuffer ? chunkBuffer.length : 0
            }`
          );
        }

        const actualChunkHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex').toLowerCase();
        if (actualChunkHash !== chunkSha256[chunkIndex]) {
          throw new Error(
            `Chunk ${chunkIndex} SHA-256 verification failed: expected ${chunkSha256[chunkIndex]}, got ${actualChunkHash}`
          );
        }

        this._assertNotSymlinkIfExists(partPath);
        const fd = await fs.promises.open(partPath, 'r+');
        try {
          await fd.write(chunkBuffer, 0, chunkBuffer.length, offset);
          await fd.datasync();
        } finally {
          await fd.close();
        }

        completedChunks[chunkIndex] = true;
        await saveBitmap();
        return chunkBuffer.length;
      },
      finalizeAndCommit: async () => {
        for (let i = 0; i < totalChunks; i++) {
          if (!completedChunks[i]) {
            throw new Error(`Cannot finalize package: chunk ${i} of ${totalChunks} is still missing`);
          }
        }

        this._assertNotSymlinkIfExists(partPath);
        const hashes = await computeFileHashesAndChunks(partPath, chunkSize);
        if (hashes.size !== expectedSize) {
          throw new Error(`Whole-file size mismatch: expected ${expectedSize}, got ${hashes.size}`);
        }
        if (hashes.sha256 !== expectedSha256) {
          throw new Error(`Whole-file SHA-256 mismatch: expected ${expectedSha256}, got ${hashes.sha256}`);
        }

        const verifiedPath = this._safeJoin(this.verifiedDir, filename);
        this._assertNotSymlinkIfExists(verifiedPath);

        // Atomic commit from staging to verified directory
        await fs.promises.rename(partPath, verifiedPath);
        if (fs.existsSync(bitmapPath)) {
          try {
            await fs.promises.unlink(bitmapPath);
          } catch {
            // ignore
          }
        }

        const record = {
          appId: 'SA-CHAOS',
          channel: 'win',
          version: String(version),
          filename,
          size: hashes.size,
          sha256: hashes.sha256,
          sha1: hashes.sha1,
          chunkSize,
          chunkSha256: hashes.chunkSha256,
          verifiedPath,
          verifiedAt: new Date().toISOString()
        };

        this.authorizedPackages.set(`${version}:${expectedSha256}`, record);
        this._saveAuthorizedCatalogSync();
        return record;
      },
      abortAndCleanStaging: async () => {
        for (const p of [partPath, bitmapPath]) {
          if (fs.existsSync(p)) {
            try {
              await fs.promises.unlink(p);
            } catch {
              // ignore
            }
          }
        }
      }
    };
  }

  /**
   * Imports an already-existing package file into the VerifiedCache after full verification
   * against a verified SignedP2PReleaseIndex. Used by VPS seeder and local peer seeding tests.
   */
  async importVerifiedPackageFile(sourceFilePath, version, assetMeta) {
    const filename = assetMeta.filename;
    if (!isValidPackageFilename(filename)) {
      throw new Error(`Unsafe filename: ${filename}`);
    }
    const stat = await fs.promises.lstat(sourceFilePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Source package must be a regular file');
    }

    const hashes = await computeFileHashesAndChunks(sourceFilePath, assetMeta.chunkSize);
    const expectedSha256 = String(assetMeta.sha256).toLowerCase();
    if (hashes.size !== assetMeta.size || hashes.sha256 !== expectedSha256) {
      throw new Error(
        `Source package verification failed: expected size=${assetMeta.size} sha256=${expectedSha256}, got size=${hashes.size} sha256=${hashes.sha256}`
      );
    }

    this.enforceQuota(hashes.size, filename);
    const verifiedPath = this._safeJoin(this.verifiedDir, filename);
    this._assertNotSymlinkIfExists(verifiedPath);

    if (path.resolve(sourceFilePath) !== path.resolve(verifiedPath)) {
      const tmpDest = `${verifiedPath}.tmp.${process.pid}`;
      await fs.promises.copyFile(sourceFilePath, tmpDest);
      await fs.promises.rename(tmpDest, verifiedPath);
    }

    const record = {
      appId: 'SA-CHAOS',
      channel: 'win',
      version: String(version),
      filename,
      size: hashes.size,
      sha256: hashes.sha256,
      sha1: hashes.sha1,
      chunkSize: assetMeta.chunkSize,
      chunkSha256: hashes.chunkSha256,
      verifiedPath,
      verifiedAt: new Date().toISOString()
    };

    this.authorizedPackages.set(`${version}:${expectedSha256}`, record);
    this._saveAuthorizedCatalogSync();
    return record;
  }

  /**
   * Checks if this node has an authorized, verified package ready to seed.
   */
  getAuthorizedPackage({ version, filename, sha256 }) {
    if (!version || !sha256) return null;
    const key = `${version}:${String(sha256).toLowerCase()}`;
    const record = this.authorizedPackages.get(key);
    if (!record) return null;
    if (filename && record.filename !== filename) return null;
    if (!fs.existsSync(record.verifiedPath)) {
      this.authorizedPackages.delete(key);
      return null;
    }
    try {
      const st = fs.lstatSync(record.verifiedPath);
      if (st.isSymbolicLink() || st.size !== record.size) {
        this.authorizedPackages.delete(key);
        return null;
      }
    } catch {
      return null;
    }
    return record;
  }

  /**
   * Reads a single authorized chunk from a verified package for seeding.
   * Never reads arbitrary file paths.
   */
  async readAuthorizedChunk({ version, filename, sha256, chunkIndex }) {
    const record = this.getAuthorizedPackage({ version, filename, sha256 });
    if (!record) {
      throw new Error('Requested package is not in the verified seeder catalog');
    }
    const totalChunks = record.chunkSha256.length;
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new Error(`Invalid chunkIndex ${chunkIndex} (totalChunks=${totalChunks})`);
    }

    const offset = chunkIndex * record.chunkSize;
    const length = Math.min(record.chunkSize, record.size - offset);
    const buffer = Buffer.allocUnsafe(length);

    const fd = await fs.promises.open(record.verifiedPath, 'r');
    try {
      const { bytesRead } = await fd.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(`Short read on verified package chunk ${chunkIndex}`);
      }
    } finally {
      await fd.close();
    }

    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
    if (actualHash !== record.chunkSha256[chunkIndex]) {
      throw new Error(`Local verified cache corruption detected on chunk ${chunkIndex}`);
    }

    return {
      chunkIndex,
      byteLength: buffer.length,
      chunkSha256: actualHash,
      buffer
    };
  }
}
