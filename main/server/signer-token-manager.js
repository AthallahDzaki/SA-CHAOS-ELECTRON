import fs from "fs";
import path from "path";
import { ERROR_CODES, TikTokConnectorError } from "./tiktok-constants.js";
import { OFFICIAL_USER_AGENT } from "./shared.js";

/**
 * Safely decodes JWT payload claims without verifying cryptographic signature.
 * (Cryptographic verification is performed server-side by the Rust signer).
 */
export function decodeJwtClaims(jwt) {
  if (!jwt || typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Manages the Ed25519 JWT lifecycle for the SA-CHAOS Custom Signing Gateway.
 * - Exchanges the local SA-CHAOS license for a short-lived signing JWT.
 * - In-memory caching with proactive refresh 60 seconds before expiration.
 * - Deduplicates concurrent refresh requests.
 * - Applies bounded exponential backoff with jitter on transient network errors.
 * - Immediately halts retries on definitive license rejection.
 * - Never persists JWT to disk or exposes it to renderer processes.
 */
export class SignerTokenManager {
  constructor(options = {}) {
    this.issuerUrl = options.issuerUrl || "https://updater.sa-chaos.my.id/jwt_issue.php";
    this.gtaPath = options.gtaPath || null;
    this.manualLicense = options.licenseToken || null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 10000;
    this.earlyRefreshSeconds = options.earlyRefreshSeconds || 60;

    this.cachedJwt = null;
    this.expiresAtMs = 0;
    this.claims = null;

    this._refreshTimer = null;
    this._refreshPromise = null;
    this._disposed = false;
    this._retryCount = 0;
    this._lastError = null;

    this.onJwtUpdated = options.onJwtUpdated || null;
    this.onError = options.onError || null;
  }

  /**
   * Sets or updates GTA Path used to resolve [GTA_PATH]/ChaosMod/token.txt
   */
  setGtaPath(gtaPath) {
    if (this.gtaPath !== gtaPath) {
      this.gtaPath = gtaPath;
      this.invalidate();
    }
  }

  /**
   * Sets manual license token directly.
   */
  setLicenseToken(licenseToken) {
    const clean = (licenseToken || "").trim();
    if (this.manualLicense !== clean) {
      this.manualLicense = clean;
      this.invalidate();
    }
  }

  /**
   * Reads license token from [GTA_PATH]/ChaosMod/token.txt or manualLicense.
   */
  getLicenseToken() {
    if (this.manualLicense && this.manualLicense.length > 0) {
      return this.manualLicense;
    }

    const gtaPath = this.gtaPath || global.GeneralConfig?.General?.GTA_PATH || "";
    if (gtaPath && gtaPath !== "empty") {
      const tokenPath = path.join(gtaPath, "ChaosMod", "token.txt");
      try {
        if (fs.existsSync(tokenPath)) {
          const val = fs.readFileSync(tokenPath, "utf8").trim();
          if (val.length > 0) return val;
        }
      } catch (err) {
        console.warn("[SignerTokenManager] Error reading token.txt:", err.message);
      }
    }

    return null;
  }

  /**
   * Returns a valid, non-expired JWT. If none exists or expires within 30s, refreshes.
   */
  async getValidToken() {
    if (this._disposed) {
      throw new TikTokConnectorError(ERROR_CODES.SIGNER_UNAVAILABLE, "SignerTokenManager is disposed.");
    }

    const now = Date.now();
    // Valid if we have a cached JWT and at least 30 seconds left before expiration
    if (this.cachedJwt && this.expiresAtMs > now + 30000) {
      return this.cachedJwt;
    }

    return this.refreshToken();
  }

  /**
   * Exchanges license for a new JWT with deduplication of concurrent requests.
   */
  async refreshToken() {
    if (this._disposed) {
      throw new TikTokConnectorError(ERROR_CODES.SIGNER_UNAVAILABLE, "SignerTokenManager is disposed.");
    }

    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = this._executeRefresh()
      .finally(() => {
        this._refreshPromise = null;
      });

    return this._refreshPromise;
  }

  async _executeRefresh() {
    const license = this.getLicenseToken();
    if (!license) {
      const err = new TikTokConnectorError(
        ERROR_CODES.LICENSE_INVALID,
        "License token SA-CHAOS tidak ditemukan di [GTA_PATH]/ChaosMod/token.txt."
      );
      this._handleError(err, false);
      throw err;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(this.issuerUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${license}`,
          "Content-Type": "application/json",
          "User-Agent": OFFICIAL_USER_AGENT,
        },
        body: JSON.stringify({
          client: "sa-chaos-desktop",
          scope: ["sign:live"],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Definitive license rejection (401 Unauthorized or 403 Forbidden)
      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => "");
        const err = new TikTokConnectorError(
          ERROR_CODES.LICENSE_INVALID,
          `License SA-CHAOS ditolak oleh server (HTTP ${res.status}): ${text}`
        );
        this._handleError(err, false);
        throw err;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new TikTokConnectorError(
          ERROR_CODES.JWT_ISSUER_UNAVAILABLE,
          `JWT issuer endpoint returned HTTP ${res.status}: ${text}`
        );
        this._handleError(err, true);
        throw err;
      }

      const data = await res.json().catch(() => null);
      if (!data || !data.success || !data.access_token) {
        const err = new TikTokConnectorError(
          ERROR_CODES.JWT_REFRESH_FAILED,
          `JWT issuer failed: ${data?.message || "Invalid payload response"}`
        );
        this._handleError(err, true);
        throw err;
      }

      const jwt = String(data.access_token).trim();
      const claims = decodeJwtClaims(jwt);
      const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 300;

      let expiresAtMs = Date.now() + (expiresInSec * 1000);
      if (claims && typeof claims.exp === "number") {
        expiresAtMs = claims.exp * 1000;
      }

      this.cachedJwt = jwt;
      this.expiresAtMs = expiresAtMs;
      this.claims = claims;
      this._retryCount = 0;
      this._lastError = null;

      // Schedule proactive refresh ~60s before expiration (minimum 10s delay)
      const leadMs = this.earlyRefreshSeconds * 1000;
      const delayMs = Math.max(10000, (expiresAtMs - Date.now()) - leadMs);

      this._scheduleRefresh(delayMs);

      if (typeof this.onJwtUpdated === "function") {
        try {
          this.onJwtUpdated({
            expiresAtMs: this.expiresAtMs,
            owner: claims?.owner || null,
            sub: claims?.sub || null,
          });
        } catch {}
      }

      return jwt;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof TikTokConnectorError) {
        throw err;
      }

      const isAbort = err.name === "AbortError";
      const wrapped = new TikTokConnectorError(
        ERROR_CODES.JWT_ISSUER_UNAVAILABLE,
        isAbort ? "Request ke JWT issuer timeout (10s)." : `Gagal menghubungi JWT issuer: ${err.message}`
      );
      this._handleError(wrapped, true);
      throw wrapped;
    }
  }

  _scheduleRefresh(delayMs) {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    if (this._disposed) return;

    this._refreshTimer = setTimeout(async () => {
      this._refreshTimer = null;
      try {
        await this.refreshToken();
      } catch (err) {
        // Retry logic is already triggered inside _handleError
      }
    }, delayMs);
  }

  _handleError(err, retryable) {
    this._lastError = err;
    if (typeof this.onError === "function") {
      try {
        this.onError(err);
      } catch {}
    }

    if (!retryable || this._disposed) {
      return;
    }

    // Exponential backoff with jitter: 2s, 4s, 8s, up to 30s max
    this._retryCount++;
    const baseBackoffMs = Math.min(30000, 2000 * Math.pow(2, Math.min(this._retryCount - 1, 4)));
    const jitterMs = Math.floor(Math.random() * 1000);
    const delayMs = baseBackoffMs + jitterMs;

    this._scheduleRefresh(delayMs);
  }

  /**
   * Clears in-memory credentials and cancels pending refresh timer.
   */
  invalidate() {
    this.cachedJwt = null;
    this.expiresAtMs = 0;
    this.claims = null;
    this._retryCount = 0;
    this._lastError = null;

    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Shuts down manager permanently, cleaning up all timers.
   */
  dispose() {
    this._disposed = true;
    this.invalidate();
    this._refreshPromise = null;
  }
}
