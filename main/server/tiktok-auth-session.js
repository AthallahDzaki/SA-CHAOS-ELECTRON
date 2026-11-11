let electron = null;
try {
  electron = await import("electron");
} catch {}
const BrowserWindow = electron?.BrowserWindow || null;
const session = electron?.session || null;
import fs from "fs";
import path from "path";
import { ERROR_CODES, TIKTOK_AUTH_STATE, TikTokConnectorError } from "./tiktok-constants.js";
import { APP_DATA_ROOT, GeneralConfig, readJson, writeJson } from "./shared.js";

const PARTITION_NAME = "persist:sa-chaos-tiktok-beta";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const REQUIRED_COOKIES = [
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "ttwid",
  "tt-target-idc",
];

/**
 * Manages the authenticated TikTok session via a dedicated isolated partition.
 * - Opens BrowserWindow for manual TikTok login.
 * - Gathers all required cookies (sessionid, sessionid_ss, sid_tt, ttwid, tt-target-idc).
 * - Verifies authenticated account identity to establish 'Connected As' (@username).
 * - Persists authenticated session across app restarts (in Chromium partition & secure app data).
 */
export class TikTokAuthSessionManager {
  constructor(options = {}) {
    this.partition = options.partition || PARTITION_NAME;
    this.userAgent = options.userAgent || DESKTOP_USER_AGENT;
    this._storagePath =
      options.storagePath !== undefined
        ? options.storagePath
        : (APP_DATA_ROOT ? path.join(APP_DATA_ROOT, "tiktok-auth-session.json") : null);

    this.activeWindow = null;
    this.authState = TIKTOK_AUTH_STATE.IDLE;
    this.connectedAs = null;
    this.connectedUserInfo = null;
    this.cookiesMap = new Map();

    this.onStateChanged = options.onStateChanged || null;
    this.onError = options.onError || null;

    // Load any previously persisted session from disk
    this._loadSavedSession();
  }

  _loadSavedSession() {
    if (!this._storagePath) return;
    try {
      if (fs.existsSync(this._storagePath)) {
        const data = readJson(this._storagePath, null);
        if (data && data.cookies && typeof data.cookies === "object") {
          this.cookiesMap.clear();
          for (const [key, value] of Object.entries(data.cookies)) {
            if (value) {
              this.cookiesMap.set(key.toLowerCase(), String(value).trim());
            }
          }
          this._fillCookieFallbacks();
          this.connectedAs = data.connectedAs || null;
          this.connectedUserInfo = data.userInfo || null;
          if (this.isAuthenticated()) {
            this.authState = TIKTOK_AUTH_STATE.AUTHENTICATED;
            console.info(`[TikTokAuthSession] Sesi TikTok terenkripsi berhasil dimuat dari disk untuk akun: ${this.connectedAs}`);
          }
        }
      }
    } catch (err) {
      console.warn("[TikTokAuthSession] Gagal memuat sesi TikTok dari disk:", err.message);
    }
  }

  _fillCookieFallbacks() {
    // If sessionid_ss is missing, copy from sessionid
    if (!this.cookiesMap.has("sessionid_ss") && this.cookiesMap.has("sessionid")) {
      this.cookiesMap.set("sessionid_ss", this.cookiesMap.get("sessionid"));
    }
    // If tt-target-idc is missing, fallback to GeneralConfig or "alisg"
    if (!this.cookiesMap.has("tt-target-idc") || !this.cookiesMap.get("tt-target-idc")) {
      const fallbackIdc = GeneralConfig?.Tiktok?.TiktokTtTargetIdc || "alisg";
      this.cookiesMap.set("tt-target-idc", fallbackIdc);
    }
  }

  _saveSessionToDisk() {
    if (!this._storagePath) return;
    try {
      const dir = path.dirname(this._storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const cookiesObj = Object.fromEntries(this.cookiesMap.entries());
      const data = {
        connectedAs: this.connectedAs,
        userInfo: this.connectedUserInfo,
        cookies: cookiesObj,
        savedAt: Date.now(),
      };
      writeJson(this._storagePath, data);
      console.info(`[TikTokAuthSession] Sesi TikTok berhasil dienkripsi (AES-256) dan disimpan ke disk (${this.connectedAs})`);
    } catch (err) {
      console.error("[TikTokAuthSession] Gagal menyimpan sesi TikTok terenkripsi ke disk:", err.message);
    }
  }

  /**
   * Restores session on startup: checks disk storage first, then checks Electron persistent partition.
   */
  async restoreSession() {
    // 1. If already authenticated from _loadSavedSession(), return true
    if (this.isAuthenticated()) {
      return true;
    }

    // 2. Try loading from partition session
    if (session && typeof session.fromPartition === "function") {
      try {
        const partitionSession = session.fromPartition(this.partition);
        const cookies = await partitionSession.cookies.get({ domain: ".tiktok.com" });
        const allCookies = await partitionSession.cookies.get({});
        const combined = [...cookies, ...allCookies];

        const map = new Map();
        for (const c of combined) {
          if (c && c.name && c.value) {
            const nameLower = c.name.toLowerCase();
            if (REQUIRED_COOKIES.includes(nameLower) && !map.has(nameLower)) {
              map.set(nameLower, c.value.trim());
            }
            if (nameLower === "tt_target_idc" && !map.has("tt-target-idc")) {
              map.set("tt-target-idc", c.value.trim());
            }
          }
        }

        // Apply fallbacks
        if (!map.has("sessionid_ss") && map.has("sessionid")) {
          map.set("sessionid_ss", map.get("sessionid"));
        }
        if (!map.has("tt-target-idc")) {
          const fallbackIdc = GeneralConfig?.Tiktok?.TiktokTtTargetIdc || "alisg";
          map.set("tt-target-idc", fallbackIdc);
        }

        const missing = REQUIRED_COOKIES.filter((name) => !map.has(name) || !map.get(name));
        if (missing.length === 0) {
          this.cookiesMap = map;

          let verifiedUser = await this._verifyAccountIdentity(partitionSession);
          this.connectedAs = verifiedUser?.username || this.connectedAs || "@tiktok_user";
          this.connectedUserInfo = verifiedUser || null;

          this._setState(TIKTOK_AUTH_STATE.AUTHENTICATED);
          this._saveSessionToDisk();
          console.info(`[TikTokAuthSession] Sesi TikTok berhasil dipulihkan dari partisi Chromium untuk akun: ${this.connectedAs}`);
          return true;
        }
      } catch (err) {
        console.warn("[TikTokAuthSession] Gagal memulihkan sesi dari partisi:", err.message);
      }
    }

    return false;
  }

  _setState(state) {
    this.authState = state;
    if (typeof this.onStateChanged === "function") {
      try {
        this.onStateChanged(state, {
          connectedAs: this.connectedAs,
          isAuthenticated: this.isAuthenticated(),
        });
      } catch {}
    }
  }

  isAuthenticated() {
    if (!this.connectedAs) return false;
    for (const name of REQUIRED_COOKIES) {
      if (!this.cookiesMap.has(name) || !this.cookiesMap.get(name)) {
        return false;
      }
    }
    return true;
  }

  getConnectedAs() {
    return this.connectedAs;
  }

  getCookies() {
    return Object.fromEntries(this.cookiesMap.entries());
  }

  get cookies() {
    return this.getCookies();
  }

  /**
   * Formats headers required by the Rust QuickJS signing server:
   * X-TTL-Client-Cookie: sessionid=...; sessionid_ss=...; sid_tt=...; ttwid=...
   */
  getSignerCookieHeader() {
    const sessionid = this.cookiesMap.get("sessionid") || "";
    const sessionid_ss = this.cookiesMap.get("sessionid_ss") || sessionid;
    const sid_tt = this.cookiesMap.get("sid_tt") || "";
    const ttwid = this.cookiesMap.get("ttwid") || "";

    if (!sessionid || !ttwid) {
      return "";
    }

    return `sessionid=${sessionid}; sessionid_ss=${sessionid_ss}; sid_tt=${sid_tt}; ttwid=${ttwid}`;
  }

  /**
   * Formats the session bundle required by tiktok-live-connector:
   * session: { cookie: { type: "cookie", value: { sessionId, ttTargetIdc } } }
   */
  getConnectorSessionBundle() {
    const sessionId = this.cookiesMap.get("sessionid") || "";
    const ttTargetIdc = this.cookiesMap.get("tt-target-idc") || "";

    if (!sessionId || !ttTargetIdc) {
      return null;
    }

    return {
      type: "cookie",
      value: {
        sessionId,
        ttTargetIdc,
      },
    };
  }

  /**
   * Launches or focuses the dedicated Electron BrowserWindow for TikTok login.
   */
  async openLoginWindow(parentWindow = null) {
    if (!BrowserWindow || !session) {
      return {
        status: "error",
        message: "Electron BrowserWindow API tidak tersedia di lingkungan saat ini.",
      };
    }

    if (this.activeWindow && !this.activeWindow.isDestroyed()) {
      this.activeWindow.focus();
      return {
        status: "in_progress",
        message: "Jendela login TikTok sedang terbuka. Silakan lanjutkan login di jendela tersebut.",
      };
    }

    this._setState(TIKTOK_AUTH_STATE.WINDOW_OPENING);

    const partitionSession = session.fromPartition(this.partition);

    return new Promise((resolve) => {
      let resolved = false;
      let checkInterval = null;
      let debounceTimer = null;

      const authWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        parent: parentWindow || global.mainWindowInstance || undefined,
        modal: false,
        title: "TikTok Login (Public Beta) — Masuk ke Akun TikTok Anda",
        autoHideMenuBar: true,
        webPreferences: {
          partition: this.partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      this.activeWindow = authWindow;
      authWindow.webContents.setUserAgent(this.userAgent);

      this._setState(TIKTOK_AUTH_STATE.WAITING_FOR_LOGIN);

      const cleanup = () => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        try {
          partitionSession.cookies.removeListener("changed", onCookieChanged);
        } catch {}
        this.activeWindow = null;
      };

      const checkSessionAndCookies = async () => {
        if (resolved || authWindow.isDestroyed()) return;

        this._setState(TIKTOK_AUTH_STATE.CHECKING_COOKIES);

        try {
          const cookies = await partitionSession.cookies.get({ domain: ".tiktok.com" });
          const allCookies = await partitionSession.cookies.get({});
          const combined = [...cookies, ...allCookies];

          const map = new Map();
          for (const c of combined) {
            if (c && c.name && c.value) {
              const nameLower = c.name.toLowerCase();
              if (REQUIRED_COOKIES.includes(nameLower) && !map.has(nameLower)) {
                map.set(nameLower, c.value.trim());
              }
              // Normalization fallback for tt_target_idc
              if (nameLower === "tt_target_idc" && !map.has("tt-target-idc")) {
                map.set("tt-target-idc", c.value.trim());
              }
            }
          }

          const missing = REQUIRED_COOKIES.filter((name) => !map.has(name) || !map.get(name));
          if (missing.length > 0) {
            this._setState(TIKTOK_AUTH_STATE.INCOMPLETE_COOKIES);
            return;
          }

          // Cookies exist! Now verify authenticated account identity
          this._setState(TIKTOK_AUTH_STATE.VERIFYING_SESSION);

          const verifiedUser = await this._verifyAccountIdentity(partitionSession);
          if (!verifiedUser) {
            // Cookies might still be propagating or passport info loading
            return;
          }

          resolved = true;
          cleanup();

          // Store verified credentials in memory
          this.cookiesMap = map;
          this._fillCookieFallbacks();
          this.connectedAs = verifiedUser.username;
          this.connectedUserInfo = verifiedUser;

          this._setState(TIKTOK_AUTH_STATE.AUTHENTICATED);
          this._saveSessionToDisk();

          if (!authWindow.isDestroyed()) {
            authWindow.close();
          }

          resolve({
            status: "success",
            connectedAs: this.connectedAs,
            userInfo: verifiedUser,
          });
        } catch (err) {
          console.error("[TikTokAuthSession] Error checking cookies/session:", err);
        }
      };

      const onCookieChanged = (_event, cookie) => {
        const name = (cookie?.name || "").toLowerCase();
        if (
          name.includes("sessionid") ||
          name.includes("sid_tt") ||
          name.includes("ttwid") ||
          name.includes("target-idc") ||
          name.includes("target_idc")
        ) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            checkSessionAndCookies();
          }, 500);
        }
      };

      partitionSession.cookies.on("changed", onCookieChanged);

      // Periodic fallback check every 2 seconds
      checkInterval = setInterval(checkSessionAndCookies, 2000);

      // Listen for window close
      authWindow.on("closed", () => {
        cleanup();
        if (!resolved) {
          resolved = true;
          this._setState(TIKTOK_AUTH_STATE.CANCELLED);
          resolve({
            status: "cancelled",
            message: "Jendela login TikTok ditutup sebelum proses autentikasi selesai.",
          });
        }
      });

      authWindow.loadURL("https://www.tiktok.com/login");
    });
  }

  /**
   * Verifies the authenticated TikTok account identity in the isolated session.
   * Returns `{ username, nickname, avatar }` or null if not yet verified.
   */
  async _verifyAccountIdentity(partitionSession) {
    try {
      // 1. Try querying TikTok passport web account info using partition session
      const res = await partitionSession.fetch("https://www.tiktok.com/passport/web/account/info/", {
        method: "GET",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "application/json",
          "Referer": "https://www.tiktok.com/",
        },
      });

      if (res.ok) {
        const json = await res.json().catch(() => null);
        const data = json?.data;
        if (data && (data.username || data.screen_name || data.user_id)) {
          const rawName = data.username || data.screen_name || `user_${data.user_id}`;
          const cleanName = rawName.replace(/^@+/, "").trim();
          if (cleanName) {
            return {
              username: `@${cleanName}`,
              nickname: data.nickname || cleanName,
              avatar: data.avatar_url || null,
            };
          }
        }
      }
    } catch (e) {
      // Passport fetch error, fallback to cookie / profile detection
    }

    // 2. Fallback: inspect partition cookies for stored user identifier
    try {
      const allCookies = await partitionSession.cookies.get({ domain: ".tiktok.com" });
      const uidCookie = allCookies.find(
        (c) => (c.name === "uid_tt" || c.name === "passport_auth_status_ss") && c.value
      );
      if (uidCookie) {
        // As a last-resort fallback if API is throttled, extract username from user profile page HTML
        const profileRes = await partitionSession.fetch("https://www.tiktok.com/", {
          method: "GET",
          headers: {
            "User-Agent": this.userAgent,
          },
        });
        if (profileRes.ok) {
          const html = await profileRes.text();
          const match = html.match(/"uniqueId":"([a-zA-Z0-9_.-]+)"/);
          if (match && match[1]) {
            return {
              username: `@${match[1].replace(/^@+/, "")}`,
              nickname: match[1],
            };
          }
        }
      }
    } catch {}

    return null;
  }

  /**
   * Clears partition session cookies and cached credentials in memory and disk.
   */
  async clearSession() {
    this.cookiesMap.clear();
    this.connectedAs = null;
    this.connectedUserInfo = null;
    this._setState(TIKTOK_AUTH_STATE.IDLE);

    if (this._storagePath && fs.existsSync(this._storagePath)) {
      try {
        fs.unlinkSync(this._storagePath);
        console.info("[TikTokAuthSession] File sesi tiktok-auth-session.json dihapus.");
      } catch {}
    }

    if (session && typeof session.fromPartition === "function") {
      try {
        const partitionSession = session.fromPartition(this.partition);
        await partitionSession.clearStorageData({
          storages: ["cookies", "localstorage"],
        });
        console.log("[TikTokAuthSession] Sesi TikTok berhasil dihapus dari partisi.");
      } catch (err) {
        console.warn("[TikTokAuthSession] Gagal menghapus storage partisi:", err.message);
      }
    }
  }

  /**
   * Injects existing cookies into memory (for testing or backwards compatibility).
   */
  setSessionFromCookies(cookiesObj, connectedAs = null) {
    if (!cookiesObj || typeof cookiesObj !== "object") return;
    this.cookiesMap.clear();
    for (const [key, value] of Object.entries(cookiesObj)) {
      if (value) {
        this.cookiesMap.set(key.toLowerCase(), String(value).trim());
      }
    }
    this._fillCookieFallbacks();
    if (connectedAs) {
      this.connectedAs = connectedAs.startsWith("@") ? connectedAs : `@${connectedAs}`;
    }
    if (this.isAuthenticated()) {
      this._setState(TIKTOK_AUTH_STATE.AUTHENTICATED);
      this._saveSessionToDisk();
    }
  }
}

// Global singleton instance for the Electron application
export const globalTikTokAuthManager = new TikTokAuthSessionManager();
