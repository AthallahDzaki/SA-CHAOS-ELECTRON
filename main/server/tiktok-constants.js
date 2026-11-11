/**
 * SA-CHAOS TikTok LIVE Connector Constants & Structured Errors
 */

export const TIKTOK_PROVIDERS = Object.freeze({
  INDOFINITY: "indofinity",
  CUSTOM_BETA: "custom_beta",
});

export const DEFAULT_PROVIDER = TIKTOK_PROVIDERS.INDOFINITY;

export const SIGNING_SERVERS = Object.freeze({
  los_santos: {
    id: "los_santos",
    name: "Los Santos Server",
    url: "https://signer.sa-chaos.id",
    status: "active",
  },
  san_fierro: {
    id: "san_fierro",
    name: "San Fierro Server",
    url: "https://signer2.sa-chaos.id",
    status: "planning",
  },
});

export const DEFAULT_SIGNING_SERVER = "los_santos";

export const ROOM_STATUS = Object.freeze({
  UNKNOWN: "unknown",
  CHECKING: "checking",
  LIVE: "live",
  OFFLINE: "offline",
  ERROR: "error",
});

export const CONNECTION_STATUS = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  WAITING_FOR_LIVE: "waiting_for_live",
  ERROR: "error",
});

export const TIKTOK_AUTH_STATE = Object.freeze({
  IDLE: "IDLE",
  WINDOW_OPENING: "WINDOW_OPENING",
  WAITING_FOR_LOGIN: "WAITING_FOR_LOGIN",
  CHECKING_COOKIES: "CHECKING_COOKIES",
  VERIFYING_SESSION: "VERIFYING_SESSION",
  AUTHENTICATED: "AUTHENTICATED",
  INCOMPLETE_COOKIES: "INCOMPLETE_COOKIES",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

export const ERROR_CODES = Object.freeze({
  // License errors
  LICENSE_INVALID: "LICENSE_INVALID",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",
  LICENSE_OWNER_MISMATCH: "LICENSE_OWNER_MISMATCH",

  // JWT errors
  JWT_ISSUER_UNAVAILABLE: "JWT_ISSUER_UNAVAILABLE",
  JWT_REFRESH_FAILED: "JWT_REFRESH_FAILED",
  JWT_EXPIRED: "JWT_EXPIRED",

  // TikTok authentication & cookies errors
  TIKTOK_LOGIN_CANCELLED: "TIKTOK_LOGIN_CANCELLED",
  TIKTOK_COOKIES_INCOMPLETE: "TIKTOK_COOKIES_INCOMPLETE",
  TIKTOK_SESSION_EXPIRED: "TIKTOK_SESSION_EXPIRED",
  TIKTOK_ACCOUNT_VERIFICATION_FAILED: "TIKTOK_ACCOUNT_VERIFICATION_FAILED",

  // Room status errors
  ROOM_OFFLINE: "ROOM_OFFLINE",
  ROOM_STATUS_UNKNOWN: "ROOM_STATUS_UNKNOWN",
  ROOM_STATUS_CHECK_FAILED: "ROOM_STATUS_CHECK_FAILED",
  ROOM_ID_CHANGED: "ROOM_ID_CHANGED",
  ROOM_ACCESS_DENIED: "ROOM_ACCESS_DENIED",

  // Custom Signer errors
  SIGNER_UNAUTHORIZED: "SIGNER_UNAUTHORIZED",
  SIGNER_RATE_LIMITED: "SIGNER_RATE_LIMITED",
  SIGNER_UNAVAILABLE: "SIGNER_UNAVAILABLE",

  // WebSocket & connection errors
  TIKTOK_CONNECTION_TIMEOUT: "TIKTOK_CONNECTION_TIMEOUT",
  TIKTOK_WEBSOCKET_DISCONNECTED: "TIKTOK_WEBSOCKET_DISCONNECTED",
  TIKTOK_RECONNECT_FAILED: "TIKTOK_RECONNECT_FAILED",
});

export class TikTokConnectorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "TikTokConnectorError";
    this.code = code;
    this.details = details;
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
    };
  }
}
