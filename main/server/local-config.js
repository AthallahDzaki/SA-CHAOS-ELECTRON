import express from "express";
import cors from "cors";
import path from "path";
import axios from "axios";
import fileUpload from "express-fileupload";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, copyFileSync } from "fs";
import { fileURLToPath } from "url";
import { readJson, writeJson, APP_DATA_ROOT, OFFICIAL_USER_AGENT, GeneralConfig } from "./shared.js";
import { fetchIndofinityStatus, extractIndofinityToken, verifyTokenOwner, normalizeUsername, launchIndofinityApp } from "./indofinity.js";
import { captureTikTokCookies } from "./tiktok-cookie.js";
import { globalTikTokAuthManager } from "./tiktok-auth-session.js";
import { globalTikTokProviderManager } from "./tiktok-provider-manager.js";
import { TIKTOK_PROVIDERS } from "./tiktok-constants.js";
import { getLatestHeartbeatData, runHeartbeatCheck } from "./heartbeat.js";
import { exclusiveManager } from "./exclusive.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// __dirname is main/server, so __dirname/../../renderer points to the renderer folder in app.asar
const RENDERER_PATH = path.join(__dirname, "..", "..", "renderer");
import { SelectGTASA } from "./utils.js";
import { checkAndSyncAutoUpdaterExe, checkAndSyncModFiles, checkAndSyncDesktopApp, runFallbackUpdater } from "./updater.js";
import {
  getGlobalP2PStatus,
  updateGlobalP2PConfig,
  getGlobalP2POrchestrator,
  DEFAULT_P2P_GENERAL_SETTINGS
} from "./p2p/index.js";
import { spawn } from "child_process";
import { dialog } from "electron";
import { exec } from "child_process";
import { logHistory } from "./logger.js";
import { TikTokGatewayStatus } from "./tiktok.js";
import { randomNess } from "./random.js";

const PRODUCT_KEYS = Object.freeze({
  DE: "SA-CHAOS-DE",
  CLASSIC: "SA-CHAOS-CLASSIC",
  SONIC: "SA-CHAOS-SONIC",
  MOUNTAIN: "SA-CHAOS-MOUNTAIN",
  VICECITY: "SA-CHAOS-VICECITY",
  UNKNOWN: "UNKNOWN",
});

const PRODUCT_EFFECT_JSON_URL = Object.freeze({
  [PRODUCT_KEYS.DE]:
    "https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-EFFECT-LIST/refs/heads/definitive-edition/effects.json",
  [PRODUCT_KEYS.CLASSIC]:
    "https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-EFFECT-LIST/refs/heads/classic/effects.json",
  [PRODUCT_KEYS.SONIC]:
    "https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-EFFECT-LIST/refs/heads/sonic/effects.json",
  [PRODUCT_KEYS.MOUNTAIN]:
    "https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-EFFECT-LIST/refs/heads/mountain/effects.json",
  [PRODUCT_KEYS.VICECITY]:
    "https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-EFFECT-LIST/refs/heads/vicecity/effects.json",
});

function resolveProductEffectUrl(productKey) {
  const normalizedKey = normalizeProductKey(productKey);
  if (PRODUCT_EFFECT_JSON_URL[normalizedKey]) {
    return PRODUCT_EFFECT_JSON_URL[normalizedKey];
  }
  if (PRODUCT_EFFECT_JSON_URL[productKey]) {
    return PRODUCT_EFFECT_JSON_URL[productKey];
  }
  if (!normalizedKey || normalizedKey === PRODUCT_KEYS.UNKNOWN) {
    return "";
  }
  const branchCandidate = String(normalizedKey)
    .toLowerCase()
    .replace(/^sa-chaos-/, "")
    .replace(/[^a-z0-9_\-\.\/]/g, "-");
  return `https://raw.githubusercontent.com/AthallahDzaki/SA-CHAOS-EFFECT-LIST/refs/heads/${branchCandidate}/effects.json`;
}

const DEFAULT_COMBO_CONFIG = Object.freeze({
  BetaEnabled: false,
  ChainDelayMs: 350,
  MaxComboLength: 5,
  DeduplicateMs: 1200,
});

const DEFAULT_SPINWHEEL_SETTINGS = Object.freeze({
  spinDuration: 7,
  soundEnabled: true,
  winnerDuration: 5,
  autoHide: true,
  chatCommand: "!spin",
  minDiamonds: 1,
});

function normalizeProductKey(rawValue) {
  let value = String(rawValue || "")
    .trim()
    .toUpperCase()
    .replace(/_/g, "-");

  if (!value) {
    return PRODUCT_KEYS.UNKNOWN;
  }

  if (value.includes("VICE") || value.includes("VC")) {
    return PRODUCT_KEYS.VICECITY;
  }

  if (value.includes("SONIC")) {
    return PRODUCT_KEYS.SONIC;
  }

  if (value.includes("CLASSIC")) {
    return PRODUCT_KEYS.CLASSIC;
  }

  if (value.includes("DE")) {
    return PRODUCT_KEYS.DE;
  }

  if (value.includes("MOUNTAIN")) {
    return PRODUCT_KEYS.MOUNTAIN;
  }

  // Dynamic product detection (e.g. SA-CHAOS-NEWPRODUCT, etc.)
  if (value.startsWith("SA-CHAOS-") || value.length >= 3) {
    return value.startsWith("SA-CHAOS-") ? value : `SA-CHAOS-${value}`;
  }

  return PRODUCT_KEYS.UNKNOWN;
}

function ensureNumber(value, fallbackValue) {
  let parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackValue;
  }
  return parsed;
}

export class LocalConfigHandler {
  constructor(options = {}) {
    this.app = express();
    this.port = options.port || 9001;
    this.productCode = options.productCode || PRODUCT_KEYS.UNKNOWN;
    this.version = options.version || "1.0.0";
    this.enableGithubSync = options.enableGithubSync !== false;
    this.version = options.serverVersion;
    
    // Solusi 1: Mengubah default interval menjadi 5 menit (300000ms) agar lebih bersahabat dengan rate limit
    this.githubSyncIntervalMs = ensureNumber(options.githubSyncIntervalMs, 300000);

    this.rootPath = APP_DATA_ROOT;
    this.configPath = path.resolve(this.rootPath, "config.json");
    this.configExamplePath = path.resolve(this.rootPath, "config.json.ex");
    this.effectsPath = path.resolve(this.rootPath, "effects.json");
    this.effectsCachePath = path.resolve(this.rootPath, "effects.cache.json");
    this.giftsPath = path.resolve(this.rootPath, "gifts.json");
    this.giftImgPath = path.resolve(this.rootPath, "gift-img.json");
    this.goalPath = path.resolve(this.rootPath, "gce.json");
    this.spinwheelPath = path.resolve(this.rootPath, "spinwheel-effects.json");
    this.saweriaPath = path.resolve(this.rootPath, "saweria.json");
    this.voteConfigPath = path.resolve(this.rootPath, "vote-config.json");

    this.syncTimer = null;
    this.eventClients = new Set();
    this.lastSyncMeta = {
      status: "idle",
      source: "local",
      updatedAt: null,
      productKey: normalizeProductKey(this.productCode),
      url: "",
      message: "Sync has not started",
    };

    this.updateCallbacks = {
      config: options.onConfigChanged,
      effects: options.onEffectsChanged,
      gifts: options.onGiftsChanged,
      goal: options.onGoalChanged,
      spinwheel: options.onSpinwheelChanged,
      saweria: options.onSaweriaChanged,
      executeEffect: options.onExecuteEffect,
    };

    this.pendingSpins = new Map();
    this.spinQueue = [];
    this.isSpinning = false;

    this.app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("X-SA-CHAOS-Bridge", "local-config");
      next();
    });

    this.app.use(
      cors({
        origin: "*",
        methods: "*",
        allowedHeaders: "*",
        exposedHeaders: "*",
      }),
    );

    this.app.use(
      fileUpload({
        limits: { fileSize: 50 * 1024 * 1024 },
        abortOnLimit: true,
      }),
    );

      this.app.use(express.json({ limit: "50mb" }));
      this.app.use(express.urlencoded({ extended: true, limit: "50mb" }));
      
      // Fix Next.js RSC payload requests where .__PAGE__.txt is requested instead of /__PAGE__.txt
      this.app.use((req, res, next) => {
        if (req.path.endsWith('.__PAGE__.txt')) {
          req.url = req.url.replace('.__PAGE__.txt', '/__PAGE__.txt');
        }
        next();
      });

      this.app.use(express.static(RENDERER_PATH, { extensions: ['html'], index: false }));

    this.ensureBootFiles();
    this.app.use("/config", this.handleConfigRoutes());

    this.app.use((err, req, res, next) => {
      console.log("[LocalConfig] Internal Error:", err);
      res.status(500).json({ status: "error", message: "Local Config API: " + err.message });
    });

      this.app.get("*", (req, res, next) => {
        // Skip config API routes
        if (req.path.startsWith("/config/")) {
          return next();
        }

        let cleanPath = req.path;
        // Remove trailing slash to help resolve static HTML pages
        if (cleanPath.endsWith("/") && cleanPath.length > 1) {
          cleanPath = cleanPath.slice(0, -1);
        }
        
        const htmlPath = path.join(RENDERER_PATH, cleanPath + ".html");
        const indexHtmlPath = path.join(RENDERER_PATH, cleanPath, "index.html");
        
        if (existsSync(htmlPath)) {
          return res.sendFile(htmlPath);
        } else if (existsSync(indexHtmlPath)) {
          return res.sendFile(indexHtmlPath);
        } else if (cleanPath === "/" && existsSync(path.join(RENDERER_PATH, "index.html"))) {
          return res.sendFile(path.join(RENDERER_PATH, "index.html"));
        }
        
        // Return custom 404 page if exists
        const notFoundPath = path.join(RENDERER_PATH, "404.html");
        if (existsSync(notFoundPath)) {
          return res.status(404).sendFile(notFoundPath);
        }

        res.status(404).send("Not Found");
      });

    this.server = this.app.listen(this.port, () => {
      console.log(`[LocalConfig] Server is running on port ${this.port}`);
      console.log(`[LocalConfig] Endpoint: http://localhost:${this.port}/config/getconfig`);
    });

    this.server.on("error", (error) => {
      console.log("[LocalConfig] Failed to start server:", error.message);
    });

    if (this.enableGithubSync) {
      this.startGithubSyncLoop();
    }
  }

  ensureBootFiles() {
    if (!existsSync(this.configPath)) {
      let fallbackConfig = this.readJSON(this.configExamplePath, {});
      this.writeJSON(this.configPath, fallbackConfig);
    }

    if (!existsSync(this.effectsPath)) {
      this.writeJSON(this.effectsPath, { Function: [] });
    }

    if (!existsSync(this.giftsPath)) {
      this.writeJSON(this.giftsPath, []);
    }

    if (!existsSync(this.giftImgPath)) {
      this.writeJSON(this.giftImgPath, []);
    }

    if (!existsSync(this.goalPath)) {
      this.writeJSON(this.goalPath, { goals: [], id: "", effect: "" });
    }

    if (!existsSync(this.spinwheelPath)) {
      this.writeJSON(this.spinwheelPath, { effects: [] });
    }

    if (!existsSync(this.saweriaPath)) {
      this.writeJSON(this.saweriaPath, []);
    }

    if (!existsSync(this.voteConfigPath)) {
      this.writeJSON(this.voteConfigPath, this.getDefaultVoteConfig());
    }

    let config = this.readJSON(this.configPath, this.readJSON(this.configExamplePath, {}));
    if (this.ensureConfigShape(config)) {
      this.writeJSON(this.configPath, config);
    }
  }

  handleConfigRoutes() {
    let router = express.Router();

    router.get("/", (req, res) => {
      res.json({
        status: "success",
        product: this.getProductCode(),
        version: this.version,
        isUpdateReady: !!global.isUpdateReadyToApply,
        endpoints: this.buildEndpointList(),
        gatewayStatus: TikTokGatewayStatus,
      });
    });

    router.get("/browse-folder", (req, res) => {
      let result = dialog.showOpenDialogSync({
        title: "Pilih Folder 'data' SA-CHAOS Lama",
        properties: ["openDirectory"]
      });
      if (result && result.length > 0) {
        res.json({ status: "success", path: result[0] });
      } else {
        res.json({ status: "cancelled" });
      }
    });

    router.post("/change-gta-path", async (req, res) => {
      try {
        let gtaPath = await SelectGTASA();
        if (gtaPath && gtaPath !== "empty") {
          let cleanPath = gtaPath.replace(/\\(gta_sa\.exe|SanAndreas\.exe)$/i, "");
          let config = this.getConfig();
          config.General.GTA_PATH = cleanPath;
          if (existsSync(path.join(cleanPath, "SanAndreas.exe"))) {
            config.General.Product = "SA-CHAOS-DE";
            this.productCode = "SA-CHAOS-DE";
          } else {
            config.General.Product = "SA-CHAOS-CLASSIC";
            this.productCode = "SA-CHAOS-CLASSIC";
          }
          this.writeJSON(this.configPath, config);
          this.emitUpdate("config", { source: "change-gta-path", config });
          checkAndSyncAutoUpdaterExe(cleanPath).catch(console.error);
          await this.syncEffectsFromGithub("product-switch").catch((err) =>
            console.warn("[LocalConfig] Product switch sync error:", err.message)
          );
          return res.json({ status: "success", path: cleanPath, product: config.General.Product });
        }
        return res.json({ status: "cancelled" });
      } catch (e) {
        return res.status(500).json({ status: "error", message: e.message });
      }
    });

    router.get("/autoupdater-status", (req, res) => {
      res.json(global.autoUpdaterSyncStatus || {
        status: "idle",
        percent: 0,
        message: "",
        error: null,
        updatedAt: Date.now()
      });
    });

    router.get("/desktop-updater-status", async (req, res) => {
      if (req.query.check === "true" || !global.desktopAppUpdateStatus?.latestVersion) {
        await checkAndSyncDesktopApp(false).catch(() => {});
      }
      res.json(global.desktopAppUpdateStatus || {
        status: "idle",
        updateAvailable: false,
        percent: 0,
        detail: "",
        error: null,
        updatedAt: Date.now()
      });
    });

    router.post("/trigger-desktop-update", async (req, res) => {
      console.log("[LocalConfig] Menerima permintaan manual trigger update desktop app...");
      const updateUrl = `https://updater.sa-chaos.my.id/velopack.php/`;
      const selectedChannel = String(GeneralConfig?.General?.UpdateChannel || "release").toLowerCase() === "beta" ? "beta" : "win";
      
      // Jalankan proses update di background agar response HTTP tidak hanging
      runFallbackUpdater({
        updateUrl,
        channel: selectedChannel,
        onProgress: (p) => {
          if (!global.desktopAppUpdateStatus) global.desktopAppUpdateStatus = {};
          global.desktopAppUpdateStatus.status = "downloading";
          global.desktopAppUpdateStatus.percent = p.percent || 0;
          global.desktopAppUpdateStatus.detail = p.detail || "";
          global.desktopAppUpdateStatus.updatedAt = Date.now();
          try {
            this.emitUpdate("desktop-update-progress", global.desktopAppUpdateStatus);
          } catch (e) {}
        }
      }).catch((err) => {
        console.error("[LocalConfig] Trigger desktop update error:", err.message);
        if (global.desktopAppUpdateStatus) {
          global.desktopAppUpdateStatus.status = "error";
          global.desktopAppUpdateStatus.error = err.message;
          global.desktopAppUpdateStatus.updatedAt = Date.now();
        }
      });

      res.json({
        status: "started",
        message: "Proses pembaruan desktop app (Direct S3) dimulai."
      });
    });

    router.post("/auto-update", async (req, res) => {
      const logs = [];
      const logFn = (msg) => {
        console.log("[AutoUpdater]", msg);
        logs.push(msg + "\n");
      };

      try {
        let config = this.getConfig();
        let gtaPath = config.General?.GTA_PATH;
        if (!gtaPath || gtaPath === "empty" || !existsSync(gtaPath)) {
          return res.status(400).json({
            status: "error",
            message: "Direktori GTA SA belum diatur atau tidak ditemukan.",
          });
        }

        let autoUpdaterPath = path.join(gtaPath, "AutoUpdater.exe");

        // 1. Pastikan binary AutoUpdater.exe di folder GTA selalu tersinkronisasi
        try {
          await checkAndSyncAutoUpdaterExe(gtaPath, false);
        } catch (exeErr) {
          logFn(`[System Warning] AutoUpdater.exe sync: ${exeErr.message}`);
        }

        // 2. Jalankan AutoUpdater.exe dengan argumen --electron (memory check, un-inject, update, re-inject)
        if (existsSync(autoUpdaterPath)) {
          logFn(`[System] Menjalankan AutoUpdater.exe (--electron) di: ${gtaPath}`);
          return new Promise((resolve) => {
            const child = spawn(autoUpdaterPath, ["--electron"], { cwd: gtaPath });

            child.stdout.on("data", (data) => {
              let str = data.toString();
              console.log("[AutoUpdater]", str.trim());
              logs.push(str);
            });

            child.stderr.on("data", (data) => {
              let str = data.toString();
              console.error("[AutoUpdater ERR]", str.trim());
              logs.push(`[ERR] ${str}`);
            });

            child.on("error", (err) => {
              logFn(`[System Error] Gagal menjalankan AutoUpdater.exe: ${err.message}`);
              return resolve(res.json({
                status: "error",
                code: -1,
                logs: logs.join(""),
                message: err.message,
              }));
            });

            child.on("close", (code) => {
              logFn(`\n[System] AutoUpdater selesai (exit code: ${code}).`);
              return resolve(res.json({
                status: code === 0 ? "success" : "error",
                code,
                logs: logs.join(""),
              }));
            });
          });
        }

        // 3. Fallback: jika AutoUpdater.exe tidak ditemukan, gunakan sinkronisasi internal Electron
        logFn(`[System] AutoUpdater.exe tidak ditemukan, menggunakan sinkronisasi internal Electron...`);
        let modSuccess = false;
        try {
          const modResult = await checkAndSyncModFiles(gtaPath, logFn);
          if (modResult?.status === "up_to_date") {
            modSuccess = true;
            logFn(`[System] File mod sudah up to date (Hash: ${modResult.hash || "cocok"}).`);
          } else if (modResult?.status === "success") {
            modSuccess = true;
            logFn(`[System] Pembaruan mod berhasil dipasang (${modResult.extractedCount || 0} file diperbarui).`);
          } else if (modResult?.status === "error") {
            logFn(`[System Error] ${modResult.message}`);
          }
        } catch (modErr) {
          logFn(`[System Error] Mod sync error: ${modErr.message}`);
        }

        logFn(`\n[System] Proses pemeriksaan pembaruan selesai.`);

        return res.json({
          status: modSuccess ? "success" : "error",
          code: modSuccess ? 0 : 1,
          logs: logs.join(""),
        });
      } catch (e) {
        return res.status(500).json({ status: "error", message: e.message });
      }
    });

    router.post("/migrate-legacy", (req, res) => {
      try {
        let oldPath = req.body.oldDataPath;
        if (!oldPath) {
          return res.status(400).json({ status: "error", message: "Path tidak boleh kosong." });
        }
        
        let dataPath = oldPath;
        if (!existsSync(path.join(dataPath, "config.json"))) {
          if (existsSync(path.join(dataPath, "data", "config.json"))) {
            dataPath = path.join(dataPath, "data");
          } else {
            return res.status(400).json({ status: "error", message: "Folder tidak valid. Pastikan Anda memilih folder instalasi server lama atau folder 'data'." });
          }
        }
        
        const filesToCopy = ["config.json", "effects.json", "gifts.json", "gift-img.json", "gce.json", "saweria.json", "spinwheel-effects.json", "vote-config.json"];
        let copiedCount = 0;
        
        for (const file of filesToCopy) {
          const srcFile = path.join(dataPath, file);
          const destFile = path.join(this.rootPath, file);
          if (existsSync(srcFile)) {
            copyFileSync(srcFile, destFile);
            copiedCount++;
          }
        }
        
        if (copiedCount > 0) {
          // Re-load the config to runtime
          let config = this.readJSON(this.configPath, this.readJSON(this.configExamplePath, {}));
          this.ensureConfigShape(config);

          // Re-evaluate product code after migration
          let gtaPath = config.General?.GTA_PATH || "";
          if (gtaPath) {
            if (existsSync(path.join(gtaPath, "SanAndreas.exe"))) {
              config.General.Product = "SA-CHAOS-DE";
              this.productCode = "SA-CHAOS-DE";
            } else if (existsSync(path.join(gtaPath, "gta_sa.exe"))) {
              config.General.Product = "SA-CHAOS-CLASSIC";
              this.productCode = "SA-CHAOS-CLASSIC";
            }
            this.writeJSON(this.configPath, config);
          }

          this.emitUpdate("config", {
            source: "migrate",
            config,
          });
          return res.json({ status: "success", message: `Berhasil migrasi ${copiedCount} file konfigurasi.` });
        } else {
          return res.status(400).json({ status: "error", message: "Tidak ada data yang disalin." });
        }
      } catch (e) {
        return res.status(500).json({ status: "error", message: e.message });
      }
    });

    router.get("/events", (req, res) => {
      this.setupEventStream(req, res);
    });

    router.get("/sync-status", (req, res) => {
      res.json({
        status: "success",
        sync: this.lastSyncMeta,
        immune: {
          active: Boolean(global.isImmuneActive && global.isImmuneActive()),
          remainingMs: global.getImmuneRemainingMs ? global.getImmuneRemainingMs() : 0,
          durationMs: global.immuneDuration || 0,
          expiresAt: global.immuneUntil || 0,
        },
      });
    });

    router.get("/product", (req, res) => {
      res.json({ product: this.getProductCode() });
    });

    router.get("/get-product", (req, res) => {
      res.json({
        status: "success",
        product: this.getProductCode(),
      });
    });

    router.get("/logs", (req, res) => {
      res.json({
        status: "success",
        logs: logHistory || [],
      });
    });

    router.post("/clear-logs", (req, res) => {
      if (Array.isArray(logHistory)) {
        logHistory.length = 0;
      }
      res.json({
        status: "success",
        message: "Logs cleared successfully",
      });
    });

    router.get("/getconfig", (req, res) => {
      res.json(this.getConfig());
    });

    router.get("/getconfig-status", (req, res) => {
      res.json({
        status: "success",
        config: this.getConfig(),
      });
    });

    router.post("/setconfig", (req, res) => {
      let config = this.getConfig();
      let bodyData = this.normalizePayload(req.body);

      if (typeof bodyData !== "object" || bodyData == null || Array.isArray(bodyData)) {
        return res.status(400).json({ status: "error", message: "Invalid payload" });
      }

      if (bodyData.path != undefined) {
        let pathKey = String(bodyData.path || "").trim();
        if (pathKey === "") {
          return res.status(400).json({ status: "error", message: "Path cannot be empty" });
        }

        if (bodyData.value == undefined) {
          return res.status(400).json({ status: "error", message: "Value is required" });
        }

        this.setByPath(config, pathKey, this.normalizePayload(bodyData.value));
      } else {
        let partialConfig =
          bodyData.config != undefined ? this.normalizePayload(bodyData.config) : bodyData;
        if (
          typeof partialConfig !== "object" ||
          partialConfig == null ||
          Array.isArray(partialConfig) ||
          Object.keys(partialConfig).length === 0
        ) {
          return res
            .status(400)
            .json({ status: "error", message: "Config payload cannot be empty" });
        }

        config = this.deepMerge(config, partialConfig);
      }

      this.ensureConfigShape(config);
      this.writeJSON(this.configPath, config);
      this.emitUpdate("config", {
        source: "setconfig",
        config,
      });

      return res.json({ status: "success", message: "Config updated", config });
    });

    router.get("/gifts", (req, res) => {
      let gifts = this.getGiftList(true);
      return res.json(gifts);
    });

    router.get("/getgifts", (req, res) => {
      let gifts = this.getGiftList(false);
      return res.json({ status: "success", gifts });
    });

    router.get("/getgift", (req, res) => {
      let gifts = this.getGiftList(false);
      let gift = this.findGift(gifts, req.query);
      if (!gift) {
        return res.status(404).json({ status: "error", message: "Gift not found" });
      }

      return res.json({ status: "success", gift });
    });

    router.post("/setgift", (req, res) => {
      let payload = this.normalizePayload(req.body);
      let gifts = this.readJSON(this.giftsPath, []);
      if (!Array.isArray(gifts)) {
        return res.status(500).json({ status: "error", message: "Invalid gifts file structure" });
      }

      let gift = this.findGift(gifts, payload);
      if (!gift) {
        return res.status(404).json({ status: "error", message: "Gift not found" });
      }

      let effects = this.getEffectsList();
      let disableEffect = this.toBoolean(payload.disable) || this.toBoolean(payload.clear);
      let effectInput =
        payload.effectId ??
        payload.effect_id ??
        payload.effect ??
        payload.effectDescription ??
        payload.effect_description ??
        payload.run_effect;

      if (
        disableEffect ||
        effectInput == undefined ||
        String(effectInput).trim() === "" ||
        String(effectInput).trim().toLowerCase() === "disable"
      ) {
        gift.run_effect = "";
      } else if (
        String(effectInput).trim().toLowerCase() === "none" ||
        String(effectInput).trim().toLowerCase() === "no_effect"
      ) {
        gift.run_effect = "none";
      } else if (String(effectInput).trim().toLowerCase() === "random") {
        gift.run_effect = "random";
      } else if (
        String(effectInput).trim().toLowerCase() === "spinwheel" ||
        String(effectInput).trim().toLowerCase() === "wheel"
      ) {
        gift.run_effect = "spinwheel";
      } else {
        let selectedEffect = this.resolveEffectByInput(effects, effectInput);
        if (!selectedEffect) {
          return res.status(404).json({ status: "error", message: "Effect not found" });
        }

        if (!selectedEffect.description) {
          return res.status(400).json({ status: "error", message: "Effect description is empty" });
        }

        gift.run_effect = selectedEffect.description;
      }

      let customLabelPayload =
        payload.custom_label ??
        payload.customLabel ??
        payload["custom-label"] ??
        payload.overlay_text ??
        payload.label;
      if (customLabelPayload !== undefined) {
        gift.custom_label = String(customLabelPayload || "").trim();
      }

      let comboPayload = payload.run_combo ?? payload.runCombo ?? payload["run-combo"];
      if (comboPayload != undefined) {
        let combo = this.normalizeComboList(comboPayload);
        let config = this.getConfig();
        let maxComboLength = ensureNumber(
          config.ComboEffect?.MaxComboLength,
          DEFAULT_COMBO_CONFIG.MaxComboLength,
        );
        combo = combo.slice(0, maxComboLength);
        gift.run_combo = combo.filter((effectId) => this.findEffectById(effects, effectId) != null);
      }

      let durationPayload =
        payload.duration ??
        payload.duration_ms ??
        payload.durationMs ??
        payload["duration-ms"] ??
        payload.effect_duration;
      if (durationPayload !== undefined) {
        let parsedDuration = parseInt(durationPayload, 10);
        gift.duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;
      }

      let repeatPayload =
        payload.repeat_count ??
        payload.run_count ??
        payload.repeatCount ??
        payload.runCount ??
        payload["repeat-count"] ??
        payload["run-count"];
      if (repeatPayload !== undefined) {
        let parsedRepeat = parseInt(repeatPayload, 10);
        gift.repeat_count = Number.isFinite(parsedRepeat) && parsedRepeat > 0 ? parsedRepeat : 1;
        gift.run_count = gift.repeat_count;
      }

      this.writeJSON(this.giftsPath, gifts);
      this.emitUpdate("gifts", {
        source: "setgift",
        gifts,
      });

      return res.json({ status: "success", message: "Gift updated", gift });
    });

    router.get("/effects", (req, res) => {
      return res.json(this.readEffects());
    });

    router.get("/geteffects", (req, res) => {
      return res.json({ status: "success", effects: this.readEffects() });
    });

    router.get("/exclusive-locks", (req, res) => {
      return res.json({
        status: "success",
        locks: exclusiveManager.getActiveLocks(),
      });
    });

    router.post("/update-effects", async (req, res) => {
      let syncResult = await this.syncEffectsFromGithub("manual");
      if (syncResult.status !== "success") {
        return res.status(500).json({
          status: "error",
          message: syncResult.message || "Failed to sync effect list",
        });
      }

      return res.json({
        status: "success",
        message: syncResult.changed
          ? "Effects synchronized from GitHub"
          : "Effects already up to date",
        sync: syncResult,
      });
    });

    router.get("/goal-config-effect", (req, res) => {
      let goalConfig = this.normalizeGoalConfig(
        this.readJSON(this.goalPath, { goals: [], id: "", effect: "" }),
      );
      this.writeJSON(this.goalPath, goalConfig);
      return res.json(goalConfig);
    });

    router.get("/getgoal", (req, res) => {
      let goal = this.normalizeGoalConfig(
        this.readJSON(this.goalPath, { goals: [], id: "", effect: "" }),
      );
      return res.json({ status: "success", goal });
    });

    router.post("/setgoal", (req, res) => {
      let payload = this.normalizePayload(req.body);
      if (typeof payload !== "object" || payload == null || Array.isArray(payload)) {
        return res.status(400).json({ status: "error", message: "Invalid payload" });
      }

      let goalConfig = this.normalizeGoalConfig(
        this.readJSON(this.goalPath, { goals: [], id: "", effect: "" }),
      );

      if (payload.goals != undefined) {
        let goals = this.normalizePayload(payload.goals);
        if (!Array.isArray(goals)) {
          return res.status(400).json({ status: "error", message: "goals must be array" });
        }
        goalConfig = this.normalizeGoalConfig({ goals });
      } else {
        goalConfig = this.normalizeGoalConfig(this.deepMerge(goalConfig, payload));
      }

      this.writeJSON(this.goalPath, goalConfig);
      this.emitUpdate("goal", {
        source: "setgoal",
        goal: goalConfig,
      });

      return res.json({ status: "success", message: "Goal config updated", goal: goalConfig });
    });

    router.post("/handle-goal-config", (req, res) => {
      let incomingGoals = [];
      if (req.body["goals"] != undefined) {
        try {
          incomingGoals =
            typeof req.body["goals"] === "string"
              ? JSON.parse(req.body["goals"])
              : req.body["goals"];
        } catch (error) {
          return res.status(400).json({ status: "error", message: "Invalid goals payload" });
        }

        if (!Array.isArray(incomingGoals)) {
          return res.status(400).json({ status: "error", message: "Invalid goals payload" });
        }
      } else if (req.body["run-effect"] != undefined) {
        incomingGoals = [{ name: "Goal 1", id: req.body["run-effect"] }];
      }

      let effectList = this.getEffectsList();
      let sanitizedGoals = [];
      let usedKeys = new Set();

      for (let i = 0; i < incomingGoals.length; i++) {
        let goalItem = incomingGoals[i];
        if (!goalItem || typeof goalItem !== "object") {
          continue;
        }

        let effectId = String(goalItem.id || goalItem.effect_id || "").trim();
        if (effectId === "" || effectId === "disable") {
          continue;
        }

        let selectedEffect = this.findEffectById(effectList, effectId);
        if (!selectedEffect) {
          return res
            .status(400)
            .json({ status: "error", message: `Effect not found on goal ${i + 1}` });
        }

        if (!selectedEffect.description) {
          return res
            .status(400)
            .json({ status: "error", message: `Description problem on goal ${i + 1}` });
        }

        let goalName = String(goalItem.name || "").trim() || `Goal ${sanitizedGoals.length + 1}`;
        let keyBase = this.toGoalKey(goalItem.key || goalName, sanitizedGoals.length + 1);
        let key = keyBase;
        let suffix = 2;
        while (usedKeys.has(key)) {
          key = `${keyBase}-${suffix}`;
          suffix++;
        }
        usedKeys.add(key);

        sanitizedGoals.push({
          name: goalName,
          key,
          id: selectedEffect.id,
          effect: selectedEffect.name,
        });
      }

      let goalConfig = this.normalizeGoalConfig({ goals: sanitizedGoals });
      this.writeJSON(this.goalPath, goalConfig);
      this.emitUpdate("goal", {
        source: "handle-goal-config",
        goal: goalConfig,
      });

      return res.json({ status: "success", goals: goalConfig.goals });
    });

    const getSpinwheelData = (req, res) => {
      let spinwheel = this.readJSON(this.spinwheelPath, { effects: [], settings: {} });
      if (!spinwheel || typeof spinwheel !== "object") {
        spinwheel = { effects: [], settings: { ...DEFAULT_SPINWHEEL_SETTINGS } };
      }
      return res.json({
        effects: Array.isArray(spinwheel.effects) ? spinwheel.effects : [],
        settings: { ...DEFAULT_SPINWHEEL_SETTINGS, ...(spinwheel.settings || {}) },
      });
    };

    router.get("/spinnwheel-effects", getSpinwheelData);
    router.get("/spinwheel-effects", getSpinwheelData);

    router.post("/handle-spinwheel-config", (req, res) => {
      let currentSpinwheel = this.readJSON(this.spinwheelPath, { effects: [], settings: {} });
      let effects = currentSpinwheel.effects || [];

      if (req.body["effects"] != undefined) {
        try {
          effects =
            typeof req.body["effects"] === "string"
              ? JSON.parse(req.body["effects"])
              : req.body["effects"];
        } catch (error) {
          return res.status(400).json({ status: "error", message: "Invalid effects payload" });
        }
      }

      if (!Array.isArray(effects)) {
        return res.status(400).json({ status: "error", message: "Invalid effects payload" });
      }

      let effectList = this.getEffectsList();
      let sanitized = effects
        .map((item) => {
          let effectId = String(item?.id || item?.effect_id || "").trim();
          if (effectId === "") {
            return null;
          }

          let selectedEffect = this.findEffectById(effectList, effectId);
          if (!selectedEffect) {
            return null;
          }

          let customLabel = String(item?.custom_label || item?.customLabel || item?.custom_name || "").trim();
          let displayName = String(item?.name || "").trim();
          let finalName = customLabel || displayName || selectedEffect.name;

          return {
            id: selectedEffect.id,
            name: finalName,
            custom_label: customLabel || (finalName !== selectedEffect.name ? finalName : undefined),
          };
        })
        .filter((item) => item != null);

      let nextSettings = { ...DEFAULT_SPINWHEEL_SETTINGS, ...(currentSpinwheel.settings || {}) };
      if (req.body["settings"] != undefined) {
        try {
          let parsedSettings =
            typeof req.body["settings"] === "string"
              ? JSON.parse(req.body["settings"])
              : req.body["settings"];
          if (parsedSettings && typeof parsedSettings === "object") {
            nextSettings = { ...nextSettings, ...parsedSettings };
          }
        } catch (e) {
          // ignore error
        }
      }

      if (nextSettings.minDiamonds !== undefined) {
        nextSettings.minDiamonds = Math.max(1, parseInt(nextSettings.minDiamonds, 10) || 1);
      }

      let spinwheel = { effects: sanitized, settings: nextSettings };
      this.writeJSON(this.spinwheelPath, spinwheel);
      this.emitUpdate("spinwheel", {
        source: "handle-spinwheel-config",
        spinwheel,
      });

      return res.json({ status: "success", spinwheel });
    });

    router.post("/spinwheel/spin", (req, res) => {
      let options = {
        username: req.body["username"] || req.body["user"] || "Streamer",
        nickname: req.body["nickname"] || req.body["name"] || "Streamer",
        giftName: req.body["giftName"] || req.body["gift"] || "",
        source: req.body["source"] || "manual",
        forceTargetIndex: req.body["targetIndex"] !== undefined ? parseInt(req.body["targetIndex"], 10) : undefined,
      };

      let result = this.triggerSpinwheel(options);
      if (result.error) {
        return res.status(400).json({ status: "error", message: result.error });
      }
      return res.json({ status: "success", ...result });
    });

    router.post("/spinwheel/execute", (req, res) => {
      let spinId = req.body["spinId"] || req.body["spin_id"];
      let effectId = req.body["effectId"] || req.body["effect_id"] || req.body["id"];
      let user = {
        username: req.body["username"] || req.body["user"] || "Spinwheel",
        nickname: req.body["nickname"] || req.body["name"] || "Spinwheel",
      };

      let result = this.confirmSpinwheelExecution(spinId, effectId, user, false);
      return res.json(result);
    });

    router.get("/immune/status", (req, res) => {
      let active = Boolean(global.isImmuneActive && global.isImmuneActive());
      let remainingMs = global.getImmuneRemainingMs ? global.getImmuneRemainingMs() : 0;
      return res.json({
        status: "success",
        active,
        remainingMs,
        durationMs: global.immuneDuration || 0,
        expiresAt: global.immuneUntil || 0,
      });
    });

    router.post("/immune/trigger", (req, res) => {
      let durationMs = parseInt(req.body["duration"] || req.body["durationMs"] || req.body["duration_ms"], 10);
      let config = this.getConfig();
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        durationMs = Number(config.General?.ImmuneDuration || 30000);
      }
      let result = null;
      if (global.TiktokHandler && typeof global.TiktokHandler.activateImmune === "function") {
        result = global.TiktokHandler.activateImmune(durationMs, { username: "Manual Trigger", nickname: "Dashboard/Debug" });
      } else {
        global.immuneUntil = Date.now() + durationMs;
        global.immuneDuration = durationMs;
        result = { active: true, durationMs, expiresAt: global.immuneUntil };
      }
      return res.json({ status: "success", ...result });
    });

    router.post("/immune/cancel", (req, res) => {
      global.immuneUntil = 0;
      global.immuneDuration = 0;
      if (global.immuneTimer) {
        clearTimeout(global.immuneTimer);
        global.immuneTimer = null;
      }
      this.broadcastEvent("immune-status", {
        active: false,
        durationMs: 0,
        remainingMs: 0,
        expiresAt: 0,
        timestamp: new Date().toISOString(),
      });
      console.log("[IMMUNE] Mode Immune dibatalkan secara manual.");
      return res.json({ status: "success", active: false });
    });

    router.post(["/execute-effect", "/debug/execute-effect"], (req, res) => {
      let effectId = req.body["effectId"] || req.body["effect_id"] || req.body["id"];
      let duration = req.body["duration"];
      let username = req.body["username"] || req.body["user"] || "Debug Menu";
      let nickname = req.body["nickname"] || req.body["name"] || "Debug Menu";

      if (!effectId) {
        return res.status(400).json({ status: "error", message: "Effect ID is required" });
      }

      let effectList = this.getEffectsList();
      let effect = this.findEffectById(effectList, effectId);
      if (!effect) {
        effect = effectList.find((e) =>
          String(e.id) === String(effectId) ||
          String(e.name || "").toLowerCase() === String(effectId).toLowerCase() ||
          String(e.description || "").toLowerCase() === String(effectId).toLowerCase()
        );
      }

      if (!effect) {
        return res.status(404).json({ status: "error", message: `Effect '${effectId}' not found` });
      }

      let effectToRun = { ...effect };
      if (duration && Number(duration) > 0) {
        effectToRun.duration = Number(duration);
      }

      let user = {
        username,
        nickname,
        source: "debug_menu",
      };

      if (typeof this.updateCallbacks.executeEffect === "function") {
        try {
          this.updateCallbacks.executeEffect(effectToRun, user);
          this.broadcastEvent("effect-executed", {
            effect: effectToRun,
            user,
            timestamp: new Date().toISOString(),
          });
          console.log(`[DebugMenu] Executed effect: ${effectToRun.name || effectToRun.description} (ID: ${effectToRun.id})`);
          return res.json({
            status: "success",
            message: `Efek '${effectToRun.name || effectToRun.description}' berhasil dijalankan!`,
            effect: effectToRun,
          });
        } catch (err) {
          return res.status(500).json({ status: "error", message: err.message });
        }
      } else {
        return res.status(500).json({ status: "error", message: "Execution handler tidak terdaftar" });
      }
    });

    router.get(["/vote-config", "/get-vote-config"], (req, res) => {
      let voteConfig = this.getVoteConfig();
      return res.json({ status: "success", data: voteConfig });
    });

    router.post("/handle-vote-config", (req, res) => {
      let currentVoteConfig = this.getVoteConfig();
      let body = req.body || {};

      let parsedSettings = {};
      if (typeof body.settings === "object" && body.settings !== null) {
        parsedSettings = body.settings;
      } else if (typeof body.settings === "string") {
        try {
          parsedSettings = JSON.parse(body.settings);
        } catch (e) {
          parsedSettings = {};
        }
      }

      let parsedGiftPoints = null;
      if (Array.isArray(body.giftPoints)) {
        parsedGiftPoints = body.giftPoints;
      } else if (typeof body.giftPoints === "string") {
        try {
          parsedGiftPoints = JSON.parse(body.giftPoints);
        } catch (e) {
          parsedGiftPoints = null;
        }
      }

      // Merge settings
      let nextSettings = { ...currentVoteConfig.settings, ...parsedSettings };

      if (body["enabled"] !== undefined) {
        nextSettings.enabled = body["enabled"] === true || body["enabled"] === "true";
      } else if (body["enable-vote"] !== undefined) {
        nextSettings.enabled = body["enable-vote"] === true || body["enable-vote"] === "true";
      }

      if (body["cooldown"] !== undefined) {
        let cd = parseInt(body["cooldown"], 10);
        if (Number.isFinite(cd) && cd > 0) nextSettings.cooldown = cd;
      } else if (body["vote-cooldown"] !== undefined) {
        let cd = parseInt(body["vote-cooldown"], 10);
        if (Number.isFinite(cd) && cd > 0) nextSettings.cooldown = cd;
      }

      if (body["chatVotePoints"] !== undefined) {
        let pt = parseInt(body["chatVotePoints"], 10);
        if (Number.isFinite(pt) && pt > 0) nextSettings.chatVotePoints = pt;
      }

      if (body["allowRepeatGifts"] !== undefined) {
        nextSettings.allowRepeatGifts = body["allowRepeatGifts"] === true || body["allowRepeatGifts"] === "true";
      }

      if (body["multiplyByStreak"] !== undefined) {
        nextSettings.multiplyByStreak = body["multiplyByStreak"] === true || body["multiplyByStreak"] === "true";
      }

      let nextGiftPoints = Array.isArray(parsedGiftPoints) ? parsedGiftPoints : currentVoteConfig.giftPoints;
      let sanitizedGiftPoints = (nextGiftPoints || []).map((item) => ({
        giftId: Number(item.giftId || item.id || 0),
        giftName: String(item.giftName || item.name || "").trim(),
        target: String(item.target || "1").trim(),
        points: Math.max(1, parseInt(item.points || 1, 10)),
        multiplyByCount: item.multiplyByCount !== false && item.multiplyByCount !== "false",
      })).filter((item) => item.giftId > 0 || item.giftName.length > 0);

      let finalVoteConfig = {
        settings: nextSettings,
        giftPoints: sanitizedGiftPoints,
      };

      this.writeJSON(this.voteConfigPath, finalVoteConfig);

      // Sync with Tiktok general config
      let config = this.getConfig();
      if (config.Tiktok) {
        config.Tiktok.TiktokVoteEnable = Boolean(nextSettings.enabled);
        config.Tiktok.TiktokVoteCooldown = Number(nextSettings.cooldown) || 30000;
        this.writeJSON(this.configPath, config);
        this.emitUpdate("config", {
          source: "handle-vote-config",
          config,
        });
      }

      if (global.TiktokHandler) {
        if (typeof global.TiktokHandler.reloadConfigFromGeneral === "function") {
          global.TiktokHandler.reloadConfigFromGeneral();
        }
        if (typeof global.TiktokHandler.reloadVoteConfig === "function") {
          global.TiktokHandler.reloadVoteConfig();
        }
        if (typeof global.TiktokHandler.broadcastVoteToSSE === "function") {
          global.TiktokHandler.broadcastVoteToSSE(true);
        }
      }

      this.emitUpdate("vote-config", {
        source: "handle-vote-config",
        voteConfig: finalVoteConfig,
      });

      return res.json({ status: "success", data: finalVoteConfig });
    });

    router.post("/vote/reset", (req, res) => {
      if (global.TiktokHandler && typeof global.TiktokHandler.resetVoteRound === "function") {
        global.TiktokHandler.resetVoteRound();
        return res.json({ status: "success", message: "Putaran vote berhasil di-reset" });
      }
      return res.json({ status: "error", message: "TikTok Handler belum aktif" });
    });

    router.post("/vote/start", (req, res) => {
      if (global.TiktokHandler && typeof global.TiktokHandler.forceStartVote === "function") {
        global.TiktokHandler.forceStartVote();
        return res.json({ status: "success", message: "Voting berhasil dimulai" });
      }
      return res.json({ status: "error", message: "TikTok Handler belum aktif" });
    });

    router.get("/logs", (req, res) => {
      return res.json({ status: "success", logs: logHistory });
    });

    router.get("/check-audio-path", (req, res) => {
      let config = this.getConfig();
      let audioPath = String(config.General?.GTA_PATH || "") + "\\ChaosMod\\audio";

      if (audioPath !== "\\ChaosMod\\audio" && existsSync(audioPath)) {
        return res.json({ status: "success", path: audioPath });
      }

      return res.json({ status: "error", message: "Audio path not found" });
    });

    router.get("/get-audio-effect", (req, res) => {
      let config = this.getConfig();
      let audioPath = String(config.General?.GTA_PATH || "") + "\\ChaosMod\\audio";

      if (audioPath !== "\\ChaosMod\\audio" && existsSync(audioPath)) {
        let files = readdirSync(audioPath).filter((fileName) => {
          return (
            fileName.endsWith(".mp3") || fileName.endsWith(".ogg") || fileName.endsWith(".wav")
          );
        });

        return res.json({ status: "success", files });
      }

      return res.json({ status: "error", message: "Audio path not found" });
    });

    router.post("/select-gta-path", async (req, res) => {
      let gtaPath = await SelectGTASA();
      if (gtaPath && gtaPath !== "empty") {
        let cleanPath = gtaPath.trim().replace(/\\(gta_sa\.exe|SanAndreas\.exe)$/i, "");
        
        let config = this.getConfig();
        config.General.GTA_PATH = cleanPath;
        if (gtaPath.toLowerCase().endsWith("sanandreas.exe") || existsSync(path.join(cleanPath, "SanAndreas.exe"))) {
          config.General.Product = "SA-CHAOS-DE";
          this.productCode = "SA-CHAOS-DE";
        } else {
          config.General.Product = "SA-CHAOS-CLASSIC";
          this.productCode = "SA-CHAOS-CLASSIC";
        }
        this.writeJSON(this.configPath, config);
        this.emitUpdate("config", { source: "select-gta-path", config });
        await this.syncEffectsFromGithub("product-switch").catch((err) =>
          console.warn("[LocalConfig] Product switch sync error:", err.message)
        );
        return res.json({ status: "success", path: cleanPath, product: config.General.Product });
      }

      return res.json({ status: "error", message: "GTA Path not found" });
    });



    router.get("/tiktok-provider/status", (req, res) => {
      try {
        const status = global.TikTokProviderManager
          ? global.TikTokProviderManager.getStatus()
          : {
              selectedProvider: TIKTOK_PROVIDERS.INDOFINITY,
              channel: "Stable",
              isCustomBeta: false,
              roomStatus: "unknown",
              connectionStatus: "disconnected",
            };
        return res.json({ status: "success", data: status });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.post("/tiktok-provider/switch", async (req, res) => {
      try {
        const target = req.body?.provider;
        const clean = String(target).toLowerCase() === "custom_beta" ? TIKTOK_PROVIDERS.CUSTOM_BETA : TIKTOK_PROVIDERS.INDOFINITY;
        if (global.TikTokProviderManager) {
          await global.TikTokProviderManager.setProvider(clean);
        }
        return res.json({
          status: "success",
          provider: clean,
          data: global.TikTokProviderManager ? global.TikTokProviderManager.getStatus() : null,
        });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.get("/tiktok-auth/status", (req, res) => {
      try {
        return res.json({
          status: "success",
          data: {
            authenticated: globalTikTokAuthManager.isAuthenticated(),
            connectedAs: globalTikTokAuthManager.getConnectedAs(),
            authState: globalTikTokAuthManager.authState,
          },
        });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.post("/tiktok-auth/login", async (req, res) => {
      try {
        const result = await globalTikTokAuthManager.openLoginWindow(global.mainWindowInstance);
        return res.json({ status: "success", result });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.post("/tiktok-auth/logout", async (req, res) => {
      try {
        await globalTikTokAuthManager.clearSession();
        if (global.TikTokProviderManager && global.TikTokProviderManager.getProvider() === TIKTOK_PROVIDERS.CUSTOM_BETA) {
          global.TikTokProviderManager.customConnector.disconnect();
        }
        return res.json({ status: "success", message: "TikTok session cleared." });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.get("/indofinity/status", async (req, res) => {
      try {
        const force = req.query.force === "true" || req.query.refresh === "true";
        const latest = getLatestHeartbeatData();

        let data = latest;
        if (force || !latest || latest.lastCheck === 0) {
          data = await runHeartbeatCheck({ config: this.getConfig() });
        }

        return res.json({
          status: "success",
          data: {
            ok: Boolean(data.ok),
            connected: Boolean(data.connected),
            live: Boolean(data.live),
            uniqueId: data.uniqueId || "",
            loggedIn: Boolean(data.loggedIn),
            tokenOwner: data.owner || "",
            verification: {
              match: Boolean(data.matched),
              message: data.verificationMessage || "",
              owner: data.owner || "",
              currentUser: data.uniqueId || ""
            },
            lastCheck: data.lastCheck,
            error: data.error || null,
            raw: data.raw || null
          }
        });
      } catch (err) {
        return res.json({
          status: "error",
          message: err.message
        });
      }
    });

    router.get("/heartbeat", (req, res) => {
      res.json({
        status: "success",
        heartbeat: getLatestHeartbeatData()
      });
    });

    router.post("/heartbeat/check", async (req, res) => {
      try {
        const result = await runHeartbeatCheck({ config: this.getConfig() });
        res.json({
          status: "success",
          heartbeat: result
        });
      } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
      }
    });

    router.get("/tiktok-vote/status", (req, res) => {
      if (global.TiktokHandler && typeof global.TiktokHandler.getVoteSnapshot === "function") {
        return res.json({ status: "success", data: global.TiktokHandler.getVoteSnapshot() });
      }
      const config = this.getConfig();
      return res.json({
        status: "success",
        data: {
          enabled: Boolean(config.Tiktok?.TiktokVoteEnable),
          mode: "Cooldown",
          remaining: 0,
          cooldown: config.Tiktok?.TiktokVoteCooldown || 30000,
          effects: [],
          votes: [0, 0, 0],
          percentages: [0, 0, 0],
          totalVotes: 0,
          winningIndex: 0,
          winningEffect: "",
          lastWinner: "",
          timestamp: Date.now()
        }
      });
    });

    router.post("/indofinity/detect-token", async (req, res) => {
      try {
        const result = extractIndofinityToken();
        if (result && result.token) {
          return res.json({
            status: "success",
            token: result.token,
            source: result.source,
            strategy: result.strategy
          });
        }
        return res.json({
          status: "not_found",
          message: "Token tidak ditemukan di LevelDB IndoFinity."
        });
      } catch (err) {
        return res.json({
          status: "error",
          message: err.message
        });
      }
    });

    router.post("/indofinity/launch", async (req, res) => {
      try {
        const result = launchIndofinityApp();
        if (result.ok) {
          return res.json({ status: "success", message: "IndoFinity sedang dibuka...", path: result.path });
        }
        return res.json({ status: "not_found", message: result.error || "Aplikasi IndoFinity tidak ditemukan." });
      } catch (err) {
        return res.json({ status: "error", message: err.message });
      }
    });

    router.post("/validate-token", async (req, res) => {
      let config = this.getConfig();
      let gtaPath = String(config.General?.GTA_PATH || "").trim();

      if (!gtaPath || gtaPath === "empty") {
        return res.json({ status: "missing_gta_path", message: "GTA Path is not set." });
      }

      let manualToken = req.body?.manualToken;
      let tokenValue = "";
      let tokenFilePath = path.join(gtaPath, "ChaosMod", "token.txt");

      if (manualToken) {
        tokenValue = String(manualToken).trim();
        try {
          if (!existsSync(path.join(gtaPath, "ChaosMod"))) {
            mkdirSync(path.join(gtaPath, "ChaosMod"), { recursive: true });
          }
          writeFileSync(tokenFilePath, tokenValue, "utf8");
        } catch (e) {
          console.error("Failed to write token file", e);
        }
      } else {
        if (!existsSync(tokenFilePath)) {
          return res.json({ status: "invalid", message: "Token file not found in GTA Path." });
        }
        try {
          tokenValue = readFileSync(tokenFilePath, "utf8").trim();
        } catch (e) {
          return res.json({ status: "invalid", message: "Failed to read token file." });
        }
      }

      if (!tokenValue) {
        return res.json({ status: "invalid", message: "Token is empty." });
      }

      try {
        const response = await axios.get(`https://updater.sa-chaos.my.id/check.php?token=${encodeURIComponent(tokenValue)}`, {
          headers: { "User-Agent": OFFICIAL_USER_AGENT }
        });
        if (response.data && response.data.status === "error") {
          return res.json({ status: "invalid", message: response.data.message || "Invalid Token." });
        }
        
        let expiredAt = null;
        let owner = null;
        if (response.data) {
          expiredAt = response.data.expired_at || response.data.expired_timestamp || null;
          owner = response.data.owner || null;
        }

        if (owner) {
          global.tokenOwner = owner;
          if (global.TiktokHandler) {
            global.TiktokHandler.setTokenOwner(owner);
          }
        }

        // Check if current live user is detected and matches owner
        const currentLiveUser = global.TiktokHandler?.indofinityStatus?.uniqueId || "";
        const verification = verifyTokenOwner(owner, currentLiveUser);
        if (!verification.match) {
          if (global.TiktokHandler) {
            global.TiktokHandler.setOwnerMismatch(true, verification.message);
          }
          return res.json({
            status: "owner_mismatch",
            message: verification.message,
            owner: owner,
            currentLiveUser: currentLiveUser,
            expired_at: expiredAt
          });
        }
        
        return res.json({ status: "success", message: "Token is valid.", expired_at: expiredAt, owner: owner });
      } catch (err) {
        console.error("Token validation error:", err);
        return res.json({ status: "invalid", message: "Failed to connect to validation server." });
      }
    });

    router.post("/handle-general-config", (req, res) => {
      let config = this.getConfig();
      let general = config.General;
      let prevProduct = general?.Product;
      let productChanged = false;

      if (req.body["port"] != undefined) {
        let value = parseInt(req.body["port"], 10);
        if (!Number.isNaN(value)) {
          general.GUIWebsocketPort = value;
        }
      }

      if (req.body["GTA_PATH"] != undefined) {
        general.GTA_PATH = req.body["GTA_PATH"];
        if (existsSync(path.join(general.GTA_PATH, "SanAndreas.exe"))) {
          general.Product = "SA-CHAOS-DE";
          this.productCode = "SA-CHAOS-DE";
        } else if (existsSync(path.join(general.GTA_PATH, "gta_sa.exe"))) {
          general.Product = "SA-CHAOS-CLASSIC";
          this.productCode = "SA-CHAOS-CLASSIC";
        }
        if (general.Product !== prevProduct) {
          productChanged = true;
        }
      }

      if (req.body["minimize_to_tray"] != undefined) {
        general.MinimizeToTray = String(req.body["minimize_to_tray"]).toLowerCase() === "true";
      }

      if (req.body["verbose_log"] != undefined) {
        general.VerboseLog = String(req.body["verbose_log"]).toLowerCase() === "true";
      }

      if (req.body["log_to_file"] != undefined) {
        general.LogToFile = String(req.body["log_to_file"]).toLowerCase() === "true";
      }

      if (req.body["cooldown"] != undefined) {
        let value = parseInt(req.body["cooldown"], 10);
        if (!Number.isNaN(value)) {
          general.Cooldown = value;
        }
      }

      if (req.body["duration"] != undefined) {
        let value = parseInt(req.body["duration"], 10);
        if (!Number.isNaN(value)) {
          general.EffectDuration = value;
        }
      }

      if (req.body["immune_duration"] != undefined || req.body["immune-duration"] != undefined) {
        let rawVal = req.body["immune_duration"] ?? req.body["immune-duration"];
        let value = parseInt(rawVal, 10);
        if (!Number.isNaN(value) && value > 0) {
          general.ImmuneDuration = value;
        }
      }

      if (req.body["seed"] != undefined) {
        let seedRaw = String(req.body["seed"] || "").trim();
        if (seedRaw === "") {
          general.Seed = null;
        } else {
          let value = parseInt(seedRaw, 10);
          if (!Number.isNaN(value)) {
            general.Seed = value;
          }
        }
      }

      if (!config.ComboEffect) {
        config.ComboEffect = { ...DEFAULT_COMBO_CONFIG };
      }

      if (req.body["combo-beta-enabled"] != undefined || req.body["combo_beta_enabled"] != undefined) {
        config.ComboEffect.BetaEnabled =
          String(req.body["combo-beta-enabled"] ?? req.body["combo_beta_enabled"]).toLowerCase() === "true";
      }

      const comboDelayRaw =
        req.body["combo-chain-delay"] ??
        req.body["combo_chain_delay"] ??
        req.body["comboChainDelay"];
      if (comboDelayRaw != undefined) {
        config.ComboEffect.ChainDelayMs = ensureNumber(
          parseInt(comboDelayRaw, 10),
          config.ComboEffect.ChainDelayMs,
        );
      }

      const comboMaxLengthRaw =
        req.body["combo-max-length"] ??
        req.body["combo_max_length"] ??
        req.body["comboMaxLength"];
      if (comboMaxLengthRaw != undefined) {
        config.ComboEffect.MaxComboLength = ensureNumber(
          parseInt(comboMaxLengthRaw, 10),
          config.ComboEffect.MaxComboLength,
        );
      }

      const comboDeduplicateRaw =
        req.body["combo-deduplicate"] ??
        req.body["combo_deduplicate"] ??
        req.body["comboDeduplicate"];
      if (comboDeduplicateRaw != undefined) {
        config.ComboEffect.DeduplicateMs = ensureNumber(
          parseInt(comboDeduplicateRaw, 10),
          config.ComboEffect.DeduplicateMs,
        );
      }


      if (req.body["emulator-path"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.EmulatorPath = String(req.body["emulator-path"] || "");
      }

      if (req.body["socket-host"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.SocketHost = String(req.body["socket-host"] || "127.0.0.1");
      }

      if (req.body["socket-port"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.SocketPort = ensureNumber(
          parseInt(req.body["socket-port"], 10),
          config.Sonic.SocketPort || 0,
        );
      }

      if (req.body["settings-page-port"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.SettingsPagePort = ensureNumber(
          parseInt(req.body["settings-page-port"], 10),
          config.Sonic.SettingsPagePort || 0,
        );
      }

      if (req.body["queue-process-interval"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.QueueProcessInterval = ensureNumber(
          parseInt(req.body["queue-process-interval"], 10),
          config.Sonic.QueueProcessInterval || 0,
        );
      }

      if (req.body["queue-ack-timeout"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.QueueAckTimeout = ensureNumber(
          parseInt(req.body["queue-ack-timeout"], 10),
          config.Sonic.QueueAckTimeout || 0,
        );
      }

      if (req.body["queue-max-retry"] != undefined) {
        if (!config.Sonic) {
          config.Sonic = {};
        }
        config.Sonic.QueueMaxRetry = ensureNumber(
          parseInt(req.body["queue-max-retry"], 10),
          config.Sonic.QueueMaxRetry || 0,
        );
      }

      if (req.body["diamond_tracking_enabled"] != undefined) {
        if (!config.Tiktok) {
          config.Tiktok = {};
        }
        config.Tiktok.DiamondTrackingEnabled =
          String(req.body["diamond_tracking_enabled"]).toLowerCase() === "true";
      }

      if (req.body["diamond_tracking_accepted"] != undefined) {
        if (!config.Tiktok) {
          config.Tiktok = {};
        }
        config.Tiktok.DiamondTrackingAccepted =
          String(req.body["diamond_tracking_accepted"]).toLowerCase() === "true";
      }

      const p2pUpdates = {};
      if (req.body["p2p_updater_consent_accepted"] != undefined) {
        general.p2pUpdaterConsentAccepted =
          String(req.body["p2p_updater_consent_accepted"]).toLowerCase() === "true";
        p2pUpdates.p2pUpdaterConsentAccepted = general.p2pUpdaterConsentAccepted;
      }
      if (req.body["p2p_updater_enabled"] != undefined) {
        const wantEnable = String(req.body["p2p_updater_enabled"]).toLowerCase() === "true";
        if (wantEnable && !general.p2pUpdaterConsentAccepted) {
          return res.status(400).json({
            status: "error",
            message: "Persetujuan P2P Alpha diperlukan sebelum mengaktifkan fitur ini."
          });
        }
        general.p2pUpdaterEnabled = wantEnable;
        p2pUpdates.p2pUpdaterEnabled = wantEnable;
      }
      if (req.body["p2p_seeding_enabled"] != undefined) {
        general.p2pSeedingEnabled =
          String(req.body["p2p_seeding_enabled"]).toLowerCase() === "true";
        p2pUpdates.p2pSeedingEnabled = general.p2pSeedingEnabled;
      }
      if (req.body["p2p_max_upload_kbps"] != undefined) {
        const val = parseInt(req.body["p2p_max_upload_kbps"], 10);
        if (!Number.isNaN(val) && val >= 64) {
          general.p2pMaxUploadKBps = val;
          p2pUpdates.p2pMaxUploadKBps = val;
        }
      }
      if (req.body["p2p_max_cache_mb"] != undefined) {
        const val = parseInt(req.body["p2p_max_cache_mb"], 10);
        if (!Number.isNaN(val) && val >= 100) {
          general.p2pMaxCacheMB = val;
          p2pUpdates.p2pMaxCacheMB = val;
        }
      }

      const reqChannel = req.body["update_channel"] ?? req.body["updateChannel"] ?? req.body["update-channel"];
      if (reqChannel != undefined) {
        const cleanChannel = String(reqChannel).trim().toLowerCase() === "beta" ? "beta" : "release";
        general.UpdateChannel = cleanChannel;
        if (GeneralConfig && GeneralConfig.General) {
          GeneralConfig.General.UpdateChannel = cleanChannel;
        }
      }

      const reqProvider = req.body["tiktok_provider"] ?? req.body["tiktok-provider"] ?? req.body["tiktokProvider"];
      if (reqProvider != undefined) {
        const cleanProvider = String(reqProvider).toLowerCase() === "custom_beta" ? TIKTOK_PROVIDERS.CUSTOM_BETA : TIKTOK_PROVIDERS.INDOFINITY;
        if (!config.Tiktok) config.Tiktok = {};
        config.Tiktok.Provider = cleanProvider;
        general.TiktokProvider = cleanProvider;
        if (cleanProvider === TIKTOK_PROVIDERS.INDOFINITY) {
          config.Tiktok.TiktokUseIndofinity = true;
        } else {
          config.Tiktok.TiktokUseIndofinity = false;
        }
        if (global.TikTokProviderManager) {
          global.TikTokProviderManager.setProvider(cleanProvider).catch((e) =>
            console.warn("[LocalConfig] Provider switch warning:", e.message)
          );
        }
      }

      this.ensureConfigShape(config);
      this.writeJSON(this.configPath, config);
      if (Object.keys(p2pUpdates).length > 0) {
        updateGlobalP2PConfig(p2pUpdates).catch((err) =>
          console.warn("[LocalConfig] P2P runtime sync warning:", err.message)
        );
      }
      this.emitUpdate("config", {
        source: "handle-general-config",
        config,
      });

      if (productChanged) {
        this.syncEffectsFromGithub("product-switch").catch((err) =>
          console.warn("[LocalConfig] Product switch sync error:", err.message)
        );
      }

      return res.json({ status: "success" });
    });

    router.post("/accept-diamond-tracking", (req, res) => {
      let config = this.getConfig();
      if (!config.Tiktok) {
        config.Tiktok = {};
      }

      let accepted = req.body?.accepted === true || String(req.body?.accepted).toLowerCase() === "true";
      let enabled = req.body?.enabled !== false && String(req.body?.enabled).toLowerCase() !== "false";

      config.Tiktok.DiamondTrackingAccepted = accepted;
      config.Tiktok.DiamondTrackingEnabled = enabled;

      this.ensureConfigShape(config);
      this.writeJSON(this.configPath, config);
      this.emitUpdate("config", {
        source: "accept-diamond-tracking",
        config,
      });

      return res.json({ status: "success", accepted, enabled });
    });

    router.get("/p2p-status", (req, res) => {
      try {
        return res.json({
          status: "success",
          p2p: getGlobalP2PStatus()
        });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.get("/p2p-readiness", async (req, res) => {
      try {
        const { probeP2PReadiness } = await import("./p2p/index.js");
        const readiness = await probeP2PReadiness();
        return res.json({ status: "success", readiness });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.post("/p2p-config", async (req, res) => {
      try {
        const body = req.body || {};
        const patch = {};

        if (body.p2pUpdaterConsentAccepted !== undefined || body.p2p_updater_consent_accepted !== undefined) {
          const raw = body.p2pUpdaterConsentAccepted ?? body.p2p_updater_consent_accepted;
          patch.p2pUpdaterConsentAccepted = raw === true || String(raw).toLowerCase() === "true";
        }

        if (body.p2pUpdaterEnabled !== undefined || body.p2p_updater_enabled !== undefined) {
          const raw = body.p2pUpdaterEnabled ?? body.p2p_updater_enabled;
          patch.p2pUpdaterEnabled = raw === true || String(raw).toLowerCase() === "true";
        }

        if (body.p2pSeedingEnabled !== undefined || body.p2p_seeding_enabled !== undefined) {
          const raw = body.p2pSeedingEnabled ?? body.p2p_seeding_enabled;
          patch.p2pSeedingEnabled = raw === true || String(raw).toLowerCase() === "true";
        }

        if (body.p2pMaxUploadKBps !== undefined || body.p2p_max_upload_kbps !== undefined) {
          const raw = Number(body.p2pMaxUploadKBps ?? body.p2p_max_upload_kbps);
          if (Number.isFinite(raw) && raw >= 64) {
            patch.p2pMaxUploadKBps = raw;
          }
        }

        if (body.p2pMaxCacheMB !== undefined || body.p2p_max_cache_mb !== undefined) {
          const raw = Number(body.p2pMaxCacheMB ?? body.p2p_max_cache_mb);
          if (Number.isFinite(raw) && raw >= 100) {
            patch.p2pMaxCacheMB = raw;
          }
        }

        if (body.p2pBootstrapMultiaddrs !== undefined) {
          let list = body.p2pBootstrapMultiaddrs;
          if (typeof list === "string") {
            try {
              list = JSON.parse(list);
            } catch {
              list = list.split(",").map((s) => s.trim()).filter(Boolean);
            }
          }
          if (Array.isArray(list)) {
            patch.p2pBootstrapMultiaddrs = list;
          }
        }

        const snapshot = await updateGlobalP2PConfig(patch);
        const config = this.getConfig();
        this.emitUpdate("config", {
          source: "p2p-config",
          config
        });
        return res.json({
          status: "success",
          p2p: snapshot
        });
      } catch (err) {
        return res.status(400).json({
          status: "error",
          message: err.message
        });
      }
    });

    router.post("/p2p-cancel", (req, res) => {
      try {
        const cancelled = getGlobalP2POrchestrator().cancelP2PAndFallbackToS3();
        return res.json({
          status: "success",
          cancelled,
          p2p: getGlobalP2PStatus()
        });
      } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.get("/update-channel", (req, res) => {
      const config = this.getConfig();
      const currentChannel = String(config?.General?.UpdateChannel || "release").toLowerCase() === "beta" ? "beta" : "release";
      return res.json({
        status: "success",
        channel: currentChannel,
        channels: [
          {
            id: "release",
            name: "Release (Stable)",
            description: "Channel rilis resmi stabil, direkomendasikan untuk gameplay dan live streaming sehari-hari."
          },
          {
            id: "beta",
            name: "Beta (Fitur Lebih Awal)",
            description: "Channel pengujian awal dengan fitur terbaru lebih cepat. Tidak menjamin kestabilan dan mungkin mengandung error."
          }
        ]
      });
    });

    router.post("/set-update-channel", async (req, res) => {
      const target = String(req.body?.channel || req.body?.update_channel || "").toLowerCase().trim();
      if (target !== "beta" && target !== "release") {
        return res.status(400).json({
          status: "error",
          message: "Channel tidak valid. Pilihan yang valid: 'release' atau 'beta'."
        });
      }

      const config = this.getConfig();
      if (!config.General) config.General = {};
      config.General.UpdateChannel = target;
      if (GeneralConfig && GeneralConfig.General) {
        GeneralConfig.General.UpdateChannel = target;
      }
      this.ensureConfigShape(config);
      this.writeJSON(this.configPath, config);

      try {
        const orch = getGlobalP2POrchestrator();
        if (orch && typeof orch.updateConfig === "function") {
          await orch.updateConfig({ channel: target === "beta" ? "beta" : "win" });
        }
      } catch (err) {
        console.warn("[LocalConfig] P2P channel update warning:", err.message);
      }

      // Trigger background check for new channel
      checkAndSyncDesktopApp(false).catch((err) => {
        console.warn("[LocalConfig] Desktop update re-check error:", err.message);
      });

      this.emitUpdate("config", {
        source: "set-update-channel",
        config
      });

      return res.json({
        status: "success",
        channel: target,
        message: target === "beta"
          ? "Berhasil beralih ke Channel Beta (Fitur Lebih Awal)."
          : "Berhasil beralih ke Channel Release (Stable)."
      });
    });

    router.post("/set-game-mode", (req, res) => {
      let config = this.getConfig();
      if (!config.Tiktok) {
        config.Tiktok = {};
      }
      let mode = String(req.body.mode || req.body["game-mode"] || "").toLowerCase().trim();

      const validModes = ["gift", "vote", "spinwheel", "hybrid_vote_gift", "hybrid_vote_spin", "custom"];
      if (!validModes.includes(mode)) {
        return res.status(400).json({
          status: "error",
          message: `Mode '${mode}' tidak valid. Pilihan: ${validModes.join(", ")}`,
        });
      }

      config.Tiktok.InteractionMode = mode;

      switch (mode) {
        case "gift": // GIFT MAYHEM
          config.Tiktok.TiktokEnable = true;
          config.Tiktok.TikfinityEnable = true;
          config.Tiktok.TiktokVoteEnable = false;
          config.Tiktok.TiktokForceEffect = true;
          break;
        case "vote": // DEMOCRACY ARENA
          config.Tiktok.TiktokEnable = true;
          config.Tiktok.TikfinityEnable = true;
          config.Tiktok.TiktokVoteEnable = true;
          config.Tiktok.TiktokForceEffect = false;
          break;
        case "spinwheel": // FORTUNE ROULETTE
          config.Tiktok.TiktokEnable = true;
          config.Tiktok.TikfinityEnable = true;
          config.Tiktok.TiktokVoteEnable = false;
          config.Tiktok.TiktokForceEffect = true;
          break;
        case "hybrid_vote_gift": // DUAL ANARCHY (VOTE & GIFT)
          config.Tiktok.TiktokEnable = true;
          config.Tiktok.TikfinityEnable = true;
          config.Tiktok.TiktokVoteEnable = true;
          config.Tiktok.TiktokForceEffect = true;
          break;
        case "hybrid_vote_spin": // ROULETTE DEMOCRACY (VOTE & SPIN)
          config.Tiktok.TiktokEnable = true;
          config.Tiktok.TikfinityEnable = true;
          config.Tiktok.TiktokVoteEnable = true;
          config.Tiktok.TiktokForceEffect = true;
          break;
        case "custom": // CUSTOM / SANDBOX
          // Leaves current settings as-is
          break;
      }

      this.ensureConfigShape(config);
      this.writeJSON(this.configPath, config);
      this.emitUpdate("config", {
        source: "set-game-mode",
        config,
      });

      console.log(`[LocalConfig] Chaos Game Mode updated to: ${mode.toUpperCase()}`);
      return res.json({
        status: "success",
        mode,
        tiktok: config.Tiktok,
      });
    });

    router.post("/tiktok/capture-cookies", async (req, res) => {
      try {
        const result = await captureTikTokCookies(global.mainWindowInstance);
        return res.json(result);
      } catch (err) {
        console.error("[capture-cookies route error]", err);
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.get("/tiktok/capture-cookies", async (req, res) => {
      try {
        const result = await captureTikTokCookies(global.mainWindowInstance);
        return res.json(result);
      } catch (err) {
        console.error("[capture-cookies route error]", err);
        return res.status(500).json({ status: "error", message: err.message });
      }
    });

    router.post("/handle-tiktok-config", (req, res) => {
      let config = this.getConfig();
      if (!config.Tiktok) {
        config.Tiktok = {};
      }

      let tiktok = config.Tiktok;

      if (req.body["enable-tiktok"] != undefined) {
        tiktok.TiktokEnable = req.body["enable-tiktok"] === "true";
      }

      if (req.body["enable-tikfinity"] != undefined) {
        tiktok.TikfinityEnable = req.body["enable-tikfinity"] === "true";
      }

      if (req.body["enable-tikfinity-http"] != undefined) {
        tiktok.TikfinityHTTPServer = req.body["enable-tikfinity-http"] === "true";
      }

      if (req.body["enable-build-in-chaos"] != undefined) {
        tiktok.TiktokUseBuiltInChaos = req.body["enable-build-in-chaos"] === "true";
      }

      if (req.body["username"] != undefined) {
        tiktok.TiktokUsername = req.body["username"];
      }

      if (req.body["session"] != undefined) {
        tiktok.TiktokSessionId = req.body["session"];
      }

      if (req.body["tt-target-idc"] != undefined) {
        tiktok.TiktokTtTargetIdc = String(req.body["tt-target-idc"] || "").trim();
      } else if (req.body["ttTargetIdc"] != undefined) {
        tiktok.TiktokTtTargetIdc = String(req.body["ttTargetIdc"] || "").trim();
      }

      if (req.body["sign-api-key"] != undefined) {
        tiktok.TiktokSignApiKey = String(req.body["sign-api-key"] || "").trim();
      } else if (req.body["signApiKey"] != undefined) {
        tiktok.TiktokSignApiKey = String(req.body["signApiKey"] || "").trim();
      }

      if (req.body["authenticate-ws"] != undefined) {
        tiktok.TiktokAuthenticateWs = req.body["authenticate-ws"] === "true" || req.body["authenticate-ws"] === true;
      } else if (req.body["authenticateWs"] != undefined) {
        tiktok.TiktokAuthenticateWs = req.body["authenticateWs"] === "true" || req.body["authenticateWs"] === true;
      }

      if (req.body["enable-vote"] != undefined) {
        tiktok.TiktokVoteEnable = req.body["enable-vote"] === "true";
      }

      if (req.body["vote-cooldown"] != undefined) {
        let value = parseInt(req.body["vote-cooldown"], 10);
        if (!Number.isNaN(value)) {
          tiktok.TiktokVoteCooldown = value;
        }
      }

      if (req.body["enable-force-effect"] != undefined) {
        tiktok.TiktokForceEffect = req.body["enable-force-effect"] === "true";
      }

      if (req.body["enable-indofinity"] != undefined) {
        tiktok.TiktokUseIndofinity = req.body["enable-indofinity"] === "true";
      }

      if (req.body["indofinity-api-token"] != undefined) {
        tiktok.IndofinityApiToken = String(req.body["indofinity-api-token"] || "").trim();
        if (!config.SonicTiktok) {
          config.SonicTiktok = {};
        }
        config.SonicTiktok.IndofinityApiToken = tiktok.IndofinityApiToken;
      }

      if (req.body["indofinity-port"] != undefined) {
        let portVal = parseInt(req.body["indofinity-port"], 10);
        if (!Number.isNaN(portVal) && portVal > 0) {
          tiktok.IndofinityPort = portVal;
        }
        if (!config.SonicTiktok) {
          config.SonicTiktok = {};
        }
        config.SonicTiktok.IndofinityPort = ensureNumber(
          portVal,
          config.SonicTiktok.IndofinityPort || 0,
        );
      }

      if (req.body["owner-unique-id"] != undefined) {
        if (!config.SonicTiktok) {
          config.SonicTiktok = {};
        }
        config.SonicTiktok.OwnerUniqueId = String(req.body["owner-unique-id"] || "");
      }

      if (req.body["force-gift-effect"] != undefined) {
        if (!config.SonicTiktok) {
          config.SonicTiktok = {};
        }
        config.SonicTiktok.ForceGiftEffect = String(req.body["force-gift-effect"] || "true");
      }

      this.ensureConfigShape(config);
      this.writeJSON(this.configPath, config);
      this.emitUpdate("config", {
        source: "handle-tiktok-config",
        config,
      });

      if (global.TiktokHandler && typeof global.TiktokHandler.reloadConfigFromGeneral === "function") {
        global.TiktokHandler.reloadConfigFromGeneral();
      }

      return res.json({ status: "success" });
    });

    router.post("/handle-gift-config", async (req, res) => {
      let gifts = this.readJSON(this.giftsPath, []);
      if (!Array.isArray(gifts)) {
        return res.status(500).json({ status: "error", message: "Invalid gifts file structure" });
      }

      let targetGift = gifts.find((item) => String(item.id) === String(req.body["gift"] || ""));
      if (!targetGift) {
        return res.status(400).json({ status: "error", message: "Gift not found" });
      }

      let config = this.getConfig();
      let effectList = this.getEffectsList();
      let effectId = String(req.body["run-effect"] || "").trim();
      let hasComboField = req.body["run-combo"] != undefined || req.body["run_combo"] != undefined;

      let customLabelPayload =
        req.body["custom_label"] ??
        req.body["custom-label"] ??
        req.body["overlay_text"] ??
        req.body["overlay-text"] ??
        req.body["label"];
      if (customLabelPayload !== undefined) {
        targetGift.custom_label = String(customLabelPayload || "").trim();
      }

      if (hasComboField) {
        let comboRaw = req.body["run-combo"] ?? req.body["run_combo"];
        let combo = this.normalizeComboList(comboRaw);
        let maxComboLength = ensureNumber(
          config.ComboEffect?.MaxComboLength,
          DEFAULT_COMBO_CONFIG.MaxComboLength,
        );
        combo = combo.slice(0, maxComboLength);
        targetGift.run_combo = combo.filter((comboEffectId) =>
          this.findEffectById(effectList, comboEffectId),
        );
      }

      let durationPayload =
        req.body["duration"] ??
        req.body["duration_ms"] ??
        req.body["durationMs"] ??
        req.body["duration-ms"] ??
        req.body["effect_duration"];
      if (durationPayload !== undefined) {
        let parsedDuration = parseInt(durationPayload, 10);
        targetGift.duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;
      }

      let repeatPayload =
        req.body["repeat_count"] ??
        req.body["run_count"] ??
        req.body["repeatCount"] ??
        req.body["runCount"] ??
        req.body["repeat-count"] ??
        req.body["run-count"];
      if (repeatPayload !== undefined) {
        let parsedRepeat = parseInt(repeatPayload, 10);
        targetGift.repeat_count = Number.isFinite(parsedRepeat) && parsedRepeat > 0 ? parsedRepeat : 1;
        targetGift.run_count = targetGift.repeat_count;
      }

      if (effectId !== "") {
        if (effectId === "disable") {
          targetGift.run_effect = "";
        } else if (effectId === "none" || effectId === "no_effect") {
          targetGift.run_effect = "none";
        } else if (effectId === "random") {
          targetGift.run_effect = "random";
        } else if (effectId === "spinwheel" || effectId === "wheel") {
          targetGift.run_effect = "spinwheel";
        } else if (effectId === "immune" || effectId.toLowerCase() === "immune") {
          targetGift.run_effect = "immune";
        } else {
          let selectedEffect = this.findEffectById(effectList, effectId);
          if (!selectedEffect) {
            return res.status(400).json({ status: "error", message: "Effect not found" });
          }

          if (!selectedEffect.description) {
            return res.status(400).json({ status: "error", message: "Description Problem!!" });
          }

          targetGift.run_effect = selectedEffect.description;

          let removeAudio = req.body["remove-audio"] === "true";
          let audioFile = req.files ? req.files["audio-effect"] : undefined;
          if (Array.isArray(audioFile)) {
            audioFile = audioFile[0];
          }

          if (removeAudio) {
            let gtaPath = String(config.General?.GTA_PATH || "");
            if (gtaPath !== "") {
              let audioPath = path.join(gtaPath, "ChaosMod", "audio");
              const commonExts = ["mp3", "ogg", "wav", "m4a", "aac"];
              for (const ext of commonExts) {
                let oldPath = path.join(audioPath, `effect_${selectedEffect.id}.${ext}`);
                if (existsSync(oldPath)) {
                  try {
                    unlinkSync(oldPath);
                  } catch (e) {
                    console.error("[LocalConfig] Failed to delete old audio:", e);
                  }
                }
              }
            }
          } else if (audioFile) {
            let gtaPath = String(config.General?.GTA_PATH || "");
            if (gtaPath !== "") {
              let audioPath = path.join(gtaPath, "ChaosMod", "audio");
              if (!existsSync(audioPath)) {
                mkdirSync(audioPath, { recursive: true });
              }

              let fileExtension =
                String(audioFile.name || "")
                  .split(".")
                  .pop() || "mp3";
              let newFileName = `effect_${selectedEffect.id}.${fileExtension}`;
              let newFilePath = path.join(audioPath, newFileName);

              try {
                // Delete previous audio files with different extensions to avoid conflicts
                const commonExts = ["mp3", "ogg", "wav", "m4a", "aac"];
                for (const ext of commonExts) {
                  if (ext !== fileExtension) {
                    let oldPath = path.join(audioPath, `effect_${selectedEffect.id}.${ext}`);
                    if (existsSync(oldPath)) {
                      try {
                        unlinkSync(oldPath);
                      } catch (e) {
                        console.error("[LocalConfig] Failed to delete old audio:", e);
                      }
                    }
                  }
                }

                await audioFile.mv(newFilePath);
              } catch (error) {
                return res
                  .status(500)
                  .json({ status: "error", message: "Failed to save audio file" });
              }
            }
          }
        }
      }

      this.writeJSON(this.giftsPath, gifts);
      this.emitUpdate("gifts", {
        source: "handle-gift-config",
        gifts,
      });

      return res.json({ status: "success", gift: targetGift });
    });

    router.post("/update-gifts", async (req, res) => {
      let username = String(req.body["username"] || "").trim();
      if (username === "") {
        return res.status(400).json({ status: "error", message: "Username is required" });
      }

      let response;
      try {
        response = await axios.get(
          `https://indofinity.com/api/v1/gifts?username=${encodeURIComponent(username)}`,
        );
      } catch (error) {
        return res
          .status(500)
          .json({ status: "error", message: "Failed to fetch gifts from source" });
      }

      let giftData = Array.isArray(response.data?.data) ? response.data.data : [];
      let currentGifts = this.readJSON(this.giftsPath, []);
      let currentImages = this.readJSON(this.giftImgPath, []);

      if (!Array.isArray(currentGifts)) {
        currentGifts = [];
      }

      if (!Array.isArray(currentImages)) {
        currentImages = [];
      }

      let giftMap = new Map(currentGifts.map((gift) => [String(gift.id), gift]));
      let imageMap = new Map(currentImages.map((image) => [String(image.id), image]));
      let apiGiftIds = new Set(giftData.map((gift) => String(gift.gift_id)));

      let addedGifts = giftData
        .filter(item => !giftMap.has(String(item.gift_id)))
        .map(item => ({ id: item.gift_id, name: item.name }));
    
      let addedGiftCount = addedGifts.length;

      let nextGifts = giftData
        .map((item) => {
          let id = String(item.gift_id);
          let existing = giftMap.get(id) || {};

          return {
            id: item.gift_id,
            name: item.name,
            diamond_count: item.diamond_count,
            run_effect: String(existing.run_effect || ""),
            run_combo: this.normalizeComboList(existing.run_combo),
            custom_label: String(existing.custom_label || ""),
            duration: Number(existing.duration || 0),
            repeat_count: Math.max(1, Number(existing.repeat_count || existing.run_count || 1)),
            run_count: Math.max(1, Number(existing.repeat_count || existing.run_count || 1)),
          };
        })
        .sort((left, right) => Number(left.diamond_count || 0) - Number(right.diamond_count || 0));

      let nextImages = giftData.map((item) => {
        let id = String(item.gift_id);
        let existing = imageMap.get(id) || {};
        return {
          id: item.gift_id,
          name: item.name,
          image: item.image ?? existing.image ?? "",
        };
      });

      let removedGiftCount = currentGifts.filter((gift) => !apiGiftIds.has(String(gift.id))).length;
      let removedImageCount = currentImages.filter(
        (image) => !apiGiftIds.has(String(image.id)),
      ).length;

      this.writeJSON(this.giftsPath, nextGifts);
      this.writeJSON(this.giftImgPath, nextImages);

      this.emitUpdate("gifts", {
        source: "update-gifts",
        gifts: nextGifts,
      });

      return res.json({
        status: "success",
        message: `Gifts updated successfully. ${addedGiftCount} gifts added,  ${removedGiftCount} gifts removed, ${removedImageCount} images removed.`,
        new_gifts: nextGifts,
      });
    });

    router.post("/handle-saweria-config", (req, res) => {
      let saweria = this.readJSON(this.saweriaPath, []);
      if (!Array.isArray(saweria)) {
        saweria = [];
      }

      let effectList = this.getEffectsList();
      let effectId = String(req.body["run-effect"] || "").trim();
      let price = parseInt(req.body["money-amount"], 10);

      if (Number.isNaN(price)) {
        return res.status(400).json({ status: "error", message: "Invalid money amount" });
      }

      let entry = saweria.find((item) => Number(item.price) === price);
      if (!entry) {
        entry = {
          price,
          run_effect: "",
          effect_id: "",
        };
        saweria.push(entry);
      }

      if (effectId === "disable" || effectId === "") {
        entry.run_effect = "";
        entry.effect_id = "";
      } else if (effectId === "none" || effectId === "no_effect") {
        entry.run_effect = "none";
        entry.effect_id = "none";
      } else if (effectId === "random") {
        entry.run_effect = "random";
        entry.effect_id = "random";
      } else if (effectId === "spinwheel" || effectId === "wheel") {
        entry.run_effect = "spinwheel";
        entry.effect_id = "spinwheel";
      } else {
        let selectedEffect = this.findEffectById(effectList, effectId);
        if (!selectedEffect) {
          return res.status(400).json({ status: "error", message: "Effect not found" });
        }

        if (!selectedEffect.description) {
          return res.status(400).json({ status: "error", message: "Description Problem!!" });
        }

        entry.run_effect = selectedEffect.description;
        entry.effect_id = selectedEffect.id;
      }

      this.writeJSON(this.saweriaPath, saweria);
      this.emitUpdate("saweria", {
        source: "handle-saweria-config",
        saweria,
      });

      return res.json({ status: "success" });
    });

    router.get("/saweria-config-effect", (req, res) => {
      let saweria = this.readJSON(this.saweriaPath, []);
      if (!Array.isArray(saweria)) {
        saweria = [];
      }

      return res.json(saweria);
    });

    router.get("/get-saweria-effect", (req, res) => {
      let saweria = this.readJSON(this.saweriaPath, []);
      if (!Array.isArray(saweria)) {
        saweria = [];
      }

      let price = parseInt(req.query.price, 10);
      if (Number.isNaN(price)) {
        return res.status(400).json({ status: "error", message: "Invalid money amount" });
      }

      let found = saweria.find((item) => Number(item.price) === price);
      return res.json(found || { price, run_effect: "" });
    });

    return router;
  }

  buildEndpointList() {
    return [
      "/config/getconfig",
      "/config/product",
      "/config/gifts",
      "/config/effects",
      "/config/check-audio-path",
      "/config/get-audio-effect",
      "/config/goal-config-effect",
      "/config/spinnwheel-effects",
      "/config/spinwheel-effects",
      "/config/spinwheel/spin",
      "/config/spinwheel/execute",
      "/config/get-saweria-effect",
      "/config/handle-general-config",
      "/config/handle-tiktok-config",
      "/config/tiktok/capture-cookies",
      "/config/set-game-mode",
      "/config/handle-gift-config",
      "/config/handle-goal-config",
      "/config/handle-spinwheel-config",
      "/config/handle-saweria-config",
      "/config/update-gifts",
      "/config/update-effects",
      "/config/events",
      "/config/sync-status",
      "/config/indofinity/status",
      "/config/indofinity/launch",
      "/config/tiktok-vote/status",
      "/config/vote-config",
      "/config/get-vote-config",
      "/config/handle-vote-config",
      "/config/vote/reset",
      "/config/vote/start",
      "/config/execute-effect",
      "/config/heartbeat",
      "/config/immune/status",
      "/config/immune/trigger",
      "/config/immune/cancel",
    ];
  }

  setupEventStream(req, res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    res.write("retry: 5000\n\n");
    this.eventClients.add(res);

    this.writeEvent(res, "bridge-ready", {
      status: "success",
      product: this.getProductCode(),
      sync: this.lastSyncMeta,
      timestamp: new Date().toISOString(),
    });

    let keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (error) {
        clearInterval(keepAlive);
        this.eventClients.delete(res);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      this.eventClients.delete(res);
    });
  }

  writeEvent(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcastEvent(eventName, payload) {
    let deadClients = [];
    this.eventClients.forEach((client) => {
      try {
        this.writeEvent(client, eventName, payload);
      } catch (error) {
        deadClients.push(client);
      }
    });

    deadClients.forEach((client) => {
      this.eventClients.delete(client);
    });
  }

  emitUpdate(type, payload = {}) {
    let callback = this.updateCallbacks[type];
    if (typeof callback === "function") {
      try {
        callback(payload);
      } catch (error) {
        console.log(`[LocalConfig] Callback error on ${type}:`, error.message);
      }
    }

    this.broadcastEvent(`${type}-changed`, {
      type,
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }

  triggerSpinwheel(options = {}) {
    if (global.isImmuneActive && global.isImmuneActive()) {
      let remSec = Math.ceil((global.getImmuneRemainingMs ? global.getImmuneRemainingMs() : 0) / 1000);
      console.log(`[IMMUNE BLOCKED] Spin Wheel dibatalkan karena mode Immune sedang aktif (${remSec}s tersisa).`);
      return { error: `Mode Immune sedang aktif (${remSec}s tersisa). Spin Wheel diblokir.` };
    }

    let spinwheel = this.readJSON(this.spinwheelPath, { effects: [], settings: {} });
    let effects = Array.isArray(spinwheel?.effects) ? spinwheel.effects : [];
    if (effects.length < 2) {
      console.warn("[Spinwheel] Need at least 2 effects to spin the wheel");
      return { error: "Dibutuhkan minimal 2 efek pada roda untuk memutar." };
    }

    let settings = {
      ...DEFAULT_SPINWHEEL_SETTINGS,
      ...(spinwheel.settings || {}),
    };

    let targetIndex =
      Number.isInteger(options.forceTargetIndex) &&
      options.forceTargetIndex >= 0 &&
      options.forceTargetIndex < effects.length
        ? options.forceTargetIndex
        : randomNess(0, effects.length - 1);

    let winner = effects[targetIndex];
    let spinId = `spin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    let user = {
      username: String(options.username || options.user || "Streamer").trim(),
      nickname: String(options.nickname || options.name || options.username || "Streamer").trim(),
      giftName: String(options.giftName || options.gift || "").trim(),
      amount: options.amount || "",
      source: String(options.source || "manual").trim(),
    };

    let spinPayload = {
      spinId,
      effects,
      targetIndex,
      winner,
      user,
      settings,
      timestamp: Date.now(),
    };

    if (this.isSpinning) {
      this.spinQueue.push({ spinPayload, winner, user, settings });
      console.log(`[Spinwheel] Spin queued for ${user.nickname}! Queue position: #${this.spinQueue.length}`);
      return {
        spinId,
        queued: true,
        position: this.spinQueue.length,
        targetIndex,
        winner,
        user,
        settings,
      };
    }

    this._dispatchSpin(spinPayload, winner, user, settings);
    return {
      spinId,
      targetIndex,
      winner,
      user,
      settings,
    };
  }

  _dispatchSpin(spinPayload, winner, user, settings) {
    this.isSpinning = true;
    let spinId = spinPayload.spinId;

    // Store in pendingSpins map
    this.pendingSpins.set(spinId, {
      spinPayload,
      executed: false,
      timeout: null,
    });

    // Broadcast SSE event to OBS overlay
    this.broadcastEvent("spinwheel-spin", spinPayload);

    // Fallback timer: if overlay doesn't confirm execution within spinDuration + 2500ms, execute automatically!
    let delayMs = (settings.spinDuration || 7) * 1000 + 2500;
    let fallbackTimer = setTimeout(() => {
      this.confirmSpinwheelExecution(spinId, winner.id, user, true);
    }, delayMs);

    let pendingRecord = this.pendingSpins.get(spinId);
    if (pendingRecord) {
      pendingRecord.timeout = fallbackTimer;
    }

    console.log(`[Spinwheel] Spin triggered! Winner: ${winner.name} (#${spinPayload.targetIndex + 1}) by ${user.nickname}`);
  }

  confirmSpinwheelExecution(spinId, effectId, user = {}, isFallback = false) {
    let pending = spinId ? this.pendingSpins.get(spinId) : null;
    if (!pending) {
      if (effectId) {
        let effectList = this.getEffectsList();
        let effect = this.findEffectById(effectList, effectId);
        if (effect && typeof this.updateCallbacks.executeEffect === "function") {
          this.updateCallbacks.executeEffect(effect, user);
          return { status: "success", executed: true, effect };
        }
      }
      return { status: "ignored", message: "Spin not found or already executed" };
    }

    if (pending.executed) {
      return { status: "already_executed", spinId };
    }

    pending.executed = true;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }

    let winnerEffect = pending.spinPayload.winner;
    let effectList = this.getEffectsList();
    let matchedEffect = this.findEffectById(effectList, winnerEffect.id) || winnerEffect;

    console.log(`[Spinwheel] Executing winner effect to game: ${matchedEffect.name} (Source: ${isFallback ? "Fallback Timeout" : "Overlay Callback"})`);
    if (typeof this.updateCallbacks.executeEffect === "function") {
      this.updateCallbacks.executeEffect(matchedEffect, pending.spinPayload.user || user);
    }

    let winnerDurationMs = Math.max(1000, Number(pending.spinPayload?.settings?.winnerDuration || 5) * 1000);
    setTimeout(() => {
      this.isSpinning = false;
      if (this.spinQueue.length > 0) {
        let next = this.spinQueue.shift();
        this._dispatchSpin(next.spinPayload, next.winner, next.user, next.settings);
      }
    }, winnerDurationMs);

    // Clean up after 30 seconds
    setTimeout(() => {
      this.pendingSpins.delete(spinId);
    }, 30000);

    return {
      status: "success",
      executed: true,
      effect: matchedEffect,
    };
  }

  async startGithubSyncLoop() {
    await this.syncEffectsFromGithub("startup");

    this.syncTimer = setInterval(() => {
      this.syncEffectsFromGithub("interval");
    }, this.githubSyncIntervalMs);

    if (typeof this.syncTimer.unref === "function") {
      this.syncTimer.unref();
    }
  }

  stopGithubSyncLoop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  stop() {
    this.stopGithubSyncLoop();
    if (this.server) {
      this.server.close();
    }
  }

  // Solusi 2: Modifikasi method sync dengan validasi Caching ETag (If-None-Match)
  async syncEffectsFromGithub(reason = "interval") {
    let config = this.getConfig();
    let productKey = this.resolveProductKey(config);
    let effectUrl = resolveProductEffectUrl(productKey);

    if (!effectUrl) {
      this.lastSyncMeta = {
        status: "skipped",
        source: "local",
        updatedAt: new Date().toISOString(),
        productKey,
        url: "",
        message: "No GitHub URL configured for current product",
      };
      return {
        status: "skipped",
        changed: false,
        message: this.lastSyncMeta.message,
      };
    }

    // Ambil cache lokal per-product (jika ada)
    let cachedMetaData = this.readJSON(this.effectsCachePath, {});
    let productCache =
      cachedMetaData.products?.[productKey] ||
      (cachedMetaData.productKey === productKey ? cachedMetaData : null);
    let oldEtag = productCache?.etag || "";

    try {
      // Kirim header If-None-Match ke GitHub Raw
      let response = await axios.get(effectUrl, {
        timeout: 15000,
        headers: oldEtag ? { "If-None-Match": oldEtag } : {}
      });

      // Jika kode eksekusi sampai di sini, artinya status HTTP = 200 OK (Ada perubahan di repo GitHub)
      let newEtag = response.headers["etag"] || "";
      let remoteEffects = this.normalizeEffectsPayload(response.data);
      let localEffects = this.readEffects();
      let mergedEffects = this.mergeEffectData(localEffects, remoteEffects);

      let changed = JSON.stringify(localEffects) !== JSON.stringify(mergedEffects);
      if (changed) {
        this.writeJSON(this.effectsPath, mergedEffects);
      }

      // Simpan data berserta ETag barunya ke cache lokal (per-product)
      if (!cachedMetaData.products) {
        cachedMetaData.products = {};
      }
      cachedMetaData.products[productKey] = {
        updatedAt: new Date().toISOString(),
        productKey,
        url: effectUrl,
        etag: newEtag,
        data: mergedEffects,
      };
      cachedMetaData.updatedAt = new Date().toISOString();
      cachedMetaData.productKey = productKey;
      cachedMetaData.url = effectUrl;
      cachedMetaData.etag = newEtag;
      cachedMetaData.data = mergedEffects;
      this.writeJSON(this.effectsCachePath, cachedMetaData);

      let reconcileResult = this.reconcileWithEffects(mergedEffects);

      this.lastSyncMeta = {
        status: "success",
        source: "github",
        updatedAt: new Date().toISOString(),
        productKey,
        url: effectUrl,
        message: changed
          ? "Effect list synchronized from GitHub"
          : "Effect list already up to date",
      };

      if (changed || reconcileResult.changedSections.length > 0) {
        this.emitUpdate("effects", {
          source: "github",
          reason,
          effects: mergedEffects,
          sync: this.lastSyncMeta,
          reconcile: reconcileResult,
        });
      }

      return {
        status: "success",
        changed,
        reconcile: reconcileResult,
        sync: this.lastSyncMeta,
      };
    } catch (error) {
      // Catch blok untuk menangani respons HTTP khusus dari Axios
      if (error.response && error.response.status === 304) {
        // Status 304 Not Modified berarti file di GitHub tidak berubah.
        // PENTING: Jika pengguna baru saja beralih produk, effects.json saat ini mungkin masih berisi efek produk sebelumnya!
        // Pastikan effects.json memuat efek dari productCache untuk productKey saat ini.
        let changed = false;
        let reconcileResult = { changedSections: [] };
        if (productCache?.data) {
          try {
            let cachedProductEffects = this.normalizeEffectsPayload(productCache.data);
            let currentEffects = this.readEffects();
            if (JSON.stringify(currentEffects) !== JSON.stringify(cachedProductEffects)) {
              this.writeJSON(this.effectsPath, cachedProductEffects);
              reconcileResult = this.reconcileWithEffects(cachedProductEffects);
              changed = true;
            }
          } catch (e) {
            console.warn("[LocalConfig] Failed restoring cached product effects on 304:", e.message);
          }
        }

        this.lastSyncMeta = {
          status: "success",
          source: "github",
          updatedAt: new Date().toISOString(),
          productKey,
          url: effectUrl,
          message: "Effect list up to date (cached via 304 Not Modified)",
        };

        if (changed || reconcileResult.changedSections.length > 0) {
          this.emitUpdate("effects", {
            source: "github-cache",
            reason,
            effects: this.readEffects(),
            sync: this.lastSyncMeta,
            reconcile: reconcileResult,
          });
        }

        return {
          status: "success",
          changed,
          reconcile: reconcileResult,
          sync: this.lastSyncMeta,
        };
      }

      // Handle khusus jika terkena limit (429) atau error jaringan agar tidak crash
      // Coba pulihkan dari cache produk ini jika ada
      let changed = false;
      let reconcileResult = { changedSections: [] };
      if (productCache?.data) {
        try {
          let cachedProductEffects = this.normalizeEffectsPayload(productCache.data);
          let currentEffects = this.readEffects();
          if (JSON.stringify(currentEffects) !== JSON.stringify(cachedProductEffects)) {
            this.writeJSON(this.effectsPath, cachedProductEffects);
            reconcileResult = this.reconcileWithEffects(cachedProductEffects);
            changed = true;
          }
        } catch (e) {}
      }

      let currentActiveEffects = this.readEffects();
      let hasCachedEffects = Array.isArray(currentActiveEffects.Function) && currentActiveEffects.Function.length > 0;

      this.lastSyncMeta = {
        status: hasCachedEffects ? "cached" : "error",
        source: "device_cache",
        updatedAt: productCache?.updatedAt || cachedMetaData.updatedAt || new Date().toISOString(),
        productKey,
        url: effectUrl,
        message: hasCachedEffects
          ? `GitHub offline/down (${error.message}). Menggunakan cache lokal device (${currentActiveEffects.Function.length} efek).`
          : `Gagal sinkronisasi dari GitHub: ${error.message}`,
      };

      console.log(`[LocalConfig] GitHub sync notice: ${this.lastSyncMeta.message}`);

      if (changed || reconcileResult.changedSections.length > 0) {
        this.emitUpdate("effects", {
          source: "device_cache",
          reason,
          effects: currentActiveEffects,
          sync: this.lastSyncMeta,
          reconcile: reconcileResult,
        });
      }

      return {
        status: hasCachedEffects ? "cached" : "error",
        changed,
        source: "device_cache",
        message: this.lastSyncMeta.message,
        sync: this.lastSyncMeta,
      };
    }
  }

  mergeEffectData(localEffects, remoteEffects) {
    let merged = {
      ...(localEffects && typeof localEffects === "object" && !Array.isArray(localEffects)
        ? localEffects
        : {}),
    };

    Object.keys(remoteEffects).forEach((key) => {
      merged[key] = remoteEffects[key];
    });

    if (!Array.isArray(merged.Function)) {
      merged.Function = [];
    }

    return merged;
  }

  normalizeEffectsPayload(payload) {
    if (Array.isArray(payload)) {
      return { Function: payload };
    }

    if (payload && typeof payload === "object") {
      if (Array.isArray(payload.Function)) {
        return payload;
      }

      if (Array.isArray(payload.effects)) {
        return {
          ...payload,
          Function: payload.effects,
        };
      }
    }

    throw new Error("Invalid effect payload from source");
  }

  reconcileWithEffects(effectsPayload) {
    let changedSections = [];
    let effectList = Array.isArray(effectsPayload?.Function) ? effectsPayload.Function : [];

    // SAFEGUARD: Jangan pernah reconcile jika list efek kosong (misal saat GitHub down)
    // agar konfigurasi gift, goal, saweria, dan spinwheel pengguna TIDAK TERHAPUS.
    if (effectList.length === 0) {
      console.log("[LocalConfig] Reconcile dilewati karena daftar efek kosong (melindungi konfigurasi pengguna).");
      return {
        changedSections: [],
      };
    }

    let effectById = new Map();
    let effectDescriptionSet = new Set();

    effectList.forEach((effect) => {
      if (!effect || typeof effect !== "object") {
        return;
      }

      let id = String(effect.id || "").trim();
      if (id !== "") {
        effectById.set(id.toLowerCase(), effect);
      }

      let description = String(effect.description || "").trim();
      if (description !== "") {
        effectDescriptionSet.add(description.toLowerCase());
      }
    });

    let gifts = this.readJSON(this.giftsPath, []);
    if (Array.isArray(gifts)) {
      let giftsChanged = false;
      gifts.forEach((gift) => {
        let runEffect = String(gift.run_effect || "").trim();
        if (
          runEffect !== "" &&
          !this.isSpecialRunEffect(runEffect) &&
          !effectDescriptionSet.has(runEffect.toLowerCase())
        ) {
          gift.run_effect = "";
          giftsChanged = true;
        }

        let normalizedCombo = this.normalizeComboList(gift.run_combo);
        let filteredCombo = normalizedCombo.filter((comboId) =>
          effectById.has(comboId.toLowerCase()),
        );
        if (
          JSON.stringify(normalizedCombo) !== JSON.stringify(filteredCombo) ||
          !Array.isArray(gift.run_combo)
        ) {
          gift.run_combo = filteredCombo;
          giftsChanged = true;
        }
      });

      if (giftsChanged) {
        this.writeJSON(this.giftsPath, gifts);
        changedSections.push("gifts");
        this.emitUpdate("gifts", {
          source: "effects-reconcile",
          gifts,
        });
      }
    }

    let goalRaw = this.normalizeGoalConfig(
      this.readJSON(this.goalPath, { goals: [], id: "", effect: "" }),
    );
    let nextGoals = [];
    let usedGoalKeys = new Set();

    goalRaw.goals.forEach((goal, index) => {
      let goalEffect = effectById.get(
        String(goal.id || "")
          .trim()
          .toLowerCase(),
      );
      if (!goalEffect) {
        return;
      }

      let goalName = String(goal.name || "").trim() || `Goal ${nextGoals.length + 1}`;
      let keyBase = this.toGoalKey(goal.key || goalName, nextGoals.length + 1);
      let key = keyBase;
      let suffix = 2;

      while (usedGoalKeys.has(key)) {
        key = `${keyBase}-${suffix}`;
        suffix++;
      }

      usedGoalKeys.add(key);
      nextGoals.push({
        name: goalName,
        key,
        id: String(goalEffect.id),
        effect: String(goalEffect.name || ""),
      });
    });

    let nextGoalConfig = this.normalizeGoalConfig({ goals: nextGoals });
    if (JSON.stringify(goalRaw) !== JSON.stringify(nextGoalConfig)) {
      this.writeJSON(this.goalPath, nextGoalConfig);
      changedSections.push("goal");
      this.emitUpdate("goal", {
        source: "effects-reconcile",
        goal: nextGoalConfig,
      });
    }

    let saweria = this.readJSON(this.saweriaPath, []);
    if (Array.isArray(saweria)) {
      let saweriaChanged = false;
      saweria.forEach((entry) => {
        let effectId = String(entry.effect_id || "").trim();
        if (effectId === "") {
          return;
        }

        if (!effectById.has(effectId.toLowerCase()) && !this.isSpecialRunEffect(effectId)) {
          entry.effect_id = "";
          entry.run_effect = "";
          saweriaChanged = true;
        }
      });

      if (saweriaChanged) {
        this.writeJSON(this.saweriaPath, saweria);
        changedSections.push("saweria");
        this.emitUpdate("saweria", {
          source: "effects-reconcile",
          saweria,
        });
      }
    }

    let spinwheel = this.readJSON(this.spinwheelPath, { effects: [] });
    if (spinwheel && typeof spinwheel === "object") {
      let currentEffects = Array.isArray(spinwheel.effects) ? spinwheel.effects : [];
      let nextSpinwheelEffects = currentEffects
        .map((item) => {
          let selectedEffect = effectById.get(
            String(item?.id || "")
              .trim()
              .toLowerCase(),
          );
          if (!selectedEffect) {
            return null;
          }

          return {
            id: String(selectedEffect.id),
            name: String(selectedEffect.name || ""),
          };
        })
        .filter((item) => item != null);

      if (JSON.stringify(currentEffects) !== JSON.stringify(nextSpinwheelEffects)) {
        let nextSpinwheel = { effects: nextSpinwheelEffects };
        this.writeJSON(this.spinwheelPath, nextSpinwheel);
        changedSections.push("spinwheel");
        this.emitUpdate("spinwheel", {
          source: "effects-reconcile",
          spinwheel: nextSpinwheel,
        });
      }
    }

    return {
      changedSections,
    };
  }

  resolveProductKey(config) {
    let currentConfig = config || this.getConfig();
    let candidates = [
      currentConfig?.General?.Product,
      currentConfig?.General?.product,
      this.productCode,
      currentConfig?.General?.Mode,
      currentConfig?.General?.Variant,
      currentConfig?.product,
      currentConfig?.mode,
      currentConfig?.variant,
    ];

    for (let i = 0; i < candidates.length; i++) {
      let key = normalizeProductKey(candidates[i]);
      if (key !== PRODUCT_KEYS.UNKNOWN) {
        this.productCode = key;
        return key;
      }
    }

    let fallback = normalizeProductKey(this.productCode);
    let resolved = fallback !== PRODUCT_KEYS.UNKNOWN ? fallback : PRODUCT_KEYS.DE;
    this.productCode = resolved;
    return resolved;
  }

  getProductCode() {
    let config = this.getConfig();
    let key = this.resolveProductKey(config);
    if (key === PRODUCT_KEYS.UNKNOWN) {
      return PRODUCT_KEYS.DE;
    }

    return key;
  }

  ensureConfigShape(config) {
    let changed = false;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      config = {};
      changed = true;
    }

    if (!config.General || typeof config.General !== "object" || Array.isArray(config.General)) {
      config.General = {};
      changed = true;
    }

    Object.keys(DEFAULT_P2P_GENERAL_SETTINGS).forEach((key) => {
      if (config.General[key] === undefined) {
        config.General[key] = DEFAULT_P2P_GENERAL_SETTINGS[key];
        changed = true;
      }
    });

    if (
      !config.RapidFire ||
      typeof config.RapidFire !== "object" ||
      Array.isArray(config.RapidFire)
    ) {
      config.RapidFire = {};
      changed = true;
    }

    if (!config.Tiktok || typeof config.Tiktok !== "object" || Array.isArray(config.Tiktok)) {
      config.Tiktok = {};
      changed = true;
    }

    if (config.Tiktok.Provider === undefined) {
      config.Tiktok.Provider = TIKTOK_PROVIDERS.INDOFINITY;
      changed = true;
    }
    if (config.General.TiktokProvider === undefined) {
      config.General.TiktokProvider = config.Tiktok.Provider || TIKTOK_PROVIDERS.INDOFINITY;
      changed = true;
    }

    if (config.Tiktok.TiktokTtTargetIdc === undefined) {
      config.Tiktok.TiktokTtTargetIdc = "";
      changed = true;
    }
    if (config.Tiktok.TiktokSignApiKey === undefined) {
      config.Tiktok.TiktokSignApiKey = "";
      changed = true;
    }
    if (config.Tiktok.TiktokAuthenticateWs === undefined) {
      config.Tiktok.TiktokAuthenticateWs = true;
      changed = true;
    }

    if (
      !config.EffectForceEffect ||
      typeof config.EffectForceEffect !== "object" ||
      Array.isArray(config.EffectForceEffect)
    ) {
      config.EffectForceEffect = {};
      changed = true;
    }

    if (
      !config.EffectForceCategory ||
      typeof config.EffectForceCategory !== "object" ||
      Array.isArray(config.EffectForceCategory)
    ) {
      config.EffectForceCategory = {};
      changed = true;
    }

    if (
      !config.EffectDurations ||
      typeof config.EffectDurations !== "object" ||
      Array.isArray(config.EffectDurations)
    ) {
      config.EffectDurations = {};
      changed = true;
    }

    if (
      !config.ComboEffect ||
      typeof config.ComboEffect !== "object" ||
      Array.isArray(config.ComboEffect)
    ) {
      config.ComboEffect = {};
      changed = true;
    }

    Object.keys(DEFAULT_COMBO_CONFIG).forEach((key) => {
      if (config.ComboEffect[key] == undefined) {
        config.ComboEffect[key] = DEFAULT_COMBO_CONFIG[key];
        changed = true;
      }
    });

    let betaEnabled = config.ComboEffect.BetaEnabled;
    if (typeof betaEnabled !== "boolean") {
      config.ComboEffect.BetaEnabled = String(betaEnabled).toLowerCase() === "true";
      changed = true;
    }

    let chainDelayMs = ensureNumber(
      config.ComboEffect.ChainDelayMs,
      DEFAULT_COMBO_CONFIG.ChainDelayMs,
    );
    if (chainDelayMs !== config.ComboEffect.ChainDelayMs) {
      config.ComboEffect.ChainDelayMs = chainDelayMs;
      changed = true;
    }

    let maxComboLength = ensureNumber(
      config.ComboEffect.MaxComboLength,
      DEFAULT_COMBO_CONFIG.MaxComboLength,
    );
    if (maxComboLength !== config.ComboEffect.MaxComboLength) {
      config.ComboEffect.MaxComboLength = maxComboLength;
      changed = true;
    }

    let deduplicateMs = ensureNumber(
      config.ComboEffect.DeduplicateMs,
      DEFAULT_COMBO_CONFIG.DeduplicateMs,
    );
    if (deduplicateMs !== config.ComboEffect.DeduplicateMs) {
      config.ComboEffect.DeduplicateMs = deduplicateMs;
      changed = true;
    }

    return changed;
  }

  getConfig() {
    let fallback = this.readJSON(this.configExamplePath, {});
    let config = this.readJSON(this.configPath, fallback);
    if (typeof config !== "object" || config == null || Array.isArray(config)) {
      config = fallback;
    }

    if (this.ensureConfigShape(config)) {
      this.writeJSON(this.configPath, config);
    }

    return config;
  }

  readEffects() {
    let effects = this.readJSON(this.effectsPath, { Function: [] });
    if (!effects || typeof effects !== "object" || Array.isArray(effects)) {
      effects = { Function: [] };
    }

    if (!Array.isArray(effects.Function)) {
      effects.Function = [];
    }

    // Jika effects.json kosong, coba pulihkan dari effects.cache.json
    if (effects.Function.length === 0 && existsSync(this.effectsCachePath)) {
      try {
        let cached = this.readJSON(this.effectsCachePath, {});
        let currentProduct = this.getProductCode();
        let productCache =
          cached?.products?.[currentProduct] ||
          (cached?.productKey === currentProduct ? cached : null);
        let cachedFunctions = productCache?.data?.Function || cached?.data?.Function || cached?.Function;
        if (Array.isArray(cachedFunctions) && cachedFunctions.length > 0) {
          effects = { Function: cachedFunctions };
          // Pulihkan kembali ke effects.json
          this.writeJSON(this.effectsPath, effects);
          console.log(`[LocalConfig] Memulihkan ${cachedFunctions.length} efek dari cache lokal (${this.effectsCachePath}).`);
        }
      } catch (err) {
        console.warn("[LocalConfig] Gagal memulihkan efek dari cache:", err.message);
      }
    }

    // Jika masih kosong, coba dari data bawaan aplikasi
    if (effects.Function.length === 0) {
      const bundledEffectsPath = path.join(process.cwd(), "data", "effects.json");
      const bundledCachePath = path.join(process.cwd(), "data", "effects.cache.json");
      if (existsSync(bundledEffectsPath)) {
        try {
          let bundled = this.readJSON(bundledEffectsPath, { Function: [] });
          if (Array.isArray(bundled?.Function) && bundled.Function.length > 0) {
            effects = bundled;
            this.writeJSON(this.effectsPath, effects);
            console.log(`[LocalConfig] Mengisi ${bundled.Function.length} efek dari bundle aplikasi.`);
          }
        } catch (e) {}
      } else if (existsSync(bundledCachePath)) {
        try {
          let bundledCache = this.readJSON(bundledCachePath, {});
          let bundledFunctions = bundledCache?.data?.Function || bundledCache?.Function;
          if (Array.isArray(bundledFunctions) && bundledFunctions.length > 0) {
            effects = { Function: bundledFunctions };
            this.writeJSON(this.effectsPath, effects);
            console.log(`[LocalConfig] Mengisi ${bundledFunctions.length} efek dari bundle cache aplikasi.`);
          }
        } catch (e) {}
      }
    }

    // Pastikan efek "Immune" selalu tersedia di daftar efek
    if (Array.isArray(effects.Function)) {
      const hasImmune = effects.Function.some(
        (e) => String(e?.id || "").toLowerCase() === "immune" || String(e?.name || "").toLowerCase() === "immune"
      );
      if (!hasImmune) {
        effects.Function.unshift({
          category: "Special",
          name: "Immune",
          description: "Immune",
          id: "immune",
          exclusive: false,
        });
      }
    }

    return effects;
  }

  getEffectsList() {
    let effects = this.readEffects();
    let list = Array.isArray(effects.Function) ? effects.Function : [];
    if (!list.some((e) => String(e?.id || "").toLowerCase() === "immune" || String(e?.name || "").toLowerCase() === "immune")) {
      list = [
        {
          category: "Special",
          name: "Immune",
          description: "Immune",
          id: "immune",
          exclusive: false,
        },
        ...list,
      ];
    }
    return list;
  }

  getGiftList(withImages = false) {
    let gifts = this.readJSON(this.giftsPath, []);
    let images = withImages ? this.readJSON(this.giftImgPath, []) : [];

    if (!Array.isArray(gifts)) {
      return [];
    }

    if (!Array.isArray(images)) {
      images = [];
    }

    return gifts.map((item) => {
      let gift = { ...item };
      gift.run_combo = this.normalizeComboList(gift.run_combo);
      gift.custom_label = String(gift.custom_label || "");

      if (withImages) {
        gift.images = images.find((img) => String(img.id) === String(gift.id));
      }

      return gift;
    });
  }

  getDefaultVoteConfig() {
    return {
      settings: {
        enabled: false,
        cooldown: 30000,
        chatVotePoints: 1,
        allowRepeatGifts: true,
        multiplyByStreak: true,
      },
      giftPoints: [
        {
          giftId: 5655,
          giftName: "Rose",
          target: "1",
          points: 5,
          multiplyByCount: true,
        },
        {
          giftId: 5333,
          giftName: "Coffee",
          target: "2",
          points: 5,
          multiplyByCount: true,
        },
        {
          giftId: 6064,
          giftName: "GG",
          target: "3",
          points: 5,
          multiplyByCount: true,
        },
      ],
    };
  }

  getVoteConfig() {
    let raw = this.readJSON(this.voteConfigPath, null);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.giftPoints)) {
      raw = this.getDefaultVoteConfig();
    }
    const general = this.getConfig();
    if (general?.Tiktok) {
      raw.settings = raw.settings || {};
      if (typeof general.Tiktok.TiktokVoteEnable !== "undefined") {
        raw.settings.enabled = Boolean(general.Tiktok.TiktokVoteEnable);
      }
      if (general.Tiktok.TiktokVoteCooldown) {
        raw.settings.cooldown = general.Tiktok.TiktokVoteCooldown;
      }
    }
    return raw;
  }

  findEffectById(effectList, effectId) {
    let lookup = String(effectId || "")
      .trim()
      .toLowerCase();
    if (lookup === "") {
      return null;
    }

    return (
      effectList.find(
        (item) =>
          String(item.id || "")
            .trim()
            .toLowerCase() === lookup,
      ) || null
    );
  }

  resolveEffectByInput(effectList, effectInput) {
    let lookup = String(effectInput || "")
      .trim()
      .toLowerCase();
    if (lookup === "") {
      return null;
    }

    return (
      effectList.find((item) => {
        return (
          String(item.id || "")
            .trim()
            .toLowerCase() === lookup ||
          String(item.description || "")
            .trim()
            .toLowerCase() === lookup ||
          String(item.name || "")
            .trim()
            .toLowerCase() === lookup
        );
      }) || null
    );
  }

  readJSON(filePath, fallbackValue) {
    if (!existsSync(filePath)) {
      return fallbackValue;
    }

    try {
      return readJson(filePath, fallbackValue);
    } catch (error) {
      return fallbackValue;
    }
  }

  writeJSON(filePath, value) {
    writeJson(filePath, value);
  }

  normalizePayload(value) {
    if (typeof value !== "string") {
      return value;
    }

    let trimmed = value.trim();
    if (trimmed === "") {
      return value;
    }

    if (trimmed === "true") {
      return true;
    }

    if (trimmed === "false") {
      return false;
    }

    if (trimmed === "null") {
      return null;
    }

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return value;
      }
    }

    return value;
  }

  normalizeComboList(value) {
    if (value == undefined || value == null) {
      return [];
    }

    let list = [];
    if (Array.isArray(value)) {
      list = value;
    } else {
      let raw = String(value || "").trim();
      if (raw === "") {
        return [];
      }

      if (
        (raw.startsWith("[") && raw.endsWith("]")) ||
        (raw.startsWith("{") && raw.endsWith("}"))
      ) {
        try {
          let parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            list = parsed;
          }
        } catch (error) {
          list = raw.split(/[,+|]/g);
        }
      } else {
        list = raw.split(/[,+|]/g);
      }
    }

    let unique = [];
    let used = new Set();

    list.forEach((item) => {
      let id = String(item || "").trim();
      if (id === "") {
        return;
      }

      let key = id.toLowerCase();
      if (used.has(key)) {
        return;
      }

      used.add(key);
      unique.push(id);
    });

    return unique;
  }

  isSpecialRunEffect(value) {
    let raw = String(value || "").trim();
    if (raw === "") {
      return false;
    }

    let lower = raw.toLowerCase();
    if (["random", "none", "no_effect", "spinwheel", "wheel"].includes(lower)) {
      return true;
    }

    let prefixes = [
      "spawn_vehicle",
      "spawnveh",
      "vehicle",
      "teleport",
      "tp",
      "tpto",
      "location",
    ];

    return prefixes.some((prefix) => {
      return lower === prefix || lower.startsWith(prefix + ":") || lower.startsWith(prefix + " ");
    });
  }

  deepMerge(target, source) {
    let output = { ...target };

    Object.keys(source).forEach((key) => {
      let sourceValue = this.normalizePayload(source[key]);
      let targetValue = output[key];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        output[key] = this.deepMerge(targetValue, sourceValue);
      } else {
        output[key] = sourceValue;
      }
    });

    return output;
  }

  setByPath(objectRef, pathKey, value) {
    let keys = String(pathKey)
      .split(".")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (keys.length === 0) {
      return;
    }

    let current = objectRef;
    for (let i = 0; i < keys.length - 1; i++) {
      let key = keys[i];
      if (
        current[key] == undefined ||
        typeof current[key] !== "object" ||
        current[key] == null ||
        Array.isArray(current[key])
      ) {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  findGift(gifts, source) {
    let payload = source || {};
    let giftId = payload.giftId ?? payload.gift_id ?? payload.id ?? payload.gift;
    let giftName = payload.giftName ?? payload.gift_name ?? payload.name;

    let gift = null;
    if (giftId != undefined && String(giftId).trim() !== "") {
      let lookupId = String(giftId).trim();
      gift = gifts.find((item) => String(item.id) === lookupId);
    }

    if (!gift && giftName != undefined && String(giftName).trim() !== "") {
      let lookupName = String(giftName).trim().toLowerCase();
      gift = gifts.find(
        (item) =>
          String(item.name || "")
            .trim()
            .toLowerCase() === lookupName,
      );
    }

    return gift;
  }

  toBoolean(value) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value.trim().toLowerCase() === "true";
    }
    return false;
  }

  toGoalKey(value, fallbackIndex = 1) {
    let normalized = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || `goal-${fallbackIndex}`;
  }

  normalizeGoalConfig(rawGoalConfig) {
    let rawGoals = [];

    if (rawGoalConfig && Array.isArray(rawGoalConfig.goals)) {
      rawGoals = rawGoalConfig.goals;
    } else if (rawGoalConfig && typeof rawGoalConfig === "object" && rawGoalConfig.id) {
      rawGoals = [
        {
          name: rawGoalConfig.name || "Goal 1",
          key: rawGoalConfig.key || "goal-1",
          id: rawGoalConfig.id,
          effect: rawGoalConfig.effect || "",
        },
      ];
    }

    let usedKeys = new Set();
    let normalizedGoals = rawGoals
      .filter((goal) => goal && typeof goal === "object")
      .map((goal, index) => {
        let name = String(goal.name || "").trim() || `Goal ${index + 1}`;
        let id = String(goal.id || goal.effect_id || "").trim();
        let effect = String(goal.effect || goal.run_effect || "").trim();

        if (id === "") {
          return null;
        }

        let keyBase = this.toGoalKey(goal.key || goal.slug || name, index + 1);
        let key = keyBase;
        let suffix = 2;
        while (usedKeys.has(key)) {
          key = `${keyBase}-${suffix}`;
          suffix++;
        }
        usedKeys.add(key);

        return { name, key, id, effect };
      })
      .filter((goal) => goal != null);

    return {
      goals: normalizedGoals,
      id: normalizedGoals[0] ? normalizedGoals[0].id : "",
      effect: normalizedGoals[0] ? normalizedGoals[0].effect : "",
    };
  }
}

export class LocalConfig extends LocalConfigHandler {
  constructor(options = {}) {
    super(options);
  }
}