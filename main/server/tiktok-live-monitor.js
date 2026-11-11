import { TikTokLiveConnection, UserOfflineError } from "tiktok-live-connector";
import { ROOM_STATUS, ERROR_CODES, TikTokConnectorError } from "./tiktok-constants.js";

/**
 * Monitors the LIVE / OFFLINE state of the licensed TikTok streamer.
 * - Performs pre-flight room checks before WebSocket connection attempts.
 * - Strictly distinguishes actual OFFLINE states from network errors, 429s, and timeouts.
 * - Runs controlled, non-overlapping offline polling (30-60s + jitter).
 * - Detects transitions from OFFLINE to LIVE and triggers single-flight connection.
 */
export class TikTokLiveMonitor {
  constructor(options = {}) {
    this.targetUsername = options.targetUsername || "";
    this.pollIntervalSeconds = options.pollIntervalSeconds || 35;
    this.jitterMaxSeconds = options.jitterMaxSeconds || 10;
    this.connectionFactory = options.connectionFactory || ((username, opts) => new TikTokLiveConnection(username, opts));

    this.roomStatus = ROOM_STATUS.UNKNOWN;
    this.currentRoomId = null;
    this.lastCheckedAt = 0;
    this.lastError = null;

    this._pollTimer = null;
    this._abortController = null;
    this._isPolling = false;
    this._disposed = false;
    this._generationId = 0;

    this.onStatusChanged = options.onStatusChanged || null;
    this.onLiveStarted = options.onLiveStarted || null;
    this.onLiveEnded = options.onLiveEnded || null;
  }

  setTargetUsername(username) {
    const clean = (username || "").replace(/^@+/, "").trim();
    if (this.targetUsername !== clean) {
      this.targetUsername = clean;
      this.currentRoomId = null;
      this.roomStatus = ROOM_STATUS.UNKNOWN;
      this._emitStatus();
    }
  }

  _emitStatus() {
    if (typeof this.onStatusChanged === "function") {
      try {
        this.onStatusChanged({
          roomStatus: this.roomStatus,
          roomId: this.currentRoomId,
          lastCheckedAt: this.lastCheckedAt,
          targetUsername: this.targetUsername,
          error: this.lastError ? this.lastError.message : null,
        });
      } catch {}
    }
  }

  /**
   * Preflight check: verifies whether target streamer is currently LIVE.
   * Returns `{ isLive: boolean, roomId: string | null, status: ROOM_STATUS, error: Error | null }`.
   */
  async checkLiveStatus(targetUsername = null) {
    const user = (targetUsername || this.targetUsername || "").replace(/^@+/, "").trim();
    if (!user) {
      this.roomStatus = ROOM_STATUS.UNKNOWN;
      this.lastError = new TikTokConnectorError(ERROR_CODES.ROOM_STATUS_UNKNOWN, "Username target belum ditentukan.");
      this._emitStatus();
      return { isLive: false, roomId: null, status: ROOM_STATUS.UNKNOWN, error: this.lastError };
    }

    this.roomStatus = ROOM_STATUS.CHECKING;
    this._emitStatus();

    let conn = null;
    try {
      conn = this.connectionFactory(user, {
        processInitialData: false,
        enableExtendedGiftInfo: false,
      });

      // TikTok-Live-Connector 2.5.0 fetchIsLive returns boolean (true if live, false if offline)
      const isLive = await conn.fetchIsLive();
      this.lastCheckedAt = Date.now();
      this.lastError = null;

      if (isLive) {
        let roomId = null;
        try {
          roomId = await conn.fetchRoomId();
          this.currentRoomId = roomId ? String(roomId) : this.currentRoomId;
        } catch {
          // Room ID might be resolved later during connect
        }

        this.roomStatus = ROOM_STATUS.LIVE;
        this._emitStatus();
        return { isLive: true, roomId: this.currentRoomId, status: ROOM_STATUS.LIVE, error: null };
      } else {
        this.roomStatus = ROOM_STATUS.OFFLINE;
        this.currentRoomId = null;
        this._emitStatus();
        return { isLive: false, roomId: null, status: ROOM_STATUS.OFFLINE, error: null };
      }
    } catch (err) {
      this.lastCheckedAt = Date.now();

      // Check if it's an explicit offline error
      if (err instanceof UserOfflineError || (err.message && err.message.toLowerCase().includes("offline"))) {
        this.roomStatus = ROOM_STATUS.OFFLINE;
        this.currentRoomId = null;
        this.lastError = null;
        this._emitStatus();
        return { isLive: false, roomId: null, status: ROOM_STATUS.OFFLINE, error: null };
      }

      // CRITICAL: Network errors, 429 rate limits, 502s, timeouts MUST NOT be converted to OFFLINE!
      console.warn(`[TikTokLiveMonitor] Transient room status check failure for @${user}: ${err.message}`);
      this.roomStatus = ROOM_STATUS.UNKNOWN;
      this.lastError = err;
      this._emitStatus();
      return { isLive: false, roomId: null, status: ROOM_STATUS.UNKNOWN, error: err };
    } finally {
      if (conn && typeof conn.disconnect === "function") {
        try { conn.disconnect(); } catch {}
      }
    }
  }

  /**
   * Starts non-overlapping offline monitoring for the streamer.
   */
  startMonitoring(targetUsername = null, initialDelayMs = 500) {
    if (this._disposed) return;
    if (targetUsername) this.setTargetUsername(targetUsername);

    this.stopMonitoring();
    this._abortController = new AbortController();
    const generation = ++this._generationId;

    const poll = async () => {
      if (this._disposed || generation !== this._generationId) return;
      if (this._isPolling) return; // Single-flight guard

      this._isPolling = true;
      try {
        const result = await this.checkLiveStatus();
        if (generation !== this._generationId) return;

        if (result.isLive && result.status === ROOM_STATUS.LIVE) {
          console.info(`[TikTokLiveMonitor] Streamer @${this.targetUsername} terdeteksi LIVE!`);
          if (typeof this.onLiveStarted === "function") {
            try {
              this.onLiveStarted({
                roomId: result.roomId,
                username: this.targetUsername,
              });
            } catch {}
          }
          // Stop monitoring once live is confirmed; connection manager takes over
          return;
        }
      } finally {
        this._isPolling = false;
      }

      if (this._disposed || generation !== this._generationId) return;

      // Conservative delay: base interval + random jitter
      const jitterMs = Math.floor(Math.random() * (this.jitterMaxSeconds * 1000));
      const delayMs = (this.pollIntervalSeconds * 1000) + jitterMs;

      this._pollTimer = setTimeout(poll, delayMs);
    };

    // Execute initial check with configurable delay
    this._pollTimer = setTimeout(poll, initialDelayMs);
  }

  /**
   * Notifies the monitor that an active LIVE has ended.
   */
  handleLiveEnded() {
    this.roomStatus = ROOM_STATUS.OFFLINE;
    this.currentRoomId = null;
    this._emitStatus();
    if (typeof this.onLiveEnded === "function") {
      try { this.onLiveEnded(); } catch {}
    }
  }

  /**
   * Stops active offline polling timer and aborts pending checks.
   */
  stopMonitoring() {
    this._generationId++;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._isPolling = false;
  }

  /**
   * Disposes the monitor completely.
   */
  dispose() {
    this._disposed = true;
    this.stopMonitoring();
  }
}
