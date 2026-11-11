import { fetchIndofinityStatus, verifyTokenOwner } from "./indofinity.js";
import { GeneralConfig } from "./shared.js";

let heartbeatTimer = null;
let lastHeartbeatData = {
  ok: false,
  live: false,
  uniqueId: "",
  owner: "",
  matched: true,
  lastCheck: 0,
  error: null
};

let previousLiveState = null;
let previousMismatchState = null;

/**
 * Executes a single heartbeat cycle.
 * Checks IndoFinity status (http://127.0.0.1:62030/v1/status), verifies live status & owner.
 */
export async function runHeartbeatCheck(options = {}) {
  const wsServer = options.wsServer || global.wsServerInstance;
  const config = options.config || GeneralConfig;

  // Custom Beta mode: derive heartbeat from Custom TikTok Provider Manager
  const provider = config?.Tiktok?.Provider || config?.General?.TiktokProvider || "indofinity";
  if (provider === "custom_beta" && global.TikTokProviderManager) {
    try {
      const customStatus = global.TikTokProviderManager.getStatus();
      const effectiveOwner = global.tokenOwner || global.gameClientOwner || config?.Tiktok?.owner || "";
      const isLive = customStatus.roomStatus === "live";
      const isConn = customStatus.connectionStatus === "connected";

      lastHeartbeatData = {
        ok: true,
        connected: isConn,
        live: isLive,
        uniqueId: effectiveOwner,
        loggedIn: Boolean(customStatus.isAuthenticated),
        owner: effectiveOwner,
        matched: true,
        verificationMessage: "SA-CHAOS Custom Beta terhubung langsung ke TikTok LIVE.",
        lastCheck: Date.now(),
        error: customStatus.error || null,
        raw: customStatus
      };

      global.isLive = isLive;
      global.currentLiveUser = effectiveOwner;
      global.heartbeatStatus = lastHeartbeatData;

      if (global.TiktokHandler) {
        global.TiktokHandler.isLive = isLive;
      }

      // Broadcast heartbeat to connected Game Client(s) via WebSockets
      if (wsServer && wsServer.clients) {
        const heartbeatPayload = JSON.stringify({
          type: "heartbeat",
          live: isLive,
          uniqueId: effectiveOwner,
          owner: effectiveOwner,
          matched: true,
          message: lastHeartbeatData.verificationMessage,
          timestamp: Date.now()
        });

        wsServer.clients.forEach((client) => {
          try {
            if (client.readyState === 1) client.send(heartbeatPayload);
          } catch {}
        });
      }

      if (global.mainWindowInstance && !global.mainWindowInstance.isDestroyed()) {
        try {
          global.mainWindowInstance.webContents.send("heartbeat:update", lastHeartbeatData);
        } catch (e) {}
      }

      return lastHeartbeatData;
    } catch (e) {
      console.warn("[Heartbeat 30s] Custom Beta status check error:", e.message);
    }
  }

  try {
    const status = await fetchIndofinityStatus({ config });
    const effectiveOwner = global.tokenOwner || global.gameClientOwner || config?.Tiktok?.owner || "";
    const verification = verifyTokenOwner(effectiveOwner, status.uniqueId || "");

    const isLive = Boolean(status.live);
    const uniqueId = status.uniqueId || "";

    lastHeartbeatData = {
      ok: Boolean(status.ok),
      connected: Boolean(status.connected),
      live: isLive,
      uniqueId: uniqueId,
      loggedIn: Boolean(status.loggedIn),
      owner: effectiveOwner,
      matched: verification.match,
      verificationMessage: verification.message,
      lastCheck: Date.now(),
      error: status.error || null,
      raw: status.raw || null
    };

    // Keep global states in sync for other components (tiktok.js, index.js, local-config.js)
    global.isLive = isLive;
    global.currentLiveUser = uniqueId;
    global.heartbeatStatus = lastHeartbeatData;

    if (global.TiktokHandler) {
      global.TiktokHandler.indofinityStatus = status;
      global.TiktokHandler.isLive = isLive;

      if (effectiveOwner && uniqueId) {
        global.TiktokHandler.setOwnerMismatch(!verification.match, verification.message);
      }
    }

    // Log live state transitions
    if (previousLiveState !== null && previousLiveState !== isLive) {
      console.log(`[Heartbeat 30s] ⚡ Live state changed: ${previousLiveState ? "LIVE" : "NOT LIVE"} ➔ ${isLive ? "🔴 SEDANG LIVE" : "⚫ TIDAK LIVE"}`);
    }
    previousLiveState = isLive;

    // Log owner mismatch transitions
    if (effectiveOwner && uniqueId) {
      if (previousMismatchState !== !verification.match) {
        if (!verification.match) {
          console.warn(`[Heartbeat 30s] ⚠️ OWNER MISMATCH: Akun live (@${uniqueId}) != pemilik token (@${effectiveOwner})`);
        } else {
          console.log(`[Heartbeat 30s] ✅ Token owner verified: @${effectiveOwner}`);
        }
      }
      previousMismatchState = !verification.match;
    }

    console.log(
      `[Heartbeat 30s] Status: ${status.ok ? "OK" : "NO_CONN"} | Live: ${isLive ? "🔴 LIVE" : "⚫ NOT LIVE"} | User: @${uniqueId || "-"} | Owner: @${effectiveOwner || "-"} | Matched: ${verification.match}`
    );

    // Broadcast heartbeat to connected Game Client(s) via WebSockets
    if (wsServer && wsServer.clients) {
      const heartbeatPayload = JSON.stringify({
        type: "heartbeat",
        live: isLive,
        uniqueId: uniqueId,
        owner: effectiveOwner,
        matched: verification.match,
        message: verification.message,
        timestamp: Date.now()
      });

      wsServer.clients.forEach((client) => {
        try {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(heartbeatPayload);

            // If mismatch is active, also trigger credentials mismatch event so game client can react
            if (!verification.match && effectiveOwner && uniqueId) {
              client.send(JSON.stringify({
                type: "credentials",
                status: "error",
                matched: false,
                owner: effectiveOwner,
                currentLiveUser: uniqueId,
                live: isLive,
                message: verification.message
              }));
            }
          }
        } catch (err) {
          // Silently ignore client send errors
        }
      });
    }

    // If Electron mainWindow IPC is available, emit event to renderer UI
    if (global.mainWindowInstance && !global.mainWindowInstance.isDestroyed()) {
      try {
        global.mainWindowInstance.webContents.send("heartbeat:update", lastHeartbeatData);
      } catch (e) {}
    }

    return lastHeartbeatData;
  } catch (error) {
    lastHeartbeatData = {
      ok: false,
      connected: false,
      live: false,
      uniqueId: "",
      owner: global.tokenOwner || "",
      matched: true,
      lastCheck: Date.now(),
      error: error.message
    };
    console.warn(`[Heartbeat 30s] Check failed: ${error.message}`);
    return lastHeartbeatData;
  }
}

/**
 * Starts the recurring 30-second heartbeat.
 * @param {Object} options
 * @param {number} [options.intervalMs=30000] - Interval in milliseconds (default 30000 = 30s)
 * @param {Object} [options.wsServer] - MultiWebSocketServer instance
 */
export function startHeartbeat(options = {}) {
  const intervalMs = options.intervalMs || 30000;

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  console.log(`[Heartbeat] Service initialized. Running every ${intervalMs / 1000} seconds.`);

  // Run initial check immediately
  runHeartbeatCheck(options);

  // Set recurring 30-second interval
  heartbeatTimer = setInterval(() => {
    runHeartbeatCheck(options);
  }, intervalMs);

  return {
    stop: stopHeartbeat,
    checkNow: () => runHeartbeatCheck(options),
    getData: getLatestHeartbeatData
  };
}

/**
 * Stops the recurring heartbeat.
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("[Heartbeat] Service stopped.");
  }
}

/**
 * Gets the most recent heartbeat check result.
 */
export function getLatestHeartbeatData() {
  return lastHeartbeatData;
}
