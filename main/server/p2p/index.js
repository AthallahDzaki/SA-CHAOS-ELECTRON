import fs from 'fs';
import net from 'net';
import path from 'path';
import { APP_DATA_ROOT, readJson, writeJson, GeneralConfig } from '../shared.js';
import { HybridUpdateOrchestrator, VALID_ORCHESTRATOR_STATES, UI_STATUS_LABELS } from './hybrid-orchestrator.js';
import { P2PNode, parseMultiaddr, formatMultiaddr, derivePeerIdFromSpkiDer, redactIpAddress } from './p2p-node.js';
import { VerifiedCache, DEFAULT_MAX_CACHE_BYTES } from './verified-cache.js';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_TRUSTED_PUBLISHER_KEYS,
  isValidPackageFilename,
  generatePublisherKeyPair,
  computeFileHashesAndChunks,
  createSignedP2PReleaseIndex,
  verifySignedP2PReleaseIndex
} from './signed-release-index.js';
import { canonicalizeJson, canonicalizeJsonBuffer } from './canonical-json.js';
import {
  ExistingS3UpdaterAdapter,
  VelopackLocalSourceAdapter,
  OFFICIAL_S3_UPDATE_URL
} from './velopack-bridge.js';

const CONFIG_FILE_PATH = path.join(APP_DATA_ROOT, 'config.json');
export const GITHUB_PEERS_CONFIG_URL = 'https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-P2P-CONFIG/king/peers.json';
export const PEERS_CACHE_FILE = path.join(APP_DATA_ROOT, 'p2p-peers-cache.json');

export const DEFAULT_P2P_GENERAL_SETTINGS = Object.freeze({
  p2pUpdaterEnabled: false,
  p2pUpdaterConsentAccepted: false,
  p2pSeedingEnabled: false,
  p2pMaxUploadKBps: 2048,
  p2pMaxCacheMB: 600,
  p2pBootstrapMultiaddrs: Object.freeze([
    '/ip6/2406:da1c:11f2:14b:dc34:88da:9283:b479/tcp/4001/p2p/12D3KooWBPstsnWFM4UpynN3GQqS6j3JznmyHAFznCFwXFAWXgEE',
    '/ip6/2406:da1c:11f2:16a:ca72:9311:c32c:d9d/tcp/4001/p2p/12D3KooWBPstsnWFM4UpynN3GQqS6j3JznmyHAFznCFwXFAWXgEE',
    '/ip4/3.25.222.23/tcp/4001/p2p/12D3KooWBPstsnWFM4UpynN3GQqS6j3JznmyHAFznCFwXFAWXgEE'
  ])
});

let cachedRemotePeersConfig = null;

export async function fetchRemotePeersConfig({ timeoutMs = 3500, force = false } = {}) {
  if (cachedRemotePeersConfig && !force) {
    return cachedRemotePeersConfig;
  }

  let fileCache = null;
  if (fs.existsSync(PEERS_CACHE_FILE)) {
    try {
      fileCache = JSON.parse(fs.readFileSync(PEERS_CACHE_FILE, 'utf8'));
    } catch {
      fileCache = null;
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(GITHUB_PEERS_CONFIG_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'SA-CHAOS-P2P/1.0' }
    });
    clearTimeout(timer);

    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.bootstrapPeers) && data.bootstrapPeers.length > 0) {
        cachedRemotePeersConfig = data;
        try {
          fs.writeFileSync(PEERS_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
        } catch {
          // ignore cache write error
        }
        return data;
      }
    }
  } catch {
    // Network or fetch failed, fallback to local cache or defaults
  }

  if (fileCache && Array.isArray(fileCache.bootstrapPeers) && fileCache.bootstrapPeers.length > 0) {
    cachedRemotePeersConfig = fileCache;
    return fileCache;
  }

  const fallback = {
    version: 1,
    bootstrapPeers: Array.from(DEFAULT_P2P_GENERAL_SETTINGS.p2pBootstrapMultiaddrs),
    probeEndpoints: {
      ipv6: '[2406:da1c:11f2:14b:dc34:88da:9283:b479]:4001',
      ipv4: '3.25.222.23:4001'
    }
  };
  cachedRemotePeersConfig = fallback;
  return fallback;
}

let globalOrchestrator = null;

export function readPersistedP2PSettings() {
  const cfg = readJson(CONFIG_FILE_PATH, GeneralConfig || {});
  const gen = (cfg && cfg.General) || (GeneralConfig && GeneralConfig.General) || {};
  const channel = String(gen.UpdateChannel || 'release').toLowerCase() === 'beta' ? 'beta' : 'win';
  return {
    channel,
    p2pUpdaterEnabled: Boolean(gen.p2pUpdaterEnabled ?? false),
    p2pUpdaterConsentAccepted: Boolean(gen.p2pUpdaterConsentAccepted ?? false),
    p2pSeedingEnabled: Boolean(gen.p2pSeedingEnabled ?? false),
    p2pMaxUploadKBps: Number(gen.p2pMaxUploadKBps) > 0 ? Number(gen.p2pMaxUploadKBps) : 2048,
    p2pMaxCacheMB: Number(gen.p2pMaxCacheMB) >= 100 ? Number(gen.p2pMaxCacheMB) : 600,
    p2pBootstrapMultiaddrs: Array.isArray(gen.p2pBootstrapMultiaddrs)
      ? gen.p2pBootstrapMultiaddrs.filter((m) => typeof m === 'string' && Boolean(parseMultiaddr(m)))
      : []
  };
}

export function persistP2PSettingsToConfig(partial = {}) {
  const cfg = readJson(CONFIG_FILE_PATH, GeneralConfig || {});
  if (!cfg.General || typeof cfg.General !== 'object') {
    cfg.General = {};
  }

  if (typeof partial.p2pUpdaterConsentAccepted === 'boolean') {
    cfg.General.p2pUpdaterConsentAccepted = partial.p2pUpdaterConsentAccepted;
  }

  if (typeof partial.p2pUpdaterEnabled === 'boolean') {
    // Only allow enabling P2P if consent has been accepted
    if (partial.p2pUpdaterEnabled && !cfg.General.p2pUpdaterConsentAccepted && !partial.p2pUpdaterConsentAccepted) {
      throw new Error('CONSENT_REQUIRED: Pengguna harus menyetujui informasi P2P Alpha terlebih dahulu.');
    }
    cfg.General.p2pUpdaterEnabled = partial.p2pUpdaterEnabled;
    // IMPORTANT: Never auto-enable p2pSeedingEnabled when p2pUpdaterEnabled is turned ON!
    if (typeof cfg.General.p2pSeedingEnabled !== 'boolean') {
      cfg.General.p2pSeedingEnabled = false;
    }
  }

  if (typeof partial.p2pSeedingEnabled === 'boolean') {
    cfg.General.p2pSeedingEnabled = partial.p2pSeedingEnabled;
  }

  if (typeof partial.p2pMaxUploadKBps === 'number' && Number.isFinite(partial.p2pMaxUploadKBps)) {
    cfg.General.p2pMaxUploadKBps = Math.max(64, Math.min(102400, Math.round(partial.p2pMaxUploadKBps)));
  }

  if (typeof partial.p2pMaxCacheMB === 'number' && Number.isFinite(partial.p2pMaxCacheMB)) {
    cfg.General.p2pMaxCacheMB = Math.max(100, Math.min(10240, Math.round(partial.p2pMaxCacheMB)));
  }

  if (Array.isArray(partial.p2pBootstrapMultiaddrs)) {
    cfg.General.p2pBootstrapMultiaddrs = partial.p2pBootstrapMultiaddrs
      .filter((m) => typeof m === 'string' && Boolean(parseMultiaddr(m)))
      .slice(0, 16);
  }

  // Keep in-memory GeneralConfig synchronized
  if (GeneralConfig && GeneralConfig.General) {
    Object.assign(GeneralConfig.General, {
      p2pUpdaterEnabled: Boolean(cfg.General.p2pUpdaterEnabled),
      p2pUpdaterConsentAccepted: Boolean(cfg.General.p2pUpdaterConsentAccepted),
      p2pSeedingEnabled: Boolean(cfg.General.p2pSeedingEnabled),
      p2pMaxUploadKBps: cfg.General.p2pMaxUploadKBps ?? 2048,
      p2pMaxCacheMB: cfg.General.p2pMaxCacheMB ?? 600,
      p2pBootstrapMultiaddrs: cfg.General.p2pBootstrapMultiaddrs || []
    });
  }

  writeJson(CONFIG_FILE_PATH, cfg);
  return readPersistedP2PSettings();
}

export function getGlobalP2POrchestrator() {
  if (!globalOrchestrator) {
    const initialConfig = readPersistedP2PSettings();
    globalOrchestrator = new HybridUpdateOrchestrator({
      dataDir: APP_DATA_ROOT,
      channel: initialConfig.channel || 'win',
      initialConfig
    });
    // If user previously opted into both P2P and seeding, start background seeding listener safely
    if (initialConfig.p2pUpdaterEnabled && initialConfig.p2pSeedingEnabled) {
      globalOrchestrator.updateConfig(initialConfig).catch((err) => {
        console.warn('[P2P Orchestrator] Background seeder startup warning:', err.message);
      });
    }
  }
  return globalOrchestrator;
}

export async function updateGlobalP2PConfig(partial = {}) {
  const saved = persistP2PSettingsToConfig(partial);
  const orch = getGlobalP2POrchestrator();
  return await orch.updateConfig(saved);
}

export function getGlobalP2PStatus() {
  const saved = readPersistedP2PSettings();
  if (!globalOrchestrator && !saved.p2pUpdaterEnabled) {
    // Do not instantiate any P2P subsystem when P2P is OFF
    return {
      state: 'IDLE',
      statusLabel: '',
      sourceCategory: 'S3 (Standard)',
      fallbackReason: null,
      progress: {
        percent: 0,
        transferredBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        targetVersion: null
      },
      config: {
        ...saved,
        effectiveSeeding: false
      },
      cacheUsageBytes: 0,
      maxCacheBytes: (saved.p2pMaxCacheMB || 600) * 1024 * 1024,
      p2pActive: false,
      seedingActive: false,
      multiaddrs: [],
      telemetry: {
        totalChecks: 0,
        p2pAttempts: 0,
        p2pSuccesses: 0,
        s3Downloads: 0,
        fallbacksByReason: {}
      }
    };
  }
  return getGlobalP2POrchestrator().getStatusSnapshot();
}

/**
 * Diagnostic probe to verify live P2P readiness & VPS Seeder reachability
 * over IPv6 and IPv4 fallback without altering any running updater state.
 */
export async function probeP2PReadiness({ timeoutMs = 3500 } = {}) {
  const remoteCfg = await fetchRemotePeersConfig({ timeoutMs: Math.min(timeoutMs, 3000) });

  let hostV6 = '2406:da1c:11f2:14b:dc34:88da:9283:b479';
  let portV6 = 4001;
  let hostV4 = '3.25.222.23';
  let portV4 = 4001;

  if (remoteCfg && remoteCfg.probeEndpoints) {
    if (remoteCfg.probeEndpoints.ipv6) {
      const match = remoteCfg.probeEndpoints.ipv6.match(/\[?([^\]]+)\]?:(\d+)/);
      if (match) {
        hostV6 = match[1];
        portV6 = Number(match[2]);
      }
    }
    if (remoteCfg.probeEndpoints.ipv4) {
      const match = remoteCfg.probeEndpoints.ipv4.match(/([^:]+):(\d+)/);
      if (match) {
        hostV4 = match[1];
        portV4 = Number(match[2]);
      }
    }
  }

  const checkTcp = (host, port) => {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = net.createConnection({ host, port, timeout: timeoutMs });
      socket.on('connect', () => {
        const latencyMs = Date.now() - start;
        socket.destroy();
        resolve({ reachable: true, latencyMs, error: null });
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve({ reachable: false, latencyMs: null, error: 'TIMEOUT' });
      });
      socket.on('error', (err) => {
        socket.destroy();
        resolve({ reachable: false, latencyMs: null, error: err.code || err.message });
      });
    });
  };

  const [resV6, resV4] = await Promise.all([
    checkTcp(hostV6, portV6),
    checkTcp(hostV4, portV4)
  ]);

  const capable = resV6.reachable || resV4.reachable;
  const preferredFamily = resV6.reachable ? 'IPv6' : (resV4.reachable ? 'IPv4' : 'None');
  const latencyMs = resV6.reachable ? resV6.latencyMs : (resV4.reachable ? resV4.latencyMs : null);

  let label = 'P2P Siap (IPv6 Dual-Stack Terhubung)';
  let status = 'READY';
  if (resV6.reachable && resV4.reachable) {
    label = `Bisa Digunakan (IPv6 & IPv4 Online • ${latencyMs}ms)`;
  } else if (resV6.reachable) {
    label = `Bisa Digunakan (IPv6 Online • ${latencyMs}ms)`;
  } else if (resV4.reachable) {
    label = `Bisa Digunakan (IPv4 Online • ${latencyMs}ms)`;
  } else {
    label = 'P2P Offline (Otomatis S3 Standar)';
    status = 'OFFLINE';
  }

  return {
    capable,
    vpsReachable: capable,
    status,
    label,
    preferredFamily,
    latencyMs,
    ipv6: resV6.reachable,
    ipv4: resV4.reachable,
    ipv6Error: resV6.error || null,
    ipv4Error: resV4.error || null,
    checkedAt: new Date().toISOString()
  };
}

export {
  HybridUpdateOrchestrator,
  VALID_ORCHESTRATOR_STATES,
  UI_STATUS_LABELS,
  P2PNode,
  parseMultiaddr,
  formatMultiaddr,
  derivePeerIdFromSpkiDer,
  redactIpAddress,
  VerifiedCache,
  DEFAULT_MAX_CACHE_BYTES,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_TRUSTED_PUBLISHER_KEYS,
  isValidPackageFilename,
  generatePublisherKeyPair,
  computeFileHashesAndChunks,
  createSignedP2PReleaseIndex,
  verifySignedP2PReleaseIndex,
  canonicalizeJson,
  canonicalizeJsonBuffer,
  ExistingS3UpdaterAdapter,
  VelopackLocalSourceAdapter,
  OFFICIAL_S3_UPDATE_URL
};
