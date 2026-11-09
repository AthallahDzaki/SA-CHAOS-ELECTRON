#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_TRUSTED_PUBLISHER_KEYS,
  verifySignedP2PReleaseIndex
} from '../main/server/p2p/signed-release-index.js';
import { VerifiedCache } from '../main/server/p2p/verified-cache.js';
import { P2PNode } from '../main/server/p2p/p2p-node.js';

/**
 * Ubuntu VPS Dual-Stack P2P Seeder & Bootstrap Daemon
 * - Binds explicitly to both IPv6 (`::` with ipv6Only: true) and IPv4 (`0.0.0.0`).
 * - Verifies Ed25519 signature on `p2p-index.win.json` + `p2p-index.win.sig` and SHA-256 of `.nupkg`
 *   BEFORE advertising or serving any package chunks.
 * - Never exposes a public admin/RPC port or arbitrary file read.
 */
export async function startVpsSeederDaemon(customConfig = null) {
  let config = {
    listenPort: 4001,
    bindIpv6: '::',
    bindIpv4: '0.0.0.0',
    publicIpv6: null,
    publicIpv4: null,
    releasesDir: '/var/lib/decentraupdate/releases',
    stateDir: '/var/lib/decentraupdate/state',
    maxConcurrentPeers: 32,
    maxUploadKBps: 20480,
    maxCacheMB: 2048,
    appId: 'SA-CHAOS',
    channel: 'win',
    arch: 'x64',
    trustedKeys: DEFAULT_TRUSTED_PUBLISHER_KEYS
  };

  if (customConfig && typeof customConfig === 'object') {
    config = { ...config, ...customConfig };
  } else {
    const configPath = process.argv[2] || process.env.DECENTRAUPDATE_CONFIG || '/etc/decentraupdate/config.json';
    if (fs.existsSync(configPath)) {
      const loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = { ...config, ...loaded };
    }
  }

  const stateDir = path.resolve(config.stateDir);
  const releasesDir = path.resolve(config.releasesDir);
  const cacheDir = path.join(stateDir, 'cache');

  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  if (!fs.existsSync(releasesDir)) fs.mkdirSync(releasesDir, { recursive: true });

  const verifiedCache = new VerifiedCache({
    cacheDir,
    maxCacheBytes: (Number(config.maxCacheMB) || 2048) * 1024 * 1024
  });

  const loadAndVerifyReleases = async () => {
    const indexFile = path.join(releasesDir, 'p2p-index.win.json');
    const sigFile = path.join(releasesDir, 'p2p-index.win.sig');

    if (!fs.existsSync(indexFile) || !fs.existsSync(sigFile)) {
      console.log(`[VPS Seeder] No p2p-index.win.json / .sig found in ${releasesDir} yet; running as bootstrap peer.`);
      return null;
    }

    const indexRaw = fs.readFileSync(indexFile, 'utf8');
    const sigRaw = fs.readFileSync(sigFile, 'utf8');

    const verified = verifySignedP2PReleaseIndex({
      indexInput: indexRaw,
      signatureInput: sigRaw,
      expectedAppId: config.appId,
      expectedPlatform: 'win',
      expectedArch: config.arch,
      expectedChannel: config.channel,
      trustedKeys: config.trustedKeys
    });

    const assetsToLoad = Array.isArray(verified.assets) && verified.assets.length > 0
      ? verified.assets
      : [verified.fullAsset];

    const loadedRecords = [];
    for (const asset of assetsToLoad) {
      const pkgPath = path.join(releasesDir, asset.filename);
      if (!fs.existsSync(pkgPath)) {
        if (asset.type === 'Full') {
          throw new Error(`Signed index references required Full package ${asset.filename}, but file is missing in ${releasesDir}`);
        } else {
          console.warn(`[VPS Seeder] Optional ${asset.type} package ${asset.filename} not found in ${releasesDir}; skipping.`);
          continue;
        }
      }

      const record = await verifiedCache.importVerifiedPackageFile(
        pkgPath,
        verified.index.version,
        asset
      );
      console.log(
        `[VPS Seeder] Verified and loaded ${asset.type || 'Package'} release v${record.version} (${record.filename}, ${record.size} bytes, sha256=${record.sha256})`
      );
      loadedRecords.push(record);
    }
    return loadedRecords;
  };

  await loadAndVerifyReleases();

  const node = new P2PNode({
    stateDir,
    verifiedCache,
    role: 'vps-seeder',
    seedingEnabled: true,
    listenPort: config.listenPort,
    bindIpv6: config.bindIpv6,
    bindIpv4: config.bindIpv4,
    publicIpv6: config.publicIpv6,
    publicIpv4: config.publicIpv4,
    maxConcurrentPeers: config.maxConcurrentPeers,
    maxUploadKBps: config.maxUploadKBps
  });

  const multiaddrs = await node.start();
  console.log(`[VPS Seeder] Started dual-stack seeder node (PeerId: ${node.peerId})`);
  for (const ma of multiaddrs) {
    console.log(`[VPS Seeder] Listening multiaddr: ${ma}`);
  }

  return {
    node,
    verifiedCache,
    reloadReleases: loadAndVerifyReleases,
    stop: async () => {
      await node.stop();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seeder-daemon.js')) {
  startVpsSeederDaemon()
    .then((daemon) => {
      process.on('SIGHUP', () => {
        console.log('[VPS Seeder] Received SIGHUP — reloading signed release index...');
        daemon.reloadReleases().catch((err) => {
          console.error('[VPS Seeder] Reload error:', err.message);
        });
      });
      const shutdown = async () => {
        console.log('[VPS Seeder] Shutting down cleanly...');
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[VPS Seeder] Fatal startup error:', err.message);
      process.exit(1);
    });
}
