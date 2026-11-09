import "./logger.js";
import http from "http";
import { WebSocketServer } from "ws";
import { Convert } from "./convert.js";
import { argv, exit } from "process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { xoroshiro128plus } from "pure-rand";
import { GenerateRandom, GenerateSeed, SendTheEffect } from "./random.js";

import { TikTok } from "./tiktok.js";
import { Goal } from "./goal.js";
import { LocalConfig } from "./local-config.js";
import { verifyTokenOwner } from "./indofinity.js";
import { startHeartbeat, getLatestHeartbeatData } from "./heartbeat.js";

import {
  sleep,
  findRunningProcess,
  SelectGTASA,
  killProcess,
  runProcessAndWaitToExit,
  findAvailablePort,
} from "./utils.js";

import { GeneralConfig, readJson, writeJson, readJsonText, APP_DATA_ROOT } from "./shared.js";
import { API } from "./api.js";
import { runVelopackUpdater, checkAndSyncAutoUpdaterExe, checkAndSyncModFiles, checkAndSyncDesktopApp } from "./updater.js";

let wsServer;


let g_sVersion = "SA CHAOS V1.6.2c";
let g_Version = -1;
let g_VersionString = "";

console.log("Welcome to " + g_sVersion + " by Athallah Dzaki");

let TiktokHandler, apiHandler, goalHandler, localConfigHandler;

let runtimeState = {
  effectDataBase: "",
  goalConfig: { goals: [], id: "", effect: "" },
};

const CONNECTOR_PORTS = [
  { name: "Classic", port: 42069 },
  { name: "Mountain", port: 34429 },
  { name: "Definitive Edition", port: 55992 }
];

class MultiWebSocketServer {
  constructor(portMappings) {
    this.servers = [];
    this.httpServers = [];
    
    // Add custom user port if it exists and is not already in the array
    let customPort = GeneralConfig?.General?.GUIWebsocketPort;
    if (customPort && !portMappings.find(m => m.port === customPort)) {
      portMappings.push({ name: "Custom (Config)", port: customPort });
    }

    portMappings.forEach(mapping => {
      try {
        const httpServer = http.createServer((req, res) => {
          if (req.url && req.url.startsWith("/credentials")) {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

            if (req.method === "OPTIONS") {
              res.writeHead(200);
              return res.end();
            }

            const currentLiveUser = global.currentLiveUser || global.TiktokHandler?.indofinityStatus?.uniqueId || "";
            const isLive = Boolean(global.isLive !== undefined ? global.isLive : global.TiktokHandler?.isLive);
            const tokenOwner = global.tokenOwner || global.gameClientOwner || GeneralConfig?.Tiktok?.owner || "";
            const verification = verifyTokenOwner(tokenOwner, currentLiveUser);

            let userToken = "";
            let gtaPath = GeneralConfig.General?.GTA_PATH || "";
            if (gtaPath && existsSync(path.join(gtaPath, "ChaosMod", "token.txt"))) {
              try {
                userToken = readFileSync(path.join(gtaPath, "ChaosMod", "token.txt"), "utf8").trim();
              } catch (e) {}
            }

            const payload = {
              type: "credentials",
              status: verification.match ? "success" : "error",
              matched: verification.match,
              owner: tokenOwner,
              currentLiveUser,
              live: isLive,
              token: userToken,
              message: verification.message,
              heartbeat: getLatestHeartbeatData()
            };

            res.writeHead(verification.match ? 200 : 403);
            return res.end(JSON.stringify(payload));
          }

          res.writeHead(404);
          res.end("Not Found");
        });

        httpServer.on("error", (e) => {
          // Silently handle port conflict or other bind errors
        });

        let server = new WebSocketServer({ server: httpServer });
        this.servers.push(server);
        this.httpServers.push(httpServer);

        httpServer.listen(mapping.port, () => {
          console.log(`[Connector Socket] Listening on port ${mapping.port} (${mapping.name})`);
        });
      } catch (e) {
        // Silently handle
      }
    });

    Object.defineProperty(this, 'clients', {
      get: function() {
        let allClients = new Set();
        this.servers.forEach(server => {
          if (server.clients) {
            server.clients.forEach(client => allClients.add(client));
          }
        });
        return allClients;
      }
    });
  }

  on(event, callback) {
    this.servers.forEach(server => server.on(event, callback));
  }
}

async function StartServer() {
  console.log("Starting Server...");
  wsServer = new MultiWebSocketServer(CONNECTOR_PORTS);
  global.wsServerInstance = wsServer;

  // Initialize the 30-second heartbeat to check IndoFinity / TikTok live status & owner
  startHeartbeat({ wsServer, intervalMs: 30000 });

  if (argv[2] == "--convert") {
    console.log("Converting...");
    let _convertData = await Convert(readFileSync(path.join(APP_DATA_ROOT, "effects.txt"), "utf8"));
    if (_convertData != "Error") {
      writeJson(path.join(APP_DATA_ROOT, "effects.json"), _convertData);
      console.log("Converted Successfully!");
    } else console.log("Failed to convert!");
    exit(); // Exit the process
  } else if (argv[2] == "--check") {
    let effect = readJson(path.join(APP_DATA_ROOT, "effects.json"), {})["Function"];
    console.log("Checking effects...");
    effect.forEach((element) => {
      if (typeof element.category == "undefined") {
        console.log("Error: Category is not defined! for " + element.name);
      }
      if (typeof element.name == "undefined") {
        console.log("Error: Effect is not defined! for " + element.name);
      }

      if (typeof element.description == "undefined") {
        console.log("Error: Description is not defined! for " + element.name);
      }

      if (typeof element.id == "undefined") {
        console.log("Error: ID is not defined! for " + element.name);
      }

      if (typeof element.exclusive == "undefined") {
        console.log("Error: Exclusive is not defined! for " + element.name);
      }

      console.log("Checked Successfully!");
      exit();
    });
  }

  if (GeneralConfig.General?.GTA_PATH == "" || GeneralConfig.General?.GTA_PATH == null) {
    let gtaPath = await SelectGTASA();
    if (gtaPath == "empty") {
      GeneralConfig.General.GTA_PATH = "empty";
    } else {
      if (gtaPath.toLowerCase().endsWith("sanandreas.exe")) {
        GeneralConfig.General.Product = "SA-CHAOS-DE";
      } else {
        GeneralConfig.General.Product = "SA-CHAOS-CLASSIC";
      }
      GeneralConfig.General.GTA_PATH = gtaPath.replace(/\\(gta_sa\.exe|SanAndreas\.exe)$/i, "");
    }
    writeJson(path.join(APP_DATA_ROOT, "config.json"), GeneralConfig);
    console.log("GTA SA Has Been set to: " + GeneralConfig.General.GTA_PATH);
  }

  if (GeneralConfig.General?.GTA_PATH && GeneralConfig.General.GTA_PATH !== "empty") {
    checkAndSyncAutoUpdaterExe(GeneralConfig.General.GTA_PATH).catch((err) => {
      console.error("[StartServer] AutoUpdater sync error:", err);
    });
    checkAndSyncModFiles(GeneralConfig.General.GTA_PATH).catch((err) => {
      console.error("[StartServer] Mod sync error:", err);
    });
  }

  // Backup sync check untuk aplikasi desktop (Direct S3 / Failsafe)
  checkAndSyncDesktopApp().catch((err) => {
    console.error("[StartServer] Desktop app sync error:", err);
  });

  runtimeState.effectDataBase = loadEffectDataBaseFromDisk();

  global.userSeed = GeneralConfig.General.Seed || GenerateSeed();
  global.rngInstance = xoroshiro128plus(global.userSeed);

  let remaining = GeneralConfig.General.Cooldown || 30000;

  ValidateConfig(GeneralConfig);
  if (GeneralConfig.Tiktok.TiktokEnable)
    if (GeneralConfig.Tiktok.TikfinityHTTPServer)
      apiHandler = new API(runtimeState.effectDataBase, wsServer);

//   let loading = ora("Waiting GTA SA to Start"),
//     loadingDone = false;
//   loading.spinner.interval = 100;
//   loading.start();

//   while (true) {
//     if (!findRunningProcess("gta_sa.exe")) {
//       await sleep(1000);
//       continue; // Skip the rest of the loop
//     }

//     if (loadingDone == false) {
//       loading.succeed("GTA SA Found!");
//       loadingDone = true;
//       break;
//     }
//   }

  wsServer.on("connection", (ws, req) => {
    let reqUrl = req ? (req.url || "") : "";
    console.log(`[Connector Socket] New connection from game client (${reqUrl})`);

    ws.send(
      JSON.stringify({
        type: "version",
      }),
    );

    // If connection URL contains credentials parameter (e.g. ws://localhost:42069/credentials?owner=...)
    if (reqUrl.includes("credentials")) {
      try {
        const parsedUrl = new URL(reqUrl, "http://localhost");
        const clientOwner = parsedUrl.searchParams.get("owner") || parsedUrl.searchParams.get("username") || "";
        if (clientOwner) {
          global.gameClientOwner = clientOwner;
          if (global.TiktokHandler) {
            global.TiktokHandler.setTokenOwner(clientOwner);
          }
        }

        const effectiveOwner = clientOwner || global.tokenOwner || global.gameClientOwner || GeneralConfig?.Tiktok?.owner || "";
        const currentLiveUser = global.currentLiveUser || global.TiktokHandler?.indofinityStatus?.uniqueId || "";
        const isLive = Boolean(global.isLive !== undefined ? global.isLive : global.TiktokHandler?.isLive);
        const verification = verifyTokenOwner(effectiveOwner, currentLiveUser);

        if (!verification.match && global.TiktokHandler) {
          global.TiktokHandler.setOwnerMismatch(true, verification.message);
        }

        ws.send(JSON.stringify({
          type: "credentials",
          status: verification.match ? "success" : "error",
          matched: verification.match,
          owner: effectiveOwner,
          currentLiveUser,
          live: isLive,
          message: verification.message,
          heartbeat: getLatestHeartbeatData()
        }));
      } catch (e) {
        // Silently ignore URL parsing errors
      }
    }

    ws.on("message", (message) => {
      let data = {};
      let isJson = false;
      try {
        data = JSON.parse(message);
        isJson = true;
      } catch (e) {
        data = {};
      }

      let msgStr = String(message).trim();

      // Check for /credentials parameter / message
      if (
        msgStr === "/credentials" ||
        msgStr.startsWith("/credentials ") ||
        data.type === "credentials" ||
        data.type === "/credentials" ||
        data.name === "credentials" ||
        data.name === "/credentials" ||
        data.path === "/credentials" ||
        data.credentials != undefined
      ) {
        const clientOwner = data.owner || data.username || data.uniqueId || (data.credentials && (data.credentials.owner || data.credentials.username)) || "";
        if (clientOwner) {
          global.gameClientOwner = clientOwner;
          if (global.TiktokHandler) {
            global.TiktokHandler.setTokenOwner(clientOwner);
          }
        }

        const effectiveOwner = clientOwner || global.tokenOwner || global.gameClientOwner || GeneralConfig?.Tiktok?.owner || "";
        const currentLiveUser = global.currentLiveUser || global.TiktokHandler?.indofinityStatus?.uniqueId || "";
        const isLive = Boolean(global.isLive !== undefined ? global.isLive : global.TiktokHandler?.isLive);
        const verification = verifyTokenOwner(effectiveOwner, currentLiveUser);

        console.log(`[Game Socket] /credentials processed: owner='${effectiveOwner}', liveUser='${currentLiveUser}', matched=${verification.match}`);

        if (!verification.match && global.TiktokHandler) {
          global.TiktokHandler.setOwnerMismatch(true, verification.message);
        }

        ws.send(JSON.stringify({
          type: "credentials",
          status: verification.match ? "success" : "error",
          matched: verification.match,
          owner: effectiveOwner,
          currentLiveUser,
          live: isLive,
          message: verification.message,
          heartbeat: getLatestHeartbeatData()
        }));
        return;
      }

      if (data.silentpatch == "true")
        console.log(
          "Silent Patch Detected, It's Mean Chaos time not same with Game Time. But, it's okay! Dont Delete Silent Patch!",
        );
      if (data.version != undefined) {
        g_VersionString = data.version;
        if (g_VersionString == g_sVersion) {
          g_Version = true;
        } else {
          g_Version = false;
        }
      } else if (data.name != undefined) {
        if (data.name == "effect") {
          let effect = JSON.parse(effectDataBase)["Function"].find((x) => x.id == data.data.id);
          if (effect == undefined) return; // How this possible?
          if (TiktokHandler && typeof TiktokHandler.sendEffectToClients === "function") {
            TiktokHandler.sendEffectToClients(effect);
          } else {
            wsServer.clients.forEach((clients) => {
              let data = SendTheEffect(effect, global.userSeed, global.rngInstance);
              clients.send(JSON.stringify(data));
            });
          }
        }
      }
    });
  });

//   setTimeout(() => {
//     if (g_Version == -1) {
//       console.log("Failed to check the version!");
//       console.log("Please check the client version!");
//       console.log("Client Version: " + g_VersionString);
//       console.log("Server Version: " + g_sVersion);
//       exit();
//     }
//   }, 60000);

//   let versionCheck = ora("Checking Version");
//   versionCheck.spinner.interval = 100;
//   versionCheck.start();

//   while (true) {
//     if (g_Version == -1) {
//       await sleep(1000);
//       continue;
//     }

//     if (g_Version == true) {
//       versionCheck.succeed("Version Matched!");
//       console.log("Client Version: " + g_VersionString);
//       console.log("Server Version: " + g_sVersion);
//       break;
//     } else {
//       versionCheck.fail("Version Mismatched!");
//       console.log("Please update the client or server!");
//       console.log("Client Version: " + g_VersionString);
//       console.log("Server Version: " + g_sVersion);
//       if (
//         GeneralConfig.General.GTA_PATH != "empty" &&
//         GeneralConfig.General.GTA_PATH != null &&
//         GeneralConfig.General.GTA_PATH != ""
//       ) {
//         await killProcess("gta_sa.exe");
//         let returnDir = process.cwd();
//         process.chdir(GeneralConfig.General.GTA_PATH);
//         await runProcessAndWaitToExit(GeneralConfig.General.GTA_PATH + "\\AutoUpdater.exe", () => {
//           process.chdir(returnDir);
//           StartServer();
//         });
//       } else {
//         console.log("Please update the client manually!");
//         exit();
//       }
//       return;
//     }
//   }

  setInterval(() => {
    if (!GeneralConfig?.General?.Seed) {
      global.userSeed = GenerateSeed();
      global.rngInstance = xoroshiro128plus(global.userSeed);
    }
  }, 1000); // Make Seed Random every 1 second if not explicitly configured

  runtimeState.goalConfig = loadGoalConfigFromDisk();

//   setInterval(() => {
//     console.log("Seed: " + global.userSeed);
//   }, 1000); // Print Seed every 10 seconds

  if (GeneralConfig.Tiktok.TiktokEnable) {
    if (GeneralConfig.Tiktok.TiktokForceEffect && GeneralConfig.Tiktok.TikfinityHTTPServer) {
      console.log(
        "Tiktok Force Effect and Tikfinity HTTP Server cannot be enabled at the same time!",
      );
      exit();
    }
    if (!GeneralConfig.Tiktok.TikfinityHTTPServer) {
      TiktokHandler = new TikTok(wsServer, runtimeState.effectDataBase);
      if (localConfigHandler && typeof TiktokHandler.setLocalConfigHandler === "function") {
        TiktokHandler.setLocalConfigHandler(localConfigHandler);
      }
    }
  }

  console.log("Server Started!");

  runtimeState.goalConfig = loadGoalConfigFromDisk();

  let hasGoalConfig = false;
  if (Array.isArray(runtimeState.goalConfig.goals)) {
    hasGoalConfig = runtimeState.goalConfig.goals.some((goal) => goal && goal.id);
  } else {
    hasGoalConfig = runtimeState.goalConfig.id != "";
  }

  if (hasGoalConfig) {
    goalHandler = new Goal(runtimeState.effectDataBase, wsServer, runtimeState.goalConfig);
  }

  if (!GeneralConfig.Tiktok.TikfinityHTTPServer) {
    // Remove this interval when use HTTPServer
    setInterval(async () => {
      let cooldown = GeneralConfig.General.Cooldown || 30000;
      if (remaining > cooldown) {
        remaining = cooldown;
      }

      if (GeneralConfig.Tiktok.TiktokEnable && !GeneralConfig.Tiktok.TiktokUseBuiltInChaos) {
        // If Tiktok is enabled and not using built-in chaos
        if (TiktokHandler) {
          TiktokHandler.HandleTheTimer();
        }
      } else {
        if (remaining <= 0) {
          remaining = cooldown;
          let effect = GenerateRandom(
            runtimeState.effectDataBase,
            global.rngInstance,
            GeneralConfig.EffectForceEffect.ForceSpecificEffect,
            GeneralConfig.EffectForceEffect.EffectName,
            GeneralConfig.EffectForceCategory.ForceSpecificCategory,
            GeneralConfig.EffectForceCategory.CategoryName,
          );
          if (TiktokHandler && typeof TiktokHandler.sendEffectToClients === "function") {
            TiktokHandler.sendEffectToClients(effect);
          } else {
            wsServer.clients.forEach((clients) => {
              let data = SendTheEffect(effect, global.userSeed, global.rngInstance);
              clients.send(JSON.stringify(data));
            });
          }
        } else {
          remaining -= 1000 / 24;
          wsServer.clients.forEach((clients) => {
            clients.send(
              JSON.stringify({
                type: "time",
                data: {
                  remaining: remaining,
                  cooldown: cooldown,
                  mode: "",
                },
              }),
            );
          });
        }
      }
    }, 1000 / 24);
  }
    let port = await setupLocalConfigBridge();
    
    // Velopack Auto-Updater & Desktop Backup Sync
    // Initial check is now handled in main/index.js with Splash Screen
    setInterval(() => {
      runVelopackUpdater(g_sVersion);
      checkAndSyncDesktopApp();
    }, 3600000); // Check every 1 hour

    return port;
}

export { StartServer };

function loadEffectDataBaseFromDisk() {
  return readJsonText(path.join(APP_DATA_ROOT, "effects.json"), JSON.stringify({ Function: [] }, null, 4));
}

function loadGoalConfigFromDisk() {
  try {
    let parsed = readJson(path.join(APP_DATA_ROOT, "gce.json"), {});
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    // Keep default below.
  }
  return { goals: [], id: "", effect: "" };
}

function deepReplaceInPlace(target, source) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return;
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }

  Object.keys(target).forEach((key) => {
    if (!(key in source)) {
      delete target[key];
    }
  });

  Object.keys(source).forEach((key) => {
    let sourceValue = source[key];
    let targetValue = target[key];

    if (Array.isArray(sourceValue)) {
      target[key] = sourceValue.map((item) => {
        if (item && typeof item === "object") {
          return JSON.parse(JSON.stringify(item));
        }
        return item;
      });
      return;
    }

    if (sourceValue && typeof sourceValue === "object") {
      if (!targetValue || typeof targetValue !== "object" || Array.isArray(targetValue)) {
        target[key] = {};
      }
      deepReplaceInPlace(target[key], sourceValue);
      return;
    }

    target[key] = sourceValue;
  });
}

function applyRuntimeConfig(nextConfig) {
  if (!nextConfig || typeof nextConfig !== "object" || Array.isArray(nextConfig)) {
    return;
  }

  deepReplaceInPlace(GeneralConfig, nextConfig);
  ValidateConfig(GeneralConfig);

  if (TiktokHandler && typeof TiktokHandler.reloadConfigFromGeneral === "function") {
    TiktokHandler.reloadConfigFromGeneral();
  }
}

function applyRuntimeEffects(nextEffects) {
  if (nextEffects && typeof nextEffects === "object" && !Array.isArray(nextEffects)) {
    runtimeState.effectDataBase = JSON.stringify(nextEffects, null, 4);
  } else {
    runtimeState.effectDataBase = loadEffectDataBaseFromDisk();
  }


  if (TiktokHandler && typeof TiktokHandler.updateEffectDataBase === "function") {
    TiktokHandler.updateEffectDataBase(runtimeState.effectDataBase);
  }

  if (goalHandler && typeof goalHandler.updateEffectDataBase === "function") {
    goalHandler.updateEffectDataBase(runtimeState.effectDataBase);
  }

  if (apiHandler && typeof apiHandler.updateEffectDataBase === "function") {
    apiHandler.updateEffectDataBase(runtimeState.effectDataBase);
  }
}

function applyRuntimeGoal(nextGoal) {
  if (nextGoal && typeof nextGoal === "object" && !Array.isArray(nextGoal)) {
    runtimeState.goalConfig = nextGoal;
  } else {
    runtimeState.goalConfig = loadGoalConfigFromDisk();
  }

  let hasGoalConfig = false;
  if (Array.isArray(runtimeState.goalConfig.goals)) {
    hasGoalConfig = runtimeState.goalConfig.goals.some((goal) => goal && goal.id);
  } else {
    hasGoalConfig = runtimeState.goalConfig.id != "";
  }

  if (!goalHandler && hasGoalConfig) {
    goalHandler = new Goal(runtimeState.effectDataBase, wsServer, runtimeState.goalConfig);
    return;
  }

  if (goalHandler && typeof goalHandler.updateGoalConfig === "function") {
    goalHandler.updateGoalConfig(runtimeState.goalConfig);
  }
}

async function setupLocalConfigBridge() {
  if (localConfigHandler) {
    return localConfigHandler.port;
  }

  const availablePort = await findAvailablePort(9001);

  localConfigHandler = new LocalConfig({
    version: g_sVersion,
    port: availablePort,
    productCode: GeneralConfig.General.Product || "SA-CHAOS-CLASSIC",
    rootPath: process.cwd(),
    serverVersion: "1.0.3",
    onConfigChanged: (payload) => {
      if (payload && payload.config) {
        applyRuntimeConfig(payload.config);
      }
    },
    onEffectsChanged: (payload) => {
      if (payload && payload.effects) {
        applyRuntimeEffects(payload.effects);
        return;
      }

      applyRuntimeEffects(null);
    },
    onGoalChanged: (payload) => {
      if (payload && payload.goal) {
        applyRuntimeGoal(payload.goal);
        return;
      }

      applyRuntimeGoal(null);
    },
    onExecuteEffect: (effect, senderInfo) => {
      if (TiktokHandler && typeof TiktokHandler.sendEffectToClients === "function") {
        TiktokHandler.sendEffectToClients({ ...effect, ...senderInfo });
      } else if (wsServer && wsServer.clients) {
        wsServer.clients.forEach((client) => {
          let data = SendTheEffect(effect, global.userSeed, global.rngInstance);
          client.send(JSON.stringify(data));
        });
      }
    },
  });

  global.localConfigHandler = localConfigHandler;
  if (TiktokHandler && typeof TiktokHandler.setLocalConfigHandler === "function") {
    TiktokHandler.setLocalConfigHandler(localConfigHandler);
  }

  return availablePort;
}

function ValidateConfig(config) {
  let isThisNumber = (value) => {
    return value instanceof Number || typeof value === "number";
  };

  if (!isThisNumber(config.General.GUIWebsocketPort)) {
    console.log("GUI Websocket Port is not a number!");
    console.log("Please reconfigure at the website!");
    exit();
  }

  if (!isThisNumber(config.General.Seed) && config.General.Seed != null) {
    console.log("Seed is not a number!");
    console.log("Please reconfigure at the website!");
    exit();
  }

  if (!isThisNumber(config.General.Cooldown)) {
    console.log("Cooldown is not a number!");
    console.log("Please reconfigure at the website!");
    exit();
  }

  if (!isThisNumber(config.General.EffectDuration)) {
    console.log("Effect Duration is not a number!");
    console.log("Please reconfigure at the website!");
    exit();
  }


  if (!isThisNumber(config.Tiktok.TiktokVoteCooldown)) {
    console.log("Tiktok Vote Cooldown is not a number!");
    console.log("Please reconfigure at the website!");
    exit();
  }

  config.General.Seed = null; // Force It To Be Null (For Now)
}
