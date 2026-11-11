import { WebSocket } from "ws";
import { exit } from "process";
import { TikTokLiveConnection } from "tiktok-live-connector";
import { SendTheEffect, GenerateRandom, vehicleName, randomNess } from "./random.js";
import { eVotingMode, ePickedVote, GeneralConfig, readJson, writeJson, APP_DATA_ROOT, OFFICIAL_USER_AGENT } from "./shared.js";
import fs from "fs";
import path from "path";
import axios from "axios";
import { fetchIndofinityStatus, verifyTokenOwner, normalizeUsername } from "./indofinity.js";
import { exclusiveManager } from "./exclusive.js";
import { initializeGlobalTikTokProviderManager } from "./tiktok-provider-manager.js";
import { TIKTOK_PROVIDERS } from "./tiktok-constants.js";
import { createCustomSignerApiClient } from "./custom-tiktok-connector.js";

let internal_Config = GeneralConfig.Tiktok;
export let TikTokGatewayStatus = "Disconnected";

// Global immune state accessible across server modules
global.immuneUntil = global.immuneUntil || 0;
global.immuneDuration = global.immuneDuration || 0;
global.immuneTimer = global.immuneTimer || null;
global.isImmuneActive = () => Date.now() < (global.immuneUntil || 0);
global.getImmuneRemainingMs = () => Math.max(0, (global.immuneUntil || 0) - Date.now());

class TikTokHandler {
    voteMode = eVotingMode.COOLDOWN;
    votePicked = ePickedVote.UNDETERMINED;
    votePicker = [0, 0, 0];
    votePickerUID = []; // From Chat (+1)
    votePickerExclusiveUID = []; // From Gift (+5)
    userVoteChoice = new Map(); // Tracks user chat vote choice
    voteConfig = null;
    voteCooldown = internal_Config.TiktokVoteCooldown;
    voteRemaining = internal_Config.TiktokVoteCooldown;
    voteEffect = [];
    voteMaxLength = 3;
    comboLastExecution = new Map();
    giftEffectQueue = [];
    giftQueueProcessing = false;
    giftQueueDelayMs = 250;
    lastTimerTick = Date.now();
    giftComboTracker = new Map();
    giftComboCleanupTimers = new Map();
    processedGiftMsgIds = new Map();
    _tikfinityReconnectTimer = null;
    effectTimestamps = new Map(); // Pelacak waktu terima data awal dari Tikfinity
    lastVoteSseBroadcast = 0;
    lastPickedEffectName = "";

    indofinityStatus = { uniqueId: "", live: false, loggedIn: false };
    isLive = false;
    tokenOwner = "";
    ownerMismatched = false;
    mismatchReason = "";
    indofinityPollTimer = null;

    tiktokLiveConn = null;

    constructor(
        wsServer,
        effectDataBase,
    ) {
        this.wsServer = wsServer;
        this.effectDataBase = effectDataBase;
        this.userSeed = global.userSeed;
        this.rngInstance = global.rngInstance;
        this.giftQueueDelayMs = this.getGiftQueueDelayMs();
        this.exclusiveManager = exclusiveManager;
        global.TiktokHandler = this;
        global.exclusiveManager = exclusiveManager;

        if (typeof internal_Config.TiktokUseIndofinity == "undefined") {
            internal_Config.TiktokUseIndofinity = false;
            writeJson(path.join(APP_DATA_ROOT, "config.json"), GeneralConfig);
        }

        this.tokenOwner = global.tokenOwner || global.gameClientOwner || internal_Config.owner || "";
        this.providerManager = initializeGlobalTikTokProviderManager(this);
        if (internal_Config.Provider === TIKTOK_PROVIDERS.CUSTOM_BETA) {
            this.providerManager.setProvider(TIKTOK_PROVIDERS.CUSTOM_BETA, { saveConfig: false });
        } else {
            this.startIndofinityPolling();
        }
    }

    reloadConfigFromGeneral() {
        internal_Config = GeneralConfig.Tiktok;
        this.voteCooldown = internal_Config.TiktokVoteCooldown;
        this.giftQueueDelayMs = this.getGiftQueueDelayMs();
        if (this.voteRemaining > this.voteCooldown) {
            this.voteRemaining = this.voteCooldown;
        }
        this.reloadVoteConfig();
        const activeProvider = internal_Config.Provider || GeneralConfig?.General?.TiktokProvider || TIKTOK_PROVIDERS.INDOFINITY;
        if (activeProvider === TIKTOK_PROVIDERS.CUSTOM_BETA) {
            if (this.indofinityPollTimer) {
                clearInterval(this.indofinityPollTimer);
                this.indofinityPollTimer = null;
            }
            if (this.providerManager && this.providerManager.getProvider() !== TIKTOK_PROVIDERS.CUSTOM_BETA) {
                this.providerManager.setProvider(TIKTOK_PROVIDERS.CUSTOM_BETA, { saveConfig: false });
            }
        } else {
            this.startIndofinityPolling();
            if (this.providerManager && this.providerManager.getProvider() !== TIKTOK_PROVIDERS.INDOFINITY) {
                this.providerManager.setProvider(TIKTOK_PROVIDERS.INDOFINITY, { saveConfig: false });
            }
        }
        this.SetupTiktok();
    }

    getVoteConfig() {
        if (this.voteConfig) return this.voteConfig;
        let voteConfig = null;
        try {
            voteConfig = readJson(path.join(APP_DATA_ROOT, "vote-config.json"), null);
        } catch (e) {
            voteConfig = null;
        }
        if (!voteConfig || !Array.isArray(voteConfig.giftPoints)) {
            voteConfig = {
                settings: {
                    enabled: Boolean(GeneralConfig.Tiktok?.TiktokVoteEnable),
                    cooldown: GeneralConfig.Tiktok?.TiktokVoteCooldown || 30000,
                    chatVotePoints: 1,
                    allowRepeatGifts: true,
                    multiplyByStreak: true,
                },
                giftPoints: [
                    { giftId: 5655, giftName: "Rose", target: "1", points: 5, multiplyByCount: true },
                    { giftId: 5333, giftName: "Coffee", target: "2", points: 5, multiplyByCount: true },
                    { giftId: 6064, giftName: "GG", target: "3", points: 5, multiplyByCount: true },
                ],
            };
        }
        this.voteConfig = voteConfig;
        return this.voteConfig;
    }

    reloadVoteConfig() {
        this.voteConfig = null;
        return this.getVoteConfig();
    }

    resetVoteRound() {
        this.voteMode = eVotingMode.COOLDOWN;
        this.voteCooldown = internal_Config.TiktokVoteCooldown;
        this.voteRemaining = this.voteCooldown;
        this.votePicked = ePickedVote.UNDETERMINED;
        this.votePicker = [0, 0, 0];
        this.votePickerUID = [];
        this.votePickerExclusiveUID = [];
        if (this.userVoteChoice) this.userVoteChoice.clear();
        this.voteEffect = [];
        this.broadcastVoteToSSE(true);
    }

    forceStartVote() {
        if (this.voteEffect.length < this.voteMaxLength) {
            let maxAttempts = 50;
            let attempts = 0;
            while (this.voteEffect.length < this.voteMaxLength && attempts < maxAttempts) {
                attempts++;
                let theEffect = GenerateRandom(this.effectDataBase, this.rngInstance);
                if (theEffect) {
                    const isDuplicate = this.voteEffect.some(
                        (v) => (v.id && theEffect.id && v.id === theEffect.id) || v.name === theEffect.name
                    );
                    if (!isDuplicate || attempts > 30) {
                        this.voteEffect.push(theEffect);
                    }
                }
            }
        }
        this.voteMode = eVotingMode.VOTING;
        this.voteRemaining = this.voteCooldown;
        this.votePicker = [0, 0, 0];
        this.votePickerUID = [];
        this.votePickerExclusiveUID = [];
        if (this.userVoteChoice) this.userVoteChoice.clear();
        this.broadcastVoteToSSE(true);
    }

    setTokenOwner(owner) {
        this.tokenOwner = owner;
        global.tokenOwner = owner;
        if (this.providerManager) {
            this.providerManager.updateLicenseOwner(owner);
        }
        if (this.indofinityStatus && this.indofinityStatus.uniqueId) {
            const verification = verifyTokenOwner(owner, this.indofinityStatus.uniqueId);
            this.setOwnerMismatch(!verification.match, verification.message);
        }
    }

    setOwnerMismatch(isMismatch, reason = "") {
        this.ownerMismatched = isMismatch;
        this.mismatchReason = reason;
        if (isMismatch) {
            TikTokGatewayStatus = "Owner Mismatched";
            console.warn(`[TikTok Security] ${reason}`);
        } else if (TikTokGatewayStatus === "Owner Mismatched") {
            TikTokGatewayStatus = "Connected";
        }
    }

    async checkIndofinityStatusOnce() {
        if (!internal_Config.TiktokUseIndofinity) return null;
        try {
            const status = await fetchIndofinityStatus({ config: GeneralConfig });
            if (status && status.ok) {
                this.indofinityStatus = status;
                this.isLive = Boolean(status.live);
                global.isLive = this.isLive;
                if (status.uniqueId) {
                    internal_Config.owner = status.uniqueId;
                    global.currentLiveUser = status.uniqueId;
                    if (!internal_Config.TiktokUsername) {
                        internal_Config.TiktokUsername = status.uniqueId;
                    }
                }
                const effectiveOwner = this.tokenOwner || global.tokenOwner || global.gameClientOwner || "";
                if (effectiveOwner && status.uniqueId) {
                    const verification = verifyTokenOwner(effectiveOwner, status.uniqueId);
                    this.setOwnerMismatch(!verification.match, verification.message);
                }
            }
            return status;
        } catch (e) {
            return null;
        }
    }

    startIndofinityPolling() {
        if (this.indofinityPollTimer) {
            clearInterval(this.indofinityPollTimer);
            this.indofinityPollTimer = null;
        }
        if (internal_Config.TiktokUseIndofinity) {
            this.checkIndofinityStatusOnce();
            // Recurring status checks are handled by the 30-second heartbeat service (heartbeat.js)
        }
    }

    updateEffectDataBase(effectDataBase) {
        this.effectDataBase = effectDataBase;
    }

    getEffectList() {
        try {
            let parsed = JSON.parse(this.effectDataBase);
            return Array.isArray(parsed.Function) ? parsed.Function : [];
        } catch (error) {
            return [];
        }
    }

    getLocationList() {
        try {
            let parsed = JSON.parse(this.effectDataBase);
            return Array.isArray(parsed.Location) ? parsed.Location : [];
        } catch (error) {
            return [];
        }
    }

    normalizeToken(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "");
    }

    extractPrefixedValue(raw, prefixes) {
        let text = String(raw || "").trim();
        if (text === "") {
            return null;
        }

        let lower = text.toLowerCase();
        for (let i = 0; i < prefixes.length; i++) {
            let prefix = prefixes[i];
            let prefixLower = prefix.toLowerCase();
            if (lower === prefixLower) {
                return "";
            }
            if (lower.startsWith(prefixLower + ":")) {
                return text.slice(prefix.length + 1).trim();
            }
            if (lower.startsWith(prefixLower + " ")) {
                return text.slice(prefix.length + 1).trim();
            }
        }

        return null;
    }

    resolveVehicleId(value) {
        let raw = String(value || "").trim();
        if (raw === "") {
            return null;
        }

        let numeric = Number(raw);
        if (Number.isFinite(numeric)) {
            return Math.trunc(numeric);
        }

        let normalized = this.normalizeToken(raw);
        if (normalized === "") {
            return null;
        }

        for (let i = 0; i < vehicleName.length; i++) {
            if (this.normalizeToken(vehicleName[i]) === normalized) {
                return i + 400;
            }
        }

        return null;
    }

    resolveLocation(value) {
        let raw = String(value || "").trim();
        if (raw === "") {
            return null;
        }

        let locations = this.getLocationList();
        if (locations.length === 0) {
            return null;
        }

        let numeric = parseInt(raw, 10);
        if (Number.isFinite(numeric) && numeric >= 1 && numeric <= locations.length) {
            return locations[numeric - 1];
        }

        let normalized = this.normalizeToken(raw);
        if (normalized === "") {
            return null;
        }

        let exactMatch = locations.find((location) => {
            return (
                this.normalizeToken(location.name) === normalized ||
                this.normalizeToken(location.description) === normalized
            );
        });
        if (exactMatch) {
            return exactMatch;
        }

        return (
            locations.find((location) => {
                return (
                    this.normalizeToken(location.name).includes(normalized) ||
                    this.normalizeToken(location.description).includes(normalized)
                );
            }) || null
        );
    }

    buildVehicleEffect(vehicleId) {
        let name = "Spawn Vehicle " + vehicleId;
        let index = vehicleId - 400;
        if (index >= 0 && index < vehicleName.length) {
            name = "Spawn " + vehicleName[index];
        }

        return {
            category: "Vehicle",
            name: name,
            description: "SpawnVehicle",
            id: String(vehicleId),
            exclusive: false,
        };
    }

    buildTeleportEffect(location) {
        let posX = Number(location.x != undefined ? location.x : location.posX);
        let posY = Number(location.y != undefined ? location.y : location.posY);
        let posZ = Number(location.z != undefined ? location.z : location.posZ);

        return {
            category: "Teleportation",
            name: location.name ? "Teleport To " + location.name : "Teleport",
            description: location.description || "TeleportToLocation",
            posX: posX,
            posY: posY,
            posZ: posZ,
        };
    }

    setLocalConfigHandler(handler) {
        this.localConfig = handler;
    }

    isImmuneActive() {
        return Date.now() < (global.immuneUntil || 0);
    }

    getImmuneRemainingSeconds() {
        return Math.max(0, Math.ceil(((global.immuneUntil || 0) - Date.now()) / 1000));
    }

    clearGiftQueue() {
        let count = this.giftEffectQueue.length;
        this.giftEffectQueue = [];
        this.giftComboTracker.clear();
        if (this.giftComboCleanupTimers) {
            for (const timer of this.giftComboCleanupTimers.values()) {
                clearTimeout(timer);
            }
            this.giftComboCleanupTimers.clear();
        }
        console.log(`[IMMUNE] Membersihkan ${count} antrean efek gift.`);
    }

    activateImmune(durationMs, senderInfo = {}) {
        let duration = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
            ? Number(durationMs)
            : Number(GeneralConfig?.General?.ImmuneDuration || 30000);

        const now = Date.now();
        global.immuneUntil = now + duration;
        global.immuneDuration = duration;

        const senderName = senderInfo.nickname || senderInfo.username || senderInfo.displayName || "Gift / Wheel";
        console.log(`==================================================`);
        console.log(`[IMMUNE ACTIVE] Mode Immune DIAKTIFKAN selama ${duration / 1000} detik!`);
        console.log(`├── Dipicu oleh    : ${senderName}`);
        console.log(`├── Berakhir pada  : ${new Date(global.immuneUntil).toLocaleTimeString()}`);
        console.log(`└── Status         : Semua Gift & Spin Wheel DIBLOKIR!`);
        console.log(`==================================================`);

        // 1. Bersihkan antrean gift
        this.clearGiftQueue();

        // 2. Bersihkan antrean spinwheel jika ada
        if (this.localConfig && Array.isArray(this.localConfig.spinQueue)) {
            this.localConfig.spinQueue = [];
        } else if (global.localConfigHandler && Array.isArray(global.localConfigHandler.spinQueue)) {
            global.localConfigHandler.spinQueue = [];
        }

        // 3. Kirim efek display ke Game Client GTA SA
        const effectPayload = {
            type: "effect",
            data: {
                effectID: "effect_infinite_health_player",
                effectData: { seed: this.userSeed },
                duration: duration,
                displayName: "Immune (Gifts & Wheel Blocked)",
                subtext: senderName,
                uniqueId: senderInfo.uniqueId || "",
                uniqueID: senderInfo.uniqueId || "",
                nickname: senderName,
                username: senderInfo.username || senderName,
                name: "Immune",
                message: `Immune Active (${duration / 1000}s)`
            }
        };

        this.wsServer.clients.forEach((client) => {
            try {
                client.send(JSON.stringify(effectPayload));
            } catch (e) {}
        });

        // 4. Broadcast status event ke UI / Overlay via SSE
        const broadcastPayload = {
            active: true,
            durationMs: duration,
            remainingMs: duration,
            expiresAt: global.immuneUntil,
            user: senderInfo,
            timestamp: new Date().toISOString()
        };

        if (this.localConfig && typeof this.localConfig.broadcastEvent === "function") {
            this.localConfig.broadcastEvent("immune-status", broadcastPayload);
        } else if (global.localConfigHandler && typeof global.localConfigHandler.broadcastEvent === "function") {
            global.localConfigHandler.broadcastEvent("immune-status", broadcastPayload);
        }

        // 5. Timer untuk log dan broadcast ketika waktu selesai
        if (global.immuneTimer) {
            clearTimeout(global.immuneTimer);
        }
        global.immuneTimer = setTimeout(() => {
            console.log(`[IMMUNE] Durasi Immune telah SELESAI. Semua Gift & Spin Wheel kembali normal.`);
            const finishedPayload = {
                active: false,
                durationMs: 0,
                remainingMs: 0,
                expiresAt: 0,
                timestamp: new Date().toISOString()
            };
            if (this.localConfig && typeof this.localConfig.broadcastEvent === "function") {
                this.localConfig.broadcastEvent("immune-status", finishedPayload);
            } else if (global.localConfigHandler && typeof global.localConfigHandler.broadcastEvent === "function") {
                global.localConfigHandler.broadcastEvent("immune-status", finishedPayload);
            }
        }, duration);

        return {
            active: true,
            durationMs: duration,
            expiresAt: global.immuneUntil
        };
    }

    triggerSpinwheel(senderInfo = {}) {
        if (this.isImmuneActive()) {
            console.log(`[IMMUNE BLOCKED] Spin Wheel dibatalkan karena mode Immune aktif (${this.getImmuneRemainingSeconds()}s tersisa).`);
            return null;
        }
        if (this.localConfig && typeof this.localConfig.triggerSpinwheel === "function") {
            return this.localConfig.triggerSpinwheel(senderInfo);
        }
        if (global.localConfigHandler && typeof global.localConfigHandler.triggerSpinwheel === "function") {
            return global.localConfigHandler.triggerSpinwheel(senderInfo);
        }
        console.warn("[TikTok] LocalConfigHandler not available for spinwheel trigger");
        return null;
    }

    parseSpecialEffect(raw) {
        let text = String(raw || "").trim();
        if (text === "") {
            return null;
        }

        let spinwheelValue = this.extractPrefixedValue(text, [
            "spinwheel",
            "spin_wheel",
            "spin",
            "wheel",
            "wheel_of_fortune",
        ]);
        if (spinwheelValue != null || text.toLowerCase() === "spinwheel" || text.toLowerCase() === "wheel") {
            return {
                type: "spinwheel",
                isSpinwheel: true,
            };
        }

        let immuneValue = this.extractPrefixedValue(text, [
            "immune",
            "immunity",
            "kebal",
        ]);
        if (immuneValue != null || text.toLowerCase() === "immune" || text.toLowerCase() === "immunity" || text.toLowerCase() === "kebal") {
            return {
                type: "immune",
                isImmune: true,
            };
        }

        let vehicleValue = this.extractPrefixedValue(text, [
            "spawn_vehicle",
            "spawnveh",
            "vehicle",
        ]);
        if (vehicleValue != null) {
            let vehicleId = this.resolveVehicleId(vehicleValue);
            if (!Number.isFinite(vehicleId)) {
                return {
                    type: "vehicle",
                    error: "Vehicle not found",
                };
            }
            return {
                type: "vehicle",
                effect: this.buildVehicleEffect(vehicleId),
            };
        }

        let locationValue = this.extractPrefixedValue(text, [
            "teleport",
            "tpto",
            "tp",
            "location",
        ]);
        if (locationValue != null) {
            let location = this.resolveLocation(locationValue);
            if (!location) {
                return {
                    type: "teleport",
                    error: "Location not found",
                };
            }
            return {
                type: "teleport",
                effect: this.buildTeleportEffect(location),
            };
        }

        return null;
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

            if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
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

        let used = new Set();
        let ret = [];
        list.forEach((item) => {
            let comboId = String(item || "").trim();
            if (comboId === "") {
                return;
            }

            let key = comboId.toLowerCase();
            if (used.has(key)) {
                return;
            }

            used.add(key);
            ret.push(comboId);
        });

        return ret;
    }

    getGiftQueueDelayMs() {
        let delay = Number(internal_Config && internal_Config.GiftQueueDelayMs);
        if (!Number.isFinite(delay) || delay < 0) {
            delay = 250;
        }

        return delay;
    }

    scheduleComboTrackerCleanup(trackerKey, delayMs = 1500) {
        if (!this.giftComboCleanupTimers) {
            this.giftComboCleanupTimers = new Map();
        }
        if (this.giftComboCleanupTimers.has(trackerKey)) {
            clearTimeout(this.giftComboCleanupTimers.get(trackerKey));
        }
        const timer = setTimeout(() => {
            this.giftComboTracker.delete(trackerKey);
            this.giftComboCleanupTimers.delete(trackerKey);
        }, delayMs);
        this.giftComboCleanupTimers.set(trackerKey, timer);
    }

    resolveGiftCount(data) {
        if (!data || typeof data !== "object") {
            return { shouldProcess: false, count: 0 };
        }

        // 1. Message ID / Event ID Deduplication (short-term cache)
        const msgId = String(data.id ?? data.msgId ?? data.messageId ?? "").trim();
        if (msgId) {
            const now = Date.now();
            if (!this.processedGiftMsgIds) {
                this.processedGiftMsgIds = new Map();
            }
            if (this.processedGiftMsgIds.size > 300) {
                for (const [k, ts] of this.processedGiftMsgIds.entries()) {
                    if (now - ts > 30000) {
                        this.processedGiftMsgIds.delete(k);
                    }
                }
            }
            if (this.processedGiftMsgIds.has(msgId)) {
                console.log(`[TikTok Gift] Duplicate message ID ignored: ${msgId}`);
                return { shouldProcess: false, count: 0 };
            }
            this.processedGiftMsgIds.set(msgId, now);
        }

        let isRepeatEnd = data.repeatEnd === true || data.repeatEnd === 1 || data.repeatEnd === "true";
        let repeatCountRaw = data ? (data.repeatCount != undefined ? data.repeatCount : data.repeat_count) : undefined;
        let repeatCount = Number(repeatCountRaw);

        if (!Number.isFinite(repeatCount) || repeatCount < 1) {
            repeatCount = 1;
        }

        console.log("RC:", repeatCount);

        const uniqueId = data.user?.uniqueId || data.uniqueId || data.userId || "unknown";
        const giftId = data.giftId || data.id || "0";
        const groupId = data.groupId || data.comboId || data.streakId || "";

        let trackerKey = groupId ? `${uniqueId}:${giftId}:${groupId}` : `${uniqueId}:${giftId}`;
        let lastProcessedCount = this.giftComboTracker.get(trackerKey) || 0;
        let deltaCount = repeatCount - lastProcessedCount;

        const cleanupDelay = groupId ? 10000 : 1500;

        if (deltaCount > 0) {
            this.giftComboTracker.set(trackerKey, repeatCount);
            
            if (isRepeatEnd) {
                this.scheduleComboTrackerCleanup(trackerKey, cleanupDelay);
            }

            return { shouldProcess: true, count: deltaCount };
        }

        if (isRepeatEnd) {
            this.scheduleComboTrackerCleanup(trackerKey, cleanupDelay);
        }

        return { shouldProcess: false, count: 0 };
    }

    enqueueGiftEffect(effect, count = 1, forcePrefix = false) {
        if (!effect || typeof effect !== "object") {
            return;
        }

        let total = Number(count);
        if (!Number.isFinite(total) || total < 1) {
            total = 1;
        }

        for (let i = 0; i < total; i++) {
            // Membuat token unik untuk menandai waktu masuk setiap sub-efek di dalam antrean
            const queueToken = `${effect.id || 'effect'}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            
            // Catat waktu terima data (Timestamp Masuk)
            this.effectTimestamps.set(queueToken, Date.now());

            this.giftEffectQueue.push({ effect, forcePrefix, queueToken });
        }

        this.processGiftQueue();
    }

    processGiftQueue() {
        if (this.giftQueueProcessing) {
            return;
        }

        this.giftQueueProcessing = true;

        const processNext = () => {
            if (this.giftEffectQueue.length === 0) {
                this.giftQueueProcessing = false;
                return;
            }

            // Intip elemen pertama dalam antrean tanpa menghapusnya terlebih dahulu
            let candidate = this.giftEffectQueue[0];
            if (!candidate) {
                this.giftEffectQueue.shift();
                setTimeout(processNext, this.giftQueueDelayMs);
                return;
            }

            // Periksa apakah efek ini sedang terblokir exclusive lock dari efek sebelumnya
            let lockCheck = this.exclusiveManager.isLocked(candidate.effect, this.getEffectList());
            if (lockCheck.isLocked && lockCheck.remainingMs > 0) {
                console.log(
                    `[EXCLUSIVE QUEUE] Efek [${candidate.effect.name || candidate.effect.id}] sedang di-exclusivekan oleh [${lockCheck.lockedBy}] (Sisa: ${lockCheck.remainingMs}ms). Menunda antrean...`
                );
                // Tunggu hingga exclusive lock kadaluarsa, lalu ulangi pemrosesan antrean
                const waitTime = Math.min(Math.max(50, lockCheck.remainingMs + 50), 30000);
                setTimeout(processNext, waitTime);
                return;
            }

            let next = this.giftEffectQueue.shift();
            if (next) {
                // Teruskan token pelacak ke fungsi eksekusi utama
                this.sendEffectToClients(next.effect, next.forcePrefix, next.queueToken);
            }

            setTimeout(processNext, this.giftQueueDelayMs);
        };

        processNext();
    }

    sendEffectToClients(effect, forcePrefix = false, queueToken = null) {
        if (!effect || typeof effect !== "object") {
            return;
        }

        const isImmune =
            effect && (
                effect.id === "immune" ||
                effect.id === "effect_immune" ||
                String(effect.description || "").trim().toLowerCase() === "immune" ||
                String(effect.name || "").trim().toLowerCase() === "immune"
            );

        if (isImmune) {
            const dur = Number(effect.duration) > 0
                ? Number(effect.duration)
                : Number(GeneralConfig?.General?.ImmuneDuration || 30000);
            this.activateImmune(dur, effect);
            return;
        }

        if (this.isImmuneActive()) {
            console.log(
                `[IMMUNE BLOCKED] Efek [${effect.name || effect.id}] diblokir karena mode Immune sedang aktif (${this.getImmuneRemainingSeconds()}s tersisa).`
            );
            return;
        }

        // Jika dipanggil langsung di luar antrean dan efek sedang terkena exclusive lock
        let lockCheck = this.exclusiveManager.isLocked(effect, this.getEffectList());
        if (lockCheck.isLocked && lockCheck.remainingMs > 0) {
            console.log(
                `[EXCLUSIVE DIRECT] Efek langsung [${effect.name || effect.id}] terblokir exclusive lock [${lockCheck.lockedBy}]. Dialihkan ke antrean tunggu (${lockCheck.remainingMs}ms).`
            );
            this.giftEffectQueue.push({ effect, forcePrefix, queueToken });
            this.processGiftQueue();
            return;
        }

        this.userSeed = global.userSeed;
        this.rngInstance = global.rngInstance;

        let payload = { ...effect };
        if (forcePrefix && typeof payload.id === "string" && !payload.id.startsWith("effect_")) {
            payload.id = "effect_" + payload.id;
        }

        // Tembak data ke seluruh WebSockets Game Client (GTA SA)
        this.wsServer.clients.forEach((clients) => {
            let effectData = SendTheEffect(payload, this.userSeed, this.rngInstance);
            clients.send(JSON.stringify(effectData));
        });

        // AKTIFKAN ATURAN EXCLUSIVE DARI EFEK INI UNTUK MENGUNCI TARGET EFEK SELAMA DELAY
        this.exclusiveManager.acquireLocks(payload, this.getEffectList());

        // ================= LOG HITUNGAN DELTA TIME LATENCY =================
        const timeSent = Date.now();
        if (queueToken && this.effectTimestamps.has(queueToken)) {
            const timeReceived = this.effectTimestamps.get(queueToken);
            const deltaTimeMs = timeSent - timeReceived;

            console.log(`[LATENCY LOG] Efek: [${payload.name || payload.id}]`);
            console.log(`   ├── Diterima (Tikfinity) : ${new Date(timeReceived).toLocaleTimeString()}`);
            console.log(`   ├── Dikirim ke Game      : ${new Date(timeSent).toLocaleTimeString()}`);
            console.log(`   └── Delta Jeda Antrean   : ${deltaTimeMs} ms (${(deltaTimeMs / 1000).toFixed(3)} detik)`);
            console.log(`--------------------------------------------------`);

            this.effectTimestamps.delete(queueToken); // Bersihkan memory map
        } else {
            console.log(`[DIRECT LOG] Efek [${payload.name || payload.id}] dikirim instan (Bypass Antrean).`);
            console.log(`--------------------------------------------------`);
        }
        // ===================================================================
    }

    executeGiftCombo(gift, sourceUniqueId, senderInfo = {}, executionCount = 1) {
        if (this.isImmuneActive()) {
            console.log(`[IMMUNE BLOCKED] Combo efek dibatalkan karena mode Immune sedang aktif (${this.getImmuneRemainingSeconds()}s tersisa).`);
            return false;
        }

        let comboConfig = GeneralConfig.ComboEffect || {};

        let comboIds = this.normalizeComboList(gift.run_combo);
        if (comboIds.length === 0) {
            return false;
        }

        let maxComboLength = Number(comboConfig.MaxComboLength || 5);
        if (!Number.isFinite(maxComboLength) || maxComboLength < 1) {
            maxComboLength = 5;
        }

        comboIds = comboIds.slice(0, maxComboLength);

        let deduplicateMs = Number(comboConfig.DeduplicateMs || 0);
        if (!Number.isFinite(deduplicateMs) || deduplicateMs < 0) {
            deduplicateMs = 0;
        }

        let comboKey = `${gift.id}:${sourceUniqueId || "unknown"}`;
        let now = Date.now();
        if (deduplicateMs > 0) {
            let lastExecution = this.comboLastExecution.get(comboKey);
            if (lastExecution && now - lastExecution < deduplicateMs) {
                return true;
            }
            this.comboLastExecution.set(comboKey, now);
        }

        let effectList = this.getEffectList();
        let comboEffects = comboIds
            .map((comboId) => effectList.find((item) => String(item.id || "").toLowerCase() === comboId.toLowerCase()))
            .filter((item) => item != undefined);

        if (comboEffects.length === 0) {
            return false;
        }

        let chainDelay = Number(comboConfig.ChainDelayMs || 350);
        if (!Number.isFinite(chainDelay) || chainDelay < 0) {
            chainDelay = 350;
        }

        let giftDuration = Number(gift.duration);
        let durationProp = Number.isFinite(giftDuration) && giftDuration > 0 ? { duration: giftDuration } : {};

        let totalRuns = Math.max(1, Number(executionCount) || 1);
        for (let r = 0; r < totalRuns; r++) {
            let baseDelay = r * (comboEffects.length * chainDelay + 250);

            // Hitung jadwal kombo secara cerdas memperhitungkan aturan exclusive antar-efek
            const scheduledChain = this.exclusiveManager.calculateComboSchedule(
                comboEffects,
                chainDelay,
                baseDelay,
                effectList
            );

            scheduledChain.forEach((item, index) => {
                const effect = item.effect;
                const delay = item.executionDelay;

                // Generate token pelacak khusus untuk rantai kombo efek
                const comboToken = `combo_${effect.id || 'fx'}_${Date.now()}_${r}_${index}`;
                this.effectTimestamps.set(comboToken, Date.now());

                setTimeout(() => {
                    this.sendEffectToClients({ ...effect, ...senderInfo, ...durationProp }, true, comboToken);
                }, delay);
            });
        }

        return true;
    }

    internal_ValidateData() {
        if (
            internal_Config.TiktokUsername == "" &&
            !internal_Config.TikfinityEnable
        ) {
            console.log(
                "Tiktok Username is not set. Please set it in the config.json file."
            );
            exit();
        }
        if (internal_Config.TiktokForceEffect) {
            let gifts = readJson(path.join(APP_DATA_ROOT, "gifts.json"), []);
            let hasMappedGift = Array.isArray(gifts) && gifts.some((x) => x.run_effect != "");
            if (!hasMappedGift) {
                console.warn(
                    "[TikTok] Peringatan: Belum ada efek yang diatur di gifts.json. Anda dapat mengaturnya di menu Gift Config."
                );
            }

            if (Array.isArray(gifts)) {
                let effects = [];
                try {
                    let parsed = typeof this.effectDataBase === "string" ? JSON.parse(this.effectDataBase) : this.effectDataBase;
                    effects = Array.isArray(parsed?.Function) ? parsed.Function : [];
                } catch (e) {
                    effects = [];
                }

                gifts.forEach((gift) => {
                    if (
                        !gift.run_effect ||
                        gift.run_effect === "" ||
                        gift.run_effect === "none" ||
                        gift.run_effect === "no_effect" ||
                        gift.run_effect === "random"
                    ) return;

                    let special = this.parseSpecialEffect(gift.run_effect);
                    if (special) {
                        if (special.error) {
                            console.warn(`[TikTok] Special effect not found for gift: ${gift.name}`);
                        }
                        return;
                    }

                    if (effects.length > 0) {
                        let matched = effects.find(
                            (x) =>
                                x.description == gift.run_effect ||
                                x.name == gift.run_effect ||
                                x.id == gift.run_effect
                        );
                        if (!matched) {
                            console.warn(`[TikTok] Notice: Effect '${gift.run_effect}' for gift '${gift.name}' is not in local catalog, will use dynamic payload.`);
                        }
                    }
                });
            }
        }
    }

    GetReturnVoteID(id) {
        switch (id) {
            case 0: {
                return ePickedVote.FIRST;
            }
            case 1: {
                return ePickedVote.SECOND;
            }
            case 2: {
                return ePickedVote.THIRD;
            }
        }
    }

    getVoteSnapshot() {
        let voteEffectName = this.voteEffect.map((x) => x.name || x.description || "Unknown Effect");
        let totalVotes = this.votePicker.reduce((a, b) => a + b, 0);
        let percentages = this.votePicker.map((count) => totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0);
        let highestVote = Math.max(...this.votePicker);
        let highestIndex = this.votePicker.indexOf(highestVote);
        let hasVotes = totalVotes > 0 && highestVote > 0;

        return {
            enabled: Boolean(GeneralConfig.Tiktok?.TiktokVoteEnable),
            mode: this.voteMode === eVotingMode.VOTING ? "Voting" : "Cooldown",
            remaining: Math.max(0, Math.round(this.voteRemaining)),
            cooldown: this.voteCooldown || 30000,
            effects: voteEffectName,
            votes: [...this.votePicker],
            percentages,
            totalVotes,
            pickedChoice: hasVotes ? this.GetReturnVoteID(highestIndex) : ePickedVote.UNDETERMINED,
            winningIndex: hasVotes ? highestIndex : -1,
            winningEffect: hasVotes ? (voteEffectName[highestIndex] || "") : "",
            lastWinner: this.lastPickedEffectName || "",
            timestamp: Date.now()
        };
    }

    broadcastVoteToSSE(force = false) {
        if (!GeneralConfig.Tiktok?.TiktokVoteEnable) return;
        let now = Date.now();
        if (!force && now - this.lastVoteSseBroadcast < 300) {
            return;
        }
        this.lastVoteSseBroadcast = now;

        const snapshot = this.getVoteSnapshot();
        const handler = this.localConfig || global.localConfigHandler;
        if (handler && typeof handler.broadcastEvent === "function") {
            handler.broadcastEvent("tiktok-vote", snapshot);
        }
    }

    HandleTheTimer() {
        this.userSeed = global.userSeed;
        this.rngInstance = global.rngInstance;

        let now = Date.now();
        let delta = now - this.lastTimerTick;
        this.lastTimerTick = now;

        if (!GeneralConfig.Tiktok.TiktokVoteEnable) return; 
        switch (this.voteMode) {
            case eVotingMode.COOLDOWN: {
                if (this.voteEffect.length < this.voteMaxLength) {
                    let theEffect = GenerateRandom(
                        this.effectDataBase,
                        this.rngInstance
                    );

                    if (theEffect) {
                        const isDuplicate = this.voteEffect.some(
                            (v) => (v.id && theEffect.id && v.id === theEffect.id) || v.name === theEffect.name
                        );
                        if (!isDuplicate || this.voteEffect.length === 0) {
                            this.voteEffect.push(theEffect);
                        }
                    }
                }

                if (this.voteRemaining <= 0) {
                    this.voteMode = eVotingMode.VOTING;
                    this.voteRemaining = this.voteCooldown;
                    this.broadcastVoteToSSE(true);
                }
                break;
            }
            case eVotingMode.VOTING: {
                if (this.voteRemaining <= 0) {
                    let totalVotes = this.votePicker.reduce((a, b) => a + b, 0);
                    let highestVote = Math.max(...this.votePicker);
                    let highestIndex = this.votePicker.indexOf(highestVote);
                    let pickedEffect = this.voteEffect[highestIndex];
                    let voteEffectName = this.voteEffect.map((x) => x.name);

                    if (totalVotes > 0 && highestVote > 0 && pickedEffect) {
                        if (this.isImmuneActive()) {
                            console.log(`[IMMUNE BLOCKED] Hasil voting '${pickedEffect.name}' dibatalkan karena mode Immune sedang aktif (${this.getImmuneRemainingSeconds()}s tersisa).`);
                        } else {
                            let effect = SendTheEffect(
                                {
                                    ...pickedEffect,
                                    subtext: "Hasil Voting",
                                    nickname: "Hasil Voting",
                                    username: "Hasil Voting",
                                    uniqueId: "Voting",
                                    viewer: "Hasil Voting",
                                    message: "Hasil Voting",
                                },
                                this.userSeed,
                                this.rngInstance
                            );

                            this.wsServer.clients.forEach((clients) => {
                                clients.send(JSON.stringify(effect));
                                clients.send(
                                    JSON.stringify({
                                        type: "votes",
                                        data: {
                                            effects: voteEffectName,
                                            votes: this.votePicker,
                                            pickedChoice:
                                                this.GetReturnVoteID(highestIndex),
                                        },
                                    })
                                );
                            });
                        }

                        this.lastPickedEffectName = pickedEffect ? pickedEffect.name : "";
                        console.log(`[TikTok Vote] Voting selesai! Efek terpilih: '${this.lastPickedEffectName}' dengan ${highestVote} suara.`);
                    } else {
                        // Tidak ada yang vote (0 suara) -> Jangan kirim efek ke game client!
                        console.log("[TikTok Vote] Voting berakhir tanpa suara (0 vote). Efek dibatalkan dan tidak dikirim ke game.");
                        this.wsServer.clients.forEach((clients) => {
                            clients.send(
                                JSON.stringify({
                                    type: "votes",
                                    data: {
                                        effects: voteEffectName,
                                        votes: this.votePicker,
                                        pickedChoice: ePickedVote.UNDETERMINED,
                                    },
                                })
                            );
                        });

                        this.lastPickedEffectName = "";
                    }

                    this.broadcastVoteToSSE(true);

                    this.voteMode = eVotingMode.COOLDOWN;
                    this.voteCooldown = internal_Config.TiktokVoteCooldown;
                    this.voteRemaining = this.voteCooldown;
                    this.votePicked = ePickedVote.UNDETERMINED;
                    this.votePicker = [0, 0, 0];
                    this.votePickerUID = [];
                    this.votePickerExclusiveUID = [];
                    if (this.userVoteChoice) this.userVoteChoice.clear();
                    this.voteEffect = [];
                } else {
                    let voteEffectName = this.voteEffect.map((x) => x.name);
                    this.wsServer.clients.forEach((clients) => {
                        clients.send(
                            JSON.stringify({
                                type: "votes",
                                data: {
                                    effects: voteEffectName,
                                    votes: this.votePicker,
                                    pickedChoice: ePickedVote.UNDETERMINED,
                                },
                            })
                        );
                    });
                }
                break;
            }
        }
        this.voteRemaining -= delta;
        this.wsServer.clients.forEach((clients) => {
            clients.send(
                JSON.stringify({
                    type: "time",
                    data: {
                        remaining: this.voteRemaining,
                        cooldown: this.voteCooldown,
                        mode:
                            this.voteMode == eVotingMode.COOLDOWN
                                ? "Cooldown"
                                : this.voteMode == eVotingMode.VOTING
                                ? "Voting"
                                : "Rapid Fire TIME!!!",
                    },
                })
            );
        });
        this.broadcastVoteToSSE(false);
    }

    onMessage(data) {
        const uniqueId = data.user?.uniqueId || data.uniqueId || data.userId || "";
        const nickname = data.user?.nickname || data.nickname || data.user?.name || "";
        const senderInfo = {
            uniqueId,
            uniqueID: uniqueId,
            nickname,
            username: nickname || uniqueId,
            user: { uniqueId, nickname },
            subtext: nickname || uniqueId,
        };

        if (uniqueId == "athallah.dzaki" || uniqueId == internal_Config.owner) {
            let message = (data.comment || data.message || "").trim();
            if (message === "") return;
            let splitMessage = message.split(" ");
            let command = splitMessage[0].toLowerCase();
            let argText = splitMessage.slice(1).join(" ").trim();

            if (this.isImmuneActive()) {
                console.log(`[IMMUNE BLOCKED] Chat command '${command}' dari ${uniqueId} diabaikan karena mode Immune sedang aktif.`);
                return;
            }

            switch (command) {
                case "!feffect": {
                    if (argText === "") return;
                    let effect = {
                        category: "Function",
                        name: "Dev Check Effect " + argText,
                        description: "Dev Check",
                        id: argText,
                        exclusive: false,
                        ...senderInfo,
                    };
                    this.sendEffectToClients(effect);
                    break;
                }
                case "!effect": {
                    if (argText === "") return;
                    let effect = JSON.parse(this.effectDataBase)[
                        "Function"
                    ].find((x) => x.id == argText);
                    if (effect == undefined) return;
                    this.sendEffectToClients({ ...effect, ...senderInfo });
                    break;
                }
                case "!spin":
                case "!putar":
                case "!dospin": {
                    this.triggerSpinwheel({
                        username: uniqueId,
                        nickname: nickname || uniqueId,
                        source: "chat",
                    });
                    break;
                }
                case "!spawnveh":
                case "!checkveh": {
                    if (argText === "") return;
                    let vehicleId = this.resolveVehicleId(argText);
                    if (!Number.isFinite(vehicleId)) {
                        console.log("Vehicle not found for command");
                        return;
                    }
                    this.sendEffectToClients({ ...this.buildVehicleEffect(vehicleId), ...senderInfo });
                    break;
                }
                case "!teleport":
                case "!tpto":
                case "!tp": {
                    if (argText === "") return;
                    let location = this.resolveLocation(argText);
                    if (!location) {
                        console.log("Location not found for command");
                        return;
                    }
                    this.sendEffectToClients({ ...this.buildTeleportEffect(location), ...senderInfo });
                    break;
                }
                case "!checkgift": {
                    if (argText === "") return;
                    let gift = readJson(path.join(APP_DATA_ROOT, "gifts.json"), []).find((x) => x.id == argText);
                    const activeMode = GeneralConfig.Tiktok?.InteractionMode;
                    if (activeMode === "spinwheel" || activeMode === "hybrid_vote_spin") {
                        this.triggerSpinwheel({ ...senderInfo, giftName: gift?.name || `Gift #${argText}`, source: "checkgift" });
                        return;
                    }
                    if (gift == undefined) return; 
                    if (gift.run_effect != "" && gift.run_effect !== "none" && gift.run_effect !== "no_effect") {
                        let giftDuration = Number(gift.duration);
                        let durationProp = Number.isFinite(giftDuration) && giftDuration > 0 ? { duration: giftDuration } : {};

                        let special = this.parseSpecialEffect(gift.run_effect);
                        if (special) {
                            if (special.isSpinwheel) {
                                this.triggerSpinwheel({ ...senderInfo, giftName: gift.name, source: "checkgift" });
                                return;
                            }
                            if (special.effect) {
                                this.sendEffectToClients({ ...special.effect, ...senderInfo, ...durationProp });
                                return;
                            }
                        }
                        let effects = JSON.parse(this.effectDataBase)[
                            "Function"
                        ];
                        let findEffect = effects.find(
                            (x) => x.description == gift.run_effect
                        );
                        if (findEffect == undefined) return;
                        let effectCopy = { ...findEffect, id: "effect_" + findEffect.id, ...senderInfo, ...durationProp };
                        
                        // Buat token bypass antrean langsung untuk dev checking
                        const directToken = `check_${findEffect.id}_${Date.now()}`;
                        this.effectTimestamps.set(directToken, Date.now());
                        this.sendEffectToClients(effectCopy, false, directToken);
                    }
                    break;
                }
            }
        }
        switch (this.voteMode) {
            case eVotingMode.VOTING: {
                if (this.votePickerUID.includes(uniqueId)) return;
                let message = String(data.comment || data.message || "").trim();
                const voteCfg = this.getVoteConfig();
                const chatPoints = Math.max(1, parseInt(voteCfg?.settings?.chatVotePoints || 1, 10));

                let optionIndex = -1;
                if (message === "#1" || message.startsWith("#1")) optionIndex = 0;
                else if (message === "#2" || message.startsWith("#2")) optionIndex = 1;
                else if (message === "#3" || message.startsWith("#3")) optionIndex = 2;

                if (optionIndex >= 0) {
                    this.votePicker[optionIndex] += chatPoints;
                    this.votePickerUID.push(uniqueId);
                    if (!this.userVoteChoice) this.userVoteChoice = new Map();
                    this.userVoteChoice.set(uniqueId, optionIndex);

                    if (optionIndex === 0) this.votePicked |= ePickedVote.FIRST;
                    if (optionIndex === 1) this.votePicked |= ePickedVote.SECOND;
                    if (optionIndex === 2) this.votePicked |= ePickedVote.THIRD;

                    this.broadcastVoteToSSE(true);
                }
                break;
            }
        }
    }

    onDonation(data) {
        if (this.isImmuneActive()) {
            console.log(`[IMMUNE BLOCKED] Saweria donasi diabaikan karena mode Immune sedang aktif (${this.getImmuneRemainingSeconds()}s tersisa).`);
            return;
        }

        const uniqueId = data.user?.uniqueId || data.uniqueId || data.donator_name || data.name || data.sender || "";
        const nickname = data.user?.nickname || data.nickname || data.donator_name || data.name || data.sender || "";
        const senderInfo = {
            uniqueId,
            uniqueID: uniqueId,
            nickname,
            username: nickname || uniqueId,
            user: { uniqueId, nickname },
            subtext: nickname || uniqueId,
        };

        let amount = data.amount || data.amount_raw;
        if (amount == 5000) {
            this.triggerSpinwheel({
                username: uniqueId || "Saweria Donor",
                nickname: nickname || uniqueId || "Donatur Saweria",
                amount: amount,
                source: "saweria",
            });
            console.log("Send Wheel of Fortune via Saweria (5000)");
        }

        if (fs.existsSync(path.join(APP_DATA_ROOT, "saweria.json"))) {
            let donation = readJson(path.join(APP_DATA_ROOT, "saweria.json"), []);
            let findDonation = donation.find((x) => x.price == amount);
            if (findDonation != undefined) {
                let special = this.parseSpecialEffect(findDonation.run_effect);
                if (special) {
                    if (special.isSpinwheel) {
                        this.triggerSpinwheel({
                            username: uniqueId || "Saweria Donor",
                            nickname: nickname || uniqueId || "Donatur Saweria",
                            amount: amount,
                            source: "saweria",
                        });
                        return;
                    }
                    if (special.effect) {
                        this.sendEffectToClients({ ...special.effect, ...senderInfo });
                        return;
                    }
                }
                let effect = this.getEffectList();
                let findEffect = effect.find(
                    (x) => x.description == findDonation.run_effect || x.name == findDonation.run_effect || x.id == findDonation.run_effect
                );
                if (findEffect == undefined && findDonation.run_effect) {
                    findEffect = {
                        id: findDonation.price || "saweria",
                        name: findDonation.run_effect,
                        description: findDonation.run_effect,
                        category: "Custom",
                    };
                }
                if (findEffect == undefined) return;
                
                // Daftarkan token untuk donasi platform luar (saweria/sociabuzz dll)
                const donateToken = `donation_${findEffect.id}_${Date.now()}`;
                this.effectTimestamps.set(donateToken, Date.now());
                this.sendEffectToClients({ ...findEffect, ...senderInfo }, false, donateToken);
            }
        }
    }

    async sendDiamondTrackingData(data, giftCountInfo) {
        try {
            if (!internal_Config.DiamondTrackingAccepted || internal_Config.DiamondTrackingEnabled === false) {
                return;
            }

            // Live and owner verification for IndoFinity
            if (internal_Config.TiktokUseIndofinity) {
                if (this.ownerMismatched) {
                    console.warn(`[Diamond Tracker] Revenue rejected: Owner mismatch (${this.mismatchReason})`);
                    return;
                }

                // If currently flagged as not live, perform an immediate quick-check in case stream just started
                if (!this.isLive) {
                    await this.checkIndofinityStatusOnce();
                }

                if (!this.isLive) {
                    console.log(`[Diamond Tracker] Stream is not live (live=${this.isLive}). Skipping revenue tracking to ensure data is real.`);
                    return;
                }
            }

            let diamondCount = Number(
                data.diamondCount ?? data.diamond_count ?? data.diamonds ?? data.diamondCost ?? 0
            );

            let giftList = readJson(path.join(APP_DATA_ROOT, "gifts.json"), []);
            let gift = giftList.find((x) => x.id == data.giftId);

            if (diamondCount <= 0 && gift) {
                diamondCount = Number(gift.diamond_count ?? gift.cost ?? gift.diamonds ?? 0);
            }

            if (diamondCount <= 0) {
                diamondCount = 1;
            }

            let totalDiamonds = (giftCountInfo?.count || 1) * diamondCount;
            let streamer = internal_Config.owner || internal_Config.TiktokUsername || "";

            const uniqueId = data.user?.uniqueId || data.uniqueId || data.userId || "";
            const nickname = data.user?.nickname || data.nickname || data.user?.name || "";

            let userToken = "";
            let gtaPath = GeneralConfig.General?.GTA_PATH || "";
            if (gtaPath && fs.existsSync(path.join(gtaPath, "ChaosMod", "token.txt"))) {
                try {
                    userToken = fs.readFileSync(path.join(gtaPath, "ChaosMod", "token.txt"), "utf8").trim();
                } catch (e) {}
            }

            let trackingUrl = internal_Config.DiamondTrackingServerUrl || "https://updater.sa-chaos.my.id/data.php?type=diamond_tracking";

            console.log(`[Diamond Tracker] Sending ${totalDiamonds} diamonds for streamer '${streamer}' (live: ${this.isLive}) to ${trackingUrl}`);

            await axios.post(trackingUrl, {
                token_id: userToken,
                streamer: streamer,
                owner: streamer,
                amount: totalDiamonds,
                gift_id: data.giftId,
                gift_name: data.giftName || gift?.name || "",
                streamer_unique_id: streamer,
                sender_unique_id: uniqueId,
                sender_nickname: nickname,
                live: this.isLive === true,
                is_live: this.isLive === true,
            }, {
                timeout: 10000,
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": OFFICIAL_USER_AGENT
                }
            }).catch(err => {
                console.warn("[Diamond Tracker] Post error:", err.message);
            });
        } catch (error) {
            console.error("[Diamond Tracker] Failed to send revenue tracking:", error.message);
        }
    }

    onGift(data) {
        if (this.ownerMismatched) {
            console.warn(`[TikTok Gift] Gift ignored due to owner mismatch: ${this.mismatchReason}`);
            return;
        }

        const uniqueId = data.user?.uniqueId || data.uniqueId || data.userId || "";
        const nickname = data.user?.nickname || data.nickname || data.user?.name || "";
        const senderInfo = {
            uniqueId,
            uniqueID: uniqueId,
            nickname,
            username: nickname || uniqueId,
            user: { uniqueId, nickname },
            subtext: nickname || uniqueId,
        };

        let giftCountInfo = null;
        if (
            !GeneralConfig.Tiktok.TikfinityHTTPServer &&
            GeneralConfig.Tiktok.TiktokForceEffect
        ) {
            giftCountInfo = this.resolveGiftCount(data);
            console.log("Gift Count Info", giftCountInfo);

            if (!giftCountInfo.shouldProcess) {
                return;
            }

            this.sendDiamondTrackingData(data, giftCountInfo);

            let gifts = readJson(path.join(APP_DATA_ROOT, "gifts.json"), []);
            let gift = gifts.find((x) => x.id == data.giftId);
            let giftName = gift?.name || data.giftName || data.describe || data.gift?.name || (data.giftId ? `Gift #${data.giftId}` : "Gift");

            let repeatMultiplier = 1;
            if (gift) {
                repeatMultiplier = parseInt(gift.repeat_count || gift.run_count || 1, 10);
                if (!Number.isFinite(repeatMultiplier) || repeatMultiplier < 1) {
                    repeatMultiplier = 1;
                }
            }
            let totalExecutions = (giftCountInfo.count || 1) * repeatMultiplier;

            console.log(`[TikTok Gift] Gift '${giftName}' (Received: ${giftCountInfo.count}, Multiplier: ${repeatMultiplier}x -> Total Executions: ${totalExecutions})`);

            let executeGift = true;

            // Cek status immune sebelum memproses gift
            if (this.isImmuneActive()) {
                console.log(`[IMMUNE BLOCKED] Gift '${giftName}' (${totalExecutions}x) dari ${uniqueId} diabaikan karena mode Immune sedang aktif (${this.getImmuneRemainingSeconds()}s tersisa).`);
                return;
            }

            // Interaction Mode Override for Spinwheel (FORTUNE ROULETTE / ROULETTE DEMOCRACY)
            const activeMode = GeneralConfig.Tiktok?.InteractionMode;
            if (activeMode === "vote") {
                console.log(`[TikTok Gift] Operating in ${activeMode} mode: Gift execution is bypassed, redirecting to Add Point Vote.`);
                executeGift = false;
            } else if (activeMode === "spinwheel" || activeMode === "hybrid_vote_spin") {
                let diamondCount = Number(
                    data.diamondCount ?? data.diamond_count ?? data.diamonds ?? data.diamondCost ?? 0
                );
                if (diamondCount <= 0 && gift) {
                    diamondCount = Number(gift.diamond_count ?? gift.cost ?? gift.diamonds ?? 0);
                }
                if (diamondCount <= 0) {
                    diamondCount = 1;
                }

                // Check minimal diamond setting
                let spinwheelData = readJson(path.join(APP_DATA_ROOT, "spinwheel-effects.json"), {});
                let minDiamonds = parseInt(spinwheelData?.settings?.minDiamonds ?? 1, 10);
                if (!Number.isFinite(minDiamonds) || minDiamonds < 1) {
                    minDiamonds = 1;
                }

                let totalDiamonds = (giftCountInfo.count || 1) * diamondCount;
                let effectiveDiamonds = Math.max(diamondCount, totalDiamonds);

                if (effectiveDiamonds < minDiamonds) {
                    console.log(`[TikTok Gift] Gift '${giftName}' (${effectiveDiamonds} diamond) di bawah batas minimal (${minDiamonds} diamond) untuk Spin Wheel. Lewati.`);
                    executeGift = false;
                } else {
                    console.log(`[TikTok Gift] Operating in ${activeMode} mode: routing gift '${giftName}' (${effectiveDiamonds} diamond >= ${minDiamonds} min) to Spin Wheel (${totalExecutions}x)`);
                    for (let r = 0; r < totalExecutions; r++) {
                        this.triggerSpinwheel({
                            username: uniqueId,
                            nickname: nickname || uniqueId,
                            giftName: giftName,
                            amount: diamondCount,
                            source: "gift",
                        });
                    }
                    executeGift = false;
                }
            }

            if (executeGift && gift != undefined) {
                let comboExecuted = this.executeGiftCombo(gift, uniqueId, senderInfo, totalExecutions);
                if (!comboExecuted && gift.run_effect != "") {
                    if (gift.run_effect === "none" || gift.run_effect === "no_effect") {
                        console.log(`[TikTok Gift] Gift '${gift.name}' received with no effect (overlay only). Skipping execution.`);
                    } else {
                        let giftDuration = Number(gift.duration);
                        let durationProp = Number.isFinite(giftDuration) && giftDuration > 0 ? { duration: giftDuration } : {};

                        let special = this.parseSpecialEffect(gift.run_effect);

                        if (gift.run_effect === "random") {
                            let effects = this.getEffectList();
                            if (effects && effects.length > 0) {
                                for (let r = 0; r < totalExecutions; r++) {
                                    let randomIndex = randomNess(0, effects.length - 1, this.rngInstance);
                                    this.enqueueGiftEffect({ ...effects[randomIndex], ...senderInfo, ...durationProp }, 1, true);
                                }
                            }
                        } else if (gift.run_effect === "immune" || (special && special.isImmune) || String(gift.run_effect || "").toLowerCase() === "immune") {
                            let giftDuration = Number(gift.duration);
                            let duration = Number.isFinite(giftDuration) && giftDuration > 0
                                ? giftDuration
                                : Number(GeneralConfig?.General?.ImmuneDuration || 30000);
                            this.activateImmune(duration, senderInfo);
                        } else {
                            let handledSpecial = false;
                            if (special) {
                                if (special.isSpinwheel) {
                                    for (let r = 0; r < totalExecutions; r++) {
                                        this.triggerSpinwheel({
                                            username: uniqueId,
                                            nickname: nickname || uniqueId,
                                            giftName: gift.name,
                                            source: "gift",
                                        });
                                    }
                                    handledSpecial = true;
                                } else if (special.effect) {
                                    this.enqueueGiftEffect({ ...special.effect, ...senderInfo, ...durationProp }, totalExecutions, false);
                                    handledSpecial = true;
                                }
                            }
                            
                            if (!handledSpecial) {
                                let effects = this.getEffectList();
                                let findEffect = effects.find(
                                    (x) => x.description == gift.run_effect || x.name == gift.run_effect || x.id == gift.run_effect
                                );
                                if (findEffect == undefined && gift.run_effect) {
                                    // Safe Fallback Payload Builder
                                    findEffect = {
                                        id: gift.id || "gift_custom",
                                        name: gift.name || gift.run_effect,
                                        description: gift.run_effect,
                                        category: "Custom",
                                    };
                                    console.log(`[TikTok Gift] Using fallback payload for gift '${gift.name}':`, findEffect);
                                }
                                if (findEffect != undefined) {
                                    this.enqueueGiftEffect({ ...findEffect, ...senderInfo, ...durationProp }, totalExecutions, true);
                                }
                            }
                        }
                    }
                }
            }
        }
        if (this.voteMode == eVotingMode.VOTING) {
            const voteCfg = this.getVoteConfig();
            const allowRepeat = voteCfg?.settings?.allowRepeatGifts !== false;
            if (!allowRepeat && this.votePickerExclusiveUID.includes(uniqueId)) {
                return;
            }

            const giftId = String(data.giftId ?? data.id ?? "");
            const giftName = String(data.giftName || data.describe || data.gift?.name || "").trim().toLowerCase();

            const rules = Array.isArray(voteCfg?.giftPoints) ? voteCfg.giftPoints : [];
            const matchedRule = rules.find((r) => {
                if (r.giftId && String(r.giftId) === giftId) return true;
                if (r.giftName && giftName && String(r.giftName).trim().toLowerCase() === giftName) return true;
                return false;
            });

            if (matchedRule) {
                const basePoints = Math.max(1, parseInt(matchedRule.points || 1, 10));
                let count = 1;
                if (matchedRule.multiplyByCount !== false && voteCfg?.settings?.multiplyByStreak !== false) {
                    if (giftCountInfo && typeof giftCountInfo.count === "number") {
                        count = giftCountInfo.count;
                    } else {
                        try {
                            let gInfo = this.resolveGiftCount(data);
                            if (gInfo && gInfo.count) count = gInfo.count;
                            else if (gInfo && !gInfo.shouldProcess) count = 0;
                        } catch (e) {
                            count = parseInt(data.repeatCount || data.count || 1, 10) || 1;
                        }
                    }
                }
                const totalPoints = basePoints * count;

                let target = String(matchedRule.target || "1").trim();
                let applied = false;

                if (target === "1" || target === "#1") {
                    this.votePicker[0] += totalPoints;
                    this.votePicked |= ePickedVote.FIRST;
                    applied = true;
                } else if (target === "2" || target === "#2") {
                    this.votePicker[1] += totalPoints;
                    this.votePicked |= ePickedVote.SECOND;
                    applied = true;
                } else if (target === "3" || target === "#3") {
                    this.votePicker[2] += totalPoints;
                    this.votePicked |= ePickedVote.THIRD;
                    applied = true;
                } else if (target === "user_vote") {
                    let userChoice = this.userVoteChoice ? this.userVoteChoice.get(uniqueId) : undefined;
                    if (userChoice === undefined) {
                        let note = String(data.comment || data.message || "").trim();
                        if (note.includes("#1")) userChoice = 0;
                        else if (note.includes("#2")) userChoice = 1;
                        else if (note.includes("#3")) userChoice = 2;
                        else userChoice = 0;
                    }
                    if (userChoice >= 0 && userChoice < 3) {
                        this.votePicker[userChoice] += totalPoints;
                        if (userChoice === 0) this.votePicked |= ePickedVote.FIRST;
                        if (userChoice === 1) this.votePicked |= ePickedVote.SECOND;
                        if (userChoice === 2) this.votePicked |= ePickedVote.THIRD;
                        applied = true;
                    }
                } else if (target === "all") {
                    this.votePicker[0] += totalPoints;
                    this.votePicker[1] += totalPoints;
                    this.votePicker[2] += totalPoints;
                    this.votePicked |= (ePickedVote.FIRST | ePickedVote.SECOND | ePickedVote.THIRD);
                    applied = true;
                }

                if (applied) {
                    this.votePickerExclusiveUID.push(uniqueId);
                    console.log(`[TikTok Vote] Gift '${matchedRule.giftName || giftId}' by ${uniqueId} added +${totalPoints} points (Target: ${target}, Count: ${count}x)`);
                    this.broadcastVoteToSSE(true);
                }
            }
        }
    }

    connectTikfinity() {
        if (!internal_Config.TikfinityEnable && !internal_Config.TiktokUseIndofinity) return;
        
        const targetPort = internal_Config.TiktokUseIndofinity == false ? 21213 : 62024;
        const targetUrl = `ws://localhost:${targetPort}/`;

        // Guard: Jika koneksi sudah aktif atau sedang connecting ke target URL yang sama, jangan buat socket baru
        if (this.tiktokConnection) {
            const state = this.tiktokConnection.readyState;
            if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
                if (this.tiktokConnection._chaosTargetUrl === targetUrl) {
                    console.log(`[TikTok Gateway] WebSocket already active/connecting to ${targetUrl}, skipping duplicate connection.`);
                    return;
                }
            }
            try {
                this.tiktokConnection.removeAllListeners();
                this.tiktokConnection.close();
            } catch (e) {}
            this.tiktokConnection = null;
        }

        if (this._tikfinityReconnectTimer) {
            clearTimeout(this._tikfinityReconnectTimer);
            this._tikfinityReconnectTimer = null;
        }

        TikTokGatewayStatus = "Connecting";
        const ws = new WebSocket(targetUrl);
        ws._chaosTargetUrl = targetUrl;
        this.tiktokConnection = ws;

        ws.on("open", () => {
            if (this.tiktokConnection !== ws) return;
            TikTokGatewayStatus = "Connected";
            console.log(
                `Connected to ${
                    internal_Config.TiktokUseIndofinity
                        ? "Indofinity"
                        : "Tikfinity"
                } Server (${targetUrl})`
            );
        });

        let donationPlatform = [ "saweria", "sociabuzz", "trakteer", "tako" ];

        ws.on("message", (data) => {
            if (this.tiktokConnection !== ws) return;
            let wsData;
            try {
                wsData = JSON.parse(data);
            } catch (err) {
                return;
            }
            if (wsData.event == "chat") {
                this.onMessage(wsData.data);
            } else if (wsData.event == "gift") {
                this.onGift(wsData.data);
            } else if (donationPlatform.some(platform => wsData.event && wsData.event.includes(platform))) {
                this.onDonation(wsData.data);
            } else if (wsData.event == "tiktokConnected" || wsData.event == "liveDetected") {
                let detectedId = wsData.data?.roomInfo?.uniqueId || internal_Config.owner;
                internal_Config.owner = detectedId;
                this.isLive = true;
                this.checkIndofinityStatusOnce();
                console.info(`Connected to Tiktok Interactive to Room ${wsData.data?.roomInfo?.nickname || detectedId} with Room ID ${wsData.data?.roomId}`);
            }
        });

        const scheduleReconnect = () => {
            if (this._tikfinityReconnectTimer) return;
            this._tikfinityReconnectTimer = setTimeout(() => {
                this._tikfinityReconnectTimer = null;
                const activeProv = internal_Config.Provider || GeneralConfig?.General?.TiktokProvider || TIKTOK_PROVIDERS.INDOFINITY;
                if (activeProv !== TIKTOK_PROVIDERS.CUSTOM_BETA && internal_Config.TiktokEnable && (internal_Config.TikfinityEnable || internal_Config.TiktokUseIndofinity)) {
                    this.connectTikfinity();
                }
            }, 5000);
        };

        ws.on("close", () => {
            if (this.tiktokConnection === ws) {
                this.tiktokConnection = null;
            }
            try {
                ws.removeAllListeners();
            } catch (e) {}

            if (TikTokGatewayStatus !== "Disconnected") {
                TikTokGatewayStatus = "Disconnected";
                console.log(`Connection to ${internal_Config.TiktokUseIndofinity ? "Indofinity" : "Tikfinity"} closed. Reconnecting in 5 seconds...`);
            }
            scheduleReconnect();
        });

        ws.on("error", (err) => {
            if (err.code == "ECONNREFUSED") {
                console.log(`Connection Refused from Tiktok Interactive. Please make sure the ${internal_Config.TiktokUseIndofinity ? "Indofinity" : "Tikfinity"} is running.`);
            } else {
                console.warn("[TikTok Gateway] WebSocket error:", err.message || err);
            }
            if (TikTokGatewayStatus !== "Disconnected") {
                TikTokGatewayStatus = "Disconnected";
            }
            scheduleReconnect();
        });
    }

    connectLiveConnector() {
        if (!internal_Config.TiktokEnable) {
            TikTokGatewayStatus = "Disconnected";
            return;
        }

        // uniqueId : Username Tiktok (Dari Server)
        const rawUsername = (internal_Config.TiktokUsername || internal_Config.owner || global.tokenOwner || global.currentLiveUser || "").trim();
        const uniqueId = rawUsername.replace(/^@/, "").trim();

        if (!uniqueId) {
            console.warn("[TikTokLiveConnection] Username TikTok belum diisi di Tiktok Config.");
            TikTokGatewayStatus = "Disconnected";
            return;
        }

        if (this.tiktokLiveConn) {
            try {
                this.tiktokLiveConn.disconnect();
            } catch (e) {}
            this.tiktokLiveConn = null;
        }

        const sessionId = (internal_Config.TiktokSessionId || "").trim();
        const ttTargetIdc = (internal_Config.TiktokTtTargetIdc || "").trim();

        const options = {
            processInitialData: false,
            fetchRoomInfoOnConnect: true,
            enableExtendedGiftInfo: true,
            authenticateWs: internal_Config.TiktokAuthenticateWs !== false,
        };

        if (internal_Config.TiktokSignApiKey) {
            options.signApiKey = internal_Config.TiktokSignApiKey.trim();
        }

        if (this.providerManager) {
            options.eulerApiInstance = createCustomSignerApiClient({
                signerTokenManager: this.providerManager.signerTokenManager,
                authSessionManager: this.providerManager.authSessionManager,
                signerBaseUrl: "https://signer.sa-chaos.id",
            });
        }

        // Pass them via the session.cookie bundle
        if (sessionId && ttTargetIdc) {
            options.session = {
                cookie: {
                    type: "cookie",
                    value: {
                        sessionId: sessionId,
                        ttTargetIdc: ttTargetIdc
                    }
                }
            };
        } else if (sessionId) {
            options.sessionId = sessionId;
        }

        TikTokGatewayStatus = "Connecting";
        console.log(`[TikTokLiveConnection] Menghubungkan ke @${uniqueId} (authenticateWs: ${options.authenticateWs}, session: ${!!(sessionId && ttTargetIdc)})...`);

        try {
            const connection = new TikTokLiveConnection(uniqueId, options);
            this.tiktokLiveConn = connection;

            connection.connect()
                .then((state) => {
                    TikTokGatewayStatus = "Connected";
                    this.isLive = true;
                    const detectedOwner = state?.roomInfo?.owner?.display_id || uniqueId;
                    internal_Config.owner = detectedOwner;
                    global.currentLiveUser = detectedOwner;
                    console.log("Connected to TikTok LIVE chat!");
                    console.info(`[TikTokLiveConnection] Connected to TikTok LIVE Room: ${state?.roomInfo?.owner?.nickname || detectedOwner} (Room ID: ${state?.roomId || 'unknown'})`);
                })
                .catch((err) => {
                    TikTokGatewayStatus = "Disconnected";
                    console.error("[TikTokLiveConnection] Failed to connect to TikTok LIVE:", err?.message || err);
                    if (this._liveConnRetryTimer) {
                        clearTimeout(this._liveConnRetryTimer);
                    }
                    this._liveConnRetryTimer = setTimeout(() => {
                        const currentProv = internal_Config.Provider || GeneralConfig?.General?.TiktokProvider || TIKTOK_PROVIDERS.INDOFINITY;
                        if (currentProv !== TIKTOK_PROVIDERS.INDOFINITY && !internal_Config.TikfinityEnable && internal_Config.TiktokEnable && this.tiktokLiveConn === connection) {
                            this.connectLiveConnector();
                        }
                    }, 10000);
                });

            connection.on("chat", (data) => {
                this.onMessage(data);
            });

            connection.on("gift", (data) => {
                this.onGift(data);
            });

            connection.on("disconnected", () => {
                console.log("[TikTokLiveConnection] Disconnected from TikTok LIVE chat.");
                if (TikTokGatewayStatus !== "Disconnected") {
                    TikTokGatewayStatus = "Disconnected";
                }
                setTimeout(() => {
                    if (!internal_Config.TikfinityEnable && internal_Config.TiktokEnable) {
                        this.connectLiveConnector();
                    }
                }, 5000);
            });

            connection.on("streamEnd", () => {
                console.log("[TikTokLiveConnection] Stream telah berakhir.");
                TikTokGatewayStatus = "Disconnected";
                this.isLive = false;
            });

            connection.on("error", (err) => {
                console.error("[TikTokLiveConnection] Error:", err?.message || err);
            });

        } catch (err) {
            TikTokGatewayStatus = "Disconnected";
            console.error("[TikTokLiveConnection] Setup error:", err);
        }
    }

    SetupTiktok() {
        if (!internal_Config.TiktokEnable) {
            TikTokGatewayStatus = "Disconnected";
            if (this._tikfinityReconnectTimer) {
                clearTimeout(this._tikfinityReconnectTimer);
                this._tikfinityReconnectTimer = null;
            }
            if (this.tiktokConnection) {
                try {
                    this.tiktokConnection.removeAllListeners();
                    this.tiktokConnection.close();
                } catch (e) {}
                this.tiktokConnection = null;
            }
            if (this.tiktokLiveConn) {
                try { this.tiktokLiveConn.disconnect(); } catch (e) {}
                this.tiktokLiveConn = null;
            }
            if (this.providerManager) {
                this.providerManager.customConnector.disconnect();
                this.providerManager.liveMonitor.stopMonitoring();
            }
            return;
        }

        const activeProvider = internal_Config.Provider || GeneralConfig?.General?.TiktokProvider || TIKTOK_PROVIDERS.INDOFINITY;
        if (activeProvider === TIKTOK_PROVIDERS.CUSTOM_BETA) {
            // Close any active IndoFinity connection
            if (this._tikfinityReconnectTimer) {
                clearTimeout(this._tikfinityReconnectTimer);
                this._tikfinityReconnectTimer = null;
            }
            if (this.tiktokConnection) {
                try {
                    this.tiktokConnection.removeAllListeners();
                    this.tiktokConnection.close();
                } catch (e) {}
                this.tiktokConnection = null;
            }
            if (this.tiktokLiveConn) {
                try { this.tiktokLiveConn.disconnect(); } catch (e) {}
                this.tiktokLiveConn = null;
            }
            if (this.providerManager && this.providerManager.getProvider() !== TIKTOK_PROVIDERS.CUSTOM_BETA) {
                this.providerManager.setProvider(TIKTOK_PROVIDERS.CUSTOM_BETA, { saveConfig: false });
            }
            return;
        }

        // When in IndoFinity mode, ensure Custom Beta and old connector are stopped
        if (this.providerManager) {
            this.providerManager.customConnector.disconnect();
            this.providerManager.liveMonitor.stopMonitoring();
        }

        if (this.tiktokLiveConn) {
            try { this.tiktokLiveConn.disconnect(); } catch (e) {}
            this.tiktokLiveConn = null;
        }
        if (this._liveConnRetryTimer) {
            clearTimeout(this._liveConnRetryTimer);
            this._liveConnRetryTimer = null;
        }

        // IndoFinity connects via local desktop WebSocket (port 62024 or 21213)
        if (internal_Config.TiktokUseIndofinity || internal_Config.TikfinityEnable) {
            this.connectTikfinity();
        }
    }
}

export class TikTok extends TikTokHandler {
    constructor(
        wsServer,
        effectDataBase,
    ) {
        super(
            wsServer,
            effectDataBase,
        );
        this.SetupTiktok();
    }
}