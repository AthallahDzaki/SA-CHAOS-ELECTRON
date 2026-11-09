import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export const MULTISTREAM_ID = '/multistream/1.0.0';
export const PACKAGE_PROTOCOL_ID = '/decentraupdate/package/1.0.0';
export const PEERS_PROTOCOL_ID = '/decentraupdate/peers/1.0.0';

const MAX_FRAME_BYTES = 9 * 1024 * 1024; // 9 MiB hard ceiling per frame
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    leadingZeros++;
  }
  let result = BASE58_ALPHABET[0].repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

/**
 * Derives a standard libp2p Ed25519 PeerId (12D3KooW...) from an SPKI DER Ed25519 public key.
 * Identity multihash prefix: 0x00 (identity) 0x24 (36 bytes) 0x08 0x01 (KeyType=Ed25519) 0x12 0x20 (32-byte raw pubkey).
 */
export function derivePeerIdFromSpkiDer(spkiDerBuffer) {
  const buf = Buffer.isBuffer(spkiDerBuffer) ? spkiDerBuffer : Buffer.from(spkiDerBuffer, 'base64');
  // Standard Ed25519 SPKI DER is 44 bytes; the last 32 bytes are the raw public key
  const rawPub = buf.length >= 32 ? buf.subarray(buf.length - 32) : crypto.createHash('sha256').update(buf).digest();
  const multihash = Buffer.concat([Buffer.from([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]), rawPub]);
  return encodeBase58(multihash);
}

export function generateOrLoadPeerIdentity(stateDir) {
  if (stateDir) {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const idFile = path.join(stateDir, 'peer-identity.json');
    if (fs.existsSync(idFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(idFile, 'utf8'));
        if (saved.publicKeyDerBase64 && saved.privateKeyDerBase64 && saved.peerId) {
          return {
            peerId: saved.peerId,
            publicKeyDer: Buffer.from(saved.publicKeyDerBase64, 'base64'),
            privateKeyDer: Buffer.from(saved.privateKeyDerBase64, 'base64')
          };
        }
      } catch {
        // Regenerate if corrupt
      }
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });
    const peerId = derivePeerIdFromSpkiDer(publicKey);
    try {
      fs.writeFileSync(
        idFile,
        JSON.stringify(
          {
            peerId,
            publicKeyDerBase64: publicKey.toString('base64'),
            privateKeyDerBase64: privateKey.toString('base64'),
            createdAt: new Date().toISOString()
          },
          null,
          2
        ),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch {
      // ignore write error on read-only FS
    }
    return { peerId, publicKeyDer: publicKey, privateKeyDer: privateKey };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  return {
    peerId: derivePeerIdFromSpkiDer(publicKey),
    publicKeyDer: publicKey,
    privateKeyDer: privateKey
  };
}

/**
 * Parses a multiaddr such as:
 *   /ip6/2001:db8::10/tcp/4001/p2p/12D3KooW...
 *   /ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
 */
export function parseMultiaddr(multiaddrStr) {
  if (typeof multiaddrStr !== 'string') return null;
  const trimmed = multiaddrStr.trim();
  const match = trimmed.match(/^\/(ip6|ip4)\/([^/]+)\/tcp\/(\d+)(?:\/(?:p2p|ipfs)\/([A-Za-z0-9]+))?$/i);
  if (!match) return null;
  const family = match[1].toLowerCase() === 'ip6' ? 'IPv6' : 'IPv4';
  const host = match[2];
  const port = Number(match[3]);
  const peerId = match[4] || null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const ipVersion = net.isIP(host);
  if (family === 'IPv6' && ipVersion !== 6) return null;
  if (family === 'IPv4' && ipVersion !== 4) return null;
  return {
    raw: trimmed,
    family,
    host,
    port,
    peerId
  };
}

export function formatMultiaddr({ family, host, port, peerId }) {
  const proto = family === 'IPv6' || net.isIP(host) === 6 ? 'ip6' : 'ip4';
  const base = `/${proto}/${host}/tcp/${port}`;
  return peerId ? `${base}/p2p/${peerId}` : base;
}

export function redactIpAddress(ip) {
  if (!ip || typeof ip !== 'string') return 'unknown';
  if (ip === '::1' || ip === '127.0.0.1') return ip;
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return `${parts.slice(0, 2).join(':')}::*`;
  }
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  }
  return 'redacted';
}

export class TokenBucketRateLimiter {
  constructor(bytesPerSecond = 2 * 1024 * 1024) {
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.bytesPerSecond = Math.max(16 * 1024, Number(bytesPerSecond) || 2 * 1024 * 1024);
    this.tokens = this.bytesPerSecond;
    this.lastRefill = Date.now();
  }

  async consume(byteCount) {
    if (!this.bytesPerSecond || this.bytesPerSecond <= 0) return;
    let remaining = byteCount;
    while (remaining > 0) {
      const now = Date.now();
      const elapsedSec = Math.max(0, (now - this.lastRefill) / 1000);
      if (elapsedSec > 0) {
        this.tokens = Math.min(this.bytesPerSecond, this.tokens + elapsedSec * this.bytesPerSecond);
        this.lastRefill = now;
      }
      if (this.tokens >= remaining) {
        this.tokens -= remaining;
        return;
      }
      if (this.tokens > 0) {
        remaining -= this.tokens;
        this.tokens = 0;
      }
      const waitMs = Math.min(250, Math.max(10, Math.ceil((remaining / this.bytesPerSecond) * 1000)));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * Framed Socket Reader/Writer with AES-256-GCM authenticated encryption after handshake.
 */
class FramedChannel {
  constructor(socket, idleTimeoutMs = 20000) {
    this.socket = socket;
    try {
      socket.setNoDelay(true);
    } catch {
      // ignore
    }
    this.chunks = [];
    this.bufferedBytes = 0;
    this.waiters = [];
    this.closed = false;
    this.error = null;
    this.txKey = null;
    this.rxKey = null;
    this.txSeq = 0n;
    this.rxSeq = 0n;
    this.txPrefix = Buffer.alloc(4);
    this.rxPrefix = Buffer.alloc(4);
    this.idleTimeoutMs = idleTimeoutMs;

    if (idleTimeoutMs > 0) {
      socket.setTimeout(idleTimeoutMs);
    }

    socket.on('timeout', () => {
      this._fail(new Error(`P2P stream idle timeout (${idleTimeoutMs}ms)`));
      socket.destroy();
    });

    socket.on('data', (chunk) => {
      if (this.closed) return;
      if (this.bufferedBytes + chunk.length > MAX_FRAME_BYTES + 4096) {
        this._fail(new Error('Frame buffer overflow: peer exceeded MAX_FRAME_BYTES'));
        socket.destroy();
        return;
      }
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.length;
      this._drain();
    });

    socket.on('error', (err) => {
      this._fail(err);
    });

    socket.on('close', () => {
      this.closed = true;
      this._fail(new Error('P2P socket closed'));
    });
  }

  enableEncryption(txKey, rxKey, isInitiator) {
    this.txKey = txKey;
    this.rxKey = rxKey;
    this.txSeq = 0n;
    this.rxSeq = 0n;
    this.txPrefix = Buffer.from(isInitiator ? 'CLNT' : 'SRVR');
    this.rxPrefix = Buffer.from(isInitiator ? 'SRVR' : 'CLNT');
  }

  _buildIv(prefix, seq) {
    const iv = Buffer.allocUnsafe(12);
    prefix.copy(iv, 0, 0, 4);
    iv.writeBigUInt64BE(seq, 4);
    return iv;
  }

  _fail(err) {
    if (!this.error) this.error = err;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      w.reject(this.error);
    }
  }

  _drain() {
    while (this.waiters.length > 0 && this.bufferedBytes >= 4) {
      // Ensure we have at least 4 contiguous bytes for frame length
      if (this.chunks[0].length < 4) {
        this.chunks = [Buffer.concat(this.chunks)];
      }
      const frameLen = this.chunks[0].readUInt32BE(0);
      if (frameLen > MAX_FRAME_BYTES) {
        this._fail(new Error(`Invalid frame length: ${frameLen} exceeds ${MAX_FRAME_BYTES}`));
        this.socket.destroy();
        return;
      }
      if (this.bufferedBytes < 4 + frameLen) {
        return;
      }

      // We have the full frame! Assemble and slice efficiently in linear O(N) time
      const fullBuffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      const rawPayload = fullBuffer.subarray(4, 4 + frameLen);
      const leftover = fullBuffer.subarray(4 + frameLen);
      this.chunks = leftover.length > 0 ? [leftover] : [];
      this.bufferedBytes = leftover.length;

      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);

      try {
        if (this.rxKey) {
          if (rawPayload.length < 16) {
            throw new Error('Encrypted frame too short for GCM authTag');
          }
          const iv = this._buildIv(this.rxPrefix, this.rxSeq++);
          const authTag = rawPayload.subarray(0, 16);
          const ciphertext = rawPayload.subarray(16);
          const decipher = crypto.createDecipheriv('aes-256-gcm', this.rxKey, iv);
          decipher.setAuthTag(authTag);
          const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          waiter.resolve(plaintext);
        } else {
          waiter.resolve(rawPayload);
        }
      } catch (decErr) {
        waiter.reject(decErr);
        this.socket.destroy();
        return;
      }
    }
  }

  readFrame(timeoutMs = this.idleTimeoutMs) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`P2P readFrame timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      this._drain();
    });
  }

  async readJson(timeoutMs = this.idleTimeoutMs) {
    const buf = await this.readFrame(timeoutMs);
    return JSON.parse(buf.toString('utf8'));
  }

  writeFrame(payloadBuffer) {
    if (this.closed || this.error) {
      return Promise.reject(this.error || new Error('Socket closed'));
    }
    let outPayload = payloadBuffer;
    if (this.txKey) {
      const iv = this._buildIv(this.txPrefix, this.txSeq++);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.txKey, iv);
      const encrypted = Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
      const authTag = cipher.getAuthTag();
      outPayload = Buffer.concat([authTag, encrypted]);
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(outPayload.length, 0);
    const frame = Buffer.concat([header, outPayload]);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  writeJson(obj) {
    return this.writeFrame(Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close() {
    this.closed = true;
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}

export class P2PNode {
  constructor({
    stateDir,
    verifiedCache,
    role = 'user-peer', // 'user-peer' or 'vps-seeder'
    seedingEnabled = false,
    listenPort = 0,
    bindIpv6 = '::',
    bindIpv4 = '0.0.0.0',
    publicIpv6 = null,
    publicIpv4 = null,
    bootstrapMultiaddrs = [],
    maxConcurrentPeers = 8,
    maxUploadKBps = 2048,
    discoveryTimeoutMs = 6000,
    connectTimeoutMs = 8000,
    firstByteTimeoutMs = 10000,
    idleTimeoutMs = 20000,
    happyEyeballsDelayMs = 2000,
    minSpeedBytesPerSec = 32768,
    maxPeerAttempts = 2,
    logger = console
  } = {}) {
    this.stateDir = stateDir;
    this.verifiedCache = verifiedCache;
    this.role = role;
    this.seedingEnabled = Boolean(seedingEnabled);
    this.listenPort = Number(listenPort) || 0;
    this.bindIpv6 = bindIpv6;
    this.bindIpv4 = bindIpv4;
    this.publicIpv6 = publicIpv6;
    this.publicIpv4 = publicIpv4;
    this.bootstrapMultiaddrs = Array.isArray(bootstrapMultiaddrs) ? [...bootstrapMultiaddrs] : [];
    this.maxConcurrentPeers = Number(maxConcurrentPeers) || 8;
    this.rateLimiter = new TokenBucketRateLimiter((Number(maxUploadKBps) || 2048) * 1024);

    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.firstByteTimeoutMs = firstByteTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.happyEyeballsDelayMs = happyEyeballsDelayMs;
    this.minSpeedBytesPerSec = minSpeedBytesPerSec;
    this.maxPeerAttempts = maxPeerAttempts;
    this.logger = logger;

    const identity = generateOrLoadPeerIdentity(stateDir);
    this.peerId = identity.peerId;
    this.publicKeyDer = identity.publicKeyDer;
    this.privateKeyDer = identity.privateKeyDer;
    this.privateKeyObj = crypto.createPrivateKey({ key: this.privateKeyDer, format: 'der', type: 'pkcs8' });

    this.serverIpv6 = null;
    this.serverIpv4 = null;
    this.boundPortIpv6 = null;
    this.boundPortIpv4 = null;
    this.activeSockets = new Set();
    this.knownPeers = new Map(); // peerId -> { peerId, multiaddrs: Set, role, lastSeen }
    this.running = false;

    this.stats = {
      bytesDownloadedFromVps: 0,
      bytesDownloadedFromPeers: 0,
      bytesUploaded: 0,
      ipv6BytesDownloaded: 0,
      ipv4BytesDownloaded: 0,
      chunksVerified: 0,
      chunkVerificationFailures: 0,
      connectionsAccepted: 0,
      connectionsRejected: 0,
      transferHistory: []
    };

    this._loadPersistedPeersSync();
    for (const ma of this.bootstrapMultiaddrs) {
      this.addKnownPeerMultiaddr(ma, 'vps-seeder');
    }
  }

  _peersFilePath() {
    return this.stateDir ? path.join(this.stateDir, 'p2p-peers.json') : null;
  }

  _loadPersistedPeersSync() {
    const file = this._peersFilePath();
    if (!file || !fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw.peers)) {
        for (const p of raw.peers) {
          if (p && p.peerId && p.peerId !== this.peerId && Array.isArray(p.multiaddrs)) {
            const validAddrs = p.multiaddrs.filter((m) => Boolean(parseMultiaddr(m)));
            if (validAddrs.length > 0) {
              this.knownPeers.set(p.peerId, {
                peerId: p.peerId,
                multiaddrs: new Set(validAddrs),
                role: p.role || 'user-peer',
                lastSeen: p.lastSeen || Date.now()
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  _savePersistedPeersSync() {
    const file = this._peersFilePath();
    if (!file) return;
    try {
      const peers = Array.from(this.knownPeers.values())
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .slice(0, 32)
        .map((p) => ({
          peerId: p.peerId,
          multiaddrs: Array.from(p.multiaddrs),
          role: p.role || 'user-peer',
          lastSeen: p.lastSeen || Date.now()
        }));
      fs.writeFileSync(file, JSON.stringify({ peers }, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  addKnownPeerMultiaddr(multiaddrStr, role = 'user-peer') {
    const parsed = parseMultiaddr(multiaddrStr);
    if (!parsed) return false;
    const key = parsed.peerId || `${parsed.family}:${parsed.host}:${parsed.port}`;
    if (key === this.peerId) return false;
    const existing = this.knownPeers.get(key) || {
      peerId: key,
      multiaddrs: new Set(),
      role,
      lastSeen: Date.now()
    };
    existing.multiaddrs.add(parsed.raw);
    if (role === 'vps-seeder') existing.role = 'vps-seeder';
    existing.lastSeen = Date.now();
    this.knownPeers.set(key, existing);
    this._savePersistedPeersSync();
    return true;
  }

  setBootstrapMultiaddrs(multiaddrs) {
    if (!Array.isArray(multiaddrs)) return;
    this.bootstrapMultiaddrs = [...multiaddrs];
    for (const ma of multiaddrs) {
      this.addKnownPeerMultiaddr(ma, 'vps-seeder');
    }
  }

  setSeedingEnabled(enabled) {
    this.seedingEnabled = Boolean(enabled);
  }

  setMaxUploadKBps(kbps) {
    if (Number.isFinite(kbps) && kbps > 0) {
      this.rateLimiter.setRate(kbps * 1024);
    }
  }

  /**
   * Starts dual-stack TCP listeners (IPv6 [::] with ipv6Only:true and IPv4 0.0.0.0)
   * when seeding is enabled or node is a VPS seeder.
   */
  async start() {
    if (this.running) return this.getMultiaddrs();
    this.running = true;

    for (const ma of this.bootstrapMultiaddrs) {
      this.addKnownPeerMultiaddr(ma, 'vps-seeder');
    }

    if (!this.seedingEnabled && this.role !== 'vps-seeder') {
      // Client-only mode: do not open inbound listening sockets unless seeding is enabled
      return [];
    }

    // 1. Bind IPv6 listener (ipv6Only: true so IPv4 and IPv6 are explicitly separate sockets)
    if (this.bindIpv6) {
      try {
        this.serverIpv6 = net.createServer({ allowHalfOpen: false }, (socket) =>
          this._handleIncomingConnection(socket, 'IPv6')
        );
        await new Promise((resolve, reject) => {
          this.serverIpv6.once('error', reject);
          this.serverIpv6.listen(
            { host: this.bindIpv6, port: this.listenPort, ipv6Only: true },
            () => {
              this.serverIpv6.removeListener('error', reject);
              this.boundPortIpv6 = this.serverIpv6.address().port;
              resolve();
            }
          );
        });
      } catch (err) {
        this.serverIpv6 = null;
        this.logger.warn?.(`[P2PNode] IPv6 listener bind skipped: ${err.message}`);
      }
    }

    // 2. Bind IPv4 listener (prefer same port as IPv6 if ephemeral port was chosen)
    if (this.bindIpv4) {
      const targetPortV4 = this.listenPort || this.boundPortIpv6 || 0;
      try {
        this.serverIpv4 = net.createServer({ allowHalfOpen: false }, (socket) =>
          this._handleIncomingConnection(socket, 'IPv4')
        );
        await new Promise((resolve, reject) => {
          this.serverIpv4.once('error', reject);
          this.serverIpv4.listen({ host: this.bindIpv4, port: targetPortV4 }, () => {
            this.serverIpv4.removeListener('error', reject);
            this.boundPortIpv4 = this.serverIpv4.address().port;
            resolve();
          });
        });
      } catch {
        // Retry with port 0 if targetPortV4 collided
        try {
          this.serverIpv4 = net.createServer({ allowHalfOpen: false }, (socket) =>
            this._handleIncomingConnection(socket, 'IPv4')
          );
          await new Promise((resolve, reject) => {
            this.serverIpv4.once('error', reject);
            this.serverIpv4.listen({ host: this.bindIpv4, port: 0 }, () => {
              this.serverIpv4.removeListener('error', reject);
              this.boundPortIpv4 = this.serverIpv4.address().port;
              resolve();
            });
          });
        } catch (err2) {
          this.serverIpv4 = null;
          this.logger.warn?.(`[P2PNode] IPv4 listener bind skipped: ${err2.message}`);
        }
      }
    }

    return this.getMultiaddrs();
  }

  async stop() {
    this.running = false;
    for (const sock of this.activeSockets) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();

    const closeServer = (srv) =>
      new Promise((resolve) => {
        if (!srv) return resolve();
        try {
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });

    await Promise.all([closeServer(this.serverIpv6), closeServer(this.serverIpv4)]);
    this.serverIpv6 = null;
    this.serverIpv4 = null;
    this.boundPortIpv6 = null;
    this.boundPortIpv4 = null;
  }

  /**
   * Returns multiaddrs advertised by this node (IPv6 first, then IPv4).
   */
  getMultiaddrs({ includeLoopback = false } = {}) {
    const addrs = [];
    const seen = new Set();
    const pushUnique = (ma) => {
      if (!seen.has(ma)) {
        seen.add(ma);
        addrs.push(ma);
      }
    };

    const ifaces = os.networkInterfaces();

    if (this.boundPortIpv6) {
      if (this.publicIpv6) {
        pushUnique(
          formatMultiaddr({
            family: 'IPv6',
            host: this.publicIpv6,
            port: this.boundPortIpv6,
            peerId: this.peerId
          })
        );
      }
      if (this.bindIpv6 === '::' || this.bindIpv6 === '0:0:0:0:0:0:0:0') {
        for (const list of Object.values(ifaces)) {
          for (const info of list || []) {
            if (info.family === 'IPv6' && !info.internal && !info.address.toLowerCase().startsWith('fe80:')) {
              pushUnique(
                formatMultiaddr({
                  family: 'IPv6',
                  host: info.address,
                  port: this.boundPortIpv6,
                  peerId: this.peerId
                })
              );
            }
          }
        }
      } else if (this.bindIpv6 && net.isIP(this.bindIpv6) === 6) {
        pushUnique(
          formatMultiaddr({
            family: 'IPv6',
            host: this.bindIpv6,
            port: this.boundPortIpv6,
            peerId: this.peerId
          })
        );
      }
      if (includeLoopback && (this.bindIpv6 === '::' || this.bindIpv6 === '::1')) {
        pushUnique(
          formatMultiaddr({
            family: 'IPv6',
            host: '::1',
            port: this.boundPortIpv6,
            peerId: this.peerId
          })
        );
      }
    }

    if (this.boundPortIpv4) {
      if (this.publicIpv4) {
        pushUnique(
          formatMultiaddr({
            family: 'IPv4',
            host: this.publicIpv4,
            port: this.boundPortIpv4,
            peerId: this.peerId
          })
        );
      }
      if (this.bindIpv4 === '0.0.0.0') {
        for (const list of Object.values(ifaces)) {
          for (const info of list || []) {
            if (info.family === 'IPv4' && !info.internal) {
              pushUnique(
                formatMultiaddr({
                  family: 'IPv4',
                  host: info.address,
                  port: this.boundPortIpv4,
                  peerId: this.peerId
                })
              );
            }
          }
        }
      } else if (this.bindIpv4 && net.isIP(this.bindIpv4) === 4) {
        pushUnique(
          formatMultiaddr({
            family: 'IPv4',
            host: this.bindIpv4,
            port: this.boundPortIpv4,
            peerId: this.peerId
          })
        );
      }
      if (includeLoopback && (this.bindIpv4 === '0.0.0.0' || this.bindIpv4 === '127.0.0.1')) {
        pushUnique(
          formatMultiaddr({
            family: 'IPv4',
            host: '127.0.0.1',
            port: this.boundPortIpv4,
            peerId: this.peerId
          })
        );
      }
    }

    return addrs;
  }

  async _handleIncomingConnection(socket, family) {
    if (!this.running || (!this.seedingEnabled && this.role !== 'vps-seeder')) {
      this.stats.connectionsRejected++;
      socket.destroy();
      return;
    }

    if (this.activeSockets.size >= this.maxConcurrentPeers) {
      this.stats.connectionsRejected++;
      socket.destroy();
      return;
    }

    this.stats.connectionsAccepted++;
    this.activeSockets.add(socket);
    socket.once('close', () => this.activeSockets.delete(socket));

    const channel = new FramedChannel(socket, this.idleTimeoutMs);
    try {
      const hello = await channel.readJson(this.connectTimeoutMs);
      if (
        !hello ||
        hello.multistream !== MULTISTREAM_ID ||
        (hello.protocol !== PACKAGE_PROTOCOL_ID && hello.protocol !== PEERS_PROTOCOL_ID)
      ) {
        throw new Error('Unsupported multistream or protocol in HELLO');
      }

      const clientIdPubDer = Buffer.from(hello.idPubKeyDerBase64, 'base64');
      const derivedClientPeerId = derivePeerIdFromSpkiDer(clientIdPubDer);
      if (derivedClientPeerId !== hello.peerId) {
        throw new Error('Client PeerId does not match Ed25519 public key');
      }

      const clientEphPubDer = Buffer.from(hello.ephPubKeyDerBase64, 'base64');
      const clientNonce = Buffer.from(hello.nonceBase64, 'base64');
      const clientSig = Buffer.from(hello.sigBase64, 'base64');
      const clientPubKeyObj = crypto.createPublicKey({ key: clientIdPubDer, format: 'der', type: 'spki' });

      const clientTranscript = Buffer.concat([
        Buffer.from(hello.protocol, 'utf8'),
        clientEphPubDer,
        clientNonce
      ]);

      if (!crypto.verify(null, clientTranscript, clientPubKeyObj, clientSig)) {
        throw new Error('Client Ed25519 handshake signature invalid');
      }

      // Generate server ephemeral X25519 keypair
      const serverEph = crypto.generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      });
      const serverNonce = crypto.randomBytes(16);
      const serverTranscript = Buffer.concat([
        Buffer.from(hello.protocol, 'utf8'),
        serverEph.publicKey,
        serverNonce,
        clientNonce
      ]);
      const serverSig = crypto.sign(null, serverTranscript, this.privateKeyObj);

      await channel.writeJson({
        multistream: MULTISTREAM_ID,
        protocol: hello.protocol,
        peerId: this.peerId,
        role: this.role,
        idPubKeyDerBase64: this.publicKeyDer.toString('base64'),
        ephPubKeyDerBase64: serverEph.publicKey.toString('base64'),
        nonceBase64: serverNonce.toString('base64'),
        sigBase64: serverSig.toString('base64')
      });

      const serverEphPrivObj = crypto.createPrivateKey({
        key: serverEph.privateKey,
        format: 'der',
        type: 'pkcs8'
      });
      const clientEphPubObj = crypto.createPublicKey({
        key: clientEphPubDer,
        format: 'der',
        type: 'spki'
      });

      const sharedSecret = crypto.diffieHellman({
        privateKey: serverEphPrivObj,
        publicKey: clientEphPubObj
      });
      const keyMaterial = Buffer.from(
        crypto.hkdfSync(
          'sha256',
          sharedSecret,
          Buffer.concat([clientNonce, serverNonce]),
          Buffer.from('decentraupdate-session-v1', 'utf8'),
          64
        )
      );
      const clientToServerKey = keyMaterial.subarray(0, 32);
      const serverToClientKey = keyMaterial.subarray(32, 64);
      channel.enableEncryption(serverToClientKey, clientToServerKey, false);

      if (hello.protocol === PEERS_PROTOCOL_ID) {
        await this._servePeerExchange(channel, derivedClientPeerId);
      } else if (hello.protocol === PACKAGE_PROTOCOL_ID) {
        await this._servePackageSession(channel, family);
      }
    } catch {
      // Connection ended or protocol error
    } finally {
      channel.close();
    }
  }

  async _servePeerExchange(channel, remotePeerId) {
    const req = await channel.readJson(this.firstByteTimeoutMs);
    if (!req || req.op !== 'EXCHANGE_PEERS') return;

    if (req.seeding && Array.isArray(req.announceMultiaddrs)) {
      for (const ma of req.announceMultiaddrs.slice(0, 6)) {
        const parsed = parseMultiaddr(ma);
        if (parsed && (!parsed.peerId || parsed.peerId === remotePeerId)) {
          this.addKnownPeerMultiaddr(
            formatMultiaddr({ ...parsed, peerId: remotePeerId }),
            req.role === 'vps-seeder' ? 'vps-seeder' : 'user-peer'
          );
        }
      }
    }

    const peers = [];
    for (const p of this.knownPeers.values()) {
      if (p.peerId === remotePeerId) continue;
      peers.push({
        peerId: p.peerId,
        multiaddrs: Array.from(p.multiaddrs),
        role: p.role || 'user-peer'
      });
      if (peers.length >= 24) break;
    }

    await channel.writeJson({
      ok: true,
      peers
    });
  }

  async _servePackageSession(channel) {
    while (this.running && (this.seedingEnabled || this.role === 'vps-seeder')) {
      let req;
      try {
        req = await channel.readJson(this.idleTimeoutMs);
      } catch {
        break;
      }
      if (!req || typeof req !== 'object') break;

      if (req.op === 'DONE') {
        break;
      }

      if (req.op === 'HAVE_PACKAGE') {
        const pkg = this.verifiedCache?.getAuthorizedPackage({
          version: req.version,
          filename: req.filename,
          sha256: req.sha256
        });

        if (!pkg) {
          await channel.writeJson({
            ok: false,
            error: 'PACKAGE_NOT_AVAILABLE'
          });
        } else {
          await channel.writeJson({
            ok: true,
            role: this.role,
            peerId: this.peerId,
            version: pkg.version,
            filename: pkg.filename,
            size: pkg.size,
            sha256: pkg.sha256,
            chunkSize: pkg.chunkSize,
            totalChunks: pkg.chunkSha256.length
          });
        }
        continue;
      }

      if (req.op === 'GET_CHUNK') {
        try {
          const chunkData = await this.verifiedCache.readAuthorizedChunk({
            version: req.version,
            filename: req.filename,
            sha256: req.sha256,
            chunkIndex: req.chunkIndex
          });

          await this.rateLimiter.consume(chunkData.byteLength);

          await channel.writeJson({
            ok: true,
            chunkIndex: chunkData.chunkIndex,
            byteLength: chunkData.byteLength,
            chunkSha256: chunkData.chunkSha256
          });
          await channel.writeFrame(chunkData.buffer);
          this.stats.bytesUploaded += chunkData.byteLength;
        } catch (err) {
          await channel.writeJson({
            ok: false,
            error: err.message || 'CHUNK_READ_FAILED'
          });
          break;
        }
        continue;
      }

      break;
    }
  }

  /**
   * Connects to a single multiaddr and completes the authenticated encrypted handshake.
   */
  async _dialMultiaddr(multiaddrStr, protocolId, abortSignal = null) {
    const parsed = parseMultiaddr(multiaddrStr);
    if (!parsed) {
      throw new Error(`Invalid multiaddr: ${multiaddrStr}`);
    }
    if (abortSignal?.aborted) {
      throw new Error('P2P connection cancelled');
    }

    const socket = await new Promise((resolve, reject) => {
      const sock = net.connect({
        host: parsed.host,
        port: parsed.port,
        family: parsed.family === 'IPv6' ? 6 : 4
      });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Connect timeout (${this.connectTimeoutMs}ms) to ${parsed.family} ${redactIpAddress(parsed.host)}:${parsed.port}`));
      }, this.connectTimeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        sock.destroy();
        reject(new Error('P2P dial aborted'));
      };
      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      sock.once('connect', () => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });

    this.activeSockets.add(socket);
    socket.once('close', () => this.activeSockets.delete(socket));

    const channel = new FramedChannel(socket, this.idleTimeoutMs);
    try {
      const clientEph = crypto.generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      });
      const clientNonce = crypto.randomBytes(16);
      const clientTranscript = Buffer.concat([
        Buffer.from(protocolId, 'utf8'),
        clientEph.publicKey,
        clientNonce
      ]);
      const clientSig = crypto.sign(null, clientTranscript, this.privateKeyObj);

      await channel.writeJson({
        multistream: MULTISTREAM_ID,
        protocol: protocolId,
        peerId: this.peerId,
        idPubKeyDerBase64: this.publicKeyDer.toString('base64'),
        ephPubKeyDerBase64: clientEph.publicKey.toString('base64'),
        nonceBase64: clientNonce.toString('base64'),
        sigBase64: clientSig.toString('base64')
      });

      const ack = await channel.readJson(this.connectTimeoutMs);
      if (!ack || ack.multistream !== MULTISTREAM_ID || ack.protocol !== protocolId) {
        throw new Error('Invalid multistream HELLO_ACK from peer');
      }

      const serverIdPubDer = Buffer.from(ack.idPubKeyDerBase64, 'base64');
      const derivedServerPeerId = derivePeerIdFromSpkiDer(serverIdPubDer);
      if (derivedServerPeerId !== ack.peerId) {
        throw new Error('Remote PeerId does not match Ed25519 public key');
      }
      if (parsed.peerId && parsed.peerId !== derivedServerPeerId) {
        throw new Error(`PeerId mismatch: expected ${parsed.peerId}, got ${derivedServerPeerId}`);
      }

      const serverEphPubDer = Buffer.from(ack.ephPubKeyDerBase64, 'base64');
      const serverNonce = Buffer.from(ack.nonceBase64, 'base64');
      const serverSig = Buffer.from(ack.sigBase64, 'base64');
      const serverPubKeyObj = crypto.createPublicKey({ key: serverIdPubDer, format: 'der', type: 'spki' });

      const serverTranscript = Buffer.concat([
        Buffer.from(protocolId, 'utf8'),
        serverEphPubDer,
        serverNonce,
        clientNonce
      ]);

      if (!crypto.verify(null, serverTranscript, serverPubKeyObj, serverSig)) {
        throw new Error('Remote peer Ed25519 handshake signature verification failed');
      }

      const clientEphPrivObj = crypto.createPrivateKey({
        key: clientEph.privateKey,
        format: 'der',
        type: 'pkcs8'
      });
      const serverEphPubObj = crypto.createPublicKey({
        key: serverEphPubDer,
        format: 'der',
        type: 'spki'
      });

      const sharedSecret = crypto.diffieHellman({
        privateKey: clientEphPrivObj,
        publicKey: serverEphPubObj
      });
      const keyMaterial = Buffer.from(
        crypto.hkdfSync(
          'sha256',
          sharedSecret,
          Buffer.concat([clientNonce, serverNonce]),
          Buffer.from('decentraupdate-session-v1', 'utf8'),
          64
        )
      );
      const clientToServerKey = keyMaterial.subarray(0, 32);
      const serverToClientKey = keyMaterial.subarray(32, 64);
      channel.enableEncryption(clientToServerKey, serverToClientKey, true);

      return {
        channel,
        peerId: derivedServerPeerId,
        role: ack.role || 'user-peer',
        family: parsed.family,
        host: parsed.host,
        port: parsed.port,
        multiaddr: formatMultiaddr({ ...parsed, peerId: derivedServerPeerId })
      };
    } catch (err) {
      channel.close();
      throw err;
    }
  }

  /**
   * Happy Eyeballs Dual-Stack Dialer (IPv6-First, IPv4-Fallback):
   * Attempts IPv6 multiaddrs first; if IPv6 fails or does not connect within happyEyeballsDelayMs,
   * tries IPv4 multiaddrs without waiting for a long timeout.
   */
  async dialPeerHappyEyeballs(multiaddrs, protocolId, abortSignal = null) {
    const parsedList = multiaddrs.map(parseMultiaddr).filter(Boolean);
    const ipv6Addrs = parsedList.filter((m) => m.family === 'IPv6');
    const ipv4Addrs = parsedList.filter((m) => m.family === 'IPv4');

    const errors = [];

    if (ipv6Addrs.length > 0 && ipv4Addrs.length > 0) {
      // Staggered Happy Eyeballs: start IPv6 immediately, start IPv4 if IPv6 fails or exceeds delay
      let v6Settled = false;
      const v6Promise = (async () => {
        for (const addr of ipv6Addrs) {
          try {
            const conn = await this._dialMultiaddr(addr.raw, protocolId, abortSignal);
            v6Settled = true;
            return conn;
          } catch (e) {
            errors.push(e.message);
          }
        }
        v6Settled = true;
        throw new Error(errors.join('; ') || 'All IPv6 addresses failed');
      })();

      const v4Promise = (async () => {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.happyEyeballsDelayMs);
          v6Promise.catch(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (v6Settled) {
          // Wait a tick to check if v6 actually succeeded
          try {
            return await v6Promise;
          } catch {
            // v6 failed, proceed to IPv4 fallback
          }
        }
        for (const addr of ipv4Addrs) {
          try {
            return await this._dialMultiaddr(addr.raw, protocolId, abortSignal);
          } catch (e) {
            errors.push(e.message);
          }
        }
        throw new Error(errors.join('; ') || 'All IPv4 fallback addresses failed');
      })();

      try {
        const winner = await Promise.any([v6Promise, v4Promise]);
        // Close loser if the other promise resolves later
        v6Promise.then((c) => { if (c !== winner) c.channel.close(); }).catch(() => {});
        v4Promise.then((c) => { if (c !== winner) c.channel.close(); }).catch(() => {});
        return winner;
      } catch {
        throw new Error(`Happy Eyeballs dial failed (${ errors.join(' | ') })`);
      }
    }

    // Single family available (either IPv6-only or IPv4-only)
    const ordered = [...ipv6Addrs, ...ipv4Addrs];
    for (const addr of ordered) {
      try {
        return await this._dialMultiaddr(addr.raw, protocolId, abortSignal);
      } catch (e) {
        errors.push(e.message);
      }
    }
    throw new Error(`Failed to dial peer (${errors.join(' | ') || 'no valid multiaddrs'})`);
  }

  /**
   * Queries bootstrap/known peers via /decentraupdate/peers/1.0.0 to discover additional peers
   * and optionally announce our own seeding multiaddrs if seedingEnabled === true.
   */
  async discoverPeers({ version, sha256, abortSignal = null } = {}) {
    const candidates = Array.from(this.knownPeers.values());
    const myAnnounceAddrs = this.seedingEnabled ? this.getMultiaddrs({ includeLoopback: true }) : [];

    const queryOne = async (peerEntry) => {
      let conn;
      try {
        conn = await this.dialPeerHappyEyeballs(
          Array.from(peerEntry.multiaddrs),
          PEERS_PROTOCOL_ID,
          abortSignal
        );
        await conn.channel.writeJson({
          op: 'EXCHANGE_PEERS',
          version,
          sha256,
          seeding: this.seedingEnabled,
          role: this.role,
          announceMultiaddrs: myAnnounceAddrs
        });
        const resp = await conn.channel.readJson(this.discoveryTimeoutMs);
        if (resp && resp.ok && Array.isArray(resp.peers)) {
          for (const item of resp.peers) {
            if (item && Array.isArray(item.multiaddrs)) {
              for (const ma of item.multiaddrs) {
                this.addKnownPeerMultiaddr(ma, item.role || 'user-peer');
              }
            }
          }
        }
      } catch {
        // Discovery errors on individual peers are non-fatal
      } finally {
        conn?.channel.close();
      }
    };

    await Promise.race([
      Promise.allSettled(candidates.slice(0, 4).map(queryOne)),
      new Promise((r) => setTimeout(r, this.discoveryTimeoutMs))
    ]);

    // Order candidate peers: prefer user peers or VPS seeders with IPv6 addresses first
    const allPeers = Array.from(this.knownPeers.values()).filter((p) => p.peerId !== this.peerId);
    return allPeers;
  }

  /**
   * Downloads and verifies a release package across candidate peers using /decentraupdate/package/1.0.0.
   * Enforces per-chunk SHA-256, whole-file SHA-256, idle timeout, minimum speed floor, and maxPeerAttempts.
   */
  async downloadVerifiedPackage({
    version,
    assetMeta,
    onStateChange,
    onProgress,
    abortSignal = null
  }) {
    if (!this.verifiedCache) {
      throw new Error('P2PNode requires a VerifiedCache to download packages');
    }

    // Check if already verified in local cache
    const cached = await this.verifiedCache.getVerifiedPackageIfPresent(version, assetMeta);
    if (cached) {
      return {
        verifiedRecord: cached,
        sourceType: 'cache',
        peerRole: 'local-cache',
        family: 'local',
        bytesDownloaded: 0
      };
    }

    onStateChange?.('P2P_DISCOVERING', { message: 'Connecting to peers (P2P Alpha)' });
    const peerCandidates = await this.discoverPeers({
      version,
      sha256: assetMeta.sha256,
      abortSignal
    });

    if (peerCandidates.length === 0) {
      throw new Error('NO_PEERS_DISCOVERED');
    }

    const staging = await this.verifiedCache.openStagingSession(version, assetMeta);
    let attempts = 0;
    const failureReasons = [];
    const bootstrapSet = new Set(this.bootstrapMultiaddrs.map((m) => parseMultiaddr(m)?.peerId).filter(Boolean));

    for (const peerEntry of peerCandidates) {
      if (attempts >= this.maxPeerAttempts) {
        break;
      }
      if (abortSignal?.aborted) {
        throw new Error('P2P_CANCELLED');
      }

      attempts++;
      let conn = null;
      try {
        onStateChange?.('P2P_CONNECTING', {
          message: 'Connecting to peers (P2P Alpha)',
          attempt: attempts
        });

        conn = await this.dialPeerHappyEyeballs(
          Array.from(peerEntry.multiaddrs),
          PACKAGE_PROTOCOL_ID,
          abortSignal
        );

        await conn.channel.writeJson({
          op: 'HAVE_PACKAGE',
          appId: 'SA-CHAOS',
          channel: 'win',
          version: String(version),
          filename: assetMeta.filename,
          sha256: assetMeta.sha256
        });

        const haveResp = await conn.channel.readJson(this.firstByteTimeoutMs);
        if (!haveResp || !haveResp.ok) {
          throw new Error(haveResp?.error || 'PEER_DOES_NOT_HAVE_PACKAGE');
        }

        if (haveResp.size !== assetMeta.size || haveResp.totalChunks !== staging.totalChunks) {
          throw new Error('PEER_PACKAGE_METADATA_MISMATCH');
        }

        const isVpsSeeder =
          haveResp.role === 'vps-seeder' ||
          conn.role === 'vps-seeder' ||
          bootstrapSet.has(conn.peerId);

        const sourceLabel = isVpsSeeder
          ? 'Downloading from VPS seeder (P2P)'
          : 'Downloading from another user (P2P)';
        const sourceCategory = isVpsSeeder ? 'P2P — VPS Seeder' : 'P2P — Pengguna lain';

        onStateChange?.('P2P_DOWNLOADING', {
          message: sourceLabel,
          sourceCategory,
          peerRole: isVpsSeeder ? 'vps-seeder' : 'user-peer',
          family: conn.family
        });

        const missingChunks = staging.getMissingChunkIndices();
        const transferStartMs = Date.now();
        let sessionBytes = 0;

        for (const chunkIndex of missingChunks) {
          if (abortSignal?.aborted) {
            throw new Error('P2P_CANCELLED');
          }

          await conn.channel.writeJson({
            op: 'GET_CHUNK',
            version: String(version),
            filename: assetMeta.filename,
            sha256: assetMeta.sha256,
            chunkIndex,
            maxBytes: assetMeta.chunkSize
          });

          const chunkMeta = await conn.channel.readJson(
            sessionBytes === 0 ? this.firstByteTimeoutMs : this.idleTimeoutMs
          );
          if (!chunkMeta || !chunkMeta.ok) {
            throw new Error(chunkMeta?.error || `CHUNK_${chunkIndex}_ERROR`);
          }

          const chunkBytes = await conn.channel.readFrame(this.idleTimeoutMs);
          try {
            await staging.writeVerifiedChunk(chunkIndex, chunkBytes);
            this.stats.chunksVerified++;
          } catch (verifyErr) {
            this.stats.chunkVerificationFailures++;
            throw verifyErr;
          }

          sessionBytes += chunkBytes.length;
          if (isVpsSeeder) {
            this.stats.bytesDownloadedFromVps += chunkBytes.length;
          } else {
            this.stats.bytesDownloadedFromPeers += chunkBytes.length;
          }
          if (conn.family === 'IPv6') {
            this.stats.ipv6BytesDownloaded += chunkBytes.length;
          } else {
            this.stats.ipv4BytesDownloaded += chunkBytes.length;
          }

          const elapsedSec = Math.max(0.001, (Date.now() - transferStartMs) / 1000);
          const speedBps = Math.round(sessionBytes / elapsedSec);

          // Enforce minimum speed check after 5 seconds of transfer
          if (elapsedSec >= 5 && speedBps < this.minSpeedBytesPerSec) {
            throw new Error(`P2P_TOO_SLOW (${speedBps} B/s < ${this.minSpeedBytesPerSec} B/s)`);
          }

          const completedBytes = staging.getCompletedByteCount();
          const percent = Math.min(99, Math.round((completedBytes / assetMeta.size) * 100));
          onProgress?.({
            percent,
            transferredBytes: completedBytes,
            totalBytes: assetMeta.size,
            speedBps,
            sourceLabel,
            sourceCategory,
            peerRole: isVpsSeeder ? 'vps-seeder' : 'user-peer',
            family: conn.family
          });
        }

        await conn.channel.writeJson({ op: 'DONE' }).catch(() => {});
        conn.channel.close();

        onStateChange?.('VERIFYING', {
          message: 'Verifying update package',
          sourceCategory
        });

        const verifiedRecord = await staging.finalizeAndCommit();
        const transferRecord = {
          version: String(version),
          filename: assetMeta.filename,
          bytesDownloaded: sessionBytes,
          peerId: conn.peerId,
          redactedHost: redactIpAddress(conn.host),
          family: conn.family,
          peerRole: isVpsSeeder ? 'vps-seeder' : 'user-peer',
          sourceCategory,
          completedAt: new Date().toISOString()
        };
        this.stats.transferHistory.push(transferRecord);

        return {
          verifiedRecord,
          sourceType: isVpsSeeder ? 'vps-seeder' : 'user-peer',
          sourceCategory,
          peerRole: isVpsSeeder ? 'vps-seeder' : 'user-peer',
          peerId: conn.peerId,
          family: conn.family,
          redactedHost: redactIpAddress(conn.host),
          bytesDownloaded: sessionBytes
        };
      } catch (err) {
        conn?.channel.close();
        failureReasons.push(err.message);
        if (err.message === 'P2P_CANCELLED' || abortSignal?.aborted) {
          throw new Error('P2P_CANCELLED');
        }
      }
    }

    throw new Error(`P2P_EXHAUSTED: ${failureReasons.join('; ') || 'No peer succeeded'}`);
  }
}
