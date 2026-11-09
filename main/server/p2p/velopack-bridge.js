import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { UpdateManager } from 'velopack';
import { isValidPackageFilename } from './signed-release-index.js';

export const OFFICIAL_S3_UPDATE_URL = 'https://updater.sa-chaos.my.id/velopack.php/';

/**
 * ExistingS3UpdaterAdapter
 * Wraps the existing official S3 Velopack update flow without altering endpoints,
 * channels, or delta/full download behavior.
 */
export class ExistingS3UpdaterAdapter {
  constructor({
    updateUrl = OFFICIAL_S3_UPDATE_URL,
    UpdateManagerClass = UpdateManager,
    httpClient = axios,
    allowInsecureHttpForLocalTest = false
  } = {}) {
    this.updateUrl = updateUrl.endsWith('/') ? updateUrl : `${updateUrl}/`;
    this.UpdateManagerClass = UpdateManagerClass;
    this.httpClient = httpClient;
    this.allowInsecureHttpForLocalTest = allowInsecureHttpForLocalTest;
  }

  _assertSecureUrl(urlStr) {
    if (this.allowInsecureHttpForLocalTest) return;
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') {
      throw new Error(`Security policy violation: refusing non-HTTPS update metadata URL (${parsed.protocol})`);
    }
  }

  createS3UpdateManager() {
    this._assertSecureUrl(this.updateUrl);
    const um = new this.UpdateManagerClass();
    um.setUrlOrPath(this.updateUrl);
    return um;
  }

  /**
   * Checks for updates using the authoritative S3 endpoint.
   * Returns { updateAvailable, updateInfo, targetRelease, s3FeedAssets, s3Manager }.
   */
  async checkForUpdates() {
    const s3Manager = this.createS3UpdateManager();
    const isInstalled = typeof s3Manager.isInstalled === 'function' ? s3Manager.isInstalled() : true;
    if (!isInstalled) {
      return {
        isInstalled: false,
        updateAvailable: false,
        updateInfo: null,
        targetRelease: null,
        s3FeedAssets: [],
        s3Manager
      };
    }

    const updateInfo = await s3Manager.checkForUpdatesAsync();
    if (!updateInfo || !updateInfo.targetFullRelease) {
      return {
        isInstalled: true,
        updateAvailable: false,
        updateInfo: null,
        targetRelease: null,
        s3FeedAssets: [],
        s3Manager
      };
    }

    const targetRelease = updateInfo.targetFullRelease;
    let s3FeedAssets = [];
    try {
      const feedUrl = `${this.updateUrl}releases.win.json`;
      this._assertSecureUrl(feedUrl);
      const res = await this.httpClient.get(feedUrl, {
        headers: {
          'User-Agent': 'SA-CHAOS/1.1 (Windows NT 10.0; Win64; x64) Electron/Node.js SA-CHAOS'
        },
        timeout: 10000
      });
      if (res.data && Array.isArray(res.data.Assets)) {
        s3FeedAssets = res.data.Assets;
      }
    } catch {
      // Non-fatal if supplemental size lookup fails; Velopack already parsed updateInfo
    }

    return {
      isInstalled: true,
      updateAvailable: true,
      updateInfo,
      targetRelease,
      s3FeedAssets,
      s3Manager
    };
  }

  /**
   * Fetches the optional publisher-signed P2P sidecar index (p2p-index.win.json & p2p-index.win.sig)
   * from the official HTTPS S3 release endpoint.
   */
  async fetchSignedP2PIndex() {
    const indexUrl = `${this.updateUrl}p2p-index.win.json`;
    const sigUrl = `${this.updateUrl}p2p-index.win.sig`;
    this._assertSecureUrl(indexUrl);
    this._assertSecureUrl(sigUrl);

    const [indexRes, sigRes] = await Promise.all([
      this.httpClient.get(indexUrl, { timeout: 6000, responseType: 'text' }),
      this.httpClient.get(sigUrl, { timeout: 6000, responseType: 'text' })
    ]);

    const indexData = typeof indexRes.data === 'string' ? JSON.parse(indexRes.data) : indexRes.data;
    const sigData = sigRes.data;
    return {
      indexData,
      sigData
    };
  }

  /**
   * Executes the standard S3 download (including Velopack's native delta/full handling)
   * using a clean S3 UpdateManager operation.
   */
  async downloadFromS3({ s3Manager = null, updateInfo = null, deltaAsset = null, onProgress } = {}) {
    const manager = s3Manager || this.createS3UpdateManager();
    let activeUpdateInfo = updateInfo;

    // If no updateInfo was provided or a fresh manager was created for fallback, re-query S3 cleanly
    if (!activeUpdateInfo || !s3Manager) {
      activeUpdateInfo = await manager.checkForUpdatesAsync();
    }

    if (!activeUpdateInfo || !activeUpdateInfo.targetFullRelease) {
      throw new Error('No S3 update available during S3 download');
    }

    const targetRelease = activeUpdateInfo.targetFullRelease;
    const canUseDelta = Boolean(deltaAsset && (!activeUpdateInfo || !activeUpdateInfo.isDowngrade));
    const assetToDownload = canUseDelta
      ? {
          ...targetRelease,
          fileName: deltaAsset.FileName || deltaAsset.fileName,
          FileName: deltaAsset.FileName || deltaAsset.fileName,
          size: BigInt(deltaAsset.Size || deltaAsset.size || 0),
          Size: deltaAsset.Size || deltaAsset.size,
          sha1: deltaAsset.SHA1 || deltaAsset.sha1
        }
      : targetRelease;

    await manager.downloadUpdatesAsync(assetToDownload, (progressPercent) => {
      onProgress?.({
        percent: Number(progressPercent) || 0,
        targetRelease
      });
    });

    return {
      manager,
      updateInfo: activeUpdateInfo,
      targetRelease: assetToDownload
    };
  }

  /**
   * Applies a downloaded S3 update using the exact S3 UpdateManager instance that downloaded it.
   */
  applyDownloadedS3Update({ manager, targetRelease, waitExit = false, restartArgs = [] }) {
    if (!manager || !targetRelease) {
      throw new Error('applyDownloadedS3Update requires manager and targetRelease');
    }
    if (waitExit && typeof manager.waitExitThenApplyUpdates === 'function') {
      manager.waitExitThenApplyUpdates(targetRelease, false, true, restartArgs);
    } else {
      manager.applyUpdatesAndRestart(targetRelease, restartArgs);
    }
  }
}

/**
 * VelopackLocalSourceAdapter
 * Prepares a clean, isolated local Velopack release directory containing ONLY the verified
 * Full .nupkg package, a matching releases.win.json (no delta references), and RELEASES file.
 * Uses a dedicated local UpdateManager instance so UpdateInfo objects are never mixed across managers.
 */
export class VelopackLocalSourceAdapter {
  constructor({
    baseLocalFeedDir,
    packageId = 'SA-CHAOS',
    UpdateManagerClass = UpdateManager
  } = {}) {
    if (!baseLocalFeedDir) {
      throw new Error('VelopackLocalSourceAdapter requires baseLocalFeedDir');
    }
    this.baseLocalFeedDir = path.resolve(baseLocalFeedDir);
    this.packageId = packageId;
    this.UpdateManagerClass = UpdateManagerClass;
  }

  /**
   * Prepares the local feed folder for a verified P2P full package.
   */
  async prepareLocalFeedDirectory(verifiedRecord, companionFullAsset = null) {
    if (!verifiedRecord || !verifiedRecord.verifiedPath || !verifiedRecord.filename) {
      throw new Error('Invalid verifiedRecord passed to prepareLocalFeedDirectory');
    }
    if (!isValidPackageFilename(verifiedRecord.filename)) {
      throw new Error(`Unsafe package filename in local feed adapter: ${verifiedRecord.filename}`);
    }

    const versionStr = String(verifiedRecord.version).replace(/[^0-9A-Za-z._-]/g, '');
    const versionFeedDir = path.join(this.baseLocalFeedDir, versionStr);

    if (fs.existsSync(versionFeedDir)) {
      const st = await fs.promises.lstat(versionFeedDir);
      if (st.isSymbolicLink()) {
        throw new Error('Security violation: local feed directory is a symlink');
      }
      await fs.promises.rm(versionFeedDir, { recursive: true, force: true });
    }
    await fs.promises.mkdir(versionFeedDir, { recursive: true });

    const destNupkgPath = path.join(versionFeedDir, verifiedRecord.filename);
    try {
      await fs.promises.link(verifiedRecord.verifiedPath, destNupkgPath);
    } catch {
      await fs.promises.copyFile(verifiedRecord.verifiedPath, destNupkgPath);
    }

    // Re-verify the placed file hash before generating feed metadata
    const hash256 = crypto.createHash('sha256');
    const hash1 = crypto.createHash('sha1');
    const stat = await fs.promises.lstat(destNupkgPath);
    if (stat.isSymbolicLink() || stat.size !== verifiedRecord.size) {
      throw new Error('Local feed package size or symlink check failed');
    }

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(destNupkgPath);
      stream.on('data', (chunk) => {
        hash256.update(chunk);
        hash1.update(chunk);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });

    const actualSha256 = hash256.digest('hex').toLowerCase();
    const actualSha1 = hash1.digest('hex').toUpperCase();
    if (actualSha256 !== String(verifiedRecord.sha256).toLowerCase()) {
      throw new Error(
        `Local feed package SHA-256 mismatch: expected ${verifiedRecord.sha256}, got ${actualSha256}`
      );
    }

    const isDelta = verifiedRecord.filename.includes('-delta.') || verifiedRecord.type === 'Delta';
    const assetsList = [];

    if (isDelta && companionFullAsset) {
      assetsList.push({
        PackageId: this.packageId,
        Version: String(verifiedRecord.version),
        Type: 'Full',
        FileName: companionFullAsset.filename || companionFullAsset.FileName,
        SHA1: companionFullAsset.sha1 || companionFullAsset.SHA1 || '',
        SHA256: (companionFullAsset.sha256 || companionFullAsset.SHA256 || '').toUpperCase(),
        Size: companionFullAsset.size || companionFullAsset.Size || 0,
        NotesMarkdown: '',
        NotesHTML: ''
      });
    }

    assetsList.push({
      PackageId: this.packageId,
      Version: String(verifiedRecord.version),
      Type: isDelta ? 'Delta' : 'Full',
      FileName: verifiedRecord.filename,
      SHA1: actualSha1,
      SHA256: actualSha256.toUpperCase(),
      Size: verifiedRecord.size,
      NotesMarkdown: '',
      NotesHTML: ''
    });

    const releasesJson = { Assets: assetsList };

    const releasesJsonPath = path.join(versionFeedDir, 'releases.win.json');
    const legacyReleasesPath = path.join(versionFeedDir, 'RELEASES');

    let legacyReleasesContent = '';
    if (isDelta && companionFullAsset) {
      const fullSha1 = companionFullAsset.sha1 || companionFullAsset.SHA1 || '0000000000000000000000000000000000000000';
      const fullFile = companionFullAsset.filename || companionFullAsset.FileName;
      const fullSize = companionFullAsset.size || companionFullAsset.Size || 0;
      legacyReleasesContent += `${fullSha1} ${fullFile} ${fullSize}\n`;
    }
    legacyReleasesContent += `${actualSha1} ${verifiedRecord.filename} ${verifiedRecord.size}\n`;

    await fs.promises.writeFile(releasesJsonPath, JSON.stringify(releasesJson, null, 2), 'utf8');
    await fs.promises.writeFile(legacyReleasesPath, legacyReleasesContent, 'utf8');

    return {
      localFeedDir: versionFeedDir,
      nupkgPath: destNupkgPath,
      releasesJsonPath,
      legacyReleasesPath,
      releasesJson
    };
  }

  /**
   * Stages the verified P2P package into Velopack using a separate local UpdateManager instance.
   */
  async stageVerifiedPackageViaLocalManager(verifiedRecord, { onProgress, companionFullAsset = null } = {}) {
    const feedInfo = await this.prepareLocalFeedDirectory(verifiedRecord, companionFullAsset);
    const localManager = new this.UpdateManagerClass();
    localManager.setUrlOrPath(feedInfo.localFeedDir);

    const localUpdateInfo = await localManager.checkForUpdatesAsync();
    if (!localUpdateInfo || !localUpdateInfo.targetFullRelease) {
      throw new Error('Local UpdateManager did not detect the staged update in localFeedDir');
    }

    const localTarget = localUpdateInfo.targetFullRelease;
    if (String(localTarget.Version) !== String(verifiedRecord.version)) {
      throw new Error(
        `Local UpdateInfo version mismatch: expected ${verifiedRecord.version}, got ${localTarget.Version}`
      );
    }
    const isDelta = verifiedRecord.filename.includes('-delta.') || verifiedRecord.type === 'Delta';
    if (
      !isDelta &&
      localTarget.SHA256 &&
      String(localTarget.SHA256).toLowerCase() !== String(verifiedRecord.sha256).toLowerCase()
    ) {
      throw new Error(
        `Local UpdateInfo SHA256 mismatch: expected ${verifiedRecord.sha256}, got ${localTarget.SHA256}`
      );
    }

    const toDownload = isDelta ? {
      ...localTarget,
      fileName: verifiedRecord.filename,
      FileName: verifiedRecord.filename,
      size: BigInt(verifiedRecord.size || 0),
      Size: verifiedRecord.size,
      sha1: verifiedRecord.sha1 || '',
      SHA1: verifiedRecord.sha1 || ''
    } : localTarget;

    await localManager.downloadUpdatesAsync(toDownload, (pct) => {
      onProgress?.(Number(pct) || 0);
    });

    return {
      localManager,
      localUpdateInfo,
      localTargetRelease: toDownload,
      localFeedDir: feedInfo.localFeedDir
    };
  }

  applyStagedLocalUpdate({ localManager, localTargetRelease, waitExit = false, restartArgs = [] }) {
    if (!localManager || !localTargetRelease) {
      throw new Error('applyStagedLocalUpdate requires localManager and localTargetRelease');
    }
    if (waitExit && typeof localManager.waitExitThenApplyUpdates === 'function') {
      localManager.waitExitThenApplyUpdates(localTargetRelease, false, true, restartArgs);
    } else {
      localManager.applyUpdatesAndRestart(localTargetRelease, restartArgs);
    }
  }

  /**
   * Purges temporary staged local feed files so no unencrypted update artifacts linger on disk.
   */
  async cleanupLocalFeedDirectory(version = null) {
    try {
      if (version) {
        const dir = path.join(this.baseLocalFeedDir, String(version).replace(/[^0-9A-Za-z._-]/g, ''));
        if (fs.existsSync(dir)) {
          await fs.promises.rm(dir, { recursive: true, force: true });
        }
      } else if (fs.existsSync(this.baseLocalFeedDir)) {
        await fs.promises.rm(this.baseLocalFeedDir, { recursive: true, force: true });
      }
    } catch {
      // Non-fatal cleanup
    }
  }
}
