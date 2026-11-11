import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testStoragePath = path.join(__dirname, "test-auth-session.json");

import {
  TIKTOK_PROVIDERS,
  DEFAULT_PROVIDER,
  ROOM_STATUS,
  CONNECTION_STATUS,
  ERROR_CODES,
  TIKTOK_AUTH_STATE,
  TikTokConnectorError,
} from "../main/server/tiktok-constants.js";

import {
  SignerTokenManager,
  decodeJwtClaims,
} from "../main/server/signer-token-manager.js";

import {
  TikTokAuthSessionManager,
  REQUIRED_COOKIES,
} from "../main/server/tiktok-auth-session.js";

import { TikTokLiveMonitor } from "../main/server/tiktok-live-monitor.js";
import { GeneralConfig } from "../main/server/shared.js";
import {
  CustomTikTokConnector,
  createCustomSignerApiClient,
} from "../main/server/custom-tiktok-connector.js";
import { TikTokProviderManager } from "../main/server/tiktok-provider-manager.js";

// Helper to create mock JWT string with arbitrary payload
function createMockJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "mock-sig";
  return `${header}.${body}.${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite A: IndoFinity Regression & Default Provider Invariant
// ─────────────────────────────────────────────────────────────────────────────
test("A. IndoFinity Regression: default provider is indofinity and backward compatible", async (t) => {
  if (GeneralConfig?.Tiktok) GeneralConfig.Tiktok.Provider = "indofinity";
  if (GeneralConfig?.General) GeneralConfig.General.TiktokProvider = "indofinity";

  assert.equal(DEFAULT_PROVIDER, "indofinity", "Default provider must be indofinity");

  const manager = new TikTokProviderManager();
  await manager.initialize();

  assert.equal(manager.getProvider(), "indofinity", "Default initialized provider must be indofinity");

  const status = manager.getStatus();
  assert.equal(status.selectedProvider, "indofinity");
  assert.equal(status.channel, "Stable");
  assert.equal(status.isCustomBeta, false);

  // In IndoFinity mode, signer token manager must NOT have cached JWT or active refresh timers
  assert.equal(manager.signerTokenManager.cachedJwt, null);
  assert.equal(manager.signerTokenManager._refreshTimer, null);

  manager.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite B: JWT Token Manager (Issuance, Caching, Expiry & Backoff)
// ─────────────────────────────────────────────────────────────────────────────
test("B. JWT Token Manager: token acquisition, deduplication, caching, and rejection", async (t) => {
  let fetchCount = 0;
  const mockJwt = createMockJwt({
    sub: "streamer_alpha",
    owner: "streamer_alpha",
    scope: ["sign:live"],
    exp: Math.floor(Date.now() / 1000) + 300,
  });

  const mockFetch = async (url, opts) => {
    fetchCount++;
    const auth = opts.headers["Authorization"];
    if (auth === "Bearer valid-license-123") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          access_token: mockJwt,
          token_type: "Bearer",
          expires_in: 300,
        }),
      };
    } else if (auth === "Bearer invalid-license") {
      return {
        ok: false,
        status: 401,
        text: async () => "Invalid license key",
      };
    } else {
      return {
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      };
    }
  };

  // 1. Successful JWT issuance with caching
  const tokenManager = new SignerTokenManager({
    licenseToken: "valid-license-123",
    fetchFn: mockFetch,
  });

  const jwt1 = await tokenManager.getValidToken();
  assert.equal(jwt1, mockJwt);
  assert.equal(fetchCount, 1);

  // 2. Cached token reuse (no second network request)
  const jwt2 = await tokenManager.getValidToken();
  assert.equal(jwt2, mockJwt);
  assert.equal(fetchCount, 1, "Cached token should not trigger another fetch");

  // 3. Concurrent refresh deduplication
  tokenManager.invalidate();
  const [resA, resB] = await Promise.all([
    tokenManager.getValidToken(),
    tokenManager.getValidToken(),
  ]);
  assert.equal(resA, mockJwt);
  assert.equal(resB, mockJwt);
  assert.equal(fetchCount, 2, "Concurrent requests must be deduplicated into a single network call");

  // 4. Definitive rejection on invalid license (HTTP 401)
  const badTokenManager = new SignerTokenManager({
    licenseToken: "invalid-license",
    fetchFn: mockFetch,
  });

  await assert.rejects(
    async () => badTokenManager.getValidToken(),
    (err) => err.code === ERROR_CODES.LICENSE_INVALID
  );
  assert.equal(badTokenManager._refreshTimer, null, "Definitive rejection must not schedule retry timer");

  tokenManager.dispose();
  badTokenManager.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite C: TikTok Session Auth & Cookie Validation & Disk Persistence
// ─────────────────────────────────────────────────────────────────────────────
test("C. TikTok Auth Session: cookie completeness check and identity verification", async (t) => {
  const auth = new TikTokAuthSessionManager({ storagePath: testStoragePath });

  assert.equal(auth.isAuthenticated(), false);
  assert.equal(auth.getConnectedAs(), null);

  // Partial cookies should not count as authenticated
  auth.setSessionFromCookies({
    sessionid: "test-session-id",
    ttwid: "test-ttwid",
  });
  assert.equal(auth.isAuthenticated(), false, "Missing cookies must keep state unauthenticated");

  // Full required cookies set
  auth.setSessionFromCookies(
    {
      sessionid: "sess_12345",
      sessionid_ss: "sess_12345",
      sid_tt: "sid_999",
      ttwid: "ttwid_abc",
      "tt-target-idc": "maliva",
    },
    "@account_streamer_b"
  );

  assert.equal(auth.isAuthenticated(), true);
  assert.equal(auth.getConnectedAs(), "@account_streamer_b");

  // Verify Rust QuickJS signing header format
  const signerHeader = auth.getSignerCookieHeader();
  assert.ok(signerHeader.includes("sessionid=sess_12345"));
  assert.ok(signerHeader.includes("ttwid=ttwid_abc"));
  assert.ok(signerHeader.includes("sid_tt=sid_999"));

  // Verify connector session bundle format
  const bundle = auth.getConnectorSessionBundle();
  assert.deepEqual(bundle, {
    type: "cookie",
    value: {
      sessionId: "sess_12345",
      ttTargetIdc: "maliva",
    },
  });

  // Verify disk persistence across restarts: instantiate a new manager with the same storagePath
  const restartedAuth = new TikTokAuthSessionManager({ storagePath: testStoragePath });
  assert.equal(restartedAuth.isAuthenticated(), true, "Saved session must be automatically restored on app restart");
  assert.equal(restartedAuth.getConnectedAs(), "@account_streamer_b");
  assert.equal(restartedAuth.getCookies()["sessionid"], "sess_12345");

  // Verify that the file on disk is ENCRYPTED with AES-256 (not plaintext JSON)
  const rawDiskContent = fs.readFileSync(testStoragePath, "utf8");
  assert.throws(
    () => JSON.parse(rawDiskContent),
    "Disk file must be encrypted AES-256 ciphertext and NOT valid plaintext JSON"
  );
  assert.ok(
    !rawDiskContent.includes("sess_12345"),
    "Sensitive cookies must not appear in plaintext in the file"
  );

  // Verify clearing session removes storage file and clears memory
  await restartedAuth.clearSession();
  assert.equal(restartedAuth.isAuthenticated(), false);
  assert.equal(restartedAuth.getConnectedAs(), null);
  assert.equal(restartedAuth.getSignerCookieHeader(), "");
  assert.equal(fs.existsSync(testStoragePath), false, "Storage file must be removed on clearSession()");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite D: LIVE / OFFLINE Detection & Monitoring Invariant
// ─────────────────────────────────────────────────────────────────────────────
test("D. LIVE / OFFLINE Detection: preflight check, distinguishing network errors from offline", async (t) => {
  let mockLiveStatus = true;
  let shouldThrowNetworkError = false;

  const mockFactory = (username, opts) => {
    return {
      fetchIsLive: async () => {
        if (shouldThrowNetworkError) {
          throw new Error("ETIMEDOUT: Connection timed out to TikTok gateway");
        }
        return mockLiveStatus;
      },
      fetchRoomId: async () => "7435123456789012345",
      disconnect: () => {},
    };
  };

  const monitor = new TikTokLiveMonitor({
    targetUsername: "streamer_alpha",
    connectionFactory: mockFactory,
    pollIntervalSeconds: 0.05,
    jitterMaxSeconds: 0.01,
  });

  // 1. Streamer LIVE -> status LIVE
  const resLive = await monitor.checkLiveStatus();
  assert.equal(resLive.isLive, true);
  assert.equal(resLive.status, ROOM_STATUS.LIVE);
  assert.equal(monitor.roomStatus, ROOM_STATUS.LIVE);

  // 2. Streamer OFFLINE -> status OFFLINE
  mockLiveStatus = false;
  const resOffline = await monitor.checkLiveStatus();
  assert.equal(resOffline.isLive, false);
  assert.equal(resOffline.status, ROOM_STATUS.OFFLINE);
  assert.equal(monitor.roomStatus, ROOM_STATUS.OFFLINE);

  // 3. Network error -> status UNKNOWN (NEVER declare OFFLINE on network error!)
  shouldThrowNetworkError = true;
  const resError = await monitor.checkLiveStatus();
  assert.equal(resError.status, ROOM_STATUS.UNKNOWN, "Network error must report UNKNOWN, not OFFLINE");
  assert.equal(monitor.roomStatus, ROOM_STATUS.UNKNOWN);

  // 4. Offline monitoring detects transition to LIVE
  shouldThrowNetworkError = false;
  mockLiveStatus = false;
  await monitor.checkLiveStatus();

  let liveTriggered = false;
  monitor.onLiveStarted = ({ roomId, username }) => {
    liveTriggered = true;
    assert.equal(username, "streamer_alpha");
  };

  monitor.startMonitoring(null, 10);
  assert.equal(monitor._isPolling, false);

  // Switch to LIVE
  mockLiveStatus = true;

  // Wait for monitor poll cycle
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(liveTriggered, true, "Monitor must trigger onLiveStarted when streamer starts broadcasting");

  monitor.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite E: Provider Switching & Isolation Safety
// ─────────────────────────────────────────────────────────────────────────────
test("E. Provider Switching: IndoFinity <-> Custom Beta with safe resource cleanup", async (t) => {
  const auth = new TikTokAuthSessionManager({ storagePath: testStoragePath });
  auth.setSessionFromCookies(
    {
      sessionid: "sess_beta",
      sessionid_ss: "sess_beta",
      sid_tt: "sid_beta",
      ttwid: "ttwid_beta",
      "tt-target-idc": "maliva",
    },
    "@account_beta"
  );

  let mockWsOpen = false;
  const mockFactory = (username, opts) => {
    const emitter = new EventEmitter();
    emitter.connect = async () => {
      mockWsOpen = true;
      return { roomId: "7123456789", roomInfo: { owner: { display_id: username } } };
    };
    emitter.disconnect = () => {
      mockWsOpen = false;
    };
    return emitter;
  };

  const manager = new TikTokProviderManager({
    authSessionManager: auth,
  });

  manager.customConnector.connectionFactory = mockFactory;
  manager.liveMonitor.connectionFactory = (user, opts) => ({
    fetchIsLive: async () => true,
    fetchRoomId: async () => "7123456789",
    disconnect: () => {},
  });

  // Start in default IndoFinity
  assert.equal(manager.getProvider(), TIKTOK_PROVIDERS.INDOFINITY);

  // Switch IndoFinity -> Custom Beta
  global.tokenOwner = "streamer_licensed";
  await manager.setProvider(TIKTOK_PROVIDERS.CUSTOM_BETA, { saveConfig: false });

  assert.equal(manager.getProvider(), TIKTOK_PROVIDERS.CUSTOM_BETA);
  const statusBeta = manager.getStatus();
  assert.equal(statusBeta.selectedProvider, TIKTOK_PROVIDERS.CUSTOM_BETA);
  assert.equal(statusBeta.isCustomBeta, true);
  assert.equal(statusBeta.licenseOwner, "@streamer_licensed");
  assert.equal(statusBeta.connectedAs, "@account_beta");
  assert.equal(statusBeta.watchingLive, "@streamer_licensed");

  // Switch Custom Beta -> IndoFinity
  await manager.setProvider(TIKTOK_PROVIDERS.INDOFINITY, { saveConfig: false });
  assert.equal(manager.getProvider(), TIKTOK_PROVIDERS.INDOFINITY);

  // Ensure Custom Beta resources are cleaned up
  assert.equal(manager.customConnector.isConnected(), false);
  assert.equal(manager.liveMonitor._pollTimer, null);

  manager.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite F: Event Compatibility & No Duplicate Delivery
// ─────────────────────────────────────────────────────────────────────────────
test("F. Event Compatibility: chat and gift normalization without duplication", async (t) => {
  const dispatchedEvents = [];
  const mockHandler = {
    onMessage: (data) => dispatchedEvents.push({ type: "chat", text: data.comment }),
    onGift: (data) => dispatchedEvents.push({ type: "gift", giftId: data.giftId, count: data.count }),
  };

  const auth = new TikTokAuthSessionManager({ storagePath: testStoragePath });
  auth.setSessionFromCookies(
    {
      sessionid: "sess_ok",
      ttwid: "ttwid_ok",
      "tt-target-idc": "maliva",
      sid_tt: "sid_ok",
      sessionid_ss: "sess_ok",
    },
    "@user_tester"
  );

  let capturedEmitter = null;
  const mockFactory = (username, opts) => {
    const emitter = new EventEmitter();
    capturedEmitter = emitter;
    emitter.connect = async () => ({ roomId: "888888" });
    emitter.disconnect = () => {};
    return emitter;
  };

  const manager = new TikTokProviderManager({
    authSessionManager: auth,
    handler: mockHandler,
  });

  manager.customConnector.connectionFactory = mockFactory;
  manager.liveMonitor.connectionFactory = () => ({
    fetchIsLive: async () => true,
    fetchRoomId: async () => "888888",
    disconnect: () => {},
  });

  global.tokenOwner = "licensed_creator";
  await manager.setProvider(TIKTOK_PROVIDERS.CUSTOM_BETA, { saveConfig: false });

  assert.ok(capturedEmitter !== null, "Connection instance must be created");

  // Simulate chat and gift events
  capturedEmitter.emit("chat", { comment: "Hello Chaos Mod!" });
  capturedEmitter.emit("gift", { giftId: 5655, count: 1 });
  capturedEmitter.emit("gift", { giftId: 5655, count: 5 });

  assert.equal(dispatchedEvents.length, 3);
  assert.deepEqual(dispatchedEvents[0], { type: "chat", text: "Hello Chaos Mod!" });
  assert.deepEqual(dispatchedEvents[1], { type: "gift", giftId: 5655, count: 1 });
  assert.deepEqual(dispatchedEvents[2], { type: "gift", giftId: 5655, count: 5 });

  // Switch back to IndoFinity: events from disconnected emitter must be ignored
  await manager.setProvider(TIKTOK_PROVIDERS.INDOFINITY, { saveConfig: false });
  capturedEmitter.emit("chat", { comment: "Stale event after disconnect" });

  assert.equal(dispatchedEvents.length, 3, "Stale events after provider switch must not be dispatched");

  manager.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite G: License Owner Deduplication & Periodic Poll Protection
// ─────────────────────────────────────────────────────────────────────────────
test("G. License Owner deduplication: repeated updateLicenseOwner calls do not re-connect or re-activate when already connected", async (t) => {
  const auth = new TikTokAuthSessionManager({ storagePath: testStoragePath });
  auth.setSessionFromCookies({
    sessionid: "sess_123",
    "tt-target-idc": "alisg",
    sessionid_ss: "sess_ss_123",
    sid_tt: "sid_123",
    ttwid: "ttwid_123",
  }, "@connected_user");

  let connectionAttempts = 0;
  const mockFactory = (username, opts) => {
    connectionAttempts++;
    const emitter = new EventEmitter();
    emitter.connect = async () => ({ roomId: "999999" });
    emitter.disconnect = () => {};
    return emitter;
  };

  const manager = new TikTokProviderManager({
    authSessionManager: auth,
  });

  manager.customConnector.connectionFactory = mockFactory;
  manager.liveMonitor.connectionFactory = () => ({
    fetchIsLive: async () => true,
    fetchRoomId: async () => "999999",
    disconnect: () => {},
  });

  global.tokenOwner = "streamer_unique";
  await manager.setProvider(TIKTOK_PROVIDERS.CUSTOM_BETA, { saveConfig: false });

  assert.equal(connectionAttempts, 1, "Should connect once upon provider activation");
  assert.equal(manager.customConnector.isConnected(), true, "Should be connected");

  // Simulate periodic CLEO /credentials poll with same owner
  manager.updateLicenseOwner("streamer_unique");
  manager.updateLicenseOwner("@streamer_unique");
  manager.updateLicenseOwner("streamer_unique");

  assert.equal(connectionAttempts, 1, "Repeated polls with same owner must NOT trigger re-connection");

  manager.dispose();
  try {
    if (fs.existsSync(testStoragePath)) fs.unlinkSync(testStoragePath);
  } catch {}
});
