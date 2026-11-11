import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

const appDataDir = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
export const APP_DATA_ROOT = path.join(appDataDir, "SA-CHAOS", "data");
export const OFFICIAL_USER_AGENT = "SA-CHAOS/1.1 (Windows NT 10.0; Win64; x64) Electron/Node.js SA-CHAOS";

const CONFIG_PATH = path.join(APP_DATA_ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = path.join(APP_DATA_ROOT, "config.json.ex");
const GIFTS_PATH = path.join(APP_DATA_ROOT, "gifts.json");
const GIFT_IMG_PATH = path.join(APP_DATA_ROOT, "gift-img.json");
const GOAL_PATH = path.join(APP_DATA_ROOT, "gce.json");
const SAWERIA_PATH = path.join(APP_DATA_ROOT, "saweria.json");

const AES_SECRET = Buffer.from("7a3e9c4b2d5f8a1e6c4b9a3e2f5d8c1b9a4e3d2f1b8a5e7c6d4f9b2a1c3e5d7f", "hex");
const AES_IV = Buffer.from("1b3a5c7d9e2f4a6c8b0e1d3f5a7c9e2b", "hex");

function encryptData(text) {
  const cipher = crypto.createCipheriv("aes-256-cbc", AES_SECRET, AES_IV);
  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

function decryptData(text) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", AES_SECRET, AES_IV);
  let decrypted = decipher.update(text, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function readJsonText(path, fallback) {
  try {
    const content = readFileSync(path, "utf8");
    try {
      JSON.parse(content);
      writeJson(path, JSON.parse(content));
      return content;
    } catch (plainError) {
      try {
        const decrypted = decryptData(content);
        return decrypted;
      } catch (decryptError) {
        return fallback;
      }
    }
  } catch (ioError) {
    return fallback;
  }
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readJsonText(path, JSON.stringify(fallback)));
  } catch (e) {
    return fallback;
  }
}

export function writeJson(path, payload) {
  try {
    const jsonString = JSON.stringify(payload, null, 4);
    const encrypted = encryptData(jsonString);
    writeFileSync(path, encrypted, "utf8");
  } catch (e) {
    console.error("Error writing encrypted json:", e.message);
  }
}

const defaultConfigJSON =
{
    "General": {
        "GUIWebsocketPort": 42069,
        "EffectDuration": 30000,
        "ImmuneDuration": 30000,
        "Seed": null,
        "Cooldown": 5000,
        "GTA_PATH": "",
        "MinimizeToTray": true,
        "VerboseLog": false,
        "LogToFile": false,
        "UpdateChannel": "release",
        "p2pUpdaterEnabled": false,
        "p2pUpdaterConsentAccepted": false,
        "p2pSeedingEnabled": false,
        "p2pMaxUploadKBps": 2048,
        "p2pMaxCacheMB": 600,
        "p2pBootstrapMultiaddrs": [
            "/ip6/2406:da1c:11f2:14b:dc34:88da:9283:b479/tcp/4001/p2p/12D3KooWBPstsnWFM4UpynN3GQqS6j3JznmyHAFznCFwXFAWXgEE",
            "/ip6/2406:da1c:11f2:16a:ca72:9311:c32c:d9d/tcp/4001/p2p/12D3KooWBPstsnWFM4UpynN3GQqS6j3JznmyHAFznCFwXFAWXgEE",
            "/ip4/3.25.222.23/tcp/4001/p2p/12D3KooWBPstsnWFM4UpynN3GQqS6j3JznmyHAFznCFwXFAWXgEE"
        ]
    },
    "Tiktok": {
        "TiktokEnable": true,
        "TikfinityEnable": true,
        "TikfinityHTTPServer": false,
        "TiktokUseBuiltInChaos": false,
        "TiktokVoteEnable": false,
        "TiktokForceEffect": true,
        "TiktokUseIndofinity": true,
        "TiktokUsername": "",
        "TiktokSessionId": "",
        "TiktokTtTargetIdc": "",
        "TiktokSignApiKey": "",
        "TiktokAuthenticateWs": true,
        "TiktokVoteCooldown": 30000,
        "DiamondTrackingAccepted": false,
        "DiamondTrackingEnabled": true,
        "DiamondTrackingServerUrl": "https://updater.sa-chaos.my.id/data.php?type=diamond_tracking"
    },
    "EffectForceEffect": {
        "ForceSpecificEffect": false,
        "EffectName": ""
    },
    "EffectForceCategory": {
        "ForceSpecificCategory": false,
        "CategoryName": "Teleportation"
    },
    "ComboEffect": {
        "BetaEnabled": false,
        "ChainDelayMs": 350,
        "MaxComboLength": 5,
        "DeduplicateMs": 1200
    },
    "EffectDurations": {}
};

function ensureBootFiles() {
  const oldDataDir = path.join(process.cwd(), "data");

  if (!existsSync(APP_DATA_ROOT)) {
    mkdirSync(APP_DATA_ROOT, { recursive: true });
    
    // Copy existing data from old directory to new APPDATA directory if it exists
    if (existsSync(oldDataDir)) {
      try {
        const files = readdirSync(oldDataDir);
        for (const file of files) {
          const oldFile = path.join(oldDataDir, file);
          const newFile = path.join(APP_DATA_ROOT, file);
          copyFileSync(oldFile, newFile);
        }
        console.log(`[Migration] Migrated data from ${oldDataDir} to ${APP_DATA_ROOT}`);
      } catch (e) {
        console.error(`[Migration] Failed to migrate data: ${e.message}`);
      }
    }
  }

  // Ensure old data dir exists just in case other parts of the app rely on it existing
  if (!existsSync(oldDataDir)) {
    mkdirSync(oldDataDir, { recursive: true });
  }

  if (!existsSync(CONFIG_PATH)) {
    writeJson(CONFIG_PATH, defaultConfigJSON);
  }

  if (!existsSync(GIFTS_PATH)) {
    writeJson(GIFTS_PATH, []);
  }

  if (!existsSync(GIFT_IMG_PATH)) {
    writeJson(GIFT_IMG_PATH, []);
  }

  if (!existsSync(GOAL_PATH)) {
    writeJson(GOAL_PATH, { goals: [], id: "", effect: "" });
  }

  if (!existsSync(SAWERIA_PATH)) {
    writeJson(SAWERIA_PATH, []);
  }

  const effectsPath = path.join(APP_DATA_ROOT, "effects.json");
  const effectsCachePath = path.join(APP_DATA_ROOT, "effects.cache.json");
  if (!existsSync(effectsPath)) {
    const bundledEffects = path.join(oldDataDir, "effects.json");
    if (existsSync(bundledEffects)) {
      try {
        copyFileSync(bundledEffects, effectsPath);
      } catch (e) {}
    } else {
      writeJson(effectsPath, { Function: [] });
    }
  }

  if (!existsSync(effectsCachePath)) {
    const bundledCache = path.join(oldDataDir, "effects.cache.json");
    if (existsSync(bundledCache)) {
      try {
        copyFileSync(bundledCache, effectsCachePath);
      } catch (e) {}
    }
  }
}

ensureBootFiles();

export const GeneralConfig = readJson(CONFIG_PATH, defaultConfigJSON);

export const eVotingMode = Object.freeze({
  COOLDOWN: 0,
  VOTING: 1,
  ERROR: 3,
});

export const ePickedVote = Object.freeze({
  UNDETERMINED: -1,
  NONE: 0,

  FIRST: 1 << 0,
  SECOND: 1 << 1,
  THIRD: 1 << 2,

  FIRST_SECOND: (1 << 0) | (1 << 1),
  FIRST_THIRD: (1 << 0) | (1 << 2),
  SECOND_THIRD: (1 << 1) | (1 << 2),

  ALL: (1 << 0) | (1 << 1) | (1 << 2),
});
