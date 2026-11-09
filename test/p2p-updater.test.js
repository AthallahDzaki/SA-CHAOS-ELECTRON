import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalizeJson,
  generatePublisherKeyPair,
  createSignedP2PReleaseIndex,
  verifySignedP2PReleaseIndex,
  isValidPackageFilename,
  VerifiedCache,
  P2PNode,
  ExistingS3UpdaterAdapter,
  VelopackLocalSourceAdapter,
  HybridUpdateOrchestrator,
  UI_STATUS_LABELS,
  parseMultiaddr,
  formatMultiaddr
} from '../main/server/p2p/index.js';
import { startVpsSeederDaemon } from '../vps-seeder/seeder-daemon.js';

function createTempDir(prefix = 'decentraupdate-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createSampleNupkgFile(dir, version = '1.0.63', sizeBytes = 384 * 1024) {
  const filename = `SA-CHAOS-${version}-full.nupkg`;
  const filePath = path.join(dir, filename);
  const buffer = crypto.randomBytes(sizeBytes);
  fs.writeFileSync(filePath, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex').toUpperCase();
  return { filePath, filename, sizeBytes, sha256, sha1, buffer };
}

/**
 * Mock UpdateManager that emulates Velopack 0.0.89 UpdateManager against both S3 URLs
 * and local feed directories (reading releases.win.json from disk when given a local folder).
 */
function createMockUpdateManagerClass({ s3ReleaseAsset, onS3Download, onApply }) {
  return class MockUpdateManager {
    constructor() {
      this.urlOrPath = null;
    }

    isInstalled() {
      return true;
    }

    setUrlOrPath(urlOrPath) {
      this.urlOrPath = urlOrPath;
    }

    async checkForUpdatesAsync() {
      if (!this.urlOrPath) throw new Error('urlOrPath not set');
      if (this.urlOrPath.startsWith('http://') || this.urlOrPath.startsWith('https://')) {
        if (!s3ReleaseAsset) return null;
        return {
          targetFullRelease: { ...s3ReleaseAsset }
        };
      }

      // Local directory feed mode: read releases.win.json and verify the .nupkg file exists
      const releasesPath = path.join(this.urlOrPath, 'releases.win.json');
      if (!fs.existsSync(releasesPath)) {
        throw new Error(`Missing releases.win.json in local feed dir: ${this.urlOrPath}`);
      }
      const feed = JSON.parse(fs.readFileSync(releasesPath, 'utf8'));
      const fullAsset = (feed.Assets || []).find((a) => a.Type === 'Full');
      if (!fullAsset) {
        throw new Error('No Full asset in local feed releases.win.json');
      }
      const nupkgPath = path.join(this.urlOrPath, fullAsset.FileName);
      if (!fs.existsSync(nupkgPath)) {
        throw new Error(`Missing nupkg file in local feed: ${nupkgPath}`);
      }
      return {
        targetFullRelease: { ...fullAsset }
      };
    }

    async downloadUpdatesAsync(targetRelease, progressFn) {
      if (this.urlOrPath.startsWith('http://') || this.urlOrPath.startsWith('https://')) {
        onS3Download?.(targetRelease);
      }
      progressFn?.(25);
      progressFn?.(75);
      progressFn?.(100);
    }

    applyUpdatesAndRestart(targetRelease) {
      onApply?.({ sourceUrlOrPath: this.urlOrPath, targetRelease });
    }

    waitExitThenApplyUpdates(targetRelease) {
      onApply?.({ sourceUrlOrPath: this.urlOrPath, targetRelease, waitExit: true });
    }
  };
}

test('H.1 Canonical JSON (RFC 8785) & Ed25519 SignedP2PReleaseIndex verification, expiry, anti-rollback & path safety', async () => {
  const tmpDir = createTempDir('manifest-test-');
  try {
    // 1. Canonical JSON key ordering
    const objA = { b: 2, a: { z: 'hi', m: [3, 2, 1] } };
    const objB = { a: { m: [3, 2, 1], z: 'hi' }, b: 2 };
    assert.equal(canonicalizeJson(objA), canonicalizeJson(objB));
    assert.equal(canonicalizeJson(objA), '{"a":{"m":[3,2,1],"z":"hi"},"b":2}');

    // 2. Filename allowlist & path traversal rejection
    assert.equal(isValidPackageFilename('SA-CHAOS-1.0.63-full.nupkg'), true);
    assert.equal(isValidPackageFilename('../SA-CHAOS-1.0.63-full.nupkg'), false);
    assert.equal(isValidPackageFilename('sub/SA-CHAOS-1.0.63-full.nupkg'), false);
    assert.equal(isValidPackageFilename('C:\\SA-CHAOS-1.0.63-full.nupkg'), false);
    assert.equal(isValidPackageFilename('SA-CHAOS-1.0.63-delta.nupkg'), true);
    assert.equal(isValidPackageFilename('SA-CHAOS-1.0.63-other.nupkg'), false);

    // 3. Create & verify valid signed release index
    const { publicKeyPem, privateKeyPem } = generatePublisherKeyPair();
    const sample = createSampleNupkgFile(tmpDir, '1.0.63', 200 * 1024);
    const signed = await createSignedP2PReleaseIndex({
      packagePath: sample.filePath,
      version: '1.0.63',
      chunkSize: 64 * 1024,
      signingKeyId: 'test-key-2026',
      privateKeyPem
    });

    const trustedKeys = { 'test-key-2026': publicKeyPem };
    const s3Asset = {
      PackageId: 'SA-CHAOS',
      Version: '1.0.63',
      Type: 'Full',
      FileName: sample.filename,
      SHA1: sample.sha1,
      SHA256: sample.sha256.toUpperCase(),
      Size: sample.sizeBytes
    };

    const verified = verifySignedP2PReleaseIndex({
      indexInput: signed.index,
      signatureInput: signed.signatureFileContent,
      authoritativeS3Release: s3Asset,
      trustedKeys
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.fullAsset.chunkSha256.length, 4);

    // 4. Reject tampered payload
    const tampered = structuredClone(signed.index);
    tampered.assets[0].size += 1;
    assert.throws(() => {
      verifySignedP2PReleaseIndex({
        indexInput: tampered,
        signatureInput: signed.signatureFileContent,
        authoritativeS3Release: s3Asset,
        trustedKeys
      });
    }, /Ed25519 signature verification failed/);

    // 5. Reject untrusted signingKeyId
    assert.throws(() => {
      verifySignedP2PReleaseIndex({
        indexInput: signed.index,
        signatureInput: signed.signatureFileContent,
        authoritativeS3Release: s3Asset,
        trustedKeys: { 'other-key': publicKeyPem }
      });
    }, /Untrusted or unknown signingKeyId/);

    // 6. Reject rollback sequence
    assert.throws(() => {
      verifySignedP2PReleaseIndex({
        indexInput: signed.index,
        signatureInput: signed.signatureFileContent,
        authoritativeS3Release: s3Asset,
        minSequence: signed.index.sequence + 10,
        trustedKeys
      });
    }, /Rollback rejected/);

    // 7. Reject expired index
    const futureNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    assert.throws(() => {
      verifySignedP2PReleaseIndex({
        indexInput: signed.index,
        signatureInput: signed.signatureFileContent,
        authoritativeS3Release: s3Asset,
        trustedKeys,
        now: futureNow
      });
    }, /expired/);

    // 8. Reject S3 version or hash mismatch
    assert.throws(() => {
      verifySignedP2PReleaseIndex({
        indexInput: signed.index,
        signatureInput: signed.signatureFileContent,
        authoritativeS3Release: { ...s3Asset, Version: '1.0.64' },
        trustedKeys
      });
    }, /S3 version mismatch/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('A. S3 Regression: With P2P OFF (default), 100% existing S3 flow runs and zero P2P sockets/discovery start', async () => {
  const tmpDir = createTempDir('s3-regression-');
  try {
    const sample = createSampleNupkgFile(tmpDir, '1.0.63', 128 * 1024);
    const s3Asset = {
      PackageId: 'SA-CHAOS',
      Version: '1.0.63',
      Type: 'Full',
      FileName: sample.filename,
      SHA1: sample.sha1,
      SHA256: sample.sha256.toUpperCase(),
      Size: sample.sizeBytes
    };

    let s3DownloadCount = 0;
    let appliedTarget = null;

    const MockUM = createMockUpdateManagerClass({
      s3ReleaseAsset: s3Asset,
      onS3Download: () => {
        s3DownloadCount++;
      },
      onApply: (info) => {
        appliedTarget = info;
      }
    });

    const s3Adapter = new ExistingS3UpdaterAdapter({
      updateUrl: 'https://updater.sa-chaos.my.id/velopack.php/',
      UpdateManagerClass: MockUM,
      httpClient: {
        get: async (url) => {
          if (url.endsWith('releases.win.json')) {
            return { data: { Assets: [s3Asset] } };
          }
          throw new Error('P2P sidecar should never be fetched when P2P is OFF');
        }
      }
    });

    const orchestrator = new HybridUpdateOrchestrator({
      dataDir: tmpDir,
      s3Adapter,
      initialConfig: {
        p2pUpdaterEnabled: false,
        p2pSeedingEnabled: false
      }
    });

    const snapBefore = orchestrator.getStatusSnapshot();
    assert.equal(snapBefore.config.p2pUpdaterEnabled, false);
    assert.equal(snapBefore.config.p2pSeedingEnabled, false);
    assert.equal(snapBefore.p2pActive, false);
    assert.equal(snapBefore.seedingActive, false);

    const result = await orchestrator.checkForUpdatesAndInstall();
    assert.equal(result.updated, true);
    assert.equal(result.source, 's3');
    assert.equal(result.sourceCategory, 'S3 (Standard)');
    assert.equal(s3DownloadCount, 1);
    assert.ok(appliedTarget);
    assert.equal(appliedTarget.sourceUrlOrPath, 'https://updater.sa-chaos.my.id/velopack.php/');

    const snapAfter = orchestrator.getStatusSnapshot();
    assert.equal(snapAfter.p2pActive, false);
    assert.equal(snapAfter.seedingActive, false);
    assert.equal(snapAfter.telemetry.p2pAttempts, 0);
    assert.equal(snapAfter.telemetry.s3Downloads, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('B, C & D. Full Dual-Stack P2P Transfer: (B) VPS IPv6 -> Peer A, then (C/D) VPS Stopped & Peer A -> Peer B direct transfer, then all peers OFF -> S3 Fallback', async () => {
  const rootDir = createTempDir('p2p-e2e-');
  const vpsDir = path.join(rootDir, 'vps');
  const peerADir = path.join(rootDir, 'peerA');
  const peerBDir = path.join(rootDir, 'peerB');
  const peerCDir = path.join(rootDir, 'peerC');
  fs.mkdirSync(vpsDir, { recursive: true });

  let vpsDaemon = null;
  let orchestratorA = null;
  let orchestratorB = null;
  let orchestratorC = null;

  try {
    // 1. Prepare release package & publisher signature
    const { publicKeyPem, privateKeyPem } = generatePublisherKeyPair();
    const trustedKeys = { 'publisher-2026': publicKeyPem };
    const vpsReleasesDir = path.join(vpsDir, 'releases');
    fs.mkdirSync(vpsReleasesDir, { recursive: true });

    const sample = createSampleNupkgFile(vpsReleasesDir, '1.0.64', 320 * 1024); // 5 chunks of 64 KiB
    const signed = await createSignedP2PReleaseIndex({
      packagePath: sample.filePath,
      version: '1.0.64',
      chunkSize: 64 * 1024,
      signingKeyId: 'publisher-2026',
      privateKeyPem
    });

    fs.writeFileSync(path.join(vpsReleasesDir, 'p2p-index.win.json'), JSON.stringify(signed.index, null, 2));
    fs.writeFileSync(path.join(vpsReleasesDir, 'p2p-index.win.sig'), signed.signatureFileContent);

    const s3Asset = {
      PackageId: 'SA-CHAOS',
      Version: '1.0.64',
      Type: 'Full',
      FileName: sample.filename,
      SHA1: sample.sha1,
      SHA256: sample.sha256.toUpperCase(),
      Size: sample.sizeBytes
    };

    // 2. Start Simulated Ubuntu VPS Seeder Daemon on dual-stack [::1] and 127.0.0.1
    vpsDaemon = await startVpsSeederDaemon({
      listenPort: 0,
      bindIpv6: '::1',
      bindIpv4: '127.0.0.1',
      publicIpv6: '::1',
      publicIpv4: '127.0.0.1',
      releasesDir: vpsReleasesDir,
      stateDir: path.join(vpsDir, 'state'),
      trustedKeys
    });

    const vpsAddrs = vpsDaemon.node.getMultiaddrs({ includeLoopback: true });
    assert.ok(vpsAddrs.some((m) => m.startsWith('/ip6/::1/')), 'VPS seeder must listen on IPv6 ::1');
    assert.ok(vpsAddrs.some((m) => m.startsWith('/ip4/127.0.0.1/')), 'VPS seeder must listen on IPv4 127.0.0.1');

    const createTestS3Adapter = (onS3Download, onApply) => {
      const MockUM = createMockUpdateManagerClass({
        s3ReleaseAsset: s3Asset,
        onS3Download,
        onApply
      });
      return {
        MockUM,
        s3Adapter: new ExistingS3UpdaterAdapter({
          updateUrl: 'https://updater.sa-chaos.my.id/velopack.php/',
          UpdateManagerClass: MockUM,
          httpClient: {
            get: async (url) => {
              if (url.endsWith('releases.win.json')) return { data: { Assets: [s3Asset] } };
              if (url.endsWith('p2p-index.win.json')) return { data: signed.index };
              if (url.endsWith('p2p-index.win.sig')) return { data: signed.signatureFileContent };
              throw new Error(`Unexpected URL: ${url}`);
            }
          }
        })
      };
    };

    // 3. Test B: Windows Peer A downloads v1.0.64 from VPS Seeder over direct IPv6
    let peerAS3Downloads = 0;
    let peerAApplied = null;
    const { MockUM: MockUMA, s3Adapter: s3AdapterA } = createTestS3Adapter(
      () => peerAS3Downloads++,
      (info) => { peerAApplied = info; }
    );

    orchestratorA = new HybridUpdateOrchestrator({
      dataDir: peerADir,
      trustedKeys,
      s3Adapter: s3AdapterA,
      localSourceAdapter: new VelopackLocalSourceAdapter({
        baseLocalFeedDir: path.join(peerADir, 'p2p-cache', 'local-feed'),
        UpdateManagerClass: MockUMA
      }),
      initialConfig: {
        p2pUpdaterConsentAccepted: true,
        p2pUpdaterEnabled: true,
        p2pSeedingEnabled: true, // Peer A explicitly opts in to seeding so it can serve Peer B
        p2pBootstrapMultiaddrs: vpsAddrs
      }
    });

    const seenLabelsA = [];
    const resA = await orchestratorA.checkForUpdatesAndInstall({
      onProgress: (p) => {
        if (p.status && !seenLabelsA.includes(p.status)) seenLabelsA.push(p.status);
      }
    });

    assert.equal(resA.updated, true);
    assert.equal(resA.source, 'p2p-vps');
    assert.equal(resA.sourceCategory, 'P2P — VPS Seeder');
    assert.equal(resA.family, 'IPv6', 'Peer A should prefer IPv6 when reachable');
    assert.equal(resA.bytesDownloaded, sample.sizeBytes);
    assert.equal(peerAS3Downloads, 0, 'S3 download should not run when P2P succeeds');
    assert.ok(seenLabelsA.includes(UI_STATUS_LABELS.DOWNLOADING_VPS));
    assert.ok(peerAApplied, 'VelopackLocalSourceAdapter should apply the verified local update');
    assert.equal(vpsDaemon.node.stats.bytesUploaded, sample.sizeBytes);

    // Ensure Peer A announces its seeding address to VPS or Peer B knows Peer A's multiaddr before VPS stops
    await orchestratorA.p2pNode.discoverPeers({
      version: '1.0.64',
      sha256: sample.sha256
    });
    const peerAMultiaddrs = orchestratorA.p2pNode.getMultiaddrs({ includeLoopback: true });
    assert.ok(peerAMultiaddrs.length > 0, 'Peer A should have active seeding multiaddrs');

    // 4. Test C & D (CRITICAL PROOF):
    // Peer B discovers Peer A via PEX while VPS is online, then we STOP VPS Seeder completely!
    let peerBS3Downloads = 0;
    let peerBApplied = null;
    const { MockUM: MockUMB, s3Adapter: s3AdapterB } = createTestS3Adapter(
      () => peerBS3Downloads++,
      (info) => { peerBApplied = info; }
    );

    orchestratorB = new HybridUpdateOrchestrator({
      dataDir: peerBDir,
      trustedKeys,
      s3Adapter: s3AdapterB,
      localSourceAdapter: new VelopackLocalSourceAdapter({
        baseLocalFeedDir: path.join(peerBDir, 'p2p-cache', 'local-feed'),
        UpdateManagerClass: MockUMB
      }),
      initialConfig: {
        p2pUpdaterConsentAccepted: true,
        p2pUpdaterEnabled: true,
        p2pSeedingEnabled: false, // Peer B only downloads, does NOT seed
        p2pBootstrapMultiaddrs: vpsAddrs
      }
    });

    // Peer B runs peer discovery once while VPS is still online so it learns Peer A's multiaddrs via PEX
    const nodeB = orchestratorB._getOrCreateP2PNode();
    await nodeB.discoverPeers({ version: '1.0.64', sha256: sample.sha256 });

    // NOW STOP THE VPS SEEDER COMPLETELY!
    await vpsDaemon.stop();
    vpsDaemon = null;

    const peerAUploadsBeforeB = orchestratorA.p2pNode.stats.bytesUploaded;
    const seenLabelsB = [];

    const resB = await orchestratorB.checkForUpdatesAndInstall({
      onProgress: (p) => {
        if (p.status && !seenLabelsB.includes(p.status)) seenLabelsB.push(p.status);
      }
    });

    // Verify Peer B downloaded 100% of the package from Peer A while VPS was OFF!
    assert.equal(resB.updated, true);
    assert.equal(resB.source, 'p2p-peer');
    assert.equal(resB.sourceCategory, 'P2P — Pengguna lain');
    assert.equal(resB.peerId, orchestratorA.p2pNode.peerId);
    assert.equal(resB.bytesDownloaded, sample.sizeBytes);
    assert.equal(peerBS3Downloads, 0, 'Peer B must NOT download from S3 when Peer A is reachable');
    assert.equal(
      orchestratorA.p2pNode.stats.bytesUploaded - peerAUploadsBeforeB,
      sample.sizeBytes,
      'Peer A uploaded byte counter must exactly equal package size'
    );
    assert.equal(orchestratorB.telemetry.bytesFromP2PUser, sample.sizeBytes);
    assert.equal(orchestratorB.telemetry.bytesFromP2PVps, 0);
    assert.equal(orchestratorB.telemetry.bytesFromS3, 0);
    assert.ok(seenLabelsB.includes(UI_STATUS_LABELS.DOWNLOADING_PEER));
    assert.ok(peerBApplied);

    // 5. Now stop Peer A as well! Peer C has P2P ON, but BOTH VPS and Peer A are offline -> Must fallback to S3!
    await orchestratorA.shutdown();
    orchestratorA = null;

    let peerCS3Downloads = 0;
    const { MockUM: MockUMC, s3Adapter: s3AdapterC } = createTestS3Adapter(
      () => peerCS3Downloads++,
      () => {}
    );

    orchestratorC = new HybridUpdateOrchestrator({
      dataDir: peerCDir,
      trustedKeys,
      s3Adapter: s3AdapterC,
      localSourceAdapter: new VelopackLocalSourceAdapter({
        baseLocalFeedDir: path.join(peerCDir, 'p2p-cache', 'local-feed'),
        UpdateManagerClass: MockUMC
      }),
      initialConfig: {
        p2pUpdaterConsentAccepted: true,
        p2pUpdaterEnabled: true,
        p2pSeedingEnabled: false,
        p2pBootstrapMultiaddrs: vpsAddrs
      }
    });

    const seenLabelsC = [];
    const resC = await orchestratorC.checkForUpdatesAndInstall({
      onProgress: (p) => {
        if (p.status && !seenLabelsC.includes(p.status)) seenLabelsC.push(p.status);
      }
    });

    assert.equal(resC.updated, true);
    assert.equal(resC.source, 's3-fallback');
    assert.equal(resC.sourceCategory, 'Beralih ke S3');
    assert.equal(peerCS3Downloads, 1, 'Peer C must automatically fall back to S3 when all peers are offline');
    assert.ok(seenLabelsC.includes(UI_STATUS_LABELS.SWITCHING_TO_S3));
    assert.ok(seenLabelsC.includes(UI_STATUS_LABELS.DOWNLOADING_S3));
  } finally {
    await vpsDaemon?.stop().catch(() => {});
    await orchestratorA?.shutdown().catch(() => {});
    await orchestratorB?.shutdown().catch(() => {});
    await orchestratorC?.shutdown().catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('E & F. Corrupted chunk rejection -> S3 fallback, Happy Eyeballs IPv6 blocked -> IPv4 fallback, and Separate Seeding Consent Invariant', async () => {
  const rootDir = createTempDir('security-fallback-');
  let badPeerNode = null;
  let v4OnlySeederNode = null;
  let clientNode = null;

  try {
    const { publicKeyPem, privateKeyPem } = generatePublisherKeyPair();
    const trustedKeys = { 'publisher-2026': publicKeyPem };
    const sample = createSampleNupkgFile(rootDir, '1.0.65', 128 * 1024); // 2 chunks of 64 KiB
    const signed = await createSignedP2PReleaseIndex({
      packagePath: sample.filePath,
      version: '1.0.65',
      chunkSize: 64 * 1024,
      signingKeyId: 'publisher-2026',
      privateKeyPem
    });

    // 1. Test F: Happy Eyeballs IPv6 blocked -> IPv4 fallback
    const v4Cache = new VerifiedCache({ cacheDir: path.join(rootDir, 'v4-seeder-cache') });
    await v4Cache.importVerifiedPackageFile(sample.filePath, '1.0.65', signed.index.assets[0]);

    v4OnlySeederNode = new P2PNode({
      stateDir: path.join(rootDir, 'v4-seeder-state'),
      verifiedCache: v4Cache,
      role: 'vps-seeder',
      seedingEnabled: true,
      listenPort: 0,
      bindIpv6: null, // IPv6 disabled on this seeder
      bindIpv4: '127.0.0.1',
      publicIpv4: '127.0.0.1'
    });
    await v4OnlySeederNode.start();
    const v4Multiaddr = formatMultiaddr({
      family: 'IPv4',
      host: '127.0.0.1',
      port: v4OnlySeederNode.boundPortIpv4,
      peerId: v4OnlySeederNode.peerId
    });
    // Pair an unreachable IPv6 multiaddr with the reachable IPv4 multiaddr for the same PeerId
    const unreachableV6Multiaddr = formatMultiaddr({
      family: 'IPv6',
      host: '::1',
      port: 65431, // closed port
      peerId: v4OnlySeederNode.peerId
    });

    const clientCache = new VerifiedCache({ cacheDir: path.join(rootDir, 'client-v4-cache') });
    clientNode = new P2PNode({
      stateDir: path.join(rootDir, 'client-v4-state'),
      verifiedCache: clientCache,
      bootstrapMultiaddrs: [unreachableV6Multiaddr, v4Multiaddr],
      happyEyeballsDelayMs: 200,
      connectTimeoutMs: 1500
    });

    const dlResult = await clientNode.downloadVerifiedPackage({
      version: '1.0.65',
      assetMeta: signed.index.assets[0]
    });
    assert.equal(dlResult.family, 'IPv4', 'Client should fall back to IPv4 when IPv6 is unreachable');
    assert.equal(dlResult.bytesDownloaded, sample.sizeBytes);
    await v4OnlySeederNode.stop();

    // 2. Test E: Malicious peer serves corrupted chunk -> Client rejects chunk, never commits/seeds, falls back to S3
    const badCache = new VerifiedCache({ cacheDir: path.join(rootDir, 'bad-cache') });
    await badCache.importVerifiedPackageFile(sample.filePath, '1.0.65', signed.index.assets[0]);
    // Monkeypatch readAuthorizedChunk on badCache to corrupt byte 0 of chunk 0
    badCache.readAuthorizedChunk = async () => ({
      chunkIndex: 0,
      byteLength: 64 * 1024,
      chunkSha256: signed.index.assets[0].chunkSha256[0],
      buffer: Buffer.alloc(64 * 1024, 0xff) // corrupted bytes!
    });

    badPeerNode = new P2PNode({
      stateDir: path.join(rootDir, 'bad-peer-state'),
      verifiedCache: badCache,
      role: 'user-peer',
      seedingEnabled: true,
      bindIpv6: '::1',
      bindIpv4: '127.0.0.1'
    });
    await badPeerNode.start();
    const badAddrs = badPeerNode.getMultiaddrs({ includeLoopback: true });

    const s3Asset = {
      PackageId: 'SA-CHAOS',
      Version: '1.0.65',
      Type: 'Full',
      FileName: sample.filename,
      SHA1: sample.sha1,
      SHA256: sample.sha256.toUpperCase(),
      Size: sample.sizeBytes
    };
    let s3FallbackCount = 0;
    const MockUM = createMockUpdateManagerClass({
      s3ReleaseAsset: s3Asset,
      onS3Download: () => s3FallbackCount++
    });

    const orch = new HybridUpdateOrchestrator({
      dataDir: path.join(rootDir, 'victim-client'),
      trustedKeys,
      s3Adapter: new ExistingS3UpdaterAdapter({
        UpdateManagerClass: MockUM,
        httpClient: {
          get: async (url) => {
            if (url.endsWith('releases.win.json')) return { data: { Assets: [s3Asset] } };
            if (url.endsWith('p2p-index.win.json')) return { data: signed.index };
            if (url.endsWith('p2p-index.win.sig')) return { data: signed.signatureFileContent };
          }
        }
      }),
      initialConfig: {
        p2pUpdaterConsentAccepted: true,
        p2pUpdaterEnabled: true,
        p2pSeedingEnabled: false,
        p2pBootstrapMultiaddrs: badAddrs
      }
    });

    const victimRes = await orch.checkForUpdatesAndInstall();
    assert.equal(victimRes.updated, true);
    assert.equal(victimRes.source, 's3-fallback');
    assert.equal(s3FallbackCount, 1);
    assert.ok(orch.p2pNode.stats.chunkVerificationFailures > 0, 'Must record chunk SHA-256 verification failure');
    assert.equal(
      orch.verifiedCache.getAuthorizedPackage({ version: '1.0.65', sha256: sample.sha256 }),
      null,
      'Corrupted package must NEVER be committed to VerifiedCache or seeded'
    );

    // 3. Test G: Separate Seeding Consent Invariant & Immediate Kill Switch
    await orch.updateConfig({ p2pUpdaterEnabled: true });
    assert.equal(orch.getStatusSnapshot().config.p2pSeedingEnabled, false, 'Enabling P2P download must NEVER auto-enable seeding');
    assert.equal(orch.getStatusSnapshot().seedingActive, false);

    await orch.updateConfig({ p2pSeedingEnabled: true });
    assert.equal(orch.getStatusSnapshot().seedingActive, true);

    // Turn main P2P toggle OFF -> seeding must stop immediately
    await orch.updateConfig({ p2pUpdaterEnabled: false });
    assert.equal(orch.getStatusSnapshot().p2pActive, false);
    assert.equal(orch.getStatusSnapshot().seedingActive, false);
    assert.equal(orch.getStatusSnapshot().config.effectiveSeeding, false);

    await orch.shutdown();
  } finally {
    await badPeerNode?.stop().catch(() => {});
    await v4OnlySeederNode?.stop().catch(() => {});
    await clientNode?.stop().catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('G.2 General Config UI files contain exact required labels, disclosure text, and separate seeding toggle', () => {
  const componentPath = path.resolve(
    process.cwd(),
    '..',
    'SA-CHAOS-CONFIG',
    'src',
    'components',
    'P2PUpdaterConfigSection.jsx'
  );
  const v1PagePath = path.resolve(
    process.cwd(),
    '..',
    'SA-CHAOS-CONFIG',
    'src',
    'app',
    'general-config',
    'page.js'
  );
  const v2PagePath = path.resolve(
    process.cwd(),
    '..',
    'SA-CHAOS-CONFIG',
    'src',
    'app',
    'v2',
    'general-config',
    'page.js'
  );

  const compText = fs.readFileSync(componentPath, 'utf8');
  const v1Text = fs.readFileSync(v1PagePath, 'utf8');
  const v2Text = fs.readFileSync(v2PagePath, 'utf8');

  assert.ok(compText.includes('Updater with Peer-To-Peer System'));
  assert.ok(compText.includes('Eksperimental (Alpha). Coba mengunduh update dari pengguna lain. Jika tidak tersedia, aplikasi tetap menggunakan S3.'));
  assert.ok(compText.includes('Tentang P2P Updater (Alpha)'));
  assert.ok(compText.includes('Fitur ini masih dalam tahap Alpha Testing.'));
  assert.ok(compText.includes('Saya mengerti, aktifkan P2P'));
  assert.ok(compText.includes('Share downloaded updates with other users'));
  assert.ok(v1Text.includes('P2PUpdaterConfigSection'));
  assert.ok(v2Text.includes('P2PUpdaterConfigSection'));
});

test('E.2 & H.2 Mid-transfer user toggle OFF cancellation -> S3 fallback, Resumable staging bitmap, and Storage Quota Eviction', async () => {
  const rootDir = createTempDir('mid-cancel-quota-');
  let slowSeeder = null;
  let orch = null;

  try {
    // 1. Storage Quota & Resumable Staging Test
    const cacheDir = path.join(rootDir, 'quota-cache');
    const cache = new VerifiedCache({
      cacheDir,
      maxCacheBytes: 300 * 1024 // 300 KiB cap
    });

    const { publicKeyPem, privateKeyPem } = generatePublisherKeyPair();
    const trustedKeys = { 'publisher-2026': publicKeyPem };

    const pkg1 = createSampleNupkgFile(rootDir, '1.0.61', 180 * 1024);
    const signed1 = await createSignedP2PReleaseIndex({
      packagePath: pkg1.filePath,
      version: '1.0.61',
      chunkSize: 64 * 1024,
      privateKeyPem
    });
    await cache.importVerifiedPackageFile(pkg1.filePath, '1.0.61', signed1.index.assets[0]);
    assert.ok(cache.getAuthorizedPackage({ version: '1.0.61', sha256: pkg1.sha256 }));

    // Importing a second 180 KiB package exceeds 300 KiB cap -> must evict pkg1 (1.0.61) automatically
    const pkg2 = createSampleNupkgFile(rootDir, '1.0.62', 180 * 1024);
    const signed2 = await createSignedP2PReleaseIndex({
      packagePath: pkg2.filePath,
      version: '1.0.62',
      chunkSize: 64 * 1024,
      privateKeyPem
    });
    await cache.importVerifiedPackageFile(pkg2.filePath, '1.0.62', signed2.index.assets[0]);
    assert.equal(
      cache.getAuthorizedPackage({ version: '1.0.61', sha256: pkg1.sha256 }),
      null,
      'Old package should be evicted to respect maxCacheBytes quota'
    );
    assert.ok(
      cache.getAuthorizedPackage({ version: '1.0.62', sha256: pkg2.sha256 }),
      'New package should remain in VerifiedCache'
    );
    assert.ok(cache.getCacheUsageBytes() <= 300 * 1024);

    // 2. Resumable Staging Session Test (write chunk 0, close session, re-open session, verify chunk 0 is preserved)
    const resumeCache = new VerifiedCache({ cacheDir: path.join(rootDir, 'resume-cache') });
    const session1 = await resumeCache.openStagingSession('1.0.62', signed2.index.assets[0]);
    assert.deepEqual(session1.getMissingChunkIndices(), [0, 1, 2]);
    await session1.writeVerifiedChunk(0, pkg2.buffer.subarray(0, 64 * 1024));
    assert.deepEqual(session1.getMissingChunkIndices(), [1, 2]);

    const session2 = await resumeCache.openStagingSession('1.0.62', signed2.index.assets[0]);
    assert.deepEqual(
      session2.getMissingChunkIndices(),
      [1, 2],
      'Resumed staging session must retain verified chunk 0 after re-verifying disk hash'
    );

    // 3. Mid-transfer user toggle OFF -> immediate P2P abort and seamless S3 fallback
    const slowCache = new VerifiedCache({ cacheDir: path.join(rootDir, 'slow-seeder') });
    await slowCache.importVerifiedPackageFile(pkg2.filePath, '1.0.62', signed2.index.assets[0]);

    const origRead = slowCache.readAuthorizedChunk.bind(slowCache);
    slowCache.readAuthorizedChunk = async (params) => {
      if (params.chunkIndex >= 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
      return origRead(params);
    };

    slowSeeder = new P2PNode({
      stateDir: path.join(rootDir, 'slow-seeder-state'),
      verifiedCache: slowCache,
      role: 'vps-seeder',
      seedingEnabled: true,
      bindIpv6: '::1',
      bindIpv4: '127.0.0.1'
    });
    await slowSeeder.start();

    const s3Asset = {
      PackageId: 'SA-CHAOS',
      Version: '1.0.62',
      Type: 'Full',
      FileName: pkg2.filename,
      SHA1: pkg2.sha1,
      SHA256: pkg2.sha256.toUpperCase(),
      Size: pkg2.sizeBytes
    };

    let s3Downloads = 0;
    const MockUM = createMockUpdateManagerClass({
      s3ReleaseAsset: s3Asset,
      onS3Download: () => s3Downloads++
    });

    orch = new HybridUpdateOrchestrator({
      dataDir: path.join(rootDir, 'cancel-client'),
      trustedKeys,
      s3Adapter: new ExistingS3UpdaterAdapter({
        UpdateManagerClass: MockUM,
        httpClient: {
          get: async (url) => {
            if (url.endsWith('releases.win.json')) return { data: { Assets: [s3Asset] } };
            if (url.endsWith('p2p-index.win.json')) return { data: signed2.index };
            if (url.endsWith('p2p-index.win.sig')) return { data: signed2.signatureFileContent };
          }
        }
      }),
      initialConfig: {
        p2pUpdaterConsentAccepted: true,
        p2pUpdaterEnabled: true,
        p2pSeedingEnabled: false,
        p2pBootstrapMultiaddrs: slowSeeder.getMultiaddrs({ includeLoopback: true })
      }
    });

    let toggledOffMidStream = false;
    const result = await orch.checkForUpdatesAndInstall({
      onProgress: (prog) => {
        if (!toggledOffMidStream && prog.status === UI_STATUS_LABELS.DOWNLOADING_VPS) {
          toggledOffMidStream = true;
          // User turns OFF P2P toggle right in the middle of P2P transfer!
          orch.updateConfig({ p2pUpdaterEnabled: false });
        }
      }
    });

    assert.equal(toggledOffMidStream, true);
    assert.equal(result.updated, true);
    assert.equal(result.source, 's3-fallback');
    assert.equal(s3Downloads, 1, 'Turning P2P OFF mid-transfer must seamlessly complete update via S3');
    assert.equal(orch.getStatusSnapshot().p2pActive, false);
    assert.ok(orch.telemetry.userCancellations >= 1);
  } finally {
    await slowSeeder?.stop().catch(() => {});
    await orch?.shutdown().catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

