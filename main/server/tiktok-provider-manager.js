import {
  TIKTOK_PROVIDERS,
  DEFAULT_PROVIDER,
  SIGNING_SERVERS,
  DEFAULT_SIGNING_SERVER,
  ROOM_STATUS,
  CONNECTION_STATUS,
  ERROR_CODES,
  TikTokConnectorError,
} from "./tiktok-constants.js";

export {
  TIKTOK_PROVIDERS,
  DEFAULT_PROVIDER,
  SIGNING_SERVERS,
  DEFAULT_SIGNING_SERVER,
  ROOM_STATUS,
  CONNECTION_STATUS,
  ERROR_CODES,
  TikTokConnectorError,
};
import { SignerTokenManager } from "./signer-token-manager.js";
import { globalTikTokAuthManager } from "./tiktok-auth-session.js";
import { TikTokLiveMonitor } from "./tiktok-live-monitor.js";
import { CustomTikTokConnector } from "./custom-tiktok-connector.js";
import { GeneralConfig, writeJson, APP_DATA_ROOT } from "./shared.js";
import path from "path";

/**
 * Centralized Provider Manager for SA-CHAOS TikTok LIVE Dual Provider System.
 * - Provider A: IndoFinity (Stable / Default)
 * - Provider B: SA-CHAOS Custom Connector (Public Beta)
 * Ensures only ONE provider is authoritative at any given time.
 * Coordinates room status detection, JWT lifecycle, TikTok session authentication, and safe switching.
 */
export class TikTokProviderManager {
  constructor(options = {}) {
    this.handler = options.handler || null; // Reference to TikTokHandler (tiktok.js)
    this.activeProvider = DEFAULT_PROVIDER;

    this.signerTokenManager = new SignerTokenManager({
      gtaPath: GeneralConfig?.General?.GTA_PATH || "",
    });

    this.authSessionManager = options.authSessionManager || globalTikTokAuthManager;

    this.liveMonitor = new TikTokLiveMonitor({
      onLiveStarted: ({ roomId, username }) => this._handleStreamerBecameLive(roomId, username),
      onLiveEnded: () => this._handleStreamerEndedLive(),
      onStatusChanged: (status) => this._emitStatusUpdate(),
    });

    this.customConnector = new CustomTikTokConnector({
      signerTokenManager: this.signerTokenManager,
      authSessionManager: this.authSessionManager,
      onEvent: (event) => this._handleCustomLiveEvent(event),
      onStreamEnd: () => {
        this.liveMonitor.handleLiveEnded();
        this._startOfflineMonitoringIfNeeded();
      },
      onStatusChanged: (status) => this._emitStatusUpdate(),
    });

    this._initialized = false;
    this._isSwitching = false;
    this._disposed = false;
  }

  setHandler(handler) {
    this.handler = handler;
  }

  /**
   * Initializes provider based on current GeneralConfig.
   */
  async initialize() {
    if (this._initialized) return;
    this._initialized = true;

    // Check if auth session needs restoring from disk or Chromium partition
    if (!this.authSessionManager.isAuthenticated() && typeof this.authSessionManager.restoreSession === "function") {
      await this.authSessionManager.restoreSession();
    }

    const savedProvider =
      GeneralConfig?.Tiktok?.Provider ||
      GeneralConfig?.General?.TiktokProvider ||
      DEFAULT_PROVIDER;

    const targetProvider =
      savedProvider === TIKTOK_PROVIDERS.CUSTOM_BETA
        ? TIKTOK_PROVIDERS.CUSTOM_BETA
        : TIKTOK_PROVIDERS.INDOFINITY;

    console.log(`[TikTokProviderManager] Menginisialisasi provider TikTok: ${targetProvider}`);
    await this.setProvider(targetProvider, { saveConfig: false });
  }

  getProvider() {
    return this.activeProvider;
  }

  /**
   * Resolves the fixed License Owner from license validation.
   */
  getLicenseOwner() {
    return (
      global.tokenOwner ||
      global.gameClientOwner ||
      GeneralConfig?.Tiktok?.owner ||
      this.handler?.tokenOwner ||
      ""
    ).replace(/^@+/, "").trim();
  }

  /**
   * Returns unified provider and connection status for API & UI.
   */
  getStatus() {
    const licenseOwner = this.getLicenseOwner();
    const connectedAs = this.authSessionManager.getConnectedAs();
    const isCustom = this.activeProvider === TIKTOK_PROVIDERS.CUSTOM_BETA;

    if (!isCustom) {
      // IndoFinity status
      const indoStatus = this.handler?.indofinityStatus || {};
      const isLive = Boolean(indoStatus.live || this.handler?.isLive || global.isLive);
      const isConnected = Boolean(indoStatus.connected || global.TikTokGatewayStatus === "Connected");

      return {
        selectedProvider: TIKTOK_PROVIDERS.INDOFINITY,
        channel: "Stable",
        isCustomBeta: false,
        licenseOwner: licenseOwner ? `@${licenseOwner}` : "",
        connectedAs: indoStatus.uniqueId ? `@${indoStatus.uniqueId}` : (licenseOwner ? `@${licenseOwner}` : ""),
        watchingLive: licenseOwner ? `@${licenseOwner}` : (indoStatus.uniqueId ? `@${indoStatus.uniqueId}` : ""),
        roomStatus: isLive ? ROOM_STATUS.LIVE : (indoStatus.ok ? ROOM_STATUS.OFFLINE : ROOM_STATUS.UNKNOWN),
        connectionStatus: isConnected ? CONNECTION_STATUS.CONNECTED : CONNECTION_STATUS.DISCONNECTED,
        indofinityOnline: isConnected,
        isAuthenticated: true,
        error: null,
      };
    }

    // Custom Beta status
    const serverId = this.customConnector.signerServer || DEFAULT_SIGNING_SERVER;
    const serverObj = SIGNING_SERVERS[serverId] || SIGNING_SERVERS.los_santos;

    return {
      selectedProvider: TIKTOK_PROVIDERS.CUSTOM_BETA,
      channel: "Public Beta",
      isCustomBeta: true,
      licenseOwner: licenseOwner ? `@${licenseOwner}` : "",
      connectedAs: connectedAs || "",
      watchingLive: licenseOwner ? `@${licenseOwner}` : "",
      signingServer: serverObj.name,
      signingServerId: serverObj.id,
      availableSigningServers: Object.values(SIGNING_SERVERS).map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
      })),
      roomStatus: this.liveMonitor.roomStatus,
      connectionStatus: this.customConnector.connectionStatus,
      roomId: this.customConnector.roomId || this.liveMonitor.currentRoomId,
      isAuthenticated: this.authSessionManager.isAuthenticated(),
      error: this.customConnector.lastError?.message || this.liveMonitor.lastError?.message || null,
    };
  }

  _emitStatusUpdate() {
    const status = this.getStatus();
    if (global.mainWindowInstance && !global.mainWindowInstance.isDestroyed()) {
      try {
        global.mainWindowInstance.webContents.send("tiktok:provider-status-changed", status);
      } catch {}
    }
  }

  /**
   * Switches the active TikTok provider with guaranteed isolation & cleanup.
   */
  async setProvider(newProvider, options = { saveConfig: true }) {
    if (this._disposed) return;

    const normalized =
      newProvider === TIKTOK_PROVIDERS.CUSTOM_BETA
        ? TIKTOK_PROVIDERS.CUSTOM_BETA
        : TIKTOK_PROVIDERS.INDOFINITY;

    // Guard: Prevent concurrent or recursive switching loops
    if (this._isSwitching) {
      return;
    }

    // Guard: No-op if target provider is already active and initialized
    if (this.activeProvider === normalized && this._initialized) {
      return;
    }

    this._isSwitching = true;
    try {
      const prevProvider = this.activeProvider;
      this.activeProvider = normalized;
      this._initialized = true;

      // 1. Safely stop the previous provider if switching
      if (prevProvider !== normalized) {
        await this._deactivateProvider(prevProvider);
      }

      // 2. Persist configuration
      if (options.saveConfig) {
        if (!GeneralConfig.Tiktok) GeneralConfig.Tiktok = {};
        if (!GeneralConfig.General) GeneralConfig.General = {};

        GeneralConfig.Tiktok.Provider = normalized;
        GeneralConfig.General.TiktokProvider = normalized;

        // In IndoFinity mode, ensure TiktokUseIndofinity is set
        if (normalized === TIKTOK_PROVIDERS.INDOFINITY) {
          GeneralConfig.Tiktok.TiktokUseIndofinity = true;
        } else {
          GeneralConfig.Tiktok.TiktokUseIndofinity = false;
        }

        try {
          writeJson(path.join(APP_DATA_ROOT, "config.json"), GeneralConfig);
        } catch (err) {
          console.error("[TikTokProviderManager] Gagal menyimpan config.json:", err);
        }
      }

      // 3. Activate the new provider
      await this._activateProvider(normalized);

      this._emitStatusUpdate();
      console.info(`[TikTokProviderManager] Provider aktif: ${normalized.toUpperCase()}`);
    } finally {
      this._isSwitching = false;
    }
  }

  async _deactivateProvider(provider) {
    if (provider === TIKTOK_PROVIDERS.CUSTOM_BETA) {
      console.log("[TikTokProviderManager] Menghentikan Custom Connector & Room Monitoring...");
      this.liveMonitor.stopMonitoring();
      this.customConnector.disconnect();
      this.signerTokenManager.invalidate();
    } else {
      console.log("[TikTokProviderManager] Menghentikan IndoFinity connection...");
      if (this.handler && this.handler._tikfinityReconnectTimer) {
        clearTimeout(this.handler._tikfinityReconnectTimer);
        this.handler._tikfinityReconnectTimer = null;
      }
      if (this.handler && this.handler.tiktokConnection) {
        try {
          this.handler.tiktokConnection.removeAllListeners();
          this.handler.tiktokConnection.close();
        } catch {}
        this.handler.tiktokConnection = null;
      }
      if (this.handler && this.handler.tiktokLiveConn) {
        try { this.handler.tiktokLiveConn.disconnect(); } catch {}
        this.handler.tiktokLiveConn = null;
      }
    }
  }

  async _activateProvider(provider) {
    const licenseOwner = this.getLicenseOwner();

    if (provider === TIKTOK_PROVIDERS.INDOFINITY) {
      // Revert to stable IndoFinity mode directly without recursive reloadConfigFromGeneral
      if (this.handler && typeof this.handler.SetupTiktok === "function") {
        this.handler.SetupTiktok();
      }
      return;
    }

    // Custom Beta Mode: Guard if already connected or actively connecting to this licenseOwner
    if (
      (this.customConnector.isConnected() || this.customConnector._isConnecting) &&
      this.customConnector.targetUsername &&
      this.customConnector.targetUsername.toLowerCase() === licenseOwner.toLowerCase()
    ) {
      return;
    }

    console.info(`[TikTokProviderManager] Mengaktifkan Custom Connector Beta untuk License Owner: @${licenseOwner || 'unknown'}`);
    this.signerTokenManager.setGtaPath(GeneralConfig?.General?.GTA_PATH || "");
    this.liveMonitor.setTargetUsername(licenseOwner);
    this.customConnector.setTargetUsername(licenseOwner);

    // If streamer username is not available yet, wait for token validation
    if (!licenseOwner) {
      console.warn("[TikTokProviderManager] License Owner belum terdeteksi. Menunggu validasi token...");
      return;
    }

    // If TikTok authentication is not completed, try restoring from disk/partition first
    if (!this.authSessionManager.isAuthenticated() && typeof this.authSessionManager.restoreSession === "function") {
      await this.authSessionManager.restoreSession();
    }

    // If still not authenticated, we cannot start connection
    if (!this.authSessionManager.isAuthenticated()) {
      console.info("[TikTokProviderManager] Sesi login TikTok belum tersedia. Silakan login akun TikTok di General Config.");
      return;
    }

    // Preflight room status check
    const statusResult = await this.liveMonitor.checkLiveStatus(licenseOwner);
    if (statusResult.isLive && statusResult.status === ROOM_STATUS.LIVE) {
      console.info(`[TikTokProviderManager] Streamer @${licenseOwner} terdeteksi LIVE! Memulai koneksi WebSocket...`);
      await this.customConnector.connect().catch((err) => {
        console.error("[TikTokProviderManager] Error initial connect:", err.message);
      });
    } else {
      console.info(`[TikTokProviderManager] Streamer @${licenseOwner} saat ini OFFLINE. Memulai monitoring offline...`);
      this._startOfflineMonitoringIfNeeded();
    }
  }

  _startOfflineMonitoringIfNeeded() {
    if (this.activeProvider !== TIKTOK_PROVIDERS.CUSTOM_BETA) return;
    const licenseOwner = this.getLicenseOwner();
    if (!licenseOwner) return;

    this.liveMonitor.startMonitoring(licenseOwner);
  }

  async _handleStreamerBecameLive(roomId, username) {
    if (this.activeProvider !== TIKTOK_PROVIDERS.CUSTOM_BETA) return;
    console.info(`[TikTokProviderManager] Menghubungkan ke LIVE @${username} (Room ID: ${roomId})...`);
    try {
      await this.customConnector.connect();
    } catch (err) {
      console.error("[TikTokProviderManager] Gagal menghubungkan ke room yang baru LIVE:", err.message);
    }
  }

  _handleStreamerEndedLive() {
    if (this.activeProvider !== TIKTOK_PROVIDERS.CUSTOM_BETA) return;
    console.info("[TikTokProviderManager] Streamer mengakhiri LIVE. Menutup koneksi dan beralih ke offline monitoring...");
    this.customConnector.disconnect();
    this._startOfflineMonitoringIfNeeded();
  }

  /**
   * Forwards normalized events from Custom Beta into the existing SA-CHAOS pipeline.
   */
  _handleCustomLiveEvent(event) {
    if (!this.handler || this.activeProvider !== TIKTOK_PROVIDERS.CUSTOM_BETA) {
      return;
    }

    const { type, data } = event;
    if (type === "chat" && typeof this.handler.onMessage === "function") {
      this.handler.onMessage(data);
    } else if (type === "gift" && typeof this.handler.onGift === "function") {
      this.handler.onGift(data);
    }
  }

  /**
   * Refreshes target License Owner when license is re-validated.
   */
  updateLicenseOwner(newOwner) {
    const clean = (newOwner || "").replace(/^@+/, "").trim();
    if (!clean) return;

    const currentOwner = (this.customConnector.targetUsername || "").replace(/^@+/, "").trim();
    const isSameOwner = currentOwner.toLowerCase() === clean.toLowerCase();

    this.liveMonitor.setTargetUsername(clean);
    this.customConnector.setTargetUsername(clean);

    if (this.activeProvider === TIKTOK_PROVIDERS.CUSTOM_BETA) {
      // If already connected or connecting to the exact same owner, skip re-activating
      if (isSameOwner && (this.customConnector.isConnected() || this.customConnector._isConnecting)) {
        return;
      }
      this._activateProvider(TIKTOK_PROVIDERS.CUSTOM_BETA);
    }
  }

  dispose() {
    this._disposed = true;
    this.liveMonitor.dispose();
    this.customConnector.dispose();
    this.signerTokenManager.dispose();
  }
}

// Global singleton instance
export let globalTikTokProviderManager = null;

export function initializeGlobalTikTokProviderManager(handler = null) {
  if (!globalTikTokProviderManager) {
    globalTikTokProviderManager = new TikTokProviderManager({ handler });
    global.TikTokProviderManager = globalTikTokProviderManager;
  } else if (handler) {
    globalTikTokProviderManager.setHandler(handler);
  }
  return globalTikTokProviderManager;
}
