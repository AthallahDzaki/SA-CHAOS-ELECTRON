import {
  TikTokLiveConnection,
  SignConfig,
  WebSocketConfigDefaults,
} from "tiktok-live-connector";
import EulerStreamApiClient, { Configuration } from "tiktok-live-api-sdk";
import {
  CONNECTION_STATUS,
  ERROR_CODES,
  ROOM_STATUS,
  SIGNING_SERVERS,
  DEFAULT_SIGNING_SERVER,
  TikTokConnectorError,
} from "./tiktok-constants.js";

export { SIGNING_SERVERS, DEFAULT_SIGNING_SERVER };

const SIGNER_BASE_URL = SIGNING_SERVERS.los_santos.url;

// Initialize WebSocket configuration parameters per SA-CHAOS Signer requirements
if (WebSocketConfigDefaults) {
  WebSocketConfigDefaults.DEFAULT_WS_CLIENT_PARAMS = {};
  WebSocketConfigDefaults.DEFAULT_WS_CLIENT_PARAMS_APPEND_PARAMETER = "";
}

/**
 * Creates an isolated EulerStreamApiClient configured to route signing requests
 * to the SA-CHAOS Rust QuickJS Signing Server with dynamic per-request JWT authentication.
 */
export function createCustomSignerApiClient({ signerTokenManager, authSessionManager, signerBaseUrl = SIGNER_BASE_URL }) {
  const host = new URL(signerBaseUrl).host;
  // Satisfies tiktok-live-connector whitelist check for authenticated sessions
  process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = host;

  SignConfig.apiKey = undefined;
  SignConfig.basePath = signerBaseUrl;

  const config = new Configuration({
    basePath: signerBaseUrl,
  });

  const apiClient = new EulerStreamApiClient(config);

  // Install request interceptor on the shared axios instance for dynamic JWT and cookie headers
  apiClient.rooms.axios.interceptors.request.use(async (axiosConfig) => {
    try {
      const jwt = await signerTokenManager.getValidToken();
      axiosConfig.headers = axiosConfig.headers || {};
      axiosConfig.headers["Authorization"] = `Bearer ${jwt}`;

      const cookieHeader = authSessionManager ? authSessionManager.getSignerCookieHeader() : "";
      if (cookieHeader) {
        axiosConfig.headers["X-TTL-Client-Cookie"] = cookieHeader;
      }

      // Keep SignConfig baseOptions synchronized dynamically
      SignConfig.baseOptions = {
        ...(SignConfig.baseOptions ?? {}),
        headers: {
          ...(SignConfig.baseOptions?.headers ?? {}),
          Authorization: `Bearer ${jwt}`,
          "X-TTL-Client-Cookie": cookieHeader,
        },
      };
    } catch (err) {
      console.error("[CustomTikTokConnector] Failed to attach dynamic signing credentials:", err.message);
      throw err;
    }
    return axiosConfig;
  });

  return apiClient;
}

/**
 * Manages the direct WebSocket connection to TikTok LIVE using the SA-CHAOS Custom Signing Gateway.
 * - Always targets the fixed License Owner.
 * - Injects per-request dynamic JWT and authenticated TikTok session cookies.
 * - Guards against race conditions and duplicate reconnects via generation IDs.
 * - Normalizes and forwards LIVE events (chat, gift, donations) into the existing SA-CHAOS pipeline.
 */
export class CustomTikTokConnector {
  constructor(options = {}) {
    this.targetUsername = (options.targetUsername || "").replace(/^@+/, "").trim();
    this.signerTokenManager = options.signerTokenManager;
    this.authSessionManager = options.authSessionManager;

    this.signerServer = options.signerServer || DEFAULT_SIGNING_SERVER;
    const resolvedServer = SIGNING_SERVERS[this.signerServer] || SIGNING_SERVERS.los_santos;
    this.signerBaseUrl = options.signerBaseUrl || resolvedServer.url;
    this.signerServerName = resolvedServer.name;

    this.connectionFactory = options.connectionFactory || null;

    this.connectionStatus = CONNECTION_STATUS.DISCONNECTED;
    this.activeConnection = null;
    this.roomId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;

    this._generationId = 0;
    this._reconnectTimer = null;
    this._isConnecting = false;
    this._disposed = false;

    // Event hooks
    this.onStatusChanged = options.onStatusChanged || null;
    this.onEvent = options.onEvent || null; // { type: "chat" | "gift" | ..., data }
    this.onStreamEnd = options.onStreamEnd || null;
    this.onError = options.onError || null;
  }

  setTargetUsername(username) {
    const clean = (username || "").replace(/^@+/, "").trim();
    if (this.targetUsername !== clean) {
      this.targetUsername = clean;
      if (this.isConnected()) {
        this.disconnect();
      }
    }
  }

  setSignerServer(serverId) {
    if (SIGNING_SERVERS[serverId]) {
      this.signerServer = serverId;
      this.signerBaseUrl = SIGNING_SERVERS[serverId].url;
      this.signerServerName = SIGNING_SERVERS[serverId].name;
    }
  }

  isConnected() {
    return this.connectionStatus === CONNECTION_STATUS.CONNECTED && this.activeConnection !== null;
  }

  _setStatus(status, extra = {}) {
    this.connectionStatus = status;
    if (typeof this.onStatusChanged === "function") {
      try {
        this.onStatusChanged(status, {
          targetUsername: this.targetUsername,
          roomId: this.roomId,
          reconnectAttempts: this.reconnectAttempts,
          ...extra,
        });
      } catch {}
    }
  }

  /**
   * Connects to the TikTok LIVE room for the fixed License Owner.
   */
  async connect() {
    if (this._disposed) {
      throw new TikTokConnectorError(ERROR_CODES.TIKTOK_RECONNECT_FAILED, "Connector is disposed.");
    }

    if (this._isConnecting || this.isConnected()) {
      return;
    }

    if (!this.targetUsername) {
      const err = new TikTokConnectorError(
        ERROR_CODES.LICENSE_OWNER_MISMATCH,
        "Target streamer (License Owner) belum ditentukan."
      );
      this._setStatus(CONNECTION_STATUS.ERROR, { error: err.message });
      throw err;
    }

    if (!this.authSessionManager || !this.authSessionManager.isAuthenticated()) {
      const err = new TikTokConnectorError(
        ERROR_CODES.TIKTOK_COOKIES_INCOMPLETE,
        "Sesi TikTok belum terautentikasi. Silakan login terlebih dahulu melalui jendela login TikTok."
      );
      this._setStatus(CONNECTION_STATUS.ERROR, { error: err.message });
      throw err;
    }

    const generation = ++this._generationId;
    this._isConnecting = true;
    this._setStatus(CONNECTION_STATUS.CONNECTING);

    this._teardownActiveConnection();

    try {
      // 1. Prepare custom signer API client with dynamic JWT interceptor
      const eulerApiInstance = createCustomSignerApiClient({
        signerTokenManager: this.signerTokenManager,
        authSessionManager: this.authSessionManager,
        signerBaseUrl: this.signerBaseUrl,
      });

      // 2. Prepare TikTokLiveConnection options
      const sessionBundle = this.authSessionManager.getConnectorSessionBundle();
      const options = {
        useMobile: false,
        processInitialData: false,
        fetchRoomInfoOnConnect: false,
        enableExtendedGiftInfo: false,
        authenticateWs: true,
        eulerApiInstance,
        session: {
          cookie: sessionBundle,
        },
      };

      const conn = this.connectionFactory
        ? this.connectionFactory(this.targetUsername, options)
        : new TikTokLiveConnection(this.targetUsername, options);

      this.activeConnection = conn;

      // 3. Inject full cookie set into webClient cookieJar (sessionid, tt-target-idc, sessionid_ss, sid_tt, ttwid)
      if (conn.webClient && conn.webClient.cookieJar && this.authSessionManager?.cookies) {
        const jar = conn.webClient.cookieJar;
        jar.store = jar.store || {};

        const sessionId = this.authSessionManager.cookies.sessionid;
        const ttTargetIdc = this.authSessionManager.cookies["tt-target-idc"] || this.authSessionManager.cookies.ttTargetIdc;

        if (sessionId) jar.store["sessionid"] = sessionId;
        if (ttTargetIdc) jar.store["tt-target-idc"] = ttTargetIdc;

        const allCookies = {
          sessionid: sessionId,
          "tt-target-idc": ttTargetIdc,
          sessionid_ss: this.authSessionManager.cookies.sessionid_ss,
          sid_tt: this.authSessionManager.cookies.sid_tt,
          ttwid: this.authSessionManager.cookies.ttwid,
        };

        for (const [name, value] of Object.entries(allCookies)) {
          if (value && !/[;\r\n]/.test(value)) {
            try {
              jar.store[name] = value;
              await jar.setCookie(
                `${name}=${value}; Domain=.tiktok.com; Path=/; Secure`,
                "https://www.tiktok.com"
              );
            } catch {}
          }
        }
      }

      this._wireConnectionEvents(conn, generation);

      console.info(`[CustomTikTokConnector] Menghubungkan ke LIVE @${this.targetUsername} via ${this.signerServerName}...`);
      const state = await conn.connect();

      if (generation !== this._generationId || this._disposed) {
        try { conn.disconnect(); } catch {}
        return;
      }

      this.roomId = state?.roomId ? String(state.roomId) : null;
      this.reconnectAttempts = 0;
      this._isConnecting = false;
      this._setStatus(CONNECTION_STATUS.CONNECTED, {
        roomId: this.roomId,
        roomInfo: state?.roomInfo || null,
      });

      console.info(`[CustomTikTokConnector] Berhasil terhubung ke LIVE @${this.targetUsername} (Room ID: ${this.roomId})`);
    } catch (err) {
      if (generation !== this._generationId || this._disposed) return;
      this._isConnecting = false;

      console.error(`[CustomTikTokConnector] Gagal terhubung ke LIVE @${this.targetUsername}:`, err.message || err);
      this._handleConnectionFailure(err, generation);
    }
  }

  _wireConnectionEvents(conn, generation) {
    conn.on("chat", (data) => {
      if (generation !== this._generationId || this._disposed) return;
      this._dispatch("chat", data);
    });

    conn.on("gift", (data) => {
      if (generation !== this._generationId || this._disposed) return;
      this._dispatch("gift", data);
    });

    conn.on("like", (data) => {
      if (generation !== this._generationId || this._disposed) return;
      this._dispatch("like", data);
    });

    conn.on("roomUser", (data) => {
      if (generation !== this._generationId || this._disposed) return;
      this._dispatch("roomUser", data);
    });

    conn.on("streamEnd", () => {
      if (generation !== this._generationId || this._disposed) return;
      console.info(`[CustomTikTokConnector] Stream @${this.targetUsername} telah berakhir.`);
      this._setStatus(CONNECTION_STATUS.WAITING_FOR_LIVE);
      if (typeof this.onStreamEnd === "function") {
        try { this.onStreamEnd(); } catch {}
      }
    });

    conn.on("disconnected", () => {
      if (generation !== this._generationId || this._disposed) return;
      console.warn(`[CustomTikTokConnector] Terputus dari WebSocket TikTok LIVE @${this.targetUsername}.`);
      this._handleDisconnect(generation);
    });

    conn.on("error", (err) => {
      if (generation !== this._generationId || this._disposed) return;
      console.error(`[CustomTikTokConnector] WebSocket Error:`, err?.message || err);
      if (typeof this.onError === "function") {
        try { this.onError(err); } catch {}
      }
    });
  }

  _dispatch(type, data) {
    if (typeof this.onEvent === "function") {
      try {
        this.onEvent({ type, data, timestamp: Date.now() });
      } catch (err) {
        console.error(`[CustomTikTokConnector] Event dispatch error for ${type}:`, err);
      }
    }
  }

  _handleDisconnect(generation) {
    if (generation !== this._generationId || this._disposed) return;
    this._teardownActiveConnection();

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this._setStatus(CONNECTION_STATUS.RECONNECTING, {
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
      });

      const delayMs = Math.min(30000, 3000 * Math.pow(1.5, this.reconnectAttempts - 1));
      console.log(`[CustomTikTokConnector] Menjadwalkan reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) dalam ${delayMs / 1000}s...`);

      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect().catch(() => {});
      }, delayMs);
    } else {
      console.warn(`[CustomTikTokConnector] Batas percobaan reconnect tercapai.`);
      this._setStatus(CONNECTION_STATUS.DISCONNECTED);
    }
  }

  _handleConnectionFailure(err, generation) {
    if (generation !== this._generationId || this._disposed) return;
    this._teardownActiveConnection();

    // Check if error is signing unauthorized (401)
    if (err.message && (err.message.includes("401") || err.message.includes("Unauthorized"))) {
      console.warn("[CustomTikTokConnector] Token signing tidak valid, menginvalidasi JWT...");
      if (this.signerTokenManager) {
        this.signerTokenManager.invalidate();
      }
    }

    this._setStatus(CONNECTION_STATUS.ERROR, {
      error: err?.message || String(err),
    });
  }

  _teardownActiveConnection() {
    if (this.activeConnection) {
      try {
        this.activeConnection.removeAllListeners();
        this.activeConnection.disconnect();
      } catch {}
      this.activeConnection = null;
    }
  }

  /**
   * Safely disconnects the active WebSocket and cancels any pending reconnects.
   */
  disconnect() {
    this._generationId++;
    this._isConnecting = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._teardownActiveConnection();
    this.reconnectAttempts = 0;
    this._setStatus(CONNECTION_STATUS.DISCONNECTED);
  }

  /**
   * Shuts down connector permanently.
   */
  dispose() {
    this._disposed = true;
    this.disconnect();
  }
}
