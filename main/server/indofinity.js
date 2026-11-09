import fs from "fs";
import path from "path";
import axios from "axios";
import { spawn } from "child_process";

/**
 * Normalizes username by stripping leading '@', trimming whitespace, and converting to lowercase.
 */
export function normalizeUsername(username) {
  if (!username) return "";
  return String(username).trim().toLowerCase().replace(/^@+/, "");
}

/**
 * Compares registered token owner with current TikTok live user.
 * @returns {{ match: boolean, message: string, owner: string, currentUser: string }}
 */
export function verifyTokenOwner(tokenOwner, currentLiveUser) {
  let cleanOwner = normalizeUsername(tokenOwner);
  let cleanUser = normalizeUsername(currentLiveUser);

  if (!cleanOwner || cleanOwner === "unknown" || cleanOwner === "none") {
    return {
      match: true,
      message: "Owner is not restricted.",
      owner: tokenOwner || "",
      currentUser: currentLiveUser || ""
    };
  }

  if (!cleanUser) {
    return {
      match: true,
      message: "Current live user is not detected yet.",
      owner: tokenOwner,
      currentUser: ""
    };
  }

  if (cleanOwner === cleanUser) {
    return {
      match: true,
      message: "Token owner matches current live user.",
      owner: tokenOwner,
      currentUser: currentLiveUser
    };
  }

  return {
    match: false,
    message: `Username TikTok saat ini (@${currentLiveUser}) tidak cocok dengan pemilik token terdaftar (@${tokenOwner}). Silakan hubungi admin/developer (Athallah) untuk pergantian username.`,
    owner: tokenOwner,
    currentUser: currentLiveUser
  };
}

/**
 * Scans %appdata%/IndoFinity/Local Storage/leveldb to extract the Bearer API token.
 */
export function extractIndofinityToken(customPath = null) {
  try {
    let dirPath = customPath;
    if (!dirPath) {
      const appData =
        process.env.APPDATA ||
        (process.platform === "win32"
          ? path.join(process.env.USERPROFILE || "C:\\Users\\Default", "AppData", "Roaming")
          : "");
      if (!appData) return null;
      dirPath = path.join(appData, "IndoFinity", "Local Storage", "leveldb");
    }

    if (!fs.existsSync(dirPath)) {
      return null;
    }

    const files = fs.readdirSync(dirPath);
    const sortedFiles = files
      .filter((f) => f.endsWith(".ldb") || f.endsWith(".log"))
      .map((f) => {
        try {
          return { file: f, mtime: fs.statSync(path.join(dirPath, f)).mtimeMs };
        } catch (e) {
          return { file: f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const { file } of sortedFiles) {
      try {
        const filePath = path.join(dirPath, file);
        const buf = fs.readFileSync(filePath);
        const strLatin1 = buf.toString("latin1");
        const strUtf8 = buf.toString("utf8");

        // Strategy 1: JSON format {"state":{"token":"..."}}
        const jsonRegex = /\{\s*"state"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/g;
        let m = jsonRegex.exec(strUtf8) || jsonRegex.exec(strLatin1);
        if (m && m[1] && m[1].length >= 20) {
          return { token: m[1], source: file, strategy: "json-state" };
        }

        // Strategy 2: desktop-api proximity slice (handles Snappy compressed key/value pairs)
        const keyIdx = strLatin1.indexOf("desktop-api");
        if (keyIdx !== -1) {
          const slice = strLatin1.slice(keyIdx, keyIdx + 500);
          const tokenMatch = /"(?:token":")?([a-zA-Z0-9_\-]{25,})"/.exec(slice);
          if (tokenMatch && tokenMatch[1]) {
            return { token: tokenMatch[1], source: file, strategy: "desktop-api-slice" };
          }
        }

        // Strategy 3: Direct desktop-api-token regex
        const tokenRegex = /desktop-api-token[^"]*"([a-zA-Z0-9_\-]{25,})"/;
        const m3 = tokenRegex.exec(strLatin1) || tokenRegex.exec(strUtf8);
        if (m3 && m3[1]) {
          return { token: m3[1], source: file, strategy: "desktop-api-token" };
        }
      } catch (err) {
        // Skip locked / unreadable file
      }
    }
  } catch (error) {
    console.warn("[IndoFinity] Error scanning LevelDB:", error.message);
  }

  return null;
}

/**
 * Gets IndoFinity token, prioritizing manual config, then scanning LevelDB.
 */
export function getIndofinityToken(config = null) {
  let manualToken =
    config?.Tiktok?.IndofinityApiToken ||
    config?.SonicTiktok?.IndofinityApiToken ||
    global.IndofinityApiToken ||
    "";

  if (manualToken && String(manualToken).trim().length > 0) {
    return {
      token: String(manualToken).trim(),
      source: "manual-config",
      strategy: "manual"
    };
  }

  return extractIndofinityToken();
}

/**
 * Fetches status from IndoFinity Web API: GET http://127.0.0.1:62030/v1/status
 */
export async function fetchIndofinityStatus(options = {}) {
  const port = options.port || options.config?.Tiktok?.IndofinityHttpPort || 62030;
  const tokenObj = options.token ? { token: options.token, source: "provided" } : getIndofinityToken(options.config);

  if (!tokenObj || !tokenObj.token) {
    return {
      ok: false,
      connected: false,
      tokenFound: false,
      token: null,
      code: "NO_TOKEN",
      error: "Token API IndoFinity tidak ditemukan di LevelDB dan belum diisi secara manual."
    };
  }

  const url = `http://127.0.0.1:${port}/v1/status`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${tokenObj.token}`,
        "User-Agent": "SA-CHAOS-ELECTRON"
      },
      timeout: options.timeout || 4000
    });

    const body = response.data;
    if (body && body.ok) {
      const data = body.data || {};
      const tiktok = data.tiktok || {};

      return {
        ok: true,
        connected: true,
        tokenFound: true,
        token: tokenObj.token,
        tokenSource: tokenObj.source,
        routerVersion: data.router_version,
        glueVersion: data.glue_version,
        appVersion: data.app_version,
        loggedIn: Boolean(data.logged_in),
        uniqueId: tiktok.uniqueId || "",
        live: Boolean(tiktok.live),
        raw: data
      };
    }

    return {
      ok: false,
      connected: true,
      tokenFound: true,
      token: tokenObj.token,
      tokenSource: tokenObj.source,
      error: body?.error?.message || "IndoFinity returned non-ok status",
      code: body?.error?.code || "INDOFINITY_ERROR",
      raw: body
    };
  } catch (err) {
    let errMsg = err.message;
    let code = err.code || "REQUEST_FAILED";

    if (err.response) {
      if (err.response.status === 401) {
        code = "INVALID_TOKEN";
        errMsg = "Token API IndoFinity tidak cocok (401 Unauthorized).";
      } else {
        errMsg = `IndoFinity HTTP ${err.response.status}: ${err.response.data?.error?.message || err.message}`;
      }
    } else if (err.code === "ECONNREFUSED") {
      code = "ECONNREFUSED";
      errMsg = `Tidak dapat terhubung ke IndoFinity di port ${port}. Pastikan aplikasi IndoFinity sedang berjalan.`;
    }

    return {
      ok: false,
      connected: false,
      tokenFound: true,
      token: tokenObj.token,
      tokenSource: tokenObj.source,
      error: errMsg,
      code: code
    };
  }
}

/**
 * Finds the local IndoFinity.exe executable path across common Windows installation directories.
 */
export function findIndofinityExe() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.PROGRAMFILES || "";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "";

  const candidates = [
    path.join(localAppData, "fusion_desktop", "IndoFinity.exe"),
    path.join(localAppData, "Programs", "IndoFinity", "IndoFinity.exe"),
    path.join(localAppData, "IndoFinity", "IndoFinity.exe"),
    path.join(programFiles, "IndoFinity", "IndoFinity.exe"),
    path.join(programFilesX86, "IndoFinity", "IndoFinity.exe"),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Also check under fusion_desktop/app-* directory
  try {
    const fusionDir = path.join(localAppData, "fusion_desktop");
    if (fs.existsSync(fusionDir)) {
      const entries = fs.readdirSync(fusionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("app-")) {
          const appExe = path.join(fusionDir, entry.name, "IndoFinity.exe");
          if (fs.existsSync(appExe)) {
            return appExe;
          }
        }
      }
    }
  } catch (err) {
    // ignore
  }

  return null;
}

/**
 * Launches the IndoFinity application if found.
 */
export function launchIndofinityApp() {
  const exePath = findIndofinityExe();
  if (!exePath) {
    return { ok: false, error: "Aplikasi IndoFinity.exe tidak ditemukan di direktori standar." };
  }

  try {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return { ok: true, path: exePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

