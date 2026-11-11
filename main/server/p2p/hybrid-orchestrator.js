import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_TRUSTED_PUBLISHER_KEYS,
  verifySignedP2PReleaseIndex
} from './signed-release-index.js';
import { VerifiedCache, DEFAULT_MAX_CACHE_BYTES } from './verified-cache.js';
import { P2PNode } from './p2p-node.js';
import {
  ExistingS3UpdaterAdapter,
  VelopackLocalSourceAdapter,
  OFFICIAL_S3_UPDATE_URL
} from './velopack-bridge.js';

function compareSemver(v1, v2) {
  if (!v1 || !v2) return 0;
  const clean = (v) => String(v).replace(/^v/i, '').trim();
  const p1 = clean(v1).split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = clean(v2).split('.').map((n) => parseInt(n, 10) || 0);
  const maxLen = Math.max(p1.length, p2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

export const VALID_ORCHESTRATOR_STATES = Object.freeze([
  'IDLE',
  'CHECKING_S3',
  'NO_UPDATE',
  'P2P_DISCOVERING',
  'P2P_CONNECTING',
  'P2P_DOWNLOADING',
  'VERIFYING',
  'P2P_READY',
  'S3_DOWNLOADING',
  'READY_TO_INSTALL',
  'APPLYING',
  'FAILED',
  'CANCELLED'
]);

export const UI_STATUS_LABELS = Object.freeze({
  CHECKING_S3: 'Checking for updates (S3)',
  DOWNLOADING_S3: 'Downloading from S3 (Standard)',
  CONNECTING_PEERS: 'Connecting to peers (P2P Alpha)',
  DOWNLOADING_PEER: 'Downloading from another user (P2P)',
  DOWNLOADING_VPS: 'Downloading from VPS seeder (P2P)',
  SWITCHING_TO_S3: 'P2P unavailable — switching to S3',
  VERIFYING: 'Verifying update package',
  READY_TO_INSTALL: 'Ready to install / Restart to update'
});

export class HybridUpdateOrchestrator extends EventEmitter {
  constructor({
    dataDir,
    updateUrl = OFFICIAL_S3_UPDATE_URL,
    appId = 'SA-CHAOS',
    channel = 'win',
    arch = 'x64',
    trustedKeys = DEFAULT_TRUSTED_PUBLISHER_KEYS,
    s3Adapter = null,
    localSourceAdapter = null,
    verifiedCache = null,
    p2pNode = null,
    initialConfig = {},
    autoApply = true,
    waitExitOnApply = false,
    logger = console
  } = {}) {
    super();
    this.dataDir = path.resolve(dataDir || path.join(process.cwd(), 'data'));
    this.p2pBaseDir = path.join(this.dataDir, 'p2p-cache');
    this.stateDir = path.join(this.p2pBaseDir, 'state');
    this.localFeedBaseDir = path.join(this.p2pBaseDir, 'local-feed');

    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    this.appId = appId;
    this.channel = channel;
    this.arch = arch;
    this.trustedKeys = trustedKeys;
    this.autoApply = autoApply;
    this.waitExitOnApply = waitExitOnApply;
    this.logger = logger;

    this.config = {
      p2pUpdaterEnabled: Boolean(initialConfig.p2pUpdaterEnabled ?? false),
      p2pUpdaterConsentAccepted: Boolean(initialConfig.p2pUpdaterConsentAccepted ?? false),
      p2pSeedingEnabled: Boolean(initialConfig.p2pSeedingEnabled ?? false),
      p2pMaxUploadKBps: Number(initialConfig.p2pMaxUploadKBps) || 2048,
      p2pMaxCacheMB: Number(initialConfig.p2pMaxCacheMB) || 600,
      p2pBootstrapMultiaddrs: Array.isArray(initialConfig.p2pBootstrapMultiaddrs)
        ? [...initialConfig.p2pBootstrapMultiaddrs]
        : []
    };

    // Enforce invariant: if main P2P toggle is OFF, seeding cannot be active
    if (!this.config.p2pUpdaterEnabled) {
      this._effectiveSeeding = false;
    } else {
      this._effectiveSeeding = Boolean(this.config.p2pSeedingEnabled);
    }

    this.verifiedCache =
      verifiedCache ||
      new VerifiedCache({
        cacheDir: this.p2pBaseDir,
        maxCacheBytes: this.config.p2pMaxCacheMB * 1024 * 1024 || DEFAULT_MAX_CACHE_BYTES
      });

    this.s3Adapter =
      s3Adapter ||
      new ExistingS3UpdaterAdapter({
        updateUrl
      });

    this.localSourceAdapter =
      localSourceAdapter ||
      new VelopackLocalSourceAdapter({
        baseLocalFeedDir: this.localFeedBaseDir,
        packageId: this.appId
      });

    this._injectedP2PNode = p2pNode;
    this.p2pNode = null;

    this.state = 'IDLE';
    this.statusLabel = '';
    this.sourceCategory = 'S3 (Standard)';
    this.fallbackReason = null;
    this.progress = {
      percent: 0,
      transferredBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      targetVersion: null
    };

    this._activeRunPromise = null;
    this._p2pAbortController = null;
    this._securityState = this._loadSecurityStateSync();
    this.telemetry = this._loadTelemetrySync();

    // Clean up any stale unencrypted local feed files from previous sessions
    this.localSourceAdapter.cleanupLocalFeedDirectory().catch(() => {});
  }

  _securityStatePath() {
    return path.join(this.stateDir, 'p2p-security-state.json');
  }

  _telemetryPath() {
    return path.join(this.stateDir, 'p2p-telemetry.json');
  }

  _loadSecurityStateSync() {
    const p = this._securityStatePath();
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        // ignore
      }
    }
    return {
      highestSeenSequence: 0,
      highestSeenVersion: null
    };
  }

  _saveSecurityStateSync() {
    try {
      fs.writeFileSync(this._securityStatePath(), JSON.stringify(this._securityState, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  _loadTelemetrySync() {
    const p = this._telemetryPath();
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        // ignore
      }
    }
    return {
      totalChecks: 0,
      p2pAttempts: 0,
      p2pSuccesses: 0,
      s3Downloads: 0,
      fallbacksByReason: {},
      bytesFromS3: 0,
      bytesFromP2PVps: 0,
      bytesFromP2PUser: 0,
      ipv6Bytes: 0,
      ipv4Bytes: 0,
      verificationFailures: 0,
      userCancellations: 0,
      lastUpdatedAt: null
    };
  }

  _saveTelemetrySync() {
    try {
      this.telemetry.lastUpdatedAt = new Date().toISOString();
      fs.writeFileSync(this._telemetryPath(), JSON.stringify(this.telemetry, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  _recordFallbackReason(reasonCode, friendlyMessage) {
    const key = String(reasonCode || 'UNKNOWN_P2P_FAILURE');
    this.telemetry.fallbacksByReason[key] = (this.telemetry.fallbacksByReason[key] || 0) + 1;
    this.fallbackReason = friendlyMessage || key;
    this._saveTelemetrySync();
  }

  _transition(newState, details = {}) {
    if (!VALID_ORCHESTRATOR_STATES.includes(newState)) {
      throw new Error(`Invalid orchestrator state transition: ${newState}`);
    }
    this.state = newState;
    if (details.statusLabel !== undefined) {
      this.statusLabel = details.statusLabel;
    }
    if (details.sourceCategory !== undefined) {
      this.sourceCategory = details.sourceCategory;
    }
    if (details.fallbackReason !== undefined) {
      this.fallbackReason = details.fallbackReason;
    }
    const snapshot = this.getStatusSnapshot();
    this.emit('state-change', snapshot);
    return snapshot;
  }

  getStatusSnapshot() {
    return {
      state: this.state,
      statusLabel: this.statusLabel,
      sourceCategory: this.sourceCategory,
      fallbackReason: this.fallbackReason,
      progress: { ...this.progress },
      config: {
        ...this.config,
        effectiveSeeding: Boolean(this.config.p2pUpdaterEnabled && this.config.p2pSeedingEnabled)
      },
      cacheUsageBytes: this.verifiedCache ? this.verifiedCache.getCacheUsageBytes() : 0,
      maxCacheBytes: this.verifiedCache ? this.verifiedCache.maxCacheBytes : DEFAULT_MAX_CACHE_BYTES,
      p2pActive: Boolean(this.p2pNode && this.p2pNode.running),
      seedingActive: Boolean(
        this.p2pNode &&
          this.p2pNode.running &&
          this.config.p2pUpdaterEnabled &&
          this.config.p2pSeedingEnabled
      ),
      multiaddrs: this.p2pNode ? this.p2pNode.getMultiaddrs({ includeLoopback: true }) : [],
      telemetry: { ...this.telemetry }
    };
  }

  _getOrCreateP2PNode() {
    if (this._injectedP2PNode) {
      this.p2pNode = this._injectedP2PNode;
      return this.p2pNode;
    }
    if (!this.p2pNode) {
      this.p2pNode = new P2PNode({
        stateDir: this.stateDir,
        verifiedCache: this.verifiedCache,
        role: 'user-peer',
        seedingEnabled: Boolean(this.config.p2pUpdaterEnabled && this.config.p2pSeedingEnabled),
        bootstrapMultiaddrs: this.config.p2pBootstrapMultiaddrs,
        maxUploadKBps: this.config.p2pMaxUploadKBps,
        logger: this.logger
      });
    }
    return this.p2pNode;
  }

  /**
   * Updates P2P configuration at runtime.
   * Rules enforced:
   * 1. Enabling p2pUpdaterEnabled NEVER silently enables p2pSeedingEnabled.
   * 2. Turning p2pUpdaterEnabled OFF immediately stops all P2P sockets, stops seeding,
   *    and if a P2P transfer is in progress, cancels it and falls back to S3.
   */
  async updateConfig(partialConfig = {}) {
    const prevEnabled = this.config.p2pUpdaterEnabled;
    const prevSeeding = this.config.p2pSeedingEnabled;

    if (typeof partialConfig.p2pUpdaterConsentAccepted === 'boolean') {
      this.config.p2pUpdaterConsentAccepted = partialConfig.p2pUpdaterConsentAccepted;
    }

    if (typeof partialConfig.p2pUpdaterEnabled === 'boolean') {
      this.config.p2pUpdaterEnabled = partialConfig.p2pUpdaterEnabled;
      // Only update p2pSeedingEnabled if explicitly passed; never auto-enable seeding!
    }

    if (typeof partialConfig.p2pSeedingEnabled === 'boolean') {
      this.config.p2pSeedingEnabled = partialConfig.p2pSeedingEnabled;
    }

    if (typeof partialConfig.p2pMaxUploadKBps === 'number' && partialConfig.p2pMaxUploadKBps > 0) {
      this.config.p2pMaxUploadKBps = partialConfig.p2pMaxUploadKBps;
      this.p2pNode?.setMaxUploadKBps(partialConfig.p2pMaxUploadKBps);
    }

    if (typeof partialConfig.p2pMaxCacheMB === 'number' && partialConfig.p2pMaxCacheMB >= 100) {
      this.config.p2pMaxCacheMB = partialConfig.p2pMaxCacheMB;
      this.verifiedCache?.setMaxCacheBytes(partialConfig.p2pMaxCacheMB * 1024 * 1024);
    }

    if (Array.isArray(partialConfig.p2pBootstrapMultiaddrs)) {
      this.config.p2pBootstrapMultiaddrs = [...partialConfig.p2pBootstrapMultiaddrs];
      this.p2pNode?.setBootstrapMultiaddrs(partialConfig.p2pBootstrapMultiaddrs);
    }

    if (typeof partialConfig.channel === 'string' && partialConfig.channel) {
      this.channel = partialConfig.channel.toLowerCase() === 'beta' ? 'beta' : 'win';
    }

    // If user turned P2P OFF, immediately kill all P2P activity
    if (!this.config.p2pUpdaterEnabled) {
      this._effectiveSeeding = false;
      if (this._p2pAbortController) {
        this.telemetry.userCancellations++;
        this._saveTelemetrySync();
        this._p2pAbortController.abort();
      }
      if (this.p2pNode) {
        this.p2pNode.setSeedingEnabled(false);
        await this.p2pNode.stop();
      }
      if (prevEnabled) {
        this.emit('state-change', this.getStatusSnapshot());
      }
      return this.getStatusSnapshot();
    }

    // P2P is ON; manage optional seeding state
    this._effectiveSeeding = Boolean(this.config.p2pSeedingEnabled);
    if (this._effectiveSeeding) {
      const node = this._getOrCreateP2PNode();
      node.setSeedingEnabled(true);
      await node.start();
    } else if (prevSeeding && this.p2pNode) {
      this.p2pNode.setSeedingEnabled(false);
      await this.p2pNode.stop();
    }

    this.emit('state-change', this.getStatusSnapshot());
    return this.getStatusSnapshot();
  }

  /**
   * Cancels an active P2P download and triggers automatic fallback to S3.
   */
  cancelP2PAndFallbackToS3() {
    if (this._p2pAbortController) {
      this.telemetry.userCancellations++;
      this._saveTelemetrySync();
      this._p2pAbortController.abort();
      return true;
    }
    return false;
  }

  async shutdown() {
    if (this._p2pAbortController) {
      this._p2pAbortController.abort();
    }
    if (this.p2pNode) {
      await this.p2pNode.stop();
    }
    this._transition('CANCELLED', { statusLabel: '' });
  }

  /**
   * Runs a single-flight update check, download, and optional installation.
   * 1. When p2pUpdaterEnabled === false: 100% existing S3 flow; zero P2P sockets or discovery.
   * 2. When p2pUpdaterEnabled === true:
   *    - Always checks S3 first for authoritative version selection.
   *    - Fetches & verifies SignedP2PReleaseIndex (Ed25519 + RFC 8785 + S3 hash match).
   *    - Attempts P2P download (IPv6-first / IPv4 fallback) into VerifiedCache.
   *    - Prepares local Velopack source and stages via dedicated local UpdateManager.
   *    - On ANY P2P failure/timeout/cancel/corruption: automatically falls back to S3.
   */
  async checkForUpdatesAndInstall({ onProgress, onComplete } = {}) {
    if (this._activeRunPromise) {
      return this._activeRunPromise;
    }

    this._activeRunPromise = this._executeUpdateCycle({ onProgress, onComplete }).finally(() => {
      this._activeRunPromise = null;
    });

    return this._activeRunPromise;
  }

  async _executeUpdateCycle({ onProgress, onComplete } = {}) {
    this.fallbackReason = null;
    this.telemetry.totalChecks++;
    this._saveTelemetrySync();

    this._transition('CHECKING_S3', {
      statusLabel: UI_STATUS_LABELS.CHECKING_S3,
      sourceCategory: 'S3 (Standard)'
    });

    let s3CheckResult;
    try {
      s3CheckResult = await this.s3Adapter.checkForUpdates();
    } catch (s3CheckErr) {
      // S3 is authoritative: never ask peers for version selection if S3 check fails
      this._transition('FAILED', {
        statusLabel: 'Failed to check for updates (S3 unavailable)',
        sourceCategory: 'S3 (Standard)'
      });
      onComplete?.();
      return {
        updated: false,
        source: 'none',
        error: s3CheckErr.message
      };
    }

    if (!s3CheckResult.isInstalled || !s3CheckResult.updateAvailable || !s3CheckResult.targetRelease) {
      this._transition('NO_UPDATE', {
        statusLabel: '',
        sourceCategory: 'S3 (Standard)'
      });
      onComplete?.();
      return {
        updated: false,
        source: 'none',
        reason: !s3CheckResult.isInstalled ? 'NOT_INSTALLED' : 'UP_TO_DATE'
      };
    }

    const { targetRelease, s3FeedAssets, updateInfo, s3Manager } = s3CheckResult;
    const targetVersion = String(targetRelease.Version || targetRelease.version).replace(/^v/i, '');
    const fullS3Asset =
      s3FeedAssets.find(
        (a) => String(a.Version || a.version).replace(/^v/i, '') === targetVersion && String(a.Type || a.type).toLowerCase() === 'full'
      ) || targetRelease;

    // Membaca s3FeedAssets dari urutan paling terbaru (atas) ke bawah
    const fullAssets = s3FeedAssets.filter((a) => String(a.Type || a.type).toLowerCase() === 'full');
    const deltaAssets = s3FeedAssets.filter((a) => String(a.Type || a.type).toLowerCase() === 'delta');

    const clean = (v) => String(v || '').replace(/^v/i, '').trim();
    const targetFull = fullAssets[0] || targetRelease;
    const prev1Full = fullAssets[1]; // x-1
    const prev2Full = fullAssets[2]; // x-2

    let currentVersion = '';
    try {
      const { app } = await import('electron');
      currentVersion = typeof app !== 'undefined' && app.getVersion ? clean(app.getVersion()) : '';
    } catch (_) {}

    const deltaTarget = deltaAssets.find((d) => clean(d.Version || d.version) === clean(targetFull.Version || targetFull.version));
    const deltaPrev1 = prev1Full ? deltaAssets.find((d) => clean(d.Version || d.version) === clean(prev1Full.Version || prev1Full.version)) : null;

    let canUseDeltas = false;
    let expectedDeltaBytes = 0;
    let deltaS3Asset = null;

    if (currentVersion && (!updateInfo || !updateInfo.isDowngrade)) {
      if (prev1Full && currentVersion === clean(prev1Full.Version || prev1Full.version) && deltaTarget?.Size) {
        canUseDeltas = true;
        expectedDeltaBytes = Number(deltaTarget.Size);
        deltaS3Asset = deltaTarget;
      } else if (prev2Full && currentVersion === clean(prev2Full.Version || prev2Full.version) && deltaTarget?.Size && deltaPrev1?.Size) {
        canUseDeltas = true;
        expectedDeltaBytes = Number(deltaTarget.Size) + Number(deltaPrev1.Size);
        deltaS3Asset = deltaTarget;
      }
    }

    const fullSize = Number(fullS3Asset.Size || targetRelease.Size || 0) || 0;
    const s3ExpectedSize = fullSize;
    const s3ExpectedDeltaSize = canUseDeltas && expectedDeltaBytes > 0 && expectedDeltaBytes < fullSize
      ? expectedDeltaBytes
      : s3ExpectedSize;

    this.progress = {
      percent: 0,
      transferredBytes: 0,
      totalBytes: s3ExpectedSize,
      speedBps: 0,
      targetVersion
    };

    // CASE 1: P2P OFF (Default) -> Run 100% existing S3 path without touching P2P
    if (!this.config.p2pUpdaterEnabled) {
      return await this._runS3DownloadAndApply({
        s3Manager,
        updateInfo,
        deltaAsset: deltaS3Asset,
        targetVersion,
        expectedBytes: s3ExpectedDeltaSize,
        isFallback: false,
        onProgress,
        onComplete
      });
    }

    // CASE 2: P2P ON (Opt-In Public Alpha)
    this.telemetry.p2pAttempts++;
    this._saveTelemetrySync();
    this._p2pAbortController = new AbortController();

    try {
      this._transition('P2P_DISCOVERING', {
        statusLabel: UI_STATUS_LABELS.CONNECTING_PEERS,
        sourceCategory: 'P2P Alpha'
      });

      // Step 2a: Fetch & verify publisher-signed P2P release index
      let rawSidecar;
      try {
        rawSidecar = await this.s3Adapter.fetchSignedP2PIndex();
      } catch (fetchErr) {
        this._recordFallbackReason('SIDECAR_UNAVAILABLE', 'Metadata P2P tidak tersedia untuk rilis ini');
        throw new Error(`SIDECAR_UNAVAILABLE: ${fetchErr.message}`);
      }

      let verifiedSidecar;
      try {
        verifiedSidecar = verifySignedP2PReleaseIndex({
          indexInput: rawSidecar.indexData,
          signatureInput: rawSidecar.sigData,
          expectedAppId: this.appId,
          expectedPlatform: 'win',
          expectedArch: this.arch,
          expectedChannel: this.channel,
          authoritativeS3Release: {
            Version: targetVersion,
            FileName: fullS3Asset.FileName || targetRelease.FileName,
            Size: fullS3Asset.Size || targetRelease.Size,
            SHA256: fullS3Asset.SHA256 || targetRelease.SHA256
          },
          authoritativeS3DeltaRelease: deltaS3Asset
            ? {
                Version: targetVersion,
                FileName: deltaS3Asset.FileName,
                Size: deltaS3Asset.Size,
                SHA256: deltaS3Asset.SHA256
              }
            : null,
          minSequence: this._securityState.highestSeenSequence || 0,
          minVersion: this._securityState.highestSeenVersion || null,
          trustedKeys: this.trustedKeys
        });
      } catch (sigErr) {
        this.telemetry.verificationFailures++;
        this._recordFallbackReason('INVALID_SIDECAR_SIGNATURE', 'Verifikasi indeks rilis P2P gagal');
        throw new Error(`INVALID_SIDECAR_SIGNATURE: ${sigErr.message}`);
      }

      // Persist anti-rollback sequence after valid publisher signature & S3 match
      if (verifiedSidecar.index.sequence > (this._securityState.highestSeenSequence || 0)) {
        this._securityState.highestSeenSequence = verifiedSidecar.index.sequence;
        this._securityState.highestSeenVersion = verifiedSidecar.index.version;
        this._saveSecurityStateSync();
      }

      // Determine whether Delta or Full package should be downloaded via P2P
      const canUseDelta = Boolean(
        canUseDeltas &&
        requiredDeltas.length === 1 &&
        verifiedSidecar.deltaAsset &&
        (!updateInfo || !updateInfo.isDowngrade)
      );

      const targetP2PAsset = canUseDelta
        ? verifiedSidecar.deltaAsset
        : verifiedSidecar.fullAsset;

      this.progress.totalBytes = targetP2PAsset.size;

      // Step 2b: Download verified chunks via P2PNode
      const node = this._getOrCreateP2PNode();
      node.setSeedingEnabled(Boolean(this.config.p2pUpdaterEnabled && this.config.p2pSeedingEnabled));
      await node.start();

      const p2pResult = await node.downloadVerifiedPackage({
        version: targetVersion,
        assetMeta: targetP2PAsset,
        abortSignal: this._p2pAbortController.signal,
        onStateChange: (p2pState, meta = {}) => {
          let label = UI_STATUS_LABELS.CONNECTING_PEERS;
          if (p2pState === 'P2P_DOWNLOADING') {
            label =
              meta.peerRole === 'vps-seeder'
                ? UI_STATUS_LABELS.DOWNLOADING_VPS
                : UI_STATUS_LABELS.DOWNLOADING_PEER;
          } else if (p2pState === 'VERIFYING') {
            label = UI_STATUS_LABELS.VERIFYING;
          }
          this._transition(p2pState, {
            statusLabel: label,
            sourceCategory: meta.sourceCategory || this.sourceCategory
          });
        },
        onProgress: (prog) => {
          this.progress = {
            percent: prog.percent,
            transferredBytes: prog.transferredBytes,
            totalBytes: prog.totalBytes,
            speedBps: prog.speedBps,
            targetVersion
          };
          onProgress?.({
            status: prog.sourceLabel,
            version: targetVersion,
            percent: prog.percent,
            transferredBytes: prog.transferredBytes,
            totalBytes: prog.totalBytes,
            speedBps: prog.speedBps,
            sourceCategory: prog.sourceCategory
          });
          this.emit('progress', this.getStatusSnapshot());
        }
      });

      // Step 2c: Stage into Velopack via isolated local feed directory & separate local UpdateManager
      this._transition('P2P_READY', {
        statusLabel: UI_STATUS_LABELS.VERIFYING,
        sourceCategory:
          p2pResult.peerRole === 'vps-seeder' ? 'P2P — VPS Seeder' : 'P2P — Pengguna lain'
      });

      const stagedLocal = await this.localSourceAdapter.stageVerifiedPackageViaLocalManager(
        p2pResult.verifiedRecord,
        {
          companionFullAsset: verifiedSidecar.fullAsset
        }
      );

      // Update telemetry counters
      this.telemetry.p2pSuccesses++;
      if (p2pResult.peerRole === 'vps-seeder') {
        this.telemetry.bytesFromP2PVps += p2pResult.bytesDownloaded;
      } else {
        this.telemetry.bytesFromP2PUser += p2pResult.bytesDownloaded;
      }
      if (p2pResult.family === 'IPv6') {
        this.telemetry.ipv6Bytes += p2pResult.bytesDownloaded;
      } else if (p2pResult.family === 'IPv4') {
        this.telemetry.ipv4Bytes += p2pResult.bytesDownloaded;
      }
      this._saveTelemetrySync();

      this.progress.percent = 100;
      this.progress.transferredBytes = targetP2PAsset.size;

      this._transition('READY_TO_INSTALL', {
        statusLabel: UI_STATUS_LABELS.READY_TO_INSTALL,
        sourceCategory:
          p2pResult.peerRole === 'vps-seeder' ? 'P2P — VPS Seeder' : 'P2P — Pengguna lain'
      });

      onProgress?.({
        status: UI_STATUS_LABELS.READY_TO_INSTALL,
        version: targetVersion,
        percent: 100,
        transferredBytes: verifiedSidecar.fullAsset.size,
        totalBytes: verifiedSidecar.fullAsset.size,
        sourceCategory: this.sourceCategory
      });

      if (this.autoApply) {
        this._transition('APPLYING', {
          statusLabel: UI_STATUS_LABELS.READY_TO_INSTALL
        });
        this.localSourceAdapter.applyStagedLocalUpdate({
          localManager: stagedLocal.localManager,
          localTargetRelease: stagedLocal.localTargetRelease,
          waitExit: this.waitExitOnApply
        });
      }

      return {
        updated: true,
        source: p2pResult.peerRole === 'vps-seeder' ? 'p2p-vps' : 'p2p-peer',
        sourceCategory: this.sourceCategory,
        family: p2pResult.family,
        peerId: p2pResult.peerId,
        bytesDownloaded: p2pResult.bytesDownloaded,
        version: targetVersion,
        localFeedDir: stagedLocal.localFeedDir
      };
    } catch (p2pErr) {
      // Automatic, seamless fallback to S3 on ANY P2P failure
      const rawMsg = p2pErr?.message || 'P2P_FAILED';
      if (!this.fallbackReason) {
        if (rawMsg.includes('NO_PEERS')) {
          this._recordFallbackReason('NO_PEERS', 'Tidak ada peer aktif — beralih ke S3');
        } else if (rawMsg.includes('SHA-256') || rawMsg.includes('verification failed')) {
          this.telemetry.verificationFailures++;
          this._recordFallbackReason('HASH_MISMATCH', 'Verifikasi paket P2P gagal — beralih ke S3');
        } else if (rawMsg.includes('TOO_SLOW') || rawMsg.includes('timeout')) {
          this._recordFallbackReason('TIMEOUT_OR_SLOW', 'Koneksi P2P lambat/timeout — beralih ke S3');
        } else if (rawMsg.includes('P2P_CANCELLED')) {
          this._recordFallbackReason('USER_CANCELLED', 'P2P dinonaktifkan — beralih ke S3');
        } else {
          this._recordFallbackReason('P2P_ERROR', 'P2P tidak tersedia — beralih ke S3');
        }
      }

      // Emit transitional switching status so UI clearly shows fallback
      this._transition('S3_DOWNLOADING', {
        statusLabel: UI_STATUS_LABELS.SWITCHING_TO_S3,
        sourceCategory: 'Beralih ke S3'
      });

      onProgress?.({
        status: UI_STATUS_LABELS.SWITCHING_TO_S3,
        version: targetVersion,
        percent: 0,
        transferredBytes: 0,
        totalBytes: s3ExpectedDeltaSize,
        sourceCategory: 'Beralih ke S3'
      });

      // Execute clean, separate S3 UpdateManager operation
      return await this._runS3DownloadAndApply({
        s3Manager: null, // Force a fresh S3 UpdateManager instance on fallback
        updateInfo: null,
        deltaAsset: deltaS3Asset,
        targetVersion,
        expectedBytes: s3ExpectedDeltaSize,
        isFallback: true,
        onProgress,
        onComplete
      });
    } finally {
      this._p2pAbortController = null;
    }
  }

  async _runS3DownloadAndApply({
    s3Manager,
    updateInfo,
    deltaAsset = null,
    targetVersion,
    expectedBytes,
    isFallback,
    onProgress,
    onComplete
  }) {
    try {
      this._transition('S3_DOWNLOADING', {
        statusLabel: UI_STATUS_LABELS.DOWNLOADING_S3,
        sourceCategory: isFallback ? 'Beralih ke S3' : 'S3 (Standard)'
      });

      const s3StartMs = Date.now();
      const s3Result = await this.s3Adapter.downloadFromS3({
        s3Manager,
        updateInfo,
        deltaAsset,
        onProgress: ({ percent }) => {
          const transferredBytes = Math.round((percent / 100) * expectedBytes);
          const elapsedSec = Math.max(0.001, (Date.now() - s3StartMs) / 1000);
          const speedBps = Math.round(transferredBytes / elapsedSec);
          this.progress = {
            percent,
            transferredBytes,
            totalBytes: expectedBytes,
            speedBps,
            targetVersion
          };
          onProgress?.({
            status: UI_STATUS_LABELS.DOWNLOADING_S3,
            version: targetVersion,
            percent,
            transferredBytes,
            totalBytes: expectedBytes,
            speedBps,
            sourceCategory: isFallback ? 'Beralih ke S3' : 'S3 (Standard)'
          });
          this.emit('progress', this.getStatusSnapshot());
        }
      });

      this.telemetry.s3Downloads++;
      this.telemetry.bytesFromS3 += expectedBytes;
      this._saveTelemetrySync();

      this._transition('READY_TO_INSTALL', {
        statusLabel: UI_STATUS_LABELS.READY_TO_INSTALL,
        sourceCategory: isFallback ? 'Beralih ke S3' : 'S3 (Standard)'
      });

      onProgress?.({
        status: UI_STATUS_LABELS.READY_TO_INSTALL,
        version: targetVersion,
        percent: 100,
        transferredBytes: expectedBytes,
        totalBytes: expectedBytes,
        sourceCategory: isFallback ? 'Beralih ke S3' : 'S3 (Standard)'
      });

      if (this.autoApply) {
        this._transition('APPLYING', {
          statusLabel: UI_STATUS_LABELS.READY_TO_INSTALL
        });
        this.s3Adapter.applyDownloadedS3Update({
          manager: s3Result.manager,
          targetRelease: s3Result.targetRelease,
          waitExit: this.waitExitOnApply
        });
      }

      return {
        updated: true,
        source: isFallback ? 's3-fallback' : 's3',
        sourceCategory: isFallback ? 'Beralih ke S3' : 'S3 (Standard)',
        bytesDownloaded: expectedBytes,
        version: targetVersion
      };
    } catch (s3Err) {
      this._transition('FAILED', {
        statusLabel: 'Update download failed',
        sourceCategory: 'S3 (Standard)'
      });
      onComplete?.();
      return {
        updated: false,
        source: isFallback ? 's3-fallback' : 's3',
        error: s3Err.message
      };
    }
  }
}
